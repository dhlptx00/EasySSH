import { formatFingerprint, formatSize, formatTime, padLeft, shortenPath, truncate, displayWidth } from '../text';
import type { BrowseEntry, Notice, TransferState } from '../types';
import type { Screen } from './screen';
import { promptFor, stepValue, stepsBefore } from './wizard';

export interface LineLink {
  start: number;
  length: number;
  remotePath: string;
  kind: 'file' | 'dir';
  tooltip: string;
}

export interface PaintedLine {
  plain: string;
  styled: string;
}

export interface Frame {
  lines: PaintedLine[];
  cursor?: { row: number; col: number };
  links: Map<string, LineLink>;
}

export interface RenderView {
  cols: number;
  rows: number;
  downloadFolder: string;
  home: string;
  clickHint: string;
}

type Tone = 'text' | 'muted' | 'primary' | 'green' | 'red' | 'blue';

interface Piece {
  text: string;
  tone?: Tone;
  bold?: boolean;
}

const FG: Record<Tone, string> = {
  text: '224;224;224',
  muted: '106;106;106',
  primary: '250;178;131',
  green: '127;216;143',
  red: '224;108;117',
  blue: '92;156;245',
};

function paintPieces(pieces: Piece[], width: number, selected = false): PaintedLine {
  let plain = '';
  let styled = '';
  let used = 0;
  const open = (tone: Tone, bold: boolean) => {
    const parts = ['0'];
    if (bold) parts.push('1');
    parts.push(`38;2;${FG[tone]}`);
    if (selected) parts.push('48;2;48;48;48');
    return `\x1b[${parts.join(';')}m`;
  };
  for (const piece of pieces) {
    if (!piece.text || used >= width) continue;
    const room = width - used;
    const shown = truncate(piece.text, room);
    // truncate adds an ellipsis only when the piece itself does not fit.
    // A following piece must keep the remaining columns, so cut without borrowing
    // the ellipsis from a later column when this piece is only a spacer.
    const fitted = displayWidth(piece.text) <= room ? piece.text : shown;
    plain += fitted;
    styled += open(piece.tone ?? 'text', Boolean(piece.bold)) + fitted;
    used += displayWidth(fitted);
  }
  if (used < width) {
    const gap = ' '.repeat(width - used);
    plain += gap;
    if (selected) styled += open('text', false) + gap;
    else styled += gap;
  }
  styled += '\x1b[0m';
  return { plain, styled };
}

function blank(width: number): PaintedLine {
  return paintPieces([{ text: '' }], width);
}

function hints(items: string[], width: number): PaintedLine {
  const kept: string[] = [];
  for (const item of items) {
    const next = kept.length === 0 ? item : `${kept.join('   ')}   ${item}`;
    if (displayWidth(next) > width) break;
    kept.push(item);
  }
  return paintPieces([{ text: kept.join('   '), tone: 'muted' }], width);
}

function noticeLine(notice: Notice | undefined, width: number): PaintedLine | undefined {
  if (!notice) return undefined;
  const tone = notice.tone === 'error' ? 'red' : notice.tone === 'ok' ? 'green' : 'blue';
  return paintPieces([{ text: truncate(notice.text, width), tone }], width);
}

function header(meta: string, width: number): PaintedLine {
  const title = 'Easy SSH';
  if (!meta || displayWidth(title) + 2 + displayWidth(meta) > width) {
    return paintPieces([{ text: truncate(title, width), tone: 'primary', bold: true }], width);
  }
  const gap = width - displayWidth(title) - displayWidth(meta);
  return paintPieces(
    [
      { text: title, tone: 'primary', bold: true },
      { text: ' '.repeat(gap) },
      { text: meta, tone: 'muted' },
    ],
    width,
  );
}

function downloadMeta(folder: string, home: string, cols: number): string {
  const prefix = 'download → ';
  const budget = cols - displayWidth('Easy SSH') - 2 - displayWidth(prefix);
  if (budget < 8) return '';
  return prefix + shortenPath(folder, home, budget);
}

function fit(lines: PaintedLine[], rows: number, width: number): PaintedLine[] {
  if (lines.length === rows) return lines;
  if (lines.length > rows) return lines.slice(0, rows);
  return [...lines, ...Array.from({ length: rows - lines.length }, () => blank(width))];
}

