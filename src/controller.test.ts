import assert from 'node:assert/strict';
import Module from 'node:module';
import { describe, it } from 'node:test';

/** Just enough of the vscode API for the controller to open terminals and provide links. */
const created: { name: string; exitStatus: undefined; show(): void }[] = [];
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
  TerminalLocation: { Panel: 1 },
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { Global: 1 },
  window: {
    activeTerminal: undefined,
    createTerminal: (options: { name: string }) => {
      const terminal = { name: options.name, exitStatus: undefined, show() {} };
      created.push(terminal);
      return terminal;
    },
  },
  workspace: { getConfiguration: () => ({ get: () => undefined }) },
  commands: { executeCommand: async () => undefined },
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
    const status = { text: '', tooltip: '', command: '', show() {} };
    const output = { appendLine() {}, show() {} };
    const controller = new EasySshController({} as never, output as never, status as never);
    controller.newTerminal();
    controller.newTerminal();
    assert.deepEqual(created.map((terminal) => terminal.name), ['Easy SSH', 'Easy SSH 2']);

    const lives = (controller as unknown as { lives: { terminal: unknown; app: Record<string, unknown> }[] }).lives;
    const opened: string[] = [];
    lives.forEach((live, index) => {
      const tag = index === 0 ? 'left' : 'right';
      live.app.linkFor = (line: string) => [{ start: 0, length: line.length, remotePath: `/${tag}/${line}`, kind: 'file', tooltip: tag }];
      live.app.activatePath = (path: string) => opened.push(`${tag}:${path}`);
    });

    // The left pane is focused (the active terminal), the right pane is hovered.
    controller.noteActiveTerminal(created[0] as never);
    const rightLinks = controller.provideTerminalLinks({ line: 'a.txt', terminal: created[1] } as never);
    assert.equal(rightLinks.length, 1);
    assert.equal(rightLinks[0].remotePath, '/right/a.txt');
    controller.handleTerminalLink(rightLinks[0]);
    const leftLinks = controller.provideTerminalLinks({ line: 'b.txt', terminal: created[0] } as never);
    controller.handleTerminalLink(leftLinks[0]);
    assert.deepEqual(opened, ['right:/right/a.txt', 'left:/left/b.txt']);

    // A terminal Easy SSH did not create gets no links, even with the same name.
    const impostor = { name: 'Easy SSH 2', exitStatus: undefined, show() {} };
    assert.deepEqual(controller.provideTerminalLinks({ line: 'a.txt', terminal: impostor } as never), []);

    // Closing the left pane keeps the right one working.
    controller.onClosed(created[0] as never);
    assert.equal(controller.provideTerminalLinks({ line: 'c', terminal: created[1] } as never)[0].remotePath, '/right/c');
  });
});
