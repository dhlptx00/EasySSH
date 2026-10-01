import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrowseEntry } from '../types';
import { EasySshApp } from './app';
import { entriesOf, fakeRemote, flush, sleep, type FakeRemote } from './testHost';

/** The server from the report: hqxrd logs in, then `sudo su` and works in /www/ap. */
function server(): Record<string, BrowseEntry[] | 'denied'> {
  return {
    '/': entriesOf('/', ['bin/', 'etc/', 'home/', 'root/', 'tmp/', 'www/']),
    '/home': entriesOf('/home', ['hqxrd/']),
    '/home/hqxrd': entriesOf('/home/hqxrd', ['rocky10.1/', 'notes.txt']),
    '/home/hqxrd/rocky10.1': entriesOf('/home/hqxrd/rocky10.1', ['redis/']),
    '/home/hqxrd/rocky10.1/redis': entriesOf('/home/hqxrd/rocky10.1/redis', ['redis.conf', 'data/']),
    '/www': entriesOf('/www', ['ap/', 'phpl/', 'xy/']),
    '/www/phpl': entriesOf('/www/phpl', ['index.php']),
    '/www/ap': entriesOf('/www/ap', ['app/', 'bin/', 'config/', 'composer.json', 'composer.lock', 'README.md', 'CHANGELOG.md']),
    '/root': 'denied',
  };
}

const LISTING = 'app  bin  composer.json  composer.lock  config  README.md  CHANGELOG.md';

async function connected(remote: FakeRemote, cwd: string): Promise<EasySshApp> {
  const app = new EasySshApp(remote.host, () => {});
  app.setSize(120, 30);
  app.open();
  await flush();
  app.onInput([{ type: 'key', key: 'enter' }]);
  await flush();
  remote.push(`\x1b]7;${cwd}\x07[hqxrd@web ${cwd.split('/').pop()}]$ `);
  await flush();
  return app;
}

/** Type a command the way VS Code sends keys, then let the (silent) root shell print its prompt. */
async function type(app: EasySshApp, remote: FakeRemote, line: string, prompt = '[root@web]# '): Promise<void> {
  for (const ch of line) app.onRawInput(ch);
  app.onRawInput('\r');
  await flush();
  remote.push(`\r\n${prompt}`);
  await flush();
}

/** The prompt hook answers within milliseconds; a root shell never does. Wait past the grace period. */
async function settle(): Promise<void> {
  await sleep(1650);
  await flush();
}

function linkNames(app: EasySshApp, line: string): string[] {
  return app.linkFor(line).map((link) => line.slice(link.start, link.start + link.length));
}

describe('two Easy SSH terminals on one server after sudo su (split view)', () => {
  it('links the listing in both panes, whichever folder each pane ran sudo su from', async () => {
    const leftRemote = fakeRemote({ name: 'Var', tree: server() });
    const rightRemote = fakeRemote({ name: 'Var', tree: server() });
    // Left pane ("Easy SSH"): hqxrd is already in /www/ap when it runs sudo su.
    const left = await connected(leftRemote, '/www/ap');
    // Right pane ("Easy SSH 2"): hqxrd is in ~/rocky10.1/redis when it runs sudo su.
    const right = await connected(rightRemote, '/home/hqxrd/rocky10.1/redis');

    await type(left, leftRemote, 'sudo su', '[sudo] password for hqxrd: ');
    await type(left, leftRemote, 'secret');
    await type(left, leftRemote, 'cd /www');
    await type(left, leftRemote, 'cd ap');

    await type(right, rightRemote, 'sudo su', '[sudo] password for hqxrd: ');
    await type(right, rightRemote, 'secret');
    await type(right, rightRemote, 'cd /');
    await type(right, rightRemote, 'cd~');
    await type(right, rightRemote, 'cd /wwww');
    await type(right, rightRemote, 'cd /www');
    await type(right, rightRemote, 'cd phpl/');
    await type(right, rightRemote, 'cd ..');
    await type(right, rightRemote, 'cd ap');
    await settle();

    const expected = ['composer.json', 'composer.lock', 'CHANGELOG.md', 'README.md', 'config', 'app', 'bin'].sort();
    assert.deepEqual(linkNames(left, LISTING).sort(), expected, 'left pane');
    assert.deepEqual(linkNames(right, LISTING).sort(), expected, 'right pane');
    const config = right.linkFor(LISTING).find((link) => LISTING.slice(link.start, link.start + link.length) === 'composer.json');
    assert.equal(config?.remotePath, '/www/ap/composer.json');
    assert.equal(rightRemote.status.at(-1), 'Var:/www/ap');
    left.dispose();
    right.dispose();
  });

  it('drops links instead of using the wrong folder when a line cannot be followed, per pane', async () => {
    const leftRemote = fakeRemote({ name: 'Var', tree: server() });
    const rightRemote = fakeRemote({ name: 'Var', tree: server() });
    const left = await connected(leftRemote, '/www/ap');
    const right = await connected(rightRemote, '/www/ap');
    await type(left, leftRemote, 'sudo su');
    await type(right, rightRemote, 'sudo su');
    // Up arrow recalls a history line Easy SSH cannot see.
    left.onRawInput('\x1b[A');
    await type(left, leftRemote, '');
    await settle();
    assert.deepEqual(left.linkFor(LISTING), [], 'left pane no longer knows its folder');
    assert.equal(leftRemote.status.at(-1), 'Var: folder unknown');
    assert.equal(linkNames(right, LISTING).length, 7, 'right pane is unaffected');
    await type(left, leftRemote, 'cd /www/ap');
    await settle();
    assert.equal(linkNames(left, LISTING).length, 7, 'an absolute cd finds the folder again');
    left.dispose();
    right.dispose();
  });

  it('follows a Ctrl+click on a folder in the root shell, and the hook again after exit', async () => {
    const remote = fakeRemote({ name: 'Var', tree: server() });
    const app = await connected(remote, '/home/hqxrd/rocky10.1/redis');
    await type(app, remote, 'sudo su');
    await type(app, remote, 'cd /www');
    await settle();
    const line = 'ap  phpl  xy';
    const ap = app.linkFor(line).find((link) => link.remotePath === '/www/ap');
    assert.ok(ap, 'the /www listing is linked in the root shell');
    app.activatePath('/www/ap');
    await flush();
    assert.equal(remote.written.at(-1), "cd '/www/ap'\n");
    remote.push('\r\n[root@web ap]# ');
    await settle();
    assert.equal(linkNames(app, LISTING).length, 7);
    await type(app, remote, 'exit', '');
    remote.push('\x1b]7;/home/hqxrd/rocky10.1/redis\x07[hqxrd@web redis]$ ');
    await flush();
    assert.deepEqual(linkNames(app, 'redis.conf  data'), ['redis.conf', 'data']);
    assert.deepEqual(app.linkFor(LISTING), []);
    app.dispose();
  });

  it('does not touch the folder while the prompt hook answers', async () => {
    const remote = fakeRemote({ name: 'Var', tree: server() });
    const app = await connected(remote, '/www');
    for (const ch of 'cd ap') app.onRawInput(ch);
    app.onRawInput('\r');
    await flush();
    remote.push('\x1b]7;/www/ap\x07[hqxrd@web ap]$ ');
    await settle();
    assert.equal(linkNames(app, LISTING).length, 7);
    assert.equal(remote.status.at(-1), 'Var:/www/ap');
    app.dispose();
  });
});
