import { randomUUID } from 'crypto';
import { withParent } from '../entries';
import { HostKeyChangedError, TransferCancelled, TransferError, humanizeSshError } from '../ssh/errors';
import { remoteBasename, remoteJoin } from '../remotePath';
import { RawShellTap, type RawShellUpdate } from '../ssh/rawShell';
import { shellQuote } from '../ssh/shellFeed';
import { safeFileName, shortenPath } from '../text';
import type { BrowseEntry, ConnectionRecord, Notice, TransferState } from '../types';
import type { AppHost, FileSession } from './host';
import type { InputEvent } from './input';
import { completionQuery, completionSuffix, InputLine } from './complete';
import { encodePaste, pullRawInput, type RawInputPiece } from './rawInput';
import { defaultSlashPick, matchSlashCommands, parseConnectionCommand, type SlashTarget } from './commands';
import { peelPointer, type PointerEvent } from './pointer';
import { linkAt, nameSpans, paint, render, sessionHint, type LineLink } from './render';
import { Viewport } from './viewport';
import { classifyStale, isHostSwitch, isUserSwitch, staleUploadQuestion, type StaleCwd } from './cwdTracking';
import type { ConnectionItem, Screen } from './screen';
import { applyChoice, applyStep, choiceIndex, choiceOptions, draftFromRecord, emptyDraft, nextStep, prevStep, toConnection } from './wizard';

/** Connected shell. The login PTY is shown directly; this only tracks the directory. */
interface RemoteShell {
  title: string;
  cwd: string;
  entries: BrowseEntry[];
  transfer?: TransferState;
}

