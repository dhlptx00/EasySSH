import { formatFingerprint, shortenPath, truncate, displayWidth } from '../text';
import type { BrowseEntry, Notice } from '../types';
import { assignConnectionTokens, matchSlashCommands, type SlashCommand, type SlashTarget } from './commands';
import type { Screen } from './screen';
import { choiceOptions, promptFor, stepValue, stepsBefore } from './wizard';

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
  links: Map<string, LineLink[]>;
}

export interface RenderView {
  cols: number;
  rows: number;
  downloadFolder: string;
  home: string;
}

type Tone = 'text' | 'muted' | 'primary' | 'green' | 'red' | 'blue' | 'border';

interface Piece {
  text: string;
  tone?: Tone;
  bold?: boolean;
  underline?: boolean;
}

const FG: Record<Tone, string> = {
  text: '224;224;224',
  muted: '106;106;106',
  primary: '250;178;131',
  green: '127;216;143',
  red: '224;108;117',
  blue: '92;156;245',
  border: '64;64;64',
};

// Read from package.json at build time (esbuild inlines it), so the header never goes stale.
const VERSION: string = (require('../../package.json') as { version: string }).version;
const PROMPT_BLOCK = 3;
const FRAME_GAP = 1;

/** Nearly the full terminal, with a small margin so the corners are not flush with the edge. */
function pageColumn(cols: number): { left: number; width: number } {
  const margin = cols >= 48 ? 2 : 1;
  const width = Math.min(cols, Math.max(20, cols - margin * 2));
  const left = Math.max(0, Math.floor((cols - width) / 2));
  return { left, width: Math.min(width, cols - left) };
}

/** Inner rows of a card that runs from the top of the terminal to just above the prompt. */
function frameBudget(rows: number): number {
  return Math.max(1, rows - FRAME_GAP - PROMPT_BLOCK - 2);
}

const LOGO = [
  '  ·····  ',
  ' ·     · ',
  '·   /   ·',
  ' ·     · ',
  '  ·····  ',
];

function paintPieces(pieces: Piece[], width: number, selected = false): PaintedLine {
  let plain = '';
  let styled = '';
  let used = 0;
  const open = (tone: Tone, bold: boolean, underline: boolean) => {
    const parts = ['0'];
    if (bold) parts.push('1');
    if (underline) parts.push('4');
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
    styled += open(piece.tone ?? 'text', Boolean(piece.bold), Boolean(piece.underline)) + fitted;
    used += displayWidth(fitted);
  }
  if (used < width) {
    const gap = ' '.repeat(width - used);
    plain += gap;
    if (selected) styled += open('text', false, false) + gap;
    else styled += gap;
  }
  styled += '\x1b[0m';
  return { plain, styled };
}

function blank(width: number): PaintedLine {
  return paintPieces([{ text: '' }], width);
}

