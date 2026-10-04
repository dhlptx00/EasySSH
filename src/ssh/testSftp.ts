/**
 * An in-memory SFTP server with just enough of ssh2's SFTPWrapper for the
 * transfer code: handles, positional reads and writes, stat, readdir, rename,
 * unlink and rmdir.
 * Used by unit tests only.
 */
type Kind = 'file' | 'dir' | 'link' | 'other';

interface Node {
  kind: Kind;
  mode: number;
  data: Buffer;
  /** Reported size, when it differs from the data (like /proc files). */
  reportSize?: number;
}

interface OpenFile {
  path: string;
  node: Node;
  writable: boolean;
}

const TYPE_BITS: Record<Kind, number> = { file: 0o100000, dir: 0o040000, link: 0o120000, other: 0o010000 };

function sftpError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function parentOf(target: string): string {
  const index = target.lastIndexOf('/');
  return index <= 0 ? '/' : target.slice(0, index);
}

export interface FakeSftpOptions {
  /** Folders where new files cannot be created (open 'wx' fails with code 3). */
  noCreate?: Set<string>;
  /** Offer posix-rename@openssh.com. */
  posixRename?: boolean;
  /** Return at most this many bytes per read call. */
  maxRead?: number;
  /** Delay each read by a random 0..n ms so replies arrive out of order. */
  jitter?: number;
}

export class FakeSftp {
  readonly nodes = new Map<string, Node>([['/', { kind: 'dir', mode: 0o755, data: Buffer.alloc(0) }]]);
  private readonly handles = new Map<string, OpenFile>();
  private nextHandle = 1;
  /** Highest number of reads outstanding at once. */
  maxInFlight = 0;
  private inFlight = 0;
  /** Paths whose reads stop early (a file truncated on the server mid-transfer). */
  readonly truncateAt = new Map<string, number>();
  readonly opened: { path: string; flags: string; mode?: number }[] = [];
  readonly ext_openssh_rename?: (from: string, to: string, cb: (err?: Error) => void) => void;

  constructor(private readonly options: FakeSftpOptions = {}) {
    if (options.posixRename) {
      this.ext_openssh_rename = (from, to, cb) => {
        const node = this.nodes.get(from);
        if (!node) return cb(sftpError(2, 'No such file'));
        this.nodes.delete(from);
        this.nodes.set(to, node);
        cb();
      };
    }
  }

  dir(target: string, mode = 0o755): this {
    this.nodes.set(target, { kind: 'dir', mode, data: Buffer.alloc(0) });
    return this;
  }

  file(target: string, content: string | Buffer, mode = 0o644, reportSize?: number): this {
    this.nodes.set(target, { kind: 'file', mode, data: Buffer.from(content), reportSize });
    return this;
  }

  link(target: string): this {
    this.nodes.set(target, { kind: 'link', mode: 0o777, data: Buffer.alloc(0) });
    return this;
  }

  special(target: string): this {
    this.nodes.set(target, { kind: 'other', mode: 0o644, data: Buffer.alloc(0) });
    return this;
  }

  text(target: string): string | undefined {
    return this.nodes.get(target)?.data.toString();
  }

  /** Paths that look like Easy SSH temporary files. */
  leftovers(): string[] {
    return [...this.nodes.keys()].filter((key) => key.endsWith('.part'));
  }

  on(): this {
    return this;
  }

  end(): void {}

  private attrs(node: Node) {
    return {
      mode: TYPE_BITS[node.kind] | node.mode,
      size: node.reportSize ?? node.data.length,
      mtime: 1_700_000_000,
      atime: 1_700_000_000,
      uid: 1000,
      gid: 1000,
      isDirectory: () => node.kind === 'dir',
      isFile: () => node.kind === 'file',
      isSymbolicLink: () => node.kind === 'link',
    };
  }

  stat(target: string, cb: (err: Error | undefined, stats?: ReturnType<FakeSftp['attrs']>) => void): void {
    const node = this.nodes.get(target);
    if (!node) cb(sftpError(2, 'No such file'));
    else cb(undefined, this.attrs(node));
  }

  lstat(target: string, cb: (err: Error | undefined, stats?: ReturnType<FakeSftp['attrs']>) => void): void {
    this.stat(target, cb);
  }

  realpath(target: string, cb: (err: Error | undefined, path?: string) => void): void {
    cb(undefined, target === '.' ? '/home/dev' : target);
  }

