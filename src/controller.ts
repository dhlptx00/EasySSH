import fs from 'fs';
import os from 'os';
import path from 'path';
import * as vscode from 'vscode';
import { classifyDrop } from './shellTokens';
import { connectionsFromHosts } from './ssh/importConfig';
import { loadSshConfig, MissingSshConfig } from './ssh/loadConfig';
import { openSession } from './ssh/session';
import { ConnectionStore } from './store';
import { EasySshApp } from './terminal/app';
import type { AppHost } from './terminal/host';
import { EasySshPty } from './terminal/pty';
import { expandHome, safeFileName, uniqueLocalPath } from './text';
import type { ConnectionRecord, SecretUpdate } from './types';

class PathLink extends vscode.TerminalLink {
  constructor(
    startIndex: number,
    length: number,
    readonly remotePath: string,
    tooltip: string,
  ) {
    super(startIndex, length, tooltip);
  }
}

function readyTimeout(): number {
  const value = vscode.workspace.getConfiguration('easySsh').get<number>('readyTimeout');
  if (typeof value !== 'number' || !Number.isFinite(value)) return 20000;
  return Math.max(3000, Math.floor(value));
}

export function resolveDownloadFolder(configured: string | undefined): string {
  const home = os.homedir();
  if (configured && configured.trim()) {
    const expanded = expandHome(configured.trim(), home);
    if (fs.existsSync(expanded)) return expanded;
  }
  const desktop = path.join(home, 'Desktop');
  if (fs.existsSync(desktop)) return desktop;
  const downloads = path.join(home, 'Downloads');
  if (fs.existsSync(downloads)) return downloads;
  return home;
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

export class EasySshController implements vscode.TerminalLinkProvider<PathLink> {
  private pty: EasySshPty | undefined;
  private terminal: vscode.Terminal | undefined;
  private app: EasySshApp | undefined;

  constructor(
    private readonly store: ConnectionStore,
    private readonly output: vscode.OutputChannel,
    private readonly status: vscode.StatusBarItem,
  ) {
    this.status.text = '$(remote) Easy SSH';
    this.status.tooltip = 'Open Easy SSH';
  }

  open(): void {
    if (this.terminal && this.terminal.exitStatus === undefined) {
      this.terminal.show();
      return;
    }
    let app!: EasySshApp;
    app = new EasySshApp(this.createHost(() => app), (data) => this.pty?.write(data));
    this.app = app;
    this.pty = new EasySshPty(app);
    this.terminal = vscode.window.createTerminal({
      name: 'Easy SSH',
      pty: this.pty,
      iconPath: new vscode.ThemeIcon('remote'),
      isTransient: true,
      location: vscode.TerminalLocation.Panel,
    });
    this.terminal.show();
  }

  onClosed(terminal: vscode.Terminal): void {
    if (terminal !== this.terminal) return;
    this.terminal = undefined;
    this.pty = undefined;
    this.app = undefined;
    this.status.text = '$(remote) Easy SSH';
  }

  async setDownloadFolder(): Promise<void> {
    const folder = await this.chooseDownloadFolder();
    if (folder) void vscode.window.showInformationMessage(`Easy SSH downloads to ${folder}`);
  }

  async resetHostKeys(): Promise<void> {
    await this.store.resetHostKeys();
    void vscode.window.showInformationMessage('Easy SSH forgot its saved host keys.');
  }

  provideTerminalLinks(context: vscode.TerminalLinkContext): PathLink[] {
    if (!this.app || context.terminal !== this.terminal) return [];
    const link = this.app.linkFor(context.line);
    if (!link || link.length <= 0) return [];
    return [new PathLink(link.start, link.length, link.remotePath, link.tooltip)];
  }

  handleTerminalLink(link: PathLink): void {
    this.app?.activatePath(link.remotePath);
  }

  private downloadFolder(): string {
    return resolveDownloadFolder(vscode.workspace.getConfiguration('easySsh').get<string>('downloadFolder'));
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
    await vscode.workspace.getConfiguration('easySsh').update('downloadFolder', folder, vscode.ConfigurationTarget.Global);
    return folder;
  }

  private createHost(app: () => EasySshApp): AppHost {
    return {
      listConnections: () => this.store.list(),
      saveConnection: (record, secret) => this.store.save(record, secret),
      deleteConnection: (id) => this.store.delete(id),
      secretFlags: (id) => this.store.secretFlags(id),
      importConfig: () => this.importConfig(),
      connect: async (record, options) => {
        const secret = await this.store.secret(record.id);
        return openSession({
          record,
          secret,
          known: {
            get: (host, port) => this.store.getHostKey(host, port),
            trust: (host, port, fingerprint) => this.store.trustHost(host, port, fingerprint),
          },
          readyTimeout: readyTimeout(),
          acceptChangedKey: options.acceptChangedKey,
          signal: options.signal,
          onClose: () => app().onRemoteClose(),
        });
      },
      downloadFolder: () => this.downloadFolder(),
      home: () => os.homedir(),
      clickHint: () => process.platform === 'darwin' ? 'cmd-click a file to download' : 'ctrl-click a file to download',
      chooseDownloadFolder: () => this.chooseDownloadFolder(),
      chooseUploadFiles: async () => {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectMany: true,
          canSelectFolders: false,
          openLabel: 'Upload',
          defaultUri: vscode.Uri.file(os.homedir()),
        });
        return picked?.map((item) => item.fsPath) ?? [];
      },
      classifyDrop: (text) => classifyDrop(text, (file) => {
        try {
          return fs.existsSync(file);
        } catch {
          return false;
        }
      }, os.homedir()),
      localDownloadPath: (name) => uniqueLocalPath(this.downloadFolder(), safeFileName(name), (file) => fs.existsSync(file)),
      keyExists: (file) => {
        try {
          return fs.statSync(expandHome(file, os.homedir())).isFile();
        } catch {
          return false;
        }
      },
      setStatus: (text) => {
        if (!text) {
          this.status.text = '$(remote) Easy SSH';
          this.status.tooltip = 'Open Easy SSH';
          return;
        }
        const shown = text.length > 60 ? `${text.slice(0, 24)}…${text.slice(-30)}` : text;
        this.status.text = `$(remote) ${shown}`;
        this.status.tooltip = text;
      },
      log: (line) => {
        this.output.appendLine(line);
      },
      quit: () => this.pty?.end(),
    };
  }

  private async importConfig(): Promise<{ ok: boolean; message: string }> {
    try {
      const hosts = loadSshConfig();
      const envUser = process.env.USER || process.env.USERNAME || 'root';
      const { connections, skipped } = connectionsFromHosts(hosts, envUser, os.homedir());
      if (connections.length === 0) {
        const message = skipped
          ? 'Only wildcard hosts were found in ~/.ssh/config'
          : 'No hosts found in ~/.ssh/config';
        return { ok: false, message };
      }
      const existing = await this.store.list();
      const taken = new Set(existing.map((record) => record.id));
      let added = 0;
      let updated = 0;
      for (const imported of connections) {
        const match = existing.find((record) => record.name === imported.name);
        const id = match?.id ?? importId(imported.name, taken);
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
        const secret: SecretUpdate = match && match.auth === record.auth && match.privateKeyPath === record.privateKeyPath
          ? { action: 'keep' }
          : { action: 'clear' };
        await this.store.save(record, secret);
        if (match) updated += 1;
        else {
          added += 1;
          existing.push(record);
        }
      }
      const skippedText = skipped ? `. Skipped ${skipped} wildcard hosts` : '';
      return {
        ok: true,
        message: `Imported ${added} and updated ${updated} from ~/.ssh/config${skippedText}`,
      };
    } catch (err) {
      if (err instanceof MissingSshConfig) return { ok: false, message: err.message };
      const message = err instanceof Error ? err.message : 'Could not import ~/.ssh/config';
      return { ok: false, message };
    }
  }
}
