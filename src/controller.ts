import fs from 'fs';
import os from 'os';
import path from 'path';
import * as vscode from 'vscode';
import { downloadFolderLabel, resolveDownloadFolder, resolveKnownFolder, systemProbe, type SystemFolders } from './localFolders';
import { classifyDrop } from './shellTokens';
import { connectionsFromHosts, mergeImported } from './ssh/importConfig';
import { parseKnownHosts, type KnownHostEntry } from './ssh/knownHosts';
import { loadSshConfig, MissingSshConfig } from './ssh/loadConfig';
import { openSession } from './ssh/session';
import type { HostKeyPolicy } from './ssh/hostKeys';
import { ConnectionStore } from './store';
import { EasySshApp } from './terminal/app';
import { shortRemote, type ActionMenu, type FileAction } from './terminal/actions';
import type { AppHost, ProgressHandle, RenameRequest } from './terminal/host';
import { EasySshPty } from './terminal/pty';
import type { LineLink } from './terminal/render';
import { RemoteFiles, overwriteText, type EditorSession, type EditorTarget, type OverwriteQuestion } from './remoteFiles';
import { EASYSSH_SCHEME } from './remoteFsProvider';
import type { UploadQuestion } from './terminal/cwdTracking';
import { expandHome, formatFingerprint } from './text';
import type { ConflictChoice, ConnectionRecord, SecretPayload, SecretUpdate } from './types';
import { editorThemeKind, parseColorDepth } from './terminal/theme';
import type { ConnectUi } from './ssh/session';

class PathLink extends vscode.TerminalLink {
  constructor(
    readonly link: LineLink,
    readonly owner: EasySshApp,
  ) {
    super(link.start, link.length, link.tooltip);
  }
}

interface LiveTerminal {
  pty: EasySshPty;
  terminal: vscode.Terminal;
  app: EasySshApp;
  /** The URI authority of files opened from this terminal (easyssh://<authority>/path). */
  authority?: string;
  status?: string;
  transferring?: boolean;
}

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('easySsh');
}

/** A number setting, clamped to [min, max], or the fallback when unset or invalid. */
/** A URI authority from a connection name: letters, digits, dot, dash and underscore. */
export function editorAuthority(label: string): string {
  const cleaned = label.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'server';
}

