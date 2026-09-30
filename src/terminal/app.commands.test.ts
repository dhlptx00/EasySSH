import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConnectionRecord } from '../types';
import { EasySshApp } from './app';
import type { AppHost } from './host';
import type { InputEvent } from './input';

const record: ConnectionRecord = {
  id: '1',
  name: 'prod',
  host: '10.0.0.8',
  port: 22,
  username: 'root',
  auth: 'agent',
  jumps: [],
};

const beta: ConnectionRecord = {
  id: '2',
  name: 'beta',
  host: '10.0.0.9',
  port: 22,
  username: 'admin',
  auth: 'password',
  jumps: [],
};

function host(records: ConnectionRecord[] = [record]): AppHost {
  return {
    listConnections: async () => records,
    saveConnection: async () => {},
    deleteConnection: async () => {},
    secretFlags: async () => ({ password: false, passphrase: false }),
    importConfig: async () => ({ ok: true, message: 'Imported 1' }),
    connect: async () => {
      throw new Error('not connected');
    },
    downloadFolder: () => '/Users/me/Desktop',
    home: () => '/Users/me',
    clickHint: () => 'cmd-click a file to download',
    chooseDownloadFolder: async () => undefined,
    chooseUploadFiles: async () => [],
    classifyDrop: () => null,
    localDownloadPath: (name) => name,
    keyExists: () => true,
    setStatus: () => {},
    log: () => {},
    quit: () => {},
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function visible(chunks: string[]): string {
  return chunks.join('').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

async function run(events: InputEvent[], records?: ConnectionRecord[]): Promise<string> {
  const chunks: string[] = [];
  const app = new EasySshApp(host(records), (data) => chunks.push(data));
  app.setSize(80, 24);
  app.open();
  await settle();
  app.onInput(events);
  await settle();
  return visible(chunks);
}

describe('connection command line', () => {
  it('opens the new-connection form from /new', async () => {
    const text = await run([
      { type: 'text', text: '/' },
      { type: 'text', text: 'new' },
      { type: 'key', key: 'enter' },
    ]);
    assert.match(text, /New connection/);
  });

  it('connects from a connection command and moves through the command group', async () => {
    const connected = await run([
      { type: 'text', text: '/prod' },
      { type: 'key', key: 'enter' },
    ]);
    assert.match(connected, /Connecting to root@10\.0\.0\.8:22/);

    const created = await run([
      { type: 'text', text: '/' },
      { type: 'key', key: 'down' },
      { type: 'key', key: 'enter' },
    ]);
    assert.match(created, /New connection/);
  });

  it('opens the editor from /edit and asks before /delete', async () => {
    const listed = await run([
      { type: 'text', text: '/edit' },
      { type: 'key', key: 'enter' },
    ]);
    assert.match(listed, /Edit connection/);
    assert.match(listed, /prod/);
    assert.doesNotMatch(listed, /Edit prod/);

    const edited = await run([
      { type: 'text', text: '/edit' },
      { type: 'key', key: 'enter' },
      { type: 'key', key: 'enter' },
    ]);
    assert.match(edited, /Edit prod/);

    const pending = await run([
      { type: 'text', text: '/delete' },
      { type: 'key', key: 'enter' },
    ]);
    assert.match(pending, /Delete connection/);
    assert.doesNotMatch(pending, /Delete prod\?/);

    const deleted = await run([
      { type: 'text', text: '/delete' },
      { type: 'key', key: 'enter' },
      { type: 'key', key: 'enter' },
    ]);
    assert.match(deleted, /Delete prod\?/);
  });

  it('edits the connection chosen from the list', async () => {
    const records = [record, beta];
    const listed = await run([
      { type: 'key', key: 'down' },
      { type: 'text', text: '/edit' },
      { type: 'key', key: 'enter' },
    ], records);
    assert.match(listed, /Edit connection/);
    assert.match(listed, /prod/);
    assert.match(listed, /beta/);
    assert.doesNotMatch(listed, /Edit beta/);

    const edited = await run([
      { type: 'key', key: 'down' },
      { type: 'text', text: '/edit' },
      { type: 'key', key: 'enter' },
      { type: 'key', key: 'up' },
      { type: 'key', key: 'enter' },
    ], records);
    assert.match(edited, /Edit prod/);
    assert.doesNotMatch(edited, /Edit beta/);
  });
});
