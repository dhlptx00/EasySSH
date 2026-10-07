import assert from 'node:assert/strict';
import Module from 'node:module';
import { describe, it } from 'node:test';

/** Just enough of the vscode API for the controller to open terminals and provide links. */
const created: { name: string; exitStatus: undefined; show(): void }[] = [];
const commandLog: string[] = [];
const shownDocuments: string[] = [];
let onCommand: (command: string) => void = () => {};
const config: Record<string, unknown> = { maximizePanel: false };
const vscodeStub = {
  TerminalLink: class {
    constructor(readonly startIndex: number, readonly length: number, readonly tooltip?: string) {}
  },
  ThemeIcon: class {
    constructor(readonly id: string) {}
  },
  EventEmitter: class {
    event = () => ({ dispose() {} });
    fire() {}
  },
  TerminalLocation: { Panel: 1, Editor: 2 },
  ProgressLocation: { Notification: 15 },
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { Global: 1 },
  Uri: {
    from: (parts: { scheme: string; authority: string; path: string }) => ({ ...parts, toString: () => `${parts.scheme}://${parts.authority}${parts.path}` }),
  },
  window: {
    showTextDocument: async (uri: { toString(): string }) => {
      shownDocuments.push(uri.toString());
      return undefined;
    },
    activeTerminal: undefined,
    createTerminal: (options: { name: string }) => {
      const terminal = { name: options.name, exitStatus: undefined, show() {} };
      created.push(terminal);
      return terminal;
    },
  },
  workspace: { getConfiguration: () => ({ get: (key: string) => config[key] }) },
  commands: {
    executeCommand: async (command: string) => {
      commandLog.push(command);
      onCommand(command);
      return undefined;
    },
  },
};

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const original = loader._load;
loader._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return original.call(this, request, parent, isMain);
};

describe('controller: two Easy SSH terminals', () => {
  it('routes links and clicks by terminal instance, not by name or focus', async () => {
    const { EasySshController } = await import('./controller');
    const status = { text: '', tooltip: '', command: '', show() {}, hide() {} };
    const output = { appendLine() {}, show() {} };
    const controller = new EasySshController({} as never, output as never, status as never, 'linux');
    controller.newTerminal();
    controller.newTerminal();
    assert.deepEqual(created.map((terminal) => terminal.name), ['Easy SSH', 'Easy SSH 2']);

    const lives = (controller as unknown as { lives: { terminal: unknown; app: Record<string, unknown> }[] }).lives;
    const opened: string[] = [];
    lives.forEach((live, index) => {
      const tag = index === 0 ? 'left' : 'right';
      live.app.linkFor = (line: string) => [{ start: 0, length: line.length, remotePath: `/${tag}/${line}`, kind: 'file', tooltip: tag }];
      live.app.activateLink = (link: { remotePath: string }) => opened.push(`${tag}:${link.remotePath}`);
    });

    // The left pane is focused (the active terminal), the right pane is hovered.
    controller.noteActiveTerminal(created[0] as never);
    const rightLinks = controller.provideTerminalLinks({ line: 'a.txt', terminal: created[1] } as never);
    assert.equal(rightLinks.length, 1);
    assert.equal(rightLinks[0].link.remotePath, '/right/a.txt');
    controller.handleTerminalLink(rightLinks[0]);
    const leftLinks = controller.provideTerminalLinks({ line: 'b.txt', terminal: created[0] } as never);
    controller.handleTerminalLink(leftLinks[0]);
    assert.deepEqual(opened, ['right:/right/a.txt', 'left:/left/b.txt']);

    // A terminal Easy SSH did not create gets no links, even with the same name.
    const impostor = { name: 'Easy SSH 2', exitStatus: undefined, show() {} };
    assert.deepEqual(controller.provideTerminalLinks({ line: 'a.txt', terminal: impostor } as never), []);

    // A session renames the tab and VS Code reports the new name; ending it restores the one Easy SSH gave.
    const renames: string[] = [];
    const first = (controller as unknown as { lives: { pty: { rename(name: string): void }; app: { host: { setTitle(title?: string): void } } }[] }).lives[0];
    first.pty.rename = (name) => {
      renames.push(name);
      created[0].name = name;
    };
    first.app.host.setTitle('web-01');
    assert.equal(created[0].name, 'SSH: web-01');
    controller.newTerminal();
    assert.equal(created[2].name, 'Easy SSH 3', 'a renamed tab keeps its Easy SSH name reserved');
    first.app.host.setTitle(undefined);
    assert.deepEqual(renames, ['SSH: web-01', 'Easy SSH']);

    // Closing the left pane keeps the right one working.
    controller.onClosed(created[0] as never);
    assert.equal(controller.provideTerminalLinks({ line: 'c', terminal: created[1] } as never)[0].link.remotePath, '/right/c');
  });
});