export function numberSetting(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function exists(file: string): boolean {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/** How terminal links open: Alt when multi-cursor uses Ctrl/Cmd, else Ctrl (Cmd on macOS). */
function linkModifier(): string {
  const multiCursor = vscode.workspace.getConfiguration('editor').get<string>('multiCursorModifier');
  if (multiCursor === 'ctrlCmd') return process.platform === 'darwin' ? 'Option' : 'Alt';
  return process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
}

function importId(name: string, taken: Set<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
  let id = `sshconfig:${slug}`;
  let suffix = 2;
  while (taken.has(id)) {
    id = `sshconfig:${slug}-${suffix}`;
    suffix += 1;
  }
  return id;
}

/**
 * The agent to try: SSH_AUTH_SOCK, or on Windows the OpenSSH agent pipe or
 * Pageant (setting easySsh.windowsAgent). Undefined when there is none.
 */
export function resolveAgent(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  windowsAgent: string | undefined,
  pipeExists: (pipe: string) => boolean,
): string | undefined {
  if (env.SSH_AUTH_SOCK) return env.SSH_AUTH_SOCK;
  if (platform !== 'win32') return undefined;
  const pipe = '\\\\.\\pipe\\openssh-ssh-agent';
  if (windowsAgent === 'pageant') return 'pageant';
  if (windowsAgent === 'openssh') return pipe;
  return pipeExists(pipe) ? pipe : 'pageant';
}

/** ~/.ssh/id_ed25519, id_ecdsa and id_rsa that exist, in the order ssh tries them. */
export function defaultIdentityFiles(home: string, fileExists: (file: string) => boolean): string[] {
  return ['id_ed25519', 'id_ecdsa', 'id_rsa']
    .map((name) => path.join(home, '.ssh', name))
    .filter((file) => fileExists(file));
}

function readKnownHosts(home: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const file of [path.join(home, '.ssh', 'known_hosts'), path.join(home, '.ssh', 'known_hosts2')]) {
    try {
      entries.push(...parseKnownHosts(fs.readFileSync(file, 'utf8')));
    } catch {
      // Missing or unreadable: nothing to trust from it.
    }
  }
  return entries;
}

async function appendKnownHost(home: string, line: string): Promise<void> {
  const dir = path.join(home, '.ssh');
  const file = path.join(dir, 'known_hosts');
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  let prefix = '';
  try {
    const current = await fs.promises.readFile(file, 'utf8');
    if (current.length > 0 && !current.endsWith('\n')) prefix = '\n';
  } catch {
    // A new file.
  }
  await fs.promises.appendFile(file, `${prefix}${line}\n`, { mode: 0o600 });
}

export class EasySshController implements vscode.TerminalLinkProvider<PathLink> {
  private readonly lives: LiveTerminal[] = [];
  private active: LiveTerminal | undefined;
  /** True while an Easy SSH terminal panel is the one on screen. */
  private shown = false;
  /**
   * The panel maximize is a toggle and its state cannot be read (B10), so the
   * terminal's height tells: taller after the toggle means Easy SSH maximized it.
   */
  private maximize: 'none' | 'pending' | 'ours' | 'skip' = 'none';
  private maximizedRows = 0;
  /** Ignores focus changes caused by closing the side bar after an icon click. */
  private settling = 0;
  /** Downloads and Desktop, looked up in the background at activation (B15). */
  private folders: SystemFolders = {};
  /** Where the last upload picker found its files, to start there next time. */
  private lastUploadFolder: string | undefined;

  constructor(
    private readonly store: ConnectionStore,
    private readonly output: vscode.OutputChannel,
    private readonly status: vscode.StatusBarItem,
  ) {
    this.status.text = '$(remote) Easy SSH';
    this.status.tooltip = 'Open Easy SSH';
  }

  /** Look up the system folders without blocking activation. */
  async init(): Promise<void> {
    const probe = systemProbe();
    const [downloads, desktop] = await Promise.all([
      resolveKnownFolder(probe, 'Downloads').catch(() => undefined),
      resolveKnownFolder(probe, 'Desktop').catch(() => undefined),
    ]);
    this.folders = { downloads, desktop };
    this.output.appendLine(`Downloads folder: ${downloads ?? 'not found'}. Desktop: ${desktop ?? 'not found'}`);
  }

  /** Call before moving the side bar so that close does not clear the open terminal. */
  beginIconClick(): void {
    this.settling += 1;
  }

  /** Each activity-bar click opens its own terminal. */
  finishIconClick(): void {
    this.spawn();
    setTimeout(() => {
      this.settling = Math.max(0, this.settling - 1);
    }, 250);
  }

  noteActiveTerminal(terminal: vscode.Terminal | undefined): void {
    if (this.settling > 0) return;
    const live = this.lives.find((item) => item.terminal === terminal && item.terminal.exitStatus === undefined);
    if (!live) {
      this.shown = false;
      return;
    }
    this.active = live;
    this.shown = true;
    this.applyStatus(live);
  }

  open(): void {
    const live = this.latest();
    if (live) {
      this.active = live;
      this.shown = true;
      live.terminal.show();
      this.applyStatus(live);
      return;
    }
    this.spawn();
  }

  /** Open another Easy SSH terminal. Each one has its own connection. */
  newTerminal(): void {
    this.spawn();
  }

  /** Cancel the running transfer in the active Easy SSH terminal (or any terminal with one). */
  cancelTransfer(): void {
    const candidates = [this.active, ...this.lives].filter((live): live is LiveTerminal => live !== undefined);
    for (const live of candidates) {
      if (live.app.cancelTransfer()) return;
    }
    void vscode.window.showInformationMessage('Easy SSH: no transfer is running.');
  }

  private latest(): LiveTerminal | undefined {
    for (let index = this.lives.length - 1; index >= 0; index -= 1) {
      const live = this.lives[index];
      if (live.terminal.exitStatus === undefined) return live;
    }
    return undefined;
  }

  private nextName(): string {
    const used = new Set(this.lives.map((live) => live.terminal.name));
    if (!used.has('Easy SSH')) return 'Easy SSH';
    let index = 2;
    while (used.has(`Easy SSH ${index}`)) index += 1;
    return `Easy SSH ${index}`;
  }

  private spawn(): void {
    // The app and its pty refer to each other; neither calls the other while being built.
    const app: EasySshApp = new EasySshApp(this.createHost(() => app), (data) => pty.write(data));
    const pty = new EasySshPty(app);
    const inEditor = settings().get<string>('terminalLocation') === 'editor';
    const name = this.nextName();
    const terminal = vscode.window.createTerminal({
      name,
      pty,
      iconPath: new vscode.ThemeIcon('remote'),
      isTransient: true,
      location: inEditor && vscode.TerminalLocation.Editor !== undefined ? vscode.TerminalLocation.Editor : vscode.TerminalLocation.Panel,
    });
    const live: LiveTerminal = { pty, terminal, app };
    this.lives.push(live);
    this.active = live;
    this.shown = true;
    terminal.show();
    this.applyStatus(live);
    if (!inEditor) this.maximizePanel(live);
  }

  private maximizePanel(live: LiveTerminal): void {
    if (this.maximize !== 'none' || settings().get<boolean>('maximizePanel') === false) return;
    this.maximize = 'pending';
    const started = Date.now();
    const toggle = () => {
      if (live.pty.rows === 0 && Date.now() - started < 1500) {
        setTimeout(toggle, 50);
        return;
      }
      const before = live.pty.rows;
      void vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
      setTimeout(() => {
        const after = live.pty.rows;
        if (before > 0 && after > before) {
          this.maximize = 'ours';
          this.maximizedRows = after;
          return;
        }
        if (before > 0 && after < before) {
          // It was maximized already: the toggle restored it. Put it back.
          void vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
        }
        this.maximize = 'skip';
      }, 400);
    };
    toggle();
  }

  onClosed(terminal: vscode.Terminal): void {
    const index = this.lives.findIndex((item) => item.terminal === terminal);
    if (index < 0) return;
    const [closed] = this.lives.splice(index, 1);
    this.active = this.lives.find((item) => item.terminal === vscode.window.activeTerminal) ?? this.latest();
    this.shown = this.active !== undefined && vscode.window.activeTerminal === this.active.terminal;
    if (this.lives.length === 0) {
      // Restore only a panel Easy SSH maximized and that is still maximized.
      if (this.maximize === 'ours' && closed.pty.rows >= this.maximizedRows - 1) {
        void vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
      }
      this.maximize = 'none';
      this.applyStatus(undefined);
      return;
    }
    if (this.shown && this.active) this.applyStatus(this.active);
  }

  async setDownloadFolder(): Promise<void> {
    const folder = await this.chooseDownloadFolder();
    if (folder) void vscode.window.showInformationMessage(`Easy SSH downloads to ${folder}`);
  }

  /** Forget one or more trusted host keys, or all of them, after a confirmation (S5). */
  async resetHostKeys(): Promise<void> {
    const stored = this.store.listHostKeys();
    if (stored.length === 0) {
      void vscode.window.showInformationMessage('Easy SSH has no saved host keys. Keys in ~/.ssh/known_hosts are never changed.');
      return;
    }
    const all = { label: '$(trash) Forget all saved host keys', id: '*', description: `${stored.length} hosts` };
    const items = [
      all,
      ...stored.map((item) => ({ label: item.id.replace(/>/g, ' › '), id: item.id, description: formatFingerprint(item.fingerprint) })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Easy SSH: Reset Trusted Host Keys',
      placeHolder: 'Choose the hosts to forget. You are asked to check the key again on the next connect.',
      canPickMany: true,
    });
    if (!picked || picked.length === 0) return;
    const ids = picked.some((item) => item.id === '*') ? stored.map((item) => item.id) : picked.map((item) => item.id);
    const confirm = 'Forget';
    const answer = await vscode.window.showWarningMessage(
      `Forget the saved host key of ${ids.length === 1 ? ids[0] : `${ids.length} hosts`}?`,
      { modal: true, detail: 'Keys in ~/.ssh/known_hosts are not touched.' },
      confirm,
    );
    if (answer !== confirm) return;
    await this.store.forgetHostKeys(ids);
    void vscode.window.showInformationMessage(`Easy SSH forgot ${ids.length} host key${ids.length === 1 ? '' : 's'}.`);
  }

  provideTerminalLinks(context: vscode.TerminalLinkContext): PathLink[] {
    const live = this.lives.find((item) => item.terminal === context.terminal);
    if (!live) return [];
    return live.app.linkFor(context.line)
      .filter((link) => link.length > 0)
      .map((link) => new PathLink(link, live.app));
  }

  handleTerminalLink(link: PathLink): void {
    link.owner.activateLink(link.link);
  }

  private downloadFolder(): string {
    const configured = settings().get<string>('downloadFolder');
    return resolveDownloadFolder(configured, this.folders, os.homedir(), exists);
  }

  private plainClick(): boolean {
    return settings().get<boolean>('plainClick') === true;
  }

  private async confirmUpload(question: UploadQuestion): Promise<string | undefined> {
    const here = `Upload to ${question.cwd}`;
    const home = question.home && question.home !== question.cwd ? `Upload to ${question.home}` : undefined;
    const other = 'Choose Folder…';
    const buttons = [here, ...(home ? [home] : []), other];
    const picked = await vscode.window.showWarningMessage(question.message, { modal: true, detail: question.detail }, ...buttons);
    if (picked === here) return question.cwd;
    if (home && picked === home) return question.home;
    if (picked !== other) return undefined;
    const typed = await vscode.window.showInputBox({
      title: 'Upload to a folder on the server',
      value: question.home ?? question.cwd,
      prompt: `Absolute path. The upload is written as ${question.loginUser}.`,
      validateInput: (value) => (value.trim().startsWith('/') ? undefined : 'Enter an absolute path such as /tmp'),
    });
    return typed?.trim() || undefined;
  }

  private async resolveConflict(existing: string[], remoteDir: string): Promise<ConflictChoice> {
    const replace = 'Replace';
    const keep = 'Keep Both';
    const skip = 'Skip';
    const shown = existing.slice(0, 5).join(', ') + (existing.length > 5 ? ` and ${existing.length - 5} more` : '');
    const picked = await vscode.window.showWarningMessage(
      existing.length === 1 ? `${existing[0]} already exists in ${remoteDir}` : `${existing.length} items already exist in ${remoteDir}`,
      {
        modal: true,
        detail: `${shown}\n\nReplace overwrites them. Keep Both uploads as "name (1)". Skip leaves them and uploads the rest.`,
      },
      replace,
      keep,
      skip,
    );
    if (picked === replace) return 'replace';
    if (picked === keep) return 'keep';
    if (picked === skip) return 'skip';
    return 'cancel';
  }

  private async confirmLocalUpload(paths: string[]): Promise<'upload' | 'paste'> {
    const upload = 'Upload';
    const paste = 'Type as Text';
    const picked = await vscode.window.showWarningMessage(
      `Upload ${paths.length === 1 ? paths[0] : `${paths.length} items`} from this computer?`,
      {
        modal: true,
        detail: 'This looks like a dropped file outside your home folder. If you pasted a path for the remote shell, choose Type as Text.',
      },
      upload,
      paste,
    );
    return picked === upload ? 'upload' : 'paste';
  }

  private showProgress(title: string, cancel: () => void): ProgressHandle {
    let latest: { text: string; fraction: number | undefined } | undefined;
    let apply: ((text: string, fraction: number | undefined) => void) | undefined;
    let finish: (() => void) | undefined;
    let closed = false;
    let reported = 0;
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (progress, token) => {
        token.onCancellationRequested(() => cancel());
        apply = (text, fraction) => {
          let increment: number | undefined;
          if (fraction !== undefined) {
            const percent = Math.round(fraction * 100);
            increment = Math.max(0, percent - reported);
            reported = Math.max(reported, percent);
          }
          progress.report({ message: text, increment });
        };
        if (latest) apply(latest.text, latest.fraction);
        return new Promise<void>((resolve) => {
          finish = resolve;
          if (closed) resolve();
        });
      },
    );
    return {
      report: (text, fraction) => {
        latest = { text, fraction };
        apply?.(text, fraction);
      },
      close: () => {
        closed = true;
        finish?.();
      },
    };
  }

  /** The Ctrl/Cmd+click action menu: a quick pick with icons, Download first so Enter downloads. */
  private showActionMenu(menu: ActionMenu, update?: Promise<string | undefined>): Promise<FileAction | undefined> {
    interface Item extends vscode.QuickPickItem {
      action?: FileAction;
    }
    return new Promise((resolve) => {
      const pick = vscode.window.createQuickPick<Item>();
      pick.title = menu.title;
      pick.placeholder = menu.placeholder;
      pick.matchOnDescription = true;
      pick.items = menu.items.map((item): Item => (item.separator
        ? { label: item.label, kind: vscode.QuickPickItemKind.Separator }
        : { label: item.icon ? `$(${item.icon}) ${item.label}` : item.label, description: item.description, action: item.action }));
      let settled = false;
      const finish = (action: FileAction | undefined) => {
        if (settled) return;
        settled = true;
        resolve(action);
      };
      void update?.then((text) => {
        if (text && !settled) pick.placeholder = text;
      });
      pick.onDidAccept(() => {
        finish(pick.selectedItems[0]?.action ?? pick.activeItems[0]?.action);
        pick.hide();
      });
      pick.onDidHide(() => {
        finish(undefined);
        pick.dispose();
      });
      pick.show();
    });
  }

  private async pickSaveFile(folder: string, name: string): Promise<string | undefined> {
    const picked = await vscode.window.showSaveDialog({
      title: `Download ${name}`,
      saveLabel: 'Download',
      defaultUri: vscode.Uri.file(path.join(folder, name)),
    });
    return picked?.fsPath;
  }

  private async pickDownloadParent(folder: string, name: string): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
      title: `Download folder "${name}" into…`,
      openLabel: 'Download Here',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(folder),
    });
    return picked?.[0]?.fsPath;
  }

  private async pickUploadFiles(remoteDir: string): Promise<string[] | undefined> {
    // Windows and Linux dialogs pick files or folders, not both; macOS does both.
    const picked = await vscode.window.showOpenDialog({
      title: `Upload to ${remoteDir}`,
      openLabel: `Upload to ${shortRemote(remoteDir)}`,
      canSelectFiles: true,
      canSelectFolders: process.platform === 'darwin',
      canSelectMany: true,
      defaultUri: vscode.Uri.file(this.lastUploadFolder ?? os.homedir()),
    });
    if (!picked || picked.length === 0) return undefined;
    this.lastUploadFolder = path.dirname(picked[0].fsPath);
    return picked.map((uri) => uri.fsPath);
  }

  private async askRename(request: RenameRequest): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: `Rename ${request.kind} — ${request.parent}`,
      prompt: `New name for "${request.name}"`,
      value: request.name,
      valueSelection: request.selection,
      validateInput: (value) => request.validate(value),
    });
  }

  /** Remote files in editor tabs, read and saved through each terminal's session. */
  readonly remoteFiles = new RemoteFiles(
    (authority) => this.editorTarget(authority),
    (question) => this.askOverwrite(question),
  );

  private editorTarget(authority: string): EditorTarget | undefined {
    const live = this.lives.find((item) => item.authority === authority) ?? this.adoptAuthority(authority);
    if (!live) return undefined;
    return {
      label: live.app.connectionLabel(),
      session: () => {
        const session = live.app.editorSession();
        if (!session || !session.readWhole || !session.writeWhole || !session.makeDir || !session.stat || !session.remove || !session.rename) return null;
        return session as unknown as EditorSession;
      },
    };
  }

  /**
   * A tab restored after a reload (or kept open after its terminal closed) names a terminal that no
   * longer exists. Hand it to a connected terminal for the same connection that has no files open yet.
   */
  private adoptAuthority(authority: string): LiveTerminal | undefined {
    const live = this.lives.find((item) => {
      if (item.authority || !item.app.editorSession()) return false;
      const base = editorAuthority(item.app.connectionLabel());
      return authority === base || (authority.startsWith(`${base}-`) && /^\d+$/.test(authority.slice(base.length + 1)));
    });
    if (live) live.authority = authority;
    return live;
  }

  /** A short, stable name for a terminal's files: the connection name, numbered when two terminals share it. */
  private authorityFor(live: LiveTerminal): string {
    if (live.authority) return live.authority;
    const base = editorAuthority(live.app.connectionLabel());
    const used = new Set(this.lives.filter((item) => item !== live).map((item) => item.authority));
    let candidate = base;
    for (let index = 2; used.has(candidate); index += 1) candidate = `${base}-${index}`;
    live.authority = candidate;
    return candidate;
  }

  private async openRemoteFile(live: LiveTerminal | undefined, remotePath: string): Promise<void> {
    if (!live) throw new Error('The terminal is closed.');
    const uri = vscode.Uri.from({ scheme: EASYSSH_SCHEME, authority: this.authorityFor(live), path: remotePath });
    await vscode.window.showTextDocument(uri, { preview: false });
  }

  private async askOverwrite(question: OverwriteQuestion): Promise<boolean> {
    const text = overwriteText(question);
    const action = question.now ? 'Overwrite' : 'Save';
    const picked = await vscode.window.showWarningMessage(text.message, { modal: true, detail: text.detail }, action);
    return picked === action;
  }

  private async choose(message: string, detail: string, answers: string[]): Promise<string | undefined> {
    return vscode.window.showWarningMessage(message, { modal: true, detail }, ...answers);
  }

  private async confirm(message: string, detail: string, action: string): Promise<boolean> {
    const picked = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
    return picked === action;
  }

  private async chooseDownloadFolder(): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select Download Folder',
      defaultUri: vscode.Uri.file(this.downloadFolder()),
    });
    const folder = picked?.[0]?.fsPath;
    if (!folder) return undefined;
    await settings().update('downloadFolder', folder, vscode.ConfigurationTarget.Global);
    return folder;
  }

  /** Open an SSH session with the user's settings. */
  private openFor(
    record: ConnectionRecord,
    secret: SecretPayload,
    options: { signal: AbortSignal; ui: ConnectUi },
    onClose: (reason?: string) => void,
  ): ReturnType<typeof openSession> {
    const config = settings();
    const home = os.homedir();
    return openSession({
      record,
      secret,
      known: {
        get: (id) => this.store.getHostKey(id),
        trust: (id, fingerprint) => this.store.trustHost(id, fingerprint),
      },
      knownHosts: readKnownHosts(home),
      hostKeyPolicy: config.get<HostKeyPolicy>('hostKeyPolicy') === 'trustFirst' ? 'trustFirst' : 'ask',
      writeKnownHost: config.get<boolean>('knownHostsWriteBack') === true ? (line) => appendKnownHost(home, line) : undefined,
      ui: options.ui,
      readyTimeout: numberSetting(config.get('readyTimeout'), 20000, 3000, 600000),
      keepaliveInterval: numberSetting(config.get('keepaliveInterval'), 15000, 0, 3600000),
      keepaliveCountMax: numberSetting(config.get('keepaliveCountMax'), 3, 1, 100),
      agent: resolveAgent(process.env, process.platform, config.get<string>('windowsAgent'), exists),
      identityFiles: defaultIdentityFiles(home, exists),
      signal: options.signal,
      onClose,
      log: (line) => this.output.appendLine(line),
    });
  }

  /** The secret a test uses: the typed one, the stored one ("keep"), or none. */
  private async secretFor(id: string, update: SecretUpdate): Promise<SecretPayload> {
    if (update.action === 'keep') return this.store.secret(id);
    if (update.action === 'clear') return {};
    return { password: update.password, passphrase: update.passphrase };
  }

  /** VS Code's theme, the color depth or easySsh.themeSession changed: redraw every Easy SSH terminal. */
  refreshThemes(): void {
    for (const live of this.lives) live.app.refreshTheme();
  }

  private createHost(app: () => EasySshApp): AppHost {
    const liveOf = () => this.lives.find((item) => item.app === app());
    return {
      listConnections: () => this.store.list(),
      saveConnection: (record, secret) => this.store.save(record, secret),
      deleteConnection: (id) => this.store.delete(id),
      secretFlags: (id) => this.store.secretFlags(id),
      importConfig: () => this.importConfig(),
      connect: async (record, options) => {
        const secret = await this.store.secret(record.id);
        const opened = await this.openFor(record, secret, options, (reason) => app().onRemoteClose(reason));
        if (opened.savePassword) {
          await this.store.savePassword(record.id, opened.savePassword);
          this.output.appendLine(`Saved the password for ${record.name}`);
        }
        return opened;
      },
      testConnection: async (record, update, options) => {
        const secret = await this.secretFor(record.id, update);
        this.output.appendLine(`Testing ${record.username}@${record.host}:${record.port}`);
        const opened = await this.openFor(record, secret, options, () => undefined);
        const files = opened.session.hasFiles ? opened.session.hasFiles() : true;
        opened.session.close();
        return { detail: files ? 'SFTP works' : 'terminal only, no SFTP' };
      },
      lastUsed: () => this.store.lastUsed(),
      markUsed: (id) => this.store.markUsed(id),
      theme: () => ({
        // activeColorTheme is missing in old hosts and test stubs: count those as dark.
        editorKind: editorThemeKind((vscode.window.activeColorTheme as vscode.ColorTheme | undefined)?.kind ?? 2),
        depth: parseColorDepth(settings().get<string>('colorDepth')),
        session: settings().get<boolean>('themeSession') !== false,
      }),
      downloadFolder: () => this.downloadFolder(),
      downloadLabel: () => downloadFolderLabel(this.downloadFolder(), this.folders.desktop, os.homedir()),
      plainClick: () => this.plainClick(),
      clickLabel: () => (this.plainClick() ? 'Click' : `${linkModifier()}+click`),
      confirmUpload: (question) => this.confirmUpload(question),
      resolveConflict: (existing, remoteDir) => this.resolveConflict(existing, remoteDir),
      confirmLocalUpload: (paths) => this.confirmLocalUpload(paths),
      clipboardText: async () => {
        try {
          return await vscode.env.clipboard.readText();
        } catch {
          return '';
        }
      },
      showProgress: (title, cancel) => this.showProgress(title, cancel),
      showActionMenu: (menu, update) => this.showActionMenu(menu, update),
      pickSaveFile: (folder, name) => this.pickSaveFile(folder, name),
      pickDownloadParent: (folder, name) => this.pickDownloadParent(folder, name),
      pickUploadFiles: (remoteDir) => this.pickUploadFiles(remoteDir),
      askRename: (request) => this.askRename(request),
      confirm: (message, detail, action) => this.confirm(message, detail, action),
      openRemoteFile: (remotePath) => this.openRemoteFile(liveOf(), remotePath),
      choose: (message, detail, answers) => this.choose(message, detail, answers),
      transferSettings: () => ({
        concurrency: numberSetting(settings().get('transferConcurrency'), 32, 1, 64),
        maxFiles: numberSetting(settings().get('maxTransferFiles'), 5000, 1, 100000),
      }),
      autoReconnect: () => settings().get<boolean>('autoReconnect') === true,
      setTitle: (title) => {
        const live = liveOf();
        if (live) live.pty.rename(title ? `SSH: ${title}` : live.terminal.name);
      },
      transferActive: (active) => {
        const live = liveOf();
        if (!live) return;
        live.transferring = active;
        if (this.active === live) this.applyStatus(live);
      },
      notify: (tone, text) => {
        if (tone === 'error') void vscode.window.showErrorMessage(`Easy SSH: ${text}`, 'Show Log').then((choice) => {
          if (choice) this.output.show(true);
        });
        else void vscode.window.showInformationMessage(`Easy SSH: ${text}`);
      },
      home: () => os.homedir(),
      chooseDownloadFolder: () => this.chooseDownloadFolder(),
      classifyDrop: (text) => classifyDrop(text, exists, os.homedir()),
      keyExists: (file) => {
        try {
          return fs.statSync(expandHome(file, os.homedir())).isFile();
        } catch {
          return false;
        }
      },
      scrollTerminal: (direction) => {
        const command = direction === 'up' ? 'workbench.action.terminal.scrollUp' : 'workbench.action.terminal.scrollDown';
        void vscode.commands.executeCommand(command);
      },
      setStatus: (text) => {
        const live = liveOf();
        if (live) live.status = text;
        if (live && this.active === live) this.applyStatus(live);
      },
      log: (line) => {
        this.output.appendLine(line);
      },
      quit: () => {
        liveOf()?.pty.end();
      },
    };
  }

  /** The status item shows only while an Easy SSH terminal is open (U10). */
  private applyStatus(live: LiveTerminal | undefined): void {
    if (this.lives.length === 0 || !live) {
      this.status.text = '$(remote) Easy SSH';
      this.status.tooltip = 'Open Easy SSH';
      this.status.command = 'easySsh.open';
      if (this.lives.length === 0) this.status.hide();
      return;
    }
    const text = live.status;
    this.status.show();
    if (live.transferring) {
      this.status.command = 'easySsh.cancelTransfer';
      this.status.tooltip = `${text ?? 'Transfer'}\nClick to cancel the transfer`;
    } else {
      this.status.command = 'easySsh.open';
      this.status.tooltip = text ?? 'Open Easy SSH';
    }
    if (!text) {
      this.status.text = '$(remote) Easy SSH';
      return;
    }
    const shown = text.length > 60 ? `${text.slice(0, 24)}…${text.slice(-30)}` : text;
    this.status.text = live.transferring ? `$(sync~spin) ${shown}` : `$(remote) ${shown}`;
  }

  private async importConfig(): Promise<{ ok: boolean; message: string }> {
    try {
      const hosts = loadSshConfig();
      const envUser = process.env.USER || process.env.USERNAME || 'root';
      const { connections, skipped, proxyCommand } = connectionsFromHosts(hosts, envUser, os.homedir());
      const proxyText = proxyCommand.length
        ? ` Skipped ${proxyCommand.length} ProxyCommand host${proxyCommand.length === 1 ? '' : 's'} (${proxyCommand.join(', ')}): use ProxyJump instead.`
        : '';
      if (proxyCommand.length) this.output.appendLine(`Import: ProxyCommand is not supported, skipped ${proxyCommand.join(', ')}`);
      if (connections.length === 0) {
        const message = proxyCommand.length
          ? `Nothing imported.${proxyText}`
          : skipped
            ? 'Only wildcard hosts were found in ~/.ssh/config'
            : 'No hosts found in ~/.ssh/config';
        return { ok: false, message };
      }
      const existing = await this.store.list();
      const taken = new Set(existing.map((record) => record.id));
      let added = 0;
      const updated: string[] = [];
      let unchanged = 0;
      for (const imported of connections) {
        const match = existing.find((record) => record.name === imported.name);
        if (match) {
          const { record, changed } = mergeImported(match, imported);
          if (changed.length === 0) {
            unchanged += 1;
            continue;
          }
          const keepSecret = record.auth === match.auth && record.privateKeyPath === match.privateKeyPath;
          await this.store.save(record, keepSecret ? { action: 'keep' } : { action: 'clear' });
          updated.push(`${record.name}: ${changed.join(', ')}`);
          this.output.appendLine(`Import updated ${record.name} (${changed.join(', ')})`);
          continue;
        }
        const id = importId(imported.name, taken);
        taken.add(id);
        const record: ConnectionRecord = {
          id,
          name: imported.name,
          host: imported.host,
          port: imported.port,
          username: imported.username,
          auth: imported.auth,
          privateKeyPath: imported.privateKeyPath,
          jumps: imported.jumps,
        };
        await this.store.save(record, { action: 'clear' });
        existing.push(record);
        added += 1;
      }
      const updatedText = updated.length ? `, updated ${updated.length} (${updated.join('; ')})` : '';
      const unchangedText = unchanged ? `, ${unchanged} unchanged` : '';
      return {
        ok: true,
        message: `Imported ${added} new${updatedText}${unchangedText} from ~/.ssh/config.${proxyText}`,
      };
    } catch (err) {
      if (err instanceof MissingSshConfig) return { ok: false, message: err.message };
      const message = err instanceof Error ? err.message : 'Could not import ~/.ssh/config';
      return { ok: false, message };
    }
  }
}
