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
import type { UploadQuestion } from './cwdTracking';

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
  openShell(columns: number, rows: number, onData: (chunk: string) => void, onClose: () => void): Promise<void>;
  writeShell(data: string): void;
  resizeShell(columns: number, rows: number): void;
  hasShell(): boolean;
  close(): void;
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
}
