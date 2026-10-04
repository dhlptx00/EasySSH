import * as vscode from 'vscode';
import { RemoteFileError, RemoteFiles } from './remoteFiles';

/** URI scheme of remote files opened from the action menu: easyssh://<terminal>/<absolute path>. */
export const EASYSSH_SCHEME = 'easyssh';

function asFsError(err: unknown): Error {
  if (!(err instanceof RemoteFileError)) return err instanceof Error ? err : new Error(String(err));
  switch (err.kind) {
    case 'notFound':
      return vscode.FileSystemError.FileNotFound(err.message);
    case 'noPermission':
      return vscode.FileSystemError.NoPermissions(err.message);
    case 'unavailable':
      return vscode.FileSystemError.Unavailable(err.message);
    case 'exists':
      return vscode.FileSystemError.FileExists(err.message);
    case 'isDirectory':
      return vscode.FileSystemError.FileIsADirectory(err.message);
    case 'notDirectory':
      return vscode.FileSystemError.FileNotADirectory(err.message);
    default:
      return new vscode.FileSystemError(err.message);
  }
}

function fileType(kind: string): vscode.FileType {
  if (kind === 'dir') return vscode.FileType.Directory;
  if (kind === 'file') return vscode.FileType.File;
  if (kind === 'link') return vscode.FileType.SymbolicLink;
  return vscode.FileType.Unknown;
}

/** Remote files in editor tabs, read and saved over the Easy SSH terminal's SFTP session. */
export class EasySshFileSystem implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;

  constructor(private readonly files: RemoteFiles) {}

  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      throw asFsError(err);
    }
  }

  watch(): vscode.Disposable {
    // No server-side notifications over SFTP. A save checks for changes instead.
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.run(async () => {
      const found = await this.files.stat(uri.authority, uri.path);
      return { type: fileType(found.kind), ctime: found.mtime, mtime: found.mtime, size: found.size };
    });
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.run(async () => (await this.files.list(uri.authority, uri.path)).map(([name, kind]) => [name, fileType(kind)] as [string, vscode.FileType]));
  }

  createDirectory(uri: vscode.Uri): Promise<void> {
    return this.run(() => this.files.makeDir(uri.authority, uri.path));
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.run(() => this.files.read(uri.authority, uri.path));
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean }): Promise<void> {
    return this.run(async () => {
      await this.files.write(uri.authority, uri.path, content, options);
    });
  }

  delete(uri: vscode.Uri): Promise<void> {
    return this.run(async () => {
      await this.files.remove(uri.authority, uri.path);
      this.changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    });
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    return this.run(async () => {
      if (oldUri.authority !== newUri.authority) throw new RemoteFileError('other', 'Easy SSH cannot move a file between two connections.');
      await this.files.rename(oldUri.authority, oldUri.path, newUri.path);
      this.changes.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
    });
  }
}
