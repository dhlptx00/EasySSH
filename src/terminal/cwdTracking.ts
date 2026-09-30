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
    detail = `The terminal switched to another user${after}, and that shell does not report its folder, so the last known folder is ${cwd}. `
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
