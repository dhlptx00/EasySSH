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

export interface TransferState {
  direction: 'download' | 'upload';
  label: string;
  done: number;
  total: number;
  index: number;
  count: number;
}

export interface Notice {
  tone: 'info' | 'ok' | 'error';
  text: string;
}
