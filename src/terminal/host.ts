import type { ConnectUi } from '../ssh/session';
import type { ShellKind } from '../ssh/shellFeed';
import type {
  BrowseEntry,
  ConflictChoice,
  ConnectionRecord,
  DownloadResult,
  FolderDownloadResult,
  SecretUpdate,
  TransferOptions,
  UploadOptions,
  UploadResult,
} from '../types';
import type { ActionMenu, FileAction, TreeCount } from './actions';
import type { UploadQuestion } from './cwdTracking';
import type { ColorDepth, ThemeChoice, ThemeKind } from './theme';

export interface FileSession {
  list(dir: string): Promise<BrowseEntry[]>;
  resolve(input: string, cwd: string): Promise<{ path: string; kind: 'dir' | 'file' | 'other' }>;
  /** False when the server has no SFTP (terminal only). */
  hasFiles?(): boolean;
  download(remotePath: string, folder: string, name: string, options: TransferOptions): Promise<DownloadResult>;
  downloadFolder(
    remotePath: string,
    folder: string,
    name: string,
    options: TransferOptions & { maxFiles: number },
  ): Promise<FolderDownloadResult>;
  upload(localPaths: string[], remoteDir: string, options: UploadOptions): Promise<UploadResult>;
  // The file actions below are optional: sessions without them get no action menu.
  /** Download one file to exactly localPath (a path the user chose), replacing what is there. */
  downloadTo?(remotePath: string, localPath: string, options: TransferOptions): Promise<DownloadResult>;
  /** What a path is, following symlinks. */
  stat?(remotePath: string): Promise<RemoteStat>;
  /** True when something (even a broken symlink) has this path. */
  exists?(remotePath: string): Promise<boolean>;
  /** Rename or move on the server. Fails when the target exists. */
  rename?(from: string, to: string): Promise<void>;
  /** Delete a file, a symlink, or a folder with everything in it. */
  remove?(remotePath: string, options: RemoveOptions): Promise<{ files: number; folders: number }>;
  /** Count what a folder holds, stopping at cap files or after timeoutMs. */
  countTree?(remotePath: string, options: { cap: number; timeoutMs: number }): Promise<TreeCount>;
  /** Up to `bytes` bytes from the start of a file (to tell text from binary). */
  readHead?(remotePath: string, bytes: number): Promise<Buffer>;
  /** A whole file in memory, for an editor tab. */
  readWhole?(remotePath: string, options: { maxBytes: number }): Promise<{ data: Buffer; stat: RemoteStat }>;
  /** Save an editor's bytes, keeping the file's mode, owner and symlinks. */
  writeWhole?(remotePath: string, data: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<RemoteStat>;
  /** Create one folder. */
  makeDir?(remotePath: string): Promise<void>;
  openShell(columns: number, rows: number, onData: (chunk: string) => void, onClose: () => void): Promise<void>;
  writeShell(data: string): void;
  resizeShell(columns: number, rows: number): void;
  hasShell(): boolean;
  close(): void;
}

export interface RemoteStat {
  kind: 'dir' | 'file' | 'other';
  size: number;
  /** Milliseconds since the epoch. Zero when unknown. */
  mtime: number;
}

export interface RemoveOptions {
  signal: AbortSignal;
  /** Items deleted so far. */
  onProgress?(done: number): void;
}

/** The rename box: the old name and a check of each typed name. */
export interface RenameRequest {
  name: string;
  kind: 'file' | 'folder';
  /** The folder it is in. */
  parent: string;
  /** The part of the name selected at first: the name without its extension. */
  selection: [number, number];
  /** An error to show for the typed name, or undefined when it can be used. */
  validate(value: string): Promise<string | undefined>;
}

export interface ConnectResult {
  session: FileSession;
  cwd: string;
  usedFallbackPath: boolean;
  /** Lines shown above the shell (a trusted host key, terminal-only mode). */
  notes?: string[];
  /** The login shell family, from a probe. Undefined means unknown. */
  shell?: ShellKind;
}

export interface ImportReport {
  ok: boolean;
  message: string;
}

/** A progress notification with a Cancel button. */
export interface ProgressHandle {
  report(text: string, fraction: number | undefined): void;
  close(): void;
}

export interface TransferSettings {
  /** SFTP requests in flight per file. */
  concurrency: number;
  /** Most files per upload drop or folder download. */
  maxFiles: number;
}

export interface AppHost {
  listConnections(): Promise<ConnectionRecord[]>;
  saveConnection(record: ConnectionRecord, secret: SecretUpdate): Promise<void>;
  deleteConnection(id: string): Promise<void>;
  secretFlags(id: string): Promise<{ password: boolean; passphrase: boolean }>;
  importConfig(): Promise<ImportReport>;
  /** Open a session. Prompts (passwords, host keys) go through ui. */
  connect(record: ConnectionRecord, options: { signal: AbortSignal; ui: ConnectUi }): Promise<ConnectResult>;
  downloadFolder(): string;
  home(): string;
  chooseDownloadFolder(): Promise<string | undefined>;
  classifyDrop(text: string): string[] | null;
  keyExists(path: string): boolean;
  setStatus(text: string | undefined): void;
  log(line: string): void;
  /** Scroll the terminal view when a click-to-download session receives the wheel. */
  scrollTerminal(direction: 'up' | 'down'): void;
  quit(): void;
  /**
   * Ask where a drop should go when the shell's folder is not known.
   * Resolves to an absolute remote folder, or undefined to cancel.
   */
  confirmUpload?(question: UploadQuestion): Promise<string | undefined>;
  /** Show a notification that stays until dismissed (transfer results the status bar would hide). */
  notify?(tone: 'info' | 'error', text: string): void;
  /**
   * True to open names with a plain click. That turns on terminal mouse reporting,
   * so selecting text then needs Shift (Option on macOS). Default false: names open
   * through the terminal link provider (Ctrl/Cmd+click) and selection works normally.
   */
  plainClick?(): boolean;
  /** How a name is opened, for hints, e.g. "Ctrl+click". */
  clickLabel?(): string;
  /** Where downloads go, for tooltips, e.g. "~/Downloads". */
  downloadLabel?(): string;
  transferSettings?(): TransferSettings;
  /** A cancellable progress notification for big transfers. */
  showProgress?(title: string, cancel: () => void): ProgressHandle;
  /** Some dropped items already exist on the server. */
  resolveConflict?(existing: string[], remoteDir: string): Promise<ConflictChoice>;
  /** The clipboard text. A paste equals it; a drag-and-drop does not (B1). */
  clipboardText?(): Promise<string>;
  /** A dropped path outside the local home folder: upload it, or type it as text? */
  confirmLocalUpload?(paths: string[]): Promise<'upload' | 'paste'>;
  /** Rename the terminal tab, e.g. to the connection name. Undefined restores the default. */
  setTitle?(title: string | undefined): void;
  /** Reconnect by itself after a drop (setting easySsh.autoReconnect). */
  autoReconnect?(): boolean;
  /** Tells the host a transfer runs, so the status bar item can cancel it. */
  transferActive?(active: boolean): void;
  /**
   * The action menu Ctrl/Cmd+click on a name opens (a quick pick). update, when given,
   * resolves to a better placeholder, e.g. once a folder's items are counted.
   * Without it a click downloads directly.
   */
  showActionMenu?(menu: ActionMenu, update?: Promise<string | undefined>): Promise<FileAction | undefined>;
  /** A save dialog for a downloaded file, starting at folder/name. Undefined when cancelled. */
  pickSaveFile?(folder: string, name: string): Promise<string | undefined>;
  /** A folder picker for where a downloaded folder goes, starting at folder. */
  pickDownloadParent?(folder: string, name: string): Promise<string | undefined>;
  /** A file picker for an upload into remoteDir on the server. */
  pickUploadFiles?(remoteDir: string): Promise<string[] | undefined>;
  /** Ask for a new name. Undefined when cancelled. */
  askRename?(request: RenameRequest): Promise<string | undefined>;
  /** A modal question with one action button (and Cancel). True when the button was chosen. */
  confirm?(message: string, detail: string, action: string): Promise<boolean>;
  /** Open a remote file of this terminal's connection in an editor tab. */
  openRemoteFile?(remotePath: string): Promise<void>;
  /** A modal question with several answers. Undefined when cancelled. */
  choose?(message: string, detail: string, answers: string[]): Promise<string | undefined>;
  /** When each connection last connected, in milliseconds since the epoch, by id. */
  lastUsed?(): Record<string, number>;
  /** Remember a successful connect for the Recent line and the Last used column. */
  markUsed?(id: string): Promise<void>;
  /** The Easy SSH palette: the user's choice, VS Code's theme kind, and the color depth. */
  theme?(): { choice: ThemeChoice; editorKind: ThemeKind; depth: ColorDepth; session?: boolean };
  /** Store a /theme choice (globalState and the easySsh.theme setting). */
  setTheme?(choice: ThemeChoice): Promise<void>;
  /**
   * Try a connection without saving it: connect, sign in, close. A "keep" secret
   * uses what is stored for the record's id.
   */
  testConnection?(record: ConnectionRecord, secret: SecretUpdate, options: { signal: AbortSignal; ui: ConnectUi }): Promise<{ detail?: string }>;
}
