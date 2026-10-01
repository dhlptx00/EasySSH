import { remoteJoin } from '../remotePath';

/**
 * Easy SSH learns the shell's folder from a prompt hook that prints the folder
 * at every prompt (OSC 7). After Enter, the next prompt normally reports again
 * within milliseconds. When it does not, the terminal is running something else:
 * a program, a nested shell (`bash`), another user's shell (`sudo su`), or another
 * host (`ssh`). Those shells do not have the hook, so the last folder is stale.
 * Uploads use SFTP as the login user, so a stale folder must not be used silently.
 */

export type StaleKind = 'user' | 'host' | 'unknown';

export interface StaleCwd {
  kind: StaleKind;
  /** The first command line submitted since the last report, when known. */
  command: string | null;
  /** False when the shell has never reported a folder (no hook: sh, fish, ...). */
  everReported: boolean;
  /** True when the folder was followed from the `cd` lines typed since the last report. */
  followed?: boolean;
}

const SHELLS = new Set(['su', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'ash', 'mksh']);
const HOST_COMMANDS = new Set(['ssh', 'mosh', 'telnet', 'autossh']);

function words(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

/** True for a command line that starts a shell as another user: `sudo su`, `sudo -i`, `su - app`, `sudo -u app bash`. */
export function isUserSwitch(line: string | null): boolean {
  if (!line) return false;
  const parts = words(line);
  const command = parts[0];
  if (!command) return false;
  if (command === 'su' || command === 'runuser' || command === 'newgrp' || command === 'sg' || command === 'pkexec') return true;
  if (command === 'machinectl') return parts[1] === 'shell' || parts[1] === 'login';
  if (command !== 'sudo' && command !== 'doas') return false;
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '--login' || part === '--shell') return true;
    if (part === '-u' || part === '-g' || part === '-h' || part === '-p' || part === '-C' || part === '-D' || part === '-r' || part === '-t' || part === '--user' || part === '--group') {
      index += 1;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(part)) {
      if (/[is]/.test(part.slice(1))) return true;
      continue;
    }
    if (part.startsWith('-')) continue;
    return SHELLS.has(part.replace(/^.*\//, ''));
  }
  return false;
}

/** True for a command line that opens a shell on another machine or container. */
export function isHostSwitch(line: string | null): boolean {
  if (!line) return false;
  const parts = words(line);
  const command = parts[0]?.replace(/^.*\//, '');
  if (!command) return false;
  if (HOST_COMMANDS.has(command)) return true;
  if ((command === 'docker' || command === 'podman' || command === 'kubectl' || command === 'oc') && parts.includes('exec')) return true;
  return false;
}

export function classifyStale(commands: (string | null)[]): StaleKind {
  if (commands.some(isUserSwitch)) return 'user';
  if (commands.some(isHostSwitch)) return 'host';
  return 'unknown';
}

export interface UploadQuestion {
  /** Short first line of the dialog. */
  message: string;
  /** Longer explanation. */
  detail: string;
  /** Last folder the shell reported. */
  cwd: string;
  /** The login user's home on the server, when known. */
  home?: string;
  /** The SSH login user; uploads are written as this user. */
  loginUser: string;
  names: string[];
}

function quote(command: string): string {
  const short = command.length > 60 ? `${command.slice(0, 57)}...` : command;
  return `"${short}"`;
}

export function staleUploadQuestion(
  stale: StaleCwd,
  cwd: string,
  loginUser: string,
  host: string,
  names: string[],
  home?: string,
): UploadQuestion {
  const what = names.length === 1 ? names[0] : `${names.length} items`;
  const after = stale.command ? ` after ${quote(stale.command)}` : '';
  let detail: string;
  if (!stale.everReported) {
    detail = `This shell does not report its current folder (Easy SSH tracks it in bash and zsh). The last known folder is ${cwd}.`;
  } else if (stale.kind === 'user') {
    const where = stale.followed
      ? `Easy SSH followed the cd commands typed since then to ${cwd}. `
      : `That shell does not report its folder, so the last known folder is ${cwd}. `;
    detail = `The terminal switched to another user${after}. ${where}`
      + `Uploads are written over SFTP as ${loginUser}, not as the switched user, so they cannot go into folders only that user can write. `
      + `Upload to a folder ${loginUser} can write, then move the file with sudo mv in the terminal.`;
  } else if (stale.kind === 'host') {
    detail = `The terminal opened another machine or container${after}. Uploads still go to ${host} as ${loginUser}. The last known folder there is ${cwd}.`;
  } else {
    detail = `The shell has not reported its folder${after}. A program may still be running, or another shell was started. `
      + `The last known folder is ${cwd}. Uploads are written as ${loginUser}.`;
  }
  return {
    message: `Upload ${what}? Easy SSH does not know this terminal's current folder.`,
    detail,
    cwd,
    home,
    loginUser,
    names,
  };
}

/**
 * Following the folder of a shell that has no prompt hook.
 *
 * After `sudo su` (or in sh/fish, or a nested bash) nothing reports $PWD, so the
 * last reported folder goes stale and the file names on screen no longer match
 * its listing. Easy SSH then follows the `cd` lines the user submits, checking
 * each target on the server, the same way the shell would resolve them.
 * Anything it cannot follow (a recalled history line, `cd ~`, `$VAR`, pushd, a
 * login shell for another user) makes the folder unknown instead of guessing;
 * a later `cd /absolute/path` finds it again.
 */
export type FollowStep =
  | { kind: 'cd'; target: string }
  | { kind: 'back' }
  | { kind: 'enter'; keepsFolder: boolean; otherHost: boolean }
  | { kind: 'exit' }
  | { kind: 'lost' };

/** Shells that, typed on their own, start a nested interactive shell. */
const NESTED_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'tcsh', 'csh', 'ash', 'mksh', 'fish']);
const LOST_COMMANDS = new Set(['pushd', 'popd', 'source', '.', 'exec']);

