/**
 * Watch a login-shell byte stream. Output passes through unchanged, so the
 * MOTD, "Last login" and the first prompt show as they do over ssh (B12).
 * While Easy SSH's setup line runs, hide() holds the output (its echo) until
 * the hook's first directory report, then replaces the old prompt with the
 * new one. release() shows whatever was held when no report comes.
 */
export interface RawShellUpdate {
  text: string;
  /**
   * The directory from Easy SSH's own prompt hook, which prints a plain path.
   * file:// reports come from other programs (a nested ssh, vte.sh, a prompt theme)
   * and may describe another user or host, so they are ignored.
   */
  cwd?: string;
  altScreen: boolean;
  bracketedPaste: boolean;
  /** True while the remote side has xterm mouse reporting switched on. */
  mouse: boolean;
  /** True when this chunk left the alternate screen, even if it also entered it. */
  leftAlt?: boolean;
}

const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003]);

/** Easy SSH's hook prints "$PWD" as is; anything else is someone else's report. */
export function ownCwdReport(body: string): string | undefined {
  if (!body.startsWith('/')) return undefined;
  return normalizeCwd(body);
}

interface ModeChange {
  code: number;
  enable: boolean;
}

interface OscDirectory {
  cwd: string;
  end: number;
}

interface RawParse {
  cut: number;
  modes: ModeChange[];
  osc7: OscDirectory[];
}

const SEQUENCE_LIMIT = 8192;
const HOLD_LIMIT = 64_000;

export class RawShellTap {
  private buffer = '';
  private held = '';
  private hidden = false;
  /** True when the visible output ends at the start of a line (no prompt shown). */
  private atLineStart = true;
  private replacePrompt = false;
  /** Visible text since the last line break, for prompt detection. */
  private tailLine = '';
  private altScreen = false;
  private bracketedPaste = false;
  private mouse = false;

