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

describe('plain click', () => {
  it('downloads a file, cds a directory, and ignores a drag', async () => {
    const written: string[] = [];
    const downloads: string[] = [];
    const scrolls: string[] = [];
    const shown: string[] = [];
    let push: ((chunk: string) => void) | undefined;
    const app = new EasySshApp(host(written, downloads, scrolls, (onData) => {
      push = onData;
    }), (data) => shown.push(data));
    app.setSize(80, 24);
    app.open();
    await flush();
    app.onInput([{ type: 'key', key: 'enter' }]);
    await flush();
    assert.equal(typeof push, 'function');
    push?.('\x1b]7;file://host/root\x07');
    push?.('\x1b[H\x1b[2Jtmp notes.txt other.txt');

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
    assert.deepEqual(written, ["cd '/root/tmp'\n"]);
    assert.deepEqual(downloads, ['/root/notes.txt']);

    push?.('\x1b[?1049h');
    click(app, 15, 1);
    await flush();
    assert.deepEqual(downloads, ['/root/notes.txt']);
    assert.match(written.join(''), /\x1b\[</);

    push?.('\x1b[?1000l\x1b[?1049l');
    const output = shown.join('');
    const left = output.lastIndexOf('\x1b[?1049l');
    const enabled = output.lastIndexOf('\x1b[?1000h');
    assert.ok(left >= 0 && enabled > left);

    click(app, 15, 1);
    await flush();
    assert.deepEqual(downloads, ['/root/notes.txt', '/root/other.txt']);
  });
});

function click(app: EasySshApp, col: number, row: number, upCol = col, upRow = row): void {
  app.onRawInput(`\x1b[<0;${col};${row}M\x1b[<0;${upCol};${upRow}m`);
}

function host(
  written: string[],
  downloads: string[],
  scrolls: string[],
  capture: (onData: (chunk: string) => void) => void,
): AppHost {
  let shell = false;
  const session: FileSession = {
    list: async () => files,
    resolve: async () => ({ path: '/root', kind: 'dir' }),
    download: async (remotePath) => {
      downloads.push(remotePath);
    },
    upload: async () => ({ uploaded: 0, skipped: 0 }),
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
    connect: async () => ({ session, cwd: '/root', trustedNewKey: false, usedFallbackPath: false }),
    downloadFolder: () => '/Users/me/Desktop',
    home: () => '/Users/me',
    chooseDownloadFolder: async () => undefined,
    classifyDrop: () => null,
    localDownloadPath: (name) => name,
    keyExists: () => true,
    setStatus: () => {},
    log: () => {},
    scrollTerminal: (direction) => {
      scrolls.push(direction);
    },
    quit: () => {},
  };
}

async function flush(): Promise<void> {
  for (let count = 0; count < 8; count += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
