/**
 * One line sent to a new login shell. Bash and zsh then report $PWD
 * before each prompt so the file list stays in the same directory.
 */
export const SHELL_HOOK =
  'if [ -n "$ZSH_VERSION" ]; then easy_ssh_cwd() { printf \'\\033]7;%s\\007\' "$PWD"; }; precmd_functions+=(easy_ssh_cwd); elif [ -n "$BASH_VERSION" ]; then PROMPT_COMMAND=${PROMPT_COMMAND:+"$PROMPT_COMMAND;"}' +
  '\'printf "\\033]7;%s\\007" "$PWD"\'; fi';

export interface ShellUpdate {
  /** Characters to append to the transcript. Empty while the shell is still starting. */
  text: string;
  /** Latest directory reported by the prompt hook. */
  cwd?: string;
  /** A prompt was reached, so the previous command has finished. */
  prompted: boolean;
}

interface ParsedShell {
  text: string;
  after: string;
  cwd?: string;
  pending: string;
}

/** Quote one argument for a remote POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Turn a live shell stream into transcript text.
 * Output before the first directory report is hidden, which drops the setup command.
 * An unfinished escape sequence is kept until the next chunk.
 */
export class ShellFeed {
  private pending = '';
  private held = '';
  private primed = false;

  get ready(): boolean {
    return this.primed;
  }

  push(chunk: string): ShellUpdate {
    const parsed = parseShellText(this.pending + chunk);
    this.pending = parsed.pending;
    if (!this.primed) {
      if (!parsed.cwd) {
        this.held += parsed.text;
        return { text: '', prompted: false };
      }
      this.primed = true;
      this.held = '';
      return { text: parsed.after, cwd: parsed.cwd, prompted: true };
    }
    return { text: parsed.text, cwd: parsed.cwd, prompted: parsed.cwd !== undefined };
  }

  /** Give up on the directory report and show later output as it arrives. */
  release(): void {
    if (this.primed) return;
    this.primed = true;
    this.held = '';
  }
}

function parseShellText(raw: string): ParsedShell {
  let text = '';
  let after = '';
  let cwd: string | undefined;
  let seen = false;
  let index = 0;
  const push = (value: string) => {
    text += value;
    if (seen) after += value;
  };
  while (index < raw.length) {
    if (raw[index] !== '\x1b') {
      const start = index;
      while (index < raw.length && raw[index] !== '\x1b') index += 1;
      push(visiblePlain(raw.slice(start, index)));
      continue;
    }
    if (index + 1 >= raw.length) return { text, after, cwd, pending: raw.slice(index) };
    const next = raw[index + 1];
    if (next === ']') {
      const bel = raw.indexOf('\x07', index + 2);
      const st = raw.indexOf('\x1b\\', index + 2);
      const belFirst = bel >= 0 && (st < 0 || bel < st);
      const stop = belFirst ? bel : st;
      if (stop < 0) return { text, after, cwd, pending: raw.slice(index) };
      const body = raw.slice(index + 2, stop);
      if (body.startsWith('7;')) {
        cwd = body.slice(2);
        seen = true;
        after = '';
      }
      index = belFirst ? stop + 1 : stop + 2;
      continue;
    }
    if (next === '[') {
      const finalAt = raw.slice(index + 2).search(/[@-~]/);
      if (finalAt < 0) return { text, after, cwd, pending: raw.slice(index) };
      const final = raw[index + 2 + finalAt];
      if (final === 'm') push(raw.slice(index, index + 3 + finalAt));
      index += 3 + finalAt;
      continue;
    }
    index += 2;
  }
  return { text, after, cwd, pending: '' };
}

function visiblePlain(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '\r') {
      if (text[index + 1] === '\n') index += 1;
      out += '\n';
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code === 10 || code === 9 || code >= 32) out += ch;
  }
  return out;
}