  readdir(target: string, cb: (err: Error | undefined, list?: unknown[]) => void): void {
    const node = this.nodes.get(target);
    if (!node || node.kind !== 'dir') return cb(sftpError(2, 'No such file'));
    if (node.mode === 0) return cb(sftpError(3, 'Permission denied'));
    const prefix = target === '/' ? '/' : `${target}/`;
    const list = [...this.nodes.entries()]
      .filter(([key]) => key.startsWith(prefix) && key !== target && !key.slice(prefix.length).includes('/'))
      .map(([key, child]) => ({ filename: key.slice(prefix.length), longname: '', attrs: this.attrs(child) }));
    cb(undefined, list);
  }

  mkdir(target: string, attrs: { mode?: number }, cb: (err?: Error) => void): void {
    if (this.nodes.has(target)) return cb(sftpError(4, 'Failure'));
    if (this.nodes.get(parentOf(target))?.kind !== 'dir') return cb(sftpError(2, 'No such file'));
    this.dir(target, attrs.mode ?? 0o755);
    cb();
  }

  open(target: string, flags: string, attrs: { mode?: number }, cb: (err: Error | undefined, handle?: Buffer) => void): void {
    this.opened.push({ path: target, flags, mode: attrs.mode });
    let node = this.nodes.get(target);
    if (flags === 'r') {
      if (!node || node.kind !== 'file') return cb(sftpError(2, 'No such file'));
    } else {
      if (this.nodes.get(parentOf(target))?.kind !== 'dir') return cb(sftpError(2, 'No such file'));
      if (flags === 'wx' && node) return cb(sftpError(4, 'Failure'));
      if (!node && this.options.noCreate?.has(parentOf(target))) return cb(sftpError(3, 'Permission denied'));
      if (!node) {
        node = { kind: 'file', mode: attrs.mode ?? 0o644, data: Buffer.alloc(0) };
        this.nodes.set(target, node);
      } else {
        node.data = Buffer.alloc(0);
      }
    }
    const id = String(this.nextHandle++);
    this.handles.set(id, { path: target, node, writable: flags !== 'r' });
    cb(undefined, Buffer.from(id));
  }

  private handle(handle: Buffer): OpenFile {
    const open = this.handles.get(handle.toString());
    if (!open) throw sftpError(4, 'Invalid handle');
    return open;
  }

  close(handle: Buffer, cb: (err?: Error) => void): void {
    this.handles.delete(handle.toString());
    cb();
  }

  read(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, cb: (err: Error | undefined, bytes: number) => void): void {
    const open = this.handle(handle);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    const finish = () => {
      this.inFlight -= 1;
      const limit = this.truncateAt.get(open.path) ?? open.node.data.length;
      const end = Math.min(limit, position + Math.min(length, this.options.maxRead ?? length));
      if (position >= end) return cb(undefined, 0);
      const bytes = open.node.data.copy(buffer, offset, position, end);
      cb(undefined, bytes);
    };
    if (this.options.jitter) setTimeout(finish, Math.random() * this.options.jitter);
    else setImmediate(finish);
  }

  write(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, cb: (err?: Error) => void): void {
    const open = this.handle(handle);
    const node = open.node;
    const needed = position + length;
    if (node.data.length < needed) {
      const grown = Buffer.alloc(needed);
      node.data.copy(grown);
      node.data = grown;
    }
    buffer.copy(node.data, position, offset, offset + length);
    setImmediate(() => cb());
  }

  fstat(handle: Buffer, cb: (err: Error | undefined, stats?: ReturnType<FakeSftp['attrs']>) => void): void {
    cb(undefined, this.attrs(this.handle(handle).node));
  }

  fchmod(handle: Buffer, mode: number, cb: (err?: Error) => void): void {
    this.handle(handle).node.mode = mode & 0o777;
    cb();
  }

  rename(from: string, to: string, cb: (err?: Error) => void): void {
    const node = this.nodes.get(from);
    if (!node) return cb(sftpError(2, 'No such file'));
    // SFTP v3 rename fails when the target exists.
    if (this.nodes.has(to)) return cb(sftpError(4, 'Failure'));
    this.nodes.delete(from);
    this.nodes.set(to, node);
    cb();
  }

  unlink(target: string, cb: (err?: Error) => void): void {
    const node = this.nodes.get(target);
    if (!node) return cb(sftpError(2, 'No such file'));
    if (node.kind === 'dir') return cb(sftpError(4, 'Failure'));
    this.nodes.delete(target);
    cb();
  }

  /** Like OpenSSH: only an empty folder can be removed. */
  rmdir(target: string, cb: (err?: Error) => void): void {
    const node = this.nodes.get(target);
    if (!node || node.kind !== 'dir') return cb(sftpError(2, 'No such file'));
    const prefix = target === '/' ? '/' : `${target}/`;
    if ([...this.nodes.keys()].some((key) => key.startsWith(prefix))) return cb(sftpError(4, 'Failure'));
    this.nodes.delete(target);
    cb();
  }
}
