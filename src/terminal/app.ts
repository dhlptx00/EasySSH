import { randomUUID } from 'crypto';
import { withParent } from '../entries';
import { HostKeyChangedError, TransferCancelled, humanizeSshError } from '../ssh/errors';
import { remoteBasename } from '../remotePath';
import { displayWidth, safeFileName, shortenPath } from '../text';
import type { BrowseEntry, ConnectionRecord, Notice } from '../types';
import type { AppHost, FileSession } from './host';
import type { InputEvent } from './input';
import { defaultSlashPick, matchSlashCommands, parseConnectionCommand, type SlashTarget } from './commands';
import { sanitizeTerminal } from './ansi';
import { paint, render, type LineLink } from './render';
import type { ConnectionItem, Screen } from './screen';
import { parseRemoteCommand } from './shellCommand';
import { applyChoice, applyStep, choiceIndex, choiceOptions, draftFromRecord, emptyDraft, nextStep, prevStep, toConnection } from './wizard';

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
  private records = new Map<string, ConnectionRecord>();
  private session: FileSession | null = null;
  private links = new Map<string, LineLink[]>();
  private linePlains: string[] = [];
  private trackingMouse = false;
  private lastOpenPath = '';
  private lastOpenAt = 0;
  private cols = 80;
  private rows = 24;
  private queue: Promise<void> = Promise.resolve();
  private connectAbort: AbortController | null = null;
  private transferAbort: AbortController | null = null;
  private commandAbort: AbortController | null = null;
  private history: string[] = [];
  private historyAt = -1;
  private historyDraft = '';
  private trustRecord: ConnectionRecord | null = null;
  private editingId: string | undefined;
  private selectedId: string | undefined;
  private browseEpoch = 0;
  private closed = false;
  private drawTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: AppHost,
    private readonly emit: (data: string) => void,
  ) {}

  setSize(cols: number, rows: number): void {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.draw();
  }

  open(): void {
    void this.enqueue(() => this.showConnections());
  }

  onInput(events: InputEvent[]): void {
    const queued: InputEvent[] = [];
    for (const event of events) {
      if (event.type === 'mouse' && (event.action === 'move' || event.action === 'down')) this.paintPointer(event);
      else queued.push(event);
    }
    if (queued.length === 0) return;
    void this.enqueue(async () => {
      for (let index = 0; index < queued.length; index += 1) {
        const event = queued[index];
        if (await this.tryDrop(event)) {
          const next = queued[index + 1];
          if (next?.type === 'key' && next.key === 'enter') index += 1;
          continue;
        }
        await this.onEvent(event);
      }
    });
  }

  activatePath(remotePath: string): void {
    void this.enqueue(async () => {
      await this.flashPress(remotePath);
      await this.openRemote(remotePath);
    });
  }

  linkFor(line: string): LineLink[] {
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
      if (this.closed || !this.session) return;
      if (this.screen.kind !== 'browse' && this.screen.kind !== 'connecting') return;
      this.session = null;
      this.browseEpoch += 1;
      await this.showConnections({ tone: 'error', text: 'The connection closed' });
    });
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.browseEpoch += 1;
    if (this.drawTimer) clearTimeout(this.drawTimer);
    this.connectAbort?.abort();
    this.transferAbort?.abort();
    this.commandAbort?.abort();
    this.session?.close();
    this.session = null;
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
    if (event.type === 'mouse') {
      if (this.screen.kind === 'browse') await this.onBrowsePointer(event);
      return;
    }
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
      case 'browse':
        await this.onBrowse(event);
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
    if (this.screen.kind === 'browse') {
      if (this.commandAbort) {
        this.commandAbort.abort();
        return;
      }
      if (this.screen.command) {
        this.screen = { ...this.screen, command: '' };
        this.draw();
        return;
      }
      await this.disconnect();
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

  private async onBrowse(event: InputEvent): Promise<void> {
    if (this.screen.kind !== 'browse') return;
    if (this.screen.transfer || this.commandAbort) return;
    const screen = this.screen;
    if (event.type === 'key' && (event.key === 'up' || event.key === 'down')) {
      this.recallHistory(screen, event.key === 'up' ? -1 : 1);
      return;
    }
    if (event.type === 'key' && event.key === 'escape') {
      this.historyAt = -1;
      this.screen = { ...screen, command: '' };
      this.draw();
      return;
    }
    if (event.type === 'key' && (event.key === 'backspace' || event.key === 'delete')) {
      this.historyAt = -1;
      this.screen = { ...screen, command: [...screen.command].slice(0, -1).join('') };
      this.draw();
      return;
    }
    if (event.type === 'key' && event.key === 'ctrl-u') {
      this.historyAt = -1;
      this.screen = { ...screen, command: '' };
      this.draw();
      return;
    }
    if (event.type === 'text' || event.type === 'paste') {
      const extra = event.text.replace(/[\r\n]/g, '');
      if (!extra) return;
      this.historyAt = -1;
      this.screen = { ...screen, command: screen.command + extra };
      this.draw();
      return;
    }
    if (event.type !== 'key' || event.key !== 'enter') return;
    const line = screen.command;
    this.historyAt = -1;
    this.screen = { ...screen, command: '' };
    const parsed = parseRemoteCommand(line);
    if (parsed.type === 'empty') {
      this.draw();
      return;
    }
    this.history.push(line);
    this.historyAt = -1;
    if (parsed.type === 'exit') {
      await this.disconnect();
      return;
    }
    if (parsed.type === 'cd') {
      await this.changeDir(parsed.path, line);
      return;
    }
    await this.execRemote(parsed.command, line);
  }

  private recallHistory(screen: Extract<Screen, { kind: 'browse' }>, delta: number): void {
    if (this.history.length === 0) return;
    if (delta < 0) {
      if (this.historyAt < 0) {
        this.historyDraft = screen.command;
        this.historyAt = this.history.length - 1;
      } else if (this.historyAt > 0) this.historyAt -= 1;
    } else if (this.historyAt >= 0) {
      if (this.historyAt >= this.history.length - 1) {
        this.historyAt = -1;
        this.screen = { ...screen, command: this.historyDraft };
        this.draw();
        return;
      }
      this.historyAt += 1;
    }
    if (this.historyAt < 0) return;
    this.screen = { ...screen, command: this.history[this.historyAt] ?? '' };
    this.draw();
  }

  private async execRemote(command: string, line: string): Promise<void> {
    if (!this.session || this.screen.kind !== 'browse') return;
    const abort = new AbortController();
    this.commandAbort = abort;
    const epoch = this.browseEpoch;
    const cwd = this.screen.cwd;
    const previous = this.screen.output;
    this.screen = { ...this.screen, notice: { tone: 'info', text: 'Running…' } };
    this.draw();
    try {
      const columns = Math.max(20, this.cols - 8);
      const result = await this.session.run(cwd, command, abort.signal, columns);
      if (epoch !== this.browseEpoch || this.screen.kind !== 'browse') return;
      const body = sanitizeTerminal(result.output).replace(/\n+$/, '');
      const block = body ? `$ ${line}\n${body}` : `$ ${line}`;
      this.screen = {
        ...this.screen,
        output: appendTranscript(previous, block),
        scroll: 0,
        notice: result.code === 0 ? undefined : { tone: 'error', text: `exit ${result.code}` },
      };
      this.draw();
      await this.refreshEntries();
    } catch (err) {
      if (epoch !== this.browseEpoch || this.screen.kind !== 'browse') return;
      const message = abort.signal.aborted ? 'Command cancelled' : humanizeSshError(err);
      this.screen = {
        ...this.screen,
        output: appendTranscript(previous, message),
        scroll: 0,
        notice: { tone: abort.signal.aborted ? 'info' : 'error', text: message },
      };
      this.draw();
    } finally {
      if (this.commandAbort === abort) this.commandAbort = null;
    }
  }

  private async tryDrop(event: InputEvent): Promise<boolean> {
    if (this.screen.kind !== 'browse' || this.screen.transfer) return false;
    if (event.type === 'key' || event.type === 'mouse') return false;
    // Typed input arrives one character at a time. A drop or paste arrives as a whole path.
    if (event.type === 'text' && event.text.length < 2) return false;
    const paths = this.host.classifyDrop(event.text);
    if (!paths) return false;
    await this.upload(paths);
    return true;
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
      const entries = withParent(opened.cwd, await opened.session.list(opened.cwd));
      const notes: string[] = [];
      if (opened.trustedNewKey) notes.push(`Trusted the host key for ${record.host}`);
      if (opened.usedFallbackPath) notes.push('Remote path was not found. Opened your home directory');
      this.screen = {
        kind: 'browse',
        title: record.name,
        userHost: `${record.username}@${record.host}:${record.port}`,
        cwd: opened.cwd,
        entries,
        selected: 0,
        command: '',
        output: '',
        notice: notes.length ? { tone: 'info', text: notes.join('. ') } : undefined,
      };
      this.host.setStatus(`${record.name}:${opened.cwd}`);
      this.draw();
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

  private async disconnect(): Promise<void> {
    this.browseEpoch += 1;
    this.transferAbort?.abort();
    this.session?.close();
    this.session = null;
    await this.showConnections();
  }

  private async changeDir(path: string, echo?: string): Promise<void> {
    if (this.screen.kind !== 'browse' || !this.session) return;
    const epoch = this.browseEpoch;
    const shown = echo?.trim() ? echo.trim() : `cd ${path}`;
    try {
      const resolved = await this.session.resolve(path, this.screen.cwd);
      if (epoch !== this.browseEpoch || this.screen.kind !== 'browse') return;
      if (resolved.kind !== 'dir') {
        this.screen = {
          ...this.screen,
          output: appendTranscript(this.screen.output, 'Not a directory'),
          scroll: 0,
          notice: { tone: 'error', text: 'Not a directory' },
        };
        this.draw();
        return;
      }
      const entries = withParent(resolved.path, await this.session.list(resolved.path));
      if (epoch !== this.browseEpoch || this.screen.kind !== 'browse') return;
      this.screen = {
        ...this.screen,
        cwd: resolved.path,
        entries,
        selected: 0,
        notice: undefined,
        output: appendTranscript(this.screen.output, `$ ${shown}`),
        scroll: 0,
        hoverPath: undefined,
        pressedPath: undefined,
      };
      this.host.setStatus(`${this.screen.title}:${resolved.path}`);
      this.draw();
    } catch (err) {
      if (this.screen.kind !== 'browse') return;
      const message = humanizeSshError(err);
      this.screen = {
        ...this.screen,
        output: appendTranscript(this.screen.output, message),
        scroll: 0,
        notice: { tone: 'error', text: message },
      };
      this.draw();
    }
  }

  private async openRemote(remotePath: string): Promise<void> {
    if (this.screen.kind !== 'browse') return;
    const now = Date.now();
    if (remotePath === this.lastOpenPath && now - this.lastOpenAt < 300) return;
    this.lastOpenPath = remotePath;
    this.lastOpenAt = now;
    const entry = this.screen.entries.find((item) => item.path === remotePath);
    if (!entry) {
      if (!this.session) return;
      try {
        const resolved = await this.session.resolve(remotePath, this.screen.cwd);
        if (resolved.kind === 'dir') {
          await this.changeDir(resolved.path, `cd ${remotePath}`);
          return;
        }
        if (resolved.kind === 'file') await this.download(remoteBasename(remotePath), resolved.path, 0);
      } catch (err) {
        this.showNotice('error', humanizeSshError(err));
      }
      return;
    }
    const index = this.screen.entries.indexOf(entry);
    if (index >= 0) this.screen = { ...this.screen, selected: index };
    await this.openEntry(entry);
  }

  private async openEntry(entry: BrowseEntry): Promise<void> {
    if (entry.name === '..' || entry.kind === 'dir') {
      await this.changeDir(entry.path, `cd ${entry.name}`);
      return;
    }
    if (entry.kind === 'link' || entry.kind === 'other') {
      if (!this.session || this.screen.kind !== 'browse') return;
      try {
        const resolved = await this.session.resolve(entry.path, this.screen.cwd);
        if (resolved.kind === 'dir') {
          await this.changeDir(resolved.path, `cd ${entry.name}`);
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

  private async flashPress(remotePath: string): Promise<void> {
    if (this.screen.kind !== 'browse') return;
    this.screen = { ...this.screen, pressedPath: remotePath };
    this.draw();
    await new Promise((resolve) => setTimeout(resolve, 140));
    if (this.screen.kind === 'browse' && this.screen.pressedPath === remotePath) {
      this.screen = { ...this.screen, pressedPath: undefined };
      this.draw();
    }
  }

  private async download(name: string, remotePath: string, size: number): Promise<void> {
    if (!this.session || this.screen.kind !== 'browse' || this.screen.transfer) {
      this.showNotice('error', 'Wait for the current transfer to finish');
      return;
    }
    const localPath = this.host.localDownloadPath(safeFileName(name));
    const abort = new AbortController();
    this.transferAbort = abort;
    const epoch = this.browseEpoch;
    this.screen = {
      ...this.screen,
      transfer: { direction: 'download', label: name, done: 0, total: size, index: 1, count: 1 },
    };
    this.draw();
    try {
      await this.session.download(
        remotePath,
        localPath,
        (done, total) => {
          if (epoch !== this.browseEpoch || this.screen.kind !== 'browse' || !this.screen.transfer) return;
          this.screen = { ...this.screen, transfer: { ...this.screen.transfer, done, total } };
          this.draw(false);
        },
        abort.signal,
      );
      if (epoch !== this.browseEpoch || this.screen.kind !== 'browse') return;
      const note = `Downloaded to ${localPath}`;
      this.host.log(note);
      this.screen = {
        ...this.screen,
        transfer: undefined,
        output: appendTranscript(this.screen.output, note),
        scroll: 0,
        notice: { tone: 'ok', text: note },
      };
      this.draw();
    } catch (err) {
      if (epoch !== this.browseEpoch || this.screen.kind !== 'browse') return;
      const message = abort.signal.aborted ? 'Download cancelled' : humanizeSshError(err);
      this.host.log(message);
      this.screen = {
        ...this.screen,
        transfer: undefined,
        output: appendTranscript(this.screen.output, message),
        scroll: 0,
        notice: { tone: abort.signal.aborted ? 'info' : 'error', text: message },
      };
      this.draw();
    } finally {
      if (this.transferAbort === abort) this.transferAbort = null;
    }
  }

  private async upload(paths: string[]): Promise<void> {
    if (!this.session || this.screen.kind !== 'browse') return;
    if (this.screen.transfer) {
      this.showNotice('error', 'Wait for the current transfer to finish');
      return;
    }
    const abort = new AbortController();
    this.transferAbort = abort;
    const epoch = this.browseEpoch;
    const cwd = this.screen.cwd;
    this.screen = {
      ...this.screen,
      transfer: { direction: 'upload', label: paths.length === 1 ? paths[0].split(/[/\\]/).pop() || 'file' : `${paths.length} items`, done: 0, total: 0, index: 1, count: paths.length },
    };
    this.draw();
    try {
      const result = await this.session.upload(
        paths,
        cwd,
        (state) => {
          if (epoch !== this.browseEpoch || this.screen.kind !== 'browse') return;
          this.screen = { ...this.screen, transfer: state };
          this.draw(false);
        },
        abort.signal,
      );
      if (epoch !== this.browseEpoch || this.screen.kind !== 'browse') return;
      const skipped = result.skipped ? `, skipped ${result.skipped}` : '';
      const text = result.uploaded === 0 && result.skipped === 0
        ? 'Nothing to upload'
        : `Uploaded ${result.uploaded} to ${cwd}${skipped}`;
      this.screen = {
        ...this.screen,
        transfer: undefined,
        output: appendTranscript(this.screen.output, text),
        scroll: 0,
        notice: { tone: result.uploaded ? 'ok' : 'info', text },
      };
      this.draw();
      await this.refreshEntries();
    } catch (err) {
      if (epoch !== this.browseEpoch || this.screen.kind !== 'browse') return;
      const message = abort.signal.aborted ? 'Upload cancelled' : humanizeSshError(err);
      this.screen = {
        ...this.screen,
        transfer: undefined,
        output: appendTranscript(this.screen.output, message),
        scroll: 0,
        notice: { tone: abort.signal.aborted ? 'info' : 'error', text: message },
      };
      this.draw();
    } finally {
      if (this.transferAbort === abort) this.transferAbort = null;
    }
  }

  private async refreshEntries(notice?: Notice): Promise<void> {
    if (!this.session || this.screen.kind !== 'browse') return;
    const epoch = this.browseEpoch;
    try {
      const entries = withParent(this.screen.cwd, await this.session.list(this.screen.cwd));
      if (epoch !== this.browseEpoch || this.screen.kind !== 'browse') return;
      const selected = Math.min(this.screen.selected, Math.max(0, entries.length - 1));
      this.screen = { ...this.screen, entries, selected, transfer: undefined, notice: notice ?? this.screen.notice };
      this.draw();
    } catch (err) {
      this.showNotice('error', humanizeSshError(err));
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

  private showNotice(tone: Notice['tone'], text: string): void {
    if (
      this.screen.kind === 'connections' ||
      this.screen.kind === 'browse' ||
      this.screen.kind === 'wizard' ||
      this.screen.kind === 'confirm' ||
      this.screen.kind === 'pick'
    ) {
      this.screen = { ...this.screen, notice: { tone, text } };
      this.draw();
    }
  }

  private draw(immediate = true): void {
    if (!immediate) {
      if (this.drawTimer) return;
      this.drawTimer = setTimeout(() => {
        this.drawTimer = undefined;
        this.draw(true);
      }, 80);
      return;
    }
    const frame = render(this.screen, {
      cols: this.cols,
      rows: this.rows,
      downloadFolder: this.host.downloadFolder(),
      home: this.host.home(),
      clickHint: this.host.clickHint(),
    });
    this.links = frame.links;
    this.linePlains = frame.lines.map((line) => line.plain);
    const track = this.screen.kind === 'browse';
    if (track !== this.trackingMouse) {
      this.trackingMouse = track;
      this.emit(track ? '\x1b[?1003h\x1b[?1006h' : '\x1b[?1003l\x1b[?1006l');
    }
    this.emit(paint(frame));
  }

  /** Hover and mouse-down update the file name immediately. Release is queued. */
  private paintPointer(event: Extract<InputEvent, { type: 'mouse' }>): void {
    if (this.screen.kind !== 'browse') return;
    const link = this.hitLink(event.col, event.row);
    if (event.action === 'down') {
      if (!link || event.button !== 0) return;
      this.screen = { ...this.screen, hoverPath: link.remotePath, pressedPath: link.remotePath };
      this.draw();
      return;
    }
    const path = link?.remotePath;
    const pressed = event.button === 0 ? this.screen.pressedPath : undefined;
    if (this.screen.hoverPath === path && this.screen.pressedPath === pressed) return;
    this.screen = { ...this.screen, hoverPath: path, pressedPath: pressed };
    this.draw();
  }

  private async onBrowsePointer(event: Extract<InputEvent, { type: 'mouse' }>): Promise<void> {
    if (this.screen.kind !== 'browse') return;
    if (event.action === 'wheel') {
      const delta = event.button === 0 ? 3 : -3;
      const limit = Math.max(0, this.screen.output.split('\n').length);
      const scroll = Math.max(0, Math.min(limit, (this.screen.scroll ?? 0) + delta));
      if (scroll === (this.screen.scroll ?? 0)) return;
      this.screen = { ...this.screen, scroll, hoverPath: undefined };
      this.draw();
      return;
    }
    if (event.action !== 'up' || event.button !== 0) return;
    const pressed = this.screen.pressedPath;
    const link = this.hitLink(event.col, event.row);
    if (this.screen.pressedPath) {
      this.screen = { ...this.screen, pressedPath: undefined, hoverPath: link?.remotePath };
      this.draw();
    }
    if (!pressed || link?.remotePath !== pressed) return;
    if (this.screen.transfer || this.commandAbort) return;
    await this.openRemote(pressed);
  }

  private hitLink(col: number, row: number): LineLink | undefined {
    const plain = this.linePlains[row - 1];
    if (!plain) return undefined;
    const list = this.links.get(plain.trimEnd()) ?? this.links.get(plain) ?? [];
    for (const link of list) {
      const startCol = displayWidth(plain.slice(0, link.start)) + 1;
      const endCol = startCol + displayWidth(plain.slice(link.start, link.start + link.length));
      if (col >= startCol && col < endCol) return link;
    }
    return undefined;
  }
}

function appendTranscript(current: string, block: string): string {
  const next = current ? `${current}\n${block}` : block;
  const limit = 120_000;
  return next.length <= limit ? next : next.slice(next.length - limit);
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