describe('controller helpers', () => {
  it('sends VS Code to the Marketplace and other editors to Open VSX for a rating', async () => {
    const { ratingUrl } = await import('./controller');
    assert.match(ratingUrl('vscode'), /marketplace\.visualstudio\.com.*review-details/);
    assert.match(ratingUrl('vscode-insiders'), /marketplace/);
    for (const scheme of ['cursor', 'vscodium', 'windsurf', 'code-oss']) assert.match(ratingUrl(scheme), /open-vsx\.org\/extension\/easy-ssh\/easy-ssh\/reviews/);
  });

  it('names the link key of the machine showing the window, or both when unknown (code-server)', async () => {
    const { linkModifier } = await import('./controller');
    assert.equal(linkModifier('darwin', 'alt'), 'Cmd');
    assert.equal(linkModifier('win32', undefined), 'Ctrl');
    assert.equal(linkModifier('linux', 'ctrlCmd'), 'Alt');
    assert.equal(linkModifier('darwin', 'ctrlCmd'), 'Option');
    assert.equal(linkModifier(undefined, 'alt'), 'Ctrl/Cmd');
    assert.equal(linkModifier(undefined, 'ctrlCmd'), 'Alt/Option');
  });

  it('clamps number settings and falls back on bad values', async () => {
    const { numberSetting } = await import('./controller');
    assert.equal(numberSetting(undefined, 32, 1, 64), 32);
    assert.equal(numberSetting('8', 32, 1, 64), 32);
    assert.equal(numberSetting(Number.NaN, 32, 1, 64), 32);
    assert.equal(numberSetting(500, 32, 1, 64), 64);
    assert.equal(numberSetting(0, 32, 1, 64), 1);
    assert.equal(numberSetting(7.9, 32, 1, 64), 7);
  });

  it('finds the agent: SSH_AUTH_SOCK, then the Windows OpenSSH pipe or Pageant (F7)', async () => {
    const { resolveAgent } = await import('./controller');
    const pipe = '\\\\.\\pipe\\openssh-ssh-agent';
    assert.equal(resolveAgent({ SSH_AUTH_SOCK: '/tmp/a.sock' }, 'win32', 'pageant', () => false), '/tmp/a.sock');
    assert.equal(resolveAgent({}, 'linux', 'auto', () => true), undefined);
    assert.equal(resolveAgent({}, 'win32', 'auto', () => true), pipe);
    assert.equal(resolveAgent({}, 'win32', 'auto', () => false), 'pageant');
    assert.equal(resolveAgent({}, 'win32', 'pageant', () => true), 'pageant');
    assert.equal(resolveAgent({}, 'win32', 'openssh', () => false), pipe);
  });

  it('lists the default identity files ssh would try, in order (F7)', async () => {
    const { defaultIdentityFiles } = await import('./controller');
    const path = await import('node:path');
    const home = path.join('/', 'home', 'me');
    const present = new Set([path.join(home, '.ssh', 'id_rsa'), path.join(home, '.ssh', 'id_ed25519')]);
    assert.deepEqual(defaultIdentityFiles(home, (file) => present.has(file)), [path.join(home, '.ssh', 'id_ed25519'), path.join(home, '.ssh', 'id_rsa')]);
  });
});

