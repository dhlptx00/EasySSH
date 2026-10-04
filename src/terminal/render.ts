import { formatFingerprint, relativeTime, shortenPath, truncate, displayWidth } from '../text';
import type { RowAnchor } from './viewport';
import { classifyName } from '../fileTypes';
import type { BrowseEntry, Notice } from '../types';
import { assignConnectionTokens, matchSlashCommands, type SlashCommand, type SlashTarget } from './commands';
import { SUMMARY_ACTIONS, type ConnectionItem, type Screen, type SummaryAction } from './screen';
import { colorCode, DEFAULT_THEME, mix, type PaintTheme, type Rgb, type Role } from './theme';
import {
  choiceOptions,
  FIELDS,
  fieldTitle,
  fieldValue,
  promptFor,
  sshCommand,
  stepHelp,
  stepPosition,
  stepsBefore,
  stepTitle,
  stepValue,
} from './wizard';

export interface LineLink {
  start: number;
  length: number;
  remotePath: string;
  kind: 'file' | 'dir';
  tooltip: string;
  /**
   * The viewport rows that showed this line when the link was offered. A click
   * checks them, because VS Code can keep a link after the row's text changed.
   */
  anchors?: RowAnchor[];
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
  /** Palette and color depth. Easy SSH Dark in truecolor when unset. */
  theme?: PaintTheme;
  /** Clock for "2 h ago". */
  now?: number;
  /** Which tip the home prompt shows; the app moves it on every visit. */
  tip?: number;
  /** How a name opens in a session, e.g. "Ctrl+click". */
  click?: string;
}

type Tone = Role;
/** The background of a row or a piece: the Easy SSH panel, the selection bar, or the terminal's own. */
type Fill = 'panel' | 'none' | 'select' | 'danger';

interface Piece {
  text: string;
  tone?: Tone;
  bold?: boolean;
  underline?: boolean;
  /** An exact color, e.g. for the brand badge gradient. */
  fg?: Rgb;
  bg?: Rgb;
  /** Overrides the row's fill for this piece (a selected option inside an input box). */
  fill?: Fill;
}

/** One row inside a card. */
interface Row {
  pieces: Piece[];
  fill?: Fill;
  /** Column of the text cursor inside the row's content. */
  cursor?: number;
  /** Rows a short terminal may leave out (spacing, secondary details). */
  optional?: boolean;
}

// Read from package.json at build time (esbuild inlines it), so the header never goes stale.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const VERSION: string = (require('../../package.json') as { version: string }).version;
const PROMPT_BLOCK = 3;
const FRAME_GAP = 1;
const BADGE_WIDTH = 7;

/** The palette of the frame being drawn. render() sets it; drawing is synchronous. */
let current: PaintTheme = DEFAULT_THEME;

/** Nearly the full terminal, with a small margin so the corners are not flush with the edge. */
function pageColumn(cols: number): { left: number; width: number } {
  const margin = cols >= 48 ? 2 : 1;
  const width = Math.min(cols, Math.max(20, cols - margin * 2));
  const left = Math.max(0, Math.floor((cols - width) / 2));
  return { left, width: Math.min(width, cols - left) };
}

function fillColor(fill: Fill): Rgb | undefined {
  const palette = current.palette;
  if (fill === 'panel') return palette.panel;
  if (fill === 'select') return palette.selection;
  if (fill === 'danger') return palette.danger;
  return undefined;
}

function toneColor(tone: Tone, fill: Fill): Rgb {
  const palette = current.palette;
  if (fill === 'select' || fill === 'danger') {
    return tone === 'muted' || tone === 'border' ? palette.fg.selMuted : palette.fg.selText;
  }
  return palette.fg[tone];
}

function sgr(fg: Rgb, bg: Rgb | undefined, bold: boolean, underline: boolean): string {
  const parts = ['0'];
  if (bold) parts.push('1');
  if (underline) parts.push('4');
  parts.push(colorCode(fg, current.depth, 'fg'));
  if (bg) parts.push(colorCode(bg, current.depth, 'bg'));
  return `\x1b[${parts.join(';')}m`;
}

function paintPieces(pieces: Piece[], width: number, fill: Fill = 'panel'): PaintedLine {
  let plain = '';
  let styled = '';
  let used = 0;
  for (const piece of pieces) {
    if (!piece.text || used >= width) continue;
    const room = width - used;
    // truncate adds an ellipsis only when the piece itself does not fit.
    const fitted = displayWidth(piece.text) <= room ? piece.text : truncate(piece.text, room);
    const pieceFill = piece.fill ?? fill;
    const fg = piece.fg ?? toneColor(piece.tone ?? 'text', pieceFill);
    const bg = piece.bg ?? fillColor(pieceFill);
    plain += fitted;
    styled += sgr(fg, bg, Boolean(piece.bold), Boolean(piece.underline)) + fitted;
    used += displayWidth(fitted);
  }
  if (used < width) {
    const gap = ' '.repeat(width - used);
    plain += gap;
    const bg = fillColor(fill);
    styled += bg ? sgr(toneColor('text', fill), bg, false, false) + gap : `\x1b[0m${gap}`;
  }
  styled += '\x1b[0m';
  return { plain, styled };
}

/** A row outside every box: the terminal's own background. */
function bare(width: number): PaintedLine {
  return paintPieces([], width, 'none');
}

function blankRow(optional = true): Row {
  return { pieces: [], optional };
}

function textRow(text: string, tone: Tone = 'text', bold = false, optional = false): Row {
  return { pieces: [{ text, tone, bold }], optional };
}

function noticeRow(notice: Notice | undefined): Row | undefined {
  if (!notice) return undefined;
  const tone: Tone = notice.tone === 'error' ? 'error' : notice.tone === 'ok' ? 'success' : 'info';
  const mark = notice.tone === 'error' ? '✗ ' : notice.tone === 'ok' ? '✓ ' : '› ';
  return { pieces: [{ text: mark, tone, bold: true }, { text: notice.text, tone }] };
}

function windowed<T>(items: T[], selected: number, height: number): T[] {
  if (height <= 0) return [];
  if (items.length <= height) return items;
  let start = selected - Math.floor((height - 1) / 2);
  if (start < 0) start = 0;
  if (start > items.length - height) start = items.length - height;
  return items.slice(start, start + height);
}

/**
 * Fit rows into a card: leave out optional rows from the end first, then keep
 * a window around the focused row (the cursor or the selection).
 */