function noticeLine(notice: Notice | undefined, width: number): PaintedLine | undefined {
  if (!notice) return undefined;
  const tone = notice.tone === 'error' ? 'red' : notice.tone === 'ok' ? 'green' : 'blue';
  return paintPieces([{ text: truncate(notice.text, width), tone }], width);
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

export function render(screen: Screen, view: RenderView): Frame {
  const { cols, rows } = view;
  const links = new Map<string, LineLink[]>();
  if (cols < 24 || rows < 6) {
    return {
      lines: fit([paintPieces([{ text: 'Resize the terminal', tone: 'muted' }], Math.max(cols, 1))], rows, Math.max(cols, 1)),
      links,
    };
  }

  if (screen.kind === 'connections') return renderHome(screen, view);
  return renderPanel(screen, view);
}

function stepValueLabel(step: string): string {
  if (step === 'keyPath') return 'private key';
  if (step === 'startPath' || step === 'startPathChoice') return 'remote path';
  if (step === 'jump' || step === 'jumpChoice') return 'jump host';
  return step;
}

interface PanelInput {
  text: string;
  editable: boolean;
  meta: string;
  prefix?: string;
}

function renderPanel(screen: Exclude<Screen, { kind: 'connections' }>, view: RenderView): Frame {
  const links = new Map<string, LineLink[]>();
  const contentWidth = Math.max(8, pageColumn(view.cols).width - 6);
  const budget = frameBudget(view.rows);
  let anchor: 'start' | 'end' = 'start';
  let content: PaintedLine[];
  let input: PanelInput;

  if (screen.kind === 'loading') {
    content = titled('Easy SSH', 'Loading connections…', contentWidth);
    input = { text: '', editable: false, meta: '' };
  } else if (screen.kind === 'connecting') {
    content = titled('Easy SSH', `Connecting to ${screen.label}`, contentWidth);
    input = { text: 'ctrl+c cancel', editable: false, meta: '' };
  } else if (screen.kind === 'confirm') {
    content = choiceCard(`Delete ${screen.item.name}?`, 'This removes the saved connection.', ['No', 'Yes, delete'], screen.choice, contentWidth, screen.notice);
    input = { text: 'Enter to confirm', editable: false, meta: '' };
  } else if (screen.kind === 'pick') {
    content = pickCard(screen, contentWidth, budget);
    input = { text: 'Enter to confirm', editable: false, meta: '' };
  } else if (screen.kind === 'trust') {
    content = [
      blank(contentWidth),
      paintPieces([{ text: 'Host key changed', bold: true }], contentWidth),
      paintPieces([{ text: truncate(screen.hostLabel, contentWidth), tone: 'muted' }], contentWidth),
      paintPieces([{ text: truncate(formatFingerprint(screen.fingerprint), contentWidth), tone: 'blue' }], contentWidth),
      blank(contentWidth),
      paintPieces([{ text: truncate('This does not match the key saved for this server.', contentWidth), tone: 'muted' }], contentWidth),
      blank(contentWidth),
      ...choiceRows(['No, disconnect', 'Yes, trust this key'], screen.choice, contentWidth),
      blank(contentWidth),
    ];
    input = { text: 'Enter to confirm', editable: false, meta: '' };
  } else if (screen.kind === 'wizard') {
    content = wizardCard(screen, contentWidth, budget);
    const prompt = promptFor(screen.step, screen.draft);
    if (choiceOptions(screen.step)) input = { text: 'Enter to confirm', editable: false, meta: '' };
    else {
      const shown = prompt.masked ? '•'.repeat([...screen.input].length) : screen.input;
      const meta = !shown && !prompt.masked && prompt.fallback ? `[${prompt.fallback}]` : '';
      input = { text: shown, editable: true, meta };
    }
    anchor = 'end';
  } else {
    const unreachable: never = screen;
    return unreachable;
  }

  return placePanel(content, view, input, anchor, links);
}

/** One quiet line shown above the login shell. */
/** The line shown when a shell opens. `click` is how names open, e.g. "Ctrl+click". */
export function sessionHint(click = 'Click'): { plain: string; styled: string } {
  const gold = '\x1b[38;2;250;178;131m';
  const dim = '\x1b[38;2;106;106;106m';
  const reset = '\x1b[0m';
  const parts = [
    { text: click, color: gold },
    { text: 'a file name to download', color: dim },
    { text: '·', color: dim },
    { text: 'drag files to upload', color: dim },
    { text: '·', color: dim },
    { text: 'exit', color: dim },
  ];
  return {
    plain: parts.map((part) => part.text).join(' '),
    styled: parts.map((part) => `${part.color}${part.text}${reset}`).join(' '),
  };
}

/** The file or directory under a 0-based screen column. */
export function linkAt(cells: readonly string[], column: number, entries: BrowseEntry[], downloadLabel?: string): LineLink | undefined {
  if (column < 0) return undefined;
  let text = '';
  const origin: number[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (!cell) continue;
    origin.push(index);
    text += cell;
  }
  for (const span of nameSpans(text, entries, downloadLabel)) {
    const start = origin[span.start];
    if (start === undefined) continue;
    const endChar = span.start + span.length;
    const end = endChar < origin.length ? origin[endChar] : cells.length;
    if (column >= start && column < end) return span;
  }
  return undefined;
}

export function nameSpans(plain: string, entries: BrowseEntry[], downloadLabel = 'the Desktop'): LineLink[] {
  const ranked = entries
    .filter((entry) => entry.name && entry.name !== '..' && entry.name !== '.')
    .sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));
  const taken = new Array<boolean>(plain.length).fill(false);
  const found: LineLink[] = [];
  for (const entry of ranked) {
    let from = 0;
    while (from < plain.length) {
      const at = plain.indexOf(entry.name, from);
      if (at < 0) break;
      const end = at + entry.name.length;
      const before = at === 0 || isNameBoundary(plain[at - 1], 'before');
      const after = closesName(plain, end);
      let overlap = false;
      for (let index = at; index < end; index += 1) if (taken[index]) overlap = true;
      if (before && after && !overlap) {
        for (let index = at; index < end; index += 1) taken[index] = true;
        const kind = entry.kind === 'dir' ? 'dir' : 'file';
        found.push({
          start: at,
          length: entry.name.length,
          remotePath: entry.path,
          kind,
          tooltip: kind === 'dir' ? `cd ${entry.name}` : `Download ${entry.name} to ${downloadLabel}`,
        });
      }
      from = at + Math.max(1, entry.name.length);
    }
  }
  return found;
}

