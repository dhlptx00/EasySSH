import { randomUUID } from 'crypto';
import { withParent } from '../entries';
import type { AskAnswer, AskRequest } from '../ssh/auth';
import { HostKeyDeclined, TransferCancelled, TransferError, humanizeSshError } from '../ssh/errors';
import { remoteBasename, remoteDirname, remoteJoin } from '../remotePath';
import { RawShellTap, type RawShellUpdate } from '../ssh/rawShell';
import type { ConnectUi, HostKeyQuestion } from '../ssh/session';
import { setupLine, shellQuote, type ShellKind } from '../ssh/shellFeed';
import {
  actionMenu,
  DELETE_COUNT_CAP,
  DELETE_COUNT_MS,
  deleteQuestion,
  onlyActions,
  renameProblem,
  renameQuestion,
  renameSelection,
  targetSummary,
  uploadDir,
  largeOpenQuestion,
  OPEN_ASK_BYTES,
  SNIFF_MS,
  type ActionTarget,
  type FileAction,
  type TreeCount,
} from './actions';
import { safeFileName, shortenPath } from '../text';
import { classifyName, looksLikeText, SNIFF_BYTES } from '../fileTypes';
import type { BrowseEntry, ConflictChoice, ConnectionRecord, Notice, TransferProgress } from '../types';
import type { AppHost, FileSession, ProgressHandle } from './host';
import { formatProgress, progressFraction, wantsNotification } from './progress';
import type { InputEvent } from './input';
import { completionQuery, completionSuffix, InputLine } from './complete';
import { encodePaste, pullRawInput, type RawInputPiece } from './rawInput';
import { defaultSlashPick, matchSlashCommands, parseConnectionCommand, type SlashTarget } from './commands';
import { peelPointer, type PointerEvent } from './pointer';
import { linkAt, nameSpans, paint, render, sessionHint, type LineLink } from './render';
import { Viewport } from './viewport';
import { classifyStale, FolderFollower, isHostSwitch, isUserSwitch, staleUploadQuestion, type StaleCwd } from './cwdTracking';
import type { ConnectionItem, Screen } from './screen';
import { applyChoice, applyStep, choiceIndex, choiceOptions, draftFromRecord, emptyDraft, nextStep, prevStep, toConnection } from './wizard';

/** Connected shell. The login PTY is shown directly; this only tracks the directory. */
interface RemoteShell {
  title: string;
  /** The shell's folder: reported by the prompt hook, or followed from typed `cd` lines. */
  cwd: string;
  entries: BrowseEntry[];
  /** False on a server without SFTP: no links, downloads, or uploads. */
  files: boolean;
  /**
   * True when the shell has no prompt hook (e.g. after `sudo su`) and a line could
   * not be followed. `cwd` is then only the last known folder, and names get no links.
   */
  lost?: boolean;
}

/** xterm mouse reporting, used only in plain-click mode. */
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l';
/** How long after Enter the prompt hook may take to report before the folder counts as unknown. */
const REPORT_GRACE_MS = 1500;
/** Silence after output that counts as "the login is done" before the hook line is sent. */
const QUIET_MS = 400;
/** Wait this long for any output before sending the hook anyway. */
const FIRST_OUTPUT_MS = 1500;
/** Send the hook at the latest this long after the shell opened. */
const HOOK_CAP_MS = 3000;
/** Retries for easySsh.autoReconnect, in seconds before each. */
const RECONNECT_DELAYS = [2, 5, 10];

/** One queued transfer in a terminal. */
interface TransferJob {
  label: string;
  direction: 'upload' | 'download';
  run: (signal: AbortSignal, progress: (state: TransferProgress) => void) => Promise<void>;
  /**
   * Show the progress notification once the job has run this long, even for a
   * small file. Set for transfers started from the action menu.
   */
  notifyAfterMs?: number;
}

/** A transfer from the action menu shows its notification after this long. */
const MENU_NOTIFY_MS = 300;
/** Wait this long after a prompt before listing the folder again. */
const LISTING_DEBOUNCE_MS = 150;
/** Folders up to this many names are re-listed after every command; bigger ones when their time changed. */
const LISTING_ALWAYS_MAX = 2000;

/** Keeps a held answer while a connection waits for the user. */
interface PendingPrompt {
  answer: (value: AskAnswer | undefined) => void;
}

function describe(record: ConnectionRecord): ConnectionItem {
  const auth = record.auth === 'privateKey' ? 'key' : record.auth;
  const via = record.jumps.length ? ` via ${record.jumps.map((jump) => jump.host).join(',')}` : '';
  return {
    id: record.id,
    name: record.name,
    userHost: `${record.username}@${record.host}:${record.port}`,
    detail: `${auth}${via}`,
  };
}

export class EasySshApp {
  private screen: Screen = { kind: 'loading' };
  private remote: RemoteShell | null = null;
  private records = new Map<string, ConnectionRecord>();
  private session: FileSession | null = null;
  private links = new Map<string, LineLink[]>();
  private lastOpenPath = '';
  private lastOpenAt = 0;
  private cols = 80;
  private rows = 24;
  private readonly viewport = new Viewport(80, 24);
  private pointerDown: { col: number; row: number } | undefined;
  private queue: Promise<void> = Promise.resolve();
  private connectAbort: AbortController | null = null;
  private tap = new RawShellTap();
  private raw = false;
  private remoteAlt = false;
  private remotePaste = false;
  private rawBuffer = '';
  private pendingRaw = '';
  /** Re-reports the running transfer, e.g. after another one was queued. */
  private refreshProgress: (() => void) | undefined;
  private rawTimer: ReturnType<typeof setTimeout> | undefined;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private shellClosing = false;
  private shellTimer: ReturnType<typeof setTimeout> | undefined;
  private editingId: string | undefined;
  private selectedId: string | undefined;
  private browseEpoch = 0;
  private tabEpoch = 0;
  private readonly inputLine = new InputLine();
  private closed = false;
  /** Plain click opens names (mouse reporting on). Otherwise Ctrl/Cmd+click through the link provider. */
  private plainClick = false;
  private loginUser = '';
  private hostName = '';
  /** The last connection's name, for messages about its editor tabs after it closed. */
  private lastTitle: string | undefined;
  private listingTimer: ReturnType<typeof setTimeout> | undefined;
  private listingBusy = false;
  private listingAgain = false;
  private listedFolder: { path: string; mtime: number } | undefined;
  /** Folder reports from the prompt hook since this connection opened. */
  private cwdReports = 0;
  /** When a command was submitted that the prompt hook has not answered yet. */
  private awaitingSince: number | undefined;
  /** Command lines submitted since the last folder report (null when the line was not tracked). */
  private pendingCommands: (string | null)[] = [];
  private reportWaiters: (() => void)[] = [];
  /** Follows `cd` lines while the prompt hook is silent. Undefined while the hook reports. */
  private follower: FolderFollower | undefined;
  /** Submitted lines the follower has not applied yet (null when the line was not tracked). */
  private followLines: (string | null)[] = [];
  private followTimer: ReturnType<typeof setTimeout> | undefined;
  /** A password or keyboard-interactive prompt waiting for Enter. */
  private pendingAsk: PendingPrompt | null = null;
  /** A host key question waiting for y/n. */
  private pendingTrust: ((ok: boolean) => void) | null = null;
  /** Setup of the prompt hook: waiting for the login output to settle, hiding its echo, or done. */
  private hookPhase: 'waiting' | 'hiding' | 'done' = 'done';
  private hookLine: string | undefined;
  private hookTimer: ReturnType<typeof setTimeout> | undefined;
  private hookOpenedAt = 0;
  private hookFirstOutput = false;
  private connectMs = 0;
  /** Typed pieces waiting while a possible drop is checked (B1), in order. */
  private pieceQueue: RawInputPiece[] = [];
  private pieceBusy = false;
  /** Transfers of this terminal: one runs, the rest wait (U5). */
  private transferQueue: TransferJob[] = [];
  private transferAbort: AbortController | null = null;
  private transferLabel = '';
  private progress: ProgressHandle | undefined;
  /** The connection that dropped, for Reconnect. */
  private lostRecord: ConnectionRecord | null = null;
  /** The connection this terminal is signed in to. */
  private connectedRecord: ConnectionRecord | null = null;
  private lostCwd = '';
  private dropReason: string | undefined;
  private reconnectTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTries = 0;

  constructor(
    private readonly host: AppHost,
    private readonly emit: (data: string) => void,
  ) {}

  setSize(cols: number, rows: number): void {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.viewport.resize(this.cols, this.rows);
    if (this.raw) {
      this.session?.resizeShell(this.cols, this.rows);
      return;
    }
    this.draw();
  }

  /** True while keystrokes should be forwarded to the remote shell. */
  takesRawInput(): boolean {
    return this.raw && !this.closed;
  }

  onRawInput(data: string): void {
    if (!this.raw || this.closed) return;
    // Ctrl+C belongs to the remote program. Transfers have their own Cancel (B9).
    // Keys typed before the shell is set up wait, so they do not mix with the hook line.
    if (!this.session?.hasShell() || this.hookPhase !== 'done') {
      this.pendingRaw += data;
      return;
    }
    this.flushPendingRaw();
    this.queueRaw(data);
  }

  open(): void {
    void this.enqueue(() => this.showConnections());
  }

  onInput(events: InputEvent[]): void {
    if (events.length === 0) return;
    let batch: InputEvent[] = [];
    const flushBatch = () => {
      if (batch.length === 0) return;
      const run = batch;
      batch = [];
      void this.enqueue(async () => {
        for (const event of run) await this.onEvent(event);
      });
    };
    for (const event of events) {
      // Prompts shown while connecting are answered right away: the connect task
      // holds the queue until they are answered. Ctrl+C must also reach it.
      const direct = this.screen.kind === 'ask'
        || this.screen.kind === 'trust'
        || (event.type === 'key' && event.key === 'ctrl-c' && this.connectAbort !== null);
      if (direct) {
        flushBatch();
        this.onPromptEvent(event);
      } else batch.push(event);
    }
    flushBatch();
  }

  activatePath(remotePath: string): void {
    if (this.raw && this.remoteAlt) return;
    void this.enqueue(() => this.openRemote(remotePath));
  }

