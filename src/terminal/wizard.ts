import { formatJumps, parseJumpList } from '../ssh/jump';
import { expandHome } from '../text';
import type { AuthMethod, ConnectionRecord, JumpSpec, SecretUpdate } from '../types';
import { isReservedCommand } from './commands';

export type Step =
  | 'name'
  | 'host'
  | 'port'
  | 'username'
  | 'auth'
  | 'passwordMode'
  | 'password'
  | 'keyPath'
  | 'passphrase'
  | 'startPathChoice'
  | 'startPath'
  | 'jumpChoice'
  | 'jump';

export interface Draft {
  name: string;
  host: string;
  port: string;
  username: string;
  auth: AuthMethod | '';
  /** save stores the password; ask asks for it at every connect. */
  passwordMode: '' | 'save' | 'ask';
  password: string;
  keepPassword: boolean;
  keyPath: string;
  passphrase: string;
  keepPassphrase: boolean;
  startPath: string;
  /** home opens the remote home directory. custom asks for a path. */
  startMode: '' | 'home' | 'custom';
  jump: string;
  /** none connects directly. custom asks for user@host:port. */
  jumpMode: '' | 'none' | 'custom';
  hasSavedPassword: boolean;
  hasSavedPassphrase: boolean;
  originalJump: string;
  originalJumps: JumpSpec[];
  originalKeyPath: string;
  originalAuth: AuthMethod | '';
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
    passwordMode: '',
    password: '',
    keepPassword: false,
    keyPath: '',
    passphrase: '',
    keepPassphrase: false,
    startPath: '',
    startMode: '',
    jump: '',
    jumpMode: '',
    hasSavedPassword: false,
    hasSavedPassphrase: false,
    originalJump: '',
    originalJumps: [],
    originalKeyPath: '',
    originalAuth: '',
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
    passwordMode: record.auth === 'password' ? (record.askPassword ? 'ask' : 'save') : '',
    keyPath: record.privateKeyPath ?? '',
    startPath: record.startPath ?? '',
    startMode: record.startPath ? 'custom' : 'home',
    jump,
    jumpMode: record.jumps.length ? 'custom' : 'none',
    hasSavedPassword: saved.password,
    hasSavedPassphrase: saved.passphrase,
    keepPassword: saved.password,
    keepPassphrase: saved.passphrase,
    originalJump: jump,
    originalJumps: record.jumps.map((item) => ({ ...item })),
    originalKeyPath: record.privateKeyPath ?? '',
    originalAuth: record.auth,
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
      if (draft.auth === 'password') return 'passwordMode';
      if (draft.auth === 'privateKey') return 'keyPath';
      return 'jumpChoice';
    case 'passwordMode':
      return draft.passwordMode === 'ask' ? 'jumpChoice' : 'password';
    case 'password':
      return 'jumpChoice';
    case 'keyPath':
      return 'passphrase';
    case 'passphrase':
      return 'jumpChoice';
    case 'startPathChoice':
      return draft.startMode === 'custom' ? 'startPath' : 'jumpChoice';
    case 'startPath':
      return 'jumpChoice';
    case 'jumpChoice':
      return draft.jumpMode === 'custom' ? 'jump' : 'done';
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
    case 'passwordMode':
      return 'auth';
    case 'password':
      return 'passwordMode';
    case 'keyPath':
      return 'auth';
    case 'passphrase':
      return 'keyPath';
    case 'startPathChoice':
      if (draft.auth === 'password') return draft.passwordMode === 'ask' ? 'passwordMode' : 'password';
      if (draft.auth === 'privateKey') return 'passphrase';
      return 'auth';
    case 'startPath':
      return 'startPathChoice';
    case 'jumpChoice':
      if (draft.auth === 'password') return draft.passwordMode === 'ask' ? 'passwordMode' : 'password';
      if (draft.auth === 'privateKey') return 'passphrase';
      return 'auth';
    case 'jump':
      return 'jumpChoice';
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
        hint: 'Choose how to sign in',
        masked: false,
        fallback: authWord(draft.auth),
      };
    case 'passwordMode':
      return { label: 'password', hint: 'Save the password, or type it at every connect', masked: false, fallback: '' };
    case 'password':
      return {
        label: 'password',
        hint: draft.hasSavedPassword
          ? 'Press enter to keep the saved password'
          : 'Stored in the editor secret storage. Leave empty to be asked when you connect',
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
    case 'startPathChoice':
      return { label: 'remote path', hint: 'Choose where the session opens', masked: false, fallback: '' };
    case 'startPath':
      return {
        label: 'remote path',
        hint: 'Absolute path on the server, such as /var/www',
        masked: false,
        fallback: draft.startPath,
      };
    case 'jumpChoice':
      return { label: 'jump host', hint: 'Choose a direct connection or a jump host', masked: false, fallback: '' };
    case 'jump':
      return {
        label: 'jump host',
        hint: 'user@host:port, comma separated. Each hop signs in like the server; you are asked when one needs another password',
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
    case 'passwordMode':
      return draft.passwordMode === 'ask' ? 'Ask each time' : 'Save';
    case 'password':
      return draft.password ? '••••' : draft.keepPassword ? '(saved)' : '(empty)';
    case 'keyPath':
      return draft.keyPath;
    case 'passphrase':
      if (draft.passphrase) return '••••';
      return draft.keepPassphrase ? '(saved)' : '(none)';
    case 'startPathChoice':
      return draft.startMode === 'custom' ? 'Custom path' : 'Home directory';
    case 'startPath':
      return draft.startPath || '(home)';
    case 'jumpChoice':
      return draft.jumpMode === 'custom' ? 'Jump host' : 'No jump host';
    case 'jump':
      return draft.jump || '(none)';
    default: {
      const unreachable: never = step;
      return unreachable;
    }
  }
}