function isNameBoundary(ch: string, side: 'before' | 'after'): boolean {
  if (side === 'after' && (ch === '/' || ch === '@' || ch === '*')) return true;
  return /[\s'"\\|=<>&;()[\]{},]/.test(ch);
}

/** `ls -F` markers end a name. `user@host` does not, so a prompt is not a download link. */
function closesName(plain: string, end: number): boolean {
  if (end >= plain.length) return true;
  const ch = plain[end];
  if (ch === '/' || ch === '@' || ch === '*') {
    const next = plain[end + 1];
    return next === undefined || isNameBoundary(next, 'before');
  }
  return isNameBoundary(ch, 'after');
}

function pickCard(screen: Extract<Screen, { kind: 'pick' }>, width: number, budget: number): PaintedLine[] {
  const title = screen.mode === 'edit' ? 'Edit connection' : 'Delete connection';
  const hint = screen.mode === 'edit'
    ? 'Choose a connection, then press Enter to edit it.'
    : 'Choose a connection, then press Enter to delete it.';
  const head: PaintedLine[] = [
    blank(width),
    paintPieces([{ text: title, bold: true }], width),
    paintPieces([{ text: truncate(hint, width), tone: 'muted' }], width),
  ];
  const note = noticeLine(screen.notice, width);
  if (note) head.push(note);
  head.push(blank(width));
  const listRoom = Math.max(1, budget - head.length - 1);
  const visible = windowed(screen.items, screen.selected, listRoom);
  const offset = Math.max(0, screen.items.indexOf(visible[0] ?? screen.items[0]));
  const rows = visible.map((item, index) => {
    const selected = offset + index === screen.selected;
    return paintPieces(splitLine(item.name, `${item.detail}  ${item.userHost}`, '', width, selected), width, selected);
  });
  return [...head, ...rows, blank(width)];
}

function titled(title: string, subtitle: string, width: number): PaintedLine[] {
  return [
    blank(width),
    paintPieces([{ text: title, bold: true }, { text: `  ${VERSION}`, tone: 'muted' }], width),
    blank(width),
    paintPieces([{ text: truncate(subtitle, width), tone: 'primary' }], width),
    blank(width),
  ];
}

function choiceCard(title: string, hint: string, labels: string[], pick: number, width: number, notice?: Notice): PaintedLine[] {
  const lines: PaintedLine[] = [
    blank(width),
    paintPieces([{ text: truncate(title, width), bold: true }], width),
    paintPieces([{ text: truncate(hint, width), tone: 'muted' }], width),
  ];
  const note = noticeLine(notice, width);
  if (note) lines.push(note);
  lines.push(blank(width), ...choiceRows(labels, pick, width), blank(width));
  return lines;
}

function choiceRows(labels: string[], pick: number, width: number, hints: string[] = []): PaintedLine[] {
  const selected = Math.max(0, Math.min(pick, Math.max(0, labels.length - 1)));
  const nameWidth = Math.max(1, ...labels.map((label) => displayWidth(label)));
  return labels.map((label, index) => choiceRow(label, hints[index] ?? '', index === selected, nameWidth, width));
}

function choiceRow(label: string, hint: string, selected: boolean, nameWidth: number, width: number): PaintedLine {
  const marker = selected ? '> ' : '  ';
  const padded = label + ' '.repeat(Math.max(0, nameWidth - displayWidth(label)));
  const room = Math.max(0, width - displayWidth(marker) - displayWidth(padded) - 2);
  const shown = room > 0 && hint ? truncate(hint, room) : '';
  const pieces: Piece[] = [
    { text: marker, tone: selected ? 'primary' : 'text', bold: selected },
    { text: padded, tone: 'text', bold: selected },
  ];
  if (shown) pieces.push({ text: '  ' }, { text: shown, tone: 'muted' });
  return paintPieces(pieces, width, selected);
}

function wizardCard(screen: Extract<Screen, { kind: 'wizard' }>, width: number, budget: number): PaintedLine[] {
  const prompt = promptFor(screen.step, screen.draft);
  const options = choiceOptions(screen.step);
  const title = screen.title.charAt(0).toUpperCase() + screen.title.slice(1);
  const lines: PaintedLine[] = [
    blank(width),
    paintPieces([{ text: truncate(title, width), bold: true }], width),
    paintPieces([{ text: truncate(prompt.hint, width), tone: 'muted' }], width),
  ];
  if (screen.error) lines.push(paintPieces([{ text: truncate(screen.error, width), tone: 'red' }], width));
  else {
    const note = noticeLine(screen.notice, width);
    if (note) lines.push(note);
  }
  const done = stepsBefore(screen.step, screen.draft);
  if (done.length > 0) {
    lines.push(blank(width));
    for (const step of done) {
      lines.push(paintPieces(splitLine(stepValueLabel(step), '', stepValue(step, screen.draft), width, false), width));
    }
  }
  lines.push(blank(width));
  if (options) lines.push(...choiceRows(options.map((option) => option.label), screen.pick, width, options.map((option) => option.hint)));
  else {
    const bracket = !prompt.masked && prompt.fallback ? `  [${prompt.fallback}]` : '';
    lines.push(paintPieces([
      { text: prompt.label, tone: 'primary', bold: true },
      { text: truncate(bracket, Math.max(0, width - displayWidth(prompt.label))), tone: 'muted' },
    ], width));
  }
  lines.push(blank(width));
  if (lines.length > budget) return lines.slice(lines.length - budget);
  return lines;
}

function placePanel(
  content: PaintedLine[],
  view: RenderView,
  input: PanelInput,
  anchor: 'start' | 'end',
  links: Map<string, LineLink[]>,
): Frame {
  const { cols, rows } = view;
  const { left, width } = pageColumn(cols);
  const innerWidth = width - 2;
  const contentWidth = Math.max(1, innerWidth - 4);
  const promptTop = rows - PROMPT_BLOCK;
  const cardBottom = Math.max(0, promptTop - FRAME_GAP);
  const maxInner = Math.max(1, cardBottom - 2);
  let body = content;
  if (body.length > maxInner) body = anchor === 'end' ? body.slice(body.length - maxInner) : body.slice(0, maxInner);
  else body = centerLines(body, maxInner, contentWidth);
  const paintedCard = frameCardLines(body, left, innerWidth, cols);
  const prompt = frameInput(input.text, input.editable, input.meta, left, width - 2, cols, input.prefix ?? '>');
  const lines = Array.from({ length: rows }, () => blank(cols));
  paintedCard.forEach((line, index) => {
    if (index < cardBottom && index < rows) lines[index] = line;
  });
  prompt.lines.forEach((line, index) => {
    if (promptTop + index < rows) lines[promptTop + index] = line;
  });
  const cursor = input.editable && prompt.cursorCol !== undefined ? { row: promptTop + 1, col: prompt.cursorCol } : undefined;
  return { lines, cursor, links };
}

function centerLines(lines: PaintedLine[], height: number, width: number): PaintedLine[] {
  if (lines.length >= height) return lines;
  const pad = height - lines.length;
  const top = Math.floor(pad / 2);
  const filler = () => blank(width);
  return [...Array.from({ length: top }, filler), ...lines, ...Array.from({ length: pad - top }, filler)];
}

function centerPieces(lines: Piece[][], height: number): Piece[][] {
  if (lines.length >= height) return lines;
  const pad = height - lines.length;
  const top = Math.floor(pad / 2);
  const filler = (): Piece[] => [];
  return [...Array.from({ length: top }, filler), ...lines, ...Array.from({ length: pad - top }, filler)];
}

function frameCardLines(
  content: PaintedLine[],
  left: number,
  innerWidth: number,
  cols: number,
): PaintedLine[] {
  const contentWidth = Math.max(1, innerWidth - 4);
  const lines = [rule(left, innerWidth + 2, cols, true)];
  for (const row of content) {
    const fitted = fitWidth(row, contentWidth);
    const padded = joinPainted([
      paintPieces([{ text: '  ' }], 2),
      fitted,
      paintPieces([{ text: '  ' }], 2),
    ], innerWidth);
    lines.push(boxSides(left, padded, cols));
  }
  lines.push(rule(left, innerWidth + 2, cols, false));
  return lines;
}

function fitWidth(line: PaintedLine, width: number): PaintedLine {
  const used = displayWidth(line.plain);
  if (used === width) return line;
  if (used > width) return paintPieces([{ text: truncate(line.plain.trimEnd(), width) }], width);
  const gap = ' '.repeat(width - used);
  const styled = line.styled.endsWith('\x1b[0m') ? `${line.styled.slice(0, -4)}${gap}\x1b[0m` : `${line.styled}${gap}`;
  return { plain: line.plain + gap, styled };
}

function frameInput(
  text: string,
  editable: boolean,
  meta: string,
  left: number,
  innerWidth: number,
  cols: number,
  prefixText = '>',
): { lines: PaintedLine[]; cursorCol?: number } {
  const contentWidth = Math.max(4, innerWidth - 4);
  const prefix = editable ? `${prefixText} ` : '';
  const metaText = meta && displayWidth(meta) + displayWidth(prefix) + 4 < contentWidth ? meta : '';
  const room = Math.max(0, contentWidth - displayWidth(prefix) - (metaText ? displayWidth(metaText) + 2 : 0));
  const tail = tailText(text, Math.max(room, editable ? 1 : 0));
  const gap = Math.max(metaText ? 2 : 0, contentWidth - displayWidth(prefix + tail) - displayWidth(metaText));
  const content = paintPieces([
    { text: prefix, tone: editable ? 'primary' : 'muted', bold: editable },
    { text: tail, tone: editable ? 'text' : 'muted' },
    { text: ' '.repeat(Math.max(0, gap)) },
    { text: metaText, tone: 'muted' },
  ], contentWidth);
  const padded = joinPainted([
    paintPieces([{ text: '  ' }], 2),
    content,
    paintPieces([{ text: '  ' }], 2),
  ], innerWidth);
  const line = boxSides(left, padded, cols);
  let cursorCol: number | undefined;
  if (editable) {
    const marker = prefix + tail;
    const at = line.plain.indexOf(marker);
    cursorCol = (at >= 0 ? at : 0) + displayWidth(marker) + 1;
  }
  return {
    lines: [rule(left, innerWidth + 2, cols, true), line, rule(left, innerWidth + 2, cols, false)],
    cursorCol,
  };
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

const HOME_COMMANDS: { label: string; key: string }[] = [
  { label: 'New connection', key: '/new' },
  { label: 'Edit connection', key: '/edit' },
  { label: 'Delete connection', key: '/delete' },
  { label: 'Import ~/.ssh/config', key: '/import' },
  { label: 'Quit', key: '/quit' },
];

function renderHome(screen: Extract<Screen, { kind: 'connections' }>, view: RenderView): Frame {
  const { cols, rows } = view;
  const links = new Map<string, LineLink[]>();
  const { left, width } = pageColumn(cols);
  const innerWidth = width - 2;
  const contentWidth = Math.max(8, innerWidth - 4);
  const useLogo = contentWidth >= displayWidth(LOGO[0]) + 18;
  const textInset = useLogo ? displayWidth(LOGO[0]) + 2 : 0;
  const column = Math.max(8, contentWidth - textInset);
  const tokens = assignConnectionTokens(screen.items.map((item) => ({ id: item.id, name: item.name, description: item.userHost })));
  let commands = contentWidth >= 40 ? [...HOME_COMMANDS] : HOME_COMMANDS.filter((item) => item.key !== '/import');

  const buildInner = (listLimit: number): Piece[][] => {
    const lines: Piece[][] = [[]];
    if (useLogo) {
      const beside: Piece[][] = [
        [{ text: 'Easy SSH', tone: 'text', bold: true }, { text: `  ${VERSION}`, tone: 'muted' }],
        [],
        screen.items.length === 0 ? [{ text: 'New /new', tone: 'primary', bold: true }] : [],
        [],
        [],
      ];
      LOGO.forEach((row, index) => lines.push(logoLine(row, beside[index] ?? [])));
    } else {
      lines.push([
        { text: 'Easy SSH', tone: 'text', bold: true },
        { text: `  ${VERSION}`, tone: 'muted' },
      ]);
      if (screen.items.length === 0) lines.push([{ text: 'New /new', tone: 'primary', bold: true }]);
    }
    const description = screen.items.length === 0
      ? 'Add a connection, or /import hosts from ~/.ssh/config.'
      : 'Type /name to connect. Enter uses the selected host.';
    lines.push(inset([{ text: truncate(description, column), tone: 'muted' }]));
    if (screen.notice) {
      const tone = screen.notice.tone === 'error' ? 'red' : screen.notice.tone === 'ok' ? 'green' : 'blue';
      lines.push(inset([{ text: truncate(screen.notice.text, column), tone }]));
    }
    lines.push([]);
    if (screen.items.length > 0) {
      lines.push(inset([{ text: 'Connections', tone: 'muted' }]));
      const visible = windowed(screen.items, screen.selected, Math.max(1, listLimit));
      const offset = screen.items.indexOf(visible[0] ?? screen.items[0]);
      visible.forEach((item, index) => {
        const selected = offset + index === screen.selected;
        const token = tokens.get(item.id) ?? item.name;
        lines.push(inset(splitLine(item.name, `${item.detail}  ${item.userHost}`, `/${token}`, column, selected)));
      });
      lines.push([]);
    }
    lines.push(inset([{ text: 'Commands', tone: 'muted' }]));
    for (const command of commands) {
      lines.push(inset(splitLine(command.label, '', command.key, column, false)));
    }
    lines.push([]);
    return lines;
  };

  const promptTop = rows - PROMPT_BLOCK;
  const matches = matchSlashCommands(screen.command, slashTargetsFrom(screen.items));
  const menu = matches.length > 0 ? frameMenu(matches, screen.pick, left, width - 2, cols, promptTop - FRAME_GAP) : undefined;
  const menuOpen = Boolean(menu && menu.lines.length > 0);
  const menuTop = menuOpen && menu ? promptTop - FRAME_GAP - menu.lines.length : promptTop;
  const cardBottom = menuOpen ? menuTop - FRAME_GAP : promptTop - FRAME_GAP;
  const maxInner = Math.max(1, cardBottom - 2);
  let listLimit = screen.items.length;
  let inner = buildInner(listLimit);
  while (inner.length > maxInner) {
    if (screen.items.length > 0 && listLimit > 1) listLimit -= 1;
    else if (commands.length > 3) commands = commands.slice(0, -1);
    else break;
    inner = buildInner(listLimit);
  }
  if (inner.length > maxInner) inner = inner.slice(0, maxInner);
  else inner = centerPieces(inner, maxInner);

  const card = frameCard(inner, left, innerWidth, cols);
  const prompt = framePrompt(screen.command, view, left, width - 2, cols);
  const lines = Array.from({ length: rows }, () => blank(cols));
  card.forEach((line, index) => {
    if (index < cardBottom && index < rows) lines[index] = line;
  });
  prompt.lines.forEach((line, index) => {
    if (promptTop + index < rows) lines[promptTop + index] = line;
  });
  if (menuOpen && menu) {
    menu.lines.forEach((line, index) => {
      const row = menuTop + index;
      if (row >= 0 && row < promptTop) lines[row] = line;
    });
  }
  return { lines, cursor: { row: promptTop + 1, col: prompt.cursorCol }, links };

  function inset(pieces: Piece[]): Piece[] {
    if (!textInset) return pieces;
    return [{ text: ' '.repeat(textInset) }, ...pieces];
  }
}

function logoLine(logo: string, pieces: Piece[]): Piece[] {
  return [{ text: logo, tone: 'muted' }, { text: '  ' }, ...pieces];
}

function splitLine(label: string, detail: string, right: string, width: number, selected: boolean): Piece[] {
  const detailText = detail ? `  ${detail}` : '';
  const reserve = displayWidth(detailText) + (right ? displayWidth(right) + 2 : 0);
  const name = truncate(label, Math.max(4, width - reserve));
  const gap = Math.max(right ? 2 : 0, width - displayWidth(name) - displayWidth(detailText) - displayWidth(right));
  return [
    { text: name, tone: selected ? 'primary' : 'text', bold: selected },
    { text: detailText, tone: 'muted' },
    { text: ' '.repeat(Math.max(0, gap)) },
    { text: right, tone: 'muted' },
  ];
}

function frameCard(inner: Piece[][], left: number, innerWidth: number, cols: number): PaintedLine[] {
  const contentWidth = innerWidth - 4;
  const lines = [rule(left, innerWidth + 2, cols, true)];
  for (const pieces of inner) {
    const content = paintPieces(pieces, contentWidth);
    const padded = joinPainted([
      paintPieces([{ text: '  ' }], 2),
      content,
      paintPieces([{ text: '  ' }], 2),
    ], innerWidth);
    lines.push(boxSides(left, padded, cols));
  }
  lines.push(rule(left, innerWidth + 2, cols, false));
  return lines;
}

function framePrompt(
  command: string,
  view: RenderView,
  left: number,
  innerWidth: number,
  cols: number,
): { lines: PaintedLine[]; cursorCol: number } {
  const contentWidth = Math.max(4, innerWidth - 4);
  const prefix = '> ';
  const metaBudget = Math.max(0, contentWidth - displayWidth(prefix) - 8);
  const meta = folderLabel(view.downloadFolder, view.home, metaBudget);
  const room = Math.max(1, contentWidth - displayWidth(prefix) - (meta ? displayWidth(meta) + 2 : 0));
  const tail = tailText(command, room);
  const gap = Math.max(meta ? 2 : 0, contentWidth - displayWidth(prefix + tail) - displayWidth(meta));
  const content = paintPieces([
    { text: prefix, tone: 'primary', bold: true },
    { text: tail, tone: 'text' },
    { text: ' '.repeat(Math.max(0, gap)) },
    { text: meta, tone: 'muted' },
  ], contentWidth);
  const padded = joinPainted([
    paintPieces([{ text: '  ' }], 2),
    content,
    paintPieces([{ text: '  ' }], 2),
  ], innerWidth);
  const line = boxSides(left, padded, cols);
  const marker = prefix + tail;
  const at = line.plain.indexOf(marker);
  const cursorCol = (at >= 0 ? at : 0) + displayWidth(marker) + 1;
  return {
    lines: [rule(left, innerWidth + 2, cols, true), line, rule(left, innerWidth + 2, cols, false)],
    cursorCol,
  };
}

function slashTargetsFrom(items: { id: string; name: string; userHost: string; detail: string }[]): SlashTarget[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    description: `${item.userHost} · ${item.detail}`,
  }));
}