function squeeze(rows: Row[], budget: number, anchor: 'start' | 'end' = 'start'): Row[] {
  let out = rows.slice();
  for (let index = out.length - 1; index >= 0 && out.length > budget; index -= 1) {
    if (out[index].optional) out.splice(index, 1);
  }
  if (out.length <= budget) return out;
  let focus = out.findIndex((row) => row.cursor !== undefined || row.fill === 'select' || row.fill === 'danger');
  if (focus < 0) focus = anchor === 'end' ? out.length - 1 : 0;
  let start = anchor === 'end' ? out.length - budget : 0;
  if (focus < start) start = focus;
  if (focus >= start + budget) start = focus - budget + 1;
  out = out.slice(start, start + budget);
  return out;
}

/**
 * The line shown when a shell opens. `click` is how names open, e.g. "Ctrl+click".
 * `menu` when a click opens the action menu instead of downloading.
 */
export function sessionHint(click = 'Click', menu = false, theme: PaintTheme = DEFAULT_THEME): { plain: string; styled: string } {
  const accent = `\x1b[${colorCode(theme.palette.fg.accent, theme.depth, 'fg')}m`;
  const dim = `\x1b[${colorCode(theme.palette.fg.muted, theme.depth, 'fg')}m`;
  const reset = '\x1b[0m';
  const parts = [
    { text: click, color: accent },
    { text: menu ? 'a file or folder name to download, open, rename or delete it' : 'a file or folder name to download it', color: dim },
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

export function render(screen: Screen, view: RenderView): Frame {
  current = view.theme ?? DEFAULT_THEME;
  const { cols, rows } = view;
  const links = new Map<string, LineLink[]>();
  if (cols < 24 || rows < 6) {
    const width = Math.max(cols, 1);
    const lines = [paintPieces([{ text: 'Resize the terminal', tone: 'muted' }], width, 'none')];
    while (lines.length < rows) lines.push(bare(width));
    return { lines: lines.slice(0, Math.max(rows, 1)), links };
  }
  if (screen.kind === 'connections') return renderHome(screen, view);
  return renderPanel(screen, view);
}

interface PanelInput {
  text: string;
  editable: boolean;
  meta: string;
  prefix?: string;
  /** Key hints shown instead of text: [key, what it does]. */
  hints?: [string, string][];
}

interface PanelLayout {
  rows: Row[];
  input: PanelInput;
  anchor: 'start' | 'end' | 'center';
  border?: Tone;
}

function hintInput(hints: [string, string][]): PanelInput {
  return { text: '', editable: false, meta: '', hints };
}

function renderPanel(screen: Exclude<Screen, { kind: 'connections' }>, view: RenderView): Frame {
  const width = Math.max(8, pageColumn(view.cols).width - 6);
  const layout = panelLayout(screen, view, width);
  return placePanel(layout, view);
}

function panelLayout(screen: Exclude<Screen, { kind: 'connections' }>, view: RenderView, width: number): PanelLayout {
  if (screen.kind === 'loading') {
    return { rows: brandBlock(width, 'Loading connections…'), input: { text: '', editable: false, meta: '' }, anchor: 'center' };
  }
  if (screen.kind === 'connecting') {
    return {
      rows: brandBlock(width, `${screen.title ?? 'Connecting to'} ${screen.label}…`),
      input: hintInput([['Ctrl+C', 'Cancel']]),
      anchor: 'center',
    };
  }
  if (screen.kind === 'confirm') return { ...deleteCard(screen), anchor: 'center', border: 'error' };
  if (screen.kind === 'pick') return { rows: pickCard(screen, width, view), input: hintInput([['↑↓', 'Choose'], ['Enter', screen.mode === 'edit' ? 'Edit' : 'Delete'], ['Esc', 'Back']]), anchor: 'start' };
  if (screen.kind === 'trust') {
    const q = screen.question;
    const changed = q.kind === 'changed';
    const rows: Row[] = [
      blankRow(),
      textRow(changed ? 'Host key changed' : 'New server: check its host key', changed ? 'error' : 'accent', true),
      textRow(q.via ? `${q.hostLabel} via ${q.via}` : q.hostLabel, 'muted'),
      blankRow(),
    ];
    if (changed && q.previous) {
      rows.push(
        { pieces: [{ text: 'saved  ', tone: 'muted' }, { text: formatFingerprint(q.previous), tone: 'muted' }] },
        { pieces: [{ text: 'now    ', tone: 'muted' }, { text: formatFingerprint(q.fingerprint), tone: 'info' }] },
      );
    } else rows.push(textRow(formatFingerprint(q.fingerprint), 'info'));
    rows.push(
      blankRow(),
      textRow(changed
        ? 'This is not the key saved for this server. It may have been reinstalled, or someone may be intercepting the connection.'
        : 'Compare it with the server (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) or ask its admin.', 'muted'),
      blankRow(),
      ...choiceRows(['No, disconnect', changed ? 'Yes, trust the new key' : 'Yes, trust and connect'], screen.choice, width),
      blankRow(),
    );
    return { rows, input: hintInput([['Enter', 'Confirm'], ['y / n', 'Answer'], ['Esc', 'Cancel']]), anchor: 'center', border: changed ? 'error' : undefined };
  }
  if (screen.kind === 'ask') {
    const request = screen.request;
    const rows: Row[] = [blankRow(), textRow(request.title, 'accent', true), textRow(screen.label, 'muted')];
    for (const line of (request.detail ?? '').split(/\r?\n/).filter(Boolean).slice(0, 6)) rows.push(textRow(line, 'accent2'));
    rows.push(blankRow());
    if (request.save !== undefined) {
      rows.push({ pieces: [{ text: screen.save ? '[x] ' : '[ ] ', tone: 'accent', bold: true }, { text: 'Save the password in the editor secret storage' }, { text: '  Tab', tone: 'muted' }] }, blankRow());
    }
    if (request.hint) rows.push(textRow(request.hint, 'muted'), blankRow());
    const shown = request.masked ? '•'.repeat([...screen.input].length) : screen.input;
    return { rows, input: { text: shown, editable: true, meta: 'Enter OK · Esc Cancel' }, anchor: 'end' };
  }
  if (screen.kind === 'lost') {
    const rows: Row[] = [blankRow(), textRow(`Connection to ${screen.name} lost`, 'text', true), textRow(screen.reason, 'error'), blankRow()];
    if (screen.retryIn !== undefined) rows.push(textRow(`Reconnecting in ${screen.retryIn} s…`, 'accent'), blankRow());
    rows.push(...choiceRows(['Reconnect', 'Back to the list'], screen.choice, width), blankRow());
    return { rows, input: hintInput([['Enter', 'Choose'], ['Esc', 'List']]), anchor: 'center' };
  }
  if (screen.kind === 'wizard') return wizardCard(screen, width, view);
  if (screen.kind === 'summary') return summaryCard(screen, width, view);
  const unreachable: never = screen;
  return unreachable;
}

/** The small brand row and a status line, for loading and connecting. */
function brandBlock(width: number, status: string): Row[] {
  return [blankRow(false), ...brandMark(width, [[{ text: status, tone: 'accent' }]]), blankRow(false)];
}

function pickCard(screen: Extract<Screen, { kind: 'pick' }>, width: number, view: RenderView): Row[] {
  const edit = screen.mode === 'edit';
  const rows: Row[] = [
    blankRow(),
    { pieces: [{ text: edit ? 'Edit connection' : 'Delete connection', tone: edit ? 'accent' : 'error', bold: true }] },
    textRow(edit ? 'Choose a connection, then pick the field to change.' : 'Choose a connection to delete. You confirm on the next screen.', 'muted'),
  ];
  const note = noticeRow(screen.notice);
  if (note) rows.push(note);
  rows.push(blankRow());
  rows.push(...connectionTable(screen.items, screen.selected, new Map(), width, screen.items.length, view.now ?? Date.now(), false));
  rows.push(blankRow());
  return rows;
}

function deleteCard(screen: Extract<Screen, { kind: 'confirm' }>): Omit<PanelLayout, 'anchor'> {
  const item = screen.item;
  const rows: Row[] = [
    blankRow(),
    { pieces: [{ text: '✗ ', tone: 'error', bold: true }, { text: `Delete ${item.name}?`, tone: 'error', bold: true }] },
    blankRow(),
    { pieces: [{ text: 'Host      ', tone: 'muted' }, { text: item.userHost, bold: true }] },
    { pieces: [{ text: 'Sign-in   ', tone: 'muted' }, { text: authWord(item), tone: authTone(item) }, { text: item.via ? ` via ${item.via}` : '', tone: 'muted' }] },
    blankRow(),
    textRow('This removes the saved connection and its stored password or passphrase. It cannot be undone.', 'muted'),
  ];
  const note = noticeRow(screen.notice);
  if (note) rows.push(note);
  rows.push(blankRow());
  const selected = Math.max(0, Math.min(1, screen.choice));
  rows.push(
    optionRow('No, keep it', 'Esc', selected === 0, 12, 'select'),
    optionRow('Yes, delete', 'y', selected === 1, 12, 'danger'),
    blankRow(),
  );
  return { rows, input: hintInput([['↑↓', 'Choose'], ['Enter', 'Confirm'], ['y / n', 'Answer']]), border: 'error' };
}

function choiceRows(labels: string[], pick: number, _width: number, hints: string[] = []): Row[] {
  const selected = Math.max(0, Math.min(pick, Math.max(0, labels.length - 1)));
  const nameWidth = Math.max(1, ...labels.map((label) => displayWidth(label)));
  return labels.map((label, index) => optionRow(label, hints[index] ?? '', index === selected, nameWidth, 'select'));
}

function optionRow(label: string, hint: string, selected: boolean, nameWidth: number, bar: Fill): Row {
  const padded = label + ' '.repeat(Math.max(0, nameWidth - displayWidth(label)));
  const pieces: Piece[] = [
    { text: selected ? '› ' : '  ', tone: 'accent', bold: true },
    { text: padded, tone: bar === 'danger' && !selected ? 'error' : 'text', bold: selected },
  ];
  if (hint) pieces.push({ text: '  ' }, { text: hint, tone: 'muted' });
  return { pieces, fill: selected ? bar : 'panel' };
}

/** A box drawn inside a card: a titled border, its rows, and the bottom border. */
function innerBox(title: string, body: Row[], width: number, tone: Tone): Row[] {
  const inner = Math.max(4, width - 2);
  const label = title ? `─ ${title} ` : '';
  const top: Row = {
    pieces: [
      { text: '╭', tone },
      { text: truncate(label, inner), tone, bold: true },
      { text: '─'.repeat(Math.max(0, inner - displayWidth(truncate(label, inner)))), tone },
      { text: '╮', tone },
    ],
  };
  const rows: Row[] = [top];
  for (const row of body) {
    const fill = row.fill ?? 'panel';
    const content: Piece[] = [{ text: ' ', fill }, ...row.pieces.map((piece) => ({ ...piece, fill: piece.fill ?? fill }))];
    const used = content.reduce((sum, piece) => sum + displayWidth(piece.text), 0);
    const fitted = used > inner ? clipPieces(content, inner) : [...content, { text: ' '.repeat(inner - used), fill }];
    rows.push({
      pieces: [{ text: '│', tone }, ...fitted, { text: '│', tone }],
      cursor: row.cursor !== undefined ? row.cursor + 2 : undefined,
    });
  }
  rows.push({ pieces: [{ text: `╰${'─'.repeat(inner)}╯`, tone }] });
  return rows;
}

/** Pieces cut to a width, with an ellipsis in the last one. */
function clipPieces(pieces: Piece[], width: number): Piece[] {
  const out: Piece[] = [];
  let used = 0;
  for (const piece of pieces) {
    const room = width - used;
    if (room <= 0) break;
    const w = displayWidth(piece.text);
    if (w <= room) {
      out.push(piece);
      used += w;
    } else {
      out.push({ ...piece, text: truncate(piece.text, room) });
      used = width;
    }
  }
  return out;
}

function tailText(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let used = 0;
  let out = '';
  for (const char of [...text].reverse()) {
    const w = displayWidth(char);
    if (used + w > width) break;
    out = char + out;
    used += w;
  }
  return out;
}

function progressBar(index: number, total: number, width: number): Piece[] {
  const size = Math.max(8, Math.min(width, 36));
  const done = Math.max(1, Math.round((index / Math.max(1, total)) * size));
  return [
    { text: '━'.repeat(done), tone: 'accent2' },
    { text: '─'.repeat(Math.max(0, size - done)), tone: 'border' },
  ];
}

function headerRow(title: string, right: string, width: number, tone: Tone = 'accent'): Row {
  const room = Math.max(1, width - displayWidth(right) - 2);
  const shown = truncate(title, room);
  const gap = Math.max(2, width - displayWidth(shown) - displayWidth(right));
  return { pieces: [{ text: shown, tone, bold: true }, { text: ' '.repeat(gap) }, { text: right, tone: 'muted' }] };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function wizardCard(screen: Extract<Screen, { kind: 'wizard' }>, width: number, view: RenderView): PanelLayout {
  const prompt = promptFor(screen.step, screen.draft);
  const options = choiceOptions(screen.step);
  const position = stepPosition(screen.step, screen.draft, screen.field);
  const title = screen.field ? `${capitalize(screen.title)} · ${fieldTitle(screen.field)}` : capitalize(screen.title);
  const stepText = `Step ${position.index} of ${position.total}`;
  const rows: Row[] = [
    blankRow(),
    headerRow(title, stepText, width),
    { pieces: progressBar(position.index, position.total, width), optional: true },
    blankRow(),
  ];
  const boxTone: Tone = screen.error ? 'error' : 'accent';
  if (options) {
    const nameWidth = Math.max(...options.map((option) => displayWidth(option.label)));
    const pick = Math.max(0, Math.min(screen.pick, options.length - 1));
    const body: Row[] = options.map((option, index) => {
      const selected = index === pick;
      const padded = option.label + ' '.repeat(Math.max(0, nameWidth - displayWidth(option.label)));
      return {
        pieces: [
          { text: selected ? '› ' : '  ', tone: 'accent', bold: true },
          { text: padded, bold: selected },
          { text: '  ' },
          { text: option.hint, tone: 'muted' },
        ],
        fill: selected ? 'select' : 'panel',
      };
    });
    rows.push(...innerBox(stepTitle(screen.step), body, width, boxTone));
  } else {
    const shown = prompt.masked ? '•'.repeat([...screen.input].length) : screen.input;
    const room = Math.max(1, width - 5);
    const tail = tailText(shown, room);
    const placeholder = !shown && !prompt.masked && prompt.fallback ? prompt.fallback : '';
    const body: Row = {
      pieces: tail ? [{ text: tail, bold: true }] : [{ text: placeholder, tone: 'muted' }],
      cursor: displayWidth(tail),
    };
    rows.push(...innerBox(stepTitle(screen.step), [body], width, boxTone));
  }
  rows.push({ pieces: [{ text: ' ' }, { text: stepHelp(screen.step, screen.draft), tone: 'muted' }] });
  if (screen.error) rows.push({ pieces: [{ text: ' ✗ ', tone: 'error', bold: true }, { text: screen.error, tone: 'error', bold: true }] });
  else {
    const note = noticeRow(screen.notice);
    if (note) rows.push(note);
  }
  if (!screen.field) {
    const done = stepsBefore(screen.step, screen.draft).filter((step) => step !== 'passwordMode' && step !== 'jumpChoice');
    if (done.length > 0) {
      rows.push(blankRow());
      const pieces: Piece[] = [{ text: 'So far  ', tone: 'muted' }];
      done.forEach((step, index) => {
        if (index > 0) pieces.push({ text: ' · ', tone: 'muted' });
        pieces.push({ text: stepValue(step, screen.draft), tone: 'text' });
      });
      rows.push({ pieces, optional: true });
    }
  }
  rows.push(blankRow());
  const back = screen.field ? 'Summary' : position.index === 1 ? 'Cancel' : 'Back';
  const hints: [string, string][] = options
    ? [['↑↓', 'Choose'], ['Enter', 'Next'], ['Esc', back], ['Ctrl+C', 'Cancel']]
    : [['Enter', 'Next'], ['Esc', back], ['Ctrl+C', 'Cancel']];
  void view;
  return { rows, input: hintInput(hints), anchor: 'start' };
}

const ACTION_LABELS: Record<SummaryAction, string> = {
  test: 'Test connection',
  save: 'Save',
  back: 'Back',
};

function summaryCard(screen: Extract<Screen, { kind: 'summary' }>, width: number, view: RenderView): PanelLayout {
  const home = view.home;
  const rows: Row[] = [
    blankRow(),
    headerRow(capitalize(screen.title), screen.mode === 'new' ? 'Review' : 'Choose a field', width),
    textRow(screen.mode === 'new'
      ? 'Check the values, test the connection, then save. Enter on a field changes it.'
      : 'Pick the field to change, then Save. Test connection tries the new values first.', 'muted', false, true),
  ];
  if (screen.test) {
    rows.push({
      pieces: [
        { text: screen.test.ok ? '✓ ' : '✗ ', tone: screen.test.ok ? 'success' : 'error', bold: true },
        { text: screen.test.text, tone: screen.test.ok ? 'success' : 'error', bold: true },
      ],
    });
  }
  const note = noticeRow(screen.notice);
  if (note) rows.push(note);
  rows.push(blankRow());
  const labelWidth = Math.max(...FIELDS.map((field) => displayWidth(fieldTitle(field)))) + 3;
  FIELDS.forEach((field, index) => {
    const selected = screen.choice === index;
    const value = fieldValue(field, screen.draft, home);
    const hint = selected ? 'Enter to change' : '';
    const valueRoom = Math.max(4, width - 2 - labelWidth - (hint ? displayWidth(hint) + 2 : 0));
    const shown = truncate(value, valueRoom);
    const gap = Math.max(0, width - 2 - labelWidth - displayWidth(shown) - displayWidth(hint));
    rows.push({
      pieces: [
        { text: selected ? '› ' : '  ', tone: 'accent', bold: true },
        { text: fieldTitle(field) + ' '.repeat(labelWidth - displayWidth(fieldTitle(field))), tone: 'muted' },
        { text: shown, bold: selected, tone: field === 'auth' ? authToneOf(screen.draft.auth) : 'text' },
        { text: ' '.repeat(gap) },
        { text: hint, tone: 'muted' },
      ],
      fill: selected ? 'select' : 'panel',
    });
  });
  rows.push(blankRow());
  const command = sshCommand(screen.draft, home);
  const commandRows = wrapWords(command, Math.max(8, width - 6)).map((line, index): Row => ({
    pieces: [{ text: index === 0 ? '$ ' : '  ', tone: 'accent2', bold: true }, { text: line }],
  }));
  rows.push(...innerBox('Equivalent ssh command', commandRows, width, 'border'));
  rows.push(blankRow());
  const actionHints: Record<SummaryAction, string> = {
    test: 'Connect and sign in without saving',
    save: screen.mode === 'new' ? 'Add it to the list' : 'Keep the changes',
    back: screen.mode === 'new' ? 'Back to the last step' : 'Discard the changes',
  };
  const nameWidth = Math.max(...SUMMARY_ACTIONS.map((action) => displayWidth(ACTION_LABELS[action])));
  SUMMARY_ACTIONS.forEach((action, index) => {
    const selected = screen.choice === FIELDS.length + index;
    rows.push(optionRow(ACTION_LABELS[action], actionHints[action], selected, nameWidth, 'select'));
  });
  rows.push(blankRow());
  return {
    rows,
    input: hintInput([['↑↓', 'Choose'], ['Enter', 'Select'], ['t', 'Test'], ['s', 'Save'], ['Esc', 'Back']]),
    anchor: 'start',
  };
}

/** Text broken at spaces into lines of a width; a long word is cut. */
function wrapWords(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (displayWidth(next) <= width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = displayWidth(word) <= width ? word : truncate(word, width);
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function placePanel(layout: PanelLayout, view: RenderView): Frame {
  const { cols, rows } = view;
  const { left, width } = pageColumn(cols);
  const innerWidth = width - 2;
  const promptTop = rows - PROMPT_BLOCK;
  const cardBottom = Math.max(0, promptTop - FRAME_GAP);
  const maxInner = Math.max(1, cardBottom - 2);
  let body = squeeze(layout.rows, maxInner, layout.anchor === 'end' ? 'end' : 'start');
  if (layout.anchor === 'center') body = centerRows(body, maxInner);
  else while (body.length < maxInner) body.push(blankRow());
  const card = frameCard(body, left, innerWidth, cols, layout.border ?? 'border');
  const prompt = frameInput(layout.input, left, innerWidth, cols);
  const lines = Array.from({ length: rows }, () => bare(cols));
  card.lines.forEach((line, index) => {
    if (index < cardBottom && index < rows) lines[index] = line;
  });
  prompt.lines.forEach((line, index) => {
    if (promptTop + index < rows) lines[promptTop + index] = line;
  });
  let cursor: Frame['cursor'];
  if (layout.input.editable && prompt.cursorCol !== undefined) cursor = { row: promptTop + 1, col: prompt.cursorCol };
  else if (card.cursor && card.cursor.row < cardBottom) cursor = card.cursor;
  return { lines, cursor, links: new Map() };
}

function centerRows(rows: Row[], height: number): Row[] {
  if (rows.length >= height) return rows;
  const pad = height - rows.length;
  const top = Math.floor(pad / 2);
  return [...Array.from({ length: top }, () => blankRow()), ...rows, ...Array.from({ length: pad - top }, () => blankRow())];
}

/** A card: border, two columns of padding, and its rows. The cursor, when a row has one, in screen terms. */
function frameCard(inner: Row[], left: number, innerWidth: number, cols: number, border: Tone): { lines: PaintedLine[]; cursor?: { row: number; col: number } } {
  const contentWidth = Math.max(1, innerWidth - 4);
  const lines = [rule(left, innerWidth + 2, cols, true, border)];
  let cursor: { row: number; col: number } | undefined;
  inner.forEach((row, index) => {
    const fill = row.fill ?? 'panel';
    const content = paintPieces(row.pieces, contentWidth, fill);
    const padded = joinPainted([paintPieces([{ text: '  ' }], 2, fill), content, paintPieces([{ text: '  ' }], 2, fill)], innerWidth);
    lines.push(boxSides(left, padded, cols, border));
    if (row.cursor !== undefined && !cursor) cursor = { row: index + 1, col: left + 1 + 2 + Math.min(row.cursor, contentWidth - 1) + 1 };
  });
  lines.push(rule(left, innerWidth + 2, cols, false, border));
  return { lines, cursor };
}

function frameInput(input: PanelInput, left: number, innerWidth: number, cols: number): { lines: PaintedLine[]; cursorCol?: number } {
  const contentWidth = Math.max(4, innerWidth - 4);
  const prefix = input.editable ? `${input.prefix ?? '>'} ` : '';
  const metaText = input.meta && displayWidth(input.meta) + displayWidth(prefix) + 6 < contentWidth ? input.meta : '';
  const room = Math.max(0, contentWidth - displayWidth(prefix) - (metaText ? displayWidth(metaText) + 2 : 0));
  const tail = tailText(input.text, Math.max(room, input.editable ? 1 : 0));
  const gap = Math.max(metaText ? 2 : 0, contentWidth - displayWidth(prefix + tail) - displayWidth(metaText));
  const pieces: Piece[] = input.editable
    ? [{ text: prefix, tone: 'accent', bold: true }, { text: tail }]
    : input.hints
      ? hintPieces(input.hints)
      : [{ text: tail, tone: 'muted' }];
  if (!input.hints) pieces.push({ text: ' '.repeat(Math.max(0, gap)) }, { text: metaText, tone: 'muted' });
  const content = paintPieces(pieces, contentWidth);
  const padded = joinPainted([paintPieces([{ text: '  ' }], 2), content, paintPieces([{ text: '  ' }], 2)], innerWidth);
  const line = boxSides(left, padded, cols, input.editable ? 'accent' : 'border');
  let cursorCol: number | undefined;
  if (input.editable) cursorCol = left + 1 + 2 + displayWidth(prefix + tail) + 1;
  const tone: Tone = input.editable ? 'accent' : 'border';
  return { lines: [rule(left, innerWidth + 2, cols, true, tone), line, rule(left, innerWidth + 2, cols, false, tone)], cursorCol };
}

/** "Enter Next · Esc Back": keys in the accent, labels dim. */
function hintPieces(hints: [string, string][]): Piece[] {
  const pieces: Piece[] = [];
  hints.forEach(([key, label], index) => {
    if (index > 0) pieces.push({ text: ' · ', tone: 'muted' });
    pieces.push({ text: key, tone: 'accent', bold: true }, { text: label ? ` ${label}` : '', tone: 'muted' });
  });
  return pieces;
}

/** The file or directory under a 0-based screen column. */
export function linkAt(cells: readonly string[], column: number, entries: BrowseEntry[], downloadLabel?: string, menu = false): LineLink | undefined {
  if (column < 0) return undefined;
  let text = '';
  const origin: number[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (!cell) continue;
    origin.push(index);
    text += cell;
  }
  for (const span of nameSpans(text, entries, downloadLabel, menu)) {
    const start = origin[span.start];
    if (start === undefined) continue;
    const endChar = span.start + span.length;
    const end = endChar < origin.length ? origin[endChar] : cells.length;
    if (column >= start && column < end) return span;
  }
  return undefined;
}

/** The tooltip of a linked name: what a click does. */
export function linkTooltip(entry: BrowseEntry, downloadLabel: string, menu: boolean): string {
  const folder = entry.kind === 'dir';
  if (menu) {
    if (folder) return `Folder ${entry.name}: download, upload into, rename, delete`;
    const kind = classifyName(entry.name);
    const open = kind === 'text' ? 'open, ' : kind === 'unknown' ? 'open (if text), ' : '';
    return `${entry.name}: download, ${open}rename, delete`;
  }
  return folder ? `Download folder ${entry.name} to ${downloadLabel}` : `Download ${entry.name} to ${downloadLabel}`;
}

export function nameSpans(plain: string, entries: BrowseEntry[], downloadLabel = 'the Desktop', menu = false): LineLink[] {
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
          tooltip: linkTooltip(entry, downloadLabel, menu),
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

function authWord(item: Pick<ConnectionItem, 'auth'>): string {
  if (item.auth === 'privateKey') return 'key';
  return item.auth;
}

function authToneOf(auth: string): Tone {
  if (auth === 'privateKey') return 'success';
  if (auth === 'password') return 'warn';
  if (auth === 'agent') return 'info';
  return 'text';
}

function authTone(item: Pick<ConnectionItem, 'auth'>): Tone {
  return authToneOf(item.auth);
}

/** The >_ badge: the icon's violet-to-pink gradient, three rows high. */
function badge(row: number): Piece[] {
  const palette = current.palette;
  const pieces: Piece[] = [];
  for (let col = 0; col < BADGE_WIDTH; col += 1) {
    const bg = mix(palette.badgeFrom, palette.badgeTo, col / (BADGE_WIDTH - 1));
    const text = row === 1 && col === 2 ? '>' : row === 1 && col === 3 ? '_' : ' ';
    pieces.push({ text, bg, fg: [255, 255, 255], bold: true });
  }
  return pieces;
}

function wordmark(): Piece[] {
  return [
    { text: 'Easy ', tone: 'accent', bold: true },
    { text: 'SSH', tone: 'accent2', bold: true },
    { text: `  ${VERSION}`, tone: 'muted' },
  ];
}

/**
 * The brand mark: the badge with the wordmark and up to two lines beside it.
 * Narrow cards get a one-line mark: a small badge and the wordmark.
 */
function brandMark(width: number, beside: Piece[][]): Row[] {
  if (width >= BADGE_WIDTH + 24) {
    const lines = [wordmark(), ...beside];
    return [0, 1, 2].map((index) => ({ pieces: [...badge(index), { text: '  ' }, ...(lines[index] ?? [])] }));
  }
  const palette = current.palette;
  const small: Piece[] = [
    { text: ' >', bg: palette.badgeFrom, fg: [255, 255, 255], bold: true },
    { text: '_ ', bg: palette.badgeTo, fg: [255, 255, 255], bold: true },
    { text: ' ' },
  ];
  return [{ pieces: [...small, ...wordmark()] }, ...beside.filter((line) => line.length > 0).map((pieces) => ({ pieces }))];
}

/** The most recently used connection, if any has been used. */
function mostRecent(items: ConnectionItem[]): ConnectionItem | undefined {
  let best: ConnectionItem | undefined;
  for (const item of items) {
    if (item.lastUsed && (!best || (best.lastUsed ?? 0) < item.lastUsed)) best = item;
  }
  return best;
}

/** "Last: prod-web · deploy@prod-web.example.com · 2 h ago — Enter to reconnect", shortened to fit. */
function recentPieces(recent: ConnectionItem, selected: ConnectionItem | undefined, token: string, now: number, room: number): Piece[] {
  const reconnect = selected?.id === recent.id ? 'Enter to reconnect' : `/${token} to reconnect`;
  const host: Piece[] = [{ text: ' · ', tone: 'muted' }, { text: recent.userHost.replace(/:22$/, ''), tone: 'text' }];
  const head: Piece[] = [{ text: 'Last: ', tone: 'muted' }, { text: recent.name, tone: 'text', bold: true }];
  const when: Piece[] = [{ text: ' · ', tone: 'muted' }, { text: relativeTime(recent.lastUsed, now), tone: 'accent2' }];
  const tail: Piece[] = [{ text: ` — ${reconnect}`, tone: 'muted' }];
  const size = (pieces: Piece[]) => pieces.reduce((sum, piece) => sum + displayWidth(piece.text), 0);
  for (const pieces of [[...head, ...host, ...when, ...tail], [...head, ...when, ...tail], [...head, ...host, ...when], [...head, ...when]]) {
    if (size(pieces) <= room) return pieces;
  }
  return [...head, ...when];
}

interface Column {
  key: 'name' | 'host' | 'auth' | 'last' | 'token';
  title: string;
  width: number;
}

/**
 * The connection list as aligned columns: name, user@host:port, sign-in, last
 * used, and the /name shortcut on the right. Narrow cards drop the shortcut,
 * then last used, then sign-in, then shorten the host.
 */
function connectionTable(
  items: ConnectionItem[],
  selected: number,
  tokens: Map<string, string>,
  width: number,
  limit: number,
  now: number,
  withTokens = true,
): Row[] {
  if (items.length === 0) return [];
  const lead = 2;
  const gap = 2;
  const authText = (item: ConnectionItem) => authWord(item) + (item.via ? ` via ${item.via}` : '');
  const lastText = (item: ConnectionItem) => relativeTime(item.lastUsed, now) || '—';
  const tokenText = (item: ConnectionItem) => `/${tokens.get(item.id) ?? item.name}`;
  const widest = (values: string[], floor: number, cap: number) => Math.min(cap, Math.max(floor, ...values.map((value) => displayWidth(value))));
  let columns: Column[] = [
    { key: 'name', title: 'NAME', width: widest(items.map((item) => item.name), 4, 24) },
    { key: 'host', title: 'HOST', width: widest(items.map((item) => item.userHost), 4, 44) },
    { key: 'auth', title: 'AUTH', width: widest(items.map(authText), 4, 24) },
    { key: 'last', title: 'LAST USED', width: widest(items.map(lastText), 9, 12) },
  ];
  if (withTokens) columns.push({ key: 'token', title: '', width: widest(items.map(tokenText), 2, 26) });
  const total = () => lead + columns.reduce((sum, column) => sum + column.width, 0) + gap * (columns.length - 1);
  for (const drop of ['token', 'last', 'auth'] as const) {
    if (total() <= width) break;
    columns = columns.filter((column) => column.key !== drop);
  }
  const host = columns.find((column) => column.key === 'host');
  const name = columns.find((column) => column.key === 'name') as Column;
  if (host && total() > width) {
    host.width = Math.max(0, width - lead - name.width - gap);
    if (host.width < 10) {
      columns = columns.filter((column) => column.key !== 'host');
      name.width = Math.max(4, width - lead);
    }
  } else if (!host && total() > width) name.width = Math.max(4, width - lead);
  // Spare room goes before the shortcut, so it lines up on the right edge.
  const spare = Math.max(0, width - total());

  const cell = (text: string, column: Column) => {
    const shown = truncate(text, column.width);
    return shown + ' '.repeat(Math.max(0, column.width - displayWidth(shown)));
  };
  const header: Piece[] = [{ text: ' '.repeat(lead) }];
  columns.forEach((column, index) => {
    if (index > 0) header.push({ text: ' '.repeat(gap + (column.key === 'token' ? spare : 0)) });
    header.push({ text: cell(column.title, column), tone: 'muted' });
  });
  const rows: Row[] = [{ pieces: header, optional: true }];
  const visible = windowed(items, selected, Math.max(1, limit));
  const offset = Math.max(0, items.indexOf(visible[0] ?? items[0]));
  visible.forEach((item, index) => {
    const isSelected = offset + index === selected;
    const pieces: Piece[] = [{ text: isSelected ? '› ' : '  ', tone: 'accent', bold: true }];
    columns.forEach((column, columnIndex) => {
      if (columnIndex > 0) pieces.push({ text: ' '.repeat(gap + (column.key === 'token' ? spare : 0)) });
      if (column.key === 'name') pieces.push({ text: cell(item.name, column), bold: true });
      else if (column.key === 'host') pieces.push({ text: cell(item.userHost, column), tone: 'text' });
      else if (column.key === 'auth') {
        const word = authWord(item);
        const full = cell(authText(item), column);
        pieces.push({ text: full.slice(0, word.length), tone: authTone(item), bold: isSelected });
        pieces.push({ text: full.slice(word.length), tone: 'muted' });
      } else if (column.key === 'last') pieces.push({ text: cell(lastText(item), column), tone: 'muted' });
      else pieces.push({ text: cell(tokenText(item), column), tone: 'muted' });
    });
    rows.push({ pieces, fill: isSelected ? 'select' : 'panel' });
  });
  return rows;
}

const FOOTER_HINTS: [string, string][] = [
  ['/new', 'New'],
  ['/edit', 'Edit'],
  ['/delete', 'Delete'],
  ['/import', 'Import'],
  ['/theme', 'Theme'],
  ['↑↓', 'Select'],
  ['Enter', 'Connect'],
  ['/quit', ''],
];

/** The key hints at the bottom of the home card, wrapped between hints when narrow. */
function footerRows(width: number, hasItems: boolean): Row[] {
  const hints = hasItems ? FOOTER_HINTS : FOOTER_HINTS.filter(([key]) => !['/edit', '/delete', '↑↓', 'Enter'].includes(key));
  const rows: Row[] = [];
  let pieces: Piece[] = [];
  let used = 0;
  for (const [key, label] of hints) {
    const size = displayWidth(label ? `${key} ${label}` : key);
    const sep = pieces.length ? 3 : 0;
    if (pieces.length && used + sep + size > width) {
      rows.push({ pieces });
      pieces = [];
      used = 0;
    }
    if (pieces.length) pieces.push({ text: ' · ', tone: 'muted' });
    pieces.push({ text: key, tone: 'accent' }, { text: label ? ` ${label}` : '', tone: 'muted' });
    used += (pieces.length > 2 ? 3 : 0) + size;
  }
  if (pieces.length) rows.push({ pieces });
  return rows;
}

/** Tips for the right side of the home prompt. One shows per visit. */
export function homeTips(click: string, downloads: string): string[] {
  return [
    `${click} a file name to download, open, rename or delete it`,
    'Drag files onto the terminal to upload them',
    '/import reads hosts from ~/.ssh/config',
    `Downloads go to ${downloads} · /folder changes it`,
    '/theme switches Auto, Dark and Light colors',
    'Type / to list every command and connection',
  ];
}

/** The tip for this visit that fits, or none. */
function pickTip(view: RenderView, room: number): string {
  const tips = homeTips(view.click ?? 'Ctrl+click', shortenPath(view.downloadFolder, view.home, 28));
  const start = Math.abs(Math.floor(view.tip ?? 0)) % tips.length;
  for (let offset = 0; offset < tips.length; offset += 1) {
    const tip = `Tip: ${tips[(start + offset) % tips.length]}`;
    if (displayWidth(tip) <= room) return tip;
  }
  return '';
}

function renderHome(screen: Extract<Screen, { kind: 'connections' }>, view: RenderView): Frame {
  const { cols, rows } = view;
  const links = new Map<string, LineLink[]>();
  const { left, width } = pageColumn(cols);
  const innerWidth = width - 2;
  const contentWidth = Math.max(8, innerWidth - 4);
  const now = view.now ?? Date.now();
  const tokens = assignConnectionTokens(screen.items.map((item) => ({ id: item.id, name: item.name, description: item.userHost })));
  const selectedItem = screen.items[screen.selected];
  const recent = mostRecent(screen.items);

  const build = (listLimit: number): Row[] => {
    const beside: Piece[][] = [];
    if (screen.items.length === 0) {
      beside.push([{ text: 'SSH terminal with file transfer and remote editing', tone: 'muted' }]);
      beside.push([{ text: 'Start with ', tone: 'muted' }, { text: '/new', tone: 'accent', bold: true }, { text: ' or ', tone: 'muted' }, { text: '/import', tone: 'accent', bold: true }, { text: ' (reads ~/.ssh/config)', tone: 'muted' }]);
    } else {
      const room = contentWidth >= BADGE_WIDTH + 24 ? contentWidth - BADGE_WIDTH - 2 : contentWidth;
      const intro = 'Type /name to connect, or pick a row and press Enter';
      const shortIntro = displayWidth('Type /name or press Enter to connect') <= room ? 'Type /name or press Enter to connect' : 'Type /name to connect';
      beside.push([{ text: displayWidth(intro) <= room ? intro : shortIntro, tone: 'muted' }]);
      if (recent) beside.push(recentPieces(recent, selectedItem, tokens.get(recent.id) ?? recent.name, now, room));
    }
    const out: Row[] = [blankRow(), ...brandMark(contentWidth, beside), blankRow()];
    const note = noticeRow(screen.notice);
    if (note) out.push(note, blankRow());
    if (screen.items.length > 0) {
      out.push(...connectionTable(screen.items, screen.selected, tokens, contentWidth, listLimit, now));
      out.push(blankRow());
    }
    out.push(...footerRows(contentWidth, screen.items.length > 0));
    return out;
  };

  const promptTop = rows - PROMPT_BLOCK;
  const matches = matchSlashCommands(screen.command, slashTargetsFrom(screen.items));
  const menu = matches.length > 0 ? frameMenu(matches, screen.pick, screen.command, left, innerWidth, cols, promptTop - FRAME_GAP) : undefined;
  const menuOpen = Boolean(menu && menu.lines.length > 0);
  const menuTop = menuOpen && menu ? promptTop - FRAME_GAP - menu.lines.length : promptTop;
  const cardBottom = menuOpen ? menuTop - FRAME_GAP : promptTop - FRAME_GAP;
  const maxInner = Math.max(1, cardBottom - 2);
  let listLimit = screen.items.length;
  let inner = build(listLimit);
  while (inner.length > maxInner && listLimit > 1) {
    listLimit -= 1;
    inner = build(listLimit);
  }
  inner = squeeze(inner, maxInner);
  while (inner.length < maxInner) inner.push(blankRow());

  const card = frameCard(inner, left, innerWidth, cols, 'border');
  const prompt = framePrompt(screen.command, view, left, innerWidth, cols);
  const lines = Array.from({ length: rows }, () => bare(cols));
  card.lines.forEach((line, index) => {
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
}

function framePrompt(command: string, view: RenderView, left: number, innerWidth: number, cols: number): { lines: PaintedLine[]; cursorCol: number } {
  const contentWidth = Math.max(4, innerWidth - 4);
  const prefix = '> ';
  const typedRoom = Math.max(12, displayWidth(command) + 4);
  const meta = command ? '' : pickTip(view, Math.max(0, contentWidth - displayWidth(prefix) - typedRoom));
  const room = Math.max(1, contentWidth - displayWidth(prefix) - (meta ? displayWidth(meta) + 2 : 0));
  const tail = tailText(command, room);
  const gap = Math.max(meta ? 2 : 0, contentWidth - displayWidth(prefix + tail) - displayWidth(meta));
  const content = paintPieces([
    { text: prefix, tone: 'accent', bold: true },
    { text: tail, tone: 'text' },
    { text: ' '.repeat(Math.max(0, gap)) },
    { text: meta, tone: 'muted' },
  ], contentWidth);
  const padded = joinPainted([paintPieces([{ text: '  ' }], 2), content, paintPieces([{ text: '  ' }], 2)], innerWidth);
  const line = boxSides(left, padded, cols, 'accent');
  return {
    lines: [rule(left, innerWidth + 2, cols, true, 'accent'), line, rule(left, innerWidth + 2, cols, false, 'accent')],
    cursorCol: left + 1 + 2 + displayWidth(prefix + tail) + 1,
  };
}

function slashTargetsFrom(items: ConnectionItem[]): SlashTarget[] {
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
  typed: string,
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
  const query = typed.trim().replace(/^\//, '');
  const lines = [rule(left, innerWidth + 2, cols, true, 'accent')];
  for (const row of visible) {
    const active = row.commandIndex === selected;
    const fill: Fill = active ? 'select' : 'panel';
    const content = row.header
      ? paintPieces([{ text: row.header, tone: 'muted' }], contentWidth)
      : paintPieces(menuRow(row.command as SlashCommand, active, nameWidth, contentWidth, query), contentWidth, fill);
    const padded = joinPainted([paintPieces([{ text: '  ' }], 2, fill), content, paintPieces([{ text: '  ' }], 2, fill)], innerWidth);
    lines.push(boxSides(left, padded, cols, 'accent'));
  }
  lines.push(rule(left, innerWidth + 2, cols, false, 'accent'));
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

/** A slash menu row. The typed part of the name is in the accent. */
function menuRow(command: SlashCommand, selected: boolean, nameWidth: number, width: number, query: string): Piece[] {
  const name = `/${command.name}`;
  const matched = query && command.name.toLowerCase().startsWith(query.toLowerCase()) ? 1 + query.length : 1;
  const pad = ' '.repeat(Math.max(0, nameWidth - displayWidth(name)));
  const descRoom = Math.max(0, width - 2 - nameWidth - 2);
  const desc = descRoom > 0 ? truncate(command.description, descRoom) : '';
  const pieces: Piece[] = [
    { text: selected ? '› ' : '  ', tone: 'accent', bold: true },
    { text: name.slice(0, matched), tone: 'accent', bold: true },
    { text: name.slice(matched) + pad, tone: 'text', bold: selected },
  ];
  if (desc) pieces.push({ text: '  ' }, { text: desc, tone: 'muted' });
  return pieces;
}

function rule(left: number, width: number, cols: number, top: boolean, tone: Tone = 'border'): PaintedLine {
  const bar = (top ? '╭' : '╰') + '─'.repeat(Math.max(0, width - 2)) + (top ? '╮' : '╯');
  return joinPainted([paintPieces([{ text: ' '.repeat(left) }], left, 'none'), paintPieces([{ text: bar, tone }], width)], cols);
}

function boxSides(left: number, inner: PaintedLine, cols: number, tone: Tone = 'border'): PaintedLine {
  const lead = joinPainted([paintPieces([{ text: ' '.repeat(left) }], left, 'none'), paintPieces([{ text: '│', tone }], 1)], left + 1);
  const edge = paintPieces([{ text: '│', tone }], 1);
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
    styled += `\x1b[0m${spaces}`;
  }
  return { plain, styled: `${styled}\x1b[0m` };
}

export function paint(frame: Frame): string {
  let out = '\x1b[H\x1b[?25l';
  frame.lines.forEach((line, index) => {
    out += `\x1b[${index + 1};1H\x1b[0m\x1b[2K${line.styled}`;
  });
  if (frame.cursor) out += `\x1b[${frame.cursor.row + 1};${frame.cursor.col}H\x1b[?25h`;
  return out;
}