export interface ChoiceOption {
  id: string;
  label: string;
  hint: string;
}

/** Steps answered with Up, Down, and Enter. Everything else is typed. */
export function choiceOptions(step: Step): ChoiceOption[] | null {
  if (step === 'auth') {
    return [
      { id: 'password', label: 'Password', hint: 'Stored in the editor secret storage' },
      { id: 'privateKey', label: 'Private key', hint: 'Sign in with a key file' },
      { id: 'agent', label: 'SSH agent', hint: 'Use a key already loaded in your agent' },
    ];
  }
  if (step === 'passwordMode') {
    return [
      { id: 'save', label: 'Save the password', hint: 'Stored in the editor secret storage (OS keychain)' },
      { id: 'ask', label: 'Ask each time', hint: 'Nothing is stored; type it when you connect' },
    ];
  }
  if (step === 'startPathChoice') {
    return [
      { id: 'home', label: 'Home directory', hint: 'Open your home directory on the server' },
      { id: 'custom', label: 'Custom path', hint: 'Type an absolute remote path' },
    ];
  }
  if (step === 'jumpChoice') {
    return [
      { id: 'none', label: 'No jump host', hint: 'Connect directly' },
      { id: 'custom', label: 'Use a jump host', hint: 'Hop through user@host:port' },
    ];
  }
  return null;
}

export function choiceIndex(step: Step, draft: Draft): number {
  const options = choiceOptions(step);
  if (!options) return 0;
  const id = step === 'auth'
    ? draft.auth
    : step === 'passwordMode'
      ? draft.passwordMode || 'save'
      : step === 'startPathChoice'
        ? draft.startMode
        : draft.jumpMode;
  const index = options.findIndex((option) => option.id === id);
  return index >= 0 ? index : 0;
}

