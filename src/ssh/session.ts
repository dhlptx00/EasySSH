import fs from 'fs';
import os from 'os';
import path from 'path';
import { StringDecoder } from 'node:string_decoder';
import { PassThrough, Readable, Writable, type Readable as NodeReadable } from 'stream';
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper, type TerminalModes } from 'ssh2';
import { remoteDirname, remoteJoin } from '../remotePath';
import { expandHome } from '../text';
import type { AuthMethod, BrowseEntry, ConnectionRecord, JumpSpec, SecretPayload, TransferState } from '../types';
import { HostKeyChangedError, TransferCancelled, TransferError, humanizeSshError } from './errors';
import { SHELL_HOOK } from './shellFeed';

export interface HostKeyStore {
  get(host: string, port: number): string | undefined;
  trust(host: string, port: number, fingerprint: string): Promise<void>;
}

export interface OpenSessionOptions {
  record: ConnectionRecord;
  secret: SecretPayload;
  known: HostKeyStore;
  readyTimeout: number;
  acceptChangedKey: boolean;
  signal: AbortSignal;
  onClose: () => void;
}

interface Endpoint {
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  privateKeyPath?: string;
}

interface FreshKey {
  host: string;
  port: number;
  fingerprint: string;
  wasNew: boolean;
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

function agentSocket(): string {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  throw new Error('No SSH agent is running. Choose a private key or start an agent.');
}

function readKey(file: string): Buffer {
  const expanded = expandHome(file, os.homedir());
  try {
    return fs.readFileSync(expanded);
  } catch {
    throw new Error(`Could not read the private key at ${expanded}`);
  }
}

function endpointOf(record: ConnectionRecord): Endpoint {
  return {
    host: record.host,
    port: record.port,
    username: record.username,
    auth: record.auth,
    privateKeyPath: record.privateKeyPath,
  };
}

function jumpEndpoint(jump: JumpSpec): Endpoint {
  return {
    host: jump.host,
    port: jump.port,
    username: jump.username,
    auth: jump.auth,
    privateKeyPath: jump.privateKeyPath,
  };
}

function passphraseFor(endpoint: Endpoint, record: ConnectionRecord, secret: SecretPayload): string | undefined {
  if (endpoint.auth !== 'privateKey' || !secret.passphrase) return undefined;
  if (endpoint.privateKeyPath && endpoint.privateKeyPath === record.privateKeyPath) return secret.passphrase;
  return undefined;
}

function connectClient(
  config: ConnectConfig,
  password: string | undefined,
  signal: AbortSignal,
): Promise<Client> {
  if (signal.aborted) return Promise.reject(new TransferCancelled());
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (err?: Error, ready?: Client) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (err || !ready) {
        try {
          client.end();
        } catch {
          // The socket may already be gone.
        }
        reject(err ?? new Error('Connection failed'));
        return;
      }
      resolve(ready);
    };
    const onAbort = () => finish(new TransferCancelled());
    signal.addEventListener('abort', onAbort);
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, done) => {
      done(prompts.map(() => password ?? ''));
    });
    client.once('ready', () => finish(undefined, client));
    client.once('error', (err: Error) => finish(err));
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

