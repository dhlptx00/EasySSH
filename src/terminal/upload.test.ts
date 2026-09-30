import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TransferError } from '../ssh/errors';
import { EasySshApp } from './app';
import { fakeRemote, flush, sleep, type FakeRemote } from './testHost';

async function connected(remote: FakeRemote, cwd: string): Promise<EasySshApp> {
  const app = new EasySshApp(remote.host, () => {});
  app.setSize(100, 30);
  app.open();
  await flush();
  app.onInput([{ type: 'key', key: 'enter' }]);
  await flush();
  remote.push(`\x1b]7;${cwd}\x07$ `);
  await flush();
  return app;
}

/** Type a command the way VS Code sends keys: one character at a time, then Enter. */
async function type(app: EasySshApp, line: string): Promise<void> {
  for (const ch of line) app.onRawInput(ch);
  app.onRawInput('\r');
  await flush();
}

/** VS Code sends a dropped file's path as text to the terminal it was dropped on. */
async function drop(app: EasySshApp, path: string, wait = 1700): Promise<void> {
  app.onRawInput(path);
  await sleep(wait);
  await flush();
}

describe('upload target', () => {
  it('uploads a drop through the terminal it landed on, in split view', async () => {
    const left = fakeRemote({ name: 'left' });
    const right = fakeRemote({ name: 'right' });
    const leftApp = await connected(left, '/tmp');
    const rightApp = await connected(right, '/home/hqxrd');
    await drop(leftApp, 'C:/Users/me/Desktop/捕获.PNG', 50);
    assert.deepEqual(left.uploads, [{ paths: ['C:/Users/me/Desktop/捕获.PNG'], dir: '/tmp' }]);
    assert.deepEqual(right.uploads, []);
    assert.deepEqual(left.questions, []);
    assert.equal(left.status.at(-1), 'Uploaded 1 to /tmp');
    await drop(rightApp, 'C:/Users/me/Desktop/b.txt', 50);
    assert.deepEqual(right.uploads, [{ paths: ['C:/Users/me/Desktop/b.txt'], dir: '/home/hqxrd' }]);
    assert.equal(left.uploads.length, 1);
    leftApp.dispose();
    rightApp.dispose();
  });

  it('uses the new folder after cd when the prompt hook reports it', async () => {
    const remote = fakeRemote();
    const app = await connected(remote, '/home/hqxrd');
    await type(app, 'cd /tmp');
    remote.push('\x1b]7;/tmp\x07$ ');
    await drop(app, 'C:/Users/me/a.txt', 50);
    assert.deepEqual(remote.uploads.map((item) => item.dir), ['/tmp']);
    assert.deepEqual(remote.questions, []);
    app.dispose();
  });

  it('asks instead of uploading to the old folder after sudo su', async () => {
    const remote = fakeRemote({ answer: () => undefined });
    const app = await connected(remote, '/home/hqxrd');
    await type(app, 'sudo su');
    remote.push('[root@server hqxrd]# ');
    await type(app, 'cd /tmp');
    remote.push('[root@server tmp]# ');
    await drop(app, 'C:/Users/me/Desktop/捕获.PNG');
    assert.deepEqual(remote.uploads, []);
    assert.equal(remote.questions.length, 1);
    const question = remote.questions[0];
    assert.match(question.message, /捕获\.PNG/);
    assert.match(question.detail, /after "sudo su"/);
    assert.match(question.detail, /as hqxrd, not as the switched user/);
    assert.equal(question.cwd, '/home/hqxrd');
    assert.equal(remote.status.at(-1), 'Upload cancelled');
    app.dispose();
  });

  it('uploads where the user chose and says so, as the login user', async () => {
    const remote = fakeRemote({ answer: () => '/tmp' });
    const app = await connected(remote, '/home/hqxrd');
    await type(app, 'sudo -i');
    await drop(app, 'C:/Users/me/Desktop/app.jar');
    assert.deepEqual(remote.uploads, [{ paths: ['C:/Users/me/Desktop/app.jar'], dir: '/tmp' }]);
    assert.equal(remote.status.at(-1), 'Uploaded 1 to /tmp as hqxrd');
    assert.match(remote.notes.at(-1)?.text ?? '', /sudo mv '\/tmp\/app\.jar' <folder>/);
    // Back in the login shell, the hook reports again and uploads need no question.
    await type(app, 'exit');
    remote.push('\x1b]7;/home/hqxrd\x07$ ');
    await drop(app, 'C:/Users/me/Desktop/b.txt', 50);
    assert.equal(remote.questions.length, 1);
    assert.equal(remote.uploads.at(-1)?.dir, '/home/hqxrd');
    app.dispose();
  });

  it('asks when the prompt never came back, e.g. another program or shell', async () => {
    const remote = fakeRemote({ answer: (question) => question.cwd });
    const app = await connected(remote, '/srv/app');
    await type(app, 'bash');
    await drop(app, 'C:/Users/me/a.txt');
    assert.equal(remote.questions.length, 1);
    assert.match(remote.questions[0].detail, /has not reported its folder after "bash"/);
    assert.equal(remote.uploads.at(-1)?.dir, '/srv/app');
    app.dispose();
  });

  it('names the operation, the path, and the SFTP user when the server refuses', async () => {
    const denied = Object.assign(new Error('Permission denied'), { code: 3 });
    const remote = fakeRemote({
      upload: async () => {
        throw new TransferError('Cannot write', '/srv/app/runtime/app.jar', 'remote', denied);
      },
    });
    const app = await connected(remote, '/srv/app/runtime');
    await drop(app, 'C:/Users/me/app.jar', 50);
    const expected = 'Cannot write /srv/app/runtime/app.jar: Permission denied (SFTP user hqxrd)';
    assert.equal(remote.status.at(-1), expected);
    assert.ok(remote.logs.some((line) => line.includes(expected)));
    assert.deepEqual(remote.notes.at(-1), { tone: 'error', text: `Upload failed. ${expected}` });
    app.dispose();
  });

  it('keeps the success message when the folder cannot be listed afterwards', async () => {
    let calls = 0;
    const remote = fakeRemote({
      list: async () => {
        calls += 1;
        if (calls > 1) throw Object.assign(new Error('Permission denied'), { code: 3 });
        return [];
      },
    });
    const app = await connected(remote, '/srv/dropbox');
    await drop(app, 'C:/Users/me/a.txt', 50);
    assert.equal(remote.status.at(-1), 'Uploaded 1 to /srv/dropbox');
    assert.ok(remote.logs.some((line) => /Could not list \/srv\/dropbox after the upload: Permission denied/.test(line)));
    app.dispose();
  });
});
