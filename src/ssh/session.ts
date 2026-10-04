import fs from 'fs';
import os from 'os';
import path from 'path';
import { StringDecoder } from 'node:string_decoder';
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper, type TerminalModes } from 'ssh2';
import type { Readable as NodeReadable } from 'stream';
import { NameSet, reserveLocalTarget, numberedName } from '../localTarget';
import { normalizeRemote, remoteBasename, remoteDirname, remoteJoin } from '../remotePath';
import type { TreeCount } from '../terminal/actions';
import type { RemoteStat, RemoveOptions } from '../terminal/host';
import { expandHome, safeFileName } from '../text';
import type {
  AuthMethod,
  BrowseEntry,
  ConnectionRecord,
  DownloadResult,
  FolderDownloadResult,
  JumpSpec,
  SecretPayload,
  TransferOptions,
  TransferProgress,
  UploadOptions,
  UploadResult,
} from '../types';
import { AuthFailure, AuthPlanner, type AskAnswer, type AskRequest, type AuthEndpoint } from './auth';
import { HostKeyDeclined, HostKeyError, TooManyFiles, TransferCancelled, TransferError, humanizeSshError } from './errors';
import { decideHostKey, hopIds, type HostKeyPolicy } from './hostKeys';
import { knownHostsLine, type KnownHostEntry } from './knownHosts';
import { SHELL_PROBE, shellKindFromProbe, type ShellKind } from './shellFeed';
import {
  IncompleteTransfer,
  downloadHandle,
  localFile,
  partSuffix,
  sftpClose,
  sftpFstat,
  sftpOpen,
  uploadHandle,
  type SftpHandleApi,
} from './transfer';

export interface HostKeyStore {
  get(id: string): string | undefined;
  trust(id: string, fingerprint: string): Promise<void>;
}

export interface HostKeyQuestion {
  kind: 'unknown' | 'changed';
  /** host:port as shown to the user. */
  hostLabel: string;
  /** Jump hosts in front of it, e.g. "bastion:22". */
  via?: string;
  fingerprint: string;
  previous?: string;
}

/** Questions a connection may ask while it opens. */
export interface ConnectUi {
  ask(request: AskRequest): Promise<AskAnswer | undefined>;
  trustHostKey(question: HostKeyQuestion): Promise<boolean>;
}

export interface OpenSessionOptions {
  record: ConnectionRecord;
  secret: SecretPayload;
  known: HostKeyStore;
  knownHosts: KnownHostEntry[];
  hostKeyPolicy: HostKeyPolicy;
  /** Append an accepted new key to ~/.ssh/known_hosts (setting easySsh.knownHostsWriteBack). */
  writeKnownHost?: (line: string) => Promise<void>;
  ui: ConnectUi;
  readyTimeout: number;
  keepaliveInterval: number;
  keepaliveCountMax: number;
  /** Agent socket, Windows pipe, or "pageant". Undefined when none is available. */
  agent?: string;
  /** Default identity files that exist (~/.ssh/id_ed25519, id_ecdsa, id_rsa). */
  identityFiles: string[];
  signal: AbortSignal;
  /** The connection dropped. The reason is the last error, when there was one. */
  onClose: (reason: string | undefined) => void;
  log: (line: string) => void;
  readKey?: (file: string) => Buffer;
}

export interface OpenedSession {
  session: SshSession;
  cwd: string;
  usedFallbackPath: boolean;
  /** Lines shown above the shell, e.g. a newly trusted host key. */
  notes: string[];
  shell: ShellKind;
  /** A password the user typed and chose to save. */
  savePassword?: string;
}

/** Linux tty defaults so an interactive shell enables line editing and Tab. */
export function loginTerminalModes(): TerminalModes {
  return {
    VINTR: 3,
    VQUIT: 28,
    VERASE: 127,
    VKILL: 21,
    VEOF: 4,
    VEOL: 255,
    VEOL2: 255,
    VSTART: 17,
    VSTOP: 19,
    VSUSP: 26,
    VDSUSP: 255,
    VREPRINT: 18,
    VWERASE: 23,
    VLNEXT: 22,
    VFLUSH: 255,
    VSWTCH: 255,
    VDISCARD: 15,
    IGNPAR: 0,
    PARMRK: 0,
    INPCK: 0,
    ISTRIP: 0,
    INLCR: 0,
    IGNCR: 0,
    ICRNL: 1,
    IUCLC: 0,
    IXON: 1,
    IXANY: 0,
    IXOFF: 0,
    IMAXBEL: 1,
    ISIG: 1,
    ICANON: 1,
    ECHO: 1,
    ECHOE: 1,
    ECHOK: 1,
    ECHONL: 0,
    NOFLSH: 0,
    TOSTOP: 0,
    IEXTEN: 1,
    ECHOCTL: 1,
    ECHOKE: 1,
    PENDIN: 0,
    OPOST: 1,
    OLCUC: 0,
    ONLCR: 1,
    OCRNL: 0,
    ONOCR: 0,
    ONLRET: 0,
    CS7: 0,
    CS8: 1,
    PARENB: 0,
    PARODD: 0,
  };
}

export function terminalWindow(columns: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Math.max(20, Math.min(400, Math.floor(columns) || 80)),
    rows: Math.max(2, Math.min(400, Math.floor(rows) || 24)),
  };
}

