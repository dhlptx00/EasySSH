export type AuthMethod = 'password' | 'privateKey' | 'agent';

export interface JumpSpec {
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  privateKeyPath?: string;
}

export interface ConnectionRecord {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  privateKeyPath?: string;
  /** Empty means the remote home directory. */
  startPath?: string;
  jumps: JumpSpec[];
  /** True to ask for the password at every connect instead of saving it. */
  askPassword?: boolean;
}

export interface SecretPayload {
  password?: string;
  passphrase?: string;
}

export type SecretUpdate =
  | { action: 'keep' }
  | { action: 'clear' }
  | { action: 'set'; password?: string; passphrase?: string };

export interface BrowseEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'link' | 'other';
  size: number;
  /** Milliseconds since the epoch. Zero when unknown. */
  mtime: number;
}


/** Progress of one transfer job (a file, a folder, or a drop of several items). */
export interface TransferProgress {
  /** "scan" while a folder is being listed, "copy" while bytes move. */
  phase: 'scan' | 'copy';
  bytes: number;
  totalBytes: number;
  files: number;
  totalFiles: number;
  /** The file being copied, relative to the job. */
  current?: string;
}

export interface TransferOptions {
  signal: AbortSignal;
  /** SFTP requests kept in flight per file. */
  concurrency: number;
  onProgress(progress: TransferProgress): void;
}

/** What to do when an upload would replace remote files. */
export type ConflictChoice = 'replace' | 'keep' | 'skip' | 'cancel';

export interface UploadOptions extends TransferOptions {
  /** Most files one drop may upload. */
  maxFiles: number;
  /** Asked once when some top-level targets already exist. */
  resolveConflict(existing: string[]): Promise<ConflictChoice>;
}

export interface UploadResult {
  uploaded: number;
  /** Symlinks and special files that were left out. */
  skipped: number;
  /** Top-level items left out because they existed and the user chose Skip. */
  kept: number;
  /** "old -> new" for items uploaded under a numbered name (Keep both). */
  renamed: string[];
}

export interface DownloadResult {
  localPath: string;
  bytes: number;
  /** True when the file grew while it was being read (e.g. a log). */
  grew: boolean;
}

export interface FolderDownloadResult {
  localPath: string;
  files: number;
  folders: number;
  bytes: number;
  /** Relative paths left out: symlinks, special files, unreadable folders. */
  skipped: { path: string; reason: string }[];
}

export interface Notice {
  tone: 'info' | 'ok' | 'error';
  text: string;
}
