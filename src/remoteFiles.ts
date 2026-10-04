import { humanizeSshError } from './ssh/errors';
import { remoteBasename } from './remotePath';
import type { RemoteStat, RemoveOptions } from './terminal/host';
import { formatSize } from './text';

/**
 * Remote files opened in VS Code editor tabs (URIs easyssh://<terminal>/<path>),
 * read and saved through the SFTP session of the Easy SSH terminal they came
 * from. Has no vscode dependency; remoteFsProvider.ts adapts it.
 */

/** Largest file an editor tab loads. The action menu asks before opening text over 5 MB. */
export const EDITOR_MAX_BYTES = 256 * 1024 * 1024;

/** The SFTP calls an editor tab needs. */
export interface EditorSession {
  stat(remotePath: string): Promise<RemoteStat>;
  readWhole(remotePath: string, options: { maxBytes: number }): Promise<{ data: Buffer; stat: RemoteStat }>;
  writeWhole(remotePath: string, data: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<RemoteStat>;
  list(dir: string): Promise<{ name: string; kind: 'file' | 'dir' | 'link' | 'other' }[]>;
  makeDir(remotePath: string): Promise<void>;
  remove(remotePath: string, options: RemoveOptions): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
}

/** The terminal behind an authority: its connection name, and its session while connected. */
export interface EditorTarget {
  label: string;
  session(): EditorSession | null;
}

export type RemoteFileErrorKind = 'notFound' | 'noPermission' | 'unavailable' | 'exists' | 'isDirectory' | 'notDirectory' | 'other';

export class RemoteFileError extends Error {
  override readonly name = 'RemoteFileError';
  constructor(readonly kind: RemoteFileErrorKind, message: string) {
    super(message);
  }
}

/** What a save asks when the file changed on the server after it was opened. */
export interface OverwriteQuestion {
  label: string;
  path: string;
  opened: { size: number; mtime: number };
  /** Undefined when the file was deleted on the server. */
  now: RemoteStat | undefined;
}

/** The question shown before a save replaces a file that changed on the server. */
export function overwriteText(question: OverwriteQuestion): { message: string; detail: string } {
  const name = remoteBasename(question.path);
  if (!question.now) {
    return {
      message: `"${name}" was deleted on ${question.label} after you opened it. Save it again?`,
      detail: `${question.path}\n\nSaving creates the file again with your version.`,
    };
  }
  const when = (ms: number) => (ms ? new Date(ms).toLocaleString() : 'unknown time');
  return {
    message: `"${name}" changed on ${question.label} after you opened it. Overwrite it with your version?`,
    detail:
      `${question.path}\n\nWhen you opened or last saved it: ${formatSize(question.opened.size)}, modified ${when(question.opened.mtime)}\n` +
      `On the server now: ${formatSize(question.now.size)}, modified ${when(question.now.mtime)}\n\n` +
      'Overwriting replaces the changes made on the server.',
  };
}

function sftpCode(err: unknown): number | string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'number' || typeof code === 'string' ? code : undefined;
}

/** Turn an SFTP or connection error into one an editor understands. */
export function remoteFileError(err: unknown, label: string, path: string): RemoteFileError {
  if (err instanceof RemoteFileError) return err;
  const code = sftpCode(err);
  const name = remoteBasename(path) || path;
  if (code === 2) return new RemoteFileError('notFound', `${name} does not exist on ${label} (${path})`);
  if (code === 3) return new RemoteFileError('noPermission', `Permission denied for ${path} on ${label}`);
  if (code === 11) return new RemoteFileError('exists', `${path} already exists on ${label}`);
  if (code === 'EISDIR') return new RemoteFileError('isDirectory', `${path} is a folder`);
  const text = humanizeSshError(err);
  if (/not connected|no response|closed|ECONNRESET|channel|SFTP is not available/i.test(String((err as Error)?.message ?? err))) {
    return new RemoteFileError('unavailable', `${label} is not reachable: ${text}. Reconnect the Easy SSH terminal, then try again.`);
  }
  return new RemoteFileError('other', `${text} (${path} on ${label})`);
}

interface Stamp {
  size: number;
  mtime: number;
}

