import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConnectionRecord, SecretUpdate } from '../types';
import { EasySshApp } from './app';
import type { AppHost } from './host';
import type { InputEvent } from './input';
import { fakeRemote, flush } from './testHost';
import type { ThemeChoice } from './theme';

const prod: ConnectionRecord = {
  id: 'p',
  name: 'prod-web',
  host: 'prod-web.example.com',
  port: 22,
  username: 'deploy',
  auth: 'privateKey',
  privateKeyPath: '/Users/me/.ssh/id_ed25519',
  jumps: [{ host: 'bastion.example.com', port: 22, username: 'dev', auth: 'privateKey', privateKeyPath: '/Users/me/.ssh/id_ed25519' }],
};
const bastion: ConnectionRecord = { id: 'b', name: 'bastion', host: 'bastion.example.com', port: 22, username: 'dev', auth: 'agent', jumps: [] };

interface Rig {
  app: EasySshApp;
  saved: { record: ConnectionRecord; secret: SecretUpdate }[];
  deleted: string[];
  tests: { record: ConnectionRecord; secret: SecretUpdate }[];
  themes: ThemeChoice[];
  screen(): string;
  send(...events: InputEvent[]): Promise<void>;
  type(text: string): Promise<void>;
}

const key = (name: string): InputEvent => ({ type: 'key', key: name } as InputEvent);
const enter = key('enter');

