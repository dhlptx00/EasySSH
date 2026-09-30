import { formatFingerprint, formatSize, formatTime, padLeft, shortenPath, truncate, displayWidth } from '../text';
import type { BrowseEntry, Notice, TransferState } from '../types';
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
  links: Map<string, LineLink>;
}

export interface RenderView {
  cols: number;
  rows: number;
  downloadFolder: string;
  home: string;
  clickHint: string;
}

type Tone = 'text' | 'muted' | 'primary' | 'green' | 'red' | 'blue' | 'border';

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
  border: '64;64;64',
};

const VERSION = '0.1.0';

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

  if (screen.kind === 'connections') return renderHome(screen, view);
  return renderPanel(screen, view);
}

function stepValueLabel(step: string): string {
  if (step === 'keyPath') return 'private key';
  if (step === 'startPath' || step === 'startPathChoice') return 'remote path';
  if (step === 'jump' || step === 'jumpChoice') return 'jump host';
  return step;
}

interface RowLink {
  needle: string;
  remotePath: string;
  kind: 'file' | 'dir';
  tooltip: string;
}

interface PanelInput {
  text: string;
  editable: boolean;
  meta: string;
}

function renderPanel(screen: Exclude<Screen, { kind: 'connections' }>, view: RenderView): Frame {
  const links = new Map<string, LineLink>();
  const cardWidth = Math.min(72, Math.max(20, view.cols - 8));
  const innerWidth = cardWidth - 2;
  const contentWidth = Math.max(8, innerWidth - 4);
  const budget = panelBudget(view.rows);
  let rowLinks: (RowLink | undefined)[] | undefined;
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
    const built = browseCard(screen, view, contentWidth, budget);
    content = built.lines;
    rowLinks = built.rowLinks;
    if (screen.transfer) input = { text: 'ctrl+c cancel', editable: false, meta: '' };
    else if (screen.goto !== null) input = { text: screen.goto, editable: true, meta: shortenPath(screen.cwd, view.home, 24) };
    else input = { text: 'g path', editable: false, meta: shortenPath(screen.cwd, view.home, 40) };
  }

  return placePanel(content, rowLinks, view, input, anchor, links);
}