function windowed<T>(items: T[], selected: number, height: number): T[] {
  if (height <= 0) return [];
  if (items.length <= height) return items;
  let start = selected - Math.floor((height - 1) / 2);
  if (start < 0) start = 0;
  if (start > items.length - height) start = items.length - height;
  return items.slice(start, start + height);
}

function progressLine(transfer: TransferState, width: number): PaintedLine {
  const ratio = transfer.total > 0 ? Math.max(0, Math.min(1, transfer.done / transfer.total)) : 0;
  const percent = transfer.total > 0 ? `${Math.floor(ratio * 100)}%` : '...';
  const verb = transfer.direction === 'download' ? 'Downloading' : 'Uploading';
  const count = transfer.count > 1 ? `  ${transfer.index}/${transfer.count}` : '';
  const label = `${verb} ${transfer.label}  ${percent}${count}`;
  const barWidth = Math.max(0, Math.min(16, width - displayWidth(label) - 2));
  const filled = Math.round(barWidth * ratio);
  const bar = barWidth > 0 ? `  ${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}` : '';
  return paintPieces(
    [
      { text: truncate(label, width - displayWidth(bar)), tone: 'primary' },
      { text: bar, tone: 'primary' },
    ],
    width,
  );
}

function entryName(entry: BrowseEntry): string {
  if (entry.name === '..') return '../';
  if (entry.kind === 'dir') return `${entry.name}/`;
  if (entry.kind === 'link') return `${entry.name}@`;
  return entry.name;
}