function asCount(value: number | bigint | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readKeyFile(file: string): Buffer {
  return fs.readFileSync(expandHome(file, os.homedir()));
}

interface Endpoint {
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  privateKeyPath?: string;
}

function endpointOf(item: ConnectionRecord | JumpSpec): Endpoint {
  return { host: item.host, port: item.port, username: item.username, auth: item.auth, privateKeyPath: item.privateKeyPath };
}

/**
 * A timer that can stop while the user answers a prompt. ssh2's readyTimeout
 * also runs during authentication, so a slow typist would be cut off.
 */
export class Deadline {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private left: number;
  private started = 0;
  private paused = 0;
  private done = false;

  constructor(ms: number, private readonly onExpire: () => void) {
    this.left = ms;
    this.start();
  }

  private start(): void {
    if (this.done || this.left <= 0) return;
    this.started = Date.now();
    this.timer = setTimeout(() => {
      this.done = true;
      this.onExpire();
    }, this.left);
  }

  pause(): void {
    this.paused += 1;
    if (this.paused > 1 || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.left -= Date.now() - this.started;
  }

  resume(): void {
    if (this.paused === 0) return;
    this.paused -= 1;
    if (this.paused === 0) this.start();
  }

  clear(): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

interface ConnectHooks {
  deadline: (client: Client) => Deadline;
  log: (line: string) => void;
}

function connectClient(config: ConnectConfig, signal: AbortSignal, hooks: ConnectHooks): Promise<{ client: Client; deadline: Deadline }> {
  if (signal.aborted) return Promise.reject(new TransferCancelled());
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let lastError: Error | undefined;
    const deadline = hooks.deadline(client);
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      deadline.clear();
      signal.removeEventListener('abort', onAbort);
      if (err) {
        try {
          client.end();
        } catch {
          // The socket may already be gone.
        }
        reject(err);
        return;
      }
      resolve({ client, deadline });
    };
    const onAbort = () => finish(new TransferCancelled());
    signal.addEventListener('abort', onAbort);
    client.once('ready', () => finish());
    // A listener stays for the life of the client: ssh2 can emit more than one
    // error (a keepalive timeout, then the socket), and an unhandled one is lost.
    client.on('error', (err: Error & { level?: string }) => {
      lastError = err;
      if (settled) return;
      // ssh2 reports an agent that cannot be reached, or a key it cannot sign
      // with, and then goes on with the next method.
      if (err.level === 'agent' || (err.level === 'client-authentication' && !/methods failed/i.test(err.message))) {
        hooks.log(`${config.host}: ${err.message}`);
        return;
      }
      finish(err);
    });
    client.once('close', () => finish(lastError ?? new Error('The server closed the connection')));
    try {
      client.connect(config);
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err || !sftp) reject(err ?? new Error('The server did not open SFTP'));
      else resolve(sftp);
    });
  });
}

function forward(client: Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err || !stream) reject(err ?? new Error(`Could not open a tunnel to ${host}:${port}`));
      else resolve(stream);
    });
  });
}

/** The login shell's path ($SHELL), or undefined when the server refuses exec. */
export function probeShell(client: Client, timeoutMs = 3000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let output = '';
    let done = false;
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    try {
      client.exec(SHELL_PROBE, (err, stream) => {
        if (err || !stream) {
          finish(undefined);
          return;
        }
        stream.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8');
          if (output.length > 4096) stream.close();
        });
        stream.stderr.on('data', () => undefined);
        stream.on('error', () => finish(undefined));
        stream.on('close', (code: number | null) => finish(code === 0 || code === null ? output : undefined));
      });
    } catch {
      finish(undefined);
    }
  });
}