/** Split a line into simple words. Returns null when shell expansion would be needed to know them. */
function shellWords(text: string): string[] | null {
  const out: string[] = [];
  let current = '';
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (ch === '$' || ch === '`') return null;
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && index + 1 < text.length && '"\\$`'.includes(text[index + 1])) current += text[++index];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\') {
      if (index + 1 < text.length) current += text[++index];
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) out.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) return null;
  if (started) out.push(current);
  return out;
}

/**
 * Split on `;` and `&&` outside quotes. `|`, `||`, `&`, subshells and redirections
 * make the effect on the folder uncertain, so those lines return null.
 */
function segments(line: string): string[] | null {
  const out: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') {
        current += ch + (line[index + 1] ?? '');
        index += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '\\') {
      current += ch + (line[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (ch === ';') {
      out.push(current);
      current = '';
      continue;
    }
    if (ch === '&' && line[index + 1] === '&') {
      out.push(current);
      current = '';
      index += 1;
      continue;
    }
    if (ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '{' || ch === '}' || ch === '<' || ch === '>') return null;
    current += ch;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter(Boolean);
}

function isLoginSwitch(parts: string[]): boolean {
  const command = parts[0];
  if (command === 'machinectl' || command === 'pkexec') return true;
  return parts.some((part, index) => index > 0 && (
    part === '-' || part === '-l' || part === '--login'
    || ((command === 'sudo' || command === 'doas') && /^-[A-Za-z]*i[A-Za-z]*$/.test(part))
  ));
}

function cdStep(args: string[], cwd: string | null): FollowStep {
  const rest = [...args];
  while (rest.length && /^-[LPe@]+$/.test(rest[0])) rest.shift();
  if (rest[0] === '--') rest.shift();
  if (rest.length !== 1) return { kind: 'lost' };
  const arg = rest[0];
  if (arg === '-') return { kind: 'back' };
  if (!arg || arg.startsWith('~') || /[*?[]/.test(arg)) return { kind: 'lost' };
  if (arg.startsWith('/')) return { kind: 'cd', target: remoteJoin('/', arg) };
  if (cwd === null) return { kind: 'lost' };
  return { kind: 'cd', target: remoteJoin(cwd, arg) };
}

/** What one submitted line does to the shell's folder, in order. `cwd` is the folder before the line. */
export function followSteps(line: string | null, cwd: string | null): FollowStep[] {
  if (line === null) return [{ kind: 'lost' }];
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return [];
  const parts = segments(trimmed);
  if (parts === null) return /(^|[;&|({\s])(cd|pushd|popd)(\s|$)/.test(trimmed) ? [{ kind: 'lost' }] : [];
  const steps: FollowStep[] = [];
  let here = cwd;
  for (const part of parts) {
    const words = shellWords(part);
    if (words === null) {
      if (/^(cd|pushd|popd)(\s|$)/.test(part)) steps.push({ kind: 'lost' });
      continue;
    }
    const command = words[0];
    if (!command) continue;
    if (command === 'cd') {
      const step = cdStep(words.slice(1), here);
      steps.push(step);
      here = step.kind === 'cd' ? step.target : null;
      continue;
    }
    if (command === 'exit' || command === 'logout') {
      steps.push({ kind: 'exit' });
      continue;
    }
    if (LOST_COMMANDS.has(command)) {
      steps.push({ kind: 'lost' });
      continue;
    }
    if (isHostSwitch(part)) {
      steps.push({ kind: 'enter', keepsFolder: false, otherHost: true });
      continue;
    }
    const bareShell = NESTED_SHELLS.has(command.replace(/^.*\//, '')) && words.slice(1).every((word) => word.startsWith('-') && word !== '-c');
    if (isUserSwitch(part) || bareShell) {
      const keepsFolder = !isLoginSwitch(words);
      steps.push({ kind: 'enter', keepsFolder, otherHost: false });
      if (!keepsFolder) here = null;
    }
  }
  return steps;
}

interface FollowFrame {
  cwd: string | null;
  previous: string | null;
  otherHost: boolean;
}

/** True when the path is a folder, false when it does not exist or is a file, undefined when the server would not say. */
export type FolderCheck = (path: string) => Promise<boolean | undefined>;

export class FolderFollower {
  /** The followed folder, or null when it cannot be known. */
  cwd: string | null;
  private previous: string | null = null;
  /** True while the shell is on another machine or container (ssh, docker exec). */
  private otherHost = false;
  private readonly stack: FollowFrame[] = [];

  constructor(start: string) {
    this.cwd = start;
  }

  async apply(line: string | null, isFolder: FolderCheck): Promise<void> {
    for (const step of followSteps(line, this.otherHost ? null : this.cwd)) {
      await this.step(step, isFolder);
    }
  }

  private async step(step: FollowStep, isFolder: FolderCheck): Promise<void> {
    switch (step.kind) {
      case 'enter':
        this.stack.push({ cwd: this.cwd, previous: this.previous, otherHost: this.otherHost });
        if (step.otherHost) this.otherHost = true;
        if (!step.keepsFolder) {
          this.cwd = null;
          this.previous = null;
        }
        return;
      case 'exit': {
        const frame = this.stack.pop();
        if (!frame) return;
        this.cwd = frame.cwd;
        this.previous = frame.previous;
        this.otherHost = frame.otherHost;
        return;
      }
      case 'lost':
        this.previous = this.cwd;
        this.cwd = null;
        return;
      case 'back':
        if (this.otherHost) return;
        [this.cwd, this.previous] = [this.previous, this.cwd];
        return;
      case 'cd': {
        if (this.otherHost) return;
        const found = await isFolder(step.target).catch(() => undefined);
        // `cd /wwww: No such file or directory` leaves the shell where it was.
        if (found === false) return;
        this.previous = this.cwd;
        this.cwd = step.target;
        return;
      }
      default: {
        const unreachable: never = step;
        return unreachable;
      }
    }
  }
}