export function render(screen: Screen, view: RenderView): Frame {
  const { cols, rows } = view;
  const links = new Map<string, LineLink>();
  if (cols < 24 || rows < 6) {
    return {
      lines: fit([paintPieces([{ text: 'Resize the terminal', tone: 'muted' }], Math.max(cols, 1))], rows, Math.max(cols, 1)),
      links,
    };
  }

  const meta = downloadMeta(view.downloadFolder, view.home, cols);
  const top = header(meta, cols);
  let body: PaintedLine[] = [];
  let cursor: { row: number; col: number } | undefined;
  let footerNote: PaintedLine | undefined;
  let footer = hints(['q quit'], cols);

  if (screen.kind === 'loading') {
    body = [blank(cols), paintPieces([{ text: 'Loading connections…', tone: 'muted' }], cols)];
  } else if (screen.kind === 'connecting') {
    body = [
      blank(cols),
      paintPieces([{ text: `Connecting to ${screen.label}`, tone: 'primary' }], cols),
    ];
    footer = hints(['ctrl+c cancel'], cols);
  } else if (screen.kind === 'connections') {
    footerNote = noticeLine(screen.notice, cols);
    footer = hints(['enter connect', 'n new', 'e edit', 'd delete', 'i import', 'o folder', 'q quit'], cols);
    body = [blank(cols), paintPieces([{ text: 'connections', tone: 'muted' }], cols), blank(cols)];
    if (screen.items.length === 0) {
      body.push(paintPieces([{ text: '  No connections yet', tone: 'text' }], cols));
      body.push(paintPieces([{ text: '  Press n to add one, or i to import ~/.ssh/config', tone: 'muted' }], cols));
    } else {
      const listHeight = Math.max(1, rows - body.length - 2 - (footerNote ? 1 : 0));
      const visible = windowed(screen.items, screen.selected, listHeight);
      const offset = screen.items.indexOf(visible[0] ?? screen.items[0]);
      visible.forEach((item, index) => {
        const selected = offset + index === screen.selected;
        const marker = selected ? '❯ ' : '  ';
        const detail = item.detail ? `  ${item.detail}` : '';
        const right = item.userHost;
        const fixed = displayWidth(marker) + displayWidth(detail) + 1 + displayWidth(right);
        const nameWidth = Math.max(4, cols - fixed);
        const name = truncate(item.name, nameWidth);
        const gap = Math.max(1, cols - displayWidth(marker + name + detail) - displayWidth(right));
        body.push(
          paintPieces(
            [
              { text: marker, tone: 'primary', bold: selected },
              { text: name, tone: 'text' },
              { text: detail, tone: 'muted' },
              { text: ' '.repeat(gap) },
              { text: right, tone: 'muted' },
            ],
            cols,
            selected,
          ),
        );
      });
    }
  } else if (screen.kind === 'confirm' || screen.kind === 'trust') {
    const title = screen.kind === 'confirm' ? `Delete ${screen.item.name}?` : 'Host key changed';
    const choices = screen.kind === 'confirm'
      ? ['No', 'Yes, delete']
      : ['No, disconnect', 'Yes, trust this key'];
    body = [blank(cols), paintPieces([{ text: title, tone: 'primary', bold: true }], cols), blank(cols)];
    if (screen.kind === 'trust') {
      body.push(paintPieces([{ text: screen.hostLabel, tone: 'text' }], cols));
      body.push(paintPieces([{ text: formatFingerprint(screen.fingerprint), tone: 'blue' }], cols));
      body.push(blank(cols));
      body.push(paintPieces([{ text: 'This does not match the key saved for this server.', tone: 'muted' }], cols));
      body.push(blank(cols));
    }
    choices.forEach((choice, index) => {
      const selected = index === screen.choice;
      body.push(
        paintPieces(
          [
            { text: selected ? '❯ ' : '  ', tone: 'primary', bold: selected },
            { text: choice, tone: selected ? 'primary' : 'text' },
          ],
          cols,
          selected,
        ),
      );
    });
    footer = hints(['enter confirm', 'y yes', 'n no', 'esc back'], cols);
  } else if (screen.kind === 'wizard') {
    footerNote = screen.error
      ? paintPieces([{ text: truncate(screen.error, cols), tone: 'red' }], cols)
      : noticeLine(screen.notice, cols);
    footer = hints(['enter confirm', 'esc back', 'ctrl+c cancel'], cols);
    const prompt = promptFor(screen.step, screen.draft);
    body = [blank(cols), paintPieces([{ text: screen.title, tone: 'muted' }], cols), blank(cols)];
    for (const step of stepsBefore(screen.step, screen.draft)) {
      const value = stepValue(step, screen.draft);
      body.push(
        paintPieces(
          [
            { text: `  ${stepValueLabel(step)}`, tone: 'muted' },
            { text: '  ' },
            { text: truncate(value, Math.max(8, cols - 20)), tone: 'text' },
          ],
          cols,
        ),
      );
    }
    if (stepsBefore(screen.step, screen.draft).length > 0) body.push(blank(cols));
    const bracket = !prompt.masked && prompt.fallback ? ` [${prompt.fallback}]` : '';
    body.push(paintPieces([{ text: `${prompt.label}${bracket}`, tone: 'primary' }], cols));
    body.push(paintPieces([{ text: truncate(prompt.hint, cols), tone: 'muted' }], cols));
    const shownInput = prompt.masked ? '•'.repeat(screen.input.length) : screen.input;
    const prefix = '❯ ';
    const room = Math.max(1, cols - displayWidth(prefix));
    const tail = tailText(shownInput, room);
    const inputRow = body.length;
    body.push(
      paintPieces(
        [
          { text: prefix, tone: 'primary', bold: true },
          { text: tail, tone: 'text' },
        ],
        cols,
      ),
    );
    cursor = { row: 0, col: displayWidth(prefix + tail) + 1 };
    cursor.row = inputRow;
  } else {
    const browse = screen;
    footerNote = browse.transfer ? progressLine(browse.transfer, cols) : noticeLine(browse.notice, cols);
    footer = browse.transfer
      ? hints(['ctrl+c cancel transfer'], cols)
      : browse.goto !== null
        ? hints(['enter go', 'esc cancel'], cols)
        : hints([
            view.clickHint,
            'drop files to upload',
            'enter open',
            'u upload',
            'backspace up',
            'r refresh',
            'g path',
            'q disconnect',
          ], cols);
    body = [
      paintPieces(
        [
          { text: truncate(browse.title, Math.max(4, cols - displayWidth(browse.userHost) - 2)), tone: 'primary', bold: true },
          { text: '  ' },
          { text: truncate(browse.userHost, Math.max(8, cols / 2)), tone: 'muted' },
        ],
        cols,
      ),
      paintPieces([{ text: truncate(browse.cwd, cols), tone: 'blue' }], cols),
      blank(cols),
    ];
    const listHeight = Math.max(1, rows - 1 - body.length - 1 - (footerNote ? 1 : 0));
    const visible = windowed(browse.entries, browse.selected, listHeight);
    const first = visible[0];
    const offset = first ? browse.entries.indexOf(first) : 0;
    if (browse.entries.length === 0) {
      body.push(paintPieces([{ text: '  (empty)', tone: 'muted' }], cols));
    }
    visible.forEach((entry, index) => {
      const selected = offset + index === browse.selected;
      const painted = fileRow(entry, selected, cols);
      body.push(painted.line);
      if (painted.link) links.set(painted.line.plain.trimEnd(), painted.link);
    });
    if (browse.goto !== null) {
      const prefix = 'path ❯ ';
      const room = Math.max(1, cols - displayWidth(prefix));
      const tail = tailText(browse.goto, room);
      footer = paintPieces(
        [
          { text: prefix, tone: 'primary', bold: true },
          { text: tail, tone: 'text' },
        ],
        cols,
      );
      cursor = { row: rows - 1, col: displayWidth(prefix + tail) + 1 };
    }
  }

  const footerRows = [footerNote, footer].filter((line): line is PaintedLine => Boolean(line));
  const available = rows - 1 - footerRows.length;
  const keepTail = screen.kind === 'wizard' || screen.kind === 'trust' || screen.kind === 'confirm';
  const trimmedBody = body.length <= available
    ? body
    : keepTail
      ? body.slice(body.length - available)
      : body.slice(0, available);
  const lines = fit(
    [top, ...trimmedBody, ...Array.from({ length: Math.max(0, available - trimmedBody.length) }, () => blank(cols)), ...footerRows],
    rows,
    cols,
  );
  if (screen.kind === 'wizard') {
    const inputIndex = trimmedBody.findIndex((line) => line.plain.trimEnd().startsWith('❯ '));
    cursor = inputIndex >= 0 && cursor ? { row: inputIndex + 1, col: cursor.col } : undefined;
  }
  return { lines, cursor, links };
}