function callbackOf<T>(run: (done: (err: Error | null | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    run((err, value) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}

/**
 * Rename a finished download into place. On Windows an antivirus scanner or the
 * search indexer can hold the new file for a moment, so EPERM/EBUSY/EACCES retry.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => Promise<void> = fs.promises.rename,
  attempts = 10,
  delayMs = 200,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

interface UploadPlan {
  local: string;
  remote: string;
  label: string;
  size: number;
  mode: number;
}

/** Mode for a file the upload creates when the local mode is unknown. */
export const DEFAULT_FILE_MODE = 0o644;
/** Mode for a directory the upload creates when the local mode is unknown. */
export const DEFAULT_DIR_MODE = 0o755;

/**
 * Permission bits for an uploaded file or directory: the local bits, or the fallback.
 * Windows reports no real POSIX bits, so it always uses the fallback.
 */
export function uploadMode(localMode: number | undefined, fallback: number, platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32' || localMode === undefined) return fallback;
  const bits = localMode & 0o777;
  return bits === 0 ? fallback : bits;
}

/**
 * Mode for a downloaded file or folder: the remote permission bits, always
 * readable and writable by the owner. The process umask still applies, so a
 * 0600 file stays 0600 and an executable stays executable (S6).
 */
export function downloadMode(remoteMode: number | undefined, kind: 'file' | 'folder'): number {
  const owner = kind === 'file' ? 0o600 : 0o700;
  if (remoteMode === undefined) return kind === 'file' ? 0o644 : 0o755;
  return (remoteMode & 0o777) | owner;
}

export interface CollectedUploads {
  files: UploadPlan[];
  directories: { remote: string; mode: number }[];
  skipped: number;
  /** Top-level remote targets, in drop order. */
  tops: { local: string; remote: string; name: string }[];
}

/** Walk dropped files and folders. Stops at maxFiles and on cancel, without walking the rest. */
export async function collectUploads(
  localPaths: string[],
  remoteDir: string,
  options: { signal: AbortSignal; maxFiles: number; onScan?: (files: number) => void },
): Promise<CollectedUploads> {
  const files: UploadPlan[] = [];
  const directories: { remote: string; mode: number }[] = [];
  const tops: CollectedUploads['tops'] = [];
  let skipped = 0;
  let lastReport = 0;

  const walk = async (local: string, remote: string, label: string, top: boolean) => {
    if (options.signal.aborted) throw new TransferCancelled();
    const linked = await fs.promises.lstat(local).catch((err: unknown) => {
      throw new TransferError('Cannot read', local, 'local', err);
    });
    if (linked.isSymbolicLink() && !top) {
      skipped += 1;
      return;
    }
    const stat = linked.isSymbolicLink()
      ? await fs.promises.stat(local).catch((err: unknown) => {
        throw new TransferError('Cannot read', local, 'local', err);
      })
      : linked;
    if (stat.isDirectory()) {
      directories.push({ remote, mode: uploadMode(stat.mode, DEFAULT_DIR_MODE) });
      const children = await fs.promises.readdir(local).catch((err: unknown) => {
        throw new TransferError('Cannot read folder', local, 'local', err);
      });
      for (const child of children) {
        await walk(path.join(local, child), remoteJoin(remote, child), `${label}/${child}`, false);
      }
      return;
    }
    if (!stat.isFile()) {
      skipped += 1;
      return;
    }
    files.push({ local, remote, label, size: stat.size, mode: uploadMode(stat.mode, DEFAULT_FILE_MODE) });
    if (files.length > options.maxFiles) throw new TooManyFiles(options.maxFiles, 'upload');
    if (options.onScan && files.length - lastReport >= 50) {
      lastReport = files.length;
      options.onScan(files.length);
    }
  };

  for (const local of localPaths) {
    const name = path.basename(local);
    const remote = remoteJoin(remoteDir, name);
    tops.push({ local, remote, name });
    await walk(local, remote, name, true);
  }
  return { files, directories, skipped, tops };
}

/** SFTP status code 2 (no such file) or 3 (permission denied). */
function sftpCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/** Re-root a planned path from one top-level target to another. */
function rebase(remote: string, from: string, to: string): string {
  return remote === from ? to : to + remote.slice(from.length);
}

interface Meter {
  add(bytes: number): void;
  file(name: string): void;
  fileDone(): void;
}

function meter(progress: TransferProgress, options: TransferOptions): Meter {
  let last = 0;
  const report = (force: boolean) => {
    const now = Date.now();
    if (!force && now - last < 100) return;
    last = now;
    options.onProgress({ ...progress });
  };
  return {
    add: (bytes) => {
      progress.bytes += bytes;
      report(false);
    },
    file: (name) => {
      progress.current = name;
      report(true);
    },
    fileDone: () => {
      progress.files += 1;
      report(true);
    },
  };
}

export class SshSession {
  private closed = false;
  private shell: ClientChannel | null = null;
  private lastError: string | undefined;

  constructor(
    private readonly clients: Client[],
    private readonly sftp: SFTPWrapper | null,
    private readonly onRemoteClose: (reason: string | undefined) => void,
  ) {
    for (const client of clients) {
      client.on('error', (err: Error) => {
        this.lastError = humanizeSshError(err);
      });
    }
    sftp?.on('error', (err: Error) => {
      this.lastError = humanizeSshError(err);
    });
    const finalClient = clients[clients.length - 1];
    finalClient?.on('close', () => {
      if (!this.closed) this.onRemoteClose(this.lastError);
    });
  }

  /** False on servers without SFTP: the shell works, files do not. */
  hasFiles(): boolean {
    return this.sftp !== null;
  }

  private files(): SFTPWrapper {
    if (!this.sftp) throw new Error('SFTP is not available on this server');
    return this.sftp;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.shell?.close();
    } catch {
      // Already closed.
    }
    this.shell = null;
    try {
      this.sftp?.end();
    } catch {
      // Already closed.
    }
    for (const client of [...this.clients].reverse()) {
      try {
        client.end();
      } catch {
        // Already closed.
      }
    }
  }

  async list(dir: string): Promise<BrowseEntry[]> {
    const sftp = this.files();
    const entries = await callbackOf<import('ssh2').FileEntryWithStats[]>((done) => {
      sftp.readdir(dir, (err, list) => done(err, list ?? []));
    });
    return entries
      .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
      .map((entry) => {
        let kind: BrowseEntry['kind'] = 'other';
        if (entry.attrs.isDirectory()) kind = 'dir';
        else if (entry.attrs.isSymbolicLink()) kind = 'link';
        else if (entry.attrs.isFile()) kind = 'file';
        return {
          name: entry.filename,
          path: remoteJoin(dir, entry.filename),
          kind,
          size: asCount(entry.attrs.size),
          mtime: asCount(entry.attrs.mtime) * 1000,
        };
      });
  }

  async expand(input: string): Promise<string> {
    const target = !input || input === '~' || input === '.' ? '.' : input.startsWith('~/') ? input.slice(2) || '.' : input;
    if (input.startsWith('~/')) {
      const home = await this.realpath('.');
      return this.realpath(remoteJoin(home, input.slice(2)));
    }
    return this.realpath(target);
  }

  async resolve(input: string, cwd: string): Promise<{ path: string; kind: 'dir' | 'file' | 'other' }> {
    const combined = !input || input === '~' || input.startsWith('/') || input.startsWith('~')
      ? input || '~'
      : remoteJoin(cwd, input);
    const path = await this.expand(combined);
    const kind = await this.kindOf(path);
    return { path, kind };
  }

  /**
   * Download one file into folder as name, numbered when taken. Bytes go to a
   * hidden .part file with the remote permission bits, then it is renamed.
   */
  async download(remotePath: string, folder: string, name: string, options: TransferOptions): Promise<DownloadResult> {
    await fs.promises.mkdir(folder, { recursive: true }).catch((err: unknown) => {
      throw new TransferError('Cannot create folder', folder, 'local', err);
    });
    const target = reserveLocalTarget(folder, safeFileName(name), 'file');
    try {
      const progress: TransferProgress = { phase: 'copy', bytes: 0, totalBytes: 0, files: 0, totalFiles: 1, current: name };
      const result = await this.fetchFile(remotePath, target.path, progress, options);
      return { localPath: target.path, bytes: result.bytes, grew: result.grew };
    } finally {
      target.release();
    }
  }

  /**
   * Download one file to exactly localPath, e.g. a path picked in a save dialog
   * (which already asked about replacing). Bytes go to a hidden .part file first.
   */
  async downloadTo(remotePath: string, localPath: string, options: TransferOptions): Promise<DownloadResult> {
    const folder = path.dirname(localPath);
    await fs.promises.mkdir(folder, { recursive: true }).catch((err: unknown) => {
      throw new TransferError('Cannot create folder', folder, 'local', err);
    });
    const progress: TransferProgress = { phase: 'copy', bytes: 0, totalBytes: 0, files: 0, totalFiles: 1, current: path.basename(localPath) };
    const result = await this.fetchFile(remotePath, localPath, progress, options);
    return { localPath, bytes: result.bytes, grew: result.grew };
  }

  /** What a path is, following symlinks. */
  async stat(remotePath: string): Promise<RemoteStat> {
    const sftp = this.files();
    const stats = await callbackOf<import('ssh2').Stats>((done) => sftp.stat(remotePath, (err, found) => done(err, found)));
    return {
      kind: stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other',
      size: asCount(stats.size),
      mtime: asCount(stats.mtime) * 1000,
    };
  }

  /** Rename on the server. Refuses to replace an existing name. */
  async rename(from: string, to: string): Promise<void> {
    const sftp = this.files();
    if (await this.exists(to)) {
      throw new TransferError('Cannot rename', from, 'remote', new Error(`${remoteBasename(to)} already exists`));
    }
    await callbackOf<void>((done) => sftp.rename(from, to, (err) => done(err, undefined))).catch((err: unknown) => {
      throw new TransferError('Cannot rename', from, 'remote', err);
    });
  }

  /**
   * Delete a file or symlink, or a folder with everything in it (symlinks inside
   * are removed, never followed). Stops between items when cancelled.
   */
  async remove(remotePath: string, options: RemoveOptions): Promise<{ files: number; folders: number }> {
    const sftp = this.files();
    const target = normalizeRemote(remotePath);
    if (!target.startsWith('/') || target === '/') {
      throw new TransferError('Cannot delete', remotePath, 'remote', new Error('refusing to delete this path'));
    }
    const top = await callbackOf<import('ssh2').Stats>((done) => sftp.lstat(target, (err, found) => done(err, found))).catch((err: unknown) => {
      throw new TransferError('Cannot delete', target, 'remote', err);
    });
    let files = 0;
    let folders = 0;
    const tick = () => options.onProgress?.(files + folders);
    const unlink = async (file: string) => {
      if (options.signal.aborted) throw new TransferCancelled();
      await callbackOf<void>((done) => sftp.unlink(file, (err) => done(err, undefined))).catch((err: unknown) => {
        throw new TransferError('Cannot delete', file, 'remote', err);
      });
      files += 1;
      tick();
    };
    const walk = async (dir: string): Promise<void> => {
      if (options.signal.aborted) throw new TransferCancelled();
      const entries = await callbackOf<import('ssh2').FileEntryWithStats[]>((done) => sftp.readdir(dir, (err, list) => done(err, list ?? []))).catch((err: unknown) => {
        throw new TransferError('Cannot read folder', dir, 'remote', err);
      });
      const plain: string[] = [];
      const subfolders: string[] = [];
      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        const child = remoteJoin(dir, entry.filename);
        if (entry.attrs.isDirectory()) subfolders.push(child);
        else plain.push(child);
      }
      // A few requests in flight: deleting is bound by round trips.
      let next = 0;
      const worker = async () => {
        while (next < plain.length) {
          const file = plain[next];
          next += 1;
          await unlink(file);
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, plain.length) }, worker));
      for (const sub of subfolders) await walk(sub);
      if (options.signal.aborted) throw new TransferCancelled();
      await callbackOf<void>((done) => sftp.rmdir(dir, (err) => done(err, undefined))).catch((err: unknown) => {
        throw new TransferError('Cannot delete folder', dir, 'remote', err);
      });
      folders += 1;
      tick();
    };
    if (top.isDirectory()) await walk(target);
    else await unlink(target);
    return { files, folders };
  }

  /** Count the files and subfolders under a folder, up to cap files or timeoutMs. */
  async countTree(remotePath: string, options: { cap: number; timeoutMs: number }): Promise<TreeCount> {
    const sftp = this.files();
    const deadline = Date.now() + options.timeoutMs;
    let files = 0;
    let folders = 0;
    const queue = [remotePath];
    while (queue.length > 0) {
      if (files >= options.cap || Date.now() > deadline) return { files: Math.min(files, options.cap), folders, capped: true };
      const dir = queue.shift() as string;
      let entries: import('ssh2').FileEntryWithStats[];
      try {
        entries = await callbackOf<import('ssh2').FileEntryWithStats[]>((done) => sftp.readdir(dir, (err, list) => done(err, list ?? [])));
      } catch (err) {
        if (dir === remotePath) throw err;
        continue;
      }
      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        if (entry.attrs.isDirectory()) {
          folders += 1;
          queue.push(remoteJoin(dir, entry.filename));
        } else files += 1;
      }
    }
    return { files, folders, capped: false };
  }

  private async fetchFile(
    remotePath: string,
    localPath: string,
    progress: TransferProgress,
    options: TransferOptions,
    knownSize?: boolean,
  ): Promise<{ bytes: number; grew: boolean }> {
    const sftp = this.files() as unknown as SftpHandleApi;
    if (options.signal.aborted) throw new TransferCancelled();
    const handle = await sftpOpen(sftp, remotePath, 'r').catch((err: unknown) => {
      throw new TransferError('Cannot read', remotePath, 'remote', err);
    });
    const partial = path.join(path.dirname(localPath), `.${path.basename(localPath)}.${partSuffix()}.part`);
    let local: fs.promises.FileHandle | undefined;
    try {
      const stat = await sftpFstat(sftp, handle).catch((err: unknown) => {
        throw new TransferError('Cannot read', remotePath, 'remote', err);
      });
      if (!knownSize) progress.totalBytes += stat.size;
      local = await fs.promises.open(partial, 'wx', downloadMode(stat.mode, 'file')).catch((err: unknown) => {
        throw new TransferError('Cannot write', localPath, 'local', err);
      });
      const counter = meter(progress, options);
      const result = await downloadHandle(sftp, handle, stat.size, localFile(local), {
        concurrency: options.concurrency,
        signal: options.signal,
        onBytes: (bytes) => counter.add(bytes),
      }).catch((err: unknown) => {
        if (err instanceof TransferCancelled || err instanceof IncompleteTransfer) throw err;
        const side = (err as NodeJS.ErrnoException)?.code && typeof (err as NodeJS.ErrnoException).code === 'string' ? 'local' : 'remote';
        throw new TransferError(side === 'local' ? 'Cannot write' : 'Cannot read', side === 'local' ? localPath : remotePath, side, err);
      });
      await local.close();
      local = undefined;
      await renameWithRetry(partial, localPath).catch((err: unknown) => {
        throw new TransferError('Cannot save', localPath, 'local', err);
      });
      if (!knownSize && result.bytes > stat.size) progress.totalBytes += result.bytes - stat.size;
      return { bytes: result.bytes, grew: result.bytes > stat.size };
    } catch (err) {
      await local?.close().catch(() => undefined);
      await fs.promises.rm(partial, { force: true }).catch(() => undefined);
      throw err;
    } finally {
      await sftpClose(sftp, handle);
    }
  }

  /**
   * Download a whole folder, keeping its structure. It is listed first (up to
   * maxFiles), written into a hidden temporary folder, and renamed into place
   * at the end, so a cancelled or failed download leaves nothing behind.
   * Symlinks and special files are skipped and reported.
   */
  async downloadFolder(
    remotePath: string,
    folder: string,
    name: string,
    options: TransferOptions & { maxFiles: number },
  ): Promise<FolderDownloadResult> {
    const sftp = this.files();
    const progress: TransferProgress = { phase: 'scan', bytes: 0, totalBytes: 0, files: 0, totalFiles: 0 };
    interface FileJob { remote: string; local: string; rel: string; size: number }
    const files: FileJob[] = [];
    const folders: { local: string; mode: number }[] = [];
    const skipped: FolderDownloadResult['skipped'] = [];

    const topStat = await callbackOf<import('ssh2').Stats>((done) => sftp.stat(remotePath, (err, stats) => done(err, stats))).catch((err: unknown) => {
      throw new TransferError('Cannot read', remotePath, 'remote', err);
    });
    if (!topStat.isDirectory()) throw new TransferError('Cannot download', remotePath, 'remote', new Error('not a folder'));

    await fs.promises.mkdir(folder, { recursive: true }).catch((err: unknown) => {
      throw new TransferError('Cannot create folder', folder, 'local', err);
    });
    const target = reserveLocalTarget(folder, safeFileName(name), 'folder');
    const temp = path.join(folder, `.${path.basename(target.path)}.${partSuffix()}.part`);
    try {
      folders.push({ local: temp, mode: downloadMode(topStat.mode, 'folder') });
      // Breadth-first listing. Local names are made safe and unique per folder.
      const queue: { remote: string; local: string; rel: string }[] = [{ remote: remotePath, local: temp, rel: '' }];
      let lastScan = 0;
      while (queue.length > 0) {
        if (options.signal.aborted) throw new TransferCancelled();
        const dir = queue.shift() as { remote: string; local: string; rel: string };
        let entries: import('ssh2').FileEntryWithStats[];
        try {
          entries = await callbackOf<import('ssh2').FileEntryWithStats[]>((done) => sftp.readdir(dir.remote, (err, list) => done(err, list ?? [])));
        } catch (err) {
          if (dir.rel === '') throw new TransferError('Cannot read folder', dir.remote, 'remote', err);
          skipped.push({ path: dir.rel, reason: 'folder not readable' });
          continue;
        }
        const names = new NameSet();
        entries.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
        for (const entry of entries) {
          if (entry.filename === '.' || entry.filename === '..') continue;
          const rel = dir.rel ? `${dir.rel}/${entry.filename}` : entry.filename;
          const remote = remoteJoin(dir.remote, entry.filename);
          if (entry.attrs.isSymbolicLink()) {
            skipped.push({ path: rel, reason: 'symlink' });
            continue;
          }
          if (entry.attrs.isDirectory()) {
            const local = path.join(dir.local, names.take(safeFileName(entry.filename), 'folder'));
            folders.push({ local, mode: downloadMode(entry.attrs.mode, 'folder') });
            queue.push({ remote, local, rel });
            continue;
          }
          if (!entry.attrs.isFile()) {
            skipped.push({ path: rel, reason: 'special file' });
            continue;
          }
          const size = asCount(entry.attrs.size);
          files.push({ remote, local: path.join(dir.local, names.take(safeFileName(entry.filename), 'file')), rel, size });
          progress.totalBytes += size;
          if (files.length > options.maxFiles) throw new TooManyFiles(options.maxFiles, 'download');
        }
        progress.totalFiles = files.length;
        if (Date.now() - lastScan > 100) {
          lastScan = Date.now();
          options.onProgress({ ...progress });
        }
      }
      progress.phase = 'copy';
      progress.totalFiles = files.length;
      options.onProgress({ ...progress });
      for (const item of folders) {
        await fs.promises.mkdir(item.local, { recursive: true, mode: item.mode }).catch((err: unknown) => {
          throw new TransferError('Cannot create folder', item.local, 'local', err);
        });
      }
      // A few files at a time: small files are bound by round trips, not bandwidth.
      let next = 0;
      let failure: unknown;
      const worker = async () => {
        while (failure === undefined && next < files.length) {
          const job = files[next];
          next += 1;
          try {
            meter(progress, options).file(job.rel);
            const fetched = await this.fetchFile(job.remote, job.local, progress, options, true);
            // The listing size was counted already; correct it for files that changed since.
            progress.totalBytes += fetched.bytes - job.size;
            meter(progress, options).fileDone();
          } catch (err) {
            if (failure === undefined) failure = err;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
      if (failure !== undefined) throw failure;
      if (options.signal.aborted) throw new TransferCancelled();
      await renameWithRetry(temp, target.path).catch((err: unknown) => {
        throw new TransferError('Cannot save', target.path, 'local', err);
      });
      return {
        localPath: target.path,
        files: files.length,
        folders: folders.length,
        bytes: progress.bytes,
        skipped,
      };
    } catch (err) {
      await fs.promises.rm(temp, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    } finally {
      target.release();
    }
  }

  /**
   * Upload dropped files and folders into remoteDir. Existing top-level targets
   * are only replaced when the user says so. Each file is written to a hidden
   * temporary name and renamed into place, so a failed upload never leaves a
   * half-written file under the real name.
   */
  async upload(localPaths: string[], remoteDir: string, options: UploadOptions): Promise<UploadResult> {
    const progress: TransferProgress = { phase: 'scan', bytes: 0, totalBytes: 0, files: 0, totalFiles: 0 };
    const collected = await collectUploads(localPaths, remoteDir, {
      signal: options.signal,
      maxFiles: options.maxFiles,
      onScan: (count) => options.onProgress({ ...progress, totalFiles: count }),
    });
    let { files, directories } = collected;
    const renamed: string[] = [];
    let kept = 0;

    const existing: { remote: string; name: string }[] = [];
    for (const top of collected.tops) {
      if (await this.exists(top.remote)) existing.push(top);
    }
    if (existing.length > 0) {
      const choice = await options.resolveConflict(existing.map((item) => item.name));
      if (choice === 'cancel') throw new TransferCancelled();
      if (choice === 'skip') {
        for (const item of existing) {
          const inside = (remote: string) => remote === item.remote || remote.startsWith(`${item.remote}/`);
          files = files.filter((file) => !inside(file.remote));
          directories = directories.filter((dir) => !inside(dir.remote));
          kept += 1;
        }
      } else if (choice === 'keep') {
        for (const item of existing) {
          const fresh = await this.freeRemoteName(remoteDir, item.name);
          const moved = remoteJoin(remoteDir, fresh);
          files = files.map((file) => ({ ...file, remote: rebase(file.remote, item.remote, moved) }));
          directories = directories.map((dir) => ({ ...dir, remote: rebase(dir.remote, item.remote, moved) }));
          renamed.push(`${item.name} -> ${fresh}`);
        }
      }
    }

    progress.phase = 'copy';
    progress.totalFiles = files.length;
    progress.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    options.onProgress({ ...progress });
    for (const dir of directories) await this.mkdirp(dir.remote, dir.mode);
    for (const file of files) {
      if (options.signal.aborted) throw new TransferCancelled();
      await this.mkdirp(remoteDirname(file.remote));
      meter(progress, options).file(file.label);
      await this.putFile(file, progress, options);
      meter(progress, options).fileDone();
    }
    return { uploaded: files.length, skipped: collected.skipped, kept, renamed };
  }

  private async putFile(file: UploadPlan, progress: TransferProgress, options: TransferOptions): Promise<void> {
    const sftp = this.files() as unknown as SftpHandleApi;
    const raw = this.files();
    const dir = remoteDirname(file.remote);
    const temp = remoteJoin(dir, `.${remoteBasename(file.remote)}.${partSuffix()}.part`);
    let target = temp;
    let handle: Buffer;
    try {
      handle = await sftpOpen(sftp, temp, 'wx', file.mode);
    } catch (err) {
      // A folder where the user may replace a file but not create one: write in place.
      if (sftpCode(err) !== 3) throw new TransferError('Cannot write', file.remote, 'remote', err);
      target = file.remote;
      handle = await sftpOpen(sftp, file.remote, 'w', file.mode).catch((inner: unknown) => {
        throw new TransferError('Cannot write', file.remote, 'remote', inner);
      });
    }
    let local: fs.promises.FileHandle | undefined;
    let finished = false;
    try {
      // open() only applies the mode to a new file; an existing one keeps its own.
      if (sftp.fchmod) {
        await callbackOf<void>((done) => sftp.fchmod?.(handle, file.mode, (err) => done(err, undefined))).catch(() => undefined);
      }
      local = await fs.promises.open(file.local, 'r').catch((err: unknown) => {
        throw new TransferError('Cannot read', file.local, 'local', err);
      });
      const counter = meter(progress, options);
      const result = await uploadHandle(sftp, handle, file.size, localFile(local), {
        concurrency: options.concurrency,
        signal: options.signal,
        onBytes: (bytes) => counter.add(bytes),
      }).catch((err: unknown) => {
        if (err instanceof TransferCancelled || err instanceof IncompleteTransfer) throw err;
        const code = (err as NodeJS.ErrnoException)?.code;
        if (typeof code === 'string') throw new TransferError('Cannot read', file.local, 'local', err);
        throw new TransferError('Cannot write', file.remote, 'remote', err);
      });
      const written = await sftpFstat(sftp, handle).catch(() => undefined);
      if (written && written.size !== result.bytes) throw new IncompleteTransfer(written.size, result.bytes);
      await sftpClose(sftp, handle);
      finished = true;
      if (target === temp) await this.moveIntoPlace(raw, temp, file.remote);
    } catch (err) {
      if (!finished) await sftpClose(sftp, handle);
      if (target === temp) {
        await callbackOf<void>((done) => raw.unlink(temp, (e) => done(e, undefined))).catch(() => undefined);
      }
      throw err;
    } finally {
      await local?.close().catch(() => undefined);
    }
  }

  /** Rename over an existing file: posix-rename@openssh.com when offered, else remove then rename. */
  private async moveIntoPlace(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
    const posix = (sftp as unknown as { ext_openssh_rename?: SFTPWrapper['ext_openssh_rename'] }).ext_openssh_rename;
    if (typeof posix === 'function') {
      try {
        await callbackOf<void>((done) => posix.call(sftp, from, to, (err) => done(err, undefined)));
        return;
      } catch {
        // Not offered by this server; fall through.
      }
    }
    try {
      await callbackOf<void>((done) => sftp.rename(from, to, (err) => done(err, undefined)));
      return;
    } catch (err) {
      if (!(await this.exists(to))) throw new TransferError('Cannot save', to, 'remote', err);
    }
    await callbackOf<void>((done) => sftp.unlink(to, (err) => done(err, undefined))).catch((err: unknown) => {
      throw new TransferError('Cannot replace', to, 'remote', err);
    });
    await callbackOf<void>((done) => sftp.rename(from, to, (err) => done(err, undefined))).catch((err: unknown) => {
      throw new TransferError('Cannot save', to, 'remote', err);
    });
  }

  async exists(remote: string): Promise<boolean> {
    const sftp = this.files();
    return callbackOf<import('ssh2').Stats>((done) => sftp.lstat(remote, (err, stats) => done(err, stats)))
      .then(() => true)
      .catch(() => false);
  }

  private async freeRemoteName(dir: string, name: string): Promise<string> {
    for (let index = 1; index < 1000; index += 1) {
      const candidate = numberedName(name, index, 'file');
      if (!(await this.exists(remoteJoin(dir, candidate)))) return candidate;
    }
    throw new TransferError('Cannot upload', remoteJoin(dir, name), 'remote', new Error('no free name'));
  }

  /**
   * Open the account's login shell on a terminal.
   * Aliases, functions, and the working directory then persist, as they do over ssh.
   */
  async openShell(columns: number, rows: number, onData: (chunk: string) => void, onClose: () => void): Promise<void> {
    if (this.closed) throw new Error('Not connected');
    const client = this.clients[this.clients.length - 1];
    if (!client) throw new Error('Not connected');
    const window = terminalWindow(columns, rows);
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell({ rows: window.rows, cols: window.cols, term: 'xterm-256color', modes: loginTerminalModes() }, (err, channel) => {
        if (err || !channel) reject(err ?? new Error('The server did not open a shell'));
        else resolve(channel);
      });
    });
    if (this.closed) {
      stream.close();
      throw new Error('Not connected');
    }
    this.shell = stream;
    const decoder = new StringDecoder('utf8');
    stream.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (text) onData(text);
    });
    stream.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text) onData(text);
    });
    stream.on('error', (err: Error) => {
      this.lastError = humanizeSshError(err);
    });
    stream.on('close', () => {
      const rest = decoder.end();
      if (rest) onData(rest);
      this.shell = null;
      onClose();
    });
  }

  writeShell(data: string): void {
    this.shell?.write(data);
  }

  hasShell(): boolean {
    return this.shell !== null;
  }

  resizeShell(columns: number, rows: number): void {
    const window = terminalWindow(columns, rows);
    this.shell?.setWindow(window.rows, window.cols, 0, 0);
  }

  private async realpath(target: string): Promise<string> {
    const sftp = this.files();
    return callbackOf<string>((done) => {
      sftp.realpath(target, (err, absPath) => done(err, absPath));
    });
  }

  private async kindOf(target: string): Promise<'dir' | 'file' | 'other'> {
    const sftp = this.files();
    const stat = await callbackOf<import('ssh2').Stats>((done) => {
      sftp.stat(target, (err, stats) => done(err, stats));
    });
    if (stat.isDirectory()) return 'dir';
    if (stat.isFile()) return 'file';
    return 'other';
  }

  /** Create dir and any missing parents. New parents get DEFAULT_DIR_MODE; existing directories are left as they are. */
  private async mkdirp(dir: string, mode: number = DEFAULT_DIR_MODE): Promise<void> {
    if (!dir || dir === '/' || dir === '.') return;
    const sftp = this.files();
    const parent = remoteDirname(dir);
    if (parent !== dir) {
      const parentKind = await this.kindOf(parent).catch(() => 'missing' as const);
      if (parentKind === 'missing') await this.mkdirp(parent);
    }
    try {
      await callbackOf<void>((done) => {
        sftp.mkdir(dir, { mode }, (err) => done(err, undefined));
      });
    } catch (err) {
      const kind = await this.kindOf(dir).catch(() => 'missing' as const);
      if (kind !== 'dir') throw err instanceof TransferError ? err : new TransferError('Cannot create folder', dir, 'remote', err);
    }
  }
}