  /**
   * A click on a link VS Code offered. VS Code can keep offering a link for a row
   * whose text has since changed (the pointer stayed on the row while `clear && ls`
   * redrew it), so check that the row still shows the text the link was made for.
   * If it changed, act on the name now under the link, or ask for a fresh click.
   */
  activateLink(link: Pick<LineLink, 'remotePath' | 'start' | 'length' | 'anchors'>): void {
    if (this.raw && this.remoteAlt) return;
    const checked = this.checkLink(link);
    if (checked.kind === 'stale') {
      this.host.log(`Ignored a click on ${link.remotePath}: the terminal row changed after the link was made`);
      this.host.notify?.('info', 'The terminal text under the pointer changed. Move the pointer off the name, then click it again.');
      return;
    }
    if (checked.remotePath !== link.remotePath) this.host.log(`The terminal row changed under the pointer: using ${checked.remotePath} instead of ${link.remotePath}`);
    this.activatePath(checked.remotePath);
  }

  private checkLink(link: Pick<LineLink, 'remotePath' | 'start' | 'length' | 'anchors'>): { kind: 'ok'; remotePath: string } | { kind: 'stale' } {
    const anchors = link.anchors;
    // No anchor: a wrapped line, or a row scrolled into view from history. Trust it.
    if (!this.raw || !anchors || anchors.length === 0) return { kind: 'ok', remotePath: link.remotePath };
    if (anchors.some((anchor) => this.viewport.unchanged(anchor))) return { kind: 'ok', remotePath: link.remotePath };
    const remote = this.remote;
    if (anchors.length !== 1 || !remote || !remote.files) return { kind: 'stale' };
    const now = nameSpans(this.viewport.text(anchors[0].row), remote.entries, this.downloadLabel(), this.host.showActionMenu !== undefined);
    const end = link.start + link.length;
    const under = now.filter((span) => span.start < end && link.start < span.start + span.length);
    return under.length === 1 ? { kind: 'ok', remotePath: under[0].remotePath } : { kind: 'stale' };
  }

  /** The connection an editor tab reads and saves through, while it is up. */
  editorSession(): FileSession | null {
    if (this.closed || !this.session || !this.remote || this.remote.lost || !this.remote.files) return null;
    return this.session;
  }

  /** The connection's name, for messages about editor tabs. */
  connectionLabel(): string {
    return this.remote?.title ?? this.lastTitle ?? 'the server';
  }

  linkFor(line: string): LineLink[] {
    if (this.raw) {
      if (this.remoteAlt || !this.remote || this.remote.lost || !this.remote.files) return [];
      const spans = nameSpans(line, this.remote.entries, this.downloadLabel(), this.host.showActionMenu !== undefined);
      if (spans.length === 0) return spans;
      const anchors = this.viewport.anchor(line);
      return spans.map((span) => ({ ...span, anchors }));
    }
    const found = this.links.get(line) ?? this.links.get(line.trimEnd());
    if (found) return found;
    const trimmed = line.trimEnd();
    for (const [key, value] of this.links) {
      if (key.trimEnd() === trimmed) return value;
    }
    return [];
  }

  /** Cancel the running transfer (command, status bar, or notification). */
  cancelTransfer(): boolean {
    if (!this.transferAbort) return false;
    this.transferAbort.abort();
    return true;
  }

  /** True while a transfer runs or waits in this terminal. */
  hasTransfers(): boolean {
    return this.transferAbort !== null || this.transferQueue.length > 0;
  }

  onRemoteClose(reason?: string): void {
    if (this.closed || this.shellClosing || !this.session) return;
    this.dropReason = reason ?? 'The server closed the connection';
    void this.enqueue(async () => {
      if (this.closed || this.shellClosing || !this.session) return;
      if (!this.remote && this.screen.kind !== 'connecting') return;
      await this.connectionLost(this.dropReason ?? 'The server closed the connection');
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.browseEpoch += 1;
    this.shellClosing = true;
    this.clearShellTimer();
    this.clearHookTimer();
    this.clearRawTimer();
    this.clearStatusTimer();
    this.clearReconnect();
    if (this.listingTimer) clearTimeout(this.listingTimer);
    this.listingTimer = undefined;
    this.resetFollow();
    this.connectAbort?.abort();
    this.answerPending();
    this.stopTransfers();
    this.session?.close();
    this.session = null;
    this.remote = null;
    this.host.setStatus(undefined);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(task)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.stack || err.message : String(err);
        this.host.log(message);
        this.showNotice('error', humanizeSshError(err));
      });
    return this.queue;
  }

  private async onEvent(event: InputEvent): Promise<void> {
    if (event.type === 'mouse') return;
    if (event.type === 'key' && event.key === 'ctrl-c') {
      await this.cancel();
      return;
    }
    switch (this.screen.kind) {
      case 'loading':
      case 'connecting':
        return;
      case 'connections':
        await this.onConnections(event);
        return;
      case 'confirm':
        await this.onConfirm(event);
        return;
      case 'pick':
        await this.onPick(event);
        return;
      case 'trust':
      case 'ask':
        this.onPromptEvent(event);
        return;
      case 'lost':
        await this.onLost(event);
        return;
      case 'wizard':
        await this.onWizard(event);
        return;
      default: {
        const unreachable: never = this.screen;
        return unreachable;
      }
    }
  }

  private async cancel(): Promise<void> {
    if (this.connectAbort) {
      this.connectAbort.abort();
      this.answerPending();
      return;
    }
    if (this.screen.kind === 'wizard') {
      await this.showConnections();
      return;
    }
    if (this.screen.kind === 'lost') {
      this.clearReconnect();
      this.lostRecord = null;
      await this.showConnections();
      return;
    }
    if (this.screen.kind === 'confirm' || this.screen.kind === 'pick') {
      await this.showConnections();
      return;
    }
    if (this.screen.kind === 'connections') {
      if (this.screen.command) {
        this.screen = { ...this.screen, command: '', pick: 0 };
        this.draw();
        return;
      }
      this.host.quit();
    }
  }

  /** Close any open prompt as cancelled. */
  private answerPending(): void {
    const ask = this.pendingAsk;
    const trust = this.pendingTrust;
    this.pendingAsk = null;
    this.pendingTrust = null;
    ask?.answer(undefined);
    trust?.(false);
  }

  /** Keys for the password and host key screens shown while connecting. */
  private onPromptEvent(event: InputEvent): void {
    if (event.type === 'key' && event.key === 'ctrl-c') {
      this.connectAbort?.abort();
      this.answerPending();
      return;
    }
    const screen = this.screen;
    if (screen.kind === 'trust') {
      const answer = this.choiceAnswer(event, screen.choice, ['n', 'y']);
      if (answer === 'move') {
        const choice = screen.choice === 0 ? 1 : 0;
        this.screen = { ...screen, choice };
        this.draw();
        return;
      }
      if (answer === undefined) return;
      const resolve = this.pendingTrust;
      this.pendingTrust = null;
      this.screen = { kind: 'connecting', label: screen.question.hostLabel };
      this.draw();
      resolve?.(answer === 1);
      return;
    }
    if (screen.kind !== 'ask') return;
    if (event.type === 'key' && event.key === 'escape') {
      const pending = this.pendingAsk;
      this.pendingAsk = null;
      this.connectAbort?.abort();
      pending?.answer(undefined);
      return;
    }
    if (event.type === 'key' && event.key === 'tab' && screen.request.save !== undefined) {
      this.screen = { ...screen, save: !screen.save };
      this.draw();
      return;
    }
    if (event.type === 'key' && (event.key === 'backspace' || event.key === 'delete')) {
      this.screen = { ...screen, input: [...screen.input].slice(0, -1).join('') };
      this.draw();
      return;
    }
    if (event.type === 'key' && event.key === 'ctrl-u') {
      this.screen = { ...screen, input: '' };
      this.draw();
      return;
    }
    if (event.type === 'text' || event.type === 'paste') {
      const lines = event.text.split(/\r\n|\r|\n/);
      this.screen = { ...screen, input: screen.input + lines[0] };
      if (lines.length > 1) this.submitAsk();
      else this.draw();
      return;
    }
    if (event.type === 'key' && event.key === 'enter') this.submitAsk();
  }

  private submitAsk(): void {
    const screen = this.screen;
    if (screen.kind !== 'ask') return;
    const pending = this.pendingAsk;
    this.pendingAsk = null;
    this.screen = { kind: 'connecting', label: screen.label };
    this.draw();
    pending?.answer({ value: screen.input, save: screen.save });
  }

  /** The Reconnect / Back to the list screen after a drop. */
  private async onLost(event: InputEvent): Promise<void> {
    const screen = this.screen;
    if (screen.kind !== 'lost') return;
    const answer = this.choiceAnswer(event, screen.choice, ['r', 'l']);
    if (answer === 'move') {
      this.screen = { ...screen, choice: screen.choice === 0 ? 1 : 0 };
      this.draw();
      return;
    }
    if (event.type === 'key' && event.key === 'escape') {
      this.clearReconnect();
      this.lostRecord = null;
      await this.showConnections();
      return;
    }
    if (answer === undefined) return;
    const reconnect = answer === 0;
    this.clearReconnect();
    const record = this.lostRecord;
    if (!reconnect || !record) {
      this.lostRecord = null;
      await this.showConnections();
      return;
    }
    await this.connect(record, this.lostCwd);
  }

  /** y/n, Enter, Esc, and arrows on a two-choice screen. */
  private choiceAnswer(event: InputEvent, current: number, answers: [string, string]): number | 'move' | undefined {
    if (event.type === 'key' && (event.key === 'up' || event.key === 'down' || event.key === 'left' || event.key === 'right')) return 'move';
    if (event.type === 'key' && event.key === 'escape') return 0;
    if (event.type === 'key' && event.key === 'enter') return current;
    if (event.type === 'text' && event.text.toLowerCase() === answers[0]) return 0;
    if (event.type === 'text' && event.text.toLowerCase() === answers[1]) return 1;
    return undefined;
  }

  private async onConnections(event: InputEvent): Promise<void> {
    const screen = this.screen;
    if (screen.kind !== 'connections') return;
    if (event.type === 'key' && (event.key === 'up' || event.key === 'down')) {
      const matches = matchSlashCommands(screen.command, slashTargets(screen.items));
      if (matches.length > 0) {
        const pick = move(screen.pick, event.key === 'up' ? -1 : 1, matches.length);
        this.screen = { ...screen, pick };
        this.draw();
        return;
      }
      const selected = move(screen.selected, event.key === 'up' ? -1 : 1, screen.items.length);
      this.selectedId = screen.items[selected]?.id;
      this.screen = { ...screen, selected };
      this.draw();
      return;
    }
    if (event.type === 'key' && event.key === 'escape') {
      if (!screen.command) return;
      this.screen = { ...screen, command: '', pick: 0 };
      this.draw();
      return;
    }
    if (event.type === 'key' && (event.key === 'backspace' || event.key === 'delete')) {
      if (!screen.command) return;
      this.setCommand(screen, [...screen.command].slice(0, -1).join(''), undefined);
      return;
    }
    if (event.type === 'key' && event.key === 'ctrl-u') {
      this.screen = { ...screen, command: '', pick: 0 };
      this.draw();
      return;
    }
    if (event.type === 'text' || event.type === 'paste') {
      const extra = event.text.replace(/[\r\n]/g, '');
      if (!extra) return;
      this.setCommand(screen, screen.command + extra, undefined);
      return;
    }
    if (event.type === 'key' && event.key === 'enter') await this.runConnectionCommand();
  }