function stepValueLabel(step: string): string {
  if (step === 'keyPath') return 'private key';
  if (step === 'startPath') return 'remote path';
  if (step === 'jump') return 'jump host';
  return step;
}

function tailText(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let used = 0;
  let out = '';
  const chars = [...text].reverse();
  for (const char of chars) {
    const w = displayWidth(char);
    if (used + w > width) break;
    out = char + out;
    used += w;
  }
  return out;
}

function fileRow(entry: BrowseEntry, selected: boolean, cols: number): { line: PaintedLine; link?: LineLink } {
  const marker = selected ? '❯ ' : '  ';
  const name = entryName(entry);
  const right = entry.name === '..' || !entry.mtime
    ? ''
    : `${padLeft(formatSize(entry.size), 8)}  ${formatTime(entry.mtime)}`;
  const rightWidth = right ? displayWidth(right) + 2 : 0;
  const nameWidth = Math.max(1, cols - displayWidth(marker) - rightWidth);
  const shown = truncate(name, nameWidth);
  const gap = Math.max(0, cols - displayWidth(marker + shown) - displayWidth(right));
  const line = paintPieces(
    [
      { text: marker, tone: 'primary', bold: selected },
      { text: shown, tone: entry.name.startsWith('.') ? 'muted' : 'text' },
      { text: ' '.repeat(gap) },
      { text: right, tone: 'muted' },
    ],
    cols,
    selected,
  );
  const kind = entry.kind === 'file' ? 'file' : entry.kind === 'dir' || entry.name === '..' ? 'dir' : entry.kind === 'link' ? 'file' : undefined;
  if (!kind) return { line };
  return {
    line,
    link: {
      start: marker.length,
      length: shown.length,
      remotePath: entry.path,
      kind: entry.kind === 'dir' || entry.name === '..' ? 'dir' : 'file',
      tooltip: entry.kind === 'file' ? `Download ${entry.name}` : `Open ${entry.name}`,
    },
  };
}

export function paint(frame: Frame): string {
  let out = '\x1b[H\x1b[?25l';
  frame.lines.forEach((line, index) => {
    out += `\x1b[${index + 1};1H\x1b[2K${line.styled}`;
  });
  if (frame.cursor) out += `\x1b[${frame.cursor.row + 1};${frame.cursor.col}H\x1b[?25h`;
  return out;
}
