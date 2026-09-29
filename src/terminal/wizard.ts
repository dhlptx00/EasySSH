import { formatJumps, parseJumpList } from '../ssh/jump';
import { expandHome } from '../text';
import type { AuthMethod, ConnectionRecord, JumpSpec, SecretUpdate } from '../types';

export type Step =
  | 'name'
  | 'host'
  | 'port'
  | 'username'
  | 'auth'
  | 'password'
  | 'keyPath'
  | 'passphrase'
  | 'startPath'
  | 'jump';

export interface Draft {
  name: string;
  host: string;
  port: string;
  username: string;
  auth: AuthMethod | '';
  password: string;
  keepPassword: boolean;
  keyPath: string;
  passphrase: string;
  keepPassphrase: boolean;
  startPath: string;
  jump: string;
  hasSavedPassword: boolean;
  hasSavedPassphrase: boolean;
  originalJump: string;
  originalJumps: JumpSpec[];
  originalKeyPath: string;
}

export interface Prompt {
  label: string;
  hint: string;
  masked: boolean;
  fallback: string;
}

export function emptyDraft(): Draft {
  return {
    name: '',
    host: '',
    port: '22',
    username: '',
    auth: '',
    password: '',
    keepPassword: false,
    keyPath: '',
    passphrase: '',
    keepPassphrase: false,
    startPath: '',
    jump: '',
    hasSavedPassword: false,
    hasSavedPassphrase: false,
    originalJump: '',
    originalJumps: [],
    originalKeyPath: '',
  };
}

export function draftFromRecord(
  record: ConnectionRecord,
  saved: { password: boolean; passphrase: boolean },
): Draft {
  const jump = formatJumps(record.jumps);
  return {
    ...emptyDraft(),
    name: record.name,
    host: record.host,
    port: String(record.port),
    username: record.username,
    auth: record.auth,
    keyPath: record.privateKeyPath ?? '',
    startPath: record.startPath ?? '',
    jump,
    hasSavedPassword: saved.password,
    hasSavedPassphrase: saved.passphrase,
    keepPassword: saved.password,
    keepPassphrase: saved.passphrase,
    originalJump: jump,
    originalJumps: record.jumps.map((item) => ({ ...item })),
    originalKeyPath: record.privateKeyPath ?? '',
  };
}

export function nextStep(step: Step, draft: Draft): Step | 'done' {
  switch (step) {
    case 'name':
      return 'host';
    case 'host':
      return 'port';
    case 'port':
      return 'username';
    case 'username':
      return 'auth';
    case 'auth':
      if (draft.auth === 'password') return 'password';
      if (draft.auth === 'privateKey') return 'keyPath';
      return 'startPath';
    case 'password':
      return 'startPath';
    case 'keyPath':
      return 'passphrase';
    case 'passphrase':
      return 'startPath';
    case 'startPath':
      return 'jump';
    case 'jump':
      return 'done';
    default: {
      const unreachable: never = step;
      return unreachable;
    }
  }
}

export function prevStep(step: Step, draft: Draft): Step | 'start' {
  switch (step) {
    case 'name':
      return 'start';
    case 'host':
      return 'name';
    case 'port':
      return 'host';
    case 'username':
      return 'port';
    case 'auth':
      return 'username';
    case 'password':
      return 'auth';
    case 'keyPath':
      return 'auth';
    case 'passphrase':
      return 'keyPath';
    case 'startPath':
      if (draft.auth === 'password') return 'password';
      if (draft.auth === 'privateKey') return 'passphrase';
      return 'auth';
    case 'jump':
      return 'startPath';
    default: {
      const unreachable: never = step;
      return unreachable;
    }
  }
}

export function stepsBefore(step: Step, draft: Draft): Step[] {
  const done: Step[] = [];
  let cursor: Step = 'name';
  while (cursor !== step) {
    done.push(cursor);
    const following = nextStep(cursor, draft);
    if (following === 'done') break;
    cursor = following;
  }
  return done;
}

