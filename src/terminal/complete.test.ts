import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrowseEntry } from '../types';
import type { ConnectionRecord } from '../types';
import { EasySshApp } from './app';
import { InputLine, completionQuery, completionSuffix } from './complete';
import type { AppHost, FileSession } from './host';

function entry(name: string, kind: BrowseEntry['kind']): BrowseEntry {
  return { name, path: `/${name}`, kind, size: 0, mtime: 0 };
}

const rootEntries = [
  entry('tmp', 'dir'),
  entry('home', 'dir'),
  entry('.hidden', 'dir'),
];

describe('path completion', () => {
  it('completes cd /tm to the /tmp directory', () => {
    const query = completionQuery('cd /tm', '/root');
    assert.deepEqual(query, { dir: '/', prefix: 'tm', dirsOnly: true });
    assert.equal(completionSuffix('tm', rootEntries, true), 'p/');
  });

  it('inserts only a shared prefix when several directories match', () => {
    assert.equal(completionSuffix('tm', [entry('tmp', 'dir'), entry('tmp2', 'dir')], true), 'p');
    assert.equal(completionSuffix('tm', [entry('tmp', 'dir'), entry('tmb', 'dir')], true), null);
  });

  it('finishes a directory with a slash and a file with a space', () => {
    assert.equal(completionSuffix('tmp', [entry('tmp', 'dir')], true), '/');
    assert.equal(completionSuffix('notes', [entry('notes.txt', 'file')], false), '.txt ');
    assert.equal(completionSuffix('my', [entry('my file.txt', 'file')], false), '\\ file.txt ');
  });

  it('hides dotfiles until the prefix starts with a dot', () => {
    assert.equal(completionSuffix('', [entry('.hidden', 'dir'), entry('tmp', 'dir'), entry('home', 'dir')], true), null);
    assert.equal(completionSuffix('.', [entry('.hidden', 'dir'), entry('tmp', 'dir')], true), 'hidden/');
  });

  it('resolves a relative token against the working directory', () => {
    assert.deepEqual(completionQuery('cd tm', '/var/log'), { dir: '/var/log', prefix: 'tm', dirsOnly: true });
    assert.deepEqual(completionQuery('cd ../tm', '/var/log'), { dir: '/var', prefix: 'tm', dirsOnly: true });
    assert.deepEqual(completionQuery('ls /tm', '/root'), { dir: '/', prefix: 'tm', dirsOnly: false });
    assert.deepEqual(completionQuery('cd /tmp/', '/root'), { dir: '/tmp', prefix: '', dirsOnly: true });
  });

  it('leaves command names, quotes, and home shortcuts to the shell', () => {
    assert.equal(completionQuery('git che', '/root'), null);
    assert.equal(completionQuery('', '/root'), null);
    assert.equal(completionQuery('cd "/tm"', '/root'), null);
    assert.equal(completionQuery('cd ~/tm', '/root'), null);
    assert.equal(completionQuery('ls', '/root'), null);
  });

  it('tracks a typed line and forgets it after an arrow', () => {
    const line = new InputLine();
    line.observe('cd /tm');
    assert.equal(line.text(), 'cd /tm');
    line.observe('\x7f');
    assert.equal(line.text(), 'cd /t');
    line.observe('\x1b[A');
    assert.equal(line.text(), null);
    line.observe('x');
    assert.equal(line.text(), null);
    line.observe('\r');
    assert.equal(line.text(), '');
  });
});

describe('remote tab', () => {
  it('writes the /tmp suffix and does not also send Tab', async () => {
    const written: string[] = [];
    const listed: string[] = [];
    const chunks: string[] = [];
    const app = new EasySshApp(connectedHost(written, listed), (data) => chunks.push(data));
    app.setSize(80, 24);
    app.open();
    await flush();
    app.onInput([{ type: 'key', key: 'enter' }]);
    await flush();
    const shown = chunks.join('').replace(/\x1b\[[0-9;]*m/g, '');
    assert.match(shown, /Click a file name to download/);
    assert.doesNotMatch(shown, /Cmd-click|Select text/);
    for (const ch of 'cd /tm') app.onRawInput(ch);
    app.onRawInput('\t');
    await flush();
    assert.deepEqual(written, ['c', 'd', ' ', '/', 't', 'm', 'p/']);
    assert.equal(listed.at(-1), '/');
  });

  it('sends Tab when the line is not a path', async () => {
    const written: string[] = [];
    const app = new EasySshApp(connectedHost(written, []), () => {});
    app.setSize(80, 24);
    app.open();
    await flush();
    app.onInput([{ type: 'key', key: 'enter' }]);
    await flush();
    app.onRawInput('git che');
    app.onRawInput('\t');
    await flush();
    assert.deepEqual(written, ['git che', '\t']);
  });
});

const record: ConnectionRecord = {
  id: '1',
  name: 'prod',
  host: '10.0.0.8',
  port: 22,
  username: 'root',
  auth: 'agent',
  jumps: [],
};

function connectedHost(written: string[], listed: string[]): AppHost {
  let shell = false;
  const session: FileSession = {
    list: async (dir) => {
      listed.push(dir);
      if (dir === '/') return rootEntries.map((item) => ({ ...item, path: `/${item.name}` }));
      return [];
    },
    resolve: async () => ({ path: '/root', kind: 'dir' }),
    download: async () => {},
    upload: async () => ({ uploaded: 0, skipped: 0 }),
    openShell: async () => {
      shell = true;
    },
    writeShell: (data) => {
      written.push(data);
    },
    resizeShell: () => {},
    hasShell: () => shell,
    close: () => {
      shell = false;
    },
  };
  return {
    listConnections: async () => [record],
    saveConnection: async () => {},
    deleteConnection: async () => {},
    secretFlags: async () => ({ password: false, passphrase: false }),
    importConfig: async () => ({ ok: true, message: 'Imported 1' }),
    connect: async () => ({ session, cwd: '/root', trustedNewKey: false, usedFallbackPath: false }),
    downloadFolder: () => '/Users/me/Desktop',
    home: () => '/Users/me',
    chooseDownloadFolder: async () => undefined,
    classifyDrop: () => null,
    localDownloadPath: (name) => name,
    keyExists: () => true,
    setStatus: () => {},
    log: () => {},
    scrollTerminal: () => {},
    quit: () => {},
  };
}

async function flush(): Promise<void> {
  for (let count = 0; count < 6; count += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