function callbackOf<T>(run: (done: (err: Error | null | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    run((err, value) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}

/** Turns a stream error into an error that names the operation and path. */
export interface TransferLabels {
  source: (err: Error) => Error;
  destination: (err: Error) => Error;
}

export async function pipeTransfer(
  source: Readable,
  destination: Writable,
  total: number,
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
  labels?: TransferLabels,
): Promise<void> {
  if (signal.aborted) throw new TransferCancelled();
  await new Promise<void>((resolve, reject) => {
    const meter = new PassThrough();
    let transferred = 0;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (err) {
        source.destroy();
        meter.destroy();
        destination.destroy();
        reject(err);
        return;
      }
      resolve();
    };
    const onAbort = () => {
      finish(new TransferCancelled());
    };
    signal.addEventListener('abort', onAbort);
    meter.on('data', (chunk: Buffer) => {
      transferred += chunk.length;
      onProgress(transferred, total);
    });
    source.on('error', (err) => finish(labels ? labels.source(err) : err));
    meter.on('error', (err) => finish(err));
    destination.on('error', (err) => finish(labels ? labels.destination(err) : err));
    // A normal file emits finish. ssh2's remote write stream destroys itself
    // inside _final, and current Node then emits close without finish.
    destination.on('finish', () => finish());
    destination.on('close', () => finish());
    source.pipe(meter).pipe(destination);
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
 * ssh2's write stream otherwise chmods every file to 0o666. Windows reports no
 * real POSIX bits, so it always uses the fallback.
 */
export function uploadMode(localMode: number | undefined, fallback: number, platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32' || localMode === undefined) return fallback;
  const bits = localMode & 0o777;
  return bits === 0 ? fallback : bits;
}

async function collectUploads(
  localPaths: string[],
  remoteDir: string,
): Promise<{ files: UploadPlan[]; directories: { remote: string; mode: number }[]; skipped: number }> {
  const files: UploadPlan[] = [];
  const directories: { remote: string; mode: number }[] = [];
  let skipped = 0;

  const walk = async (local: string, remote: string, label: string, top: boolean) => {
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
  };

  for (const local of localPaths) {
    const name = path.basename(local);
    await walk(local, remoteJoin(remoteDir, name), name, true);
  }
  if (files.length > 5000) throw new Error('That folder has more than 5000 files. Upload a smaller selection.');
  return { files, directories, skipped };
}

export class SshSession {
  private closed = false;
  private shell: ClientChannel | null = null;

  constructor(
    private readonly clients: Client[],
    private readonly sftp: SFTPWrapper,
    private readonly onRemoteClose: () => void,
  ) {
    const finalClient = clients[clients.length - 1];
    finalClient?.on('close', () => {
      if (!this.closed) this.onRemoteClose();
    });
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
      this.sftp.end();
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
    const entries = await callbackOf<import('ssh2').FileEntryWithStats[]>((done) => {
      this.sftp.readdir(dir, (err, list) => done(err, list ?? []));
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

  async download(
    remotePath: string,
    localPath: string,
    onProgress: (done: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const stat = await callbackOf<import('ssh2').Stats>((done) => {
      this.sftp.stat(remotePath, (err, stats) => done(err, stats));
    }).catch((err: unknown) => {
      throw new TransferError('Cannot read', remotePath, 'remote', err);
    });
    const total = asCount(stat.size);
    const partial = `${localPath}.part`;
    const folder = path.dirname(localPath);
    await fs.promises.mkdir(folder, { recursive: true }).catch((err: unknown) => {
      throw new TransferError('Cannot create folder', folder, 'local', err);
    });
    try {
      if (total === 0) {
        await fs.promises.writeFile(localPath, Buffer.alloc(0)).catch((err: unknown) => {
          throw new TransferError('Cannot write', localPath, 'local', err);
        });
        onProgress(0, 0);
        return;
      }
      const source = this.sftp.createReadStream(remotePath);
      const destination = fs.createWriteStream(partial);
      await pipeTransfer(source, destination, total, onProgress, signal, {
        source: (err) => new TransferError('Cannot read', remotePath, 'remote', err),
        destination: (err) => new TransferError('Cannot write', localPath, 'local', err),
      });
      await renameWithRetry(partial, localPath).catch((err: unknown) => {
        throw new TransferError('Cannot save', localPath, 'local', err);
      });
    } catch (err) {
      await fs.promises.rm(partial, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  async upload(
    localPaths: string[],
    remoteDir: string,
    onProgress: (state: TransferState) => void,
    signal: AbortSignal,
  ): Promise<{ uploaded: number; skipped: number }> {
    const { files, directories, skipped } = await collectUploads(localPaths, remoteDir);
    for (const dir of directories) await this.mkdirp(dir.remote, dir.mode);
    for (let index = 0; index < files.length; index += 1) {
      if (signal.aborted) throw new TransferCancelled();
      const file = files[index];
      await this.mkdirp(remoteDirname(file.remote));
      const source = fs.createReadStream(file.local);
      const destination = this.sftp.createWriteStream(file.remote, { mode: file.mode });
      await pipeTransfer(
        source,
        destination,
        file.size,
        (done, total) => {
          onProgress({
            direction: 'upload',
            label: file.label,
            done,
            total,
            index: index + 1,
            count: files.length,
          });
        },
        signal,
        {
          source: (err) => new TransferError('Cannot read', file.local, 'local', err),
          destination: (err) => new TransferError('Cannot write', file.remote, 'remote', err),
        },
      );
    }
    return { uploaded: files.length, skipped };
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
    stream.on('close', () => {
      const rest = decoder.end();
      if (rest) onData(rest);
      this.shell = null;
      onClose();
    });
    stream.write(`${SHELL_HOOK}\n`);
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
    return callbackOf<string>((done) => {
      this.sftp.realpath(target, (err, absPath) => done(err, absPath));
    });
  }

  private async kindOf(target: string): Promise<'dir' | 'file' | 'other'> {
    const stat = await callbackOf<import('ssh2').Stats>((done) => {
      this.sftp.stat(target, (err, stats) => done(err, stats));
    });
    if (stat.isDirectory()) return 'dir';
    if (stat.isFile()) return 'file';
    return 'other';
  }

  /** Create dir and any missing parents. New parents get DEFAULT_DIR_MODE; existing directories are left as they are. */
  private async mkdirp(dir: string, mode: number = DEFAULT_DIR_MODE): Promise<void> {
    if (!dir || dir === '/' || dir === '.') return;
    const parent = remoteDirname(dir);
    if (parent !== dir) {
      const parentKind = await this.kindOf(parent).catch(() => 'missing' as const);
      if (parentKind === 'missing') await this.mkdirp(parent);
    }
    try {
      await callbackOf<void>((done) => {
        this.sftp.mkdir(dir, { mode }, (err) => done(err, undefined));
      });
    } catch (err) {
      const kind = await this.kindOf(dir).catch(() => 'missing' as const);
      if (kind !== 'dir') throw err instanceof TransferError ? err : new TransferError('Cannot create folder', dir, 'remote', err);
    }
  }
}

/**
 * Open an SSH session and its SFTP channel.
 * The first accepted host key for a server is stored. A later change is rejected
 * until the caller retries with acceptChangedKey.
 */
export async function openSession(options: OpenSessionOptions): Promise<{
  session: SshSession;
  cwd: string;
  trustedNewKey: boolean;
  usedFallbackPath: boolean;
}> {
  const fresh: FreshKey[] = [];
  let mismatch: { host: string; port: number; fingerprint: string } | undefined;
  const clients: Client[] = [];

  const verify = (host: string, port: number, fingerprint: string): boolean => {
    const known = options.known.get(host, port);
    if (!known) {
      fresh.push({ host, port, fingerprint, wasNew: true });
      return true;
    }
    if (known === fingerprint) return true;
    if (options.acceptChangedKey) {
      fresh.push({ host, port, fingerprint, wasNew: false });
      return true;
    }
    mismatch = { host, port, fingerprint };
    return false;
  };

  const connectEndpoint = async (endpoint: Endpoint, sock?: Readable) => {
    const password = endpoint.auth === 'password' ? options.secret.password ?? '' : undefined;
    const config: ConnectConfig = {
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.username,
      readyTimeout: options.readyTimeout,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      tryKeyboard: endpoint.auth === 'password',
      hostHash: 'sha256',
      hostVerifier: (fingerprint: string) => verify(endpoint.host, endpoint.port, fingerprint),
    };
    if (sock) config.sock = sock as NodeReadable;
    if (endpoint.auth === 'password') config.password = password ?? '';
    if (endpoint.auth === 'privateKey') {
      if (!endpoint.privateKeyPath) throw new Error('Private key path is missing');
      config.privateKey = readKey(endpoint.privateKeyPath);
      const passphrase = passphraseFor(endpoint, options.record, options.secret);
      if (passphrase) config.passphrase = passphrase;
    }
    if (endpoint.auth === 'agent') config.agent = agentSocket();
    try {
      const client = await connectClient(config, password, options.signal);
      clients.push(client);
      return client;
    } catch (err) {
      if (err instanceof TransferCancelled) throw err;
      if (mismatch) throw new HostKeyChangedError(mismatch.host, mismatch.port, mismatch.fingerprint);
      throw new Error(humanizeSshError(err));
    }
  };

  try {
    const chain = [...options.record.jumps.map(jumpEndpoint), endpointOf(options.record)];
    let sock: Readable | undefined;
    for (let index = 0; index < chain.length; index += 1) {
      const client = await connectEndpoint(chain[index], sock);
      if (index < chain.length - 1) {
        const next = chain[index + 1];
        sock = await forward(client, next.host, next.port);
      }
    }
    for (const key of fresh) await options.known.trust(key.host, key.port, key.fingerprint);
    const finalClient = clients[clients.length - 1];
    const sftp = await openSftp(finalClient);
    let notify = false;
    const session = new SshSession(clients, sftp, () => {
      if (notify) options.onClose();
    });
    let cwd = '';
    let usedFallbackPath = false;
    try {
      cwd = await session.expand(options.record.startPath || '~');
    } catch {
      usedFallbackPath = true;
      cwd = await session.expand('~');
    }
    notify = true;
    return {
      session,
      cwd,
      trustedNewKey: fresh.length > 0,
      usedFallbackPath,
    };
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