function authWord(auth: AuthMethod | ''): string {
  if (auth === 'privateKey') return 'key';
  return auth;
}

export function promptFor(step: Step, draft: Draft): Prompt {
  switch (step) {
    case 'name':
      return { label: 'name', hint: 'A short name for this connection', masked: false, fallback: draft.name };
    case 'host':
      return { label: 'host', hint: 'Hostname or IP address', masked: false, fallback: draft.host };
    case 'port':
      return { label: 'port', hint: 'Press enter for the value in brackets', masked: false, fallback: draft.port || '22' };
    case 'username':
      return { label: 'username', hint: 'Login user on the server', masked: false, fallback: draft.username };
    case 'auth':
      return {
        label: 'auth',
        hint: 'password, key, or agent',
        masked: false,
        fallback: authWord(draft.auth),
      };
    case 'password':
      return {
        label: 'password',
        hint: draft.hasSavedPassword ? 'Press enter to keep the saved password' : 'Stored in the editor secret storage',
        masked: true,
        fallback: '',
      };
    case 'keyPath':
      return { label: 'private key', hint: 'Path to the private key file', masked: false, fallback: draft.keyPath };
    case 'passphrase':
      return {
        label: 'passphrase',
        hint: draft.hasSavedPassphrase
          ? 'Press enter to keep the saved passphrase, or leave empty if the key has none'
          : 'Leave empty if the key has no passphrase',
        masked: true,
        fallback: '',
      };
    case 'startPath':
      return {
        label: 'remote path',
        hint: 'Absolute path, or type home. Empty uses the value in brackets or your home directory',
        masked: false,
        fallback: draft.startPath,
      };
    case 'jump':
      return {
        label: 'jump host',
        hint: 'Optional. user@host:port, comma separated, same login. Type none to clear',
        masked: false,
        fallback: draft.jump,
      };
    default: {
      const unreachable: never = step;
      return unreachable;
    }
  }
}

export function stepValue(step: Step, draft: Draft): string {
  switch (step) {
    case 'name':
      return draft.name;
    case 'host':
      return draft.host;
    case 'port':
      return draft.port;
    case 'username':
      return draft.username;
    case 'auth':
      return authWord(draft.auth) || '(unset)';
    case 'password':
      return draft.password ? '••••' : draft.keepPassword ? '(saved)' : '(empty)';
    case 'keyPath':
      return draft.keyPath;
    case 'passphrase':
      if (draft.passphrase) return '••••';
      return draft.keepPassphrase ? '(saved)' : '(none)';
    case 'startPath':
      return draft.startPath || '(home)';
    case 'jump':
      return draft.jump || '(none)';
    default: {
      const unreachable: never = step;
      return unreachable;
    }
  }
}

function parseAuth(input: string): AuthMethod | undefined {
  const value = input.trim().toLowerCase();
  if (['1', 'p', 'password', 'pass'].includes(value)) return 'password';
  if (['2', 'k', 'key', 'privatekey', 'private key', 'private-key'].includes(value)) return 'privateKey';
  if (['3', 'a', 'agent', 'ssh-agent'].includes(value)) return 'agent';
  return undefined;
}

export interface ApplyContext {
  takenNames: string[];
  keyExists(path: string): boolean;
  home: string;
}

