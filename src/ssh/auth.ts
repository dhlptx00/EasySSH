import { utils } from 'ssh2';
import type { AuthMethod } from '../types';
import { TransferCancelled } from './errors';

/** One hop of a connection, as the authentication code sees it. */
export interface AuthEndpoint {
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  privateKeyPath?: string;
  /** True for the server itself, false for a jump host. */
  main: boolean;
}

/** A question shown in the terminal while connecting. */
export interface AskRequest {
  title: string;
  label: string;
  masked: boolean;
  hint?: string;
  /** Text from the server (keyboard-interactive name and instructions). */
  detail?: string;
  /** When set, Tab toggles "save" and the answer carries the choice. */
  save?: boolean;
}

export interface AskAnswer {
  value: string;
  save: boolean;
}

export interface AuthContext {
  /**
   * The saved password, tried once before asking. Set for the server and for jump
   * hosts that use password sign-in. Never set when the connection asks each time.
   */
  savedPassword?: string;
  /** The saved passphrase, for the key path it belongs to. */
  savedPassphrase?: { keyPath: string; passphrase: string };
  /** True when the password must not be saved ("Ask each time"). */
  askPassword: boolean;
  /** Agent socket, named pipe, or "pageant"; undefined when none is available. */
  agent?: string;
  /** Default identity files that exist, tried after the agent (like ssh). */
  identityFiles: string[];
  readKey(path: string): Buffer;
  /** Ask in the terminal. Resolves undefined when the user cancels. */
  ask(request: AskRequest): Promise<AskAnswer | undefined>;
  log(line: string): void;
}

type Attempt =
  | { type: 'none'; username: string }
  | { type: 'password'; username: string; password: string }
  | { type: 'publickey'; username: string; key: Buffer; passphrase?: string }
  | { type: 'agent'; username: string; agent: string }
  | {
      type: 'keyboard-interactive';
      username: string;
      prompt: (
        name: string,
        instructions: string,
        lang: string,
        prompts: { prompt: string; echo?: boolean }[],
        finish: (answers: string[]) => void,
      ) => void;
    };

type Step = 'password' | 'key' | 'agent' | 'defaults' | 'keyboard';

/** Thrown when every method failed. The message says what to try next. */
export class AuthFailure extends Error {
  override readonly name = 'AuthFailure';
}

const PASSWORD_TRIES = 3;

/** A keyboard-interactive prompt that asks for the account password (not an OTP or a code). */
export function looksLikePasswordPrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (/(code|otp|token|one[- ]time|verification|passcode|pin\b|duo|factor|yubikey|challenge)/.test(text)) return false;
  return /pass(word|wd)?\b|password|口令|密码|パスワード/.test(text);
}

function keyName(file: string): string {
  return file.split(/[/\\]/).pop() || file;
}

/** True when ssh2 cannot use the key without a passphrase. */
function keyNeedsPassphrase(key: Buffer): boolean {
  const parsed = utils.parseKey(key);
  if (!(parsed instanceof Error)) return false;
  return /encrypted|passphrase/i.test(parsed.message);
}

/** Null when the passphrase opens the key; otherwise why it does not. */
function keyProblem(key: Buffer, passphrase?: string): string | null {
  const parsed = utils.parseKey(key, passphrase);
  if (parsed instanceof Error) return parsed.message;
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || !first.isPrivateKey()) return 'not a private key';
  return null;
}

/**
 * The authentication sequence for one hop, as an ssh2 authHandler:
 * 1. "none", to learn which methods the server allows;
 * 2. the connection's method (password, key, or agent then the default key files);
 * 3. keyboard-interactive for 2FA and PAM prompts, for every method.
 * The saved password is sent only to a single hidden password-like prompt, once.
 * Every other prompt is shown in the terminal.
 */
export class AuthPlanner {
  private steps: Step[];
  private passwordTries = 0;
  private keyboardTries = 0;
  private usedSaved = false;
  private savedForKeyboard = true;
  private lastStep: Step | 'none' | undefined;
  private allowed: string[] | null = null;
  private partial = false;
  private failure: unknown;
  private readonly notes: string[] = [];
  /** A password the user typed for the main hop, and whether to save it. */
  typed?: AskAnswer;

  constructor(
    private readonly endpoint: AuthEndpoint,
    private readonly ctx: AuthContext,
  ) {
    if (endpoint.auth === 'password') this.steps = ['password', 'keyboard'];
    else if (endpoint.auth === 'privateKey') this.steps = ['key', 'keyboard'];
    else this.steps = ['agent', 'defaults', 'keyboard'];
  }

  private get who(): string {
    const host = this.endpoint.host.includes(':') ? `[${this.endpoint.host}]` : this.endpoint.host;
    return `${this.endpoint.username}@${host}${this.endpoint.port === 22 ? '' : `:${this.endpoint.port}`}`;
  }