interface MenuVisual {
  header?: string;
  command?: SlashCommand;
  commandIndex?: number;
}

function frameMenu(
  commands: SlashCommand[],
  pick: number,
  left: number,
  innerWidth: number,
  cols: number,
  maxLines: number,
): { lines: PaintedLine[] } {
  if (maxLines < 3 || commands.length === 0) return { lines: [] };
  const contentWidth = Math.max(4, innerWidth - 4);
  const selected = Math.max(0, Math.min(pick, commands.length - 1));
  const rows = menuVisuals(commands);
  const rowBudget = Math.max(1, maxLines - 2);
  let focus = rows.findIndex((row) => row.commandIndex === selected);
  if (focus < 0) focus = 0;
  let start = focus - Math.floor((rowBudget - 1) / 2);
  if (start < 0) start = 0;
  if (start > rows.length - rowBudget) start = Math.max(0, rows.length - rowBudget);
  const visible = rows.slice(start, start + rowBudget);
  const visibleCommands = visible.flatMap((row) => (row.command ? [row.command] : []));
  const nameWidth = Math.max(1, ...visibleCommands.map((command) => displayWidth(`/${command.name}`)));
  const lines = [rule(left, innerWidth + 2, cols, true)];
  for (const row of visible) {
    const active = row.commandIndex === selected;
    const content = row.header
      ? paintPieces([{ text: row.header, tone: 'muted' }], contentWidth)
      : menuRow(row.command as SlashCommand, active, nameWidth, contentWidth);
    const padded = joinPainted(
      [
        paintPieces([{ text: '  ' }], 2, active),
        content,
        paintPieces([{ text: '  ' }], 2, active),
      ],
      innerWidth,
    );
    lines.push(boxSides(left, padded, cols));
  }
  lines.push(rule(left, innerWidth + 2, cols, false));
  return { lines };
}