/** xterm mouse reporting, used only in plain-click mode. */
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l';
/** How long after Enter the prompt hook may take to report before the folder counts as unknown. */
const REPORT_GRACE_MS = 1500;

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
  private transferAbort: AbortController | null = null;
  private tap = new RawShellTap();
  private raw = false;
  private remoteAlt = false;
  private remotePaste = false;
  private rawBuffer = '';
  private pendingRaw = '';
  private rawTimer: ReturnType<typeof setTimeout> | undefined;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private shellClosing = false;
  private shellTimer: ReturnType<typeof setTimeout> | undefined;
  private trustRecord: ConnectionRecord | null = null;
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
  /** Folder reports from the prompt hook since this connection opened. */
  private cwdReports = 0;
  /** When a command was submitted that the prompt hook has not answered yet. */
  private awaitingSince: number | undefined;
  /** Command lines submitted since the last folder report (null when the line was not tracked). */
  private pendingCommands: (string | null)[] = [];
  private reportWaiters: (() => void)[] = [];

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
    if (data.includes('\x03')) this.transferAbort?.abort();
    if (!this.session?.hasShell()) {
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
    void this.enqueue(async () => {
      for (const event of events) await this.onEvent(event);
    });
  }

  activatePath(remotePath: string): void {
    if (this.raw && this.remoteAlt) return;
    void this.enqueue(() => this.openRemote(remotePath));
  }

  linkFor(line: string): LineLink[] {
    if (this.raw) {
      if (this.remoteAlt || !this.remote) return [];
      return nameSpans(line, this.remote.entries, this.downloadLabel());
    }
    const found = this.links.get(line) ?? this.links.get(line.trimEnd());
    if (found) return found;
    const trimmed = line.trimEnd();
    for (const [key, value] of this.links) {
      if (key.trimEnd() === trimmed) return value;
    }
    return [];
  }

  onRemoteClose(): void {
    void this.enqueue(async () => {
      if (this.closed || this.shellClosing || !this.session) return;
      if (!this.remote && this.screen.kind !== 'connecting') return;
      await this.disconnect({ tone: 'error', text: 'The connection closed' });
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.browseEpoch += 1;
    this.shellClosing = true;
    this.clearShellTimer();
    this.clearRawTimer();
    this.clearStatusTimer();
    this.connectAbort?.abort();
    this.transferAbort?.abort();
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
        await this.onTrust(event);
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
      return;
    }
    if (this.transferAbort) {
      this.transferAbort.abort();
      return;
    }
    if (this.screen.kind === 'wizard') {
      await this.showConnections();
      return;
    }
    if (this.screen.kind === 'confirm' || this.screen.kind === 'trust' || this.screen.kind === 'pick') {
      this.trustRecord = null;
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
      if (record) await this.connect(record, false);
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
        if (record) await this.connect(record, false);
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

  private async onTrust(event: InputEvent): Promise<void> {
    if (this.screen.kind !== 'trust') return;
    const choice = await this.pickChoice(event, this.screen.choice, ['n', 'y']);
    if (choice === 'move' || choice === 'stay') return;
    const record = this.trustRecord;
    this.trustRecord = null;
    if (choice !== 1 || !record) {
      await this.showConnections({ tone: 'info', text: 'Host key was not trusted' });
      return;
    }
    await this.connect(record, true);
  }

  private async pickChoice(event: InputEvent, current: number, answers: [string, string]): Promise<number | 'move' | 'stay'> {
    if (this.screen.kind !== 'confirm' && this.screen.kind !== 'trust') return 'stay';
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
    if (!update.cwd || !this.remote || update.cwd === this.remote.cwd) return;
    this.remote = { ...this.remote, cwd: update.cwd };
    this.host.setStatus(`${this.remote.title}:${update.cwd}`);
    const cwd = update.cwd;
    void this.enqueue(() => this.refreshListing(cwd));
  }

  /** The prompt hook printed the folder, so the shell Easy SSH set up is at its prompt again. */
  private onCwdReport(altScreen: boolean, mouse: boolean): void {
    this.cwdReports += 1;
    this.awaitingSince = undefined;
    this.pendingCommands = [];
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
      if (line === '\u0000') this.pendingCommands.push(null);
      else if (line.trim()) this.pendingCommands.push(line.trim());
    }
    if (this.pendingCommands.length > 20) this.pendingCommands.splice(0, this.pendingCommands.length - 20);
  }

  /** Undefined while the tracked folder is current; otherwise why it is not. */
  private async staleCwd(): Promise<StaleCwd | undefined> {
    if (this.awaitingSince === undefined) return undefined;
    const wait = REPORT_GRACE_MS - (Date.now() - this.awaitingSince);
    if (wait > 0) await this.waitForReport(wait);
    if (this.awaitingSince === undefined) return undefined;
    const commands = this.pendingCommands;
    const kind = classifyStale(commands);
    const command = kind === 'user'
      ? commands.find(isUserSwitch)
      : kind === 'host'
        ? commands.find(isHostSwitch)
        : commands.find((line) => !!line);
    return { kind, command: command ?? null, everReported: this.cwdReports > 0 };
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
    void this.enqueue(async () => {
      if (this.shellClosing || this.closed || !this.remote) return;
      await this.disconnect();
    });
  }

  private armShellFallback(): void {
    this.clearShellTimer();
    const epoch = this.browseEpoch;
    this.shellTimer = setTimeout(() => {
      this.shellTimer = undefined;
      if (epoch !== this.browseEpoch || this.tap.ready || !this.raw || this.closed) return;
      this.applyShellUpdate(this.tap.release());
    }, 1200);
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
    const hint = sessionHint(this.host.clickLabel?.() ?? (this.plainClick ? 'Click' : 'Ctrl+click'));
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

  private forwardPiece(piece: RawInputPiece): void {
    if (!this.session?.hasShell() || !this.remote) return;
    if (piece.kind === 'paste') {
      this.inputLine.forget();
      this.writeOrUpload(piece.text, encodePaste(piece.text, this.remotePaste), false);
      return;
    }
    if (this.remoteAlt) {
      this.inputLine.forget();
      this.writeOrUpload(piece.text, piece.text, false);
      return;
    }
    let index = 0;
    while (index < piece.text.length) {
      const tab = piece.text.indexOf('\t', index);
      const end = tab < 0 ? piece.text.length : tab;
      if (end > index) this.writeOrUpload(piece.text.slice(index, end), piece.text.slice(index, end), true);
      if (tab < 0) break;
      this.completeTab();
      index = tab + 1;
    }
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
    const link = linkAt(this.viewport.cells(event.row), event.col - 1, this.remote.entries, this.downloadLabel());
    if (link) this.activatePath(link.remotePath);
  }

  /** Send a typed chunk, or upload it when it is a local file drop. */
  private writeOrUpload(tracked: string, wire: string, remember: boolean): void {
    const drop = this.asDrop(tracked);
    if (drop) {
      this.inputLine.forget();
      if (this.remote?.transfer) this.showNotice('error', 'Wait for the current transfer to finish');
      else void this.enqueue(() => this.upload(drop));
      return;
    }
    if (!this.remoteAlt) this.noteSubmitted(tracked, remember);
    if (remember) this.inputLine.observe(tracked);
    this.writeShell(wire);
  }

  /**
   * Finish a remote path from the directory listing and insert only the missing suffix.
   * Anything else, including a second Tab on an ambiguous name, is one Tab for the shell.
   */
  private completeTab(): void {
    const session = this.session;
    const line = this.inputLine.text();
    const cwd = this.remote?.cwd ?? '';
    const query = session && line !== null && !this.remoteAlt ? completionQuery(line, cwd) : null;
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
    if (!this.remote || text.length < 2) return null;
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

  private async connect(record: ConnectionRecord, acceptChangedKey: boolean): Promise<void> {
    this.session?.close();
    this.session = null;
    this.browseEpoch += 1;
    const abort = new AbortController();
    this.connectAbort = abort;
    this.loginUser = record.username;
    this.hostName = record.host;
    this.cwdReports = 0;
    this.awaitingSince = undefined;
    this.pendingCommands = [];
    this.screen = { kind: 'connecting', label: `${record.username}@${record.host}:${record.port}` };
    this.draw();
    this.host.log(`Connecting to ${record.username}@${record.host}:${record.port}`);
    try {
      const opened = await this.host.connect(record, { acceptChangedKey, signal: abort.signal });
      if (this.closed || abort.signal.aborted) {
        opened.session.close();
        return;
      }
      this.session = opened.session;
      this.tap = new RawShellTap();
      this.shellClosing = false;
      this.remoteAlt = false;
      this.remotePaste = false;
      const entries = withParent(opened.cwd, await opened.session.list(opened.cwd));
      const notes: string[] = [];
      if (opened.trustedNewKey) notes.push(`Trusted the host key for ${record.host}`);
      if (opened.usedFallbackPath) notes.push('Remote path was not found. Opened your home directory');
      this.remote = { title: record.name, cwd: opened.cwd, entries };
      this.host.setStatus(`${record.name}:${opened.cwd}`);
      this.enterRaw(notes);
      try {
        await opened.session.openShell(
          this.cols,
          this.rows,
          (chunk) => this.onShellChunk(chunk),
          () => this.onShellClosed(),
        );
        this.session?.resizeShell(this.cols, this.rows);
        this.armShellFallback();
        this.flushPendingRaw();
      } catch (err) {
        if (!this.closed) await this.disconnect({ tone: 'error', text: humanizeSshError(err) });
      }
    } catch (err) {
      if (this.closed || abort.signal.aborted || err instanceof TransferCancelled) {
        if (!this.closed) await this.showConnections({ tone: 'info', text: 'Cancelled' });
        return;
      }
      if (err instanceof HostKeyChangedError) {
        this.trustRecord = record;
        this.screen = {
          kind: 'trust',
          hostLabel: `${err.host}:${err.port}`,
          fingerprint: err.fingerprint,
          choice: 0,
        };
        this.draw();
        return;
      }
      this.host.log(err instanceof Error ? err.message : String(err));
      await this.showConnections({ tone: 'error', text: humanizeSshError(err) });
    } finally {
      if (this.connectAbort === abort) this.connectAbort = null;
    }
  }

  private async disconnect(notice?: Notice): Promise<void> {
    if (this.shellClosing && !this.session && !this.raw) return;
    this.shellClosing = true;
    this.clearShellTimer();
    this.browseEpoch += 1;
    this.transferAbort?.abort();
    const session = this.session;
    this.session = null;
    this.remote = null;
    session?.close();
    this.leaveRaw();
    await this.showConnections(notice);
  }

  private enterDirectory(path: string): void {
    if (!this.remote || !this.session) return;
    this.session.writeShell(`cd ${shellQuote(path)}\n`);
  }

  private async openRemote(remotePath: string): Promise<void> {
    const remote = this.remote;
    if (!remote) return;
    const now = Date.now();
    if (remotePath === this.lastOpenPath && now - this.lastOpenAt < 300) return;
    this.lastOpenPath = remotePath;
    this.lastOpenAt = now;
    const entry = remote.entries.find((item) => item.path === remotePath);
    if (!entry) {
      if (!this.session) return;
      try {
        const resolved = await this.session.resolve(remotePath, remote.cwd);
        if (resolved.kind === 'dir') {
          this.enterDirectory(resolved.path);
          return;
        }
        if (resolved.kind === 'file') await this.download(remoteBasename(remotePath), resolved.path, 0);
      } catch (err) {
        this.showNotice('error', humanizeSshError(err));
      }
      return;
    }
    await this.openEntry(entry);
  }

  private async openEntry(entry: BrowseEntry): Promise<void> {
    const remote = this.remote;
    if (!remote) return;
    if (entry.name === '..' || entry.kind === 'dir') {
      this.enterDirectory(entry.path);
      return;
    }
    if (entry.kind === 'link' || entry.kind === 'other') {
      if (!this.session) return;
      try {
        const resolved = await this.session.resolve(entry.path, remote.cwd);
        if (resolved.kind === 'dir') {
          this.enterDirectory(resolved.path);
          return;
        }
        if (resolved.kind === 'file') {
          await this.download(entry.name, resolved.path, entry.size);
          return;
        }
      } catch (err) {
        this.showNotice('error', humanizeSshError(err));
        return;
      }
    }
    if (entry.kind === 'file' || entry.kind === 'link') await this.download(entry.name, entry.path, entry.size);
  }

  private async download(name: string, remotePath: string, size: number): Promise<void> {
    if (!this.session || !this.remote || this.remote.transfer) {
      this.showNotice('error', 'Wait for the current transfer to finish');
      return;
    }
    const localPath = this.host.localDownloadPath(safeFileName(name));
    const abort = new AbortController();
    this.transferAbort = abort;
    const epoch = this.browseEpoch;
    const transfer: TransferState = { direction: 'download', label: name, done: 0, total: size, index: 1, count: 1 };
    this.remote = { ...this.remote, transfer };
    this.showTransfer(transfer);
    try {
      await this.session.download(
        remotePath,
        localPath,
        (done, total) => {
          if (epoch !== this.browseEpoch || !this.remote?.transfer) return;
          const next = { ...this.remote.transfer, done, total };
          this.remote = { ...this.remote, transfer: next };
          this.showTransfer(next);
        },
        abort.signal,
      );
      if (epoch !== this.browseEpoch || !this.remote) return;
      const note = `Downloaded to ${localPath}`;
      this.host.log(note);
      this.remote = { ...this.remote, transfer: undefined };
      this.finishTransfer(note);
    } catch (err) {
      if (epoch !== this.browseEpoch || !this.remote) return;
      const message = abort.signal.aborted ? 'Download cancelled' : humanizeSshError(err);
      this.host.log(`Download of ${remotePath} failed: ${message}`);
      this.remote = { ...this.remote, transfer: undefined };
      this.finishTransfer(message);
      if (!abort.signal.aborted) this.host.notify?.('error', `Download failed. ${message}`);
    } finally {
      if (this.transferAbort === abort) this.transferAbort = null;
    }
  }

  private async upload(paths: string[]): Promise<void> {
    if (!this.session || !this.remote) return;
    if (this.remote.transfer) {
      this.showNotice('error', 'Wait for the current transfer to finish');
      return;
    }
    const session = this.session;
    const epoch = this.browseEpoch;
    let cwd = this.remote.cwd;
    let asUser = '';
    const names = paths.map((item) => item.split(/[/\\]/).filter(Boolean).pop() || item);
    const stale = await this.staleCwd();
    if (stale) {
      if (epoch !== this.browseEpoch || !this.remote || this.session !== session) return;
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
    const abort = new AbortController();
    this.transferAbort = abort;
    const transfer: TransferState = {
      direction: 'upload',
      label: paths.length === 1 ? paths[0].split(/[/\\]/).pop() || 'file' : `${paths.length} items`,
      done: 0,
      total: 0,
      index: 1,
      count: paths.length,
    };
    this.remote = { ...this.remote, transfer };
    this.showTransfer(transfer);
    try {
      const result = await this.session.upload(
        paths,
        cwd,
        (state) => {
          if (epoch !== this.browseEpoch || !this.remote) return;
          this.remote = { ...this.remote, transfer: state };
          this.showTransfer(state);
        },
        abort.signal,
      );
      if (epoch !== this.browseEpoch || !this.remote) return;
      const skipped = result.skipped ? `, skipped ${result.skipped}` : '';
      const text = result.uploaded === 0 && result.skipped === 0
        ? 'Nothing to upload'
        : `Uploaded ${result.uploaded} to ${cwd}${asUser}${skipped}`;
      this.host.log(text);
      this.remote = { ...this.remote, transfer: undefined };
      this.finishTransfer(text);
      if (stale && result.uploaded > 0) {
        const move = stale.kind === 'user' && names.length === 1
          ? ` To move it, run sudo mv ${shellQuote(remoteJoin(cwd, names[0]))} <folder> in the terminal.`
          : '';
        this.host.notify?.('info', `${text}.${move}`);
      }
      await this.refreshAfterUpload();
    } catch (err) {
      if (epoch !== this.browseEpoch || !this.remote) return;
      let message = abort.signal.aborted ? 'Upload cancelled' : humanizeSshError(err);
      if (err instanceof TransferError && err.remotePermissionDenied) message += ` (SFTP user ${this.loginUser})`;
      this.host.log(`Upload to ${cwd} failed: ${message}`);
      this.remote = { ...this.remote, transfer: undefined };
      this.finishTransfer(message);
      if (!abort.signal.aborted) this.host.notify?.('error', `Upload failed. ${message}`);
    } finally {
      if (this.transferAbort === abort) this.transferAbort = null;
    }
  }

  private async refreshListing(cwd: string): Promise<void> {
    if (!this.session || !this.remote) return;
    const epoch = this.browseEpoch;
    try {
      const entries = withParent(cwd, await this.session.list(cwd));
      if (epoch !== this.browseEpoch || !this.remote) return;
      this.remote = { ...this.remote, cwd, entries };
      this.host.setStatus(`${this.remote.title}:${cwd}`);
    } catch {
      // The shell can be in a directory SFTP is not allowed to read. Keep the previous list.
    }
  }

  /** Relist after an upload. A folder SFTP can write but not read must not turn a success into an error. */
  private async refreshAfterUpload(): Promise<void> {
    if (!this.session || !this.remote) return;
    const epoch = this.browseEpoch;
    const cwd = this.remote.cwd;
    try {
      const entries = withParent(cwd, await this.session.list(cwd));
      if (epoch !== this.browseEpoch || !this.remote) return;
      this.remote = { ...this.remote, entries, transfer: undefined };
    } catch (err) {
      this.host.log(`Could not list ${cwd} after the upload: ${humanizeSshError(err)}`);
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

  private showTransfer(state: TransferState): void {
    const pct = state.total > 0 ? ` ${Math.min(100, Math.floor((state.done / state.total) * 100))}%` : '';
    const action = state.direction === 'download' ? 'Downloading' : 'Uploading';
    const count = state.count > 1 ? ` (${state.index}/${state.count})` : '';
    this.host.setStatus(`${action} ${state.label}${count}${pct}`);
  }

  private finishTransfer(text: string): void {
    const remote = this.remote;
    if (!remote) return;
    this.host.setStatus(text);
    this.clearStatusTimer();
    const epoch = this.browseEpoch;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      if (this.closed || epoch !== this.browseEpoch || !this.remote || this.remote.transfer) return;
      this.host.setStatus(`${this.remote.title}:${this.remote.cwd}`);
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
