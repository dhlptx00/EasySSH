import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConnectUi } from '../ssh/session';
import { BASH_HOOK } from '../ssh/shellFeed';
import { EasySshApp } from './app';
import type { AppHost, ConnectResult, ProgressHandle } from './host';
import { fakeRemote, flush, sleep, type FakeRemote } from './testHost';

function plain(chunks: string[]): string {
  return chunks.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

async function start(host: AppHost, shown: string[] = []): Promise<EasySshApp> {
  const app = new EasySshApp(host, (data) => shown.push(data));
  app.setSize(100, 30);
  app.open();
  await flush();
  app.onInput([{ type: 'key', key: 'enter' }]);
  await flush();
  return app;
}

/** Connected, with the prompt hook already reporting the folder. */
async function connected(remote: FakeRemote, cwd = '/home/hqxrd', shown: string[] = []): Promise<EasySshApp> {
  const app = await start(remote.host, shown);
  remote.push(`\x1b]7;${cwd}\x07$ `);
  await flush();
  return app;
}

describe('login output and the setup hook (B11, B12)', () => {
  it('shows the MOTD, sends the hook after the prompt, hides its echo, and holds typed keys until then', async () => {
    const remote = fakeRemote();
    const shown: string[] = [];
    const app = await start(remote.host, shown);
    remote.push('Welcome to Ubuntu 24.04\r\nLast login: Mon from 10.0.0.1\r\n');
    remote.push('hqxrd@web:~$ ');
    app.onRawInput('l');
    app.onRawInput('s');
    await flush();
    assert.deepEqual(remote.written, [], 'nothing is typed before the hook');
    await sleep(80);
    assert.equal(remote.written.length, 1);
    assert.equal(remote.written[0], `${BASH_HOOK}\n`);
    remote.push(`${BASH_HOOK}\r\n\x1b]7;/home/hqxrd\x07hqxrd@web:~$ `);
    await flush();
    assert.deepEqual(remote.written.slice(1), ['ls']);
    const text = plain(shown);
    assert.match(text, /Welcome to Ubuntu 24\.04/);
    assert.match(text, /Last login/);
    assert.ok(!text.includes('PROMPT_COMMAND'), 'the hook echo stays hidden');
    app.dispose();
  });

  it('restores the start folder with the hook and names the tab (U8)', async () => {
    const remote = fakeRemote();
    const titles: (string | undefined)[] = [];
    remote.record.startPath = '/srv/app';
    const app = await start({ ...remote.host, setTitle: (title) => titles.push(title), connect: async () => ({ session: remote.session, cwd: '/srv/app', usedFallbackPath: false, shell: 'bash' }) });
    remote.push('$ ');
    await sleep(80);
    assert.match(remote.written[0], /; cd -- '\/srv\/app' 2>\/dev\/null\n$/);
    assert.deepEqual(titles, ['server']);
    app.dispose();
    assert.deepEqual(titles, ['server']);
  });
});

describe('pasting and dropping paths (B1, S4)', () => {
  it('types a pasted path that is also on the clipboard instead of uploading it (B1 regression)', async () => {
    const remote = fakeRemote({ clipboard: 'C:/Users/me/a.txt' });
    const app = await connected(remote);
    app.onRawInput('C:/Users/me/a.txt');
    await sleep(60);
    await flush();
    assert.deepEqual(remote.uploads, []);
    assert.ok(remote.written.join('').includes('C:/Users/me/a.txt'));
    app.dispose();
  });

  it('never uploads a path pasted into a full-screen program (B1 regression)', async () => {
    const remote = fakeRemote();
    const app = await connected(remote);
    remote.push('\x1b[?1049h');
    await flush();
    app.onRawInput('C:/Users/me/a.txt');
    await sleep(60);
    await flush();
    assert.deepEqual(remote.uploads, []);
    assert.ok(remote.written.join('').includes('C:/Users/me/a.txt'));
    app.dispose();
  });

  it('asks before uploading a dropped file from outside the home folder (S4)', async () => {
    const pasted = fakeRemote({ localUpload: 'paste' });
    const app = await connected(pasted);
    app.onRawInput('D:/secrets/key.pem');
    await sleep(60);
    await flush();
    assert.deepEqual(pasted.uploads, []);
    assert.ok(pasted.written.join('').includes('D:/secrets/key.pem'));
    app.dispose();

    const uploaded = fakeRemote({ localUpload: 'upload' });
    const second = await connected(uploaded);
    second.onRawInput('D:/data/report.csv');
    await sleep(60);
    await flush();
    assert.deepEqual(uploaded.uploads, [{ paths: ['D:/data/report.csv'], dir: '/home/hqxrd' }]);
    second.dispose();
  });
});

describe('transfers', () => {
  it('queues downloads, shows progress with Cancel, and Ctrl+C goes to the shell (U1, U5, B9)', async () => {
    const releases: (() => void)[] = [];
    const remote = fakeRemote({
      files: [
        { name: 'big.iso', path: '/home/hqxrd/big.iso', kind: 'file', size: 50_000_000, mtime: 0 },
        { name: 'logs', path: '/home/hqxrd/logs', kind: 'dir', size: 0, mtime: 0 },
      ],
      download: (_path, _kind, signal, progress) => new Promise<void>((resolve, reject) => {
        progress({ phase: 'copy', bytes: 10_000_000, totalBytes: 50_000_000, files: 0, totalFiles: 1 });
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        releases.push(resolve);
      }),
    });
    const reports: string[] = [];
    let cancel: (() => void) | undefined;
    const host: AppHost = {
      ...remote.host,
      showProgress: (title: string, onCancel: () => void): ProgressHandle => {
        cancel = onCancel;
        return { report: (text) => reports.push(`${title}: ${text}`), close: () => {} };
      },
    };
    const app = await start(host);
    remote.push('\x1b]7;/home/hqxrd\x07$ ');
    await flush();
    app.activatePath('/home/hqxrd/big.iso');
    await flush();
    app.activatePath('/home/hqxrd/logs');
    await flush();
    assert.deepEqual(remote.downloads.map((item) => [item.remotePath, item.kind]), [['/home/hqxrd/big.iso', 'file']]);
    assert.ok(app.hasTransfers());
    assert.ok(reports.some((line) => line.startsWith('Easy SSH: big.iso') && /\+1 queued/.test(line)), reports.join('\n'));

    app.onRawInput('\x03');
    await flush();
    assert.ok(remote.written.includes('\x03'), 'Ctrl+C reaches the remote shell');
    assert.equal(releases.length, 1, 'the transfer keeps running');

    releases[0]();
    await flush();
    assert.deepEqual(remote.downloads.map((item) => [item.remotePath, item.kind, item.name]), [
      ['/home/hqxrd/big.iso', 'file', 'big.iso'],
      ['/home/hqxrd/logs', 'folder', 'logs'],
    ]);
    cancel?.();
    await flush();
    assert.equal(app.hasTransfers(), false);
    assert.ok(remote.status.some((line) => /Cancelled logs\//.test(line)), remote.status.join('\n'));
    app.dispose();
  });

  it('reports what a folder download skipped', async () => {
    const remote = fakeRemote({ files: [{ name: 'site', path: '/home/hqxrd/site', kind: 'dir', size: 0, mtime: 0 }] });
    remote.session.downloadFolder = async (_remote, folder, name) => ({
      localPath: `${folder}/${name}`,
      files: 3,
      folders: 2,
      bytes: 10,
      skipped: [{ path: 'current', reason: 'symlink' }, { path: 'cache', reason: 'symlink' }],
    });
    const app = await connected(remote);
    app.activatePath('/home/hqxrd/site');
    await sleep(20);
    const all = [...remote.status, ...remote.notes.map((note) => note.text)].join('\n');
    assert.match(all, /3 files/);
    assert.match(all, /skipped 2 \(symlink\)/);
    app.dispose();
  });
});

describe('connecting', () => {
  it('asks for the password in the terminal, masked, with a save toggle (S3)', async () => {
    const remote = fakeRemote();
    let answer: unknown;
    const shown: string[] = [];
    const host: AppHost = {
      ...remote.host,
      connect: async (_record, { ui }: { ui: ConnectUi }): Promise<ConnectResult> => {
        answer = await ui.ask({ title: 'Password', label: 'password for dev@web01', masked: true, save: true, hint: 'Tab: save or not' });
        return { session: remote.session, cwd: '/home/hqxrd', usedFallbackPath: false, shell: 'bash' };
      },
    };
    const app = await start(host, shown);
    app.onInput([{ type: 'text', text: 'hunter2' }, { type: 'key', key: 'tab' }]);
    await flush();
    const screen = plain(shown);
    assert.match(screen, /password for dev@web01/);
    assert.match(screen, /•••••••/);
    assert.ok(!screen.includes('hunter2'));
    app.onInput([{ type: 'key', key: 'enter' }]);
    await flush();
    assert.deepEqual(answer, { value: 'hunter2', save: false });
    app.dispose();
  });

  it('shows the fingerprint of a new server and connects only when trusted (S1)', async () => {
    for (const [key, expected] of [['y', true], ['n', false]] as const) {
      const remote = fakeRemote();
      let trusted: boolean | undefined;
      const shown: string[] = [];
      const host: AppHost = {
        ...remote.host,
        connect: async (_record, { ui }) => {
          trusted = await ui.trustHostKey({ kind: 'unknown', hostLabel: '10.0.0.8:22', fingerprint: 'ab'.repeat(32) });
          if (!trusted) throw new Error('declined');
          return { session: remote.session, cwd: '/home/hqxrd', usedFallbackPath: false };
        },
      };
      const app = await start(host, shown);
      assert.match(plain(shown), /New server: check its host key/);
      assert.match(plain(shown), /SHA256:/);
      app.onInput([{ type: 'text', text: key }]);
      await flush();
      assert.equal(trusted, expected);
      app.dispose();
    }
  });

  it('cancels a connect with Ctrl+C, even while a prompt waits', async () => {
    const remote = fakeRemote();
    const shown: string[] = [];
    let aborted = false;
    const host: AppHost = {
      ...remote.host,
      connect: async (_record, { signal, ui }) => {
        signal.addEventListener('abort', () => (aborted = true));
        await ui.ask({ title: 'Password', label: 'password', masked: true });
        throw new Error('stopped');
      },
    };
    const app = await start(host, shown);
    app.onInput([{ type: 'key', key: 'ctrl-c' }]);
    await flush();
    assert.equal(aborted, true);
    assert.match(plain(shown), /Cancelled/);
    app.dispose();
  });

  it('opens the shell when the first listing fails (B7) and works without SFTP (B8)', async () => {
    const remote = fakeRemote({ list: async () => {
      throw Object.assign(new Error('Permission denied'), { code: 3 });
    } });
    const app = await connected(remote);
    assert.ok(remote.session.hasShell());
    assert.ok(remote.logs.some((line) => /Could not list/.test(line)));
    app.dispose();

    const noSftp = fakeRemote({ files: [{ name: 'a.txt', path: '/home/hqxrd/a.txt', kind: 'file', size: 1, mtime: 0 }] });
    noSftp.session.hasFiles = () => false;
    const shown: string[] = [];
    const second = await connected(noSftp, '/home/hqxrd', shown);
    assert.ok(noSftp.session.hasShell());
    assert.ok(noSftp.status.some((line) => /terminal only/.test(line)));
    assert.deepEqual(second.linkFor('a.txt'), []);
    second.dispose();
  });
});

describe('connection lost (U3)', () => {
  it('says why and reconnects into the same folder', async () => {
    const remote = fakeRemote();
    let connects = 0;
    const host: AppHost = {
      ...remote.host,
      connect: async () => {
        connects += 1;
        return { session: remote.session, cwd: '/home/hqxrd', usedFallbackPath: false, shell: 'bash' };
      },
    };
    const shown: string[] = [];
    const app = await start(host, shown);
    remote.push('\x1b]7;/srv/www\x07$ ');
    await flush();
    app.onRemoteClose('Connection reset by the network');
    await flush();
    const screen = plain(shown);
    assert.match(screen, /Connection to server lost/);
    assert.match(screen, /Connection reset by the network/);
    assert.ok(remote.status.includes('server: connection lost'));
    remote.written.length = 0;
    app.onInput([{ type: 'text', text: 'r' }]);
    await flush();
    assert.equal(connects, 2);
    remote.push('$ ');
    await sleep(80);
    assert.match(remote.written[0] ?? '', /; cd -- '\/srv\/www' 2>\/dev\/null\n$/);
    app.dispose();
  });

  it('reconnects by itself with easySsh.autoReconnect', async () => {
    const remote = fakeRemote();
    let connects = 0;
    const host: AppHost = {
      ...remote.host,
      autoReconnect: () => true,
      connect: async () => {
        connects += 1;
        return { session: remote.session, cwd: '/home/hqxrd', usedFallbackPath: false, shell: 'bash' };
      },
    };
    const shown: string[] = [];
    const app = await start(host, shown);
    remote.push('\x1b]7;/home/hqxrd\x07$ ');
    await flush();
    app.onRemoteClose('keepalive timeout');
    await flush();
    assert.match(plain(shown), /Reconnecting in 2/);
    await sleep(2300);
    await flush();
    assert.equal(connects, 2);
    app.dispose();
  });
});
