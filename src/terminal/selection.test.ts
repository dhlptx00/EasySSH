import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Terminal } from '@xterm/headless';
import { EasySshApp } from './app';
import { fakeRemote, flush } from './testHost';

/**
 * xterm.js (the VS Code terminal) selects text with a plain drag only while no
 * mouse tracking mode is active. With tracking on, drags go to the program and
 * selection needs Shift (Option on macOS). These tests run the bytes Easy SSH
 * writes through a real xterm parser and check that mode.
 */
function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

async function session(plainClick: boolean) {
  const term = new Terminal({ cols: 100, rows: 30, allowProposedApi: true });
  const remote = fakeRemote({ plainClick });
  const out: string[] = [];
  const app = new EasySshApp(remote.host, (data) => out.push(data));
  app.setSize(100, 30);
  app.open();
  await flush();
  app.onInput([{ type: 'key', key: 'enter' }]);
  await flush();
  const shell = async (bytes: string) => {
    remote.push(bytes);
    await flush();
    await write(term, out.splice(0).join(''));
  };
  await shell('\x1b]7;/root\x07[root@server ~]# ');
  return { term, app, shell };
}

describe('text selection in the remote shell', () => {
  it('leaves mouse tracking off by default, so a plain drag selects', async () => {
    const { term, app, shell } = await session(false);
    assert.equal(term.modes.mouseTrackingMode, 'none');
    await shell('git log --oneline\r\n0a1b2c3 fix upload\r\n\x1b]7;/root/repo\x07[root@server repo]# ');
    assert.equal(term.modes.mouseTrackingMode, 'none');
    app.dispose();
  });

  it('does not stay in mouse mode after a program forgets to switch it off', async () => {
    const { term, app, shell } = await session(false);
    await shell('\x1b[?1049h\x1b[?1002h\x1b[?1006h');
    assert.equal(term.modes.mouseTrackingMode, 'drag');
    await shell('\x1b[?1049l');
    assert.equal(term.modes.mouseTrackingMode, 'none');
    await shell('\x1b[?1000hstill on\r\n\x1b]7;/root\x07# ');
    assert.equal(term.modes.mouseTrackingMode, 'none');
    app.dispose();
  });

  it('keeps a full-screen program\'s mouse mode while it runs, then clears it', async () => {
    const { term, app, shell } = await session(false);
    await shell('\x1b[?1049h\x1b[?1003h\x1b[?1006h');
    await shell('\x1b[5;5Hediting');
    assert.equal(term.modes.mouseTrackingMode, 'any');
    await shell('\x1b[?1049l\x1b]7;/root\x07[root@server ~]# ');
    assert.equal(term.modes.mouseTrackingMode, 'none');
    app.dispose();
  });

  it('clears X10 mouse mode left on at the prompt', async () => {
    const { term, app, shell } = await session(false);
    await shell('\x1b[?9h');
    assert.equal(term.modes.mouseTrackingMode, 'x10');
    await shell('\r\n\x1b]7;/root\x07[root@server ~]# ');
    assert.equal(term.modes.mouseTrackingMode, 'none');
    app.dispose();
  });

  it('turns tracking on only when easySsh.plainClick asks for plain clicks', async () => {
    const { term, app } = await session(true);
    assert.equal(term.modes.mouseTrackingMode, 'vt200');
    app.dispose();
  });
});