  private async runConnectionCommand(): Promise<void> {
    const screen = this.screen;
    if (screen.kind !== 'connections') return;
    const matches = matchSlashCommands(screen.command, slashTargets(screen.items));
    const chosen = matches.length > 0 ? matches[Math.max(0, Math.min(screen.pick, matches.length - 1))] : undefined;
    if (chosen?.connectionId) {
      this.screen = { ...screen, command: '', pick: 0 };
      const record = this.records.get(chosen.connectionId);
      if (record) await this.connect(record);
      else this.showNotice('info', 'That connection is no longer available');
      return;
    }
    const line = chosen ? `/${chosen.name}` : screen.command;
    const action = parseConnectionCommand(line);
    if (action.type === 'unknown') {
      this.screen = {
        ...screen,
        notice: { tone: 'error', text: 'Unknown command. Try /new, /edit, /delete, or /help' },
      };
      this.draw();
      return;
    }
    this.screen = { ...screen, command: '', pick: 0 };
    switch (action.type) {
      case 'connect': {
        const record = this.currentRecord();
        if (record) await this.connect(record);
        else this.showNotice('info', 'Type /new to add a connection');
        return;
      }
      case 'new':
        this.editingId = undefined;
        this.screen = { kind: 'wizard', title: 'new connection', draft: emptyDraft(), step: 'name', input: '', pick: 0 };
        this.draw();
        return;
      case 'edit':
      case 'delete': {
        if (this.screen.kind !== 'connections') return;
        this.openPicker(action.type, this.screen.items, this.screen.selected);
        return;
      }
      case 'import':
        await this.importConfig();
        return;
      case 'folder':
        await this.pickFolder();
        return;
      case 'quit':
        this.host.quit();
        return;
      case 'help':
        this.showNotice('info', 'Commands: /new, /edit, /delete, /import, /folder, /quit. A connection name connects directly.');
        return;
      default: {
        const unreachable: never = action;
        return unreachable;
      }
    }
  }

  private openPicker(mode: 'edit' | 'delete', items: ConnectionItem[], selected: number): void {
    if (items.length === 0) {
      this.showNotice('info', 'Type /new to add a connection');
      return;
    }
    this.screen = {
      kind: 'pick',
      mode,
      items,
      selected: Math.max(0, Math.min(selected, items.length - 1)),
    };
    this.draw();
  }

  private async onPick(event: InputEvent): Promise<void> {
    if (this.screen.kind !== 'pick') return;
    if (event.type === 'key' && (event.key === 'up' || event.key === 'down')) {
      const selected = move(this.screen.selected, event.key === 'up' ? -1 : 1, this.screen.items.length);
      this.screen = { ...this.screen, selected };
      this.draw();
      return;
    }
    if (event.type === 'key' && event.key === 'escape') {
      await this.showConnections();
      return;
    }
    if (event.type !== 'key' || event.key !== 'enter') return;
    const item = this.screen.items[this.screen.selected];
    if (!item) {
      await this.showConnections();
      return;
    }
    this.selectedId = item.id;
    if (this.screen.mode === 'delete') {
      this.screen = { kind: 'confirm', item, choice: 0 };
      this.draw();
      return;
    }
    await this.openEditor(item.id);
  }

