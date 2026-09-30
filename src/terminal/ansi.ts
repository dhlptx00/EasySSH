import { charWidth } from '../text';

export interface TermLine {
  plain: string;
  styled: string;
}

export interface Emphasis {
  start: number;
  length: number;
  selected: boolean;
}

/** Keep text and SGR colors. Drop cursor and erase sequences that would redraw the screen. */
export function sanitizeTerminal(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === '\r') {
      if (text[index + 1] === '\n') index += 1;
      out += '\n';
      continue;
    }
    if (ch !== '\x1b') {
      const code = ch.codePointAt(0) ?? 0;
      if (code === 10 || code === 9 || code >= 32) out += ch;
      continue;
    }
    const next = text[index + 1];
    if (next === '[') {
      const finalAt = text.slice(index + 2).search(/[@-~]/);
      if (finalAt < 0) break;
      const final = text[index + 2 + finalAt];
      if (final === 'm') out += text.slice(index, index + 3 + finalAt);
      index += 2 + finalAt;
      continue;
    }
    if (next === ']') {
      const bel = text.indexOf('\x07', index + 2);
      const st = text.indexOf('\x1b\\', index + 2);
      const stop = bel >= 0 && (st < 0 || bel < st) ? bel : st >= 0 ? st + 1 : -1;
      if (stop < 0) break;
      index = stop;
      continue;
    }
  }
  return out;
}

/** Wrap sanitized terminal text to a display width, preserving SGR colors. */
export function wrapTerminal(text: string, width: number): TermLine[] {
  const clean = sanitizeTerminal(text);
  const limit = Math.max(1, width);
  const lines: TermLine[] = [];
  let plain = '';
  let styled = '';
  let used = 0;
  let sgr = '';

  const push = () => {
    lines.push({ plain, styled: `${styled}\x1b[0m` });
    plain = '';
    styled = sgr;
    used = 0;
  };

  for (let index = 0; index < clean.length; index += 1) {
    const ch = clean[index];
    if (ch === '\n') {
      push();
      sgr = '';
      styled = '';
      continue;
    }
    if (ch === '\x1b') {
      const match = /^\x1b\[[0-9;]*m/.exec(clean.slice(index));
      if (match) {
        sgr = match[0];
        styled += match[0];
        index += match[0].length - 1;
      }
      continue;
    }
    if (ch === '\t') {
      const spaces = 8 - (used % 8);
      for (let count = 0; count < spaces; count += 1) {
        if (used >= limit) push();
        plain += ' ';
        styled += ' ';
        used += 1;
      }
      continue;
    }
    const wide = charWidth(ch.codePointAt(0) ?? 0);
    if (wide === 0) continue;
    if (used > 0 && used + wide > limit) push();
    plain += ch;
    styled += ch;
    used += wide;
  }
  if (plain.length > 0 || lines.length === 0) push();
  return lines;
}

/** Underline or highlight character spans without moving the visible text. */
export function emphasize(line: TermLine, spans: Emphasis[]): TermLine {
  const active = spans.filter((span) => span.length > 0 && span.start >= 0);
  if (active.length === 0) return line;
  const sorted = [...active].sort((a, b) => a.start - b.start);
  const source = line.styled.endsWith('\x1b[0m') ? line.styled.slice(0, -4) : line.styled;
  let styled = '';
  let plainIndex = 0;
  let current = '\x1b[0m';
  const covering = (index: number) => sorted.find((span) => index >= span.start && index < span.start + span.length);

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\x1b') {
      const match = /^\x1b\[[0-9;]*m/.exec(source.slice(index));
      if (match) {
        current = match[0];
        if (!covering(plainIndex)) styled += match[0];
        index += match[0].length - 1;
        continue;
      }
    }
    const span = covering(plainIndex);
    if (span && plainIndex === span.start) {
      styled += span.selected ? '\x1b[1;4;48;2;48;48;48m' : '\x1b[4m';
    }
    styled += source[index];
    const ended = Boolean(span && plainIndex + 1 === span.start + span.length);
    plainIndex += 1;
    if (ended) styled += `\x1b[0m${current === '\x1b[0m' ? '' : current}`;
  }
  return { plain: line.plain, styled: `${styled}\x1b[0m` };
}