async function rig(options: { records?: ConnectionRecord[]; test?: () => Promise<{ detail?: string }>; lastUsed?: Record<string, number> } = {}): Promise<Rig> {
  const records = [...(options.records ?? [bastion, prod])];
  const chunks: string[] = [];
  let theme: ThemeChoice = 'auto';
  const out: Omit<Rig, 'app' | 'screen' | 'send' | 'type'> = { saved: [], deleted: [], tests: [], themes: [] };
  const host: AppHost = {
    listConnections: async () => records,
    saveConnection: async (record, secret) => {
      out.saved.push({ record, secret });
    },
    deleteConnection: async (id) => {
      out.deleted.push(id);
    },
    secretFlags: async () => ({ password: false, passphrase: true }),
    importConfig: async () => ({ ok: true, message: 'Imported 0' }),
    connect: async () => {
      throw new Error('not here');
    },
    testConnection: async (record, secret) => {
      out.tests.push({ record, secret });
      return options.test ? options.test() : { detail: 'SFTP works' };
    },
    lastUsed: () => options.lastUsed ?? {},
    theme: () => ({ choice: theme, editorKind: 'light', depth: 'truecolor' }),
    setTheme: async (choice) => {
      theme = choice;
      out.themes.push(choice);
    },
    downloadFolder: () => '/Users/me/Downloads',
    home: () => '/Users/me',
    chooseDownloadFolder: async () => undefined,
    classifyDrop: () => null,
    keyExists: (file) => file === '/Users/me/.ssh/id_ed25519',
    setStatus: () => {},
    log: () => {},
    scrollTerminal: () => {},
    quit: () => {},
  };
  const app = new EasySshApp(host, (data) => chunks.push(data));
  app.setSize(110, 34);
  app.open();
  await flush();
  const send = async (...events: InputEvent[]) => {
    for (const event of events) {
      app.onInput([event]);
      await flush();
    }
  };
  return {
    app,
    ...out,
    // The last full frame, without escape codes.
    screen: () => {
      const all = chunks.join('');
      const last = all.lastIndexOf('\x1b[H\x1b[?25l');
      return all.slice(last).replace(/\x1b\[\d+;1H\x1b\[0m\x1b\[2K/g, '\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    },
    send,
    type: async (text: string) => send({ type: 'text', text }, enter),
  };
}

describe('the /new wizard', () => {
  it('walks Step 1 of N, checks each field, and ends on a summary with the ssh command', async () => {
    const r = await rig();
    await r.type('/new');
    assert.match(r.screen(), /New connection\s+Step 1 of 6/);
    assert.match(r.screen(), /╭─ Connection name/);
    await r.send(enter);
    assert.match(r.screen(), /✗ Name is required/);
    await r.type('prod-api');
    assert.match(r.screen(), /Step 2 of 6/);
    await r.send(enter);
    assert.match(r.screen(), /✗ Host is required/);
    await r.type('prod-api.example.com');
    await r.type('22x');
    assert.match(r.screen(), /✗ Port must be a number, such as 22/);
    await r.send(key('ctrl-u'));
    await r.type('70000');
    assert.match(r.screen(), /✗ Port must be between 1 and 65535/);
    await r.send(key('ctrl-u'));
    await r.type('2222');
    await r.type('deploy');
    assert.match(r.screen(), /╭─ Sign-in method/);
    await r.send(key('down'), enter);
    assert.match(r.screen(), /Step 6 of 8/);
    await r.type('~/.ssh/missing');
    assert.match(r.screen(), /✗ Key file not found: \/Users\/me\/\.ssh\/missing/);
    await r.send(key('ctrl-u'));
    await r.type('~/.ssh/id_ed25519');
    await r.type('secret phrase');
    assert.match(r.screen(), /╭─ Jump host/);
    await r.send(enter);
    const summary = r.screen();
    assert.match(summary, /New connection\s+Review/);
    assert.match(summary, /\$ ssh -p 2222 -i ~\/\.ssh\/id_ed25519 deploy@prod-api\.example\.com/);
    assert.match(summary, /Key ~\/\.ssh\/id_ed25519 · new passphrase/);
    assert.doesNotMatch(summary, /secret phrase/);
    assert.match(summary, /› Save/);
    assert.equal(r.saved.length, 0, 'nothing is saved before Save');

    await r.send({ type: 'text', text: 't' });
    assert.equal(r.tests.length, 1);
    assert.equal(r.tests[0].record.host, 'prod-api.example.com');
    assert.deepEqual(r.tests[0].secret, { action: 'set', passphrase: 'secret phrase' });
    assert.match(r.screen(), /✓ Connected and signed in to deploy@prod-api\.example\.com:2222 in \d+\.\d s · SFTP works\. Not saved yet/);
    assert.equal(r.saved.length, 0, 'a test does not save');

    await r.send(enter);
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].record.port, 2222);
    assert.match(r.screen(), /Saved prod-api/);
  });

  it('goes back with Esc, from the summary to the last step and from the first step to the list', async () => {
    const r = await rig();
    await r.type('/new');
    await r.type('a');
    assert.match(r.screen(), /Step 2 of 6/);
    await r.send(key('escape'));
    assert.match(r.screen(), /Step 1 of 6/);
    await r.type('a');
    await r.type('h');
    await r.type('');
    await r.type('u');
    await r.send(key('down'), key('down'), enter);
    await r.send(enter);
    assert.match(r.screen(), /Review/);
    await r.send(key('escape'));
    assert.match(r.screen(), /╭─ Jump host/);
    for (let index = 0; index < 6; index += 1) await r.send(key('escape'));
    assert.match(r.screen(), /NAME\s+HOST/);
  });

  it('reports a failed test without leaving the summary', async () => {
    const r = await rig({ test: async () => Promise.reject(new Error('All configured authentication methods failed')) });
    await r.type('/new');
    for (const value of ['x', 'x.example.com', '', 'root']) await r.type(value);
    await r.send(key('down'), key('down'), enter, enter);
    await r.send(key('up'), enter);
    assert.equal(r.tests.length, 1);
    assert.match(r.screen(), /✗ Test failed:/);
    assert.match(r.screen(), /Review/);
  });
});

describe('/edit and /delete', () => {
  it('opens the field picker, changes one field, and saves the same id', async () => {
    const r = await rig();
    await r.type('/edit');
    assert.match(r.screen(), /Edit connection/);
    await r.send(key('down'), enter);
    const fields = r.screen();
    assert.match(fields, /Edit prod-web\s+Choose a field/);
    assert.match(fields, /Sign-in\s+Key ~\/\.ssh\/id_ed25519 · passphrase saved/);
    assert.match(fields, /Jump host\s+dev@bastion\.example\.com:22/);
    assert.match(fields, /-J dev@bastion\.example\.com deploy@prod-web\.example\.com/);
    await r.send(key('down'), enter);
    assert.match(r.screen(), /Edit prod-web · Host\s+Step 1 of 1/);
    assert.match(r.screen(), /Esc Summary/);
    await r.type('web2.example.com');
    assert.match(r.screen(), /Host\s+web2\.example\.com/);
    await r.send({ type: 'text', text: 's' });
    assert.equal(r.saved.length, 1);
    assert.equal(r.saved[0].record.id, 'p');
    assert.equal(r.saved[0].record.host, 'web2.example.com');
    assert.deepEqual(r.saved[0].secret, { action: 'keep' });
  });

  it('changes the sign-in through its own steps and returns before the jump host', async () => {
    const r = await rig();
    await r.type('/edit');
    await r.send(key('down'), enter);
    for (let index = 0; index < 4; index += 1) await r.send(key('down'));
    await r.send(enter);
    assert.match(r.screen(), /Sign-in method/);
    await r.send(key('up'), enter);
    assert.match(r.screen(), /Password storage/);
    await r.send(enter);
    await r.type('pa55');
    const back = r.screen();
    assert.match(back, /Choose a field/);
    assert.match(back, /Password \(new, stored securely\)/);
    assert.doesNotMatch(back, /pa55/);
  });

  it('Back on the field picker discards the changes', async () => {
    const r = await rig();
    await r.type('/edit');
    await r.send(key('down'), enter, key('escape'));
    assert.match(r.screen(), /No changes saved/);
    assert.equal(r.saved.length, 0);
  });

  it('asks in red with the name and host before deleting', async () => {
    const r = await rig();
    await r.type('/delete');
    await r.send(key('down'), enter);
    const ask = r.screen();
    assert.match(ask, /✗ Delete prod-web\?/);
    assert.match(ask, /Host\s+deploy@prod-web\.example\.com:22/);
    assert.match(ask, /key via bastion/);
    await r.send({ type: 'text', text: 'y' });
    assert.deepEqual(r.deleted, ['p']);
  });
});

describe('home', () => {
  it('starts on the connection used last and shows it on the Recent line', async () => {
    const r = await rig({ lastUsed: { b: Date.now() - 3 * 86400e3, p: Date.now() - 2 * 3600e3 } });
    const screen = r.screen();
    assert.match(screen, /Last: prod-web · deploy@prod-web\.example\.com · 2 h ago — Enter to reconnect/);
    assert.match(screen, /› prod-web/);
    assert.match(screen, /key via bastion/);
  });

  it('/theme cycles Auto, Dark, Light and stores each choice', async () => {
    const r = await rig();
    await r.type('/theme');
    assert.deepEqual(r.themes, ['dark']);
    assert.match(r.screen(), /Theme: Easy SSH Dark/);
    await r.type('/theme');
    await r.type('/theme');
    assert.deepEqual(r.themes, ['dark', 'light', 'auto']);
    assert.match(r.screen(), /Theme: Auto \(Easy SSH Light, follows VS Code\)/);
  });

  it('remembers a successful connect', async () => {
    const remote = fakeRemote();
    const used: string[] = [];
    const app = new EasySshApp({ ...remote.host, markUsed: async (id) => void used.push(id) }, () => {});
    app.setSize(100, 30);
    app.open();
    await flush();
    app.onInput([{ type: 'key', key: 'enter' }]);
    await flush();
    await flush();
    assert.deepEqual(used, [remote.record.id]);
    app.dispose();
  });

  it('selects the connection just used when the session ends', async () => {
    const remote = fakeRemote();
    const other: ConnectionRecord = { ...bastion, name: 'aaa-first' };
    let closeShell: (() => void) | undefined;
    const open = remote.session.openShell;
    remote.session.openShell = async (columns, rows, data, closed) => {
      closeShell = closed;
      await open(columns, rows, data, closed);
    };
    const chunks: string[] = [];
    const app = new EasySshApp({ ...remote.host, listConnections: async () => [other, remote.record] }, (data) => chunks.push(data));
    app.setSize(100, 30);
    app.open();
    await flush();
    app.onInput([...`/${remote.record.name}`].map((ch) => ({ type: 'text', text: ch }) as InputEvent));
    app.onInput([{ type: 'key', key: 'enter' }]);
    await flush();
    await flush();
    chunks.length = 0;
    assert.ok(closeShell);
    closeShell();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await flush();
    const screen = chunks.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
    assert.match(screen, new RegExp(`› ${remote.record.name}`));
    app.dispose();
  });
});

describe('session colors', () => {
  it('paints the connected shell in the Easy SSH palette and restores the terminal colors after', async () => {
    const remote = fakeRemote();
    const chunks: string[] = [];
    let session = true;
    const app = new EasySshApp({
      ...remote.host,
      theme: () => ({ choice: 'light', editorKind: 'dark', depth: 'truecolor', session }),
    }, (data) => chunks.push(data));
    app.setSize(100, 30);
    app.open();
    await flush();
    assert.match(chunks.join(''), /\x1b\]12;#6d28d9\x07/i, 'the menu cursor uses the palette accent');
    chunks.length = 0;
    app.onInput([{ type: 'key', key: 'enter' }]);
    await flush();
    await flush();
    const connected = chunks.join('');
    assert.match(connected, /\x1b\]112\x07/, 'the menu cursor color is reset before the shell');
    assert.match(connected, /\x1b\]11;#f5f3ff\x07/, 'Easy SSH Light background in the session');
    chunks.length = 0;
    session = false;
    app.refreshTheme();
    assert.match(chunks.join(''), /\x1b\]111\x07/, 'turning it off restores the colors at once');
    session = true;
    app.refreshTheme();
    chunks.length = 0;
    app.onRemoteClose('gone');
    await flush();
    assert.match(chunks.join(''), /\x1b\]104\x07\x1b\]110\x07\x1b\]111\x07\x1b\]112\x07/, 'leaving the session restores the colors');
    app.dispose();
  });
});