export function applyStep(step: Step, typed: string, draft: Draft, ctx: ApplyContext): { draft: Draft; error?: string } {
  const next: Draft = { ...draft, originalJumps: draft.originalJumps.map((item) => ({ ...item })) };
  const fallback = promptFor(step, draft).fallback;
  const value = typed.length > 0 ? typed : fallback;

  if (step === 'name') {
    const name = value.trim();
    if (!name) return { draft, error: 'Name is required' };
    if (name.length > 48) return { draft, error: 'Name must be 48 characters or fewer' };
    if (ctx.takenNames.some((item) => item.toLowerCase() === name.toLowerCase())) {
      return { draft, error: 'A connection with that name already exists' };
    }
    next.name = name;
    return { draft: next };
  }

  if (step === 'host') {
    const host = value.trim();
    if (!host || /\s/.test(host)) return { draft, error: 'Enter a hostname or IP address' };
    next.host = host;
    return { draft: next };
  }

  if (step === 'port') {
    const port = Number(value.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { draft, error: 'Port must be between 1 and 65535' };
    }
    next.port = String(port);
    return { draft: next };
  }

  if (step === 'username') {
    const username = value.trim();
    if (!username || /\s/.test(username)) return { draft, error: 'Username is required' };
    next.username = username;
    return { draft: next };
  }

  if (step === 'auth') {
    const auth = parseAuth(value);
    if (!auth) return { draft, error: 'Enter password, key, or agent' };
    next.auth = auth;
    return { draft: next };
  }

  if (step === 'password') {
    next.password = typed;
    next.keepPassword = typed.length === 0 && draft.hasSavedPassword;
    return { draft: next };
  }

  if (step === 'keyPath') {
    const keyPath = expandHome(value.trim(), ctx.home);
    if (!keyPath) return { draft, error: 'Private key path is required' };
    if (!ctx.keyExists(keyPath)) return { draft, error: `Key file not found: ${keyPath}` };
    if (keyPath !== draft.keyPath) next.keepPassphrase = false;
    next.keyPath = keyPath;
    return { draft: next };
  }

  if (step === 'passphrase') {
    next.passphrase = typed;
    next.keepPassphrase = typed.length === 0 && draft.hasSavedPassphrase && next.keyPath === draft.originalKeyPath;
    return { draft: next };
  }

  if (step === 'startPath') {
    let startPath = value.trim();
    if (startPath === 'home' || startPath === '~') startPath = '';
    if (startPath && !startPath.startsWith('/') && !startPath.startsWith('~')) {
      return { draft, error: 'Use an absolute path, or type home' };
    }
    next.startPath = startPath;
    return { draft: next };
  }

  const jumpText = typed.trim();
  if (jumpText === 'none' || jumpText === '-') {
    next.jump = '';
    return { draft: next };
  }
  const jump = jumpText || draft.jump;
  if (jump) {
    try {
      parseJumpList(jump);
    } catch (err) {
      return { draft, error: err instanceof Error ? err.message : 'Jump host is invalid' };
    }
  }
  next.jump = jump;
  return { draft: next };
}

export function toConnection(draft: Draft, id: string): { record: ConnectionRecord; secret: SecretUpdate } {
  if (!draft.auth) throw new Error('Authentication method is missing');
  let jumps: JumpSpec[];
  if (draft.jump.trim() === draft.originalJump.trim()) {
    jumps = draft.originalJumps.map((item) => ({ ...item }));
  } else if (!draft.jump.trim()) {
    jumps = [];
  } else {
    jumps = parseJumpList(draft.jump).map((item) => ({
      host: item.host,
      port: item.port ?? 22,
      username: item.username || draft.username,
      auth: draft.auth as AuthMethod,
      privateKeyPath: draft.auth === 'privateKey' ? draft.keyPath : undefined,
    }));
  }

  const record: ConnectionRecord = {
    id,
    name: draft.name,
    host: draft.host,
    port: Number(draft.port),
    username: draft.username,
    auth: draft.auth,
    privateKeyPath: draft.auth === 'privateKey' ? draft.keyPath : undefined,
    startPath: draft.startPath || undefined,
    jumps,
  };

  let secret: SecretUpdate;
  if (draft.auth === 'agent') secret = { action: 'clear' };
  else if (draft.auth === 'password') {
    secret = draft.keepPassword && !draft.password ? { action: 'keep' } : { action: 'set', password: draft.password };
  } else if (draft.keepPassphrase && !draft.passphrase) secret = { action: 'keep' };
  else secret = { action: 'set', passphrase: draft.passphrase || undefined };

  return { record, secret };
}