function menuVisuals(commands: SlashCommand[]): MenuVisual[] {
  const rows: MenuVisual[] = [];
  let group: SlashCommand['group'] | '' = '';
  commands.forEach((command, index) => {
    if (command.group !== group) {
      group = command.group;
      rows.push({ header: group === 'connection' ? 'Connections' : 'Commands' });
    }
    rows.push({ command, commandIndex: index });
  });
  return rows;
}

function menuRow(command: SlashCommand, selected: boolean, nameWidth: number, width: number): PaintedLine {
  const marker = selected ? '> ' : '  ';
  const name = `/${command.name}`;
  const paddedName = name + ' '.repeat(Math.max(0, nameWidth - displayWidth(name)));
  const descRoom = Math.max(0, width - displayWidth(marker) - displayWidth(paddedName) - 2);
  const desc = descRoom > 0 ? truncate(command.description, descRoom) : '';
  const pieces: Piece[] = [
    { text: marker, tone: selected ? 'primary' : 'text', bold: selected },
    { text: paddedName, tone: 'text', bold: selected },
  ];
  if (desc) pieces.push({ text: '  ' }, { text: desc, tone: 'muted' });
  return paintPieces(pieces, width, selected);
}

function folderLabel(folder: string, home: string, budget: number): string {
  const prefix = 'download → ';
  if (budget < displayWidth(prefix) + 4) return '';
  return prefix + shortenPath(folder, home, budget - displayWidth(prefix));
}

