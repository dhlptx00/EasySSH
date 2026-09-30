/**
 * Watch a login-shell byte stream without changing it.
 * Bytes before the first OSC 7 directory report are hidden so the setup
 * command does not appear. After that, every byte is forwarded.
 */
export interface RawShellUpdate {
  text: string;
  cwd?: string;
  altScreen: boolean;
  bracketedPaste: boolean;
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
  private primed = false;
  private altScreen = false;
  private bracketedPaste = false;

  get ready(): boolean {
    return this.primed;
  }

  push(chunk: string): RawShellUpdate {
    this.buffer += chunk;
    return this.drain(false);
  }

  /** Show whatever is still held. Used when the shell never reports a directory. */
  release(): RawShellUpdate {
    return this.drain(true);
  }

  private drain(flush: boolean): RawShellUpdate {
    const cut = flush ? this.buffer.length : safeCut(this.buffer);
    const slice = this.buffer.slice(0, cut);
    if (!this.primed) {
      const mark = parseRaw(slice, SEQUENCE_LIMIT).osc7[0];
      if (!mark && !flush && this.buffer.length <= HOLD_LIMIT) return this.blank();
      if (!mark && cut === 0) return this.blank();
      this.primed = true;
      const text = mark ? slice.slice(mark.end) : slice;
      this.buffer = this.buffer.slice(cut);
      const update = this.paint(text);
      const cwd = update.cwd ?? (mark ? normalizeCwd(mark.cwd) : undefined);
      return { ...update, cwd };
    }
    if (cut === 0) return this.blank();
    this.buffer = this.buffer.slice(cut);
    return this.paint(slice);
  }

  private paint(text: string): RawShellUpdate {
    const parsed = parseRaw(text, SEQUENCE_LIMIT);
    for (const mode of parsed.modes) {
      if (mode.code === 47 || mode.code === 1047 || mode.code === 1049) this.altScreen = mode.enable;
      else if (mode.code === 2004) this.bracketedPaste = mode.enable;
    }
    const last = parsed.osc7.length ? normalizeCwd(parsed.osc7[parsed.osc7.length - 1].cwd) : undefined;
    return {
      text,
      cwd: last,
      altScreen: this.altScreen,
      bracketedPaste: this.bracketedPaste,
    };
  }

  private blank(): RawShellUpdate {
    return {
      text: '',
      altScreen: this.altScreen,
      bracketedPaste: this.bracketedPaste,
    };
  }
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