  /** The function to pass as ssh2's authHandler. */
  readonly handler = (methodsLeft: string[] | null, partialSuccess: boolean | null, next: (attempt: Attempt | false) => void): void => {
    if (methodsLeft) this.allowed = methodsLeft;
    if (partialSuccess) this.partial = true;
    this.nextAttempt(partialSuccess === true).then(
      (attempt) => next(attempt),
      (err: unknown) => {
        this.failure = err;
        next(false);
      },
    );
  };

  /** An error set by a cancelled prompt, if that is why authentication stopped. */
  get stopReason(): unknown {
    return this.failure;
  }

  private permits(method: string): boolean {
    return this.allowed === null || this.allowed.includes(method);
  }

  private async nextAttempt(partial: boolean): Promise<Attempt | false> {
    const { username } = this.endpoint;
    if (this.lastStep === undefined) {
      this.lastStep = 'none';
      return { type: 'none', username };
    }
    // A rejected password is asked again, up to three times.
    if (this.lastStep === 'password' && !partial && this.passwordTries < PASSWORD_TRIES && this.permits('password')) {
      const attempt = await this.passwordAttempt(true);
      if (attempt) return attempt;
    }
    // Another keyboard-interactive round: a retry, or a second factor after a partial success.
    if (this.lastStep === 'keyboard' && this.keyboardTries < PASSWORD_TRIES && this.permits('keyboard-interactive')) {
      return this.keyboardAttempt();
    }
    while (this.steps.length > 0) {
      const step = this.steps.shift() as Step;
      const attempt = await this.attemptFor(step);
      if (attempt) return attempt;
    }
    return false;
  }

  private async attemptFor(step: Step): Promise<Attempt | undefined> {
    const { username } = this.endpoint;
    switch (step) {
      case 'password':
        if (!this.permits('password')) {
          // PAM servers often allow only keyboard-interactive; it asks for the password there.
          return undefined;
        }
        return this.passwordAttempt(false);
      case 'key': {
        if (!this.permits('publickey')) return undefined;
        const file = this.endpoint.privateKeyPath;
        if (!file) throw new AuthFailure('The private key path is missing. Edit the connection and choose a key.');
        const attempt = await this.keyAttempt(file, true);
        if (attempt) this.lastStep = 'key';
        return attempt;
      }
      case 'agent':
        if (!this.permits('publickey')) return undefined;
        if (!this.ctx.agent) {
          this.notes.push('no SSH agent is running');
          return undefined;
        }
        this.lastStep = 'agent';
        return { type: 'agent', username, agent: this.ctx.agent };
      case 'defaults': {
        if (!this.permits('publickey')) return undefined;
        const file = this.ctx.identityFiles.shift();
        if (!file) return undefined;
        // More default files stay queued after this one.
        if (this.ctx.identityFiles.length > 0) this.steps.unshift('defaults');
        const attempt = await this.keyAttempt(file, false);
        if (attempt) this.lastStep = 'defaults';
        return attempt;
      }
      case 'keyboard':
        if (!this.permits('keyboard-interactive')) return undefined;
        return this.keyboardAttempt();
      default:
        return undefined;
    }
  }

  private async passwordAttempt(retry: boolean): Promise<Attempt | undefined> {
    const { username, main } = this.endpoint;
    this.lastStep = 'password';
    this.passwordTries += 1;
    if (!retry && this.ctx.savedPassword && !this.usedSaved) {
      this.usedSaved = true;
      this.savedForKeyboard = false;
      return { type: 'password', username, password: this.ctx.savedPassword };
    }
    const answer = await this.askOrStop({
      title: retry ? 'Wrong password. Try again' : 'Password',
      label: `password for ${this.who}`,
      masked: true,
      hint: main && !this.ctx.askPassword ? 'Tab: save or not · Enter: sign in · Esc: cancel' : 'Enter: sign in · Esc: cancel',
      save: main && !this.ctx.askPassword ? true : undefined,
    });
    if (main) this.typed = answer;
    this.savedForKeyboard = false;
    return { type: 'password', username, password: answer.value };
  }

