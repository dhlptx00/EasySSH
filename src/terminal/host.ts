import type { BrowseEntry, ConnectionRecord, SecretUpdate, TransferState } from '../types';

export interface FileSession {
  list(dir: string): Promise<BrowseEntry[]>;
  resolve(input: string, cwd: string): Promise<{ path: string; kind: 'dir' | 'file' | 'other' }>;
  download(
    remotePath: string,
    localPath: string,
    onProgress: (done: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  upload(
    localPaths: string[],
    remoteDir: string,
    onProgress: (state: TransferState) => void,
    signal: AbortSignal,
  ): Promise<{ uploaded: number; skipped: number }>;
  run(cwd: string, command: string, signal: AbortSignal, columns?: number): Promise<{ code: number; output: string }>;
  openShell(columns: number, rows: number, onData: (chunk: string) => void, onClose: () => void): Promise<void>;
  writeShell(data: string): void;
  resizeShell(columns: number, rows: number): void;
  hasShell(): boolean;
  close(): void;
}

export interface ConnectResult {
  session: FileSession;
  cwd: string;
  trustedNewKey: boolean;
  usedFallbackPath: boolean;
}

export interface ImportReport {
  ok: boolean;
  message: string;
}

export interface AppHost {
  listConnections(): Promise<ConnectionRecord[]>;
  saveConnection(record: ConnectionRecord, secret: SecretUpdate): Promise<void>;
  deleteConnection(id: string): Promise<void>;
  secretFlags(id: string): Promise<{ password: boolean; passphrase: boolean }>;
  importConfig(): Promise<ImportReport>;
  connect(record: ConnectionRecord, options: { acceptChangedKey: boolean; signal: AbortSignal }): Promise<ConnectResult>;
  downloadFolder(): string;
  home(): string;
  clickHint(): string;
  chooseDownloadFolder(): Promise<string | undefined>;
  chooseUploadFiles(): Promise<string[]>;
  classifyDrop(text: string): string[] | null;
  localDownloadPath(name: string): string;
  keyExists(path: string): boolean;
  setStatus(text: string | undefined): void;
  log(line: string): void;
  /** Scroll the terminal view when a click-to-download session receives the wheel. */
  scrollTerminal(direction: 'up' | 'down'): void;
  quit(): void;
}