function hostLabel(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/**
 * Open an SSH session: every hop is verified (known_hosts, then Easy SSH's own
 * store, then the user) and signed in, then SFTP and a shell probe run on the
 * last hop. SFTP is optional; without it the session is terminal only.
 */
export async function openSession(options: OpenSessionOptions): Promise<OpenedSession> {
  const clients: Client[] = [];
  const notes: string[] = [];
  const readKey = options.readKey ?? readKeyFile;
  const record = options.record;
  const chain = [...record.jumps.map(endpointOf), endpointOf(record)];
  const ids = hopIds(chain);
  const toTrust: { id: string; fingerprint: string; host: string; port: number; key: Buffer; fresh: boolean }[] = [];
  let savePassword: string | undefined;

  const connectHop = async (index: number, sock?: NodeReadable): Promise<Client> => {
    const endpoint = chain[index];
    const hop = ids[index];
    const main = index === chain.length - 1;
    let deadline: Deadline | undefined;
    const paused = <T>(work: () => Promise<T>): Promise<T> => {
      deadline?.pause();
      return work().finally(() => deadline?.resume());
    };
    const authEndpoint: AuthEndpoint = { ...endpoint, main };
    const planner = new AuthPlanner(authEndpoint, {
      savedPassword: endpoint.auth === 'password' && !record.askPassword ? options.secret.password : undefined,
      savedPassphrase: options.secret.passphrase && record.privateKeyPath
        ? { keyPath: expandHome(record.privateKeyPath, os.homedir()), passphrase: options.secret.passphrase }
        : undefined,
      askPassword: record.askPassword === true,
      agent: options.agent,
      identityFiles: [...options.identityFiles],
      readKey: (file) => readKey(file),
      ask: (request) => paused(() => options.ui.ask(request)),
      log: options.log,
    });
    let hostKeyFailure: Error | undefined;
    const via = index > 0 ? chain.slice(0, index).map((item) => hostLabel(item.host, item.port)).join(' > ') : undefined;
    const config: ConnectConfig = {
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.username,
      // Easy SSH runs its own deadline that stops while a prompt is open.
      readyTimeout: 0,
      keepaliveInterval: options.keepaliveInterval,
      keepaliveCountMax: options.keepaliveCountMax,
      authHandler: planner.handler as unknown as ConnectConfig['authHandler'],
      hostVerifier: ((key: Buffer, verify: (ok: boolean) => void) => {
        const decision = decideHostKey(hop, key, options.knownHosts, options.known, options.hostKeyPolicy, new Map());
        if (decision.action === 'trust') {
          verify(true);
          return;
        }
        if (decision.action === 'reject') {
          hostKeyFailure = new HostKeyError(endpoint.host, endpoint.port, decision.fingerprint);
          verify(false);
          return;
        }
        if (decision.action === 'store') {
          toTrust.push({ id: hop.id, fingerprint: decision.fingerprint, host: endpoint.host, port: endpoint.port, key, fresh: true });
          verify(true);
          return;
        }
        paused(() => options.ui.trustHostKey({
          kind: decision.kind,
          hostLabel: hostLabel(endpoint.host, endpoint.port),
          via,
          fingerprint: decision.fingerprint,
          previous: decision.previous,
        })).then(
          (ok) => {
            if (!ok) {
              hostKeyFailure = new HostKeyDeclined(endpoint.host, endpoint.port);
              verify(false);
              return;
            }
            toTrust.push({
              id: hop.id,
              fingerprint: decision.fingerprint,
              host: endpoint.host,
              port: endpoint.port,
              key,
              fresh: decision.kind === 'unknown',
            });
            verify(true);
          },
          () => {
            hostKeyFailure = new HostKeyDeclined(endpoint.host, endpoint.port);
            verify(false);
          },
        );
      }) as unknown as ConnectConfig['hostVerifier'],
    };
    if (sock) config.sock = sock;
    try {
      const opened = await connectClient(config, options.signal, {
        deadline: (client) => {
          deadline = new Deadline(options.readyTimeout, () => {
            client.emit('error', new Error('Timed out while waiting for the server'));
          });
          return deadline;
        },
        log: options.log,
      });
      clients.push(opened.client);
      if (main && planner.typed?.save && planner.typed.value) savePassword = planner.typed.value;
      return opened.client;
    } catch (err) {
      if (err instanceof TransferCancelled) throw err;
      if (hostKeyFailure) throw hostKeyFailure;
      const reason = planner.stopReason;
      if (reason instanceof TransferCancelled || reason instanceof AuthFailure) throw reason;
      if (/authentication methods failed/i.test((err as Error)?.message ?? '')) throw new AuthFailure(planner.explain());
      throw new Error(humanizeSshError(err));
    }
  };

  try {
    let sock: NodeReadable | undefined;
    for (let index = 0; index < chain.length; index += 1) {
      const client = await connectHop(index, sock);
      if (index < chain.length - 1) {
        const next = chain[index + 1];
        sock = await forward(client, next.host, next.port);
      }
    }
    for (const key of toTrust) {
      await options.known.trust(key.id, key.fingerprint);
      if (key.fresh) {
        notes.push(`Trusted the host key of ${hostLabel(key.host, key.port)} (${formatFingerprintShort(key.fingerprint)})`);
        if (options.writeKnownHost) {
          await options.writeKnownHost(knownHostsLine(key.host, key.port, key.key)).catch((err: unknown) => {
            options.log(`Could not add ${key.host} to ~/.ssh/known_hosts: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
    }
    const finalClient = clients[clients.length - 1];
    const [sftp, probed] = await Promise.all([
      openSftp(finalClient).catch((err: unknown) => {
        options.log(`SFTP is not available: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }),
      probeShell(finalClient),
    ]);
    const shell = shellKindFromProbe(probed);
    options.log(`Login shell: ${probed?.trim() || 'unknown'} (${shell})`);
    let notify = false;
    const session = new SshSession(clients, sftp, (reason) => {
      if (notify) options.onClose(reason);
    });
    let cwd = '';
    let usedFallbackPath = false;
    if (sftp) {
      try {
        cwd = await session.expand(record.startPath || '~');
      } catch {
        usedFallbackPath = Boolean(record.startPath);
        cwd = await session.expand('~').catch(() => '/');
      }
    } else {
      notes.push('This server has no SFTP: the terminal works, but file links, downloads and uploads are off');
    }
    notify = true;
    return { session, cwd, usedFallbackPath, notes, shell, savePassword };
  } catch (err) {
    for (const client of clients.reverse()) {
      try {
        client.end();
      } catch {
        // Ignore.
      }
    }
    throw err;
  }
}

function formatFingerprintShort(hex: string): string {
  return `SHA256:${Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '')}`;
}
