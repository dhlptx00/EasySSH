import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough, Readable, Writable, type Readable as NodeReadable } from 'stream';
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { remoteDirname, remoteJoin } from '../remotePath';
import { expandHome } from '../text';
import type { AuthMethod, BrowseEntry, ConnectionRecord, JumpSpec, SecretPayload, TransferState } from '../types';
import { HostKeyChangedError, TransferCancelled, humanizeSshError } from './errors';

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

async function pipeTransfer(
  source: Readable,
  destination: Writable,
  total: number,
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
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
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      source.destroy();
      meter.destroy();
      destination.destroy();
      finish(new TransferCancelled());
    };
    signal.addEventListener('abort', onAbort);
    meter.on('data', (chunk: Buffer) => {
      transferred += chunk.length;
      onProgress(transferred, total);
    });
    source.on('error', (err) => finish(err));
    meter.on('error', (err) => finish(err));
    destination.on('error', (err) => finish(err));
    destination.on('finish', () => finish());
    source.pipe(meter).pipe(destination);
  });
}

interface UploadPlan {
  local: string;
  remote: string;
  label: string;
  size: number;
}

async function collectUploads(
  localPaths: string[],
  remoteDir: string,
): Promise<{ files: UploadPlan[]; directories: string[]; skipped: number }> {
  const files: UploadPlan[] = [];
  const directories: string[] = [];
  let skipped = 0;

  const walk = async (local: string, remote: string, label: string) => {
    const stat = await fs.promises.lstat(local);
    if (stat.isSymbolicLink()) {
      skipped += 1;
      return;
    }
    if (stat.isDirectory()) {
      directories.push(remote);
      const children = await fs.promises.readdir(local);
      for (const child of children) {
        await walk(path.join(local, child), remoteJoin(remote, child), `${label}/${child}`);
      }
      return;
    }
    if (!stat.isFile()) {
      skipped += 1;
      return;
    }
    files.push({ local, remote, label, size: stat.size });
  };

  for (const local of localPaths) {
    const name = path.basename(local);
    await walk(local, remoteJoin(remoteDir, name), name);
  }
  if (files.length > 5000) throw new Error('That folder has more than 5000 files. Upload a smaller selection.');
  return { files, directories, skipped };
}

export class SshSession {
  private closed = false;

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
    });
    const total = asCount(stat.size);
    const partial = `${localPath}.part`;
    try {
      if (total === 0) {
        await fs.promises.writeFile(localPath, Buffer.alloc(0));
        onProgress(0, 0);
        return;
      }
      const source = this.sftp.createReadStream(remotePath);
      const destination = fs.createWriteStream(partial);
      await pipeTransfer(source, destination, total, onProgress, signal);
      await fs.promises.rename(partial, localPath);
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
    for (const dir of directories) await this.mkdirp(dir);
    for (let index = 0; index < files.length; index += 1) {
      if (signal.aborted) throw new TransferCancelled();
      const file = files[index];
      await this.mkdirp(remoteDirname(file.remote));
      const source = fs.createReadStream(file.local);
      const destination = this.sftp.createWriteStream(file.remote);
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
      );
    }
    return { uploaded: files.length, skipped };
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

  private async mkdirp(dir: string): Promise<void> {
    if (!dir || dir === '/' || dir === '.') return;
    const parent = remoteDirname(dir);
    if (parent !== dir) {
      const parentKind = await this.kindOf(parent).catch(() => 'missing' as const);
      if (parentKind === 'missing') await this.mkdirp(parent);
    }
    try {
      await callbackOf<void>((done) => {
        this.sftp.mkdir(dir, (err) => done(err, undefined));
      });
    } catch (err) {
      const kind = await this.kindOf(dir).catch(() => 'missing' as const);
      if (kind !== 'dir') throw err;
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