  private async keyAttempt(file: string, required: boolean): Promise<Attempt | undefined> {
    const { username } = this.endpoint;
    let key: Buffer;
    try {
      key = this.ctx.readKey(file);
    } catch {
      if (required) throw new AuthFailure(`Could not read the private key at ${file}`);
      return undefined;
    }
    if (!keyNeedsPassphrase(key)) {
      const problem = keyProblem(key);
      if (problem) {
        if (required) throw new AuthFailure(`Could not use the private key ${file}: ${problem}`);
        return undefined;
      }
      return { type: 'publickey', username, key };
    }
    const saved = this.ctx.savedPassphrase;
    if (saved && saved.keyPath === file && !keyProblem(key, saved.passphrase)) {
      return { type: 'publickey', username, key, passphrase: saved.passphrase };
    }
    for (let tries = 0; tries < PASSWORD_TRIES; tries += 1) {
      const answer = await this.askOrStop({
        title: tries === 0 ? 'Key passphrase' : 'Wrong passphrase. Try again',
        label: `passphrase for ${keyName(file)}`,
        masked: true,
        hint: 'Enter: unlock · Esc: cancel',
      });
      if (!keyProblem(key, answer.value)) return { type: 'publickey', username, key, passphrase: answer.value };
    }
    throw new AuthFailure(`Wrong passphrase for ${file}`);
  }

  private keyboardAttempt(): Attempt {
    const { username, main } = this.endpoint;
    this.lastStep = 'keyboard';
    this.keyboardTries += 1;
    return {
      type: 'keyboard-interactive',
      username,
      prompt: (name, instructions, _lang, prompts, finish) => {
        this.answerPrompts(name, instructions, prompts, main).then(finish, (err: unknown) => {
          this.failure = err;
          // An empty answer ends this round. The handler then gives up.
          this.steps = [];
          this.keyboardTries = PASSWORD_TRIES;
          finish(prompts.map(() => ''));
        });
      },
    };
  }

  private async answerPrompts(
    name: string,
    instructions: string,
    prompts: { prompt: string; echo?: boolean }[],
    main: boolean,
  ): Promise<string[]> {
    const saved = this.ctx.savedPassword;
    if (
      saved &&
      this.savedForKeyboard &&
      prompts.length === 1 &&
      prompts[0].echo !== true &&
      looksLikePasswordPrompt(prompts[0].prompt)
    ) {
      this.savedForKeyboard = false;
      return [saved];
    }
    const answers: string[] = [];
    const detail = [name, instructions].map((part) => part?.trim()).filter(Boolean).join('\n') || undefined;
    for (const item of prompts) {
      const label = item.prompt.trim().replace(/:\s*$/, '') || 'answer';
      const passwordLike = item.echo !== true && looksLikePasswordPrompt(item.prompt);
      const save = main && passwordLike && !this.ctx.askPassword && prompts.length === 1 ? true : undefined;
      const answer = await this.askOrStop({
        title: `${this.who} asks`,
        label,
        masked: item.echo !== true,
        detail,
        hint: save === undefined ? 'Enter: send · Esc: cancel' : 'Tab: save or not · Enter: send · Esc: cancel',
        save,
      });
      if (save !== undefined) this.typed = answer;
      answers.push(answer.value);
    }
    return answers;
  }

  private async askOrStop(request: AskRequest): Promise<AskAnswer> {
    const answer = await this.ctx.ask(request);
    if (!answer) throw new TransferCancelled();
    return answer;
  }

  /** Words for "every method failed", with the next thing to try (U11). */
  explain(): string {
    const allowed = this.allowed ?? [];
    const methods = allowed.length ? allowed.join(', ') : 'none';
    if (this.partial) {
      return `${this.who}: the first sign-in step worked, but the server wants another one (${methods}). Two-factor prompts are shown in the terminal when the server sends them.`;
    }
    const { auth, privateKeyPath } = this.endpoint;
    const lacks = (method: string) => this.allowed !== null && !this.allowed.includes(method);
    if (auth === 'password') {
      if (lacks('password') && lacks('keyboard-interactive')) {
        return `${this.who} does not accept passwords (it allows: ${methods}). Edit the connection and use a key or the SSH agent.`;
      }
      return `Wrong user name or password for ${this.who}.`;
    }
    if (auth === 'privateKey') {
      if (lacks('publickey')) return `${this.who} does not accept keys (it allows: ${methods}).`;
      const name = privateKeyPath ? keyName(privateKeyPath) : 'the key';
      return `${this.who} did not accept ${name}. Is its public key in ~/.ssh/authorized_keys on the server?`;
    }
    if (lacks('publickey')) return `${this.who} does not accept keys (it allows: ${methods}). Use password sign-in.`;
    if (!this.ctx.agent) {
      const start = process.platform === 'win32'
        ? 'Start the "OpenSSH Authentication Agent" service or Pageant (setting easySsh.windowsAgent)'
        : 'Start ssh-agent and run ssh-add';
      return `No SSH agent is running and no default key (~/.ssh/id_ed25519, id_ecdsa, id_rsa) was accepted by ${this.who}. ${start}, or choose a key file.`;
    }
    return `${this.who} did not accept any key from the SSH agent or ~/.ssh. Run ssh-add to load the right key, or check ~/.ssh/authorized_keys on the server.`;
  }
}
