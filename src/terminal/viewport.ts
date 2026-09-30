import { charWidth } from '../text';

/**
 * The visible cells of the live terminal, used to see which file name was clicked.
 * What the terminal shows is still the raw byte stream. This only mirrors it.
 */
export class Viewport {
  private lines: string[][] = [];
  private row = 0;
  private col = 0;
  private savedRow = 0;
  private savedCol = 0;
  private cols: number;
  private rows: number;
  private state: 'ground' | 'esc' | 'csi' | 'osc' | 'osc-esc' = 'ground';
  private params = '';
  private prefix = '';
  private alt = false;
  private normalLines: string[][] | undefined;
  private normalRow = 0;
  private normalCol = 0;

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.reset();
  }

  resize(cols: number, rows: number): void {
    const nextCols = Math.max(1, cols);
    const nextRows = Math.max(1, rows);
    this.row = this.refit(this.lines, this.row, nextRows);
    if (this.normalLines) this.normalRow = this.refit(this.normalLines, this.normalRow, nextRows);
    this.cols = nextCols;
    this.rows = nextRows;
    this.clamp();
    this.normalCol = Math.max(0, Math.min(this.cols - 1, this.normalCol));
  }

  private refit(lines: string[][], row: number, rows: number): number {
    const extra = lines.length - rows;
    let next = row;
    if (extra > 0) {
      lines.splice(0, extra);
      next = Math.max(0, next - extra);
    }
    while (lines.length < rows) lines.push([]);
    return next;
  }

  /** Cells on a 1-based viewport row. */
  cells(row: number): readonly string[] {
    return this.lines[row - 1] ?? [];
  }

  write(data: string): void {
    for (const ch of data) this.step(ch);
  }

  private reset(): void {
    this.lines = Array.from({ length: this.rows }, () => []);
    this.row = 0;
    this.col = 0;
  }

  private step(ch: string): void {
    if (this.state === 'osc') {
      if (ch === '\x07') this.state = 'ground';
      else if (ch === '\x1b') this.state = 'osc-esc';
      return;
    }
    if (this.state === 'osc-esc') {
      this.state = ch === '\\' ? 'ground' : 'osc';
      return;
    }
    if (this.state === 'esc') {
      if (ch === '[') {
        this.state = 'csi';
        this.params = '';
        this.prefix = '';
        return;
      }
      if (ch === ']') {
        this.state = 'osc';
        return;
      }
      if (ch === '7') this.save();
      else if (ch === '8') this.restore();
      else if (ch === 'M') this.reverse();
      this.state = 'ground';
      return;
    }
    if (this.state === 'csi') {
      if ((ch === '?' || ch === '>' || ch === '!') && this.params.length === 0 && !this.prefix) {
        this.prefix = ch;
        return;
      }
      if ((ch >= '0' && ch <= '9') || ch === ';' || ch === ':') {
        this.params += ch;
        return;
      }
      if (ch >= '@' && ch <= '~') this.csi(ch);
      this.state = 'ground';
      this.prefix = '';
      return;
    }
    if (ch === '\x1b') {
      this.state = 'esc';
      return;
    }
    if (ch === '\r') {
      this.col = 0;
      return;
    }
    if (ch === '\n') {
      this.index();
      return;
    }
    if (ch === '\b') {
      this.col = Math.max(0, this.col - 1);
      return;
    }
    if (ch === '\t') {
      this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
      return;
    }
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return;
    this.put(ch, Math.max(1, charWidth(code)));
  }

  private put(ch: string, width: number): void {
    if (this.col + width > this.cols) {
      this.col = 0;
      this.index();
    }
    const line = this.lines[this.row] ?? [];
    this.lines[this.row] = line;
    while (line.length < this.col) line.push(' ');
    line[this.col] = ch;
    if (width === 2) line[this.col + 1] = '';
    this.col += width;
  }

  private index(): void {
    if (this.row < this.rows - 1) {
      this.row += 1;
      return;
    }
    this.lines.shift();
    this.lines.push([]);
  }

  private reverse(): void {
    if (this.row > 0) {
      this.row -= 1;
      return;
    }
    this.lines.pop();
    this.lines.unshift([]);
  }

  private save(): void {
    this.savedRow = this.row;
    this.savedCol = this.col;
  }

  private restore(): void {
    this.row = this.savedRow;
    this.col = this.savedCol;
    this.clamp();
  }

  private csi(final: string): void {
    if (this.prefix === '?' && (final === 'h' || final === 'l')) {
      this.decMode(final === 'h');
      return;
    }
    const args = this.params.split(';').map((part) => Number(part));
    const at = (index: number, fallback: number) => {
      const value = args[index];
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    if (final === 'H' || final === 'f') {
      this.row = at(0, 1) - 1;
      this.col = at(1, 1) - 1;
      this.clamp();
      return;
    }
    if (final === 'A') this.row -= at(0, 1);
    else if (final === 'B') this.row += at(0, 1);
    else if (final === 'C') this.col += at(0, 1);
    else if (final === 'D') this.col -= at(0, 1);
    else if (final === 'G') this.col = at(0, 1) - 1;
    else if (final === 'd') this.row = at(0, 1) - 1;
    else if (final === 'J') this.eraseDisplay(at(0, 0) === 0 && this.params === '' ? 0 : Number(args[0] ?? 0));
    else if (final === 'K') this.eraseLine(this.params === '' ? 0 : Number(args[0] ?? 0));
    else if (final === 's') this.save();
    else if (final === 'u') this.restore();
    if (final === 'A' || final === 'B' || final === 'C' || final === 'D' || final === 'G' || final === 'd') this.clamp();
  }

  /** Remember the shell screen while a full-screen program takes the alternate buffer. */
  private decMode(enable: boolean): void {
    for (const part of this.params.split(';')) {
      const code = Number(part);
      if (code === 1049 || code === 1047) this.useAlt(enable, true);
      else if (code === 47) this.useAlt(enable, false);
    }
  }

  private useAlt(enable: boolean, clear: boolean): void {
    if (enable) {
      if (!this.alt) {
        this.normalLines = this.lines.map((line) => line.slice());
        this.normalRow = this.row;
        this.normalCol = this.col;
        this.alt = true;
      }
      if (clear) this.reset();
      return;
    }
    if (!this.alt || !this.normalLines) return;
    this.alt = false;
    this.lines = this.normalLines;
    this.row = this.normalRow;
    this.col = this.normalCol;
    this.normalLines = undefined;
    this.clamp();
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.lines = Array.from({ length: this.rows }, () => []);
      return;
    }
    if (mode === 1) {
      for (let row = 0; row < this.row; row += 1) this.lines[row] = [];
      this.eraseLine(1);
      return;
    }
    this.eraseLine(0);
    for (let row = this.row + 1; row < this.rows; row += 1) this.lines[row] = [];
  }

  private eraseLine(mode: number): void {
    const line = this.lines[this.row] ?? [];
    this.lines[this.row] = line;
    if (mode === 2) {
      this.lines[this.row] = [];
      return;
    }
    if (mode === 1) {
      for (let index = 0; index < this.col && index < line.length; index += 1) line[index] = ' ';
      return;
    }
    line.length = this.col;
  }

  private clamp(): void {
    this.row = Math.max(0, Math.min(this.rows - 1, this.row));
    this.col = Math.max(0, Math.min(this.cols - 1, this.col));
  }
}
