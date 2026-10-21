import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConnectionRecord, ForwardSpec } from '../types';
import { EasySshApp } from './app';
import type { AppHost } from './host';
import { fakeRemote, flush, sleep, type FakeRemote } from './testHost';

interface Rig {
  app: EasySshApp;
  remote: FakeRemote;
  saved: ConnectionRecord[];
  forwarded: ForwardSpec[];
  picks: string[][];
}

async function rig(options: { record?: Partial<ConnectionRecord>; pick?: number[]; text?: string; busyPort?: number } = {}): Promise<Rig> {
  const remote = fakeRemote();
  Object.assign(remote.record, options.record);
  const saved: ConnectionRecord[] = [];
  const forwarded: ForwardSpec[] = [];
  const picks: string[][] = [];
  const answers = [...(options.pick ?? [])];
  remote.session.forward = async (spec) => {
    if (spec.localPort === options.busyPort) throw new Error(`Local port ${spec.localPort} is already in use`);
    forwarded.push(spec);
  };
  remote.session.unforward = (port) => {
    const at = forwarded.findIndex((spec) => spec.localPort === port);
    if (at < 0) return false;
    forwarded.splice(at, 1);
    return true;
  };
  const host: AppHost = {
    ...remote.host,
    listConnections: async () => [saved[saved.length - 1] ?? remote.record],
    saveConnection: async (record) => {
      saved.push(record);
    },
    pickItem: async (_title, _placeholder, items) => {
      picks.push(items.map((item) => item.label));
      return answers.shift();
    },
    askText: async (request) => options.text ?? request.value,
  };
  const app = new EasySshApp(host, () => {});
  app.setSize(100, 30);
  app.open();
  await flush();
  app.onInput([{ type: 'key', key: 'enter' }]);
  await flush();
  remote.push('\x1b]7;/home/hqxrd\x07$ ');
  await flush();
  return { app, remote, saved, forwarded, picks };
}

async function type(r: Rig, line: string): Promise<void> {
  for (const ch of line) r.app.onRawInput(ch);
  await sleep(40);
  r.app.onRawInput('\r');
  await sleep(40);
  await flush();
}

describe('snippets at the shell prompt', () => {
  it('/save keeps a command, clears the typed line with Ctrl+U, and never sends Enter', async () => {
    const r = await rig();
    await type(r, '/save df -h');
    assert.equal(r.remote.written.join(''), '/save df -h\x15');
    assert.deepEqual(r.saved.map((record) => record.snippets), [['df -h']]);
    assert.ok(r.remote.status.some((text) => text === 'Saved for /run: df -h'));
    r.app.dispose();
  });

  it('/save alone offers the last command in an input box first', async () => {
    const r = await rig({ text: 'uptime' });
    await type(r, 'uptime');
    await type(r, '/save');
    assert.deepEqual(r.saved.map((record) => record.snippets), [['uptime']]);
    r.app.dispose();
  });

  it('/run types the picked command with Enter, and can remove one', async () => {
    const r = await rig({ record: { snippets: ['df -h', 'tail -f /var/log/syslog'] }, pick: [1] });
    await type(r, '/run');
    assert.deepEqual(r.picks[0], ['df -h', 'tail -f /var/log/syslog', '$(trash) Remove a saved command…']);
    assert.ok(r.remote.written.join('').endsWith('/run\x15tail -f /var/log/syslog\r'));
    r.app.dispose();

    const removing = await rig({ record: { snippets: ['df -h', 'uptime'] }, pick: [2, 0] });
    await type(removing, '/run');
    assert.deepEqual(removing.saved.map((record) => record.snippets), [['uptime']]);
    removing.app.dispose();
  });

  it('leaves other lines that start with a slash to the shell', async () => {
    const r = await rig();
    await type(r, '/usr/bin/env');
    await type(r, '/runner');
    assert.equal(r.remote.written.join(''), '/usr/bin/env\r/runner\r');
    assert.deepEqual(r.saved, []);
    r.app.dispose();
  });
});

describe('port forwarding', () => {
  it('starts saved forwards at connect, shows them in the status bar, and reports a busy port', async () => {
    const r = await rig({
      record: { forwards: [{ localPort: 3000, remoteHost: 'localhost', remotePort: 3000 }, { localPort: 5432, remoteHost: 'db', remotePort: 5432 }] },
      busyPort: 5432,
    });
    assert.deepEqual(r.forwarded.map((spec) => spec.localPort), [3000]);
    assert.ok(r.remote.status.some((text) => text.endsWith('· ⇄ 3000')));
    r.app.dispose();
  });

  it('/forward adds one, /forward lists, /unforward stops it', async () => {
    const r = await rig();
    await type(r, '/forward 8080:3000');
    assert.deepEqual(r.forwarded, [{ localPort: 8080, remoteHost: 'localhost', remotePort: 3000 }]);
    assert.ok(r.remote.status.includes('Forwarding localhost:8080 → localhost:3000'));
    await type(r, '/forward');
    assert.ok(r.remote.status.includes('Forwarding 8080 → localhost:3000'));
    await type(r, '/forward 99999');
    assert.ok(r.remote.status.some((text) => /between 1 and 65535/.test(text)));
    await type(r, '/unforward 8080');
    assert.deepEqual(r.forwarded, []);
    assert.ok(r.remote.status.includes('Stopped forwarding localhost:8080'));
    assert.ok(!r.remote.written.join('').includes('\r'), 'none of these reached the shell as a command');
    r.app.dispose();
  });
});