function panelBudget(rows: number): number {
  const top = rows >= 30 ? 2 : 1;
  return Math.max(4, rows - top - 1 - 3 - 2);
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

function browseCard(
  screen: Extract<Screen, { kind: 'browse' }>,
  view: RenderView,
  width: number,
  budget: number,
): { lines: PaintedLine[]; rowLinks: (RowLink | undefined)[] } {
  const lines: PaintedLine[] = [
    blank(width),
    paintPieces([{ text: truncate(screen.title, width), bold: true }], width),
    paintPieces([{ text: truncate(screen.userHost, width), tone: 'muted' }], width),
    paintPieces([{ text: truncate(screen.cwd, width), tone: 'blue' }], width),
    paintPieces([{ text: truncate(`${view.clickHint}   drop files to upload`, width), tone: 'muted' }], width),
  ];
  if (screen.transfer) lines.push(progressLine(screen.transfer, width));
  else {
    const note = noticeLine(screen.notice, width);
    if (note) lines.push(note);
  }
  lines.push(blank(width));
  const listHeight = Math.max(1, budget - lines.length - 1);
  const visible = windowed(screen.entries, screen.selected, listHeight);
  const offset = visible[0] ? screen.entries.indexOf(visible[0]) : 0;
  const rowLinks: (RowLink | undefined)[] = lines.map(() => undefined);
  if (screen.entries.length === 0) {
    lines.push(paintPieces([{ text: '(empty)', tone: 'muted' }], width));
    rowLinks.push(undefined);
  }
  visible.forEach((entry, index) => {
    const selected = offset + index === screen.selected;
    const painted = fileRow(entry, selected, width);
    lines.push(painted.line);
    rowLinks.push(painted.link ? {
      needle: painted.shown,
      remotePath: painted.link.remotePath,
      kind: painted.link.kind,
      tooltip: painted.link.tooltip,
    } : undefined);
  });
  lines.push(blank(width));
  rowLinks.push(undefined);
  return { lines, rowLinks };
}

function placePanel(
  content: PaintedLine[],
  rowLinks: (RowLink | undefined)[] | undefined,
  view: RenderView,
  input: PanelInput,
  anchor: 'start' | 'end',
  links: Map<string, LineLink>,
): Frame {
  const { cols, rows } = view;
  const cardWidth = Math.min(72, Math.max(20, cols - 8));
  const cardLeft = Math.max(0, Math.floor((cols - cardWidth) / 2));
  const innerWidth = cardWidth - 2;
  const promptWidth = Math.min(cols - 2, Math.max(cardWidth, Math.min(cols - 4, cardWidth + 8)));
  const promptLeft = Math.max(0, Math.floor((cols - promptWidth) / 2));
  const promptBlock = 3;
  const top = rows >= 30 ? 2 : 1;
  const gap = 1;
  const maxInner = Math.max(1, rows - top - gap - promptBlock - 2);
  let body = content;
  let linksForRows = rowLinks ?? content.map(() => undefined);
  if (body.length > maxInner) {
    body = anchor === 'end' ? body.slice(body.length - maxInner) : body.slice(0, maxInner);
    linksForRows = anchor === 'end' ? linksForRows.slice(linksForRows.length - maxInner) : linksForRows.slice(0, maxInner);
  }
  const card = frameCardLines(body, linksForRows, cardLeft, innerWidth, cols, links);
  const prompt = frameInput(input.text, input.editable, input.meta, promptLeft, promptWidth - 2, cols);
  const lines = Array.from({ length: rows }, () => blank(cols));
  const room = Math.max(0, rows - promptBlock - gap);
  const cardTop = Math.min(top, Math.max(0, room - card.length));
  card.forEach((line, index) => {
    const row = cardTop + index;
    if (row >= 0 && row < room) lines[row] = line;
  });
  const promptTop = rows - promptBlock;
  prompt.lines.forEach((line, index) => {
    if (promptTop + index < rows) lines[promptTop + index] = line;
  });
  const cursor = input.editable && prompt.cursorCol !== undefined ? { row: promptTop + 1, col: prompt.cursorCol } : undefined;
  return { lines, cursor, links };
}

function frameCardLines(
  content: PaintedLine[],
  rowLinks: (RowLink | undefined)[],
  left: number,
  innerWidth: number,
  cols: number,
  links: Map<string, LineLink>,
): PaintedLine[] {
  const contentWidth = Math.max(1, innerWidth - 4);
  const lines = [rule(left, innerWidth + 2, cols, true)];
  content.forEach((row, index) => {
    const fitted = fitWidth(row, contentWidth);
    const padded = joinPainted([
      paintPieces([{ text: '  ' }], 2),
      fitted,
      paintPieces([{ text: '  ' }], 2),
    ], innerWidth);
    const full = boxSides(left, padded, cols);
    lines.push(full);
    const link = rowLinks[index];
    if (!link) return;
    const at = full.plain.indexOf(link.needle);
    if (at < 0) return;
    links.set(full.plain.trimEnd(), {
      start: at,
      length: link.needle.length,
      remotePath: link.remotePath,
      kind: link.kind,
      tooltip: link.tooltip,
    });
  });
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
): { lines: PaintedLine[]; cursorCol?: number } {
  const contentWidth = Math.max(4, innerWidth - 4);
  const prefix = editable ? '> ' : '';
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

function fileRow(entry: BrowseEntry, selected: boolean, cols: number): { line: PaintedLine; shown: string; link?: LineLink } {
  const marker = selected ? '> ' : '  ';
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
  if (!kind) return { line, shown };
  return {
    line,
    shown,
    link: {
      start: marker.length,
      length: shown.length,
      remotePath: entry.path,
      kind: entry.kind === 'dir' || entry.name === '..' ? 'dir' : 'file',
      tooltip: entry.kind === 'file' ? `Download ${entry.name}` : `Open ${entry.name}`,
    },
  };
}

const HOME_COMMANDS: { label: string; key: string }[] = [
  { label: 'New connection', key: '/new' },
  { label: 'Edit selected', key: '/edit' },
  { label: 'Delete selected', key: '/delete' },
  { label: 'Import ~/.ssh/config', key: '/import' },
  { label: 'Quit', key: '/quit' },
];

function renderHome(screen: Extract<Screen, { kind: 'connections' }>, view: RenderView): Frame {
  const { cols, rows } = view;
  const links = new Map<string, LineLink>();
  const cardWidth = Math.min(72, Math.max(20, cols - 8));
  const cardLeft = Math.max(0, Math.floor((cols - cardWidth) / 2));
  const innerWidth = cardWidth - 2;
  const contentWidth = Math.max(8, innerWidth - 4);
  const promptWidth = Math.min(cols - 2, Math.max(cardWidth, Math.min(cols - 4, cardWidth + 8)));
  const promptLeft = Math.max(0, Math.floor((cols - promptWidth) / 2));
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

  const promptBlock = 3;
  let top = rows >= 36 ? 4 : rows >= 26 ? 2 : 1;
  let gap = 2;
  const maxInner = () => Math.max(4, rows - top - gap - promptBlock - 2);
  let listLimit = screen.items.length;
  let inner = buildInner(listLimit);
  while (inner.length > maxInner()) {
    if (screen.items.length > 0 && listLimit > 1) listLimit -= 1;
    else if (gap > 1) gap -= 1;
    else if (top > 0) top -= 1;
    else if (commands.length > 3) commands = commands.slice(0, -1);
    else break;
    inner = buildInner(listLimit);
  }
  if (inner.length > maxInner()) inner = inner.slice(inner.length - maxInner());

  const card = frameCard(inner, cardLeft, innerWidth, cols);
  const prompt = framePrompt(screen.command, view, promptLeft, promptWidth - 2, cols);
  const lines = Array.from({ length: rows }, () => blank(cols));
  const room = Math.max(0, rows - promptBlock - gap);
  const cardTop = Math.min(top, Math.max(0, room - card.length));
  card.forEach((line, index) => {
    const row = cardTop + index;
    if (row >= 0 && row < room) lines[row] = line;
  });
  const promptTop = rows - promptBlock;
  prompt.lines.forEach((line, index) => {
    lines[promptTop + index] = line;
  });
  const matches = matchSlashCommands(screen.command, slashTargetsFrom(screen.items));
  if (matches.length > 0) {
    const menuGap = 1;
    const menu = frameMenu(matches, screen.pick, promptLeft, promptWidth - 2, cols, promptTop - menuGap);
    const menuTop = promptTop - menuGap - menu.lines.length;
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