describe('controller: panel maximize (B10)', () => {
  const MAX = 'workbench.action.toggleMaximizedPanel';

  async function open(startRows: number, maximizedAlready: boolean, setting = true) {
    config.maximizePanel = setting;
    const { EasySshController } = await import('./controller');
    const status = { text: '', tooltip: '', command: '', show() {}, hide() {} };
    const controller = new EasySshController({} as never, { appendLine() {}, show() {} } as never, status as never, 'linux');
    commandLog.length = 0;
    controller.newTerminal();
    const lives = (controller as unknown as { lives: { terminal: never; pty: { rows: number } }[] }).lives;
    const live = lives[lives.length - 1];
    let maximized = maximizedAlready;
    onCommand = (command) => {
      if (command !== MAX) return;
      maximized = !maximized;
      live.pty.rows = maximized ? 40 : 12;
    };
    live.pty.rows = startRows;
    await new Promise((resolve) => setTimeout(resolve, 600));
    return {
      controller,
      live,
      restore: () => {
        onCommand = () => {};
        config.maximizePanel = false;
      },
    };
  }

  it('maximizes a normal panel and restores it on close', async () => {
    const { controller, live, restore } = await open(12, false);
    assert.deepEqual(commandLog.filter((item) => item === MAX).length, 1);
    controller.onClosed(live.terminal);
    assert.deepEqual(commandLog.filter((item) => item === MAX).length, 2);
    restore();
  });

  it('leaves an already maximized panel maximized, and does not touch it on close', async () => {
    const { controller, live, restore } = await open(40, true);
    // The toggle restored it, so Easy SSH toggled it straight back.
    assert.equal(commandLog.filter((item) => item === MAX).length, 2);
    assert.equal(live.pty.rows, 40);
    controller.onClosed(live.terminal);
    assert.equal(commandLog.filter((item) => item === MAX).length, 2);
    restore();
  });

  it('does not restore a panel the user restored already', async () => {
    const { controller, live, restore } = await open(12, false);
    live.pty.rows = 12;
    controller.onClosed(live.terminal);
    assert.equal(commandLog.filter((item) => item === MAX).length, 1);
    restore();
  });

  it('never touches the panel with easySsh.maximizePanel off', async () => {
    const { controller, live, restore } = await open(12, false, false);
    controller.onClosed(live.terminal);
    assert.equal(commandLog.filter((item) => item === MAX).length, 0);
    restore();
  });
});

describe('controller: remote files in editor tabs', () => {
  it('names a terminal\'s files easyssh://<connection>/<path>, numbered when two terminals share a connection', async () => {
    const { EasySshController, editorAuthority } = await import('./controller');
    assert.equal(editorAuthority('web-01'), 'web-01');
    assert.equal(editorAuthority('My Server (prod)'), 'My-Server-prod');
    assert.equal(editorAuthority('***'), 'server');
    const status = { text: '', tooltip: '', command: '', show() {}, hide() {} };
    const output = { appendLine() {}, show() {} };
    const controller = new EasySshController({} as never, output as never, status as never, 'linux');
    controller.newTerminal();
    controller.newTerminal();
    const lives = (controller as unknown as { lives: { app: Record<string, unknown> }[] }).lives.slice(-2);
    const sessions = [{ name: 'left' }, null];
    lives.forEach((live, index) => {
      live.app.connectionLabel = () => 'web-01';
      live.app.editorSession = () => (sessions[index] ? { ...sessions[index], readWhole() {}, writeWhole() {}, makeDir() {}, stat() {}, remove() {}, rename() {} } : null);
    });
    const hostOf = (live: { app: Record<string, unknown> }) => (live.app as unknown as { host: { openRemoteFile(path: string): Promise<void> } }).host;
    await hostOf(lives[0]).openRemoteFile('/etc/hosts');
    await hostOf(lives[1]).openRemoteFile('/etc/hosts');
    assert.deepEqual(shownDocuments.slice(-2), ['easyssh://web-01/etc/hosts', 'easyssh://web-01-2/etc/hosts']);
    // The second terminal is disconnected: its files say so.
    await assert.rejects(controller.remoteFiles.read('web-01-2', '/etc/hosts'), /web-01 is disconnected/);
    await assert.rejects(controller.remoteFiles.read('web-01-3', '/etc/hosts'), /is closed/);
    // A tab restored after a reload goes to a new connected terminal for the same connection.
    controller.newTerminal();
    const third = (controller as unknown as { lives: { app: Record<string, unknown>; authority?: string }[] }).lives.slice(-1)[0];
    third.app.connectionLabel = () => 'web-01';
    third.app.editorSession = () => ({ readWhole() {}, writeWhole() {}, makeDir() {}, stat() {}, remove() {}, rename() {} });
    const target = (controller as unknown as { editorTarget(authority: string): { label: string } | undefined }).editorTarget.bind(controller);
    assert.equal(target('db-01'), undefined);
    assert.equal(target('web-01-x'), undefined);
    assert.equal(target('web-01-3')?.label, 'web-01');
    assert.equal(third.authority, 'web-01-3');
    // Once it has files, it does not take another connection's name.
    assert.equal(target('web-01-4'), undefined);
  });
});