export function applyChoice(step: Step, optionId: string, draft: Draft): { draft: Draft; error?: string } {
  const options = choiceOptions(step);
  if (!options) return { draft, error: 'This step needs typed text' };
  const resolved = step === 'auth' ? parseAuth(optionId) : undefined;
  const option = options.find((item) => item.id === (resolved ?? optionId) || item.label.toLowerCase() === optionId.trim().toLowerCase());
  if (!option) return { draft, error: 'Choose one of the options' };
  const next: Draft = { ...draft, originalJumps: draft.originalJumps.map((item) => ({ ...item })) };
  if (step === 'auth') {
    next.auth = option.id as AuthMethod;
    return { draft: next };
  }
  if (step === 'passwordMode') {
    next.passwordMode = option.id === 'ask' ? 'ask' : 'save';
    return { draft: next };
  }
  if (step === 'startPathChoice') {
    next.startMode = option.id === 'custom' ? 'custom' : 'home';
    if (next.startMode === 'home') next.startPath = '';
    return { draft: next };
  }
  next.jumpMode = option.id === 'custom' ? 'custom' : 'none';
  if (next.jumpMode === 'none') next.jump = '';
  return { draft: next };
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
  if (choiceOptions(step)) return applyChoice(step, typed, draft);
  const next: Draft = { ...draft, originalJumps: draft.originalJumps.map((item) => ({ ...item })) };
  const fallback = promptFor(step, draft).fallback;
  const value = typed.length > 0 ? typed : fallback;

  if (step === 'name') {
    const name = value.trim();
    if (!name) return { draft, error: 'Name is required' };
    if (name.length > 48) return { draft, error: 'Name must be 48 characters or fewer' };
    if (isReservedCommand(name)) return { draft, error: 'That name is a system command. Pick another name' };
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

/**
 * Jumps for the saved record. Unedited jumps that signed in like the server
 * follow it when its sign-in method or key changes (B3). A jump with its own
 * key (e.g. from ~/.ssh/config) keeps it.
 */
function jumpsFor(draft: Draft): JumpSpec[] {
  const auth = draft.auth as AuthMethod;
  const keyPath = auth === 'privateKey' ? draft.keyPath : undefined;
  if (draft.jump.trim() === draft.originalJump.trim()) {
    return draft.originalJumps.map((item) => {
      const followed = item.auth === draft.originalAuth && (item.privateKeyPath ?? '') === (draft.originalAuth === 'privateKey' ? draft.originalKeyPath : '');
      if (!followed) return { ...item };
      return { ...item, auth, privateKeyPath: keyPath };
    });
  }
  if (!draft.jump.trim()) return [];
  return parseJumpList(draft.jump).map((item) => ({
    host: item.host,
    port: item.port ?? 22,
    username: item.username || draft.username,
    auth,
    privateKeyPath: keyPath,
  }));
}

export function toConnection(draft: Draft, id: string): { record: ConnectionRecord; secret: SecretUpdate } {
  if (!draft.auth) throw new Error('Authentication method is missing');
  const askPassword = draft.auth === 'password' && draft.passwordMode === 'ask';
  const record: ConnectionRecord = {
    id,
    name: draft.name,
    host: draft.host,
    port: Number(draft.port),
    username: draft.username,
    auth: draft.auth,
    privateKeyPath: draft.auth === 'privateKey' ? draft.keyPath : undefined,
    startPath: draft.startPath || undefined,
    jumps: jumpsFor(draft),
  };
  if (askPassword) record.askPassword = true;

  let secret: SecretUpdate;
  if (draft.auth === 'agent' || askPassword) secret = { action: 'clear' };
  else if (draft.auth === 'password') {
    if (draft.keepPassword && !draft.password) secret = { action: 'keep' };
    // An empty password is not stored: Easy SSH asks for it when connecting.
    else secret = draft.password ? { action: 'set', password: draft.password } : { action: 'clear' };
  } else if (draft.keepPassphrase && !draft.passphrase) secret = { action: 'keep' };
  else secret = { action: 'set', passphrase: draft.passphrase || undefined };

  return { record, secret };
}