  /** True when the last visible line looks like a shell prompt ("$ ", "# ", "% ", "> "). */
  promptLike(): boolean {
    return /[$#%>\u276f\u00bb\u279c\u03bb]\s*$/.test(this.tailLine);
  }

  /** True while setup output is held back. */
  get hiding(): boolean {
    return this.hidden;
  }

  /** Hold output from now until the prompt hook reports a directory. */
  hide(): void {
    this.hidden = true;
    this.held = '';
    // A prompt is on screen: the hook's prompt replaces it instead of repeating it.
    this.replacePrompt = !this.atLineStart;
  }

  push(chunk: string): RawShellUpdate {
    this.buffer += chunk;
    return this.drain(false);
  }

  /** Record that Easy SSH itself switched mouse reporting off. */
  mouseOff(): void {
    this.mouse = false;
  }

  /** Show whatever is still held. Used when the shell never reports a directory. */
  release(): RawShellUpdate {
    if (!this.hidden) return this.drain(true);
    this.hidden = false;
    const text = this.held + this.buffer;
    this.held = '';
    this.buffer = '';
    return this.paint(text);
  }

  private drain(flush: boolean): RawShellUpdate {
    const cut = flush ? this.buffer.length : safeCut(this.buffer);
    if (cut === 0) return this.blank();
    const slice = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    if (!this.hidden) return this.paint(slice);
    this.held += slice;
    const mark = parseRaw(this.held, SEQUENCE_LIMIT).osc7.find((report) => ownCwdReport(report.cwd) !== undefined);
    if (!mark) {
      if (this.held.length > HOLD_LIMIT) return this.release();
      return this.blank();
    }
    this.hidden = false;
    const before = this.held.slice(0, mark.end);
    const after = this.held.slice(mark.end);
    this.held = '';
    // Keep the mode changes made while hidden (bracketed paste, for example).
    this.paint(before);
    const lines = (after.match(/\n/g) ?? []).length;
    const prefix = this.replacePrompt ? `\r${lines > 0 ? `\x1b[${lines}A` : ''}\x1b[J` : '';
    const update = this.paint(after);
    return { ...update, text: prefix + update.text, cwd: update.cwd ?? ownCwdReport(mark.cwd) };
  }

  private paint(text: string): RawShellUpdate {
    const parsed = parseRaw(text, SEQUENCE_LIMIT);
    let leftAlt = false;
    for (const mode of parsed.modes) {
      if (mode.code === 47 || mode.code === 1047 || mode.code === 1049) {
        if (!mode.enable) leftAlt = true;
        this.altScreen = mode.enable;
      }
      else if (mode.code === 2004) this.bracketedPaste = mode.enable;
      else if (MOUSE_MODES.has(mode.code)) this.mouse = mode.enable;
    }
    let last: string | undefined;
    for (const report of parsed.osc7) last = ownCwdReport(report.cwd) ?? last;
    const visible = stripSequences(text);
    const lastBreak = Math.max(visible.lastIndexOf('\n'), visible.lastIndexOf('\r'));
    const tail = visible.slice(lastBreak + 1);
    if (tail.length > 0) this.atLineStart = false;
    else if (lastBreak >= 0) this.atLineStart = true;
    this.tailLine = (lastBreak >= 0 ? tail : this.tailLine + tail).slice(-200);
    return {
      text,
      cwd: last,
      altScreen: this.altScreen,
      bracketedPaste: this.bracketedPaste,
      mouse: this.mouse,
      leftAlt: leftAlt && !this.altScreen,
    };
  }

  private blank(): RawShellUpdate {
    return {
      text: '',
      altScreen: this.altScreen,
      bracketedPaste: this.bracketedPaste,
      mouse: this.mouse,
    };
  }
}

/** Text without escape sequences and control bytes other than CR and LF. */
function stripSequences(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export function normalizeCwd(value: string): string | undefined {
  let text = value.trim();
  const file = /^file:\/\/[^/]*(\/.*)$/.exec(text);
  if (file) {
    try {
      text = decodeURIComponent(file[1]);
    } catch {
      text = file[1];
    }
  }
  if (!text || /[\r\n\x00]/.test(text)) return undefined;
  return text;
}

function safeCut(text: string): number {
  return parseRaw(text, SEQUENCE_LIMIT).cut;
}

/** Parse complete escape sequences. An unfinished one stays after `cut`. */
function parseRaw(text: string, limit: number): RawParse {
  const modes: ModeChange[] = [];
  const osc7: OscDirectory[] = [];
  let index = 0;
  while (index < text.length) {
    const esc = text.indexOf('\x1b', index);
    if (esc < 0) return { cut: text.length, modes, osc7 };
    if (esc + 1 >= text.length) return { cut: esc, modes, osc7 };
    const next = text[esc + 1];
    if (next === '[') {
      let cursor = esc + 2;
      while (cursor < text.length && text.charCodeAt(cursor) < 0x40) cursor += 1;
      if (cursor >= text.length) {
        if (text.length - esc > limit) {
          index = esc + 1;
          continue;
        }
        return { cut: esc, modes, osc7 };
      }
      const final = text[cursor];
      if ((final === 'h' || final === 'l') && text[esc + 2] === '?') {
        const enable = final === 'h';
        for (const part of text.slice(esc + 3, cursor).split(';')) {
          if (!part) continue;
          const code = Number(part);
          if (Number.isInteger(code)) modes.push({ code, enable });
        }
      }
      index = cursor + 1;
      continue;
    }
    if (next === ']') {
      let cursor = esc + 2;
      let end = -1;
      while (cursor < text.length) {
        if (text[cursor] === '\x07') {
          end = cursor + 1;
          break;
        }
        if (text[cursor] === '\x1b' && text[cursor + 1] === '\\') {
          end = cursor + 2;
          break;
        }
        cursor += 1;
        if (cursor - esc > limit) {
          end = -2;
          break;
        }
      }
      if (end === -1) return { cut: esc, modes, osc7 };
      if (end === -2) {
        index = esc + 1;
        continue;
      }
      const terminator = text[end - 1] === '\x07' ? 1 : 2;
      const body = text.slice(esc + 2, end - terminator);
      if (body.startsWith('7;')) osc7.push({ cwd: body.slice(2), end });
      index = end;
      continue;
    }
    if ((next === 'O' || next === 'P') && esc + 2 >= text.length) return { cut: esc, modes, osc7 };
    index = esc + 2;
  }
  return { cut: text.length, modes, osc7 };
}