export class RemoteFiles {
  /**
   * Per open file: `baseline` is the server's size and time matching the editor's
   * text (last read or save); a save compares the server against it. `reported`
   * is what stat told VS Code, which keeps it as the file's version, so stat keeps
   * reporting it until a save and VS Code never raises a second conflict check.
   */
  private readonly known = new Map<string, { baseline: Stamp; reported: Stamp }>();

  constructor(
    private readonly lookup: (authority: string) => EditorTarget | undefined,
    private readonly askOverwrite: (question: OverwriteQuestion) => Promise<boolean>,
  ) {}

  private connect(authority: string): { label: string; session: EditorSession } {
    const target = this.lookup(authority);
    if (!target) {
      throw new RemoteFileError(
        'unavailable',
        `The Easy SSH terminal this file was opened from (${authority}) is closed. Connect again and open the file from the terminal.`,
      );
    }
    const session = target.session();
    if (!session) {
      throw new RemoteFileError('unavailable', `${target.label} is disconnected. Reconnect the Easy SSH terminal, then try again.`);
    }
    return { label: target.label, session };
  }

  private async run<T>(authority: string, path: string, work: (session: EditorSession, label: string) => Promise<T>): Promise<T> {
    const { label, session } = this.connect(authority);
    try {
      return await work(session, label);
    } catch (err) {
      throw remoteFileError(err, label, path);
    }
  }

  private key(authority: string, path: string): string {
    return `${authority}\n${path}`;
  }

  /**
   * The file's type, size and time. For a file open in an editor this reports
   * what the editor last read or saved, so the save below (not VS Code's own
   * check) decides about changes on the server and can say what changed.
   */
  async stat(authority: string, path: string): Promise<RemoteStat> {
    const found = await this.run(authority, path, (session) => session.stat(path));
    const known = this.known.get(this.key(authority, path));
    return known && found.kind === 'file' ? { ...found, size: known.reported.size, mtime: known.reported.mtime } : found;
  }

  async read(authority: string, path: string): Promise<Uint8Array> {
    const { data, stat } = await this.run(authority, path, (session) => session.readWhole(path, { maxBytes: EDITOR_MAX_BYTES }));
    const key = this.key(authority, path);
    const baseline = { size: stat.size, mtime: stat.mtime };
    this.known.set(key, { baseline, reported: this.known.get(key)?.reported ?? baseline });
    return data;
  }

  /** Save. If the file changed on the server since it was read, ask first. */
  async write(authority: string, path: string, data: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    await this.run(authority, path, async (session, label) => {
      const key = this.key(authority, path);
      const opened = this.known.get(key)?.baseline;
      if (opened) {
        const now = await session.stat(path).catch((err: unknown) => {
          if (sftpCode(err) === 2) return undefined;
          throw err;
        });
        if (!now || now.size !== opened.size || now.mtime !== opened.mtime) {
          const sure = await this.askOverwrite({ label, path, opened, now });
          if (!sure) throw new RemoteFileError('other', `Not saved: ${remoteBasename(path)} changed on ${label}. Your changes are still in the editor.`);
        }
      }
      const saved = await session.writeWhole(path, data, { create: options.create || opened !== undefined, overwrite: options.overwrite });
      const stamp = { size: saved.size, mtime: saved.mtime };
      this.known.set(key, { baseline: stamp, reported: stamp });
    });
  }

  async list(authority: string, path: string): Promise<[string, 'file' | 'dir' | 'link' | 'other'][]> {
    const entries = await this.run(authority, path, (session) => session.list(path));
    return entries.filter((entry) => entry.name !== '.' && entry.name !== '..').map((entry) => [entry.name, entry.kind]);
  }

  async makeDir(authority: string, path: string): Promise<void> {
    await this.run(authority, path, (session) => session.makeDir(path));
  }

  async remove(authority: string, path: string): Promise<void> {
    await this.run(authority, path, (session) => session.remove(path, { signal: new AbortController().signal }));
    this.known.delete(this.key(authority, path));
  }

  async rename(authority: string, from: string, to: string): Promise<void> {
    await this.run(authority, from, (session) => session.rename(from, to));
    const known = this.known.get(this.key(authority, from));
    this.known.delete(this.key(authority, from));
    if (known) this.known.set(this.key(authority, to), known);
  }

  /** The editor closed the file: forget what it read. */
  forget(authority: string, path: string): void {
    this.known.delete(this.key(authority, path));
  }
}