  private async openEditor(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) {
      await this.showConnections({ tone: 'info', text: 'That connection is no longer available' });
      return;
    }
    const saved = await this.host.secretFlags(record.id);
    if (this.closed || this.screen.kind !== 'pick') return;
    this.editingId = record.id;
    this.selectedId = record.id;
    this.screen = {
      kind: 'wizard',
      title: `edit ${record.name}`,
      draft: draftFromRecord(record, saved),
      step: 'name',
      input: '',
      pick: 0,
    };
    this.draw();
  }

  private async onConfirm(event: InputEvent): Promise<void> {
    if (this.screen.kind !== 'confirm') return;
    const choice = await this.pickChoice(event, this.screen.choice, ['n', 'y']);
    if (choice === 'move' || choice === 'stay') return;
    if (choice !== 1) {
      await this.showConnections();
      return;
    }
    const id = this.screen.item.id;
    await this.host.deleteConnection(id);
    this.records.delete(id);
    await this.showConnections({ tone: 'ok', text: `Deleted ${this.screen.item.name}` });
  }

  private async pickChoice(event: InputEvent, current: number, answers: [string, string]): Promise<number | 'move' | 'stay'> {
    if (this.screen.kind !== 'confirm') return 'stay';
    if (event.type === 'key' && (event.key === 'up' || event.key === 'down' || event.key === 'left' || event.key === 'right')) {
      const next = event.key === 'up' || event.key === 'left' ? 0 : 1;
      this.screen = { ...this.screen, choice: next };
      this.draw();
      return 'move';
    }
    if (event.type === 'key' && event.key === 'escape') return 0;
    if (event.type === 'key' && event.key === 'enter') return current;
    if (event.type === 'text' && event.text.toLowerCase() === answers[0]) return 0;
    if (event.type === 'text' && event.text.toLowerCase() === answers[1]) return 1;
    return 'stay';
  }

  private async onWizard(event: InputEvent): Promise<void> {
    if (this.screen.kind !== 'wizard') return;
    const options = choiceOptions(this.screen.step);
    if (event.type === 'key' && event.key === 'escape') {
      const back = prevStep(this.screen.step, this.screen.draft);
      if (back === 'start') {
        await this.showConnections();
        return;
      }
      this.screen = { ...this.screen, step: back, input: '', pick: choiceIndex(back, this.screen.draft), error: undefined };
      this.draw();
      return;
    }
    if (options) {
      if (event.type === 'key' && (event.key === 'up' || event.key === 'down')) {
        const pick = move(this.screen.pick, event.key === 'up' ? -1 : 1, options.length);
        this.screen = { ...this.screen, pick };
        this.draw();
      }
      if (event.type === 'key' && event.key === 'enter') await this.advanceWizard(options[Math.max(0, Math.min(this.screen.pick, options.length - 1))].id);
      return;
    }
    if (event.type === 'key' && (event.key === 'backspace' || event.key === 'delete')) {
      this.screen = { ...this.screen, input: [...this.screen.input].slice(0, -1).join(''), error: undefined };
      this.draw();
      return;
    }
    if (event.type === 'key' && event.key === 'ctrl-u') {
      this.screen = { ...this.screen, input: '' };
      this.draw();
      return;
    }
    if (event.type === 'text' || event.type === 'paste') {
      const extra = event.text.replace(/[\r\n]/g, '');
      this.screen = { ...this.screen, input: this.screen.input + extra, error: undefined };
      this.draw();
      return;
    }
    if (event.type !== 'key' || event.key !== 'enter') return;
    await this.advanceWizard(this.screen.input);
  }

  private async advanceWizard(typed: string): Promise<void> {
    if (this.screen.kind !== 'wizard') return;
    const taken = [...this.records.values()].filter((record) => record.id !== this.editingId).map((record) => record.name);
    const applied = choiceOptions(this.screen.step)
      ? applyChoice(this.screen.step, typed, this.screen.draft)
      : applyStep(this.screen.step, typed, this.screen.draft, {
          takenNames: taken,
          keyExists: (file) => this.host.keyExists(file),
          home: this.host.home(),
        });
    if (applied.error) {
      this.screen = { ...this.screen, draft: applied.draft, error: applied.error };
      this.draw();
      return;
    }
    const following = nextStep(this.screen.step, applied.draft);
    if (following !== 'done') {
      this.screen = {
        ...this.screen,
        draft: applied.draft,
        step: following,
        input: '',
        pick: choiceIndex(following, applied.draft),
        error: undefined,
      };
      this.draw();
      return;
    }
    const id = this.editingId ?? randomUUID();
    const { record, secret } = toConnection(applied.draft, id);
    await this.host.saveConnection(record, secret);
    this.editingId = undefined;
    this.selectedId = id;
    await this.showConnections({ tone: 'ok', text: `Saved ${record.name}` });
  }

  private onShellChunk(chunk: string): void {
    if (this.closed || this.shellClosing || !this.raw) return;
    this.applyShellUpdate(this.tap.push(chunk));
    if (this.hookPhase === 'waiting') this.scheduleHook(true);
  }

  /**
   * Send the hook once the login output settles: right after something that looks
   * like a prompt, after a short silence, or at the latest after HOOK_CAP_MS. The
   * MOTD and "Last login" before it stay visible (B12).
   */
  private scheduleHook(output: boolean): void {
    if (this.hookPhase !== 'waiting') return;
    if (output) this.hookFirstOutput = true;
    this.clearHookTimer();
    const elapsed = Date.now() - this.hookOpenedAt;
    const wait = this.hookFirstOutput ? (this.tap.promptLike() ? 30 : QUIET_MS) : FIRST_OUTPUT_MS;
    const delay = Math.max(0, Math.min(wait, HOOK_CAP_MS - elapsed));
    const epoch = this.browseEpoch;
    this.hookTimer = setTimeout(() => {
      this.hookTimer = undefined;
      if (epoch !== this.browseEpoch || this.closed) return;
      this.sendHook();
    }, delay);
  }

  private sendHook(): void {
    if (this.hookPhase !== 'waiting' || !this.session?.hasShell() || !this.hookLine) {
      this.finishHook();
      return;
    }
    this.hookPhase = 'hiding';
    this.tap.hide();
    this.writeShell(`${this.hookLine}\n`);
    // A slow login gets more time before held output is shown anyway.
    const fallback = Math.max(1500, Math.min(6000, this.connectMs * 4));
    const epoch = this.browseEpoch;
    this.clearHookTimer();
    this.hookTimer = setTimeout(() => {
      this.hookTimer = undefined;
      if (epoch !== this.browseEpoch || this.closed || !this.raw) return;
      if (this.tap.hiding) this.applyShellUpdate(this.tap.release());
      this.finishHook();
    }, fallback);
  }

  private finishHook(): void {
    if (this.hookPhase === 'done') return;
    this.hookPhase = 'done';
    this.clearHookTimer();
    this.flushPendingRaw();
  }

  private clearHookTimer(): void {
    if (!this.hookTimer) return;
    clearTimeout(this.hookTimer);
    this.hookTimer = undefined;
  }

  private applyShellUpdate(update: RawShellUpdate): void {
    const wasAlt = this.remoteAlt;
    this.remoteAlt = update.altScreen;
    this.remotePaste = update.bracketedPaste;
    if (update.altScreen) {
      this.tabEpoch += 1;
      this.inputLine.forget();
    }
    if (update.text) this.present(update.text);
    if ((wasAlt || update.leftAlt) && !update.altScreen) {
      this.inputLine.reset();
      if (this.plainClick) this.present(MOUSE_ON);
      else if (update.mouse) this.mouseOff();
    }
    if (update.cwd !== undefined) this.onCwdReport(update.altScreen, update.mouse);
    if (update.cwd !== undefined && this.hookPhase === 'hiding' && !this.tap.hiding) this.finishHook();
    // The shell reports folders already (a reconnect into a shell with the hook, or the
    // user's own prompt): no need to type the setup line.
    if (update.cwd !== undefined && this.hookPhase === 'waiting') this.finishHook();
    if (update.cwd && this.remote && update.cwd === this.remote.cwd && !this.remote.lost) {
      // Back at the prompt in the same folder: a command may have created, renamed
      // or deleted names here, so list the folder again (debounced).
      this.scheduleListingRefresh();
      return;
    }
    if (!update.cwd || !this.remote) return;
    this.remote = { ...this.remote, cwd: update.cwd };
    if (!this.remote.files) return;
    if (!this.transferAbort) this.host.setStatus(`${this.remote.title}:${update.cwd}`);
    const cwd = update.cwd;
    void this.enqueue(() => this.refreshListing(cwd));
  }

  /** The prompt hook printed the folder, so the shell Easy SSH set up is at its prompt again. */
  private onCwdReport(altScreen: boolean, mouse: boolean): void {
    this.cwdReports += 1;
    this.awaitingSince = undefined;
    this.pendingCommands = [];
    this.resetFollow();
    const waiters = this.reportWaiters;
    this.reportWaiters = [];
    for (const wake of waiters) wake();
    // A prompt never needs mouse reporting. A program that exited without
    // switching it off would otherwise block text selection.
    if (!this.plainClick && !altScreen && mouse) this.mouseOff();
  }

  private mouseOff(): void {
    this.present(MOUSE_OFF);
    this.tap.mouseOff();
  }

  /** Track Enter so a missing folder report after it can be noticed. */
  private noteSubmitted(tracked: string, typed: boolean): void {
    if (!/[\r\n]/.test(tracked)) return;
    const lines = tracked.split(/\r\n|\r|\n/);
    const done = lines.slice(0, -1);
    if (typed) {
      const before = this.inputLine.text();
      done.splice(1);
      done[0] = before === null ? '\u0000' : before + done[0];
    }
    if (this.awaitingSince === undefined) this.awaitingSince = Date.now();
    for (const line of done) {
      const entry = line === '\u0000' ? null : line.trim();
      if (entry === '') continue;
      this.pendingCommands.push(entry);
      this.followLines.push(entry);
    }
    if (this.pendingCommands.length > 20) this.pendingCommands.splice(0, this.pendingCommands.length - 20);
    // Too many lines to replay safely: forget the folder rather than guess.
    if (this.followLines.length > 200) this.followLines.splice(0, this.followLines.length, null);
    this.scheduleFollow();
  }

  /**
   * Once the prompt hook has missed its grace period, the shell is one Easy SSH did
   * not set up (`sudo su`, sh, a nested bash). Follow its `cd` lines from then on.
   */
  private scheduleFollow(): void {
    if (this.follower) {
      void this.enqueue(() => this.followFolder());
      return;
    }
    if (this.followTimer) return;
    const epoch = this.browseEpoch;
    this.followTimer = setTimeout(() => {
      this.followTimer = undefined;
      if (epoch !== this.browseEpoch || this.closed || this.awaitingSince === undefined) return;
      void this.enqueue(() => this.followFolder());
    }, REPORT_GRACE_MS);
  }

  private resetFollow(): void {
    this.follower = undefined;
    this.followLines = [];
    if (this.followTimer) clearTimeout(this.followTimer);
    this.followTimer = undefined;
  }

  /** Apply the lines submitted since the last report, then list the folder they lead to. */
  private async followFolder(): Promise<void> {
    const session = this.session;
    if (!session || !this.remote || !this.raw || this.awaitingSince === undefined || !this.remote.files) return;
    const epoch = this.browseEpoch;
    if (!this.follower) this.follower = new FolderFollower(this.remote.cwd);
    const follower = this.follower;
    while (this.followLines.length > 0) {
      const line = this.followLines.shift() ?? null;
      await follower.apply(line, (path) => folderCheck(session, path));
      if (epoch !== this.browseEpoch || this.follower !== follower || !this.remote) return;
    }
    const cwd = follower.cwd;
    if (cwd === null) {
      if (this.remote.lost) return;
      this.remote = { ...this.remote, entries: [], lost: true };
      this.host.log('The current folder is not known (a line in a shell without the prompt hook could not be followed). Names are not linked until cd /absolute/path.');
      if (!this.transferAbort) this.host.setStatus(`${this.remote.title}: folder unknown`);
      return;
    }
    if (cwd === this.remote.cwd && !this.remote.lost) return;
    let entries = withParent(cwd, []);
    try {
      entries = withParent(cwd, await session.list(cwd));
    } catch (err) {
      // e.g. a folder only root can read. Links there would download nothing.
      this.host.log(`Could not list ${cwd}: ${humanizeSshError(err)}`);
    }
    if (epoch !== this.browseEpoch || this.follower !== follower || !this.remote || follower.cwd !== cwd) return;
    this.remote = { ...this.remote, cwd, entries, lost: false };
    if (!this.transferAbort) this.host.setStatus(`${this.remote.title}:${cwd}`);
  }

  /** Undefined while the tracked folder is current; otherwise why it is not. */
  private async staleCwd(): Promise<StaleCwd | undefined> {
    if (this.awaitingSince === undefined) return undefined;
    const wait = REPORT_GRACE_MS - (Date.now() - this.awaitingSince);
    if (wait > 0) await this.waitForReport(wait);
    if (this.awaitingSince === undefined) return undefined;
    await this.followFolder();
    const commands = this.pendingCommands;
    const kind = classifyStale(commands);
    const command = kind === 'user'
      ? commands.find(isUserSwitch)
      : kind === 'host'
        ? commands.find(isHostSwitch)
        : commands.find((line) => !!line);
    const followed = this.follower !== undefined && this.remote !== null && !this.remote.lost;
    return { kind, command: command ?? null, everReported: this.cwdReports > 0, followed };
  }

  private waitForReport(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.reportWaiters = this.reportWaiters.filter((item) => item !== wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.reportWaiters.push(wake);
    });
  }

  private downloadLabel(): string {
    return this.host.downloadLabel?.() ?? 'the Desktop';
  }

  private onShellClosed(): void {
    // A dropped connection closes the shell too. Give the client a moment to
    // report the drop, so "exit" and a lost connection end differently.
    const epoch = this.browseEpoch;
    setTimeout(() => {
      void this.enqueue(async () => {
        if (epoch !== this.browseEpoch || this.shellClosing || this.closed || !this.remote) return;
        if (this.dropReason !== undefined) await this.connectionLost(this.dropReason);
        else await this.disconnect();
      });
    }, 300);
  }

  private clearShellTimer(): void {
    if (!this.shellTimer) return;
    clearTimeout(this.shellTimer);
    this.shellTimer = undefined;
  }

  private enterRaw(notes: string[]): void {
    this.raw = true;
    this.rawBuffer = '';
    this.tabEpoch += 1;
    this.inputLine.reset();
    this.plainClick = this.host.plainClick?.() ?? false;
    const dim = '\x1b[38;2;106;106;106m';
    const hint = sessionHint(this.host.clickLabel?.() ?? (this.plainClick ? 'Click' : 'Ctrl+click'), this.host.showActionMenu !== undefined);
    const lines = [...notes.map((note) => `${dim}${note}\x1b[0m`), hint.styled].join('\r\n');
    this.present(`\x1b[?1049l\x1b[?25h\x1b[0m\x1b[2J\x1b[3J\x1b[H${lines}\r\n${this.plainClick ? MOUSE_ON : ''}`);
  }

  /** Show bytes in the terminal and keep a copy for click hit-testing. */
  private present(data: string): void {
    if (this.raw) this.viewport.write(data);
    this.emit(data);
  }

  private leaveRaw(): void {
    this.clearRawTimer();
    this.tabEpoch += 1;
    this.inputLine.reset();
    this.rawBuffer = '';
    this.pendingRaw = '';
    this.pointerDown = undefined;
    if (!this.raw) return;
    this.raw = false;
    this.remoteAlt = false;
    this.remotePaste = false;
    this.emit('\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?2004h\x1b[?1049h\x1b[0m');
  }

  private flushPendingRaw(): void {
    if (!this.pendingRaw) return;
    const queued = this.pendingRaw;
    this.pendingRaw = '';
    this.queueRaw(queued);
  }

  private queueRaw(data: string): void {
    this.rawBuffer += data;
    this.clearRawTimer();
    const peeled = peelPointer(this.rawBuffer);
    for (const event of peeled.events) this.onLocalPointer(event);
    const pulled = pullRawInput(peeled.text);
    this.rawBuffer = peeled.held + pulled.rest;
    for (const piece of pulled.pieces) this.forwardPiece(piece);
    if (!this.rawBuffer) return;
    const openPaste = this.rawBuffer.startsWith('\x1b[200~');
    this.rawTimer = setTimeout(() => {
      this.rawTimer = undefined;
      if (!this.raw || !this.rawBuffer) return;
      const pending = this.rawBuffer;
      this.rawBuffer = '';
      // A trailing mouse report never became a click. Drop it instead of typing it.
      if (pending.startsWith('\x1b[<')) return;
      if (pending.startsWith('\x1b[200~')) this.forwardPiece({ kind: 'paste', text: pending.slice('\x1b[200~'.length) });
      else this.forwardPiece({ kind: 'bytes', text: pending });
    }, openPaste ? 2000 : 25);
  }

  /** Pieces go out in order. A possible file drop holds the ones after it until it is decided. */
  private forwardPiece(piece: RawInputPiece): void {
    this.pieceQueue.push(piece);
    if (!this.pieceBusy) void this.drainPieces();
  }

  private async drainPieces(): Promise<void> {
    this.pieceBusy = true;
    try {
      while (this.pieceQueue.length > 0) {
        const piece = this.pieceQueue.shift() as RawInputPiece;
        const wait = this.forwardNow(piece);
        if (wait) await wait;
      }
    } finally {
      this.pieceBusy = false;
    }
  }

  private forwardNow(piece: RawInputPiece): Promise<void> | undefined {
    if (!this.session?.hasShell() || !this.remote) return undefined;
    if (piece.kind === 'paste') {
      this.inputLine.forget();
      return this.writeOrUpload(piece.text, encodePaste(piece.text, this.remotePaste), false);
    }
    if (this.remoteAlt) {
      this.inputLine.forget();
      this.writeShell(piece.text);
      return undefined;
    }
    let index = 0;
    while (index < piece.text.length) {
      const tab = piece.text.indexOf('\t', index);
      const end = tab < 0 ? piece.text.length : tab;
      if (end > index) {
        const wait = this.writeOrUpload(piece.text.slice(index, end), piece.text.slice(index, end), true);
        if (wait) {
          // The rest of this piece waits for the drop decision too.
          const rest = piece.text.slice(end);
          if (rest) this.pieceQueue.unshift({ kind: 'bytes', text: rest });
          return wait;
        }
      }
      if (tab < 0) break;
      this.completeTab();
      index = tab + 1;
    }
    return undefined;
  }

  private onLocalPointer(event: PointerEvent): void {
    // Mouse reports only reach Easy SSH in plain-click mode or when a remote
    // program asked for them. In the second case they belong to that program.
    if (this.remoteAlt || !this.plainClick) {
      this.writeShell(event.raw);
      return;
    }
    if (event.action === 'wheel') {
      this.host.scrollTerminal(event.button === 0 ? 'up' : 'down');
      return;
    }
    if (event.action === 'down' && event.button === 0) {
      this.pointerDown = { col: event.col, row: event.row };
      return;
    }
    if (event.action !== 'up' || event.button !== 0 || !this.remote) {
      this.pointerDown = undefined;
      return;
    }
    const down = this.pointerDown;
    this.pointerDown = undefined;
    if (!down || down.col !== event.col || down.row !== event.row) return;
    const link = linkAt(this.viewport.cells(event.row), event.col - 1, this.remote.entries, this.downloadLabel(), this.host.showActionMenu !== undefined);
    if (link) this.activatePath(link.remotePath);
  }

  /**
   * Send a typed chunk, or upload it when it is a local file drop. A paste is
   * text: it equals the clipboard, and a drag-and-drop does not touch the
   * clipboard (B1). Returns a promise while that is being checked.
   */
  private writeOrUpload(tracked: string, wire: string, remember: boolean): Promise<void> | undefined {
    const drop = this.asDrop(tracked);
    if (!drop) {
      this.typeText(tracked, wire, remember);
      return undefined;
    }
    return this.decideDrop(drop, tracked, wire, remember);
  }

  private typeText(tracked: string, wire: string, remember: boolean): void {
    if (!this.remoteAlt) this.noteSubmitted(tracked, remember);
    if (remember) this.inputLine.observe(tracked);
    this.writeShell(wire);
  }

  private async decideDrop(paths: string[], tracked: string, wire: string, remember: boolean): Promise<void> {
    const clip = this.host.clipboardText ? await this.host.clipboardText().catch(() => '') : '';
    const same = (a: string) => a.replace(/\r\n?/g, '\n').trim();
    if (clip && same(clip) === same(tracked)) {
      this.typeText(tracked, wire, remember);
      return;
    }
    const home = this.host.home();
    const outside = paths.filter((item) => !isInside(item, home));
    if (outside.length > 0 && this.host.confirmLocalUpload) {
      const choice = await this.host.confirmLocalUpload(outside);
      if (choice !== 'upload') {
        this.typeText(tracked, wire, remember);
        return;
      }
    }
    if (!this.remote || !this.session) return;
    this.inputLine.forget();
    if (!this.remote.files) {
      this.showNotice('error', 'Uploads need SFTP, which this server does not offer');
      return;
    }
    void this.enqueue(() => this.upload(paths));
  }

  /**
   * Finish a remote path from the directory listing and insert only the missing suffix.
   * Anything else, including a second Tab on an ambiguous name, is one Tab for the shell.
   */
  private completeTab(): void {
    const session = this.session;
    const line = this.inputLine.text();
    const cwd = this.remote?.cwd ?? '';
    const query = session && line !== null && !this.remoteAlt && !this.remote?.lost ? completionQuery(line, cwd) : null;
    if (!session || !query || line === null) {
      this.inputLine.forget();
      this.writeShell('\t');
      return;
    }
    const epoch = ++this.tabEpoch;
    const snapshot = line;
    void this.finishTab(epoch, snapshot, session, query);
  }

  private async finishTab(
    epoch: number,
    snapshot: string,
    session: FileSession,
    query: NonNullable<ReturnType<typeof completionQuery>>,
  ): Promise<void> {
    let suffix: string | null = null;
    try {
      const entries = await session.list(query.dir);
      suffix = completionSuffix(query.prefix, entries, query.dirsOnly);
    } catch (err) {
      this.host.log(err instanceof Error ? err.message : String(err));
      suffix = null;
    }
    if (!this.sameTab(epoch, snapshot, session)) return;
    if (!suffix) {
      this.inputLine.forget();
      this.writeShell('\t');
      return;
    }
    this.inputLine.observe(suffix);
    this.writeShell(suffix);
  }

  private sameTab(epoch: number, snapshot: string, session: FileSession): boolean {
    return epoch === this.tabEpoch
      && this.raw
      && !this.closed
      && !this.remoteAlt
      && this.session === session
      && this.remote !== null
      && this.inputLine.text() === snapshot;
  }

  private writeShell(data: string): void {
    try {
      this.session?.writeShell(data);
    } catch (err) {
      this.host.log(err instanceof Error ? err.message : String(err));
    }
  }

  private asDrop(text: string): string[] | null {
    // Inside vim, less, or another full-screen program, input belongs to it.
    if (!this.remote || this.remoteAlt || text.length < 2) return null;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
    return this.host.classifyDrop(text);
  }

  private clearRawTimer(): void {
    if (!this.rawTimer) return;
    clearTimeout(this.rawTimer);
    this.rawTimer = undefined;
  }

  private setCommand(screen: Extract<Screen, { kind: 'connections' }>, command: string, notice: Notice | undefined): void {
    const matches = matchSlashCommands(command, slashTargets(screen.items));
    this.screen = { ...screen, command, pick: defaultSlashPick(matches, command), notice };
    this.draw();
  }

  private currentRecord(): ConnectionRecord | undefined {
    if (this.screen.kind !== 'connections') return undefined;
    const item = this.screen.items[this.screen.selected];
    return item ? this.records.get(item.id) : undefined;
  }

  private async showConnections(notice?: Notice): Promise<void> {
    const records = await this.host.listConnections();
    this.records = new Map(records.map((record) => [record.id, record]));
    const items = records.map(describe);
    let selected = items.findIndex((item) => item.id === this.selectedId);
    if (selected < 0) selected = 0;
    this.screen = { kind: 'connections', items, selected, notice, command: '', pick: 0 };
    this.host.setStatus(undefined);
    this.draw();
  }

  /**
   * Connect and open the login shell. restoreDir is a folder to cd to once the
   * shell is set up (the start path, or the folder before a reconnect).
   */
  private async connect(record: ConnectionRecord, restoreDir?: string): Promise<void> {
    this.session?.close();
    this.session = null;
    this.browseEpoch += 1;
    this.clearReconnect();
    this.dropReason = undefined;
    const abort = new AbortController();
    this.connectAbort = abort;
    this.loginUser = record.username;
    this.hostName = record.host;
    this.cwdReports = 0;
    this.awaitingSince = undefined;
    this.pendingCommands = [];
    this.resetFollow();
    const label = `${record.username}@${record.host}:${record.port}`;
    this.screen = { kind: 'connecting', label };
    this.draw();
    this.host.log(`Connecting to ${label}`);
    const started = Date.now();
    const ui: ConnectUi = {
      ask: (request: AskRequest) => new Promise<AskAnswer | undefined>((resolve) => {
        if (this.closed || abort.signal.aborted) {
          resolve(undefined);
          return;
        }
        this.pendingAsk = { answer: resolve };
        this.screen = { kind: 'ask', label: request.label, request, input: '', save: request.save ?? false };
        this.draw();
      }),
      trustHostKey: (question: HostKeyQuestion) => new Promise<boolean>((resolve) => {
        if (this.closed || abort.signal.aborted) {
          resolve(false);
          return;
        }
        this.pendingTrust = resolve;
        this.screen = { kind: 'trust', question, choice: 0 };
        this.draw();
      }),
    };
    let opened: Awaited<ReturnType<AppHost['connect']>> | undefined;
    try {
      opened = await this.host.connect(record, { signal: abort.signal, ui });
    } catch (err) {
      if (this.connectAbort === abort) this.connectAbort = null;
      this.answerPending();
      if (this.closed) return;
      if (abort.signal.aborted || err instanceof TransferCancelled) {
        await this.showConnections({ tone: 'info', text: 'Cancelled' });
        return;
      }
      if (err instanceof HostKeyDeclined) {
        await this.showConnections({ tone: 'info', text: `Host key of ${err.host} was not trusted. Not connected` });
        return;
      }
      this.host.log(err instanceof Error ? err.message : String(err));
      if (this.lostRecord) {
        await this.connectionLost(humanizeSshError(err), true);
        return;
      }
      await this.showConnections({ tone: 'error', text: humanizeSshError(err) });
      return;
    }
    if (this.connectAbort === abort) this.connectAbort = null;
    const session = opened.session;
    if (this.closed || abort.signal.aborted) {
      session.close();
      if (!this.closed) await this.showConnections({ tone: 'info', text: 'Cancelled' });
      return;
    }
    this.connectMs = Date.now() - started;
    this.session = session;
    this.connectedRecord = record;
    this.lostRecord = null;
    this.reconnectTries = 0;
    this.tap = new RawShellTap();
    this.shellClosing = false;
    this.remoteAlt = false;
    this.remotePaste = false;
    const files = session.hasFiles ? session.hasFiles() : true;
    let entries: BrowseEntry[] = [];
    if (files) {
      try {
        entries = withParent(opened.cwd, await session.list(opened.cwd));
      } catch (err) {
        // A home or start folder SFTP may not read (chroot, permissions): open the shell anyway (B7).
        this.host.log(`Could not list ${opened.cwd}: ${humanizeSshError(err)}`);
        entries = withParent(opened.cwd, []);
      }
    }
    if (this.session !== session) return;
    const notes = [...(opened.notes ?? [])];
    if (opened.usedFallbackPath) notes.push('Remote path was not found. Opened your home directory');
    this.remote = { title: record.name, cwd: opened.cwd, entries, files };
    this.lastTitle = record.name;
    this.host.setStatus(files ? `${record.name}:${opened.cwd}` : `${record.name} (terminal only)`);
    this.host.setTitle?.(record.name);
    this.enterRaw(notes);
    const shell: ShellKind = opened.shell ?? 'unknown';
    const wanted = restoreDir || (record.startPath && !opened.usedFallbackPath ? opened.cwd : undefined);
    this.hookLine = setupLine(shell, wanted);
    this.hookPhase = this.hookLine ? 'waiting' : 'done';
    this.hookFirstOutput = false;
    this.hookOpenedAt = Date.now();
    try {
      await session.openShell(
        this.cols,
        this.rows,
        (chunk) => this.onShellChunk(chunk),
        () => this.onShellClosed(),
      );
      this.session?.resizeShell(this.cols, this.rows);
      if (this.hookPhase === 'waiting') this.scheduleHook(false);
      else this.flushPendingRaw();
    } catch (err) {
      if (!this.closed) await this.disconnect({ tone: 'error', text: humanizeSshError(err) });
    }
  }

  private async disconnect(notice?: Notice): Promise<void> {
    if (this.shellClosing && !this.session && !this.raw) return;
    this.closeSession();
    await this.showConnections(notice);
  }

  private closeSession(): void {
    this.shellClosing = true;
    this.clearShellTimer();
    this.clearHookTimer();
    this.hookPhase = 'done';
    this.resetFollow();
    this.browseEpoch += 1;
    this.stopTransfers();
    const session = this.session;
    this.session = null;
    this.remote = null;
    this.pieceQueue = [];
    session?.close();
    this.leaveRaw();
    this.host.setTitle?.(undefined);
  }

  /**
   * The connection dropped: say why, and offer Reconnect (U3). With
   * easySsh.autoReconnect it retries by itself a few times.
   */
  private async connectionLost(reason: string, afterRetry = false): Promise<void> {
    const record = this.lostRecord ?? this.connectedRecord ?? undefined;
    const cwd = this.remote?.cwd || this.lostCwd;
    if (this.session || this.raw) this.closeSession();
    this.dropReason = undefined;
    if (!record) {
      await this.showConnections({ tone: 'error', text: `The connection closed: ${reason}` });
      return;
    }
    this.lostRecord = record;
    this.lostCwd = cwd;
    this.host.log(`Connection to ${record.name} lost: ${reason}`);
    this.host.setStatus(`${record.name}: connection lost`);
    this.screen = { kind: 'lost', name: record.name, reason, choice: 0 };
    this.draw();
    if (!afterRetry) this.reconnectTries = 0;
    if (this.host.autoReconnect?.() && this.reconnectTries < RECONNECT_DELAYS.length) {
      let left = RECONNECT_DELAYS[this.reconnectTries];
      this.reconnectTries += 1;
      this.screen = { ...this.screen, retryIn: left };
      this.draw();
      this.reconnectTimer = setInterval(() => {
        left -= 1;
        if (this.closed || this.screen.kind !== 'lost') {
          this.clearReconnect();
          return;
        }
        if (left > 0) {
          this.screen = { ...this.screen, retryIn: left };
          this.draw();
          return;
        }
        this.clearReconnect();
        const again = this.lostRecord;
        if (again) void this.enqueue(() => this.connect(again, this.lostCwd));
      }, 1000);
    }
  }

  private clearReconnect(): void {
    if (!this.reconnectTimer) return;
    clearInterval(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private async openRemote(remotePath: string): Promise<void> {
    const remote = this.remote;
    if (!remote || !remote.files) return;
    const now = Date.now();
    if (remotePath === this.lastOpenPath && now - this.lastOpenAt < 300) return;
    this.lastOpenPath = remotePath;
    this.lastOpenAt = now;
    const entry = remote.entries.find((item) => item.path === remotePath);
    if (!entry) {
      if (!this.session) return;
      try {
        const resolved = await this.session.resolve(remotePath, remote.cwd);
        if (resolved.kind === 'dir') this.clicked({ name: remoteBasename(remotePath), path: resolved.path, kind: 'folder' });
        else if (resolved.kind === 'file') this.clicked({ name: remoteBasename(remotePath), path: resolved.path, kind: 'file' });
      } catch (err) {
        this.showNotice('error', humanizeSshError(err));
      }
      return;
    }
    await this.openEntry(entry);
  }

  /**
   * A click on a name opens the action menu. A host without one (tests, older
   * embedders) downloads directly: files, and folders with everything in them.
   */
  private async openEntry(entry: BrowseEntry): Promise<void> {
    const remote = this.remote;
    if (!remote || entry.name === '..' || entry.name === '.') return;
    if (entry.kind === 'dir') {
      this.clicked({ name: entry.name, path: entry.path, kind: 'folder', mtime: entry.mtime });
      return;
    }
    if (entry.kind === 'file') {
      this.clicked({ name: entry.name, path: entry.path, kind: 'file', size: entry.size, mtime: entry.mtime });
      return;
    }
    if (!this.session) return;
    try {
      // A symlink is followed at the top level, like ssh's scp -r would. The
      // menu then acts on the link's own path, so Rename and Delete change the link.
      const resolved = await this.session.resolve(entry.path, remote.cwd);
      if (resolved.kind === 'dir') this.clicked({ name: entry.name, path: entry.path, kind: 'folder', linkTarget: resolved.path });
      else if (resolved.kind === 'file') this.clicked({ name: entry.name, path: entry.path, kind: 'file', linkTarget: resolved.path });
      else this.showNotice('error', `${entry.name} is not a regular file or folder`);
    } catch (err) {
      this.showNotice('error', humanizeSshError(err));
    }
  }

  /** A name was clicked: open the action menu, or download when the host has none. */
  private clicked(target: ActionTarget): void {
    if (!this.host.showActionMenu) {
      this.download(target.name, target.linkTarget ?? target.path, target.kind);
      return;
    }
    // Outside the app queue: the menu and its dialogs wait for the user, and
    // folder tracking and listings must keep running meanwhile.
    void this.runActionMenu(target).catch((err: unknown) => {
      this.host.log(err instanceof Error ? err.stack || err.message : String(err));
      this.host.notify?.('error', humanizeSshError(err));
    });
  }

  /** The menu actions this session supports for a target. */
  private actionsFor(session: FileSession, target: ActionTarget, text: boolean): Set<FileAction> {
    const can = new Set<FileAction>(['download']);
    if (target.kind === 'folder') can.add('upload');
    if (target.kind === 'file' && text && this.canEdit(session)) can.add('open');
    if (session.rename && this.host.askRename) can.add('rename');
    if (session.remove && this.host.confirm) can.add('delete');
    return can;
  }

  /** True while the connection an action started on is still the one shown. */
  private alive(session: FileSession, epoch: number): boolean {
    return !this.closed && this.session === session && this.browseEpoch === epoch && this.remote !== null;
  }

  private async runActionMenu(target: ActionTarget): Promise<void> {
    const host = this.host;
    const session = this.session;
    if (!session || !this.remote || !this.remote.files || !host.showActionMenu) return;
    const epoch = this.browseEpoch;
    const text = target.kind === 'file' && this.canEdit(session) ? await this.isText(session, target) : false;
    if (!this.alive(session, epoch)) return;
    const menu = actionMenu(target, { downloadLabel: this.downloadLabel(), items: target.kind === 'folder' ? 'counting' : undefined });
    menu.items = onlyActions(menu.items, this.actionsFor(session, target, text));
    const picked = await host.showActionMenu(menu, this.describeTarget(session, target));
    if (!picked || !this.alive(session, epoch)) return;
    this.host.log(`${picked} ${target.path}`);
    switch (picked) {
      case 'download':
        await this.menuDownload(session, epoch, target);
        return;
      case 'upload':
        await this.menuUpload(session, epoch, target);
        return;
      case 'open':
        await this.menuOpen(session, epoch, target);
        return;
      case 'rename':
        await this.menuRename(session, epoch, target);
        return;
      case 'delete':
        await this.menuDelete(session, epoch, target);
        return;
      default: {
        const unreachable: never = picked;
        return unreachable;
      }
    }
  }

  /** A better menu placeholder once cheap facts are in: a folder's item count, a link's size. */
  private describeTarget(session: FileSession, target: ActionTarget): Promise<string | undefined> {
    if (target.kind === 'folder') {
      return session.list(target.linkTarget ?? target.path)
        .then((entries) => targetSummary(target, entries.length))
        .catch(() => targetSummary(target));
    }
    if (target.size === undefined && session.stat) {
      return session.stat(target.linkTarget ?? target.path)
        .then((found) => {
          target.size = found.size;
          target.mtime = found.mtime;
          return targetSummary(target);
        })
        .catch(() => undefined);
    }
    return Promise.resolve(undefined);
  }

  /** Download: a save dialog for a file, a folder picker for a folder. Cancel does nothing. */
  private async menuDownload(session: FileSession, epoch: number, target: ActionTarget): Promise<void> {
    const folder = this.host.downloadFolder();
    const source = target.linkTarget ?? target.path;
    if (target.kind === 'file') {
      if (!this.host.pickSaveFile) {
        this.download(target.name, source, 'file', { menu: true });
        return;
      }
      const local = await this.host.pickSaveFile(folder, safeFileName(target.name));
      if (!local || !this.alive(session, epoch)) return;
      this.download(target.name, source, 'file', { exact: local, menu: true });
      return;
    }
    if (!this.host.pickDownloadParent) {
      this.download(target.name, source, 'folder', { menu: true });
      return;
    }
    const parent = await this.host.pickDownloadParent(folder, target.name);
    if (!parent || !this.alive(session, epoch)) return;
    this.download(target.name, source, 'folder', { folder: parent, menu: true });
  }

  /** Upload into the clicked folder (the menu offers Upload for folders only). */
  private async menuUpload(session: FileSession, epoch: number, target: ActionTarget): Promise<void> {
    if (!this.host.pickUploadFiles) return;
    const dir = uploadDir(target);
    const paths = await this.host.pickUploadFiles(dir);
    if (!paths || paths.length === 0 || !this.alive(session, epoch)) return;
    this.queueUpload(session, paths, dir, { menu: true });
  }

  /** Open needs an editor host and whole-file SFTP reads and writes. */
  private canEdit(session: FileSession): boolean {
    return this.host.openRemoteFile !== undefined && session.readWhole !== undefined && session.writeWhole !== undefined;
  }

  /**
   * Whether the menu offers Open: text by name, binary by name, otherwise by the
   * first bytes (no NUL, valid UTF-8). A sniff that fails or is slow offers Open.
   */
  private async isText(session: FileSession, target: ActionTarget): Promise<boolean> {
    const byName = classifyName(target.name);
    if (byName !== 'unknown') return byName === 'text';
    if (target.size === 0 || !session.readHead) return true;
    const path = target.linkTarget ?? target.path;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), SNIFF_MS);
    });
    try {
      const head = await Promise.race([session.readHead(path, SNIFF_BYTES).catch(() => undefined), late]);
      if (!head) {
        this.host.log(`Could not read the start of ${path} in time; offering Open`);
        return true;
      }
      return looksLikeText(head);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Open: load the file into a VS Code editor tab. Big files ask first. */
  private async menuOpen(session: FileSession, epoch: number, target: ActionTarget): Promise<void> {
    const open = this.host.openRemoteFile;
    if (!open) return;
    let size = target.size;
    if (size === undefined && session.stat) size = await session.stat(target.linkTarget ?? target.path).then((found) => found.size).catch(() => undefined);
    if (!this.alive(session, epoch)) return;
    if (size !== undefined && size > OPEN_ASK_BYTES && this.host.choose) {
      const question = largeOpenQuestion(target, size);
      const answer = await this.host.choose(question.message, question.detail, ['Open Anyway', 'Download']);
      if (!answer || !this.alive(session, epoch)) return;
      if (answer === 'Download') {
        await this.menuDownload(session, epoch, target);
        return;
      }
    }
    try {
      await open.call(this.host, target.path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.host.log(`Could not open ${target.path}: ${message}`);
      this.host.notify?.('error', `Could not open ${target.name}. ${message}`);
    }
  }

  /** Rename: ask for the new name, confirm, then rename over SFTP. */
  private async menuRename(session: FileSession, epoch: number, target: ActionTarget): Promise<void> {
    const rename = session.rename;
    if (!rename || !this.host.askRename) return;
    const parent = remoteDirname(target.path);
    const check = async (value: string): Promise<string | undefined> => {
      const problem = renameProblem(value, target.name);
      if (problem) return problem;
      if (session.exists && (await session.exists(remoteJoin(parent, value)).catch(() => false))) return `"${value}" already exists in ${parent}`;
      return undefined;
    };
    const next = await this.host.askRename({
      name: target.name,
      kind: target.kind,
      parent,
      selection: renameSelection(target.name, target.kind),
      validate: check,
    });
    if (next === undefined || !this.alive(session, epoch)) return;
    const problem = await check(next);
    if (problem) {
      this.host.notify?.('error', `Not renamed. ${problem}`);
      return;
    }
    const question = renameQuestion(target, next);
    if (this.host.confirm && !(await this.host.confirm(question.message, question.detail, 'Rename'))) return;
    if (!this.alive(session, epoch)) return;
    try {
      await rename.call(session, target.path, remoteJoin(parent, next));
    } catch (err) {
      this.host.log(`Rename of ${target.path} failed: ${humanizeSshError(err)}`);
      this.host.notify?.('error', `Rename failed. ${humanizeSshError(err)}`);
      return;
    }
    this.host.log(`Renamed ${target.path} to ${remoteJoin(parent, next)}`);
    this.host.notify?.('info', `Renamed "${target.name}" to "${next}"`);
    void this.enqueue(() => this.refreshCwd());
  }

  /** Delete: count a folder's files, ask with the count, then delete over SFTP. */
  private async menuDelete(session: FileSession, epoch: number, target: ActionTarget): Promise<void> {
    const remove = session.remove;
    // Never delete without a confirmation.
    if (!remove || !this.host.confirm) return;
    let count: TreeCount | undefined;
    if (target.kind === 'folder' && !target.linkTarget && session.countTree) {
      this.host.setStatus(`Counting files in ${target.name}…`);
      count = await session.countTree(target.path, { cap: DELETE_COUNT_CAP, timeoutMs: DELETE_COUNT_MS }).catch((err: unknown) => {
        this.host.log(`Could not count ${target.path}: ${humanizeSshError(err)}`);
        return undefined;
      });
      this.restoreStatus();
    }
    if (!this.alive(session, epoch)) return;
    const question = deleteQuestion(target, count);
    if (!(await this.host.confirm(question.message, question.detail, 'Delete'))) return;
    if (!this.alive(session, epoch)) return;
    const abort = new AbortController();
    const total = count && !count.capped ? count.files + count.folders + 1 : undefined;
    let progress: ProgressHandle | undefined;
    let done = 0;
    let reported = 0;
    const report = () => {
      reported = Date.now();
      progress?.report(total ? `${done} of ${total} items` : `${done} items`, total ? Math.min(1, done / total) : undefined);
    };
    const timer = target.kind === 'folder' && !target.linkTarget
      ? setTimeout(() => {
        progress = this.host.showProgress?.(`Easy SSH: deleting ${target.name}/`, () => abort.abort());
        report();
      }, MENU_NOTIFY_MS)
      : undefined;
    const what = target.linkTarget ? 'link' : target.kind;
    try {
      const result = await remove.call(session, target.path, {
        signal: abort.signal,
        onProgress: (items) => {
          done = items;
          if (Date.now() - reported >= 100) report();
        },
      });
      const inside = target.kind === 'folder' && !target.linkTarget
        ? ` (${result.files} file${result.files === 1 ? '' : 's'}, ${Math.max(0, result.folders - 1)} subfolder${result.folders === 2 ? '' : 's'})`
        : '';
      this.host.log(`Deleted ${target.path}${inside}`);
      this.host.notify?.('info', `Deleted ${what} "${target.name}"${inside}`);
    } catch (err) {
      if (abort.signal.aborted || err instanceof TransferCancelled) {
        this.host.log(`Stopped deleting ${target.path} after ${done} items`);
        this.host.notify?.('info', `Stopped deleting "${target.name}" after ${done} items. Those are gone; the rest is still there.`);
      } else {
        this.host.log(`Delete of ${target.path} failed after ${done} items: ${humanizeSshError(err)}`);
        this.host.notify?.('error', `Delete failed${done ? ` after ${done} items` : ''}. ${humanizeSshError(err)}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
      progress?.close();
    }
    void this.enqueue(() => this.refreshCwd());
  }

  /** The status bar shows the connection and folder again. */
  private restoreStatus(): void {
    if (this.closed || !this.remote || this.transferAbort) return;
    this.host.setStatus(this.remote.files ? `${this.remote.title}:${this.remote.cwd}` : `${this.remote.title} (terminal only)`);
  }

  /**
   * Queue a download of a file or a whole folder. By default it goes into the
   * download folder under a free name; the action menu passes the folder (or the
   * exact file path) the user picked.
   */
  private download(
    name: string,
    remotePath: string,
    kind: 'file' | 'folder',
    where: { folder?: string; exact?: string; menu?: boolean } = {},
  ): void {
    const session = this.session;
    if (!session || !this.remote) return;
    const folder = where.folder ?? this.host.downloadFolder();
    const settings = this.transferSettings();
    this.enqueueTransfer({
      label: kind === 'folder' ? `${name}/` : name,
      direction: 'download',
      notifyAfterMs: where.menu ? MENU_NOTIFY_MS : undefined,
      run: async (signal, onProgress) => {
        const options = { signal, concurrency: settings.concurrency, onProgress };
        if (kind === 'file') {
          const result = where.exact && session.downloadTo
            ? await session.downloadTo(remotePath, where.exact, options)
            : await session.download(remotePath, folder, name, options);
          const grew = result.grew ? ' (it grew while downloading)' : '';
          this.host.log(`Downloaded ${remotePath} to ${result.localPath}${grew}`);
          this.finishTransfer(`Downloaded to ${result.localPath}`);
          if (where.menu) this.host.notify?.('info', `Downloaded ${name} to ${result.localPath}${grew}`);
          return;
        }
        const result = await session.downloadFolder(remotePath, folder, name, { ...options, maxFiles: settings.maxFiles });
        const skipped = result.skipped.length ? `, skipped ${result.skipped.length}` : '';
        const text = `Downloaded ${result.files} file${result.files === 1 ? '' : 's'} to ${result.localPath}${skipped}`;
        this.host.log(text);
        for (const item of result.skipped) this.host.log(`  skipped ${item.path} (${item.reason})`);
        this.finishTransfer(text);
        if (result.skipped.length > 0) {
          const kinds = [...new Set(result.skipped.map((item) => item.reason))].join(', ');
          this.host.notify?.('info', `${text} (${kinds}). The list is in the Easy SSH log.`);
        } else if (where.menu) this.host.notify?.('info', text);
      },
    });
  }

  private async upload(paths: string[]): Promise<void> {
    if (!this.session || !this.remote) return;
    const session = this.session;
    const epoch = this.browseEpoch;
    let cwd = this.remote.cwd;
    let asUser = '';
    const names = paths.map((item) => item.split(/[/\\]/).filter(Boolean).pop() || item);
    const stale = await this.staleCwd();
    if (epoch !== this.browseEpoch || !this.remote || this.session !== session) return;
    // Waiting for the prompt hook may have moved the folder (a report, or followed cd lines).
    cwd = this.remote.cwd;
    if (stale) {
      const home = await session.resolve('~', cwd).then((found) => found.path).catch(() => undefined);
      const question = staleUploadQuestion(stale, cwd, this.loginUser, this.hostName, names, home);
      this.host.log(`Upload of ${names.join(', ')}: ${question.detail}`);
      const picked = this.host.confirmUpload ? await this.host.confirmUpload(question) : undefined;
      if (epoch !== this.browseEpoch || !this.remote || this.session !== session) return;
      if (!picked) {
        this.finishTransfer('Upload cancelled');
        return;
      }
      cwd = picked;
      asUser = ` as ${this.loginUser}`;
    }
    this.queueUpload(session, paths, cwd, { stale, asUser });
  }

  /** Queue an upload of local paths into the remote folder target. */
  private queueUpload(
    session: FileSession,
    paths: string[],
    target: string,
    context: { stale?: StaleCwd; asUser?: string; menu?: boolean } = {},
  ): void {
    const { stale, menu } = context;
    const asUser = context.asUser ?? '';
    const names = paths.map((item) => item.split(/[/\\]/).filter(Boolean).pop() || item);
    const settings = this.transferSettings();
    this.enqueueTransfer({
      label: paths.length === 1 ? names[0] : `${paths.length} items`,
      direction: 'upload',
      notifyAfterMs: menu ? MENU_NOTIFY_MS : undefined,
      run: async (signal, onProgress) => {
        try {
          const result = await session.upload(paths, target, {
            signal,
            concurrency: settings.concurrency,
            maxFiles: settings.maxFiles,
            onProgress,
            resolveConflict: (existing) => this.resolveConflict(existing, target),
          });
          const parts: string[] = [];
          if (result.skipped) parts.push(`skipped ${result.skipped} links or special files`);
          if (result.kept) parts.push(`kept ${result.kept} existing`);
          if (result.renamed.length) parts.push(`as ${result.renamed.join(', ')}`);
          const extra = parts.length ? ` (${parts.join('; ')})` : '';
          const text = result.uploaded === 0 && result.kept === 0 && result.skipped === 0
            ? 'Nothing to upload'
            : `Uploaded ${result.uploaded} to ${target}${asUser}${extra}`;
          this.host.log(text);
          this.finishTransfer(text);
          if (stale && result.uploaded > 0) {
            const move = stale.kind === 'user' && names.length === 1
              ? ` To move it, run sudo mv ${shellQuote(remoteJoin(target, names[0]))} <folder> in the terminal.`
              : '';
            this.host.notify?.('info', `${text}.${move}`);
          } else if (menu) this.host.notify?.('info', text);
          void this.enqueue(() => this.refreshCwd('the upload'));
        } catch (err) {
          if (err instanceof TransferError && err.remotePermissionDenied) {
            throw new TransferError(err.action, err.target, err.side, new Error(`${err.reason} (SFTP user ${this.loginUser})`));
          }
          throw err;
        }
      },
    });
  }

  private async resolveConflict(existing: string[], remoteDir: string): Promise<ConflictChoice> {
    if (!this.host.resolveConflict) return 'keep';
    return this.host.resolveConflict(existing, remoteDir);
  }

  private transferSettings(): { concurrency: number; maxFiles: number } {
    return this.host.transferSettings?.() ?? { concurrency: 32, maxFiles: 5000 };
  }

  /** Add a transfer. It starts now, or after the ones already queued (U5). */
  private enqueueTransfer(job: TransferJob): void {
    this.transferQueue.push(job);
    if (this.transferAbort) {
      const waiting = this.transferQueue.length;
      this.host.log(`Queued ${job.label} (${waiting} waiting)`);
      // Show the new queue length in the status bar and the notification.
      if (this.refreshProgress) this.refreshProgress();
      else this.host.setStatus(`${this.transferLabel} · +${waiting} queued`);
      return;
    }
    void this.runTransfers();
  }

  private async runTransfers(): Promise<void> {
    const epoch = this.browseEpoch;
    while (this.transferQueue.length > 0 && epoch === this.browseEpoch && !this.closed) {
      const job = this.transferQueue.shift() as TransferJob;
      const abort = new AbortController();
      this.transferAbort = abort;
      this.transferLabel = job.label;
      this.host.transferActive?.(true);
      const started = Date.now();
      let shown = false;
      let last: TransferProgress | undefined;
      const onProgress = (state: TransferProgress) => {
        if (epoch !== this.browseEpoch || abort.signal.aborted) return;
        last = state;
        const text = formatProgress(state, Date.now() - started, this.transferQueue.length);
        this.host.setStatus(`${job.label}: ${text}`);
        const late = job.notifyAfterMs !== undefined && Date.now() - started >= job.notifyAfterMs;
        if (!shown && (wantsNotification(state) || late) && this.host.showProgress) {
          shown = true;
          this.progress = this.host.showProgress(`Easy SSH: ${job.label}`, () => abort.abort());
        }
        this.progress?.report(text, progressFraction(state));
      };
      this.refreshProgress = () => {
        if (last) onProgress(last);
      };
      this.host.setStatus(`${job.label}: starting`);
      try {
        await job.run(abort.signal, onProgress);
      } catch (err) {
        if (epoch === this.browseEpoch) {
          const cancelled = abort.signal.aborted || err instanceof TransferCancelled;
          const message = cancelled ? `Cancelled ${job.label}` : humanizeSshError(err);
          this.host.log(`${job.label} failed: ${message}`);
          if (err instanceof Error && !cancelled && !(err instanceof TransferError)) this.host.log(err.stack || err.message);
          this.finishTransfer(message);
          if (!cancelled) this.host.notify?.('error', `${job.direction === 'upload' ? 'Upload' : 'Download'} failed. ${message}`);
        }
      } finally {
        this.refreshProgress = undefined;
        this.progress?.close();
        this.progress = undefined;
        if (this.transferAbort === abort) this.transferAbort = null;
      }
    }
    this.host.transferActive?.(false);
  }

  /** Cancel the running transfer and drop the queued ones. */
  private stopTransfers(): void {
    this.transferQueue = [];
    this.transferAbort?.abort();
    this.progress?.close();
    this.progress = undefined;
  }

  /** List the shell's folder again soon; several prompts in a row make one listing. */
  private scheduleListingRefresh(): void {
    if (!this.remote || !this.remote.files || this.closed) return;
    if (this.listingTimer) clearTimeout(this.listingTimer);
    this.listingTimer = setTimeout(() => {
      this.listingTimer = undefined;
      void this.refreshSameFolder();
    }, LISTING_DEBOUNCE_MS);
  }

  /**
   * Re-list the current folder after a command, so names it created become
   * clickable. A big folder is only re-listed when its modification time changed.
   */
  private async refreshSameFolder(): Promise<void> {
    if (this.listingBusy) {
      this.listingAgain = true;
      return;
    }
    const session = this.session;
    const remote = this.remote;
    if (!session || !remote || !remote.files || remote.lost || this.closed) return;
    const cwd = remote.cwd;
    const epoch = this.browseEpoch;
    this.listingBusy = true;
    try {
      let folderTime: number | undefined;
      if (remote.entries.length > LISTING_ALWAYS_MAX && session.stat) {
        folderTime = await session.stat(cwd).then((found) => found.mtime).catch(() => undefined);
        if (folderTime !== undefined && this.listedFolder?.path === cwd && this.listedFolder.mtime === folderTime) return;
      }
      const entries = withParent(cwd, await session.list(cwd));
      if (epoch !== this.browseEpoch || this.session !== session || !this.remote || this.remote.cwd !== cwd) return;
      this.remote = { ...this.remote, entries };
      this.listedFolder = folderTime === undefined ? undefined : { path: cwd, mtime: folderTime };
    } catch {
      // The folder may have become unreadable. Keep the previous list.
    } finally {
      this.listingBusy = false;
      if (this.listingAgain) {
        this.listingAgain = false;
        this.scheduleListingRefresh();
      }
    }
  }

  private async refreshListing(cwd: string): Promise<void> {
    if (!this.session || !this.remote || !this.remote.files) return;
    const epoch = this.browseEpoch;
    try {
      const entries = withParent(cwd, await this.session.list(cwd));
      if (epoch !== this.browseEpoch || !this.remote) return;
      this.remote = { ...this.remote, cwd, entries, lost: false };
      if (!this.transferAbort) this.host.setStatus(`${this.remote.title}:${cwd}`);
    } catch {
      // The shell can be in a directory SFTP is not allowed to read. Keep the previous list.
    }
  }

  /** List the shell's folder again, e.g. after an upload, rename, or delete changed it. */
  private async refreshCwd(after = 'the change'): Promise<void> {
    if (!this.session || !this.remote || !this.remote.files) return;
    const epoch = this.browseEpoch;
    const cwd = this.remote.cwd;
    try {
      const entries = withParent(cwd, await this.session.list(cwd));
      if (epoch !== this.browseEpoch || !this.remote) return;
      this.remote = { ...this.remote, entries };
    } catch (err) {
      this.host.log(`Could not list ${cwd} after ${after}: ${humanizeSshError(err)}`);
    }
  }

  private async importConfig(): Promise<void> {
    const report = await this.host.importConfig();
    await this.showConnections({ tone: report.ok ? 'ok' : 'error', text: report.message });
  }

  private async pickFolder(): Promise<void> {
    const picked = await this.host.chooseDownloadFolder();
    if (!picked) return;
    this.showNotice('ok', `Downloads go to ${shortenPath(picked, this.host.home(), 80)}`);
  }

  private finishTransfer(text: string): void {
    const remote = this.remote;
    if (!remote) return;
    this.host.setStatus(text);
    this.clearStatusTimer();
    const epoch = this.browseEpoch;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      if (this.closed || epoch !== this.browseEpoch || !this.remote || this.transferAbort) return;
      this.host.setStatus(this.remote.files ? `${this.remote.title}:${this.remote.cwd}` : `${this.remote.title} (terminal only)`);
    }, 4000);
  }

  private clearStatusTimer(): void {
    if (!this.statusTimer) return;
    clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
  }

  private showNotice(tone: Notice['tone'], text: string): void {
    if (this.raw) {
      this.host.setStatus(text);
      return;
    }
    if (
      this.screen.kind === 'connections' ||
      this.screen.kind === 'wizard' ||
      this.screen.kind === 'confirm' ||
      this.screen.kind === 'pick'
    ) {
      this.screen = { ...this.screen, notice: { tone, text } };
      this.draw();
    }
  }

  private draw(): void {
    if (this.raw) return;
    const frame = render(this.screen, {
      cols: this.cols,
      rows: this.rows,
      downloadFolder: this.host.downloadFolder(),
      home: this.host.home(),
    });
    this.links = frame.links;
    this.emit(paint(frame));
  }
}

/** Whether a `cd` target exists as a folder, as far as the SFTP user can tell. */
async function folderCheck(session: FileSession, path: string): Promise<boolean | undefined> {
  try {
    const found = await session.resolve(path, '/');
    if (found.kind === 'dir') return true;
    if (found.kind === 'file') return false;
    return undefined;
  } catch (err) {
    // SFTP status 2 is "no such file": the shell's cd failed too.
    return (err as { code?: unknown } | null)?.code === 2 ? false : undefined;
  }
}

/** True when a local path is the home folder or inside it. */
export function isInside(file: string, home: string): boolean {
  if (!home) return true;
  const windows = /^[A-Za-z]:|^\\\\/.test(home);
  const clean = (value: string) => {
    const unified = windows ? value.replace(/\//g, '\\').toLowerCase() : value;
    return unified.replace(/[\\/]+$/, '');
  };
  const root = clean(home);
  const target = clean(file.startsWith('~') ? home + file.slice(1) : file);
  const sep = windows ? '\\' : '/';
  return target === root || target.startsWith(root + sep);
}

function slashTargets(items: ConnectionItem[]): SlashTarget[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    description: `${item.userHost} · ${item.detail}`,
  }));
}

function move(selected: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, selected + delta));
}
