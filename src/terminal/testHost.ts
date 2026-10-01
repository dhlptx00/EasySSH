import { remoteBasename, remoteDirname, remoteJoin } from '../remotePath';
import type { BrowseEntry, ConnectionRecord, TransferState } from '../types';
import type { UploadQuestion } from './cwdTracking';
import type { AppHost, FileSession } from './host';

/** A fake connection for app tests. Everything the app does is recorded. */
export interface FakeRemote {
  record: ConnectionRecord;
  session: FileSession;
  written: string[];
  uploads: { paths: string[]; dir: string }[];
  status: string[];
  logs: string[];
  notes: { tone: 'info' | 'error'; text: string }[];
  questions: UploadQuestion[];
  /** Feed bytes as if the remote shell printed them. */
  push(chunk: string): void;
  host: AppHost;
}

export function fakeRemote(options: {
  name?: string;
  username?: string;
  cwd?: string;
  home?: string;
  files?: BrowseEntry[];
  answer?: (question: UploadQuestion) => string | undefined;
  upload?: (paths: string[], dir: string) => Promise<{ uploaded: number; skipped: number }>;
  list?: (dir: string) => Promise<BrowseEntry[]>;
  /**
   * A server filesystem: folder path to its entries. When given, list and resolve
   * answer from it, a missing path fails like SFTP (code 2), and 'denied' fails
   * like a folder the login user cannot read (code 3).
   */
  tree?: Record<string, BrowseEntry[] | 'denied'>;
  plainClick?: boolean;
} = {}): FakeRemote {
  const username = options.username ?? 'hqxrd';
  const record: ConnectionRecord = {
    id: options.name ?? 'server',
    name: options.name ?? 'server',
    host: '10.0.0.8',
    port: 22,
    username,
    auth: 'agent',
    jumps: [],
  };
  let onData: ((chunk: string) => void) | undefined;
  let shell = false;
  const remote: FakeRemote = {
    record,
    written: [],
    uploads: [],
    status: [],
    logs: [],
    notes: [],
    questions: [],
    push: (chunk) => onData?.(chunk),
    session: {
      list: options.list ?? (options.tree ? async (dir) => treeList(options.tree ?? {}, dir) : async () => options.files ?? []),
      resolve: options.tree
        ? async (input, cwd) => treeResolve(options.tree ?? {}, input === '~' ? options.home ?? `/home/${username}` : remoteJoin(cwd, input))
        : async (input) => ({ path: input === '~' ? options.home ?? `/home/${username}` : input, kind: 'dir' }),
      download: async () => {},
      upload: async (paths: string[], dir: string, onProgress: (state: TransferState) => void) => {
        remote.uploads.push({ paths, dir });
        onProgress({ direction: 'upload', label: 'x', done: 1, total: 1, index: 1, count: paths.length });
        return options.upload ? options.upload(paths, dir) : { uploaded: paths.length, skipped: 0 };
      },
      openShell: async (_columns, _rows, data) => {
        shell = true;
        onData = data;
      },
      writeShell: (data) => {
        remote.written.push(data);
      },
      resizeShell: () => {},
      hasShell: () => shell,
      close: () => {
        shell = false;
      },
    },
    host: undefined as unknown as AppHost,
  };
  remote.host = {
    listConnections: async () => [record],
    saveConnection: async () => {},
    deleteConnection: async () => {},
    secretFlags: async () => ({ password: false, passphrase: false }),
    importConfig: async () => ({ ok: true, message: '' }),
    connect: async () => ({ session: remote.session, cwd: options.cwd ?? `/home/${username}`, trustedNewKey: false, usedFallbackPath: false }),
    downloadFolder: () => 'C:\\Users\\me\\Desktop',
    home: () => 'C:\\Users\\me',
    chooseDownloadFolder: async () => undefined,
    classifyDrop: (text) => (/^[A-Za-z]:\//.test(text) ? [text] : null),
    localDownloadPath: (name) => name,
    keyExists: () => true,
    setStatus: (text) => {
      if (text) remote.status.push(text);
    },
    log: (line) => {
      remote.logs.push(line);
    },
    scrollTerminal: () => {},
    quit: () => {},
    confirmUpload: async (question) => {
      remote.questions.push(question);
      return options.answer ? options.answer(question) : undefined;
    },
    notify: (tone, text) => {
      remote.notes.push({ tone, text });
    },
    plainClick: () => options.plainClick ?? false,
  };
  return remote;
}

export async function flush(): Promise<void> {
  for (let count = 0; count < 10; count += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sftpError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function treeList(tree: Record<string, BrowseEntry[] | 'denied'>, dir: string): BrowseEntry[] {
  const found = tree[dir];
  if (found === 'denied') throw sftpError(3, 'Permission denied');
  if (!found) throw sftpError(2, 'No such file');
  return found;
}

function treeResolve(tree: Record<string, BrowseEntry[] | 'denied'>, path: string): { path: string; kind: 'dir' | 'file' | 'other' } {
  if (tree[path] !== undefined) return { path, kind: 'dir' };
  const parent = tree[remoteDirname(path)];
  if (parent === 'denied') throw sftpError(3, 'Permission denied');
  const entry = parent?.find((item) => item.name === remoteBasename(path));
  if (!entry) throw sftpError(2, 'No such file');
  return { path, kind: entry.kind === 'dir' ? 'dir' : entry.kind === 'file' ? 'file' : 'other' };
}

/** Entries for a fake folder: names ending in / are folders. */
export function entriesOf(dir: string, names: string[]): BrowseEntry[] {
  return names.map((name) => {
    const folder = name.endsWith('/');
    const bare = folder ? name.slice(0, -1) : name;
    return { name: bare, path: remoteJoin(dir, bare), kind: folder ? 'dir' : 'file', size: 1, mtime: 0 };
  });
}
