import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrowseEntry, ConnectionRecord } from '../types';
import { EasySshApp } from './app';
import type { AppHost, FileSession } from './host';

const record: ConnectionRecord = {
  id: '1',
  name: 'prod',
  host: '10.0.0.8',
  port: 22,
  username: 'root',
  auth: 'agent',
  jumps: [],
};

const files: BrowseEntry[] = [
  { name: 'tmp', path: '/root/tmp', kind: 'dir', size: 0, mtime: 0 },
  { name: 'notes.txt', path: '/root/notes.txt', kind: 'file', size: 4, mtime: 0 },
  { name: 'other.txt', path: '/root/other.txt', kind: 'file', size: 4, mtime: 0 },
];

describe('plain click (easySsh.plainClick)', () => {
  it('downloads a file or a whole folder, and ignores a drag', async () => {
    const written: string[] = [];
    const downloads: string[] = [];
    const scrolls: string[] = [];
    const shown: string[] = [];
    let push: ((chunk: string) => void) | undefined;
    const app = new EasySshApp(host(written, downloads, scrolls, (onData) => {
      push = onData;
    }, true), (data) => shown.push(data));
    app.setSize(80, 24);
    app.open();
    await flush();
    app.onInput([{ type: 'key', key: 'enter' }]);
    await flush();
    assert.equal(typeof push, 'function');
    push?.('\x1b]7;/root\x07');
    push?.('\x1b[H\x1b[2Jtmp notes.txt other.txt');
    assert.match(shown.join(''), /\x1b\[\?1000h/);

    click(app, 1, 1, 20, 1);
    await flush();
    assert.deepEqual(downloads, []);
    assert.deepEqual(written, []);

    app.onRawInput('\x1b[<64;1;1M');
    await flush();
    assert.deepEqual(scrolls, ['up']);
    assert.deepEqual(written, []);

    click(app, 1, 1);
    click(app, 5, 1);
    await flush();
    // A folder click downloads the folder; it never types cd.
    assert.deepEqual(written, []);
    assert.deepEqual([...downloads].sort(), ['/root/notes.txt', '/root/tmp/']);

    push?.('\x1b[?1049h');
    click(app, 15, 1);
    await flush();
    assert.deepEqual([...downloads].sort(), ['/root/notes.txt', '/root/tmp/']);
    assert.match(written.join(''), /\x1b\[</);

    push?.('\x1b[?1000l\x1b[?1049l');
    const output = shown.join('');
    const left = output.lastIndexOf('\x1b[?1049l');
    const enabled = output.lastIndexOf('\x1b[?1000h');
    assert.ok(left >= 0 && enabled > left);

    click(app, 15, 1);
    await flush();
    assert.deepEqual([...downloads].sort(), ['/root/notes.txt', '/root/other.txt', '/root/tmp/']);
  });
});

function click(app: EasySshApp, col: number, row: number, upCol = col, upRow = row): void {
  app.onRawInput(`\x1b[<0;${col};${row}M\x1b[<0;${upCol};${upRow}m`);
}

describe('Ctrl+click links (default)', () => {
  it('never turns on mouse reporting, so the terminal selects text normally', async () => {
    const written: string[] = [];
    const downloads: string[] = [];
    const shown: string[] = [];
    let push: ((chunk: string) => void) | undefined;
    const app = new EasySshApp(host(written, downloads, [], (onData) => {
      push = onData;
    }), (data) => shown.push(data));
    app.setSize(80, 24);
    app.open();
    await flush();
    app.onInput([{ type: 'key', key: 'enter' }]);
    await flush();
    push?.('\x1b]7;/root\x07');
    push?.('tmp notes.txt other.txt\r\n');
    const output = shown.join('');
    assert.doesNotMatch(output, /\x1b\[\?100[0-3]h/);
    assert.match(output.replace(/\x1b\[[0-9;]*m/g, ''), /Ctrl\+click a file or folder name to download it/);

    // Names still open through the terminal link provider.
    const links = app.linkFor('tmp notes.txt other.txt');
    assert.deepEqual(links.map((link) => link.remotePath), ['/root/notes.txt', '/root/other.txt', '/root/tmp']);
    assert.match(links[0].tooltip, /to ~\/Desktop$/);
    assert.match(links[2].tooltip, /^Download folder tmp to ~\/Desktop$/);
    app.activatePath('/root/notes.txt');
    await flush();
    assert.deepEqual(downloads, ['/root/notes.txt']);
    app.activatePath('/root/tmp');
    await flush();
    assert.deepEqual(downloads, ['/root/notes.txt', '/root/tmp/']);
    assert.deepEqual(written, []);
  });

  it('gives mouse reports to the remote program that asked for them', async () => {
    const written: string[] = [];
    const downloads: string[] = [];
    let push: ((chunk: string) => void) | undefined;
    const app = new EasySshApp(host(written, downloads, [], (onData) => {
      push = onData;
    }), () => {});
    app.setSize(80, 24);
    app.open();
    await flush();
    app.onInput([{ type: 'key', key: 'enter' }]);
    await flush();
    push?.('\x1b]7;/root\x07notes.txt\r\n\x1b[?1000h');
    click(app, 1, 1);
    await flush();
    assert.deepEqual(downloads, []);
    assert.equal(written.join(''), '\x1b[<0;1;1M\x1b[<0;1;1m');
  });

  it('switches mouse reporting off when a program leaves it on at the prompt', async () => {
    const shown: string[] = [];
    let push: ((chunk: string) => void) | undefined;
    const app = new EasySshApp(host([], [], [], (onData) => {
      push = onData;
    }), (data) => shown.push(data));
    app.setSize(80, 24);
    app.open();
    await flush();
    app.onInput([{ type: 'key', key: 'enter' }]);
    await flush();
    push?.('\x1b]7;/root\x07');
    shown.length = 0;
    // A full-screen program with mouse support exits without switching it off.
    push?.('\x1b[?1049h\x1b[?1002h\x1b[?1006hvim\x1b[?1049l');
    assert.match(shown.join(''), /\x1b\[\?1002l/);
    shown.length = 0;
    // A program on the main screen does the same; the next prompt clears it.
    push?.('\x1b[?1000hprogram output\r\n\x1b]7;/root\x07$ ');
    assert.match(shown.join(''), /\x1b\[\?1000l/);
    shown.length = 0;
    push?.('\x1b]7;/root\x07$ ');
    assert.doesNotMatch(shown.join(''), /\x1b\[\?1000l/);
  });
});

function host(
  written: string[],
  downloads: string[],
  scrolls: string[],
  capture: (onData: (chunk: string) => void) => void,
  plainClick = false,
): AppHost {
  let shell = false;
  const session: FileSession = {
    list: async () => files,
    resolve: async () => ({ path: '/root', kind: 'dir' }),
    download: async (remotePath, folder, name) => {
      downloads.push(remotePath);
      return { localPath: `${folder}/${name}`, bytes: 4, grew: false };
    },
    downloadFolder: async (remotePath, folder, name) => {
      downloads.push(`${remotePath}/`);
      return { localPath: `${folder}/${name}`, files: 1, folders: 1, bytes: 4, skipped: [] };
    },
    upload: async () => ({ uploaded: 0, skipped: 0, kept: 0, renamed: [] }),
    openShell: async (_columns, _rows, onData) => {
      shell = true;
      capture(onData);
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
    connect: async () => ({ session, cwd: '/root', usedFallbackPath: false }),
    downloadFolder: () => '/Users/me/Desktop',
    home: () => '/Users/me',
    chooseDownloadFolder: async () => undefined,
    classifyDrop: () => null,
    keyExists: () => true,
    setStatus: () => {},
    log: () => {},
    scrollTerminal: (direction) => {
      scrolls.push(direction);
    },
    quit: () => {},
    plainClick: () => plainClick,
    downloadLabel: () => '~/Desktop',
  };
}

async function flush(): Promise<void> {
  for (let count = 0; count < 8; count += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