function rule(left: number, width: number, cols: number, top: boolean): PaintedLine {
  const bar = (top ? '╭' : '╰') + '─'.repeat(Math.max(0, width - 2)) + (top ? '╮' : '╯');
  return paintPieces([
    { text: ' '.repeat(left) },
    { text: bar, tone: 'border' },
  ], cols);
}

function boxSides(left: number, inner: PaintedLine, cols: number): PaintedLine {
  const lead = paintPieces([
    { text: ' '.repeat(left) },
    { text: '│', tone: 'border' },
  ], left + 1);
  const edge = paintPieces([{ text: '│', tone: 'border' }], 1);
  return joinPainted([lead, inner, edge], cols);
}

function joinPainted(parts: PaintedLine[], cols: number): PaintedLine {
  let plain = '';
  let styled = '';
  for (const part of parts) {
    plain += part.plain;
    styled += part.styled.endsWith('\x1b[0m') ? part.styled.slice(0, -4) : part.styled;
  }
  const gap = cols - displayWidth(plain);
  if (gap > 0) {
    const spaces = ' '.repeat(gap);
    plain += spaces;
    styled += spaces;
  }
  return { plain, styled: `${styled}\x1b[0m` };
}

export function paint(frame: Frame): string {
  let out = '\x1b[H\x1b[?25l';
  frame.lines.forEach((line, index) => {
    out += `\x1b[${index + 1};1H\x1b[2K${line.styled}`;
  });
  if (frame.cursor) out += `\x1b[${frame.cursor.row + 1};${frame.cursor.col}H\x1b[?25h`;
  return out;
}
