import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';
import type { SFTPWrapper } from 'ssh2';
import { TransferCancelled } from './errors';
import { SshSession } from './session';
import { FakeSftp } from './testSftp';

function sessionOf(sftp: FakeSftp): SshSession {
  return new SshSession([], sftp as unknown as SFTPWrapper, () => {});
}

function tree(): FakeSftp {
  return new FakeSftp()
    .dir('/home').dir('/home/demo').dir('/home/demo/project')
    .file('/home/demo/project/notes.txt', 'hello')
    .dir('/home/demo/project/logs')
    .file('/home/demo/project/logs/a.log', 'a')
    .file('/home/demo/project/logs/b.log', 'b')
    .dir('/home/demo/project/logs/old')
    .file('/home/demo/project/logs/old/c.log', 'c')
    .link('/home/demo/project/logs/current')
    .dir('/home/demo/project/logs/empty');
}

const transfer = () => ({ signal: new AbortController().signal, concurrency: 4, onProgress: () => {} });

describe('file actions over SFTP', () => {
  it('counts files and subfolders, and stops at the cap', async () => {
    const session = sessionOf(tree());
    assert.deepEqual(await session.countTree('/home/demo/project/logs', { cap: 100, timeoutMs: 5000 }), { files: 4, folders: 2, capped: false });
    const capped = await session.countTree('/home/demo/project', { cap: 2, timeoutMs: 5000 });
    assert.equal(capped.capped, true);
    assert.equal(capped.files, 2);
    await assert.rejects(session.countTree('/nope', { cap: 10, timeoutMs: 1000 }));
  });

  it('deletes a folder with everything in it, links without following them', async () => {
    const sftp = tree().dir('/srv').file('/srv/keep.txt', 'k');
    const session = sessionOf(sftp);
    const seen: number[] = [];
    const result = await session.remove('/home/demo/project/logs', { signal: new AbortController().signal, onProgress: (done) => seen.push(done) });
    assert.deepEqual(result, { files: 4, folders: 3 });
    assert.deepEqual([...sftp.nodes.keys()].filter((key) => key.startsWith('/home/demo/project')).sort(), ['/home/demo/project', '/home/demo/project/notes.txt']);
    assert.equal(seen.at(-1), 7);
    assert.equal(sftp.text('/srv/keep.txt'), 'k');
    await session.remove('/home/demo/project/notes.txt', { signal: new AbortController().signal });
    assert.equal(sftp.nodes.has('/home/demo/project/notes.txt'), false);
  });

  it('refuses to delete the root and stops when cancelled', async () => {
    const sftp = tree();
    const session = sessionOf(sftp);
    await assert.rejects(session.remove('/', { signal: new AbortController().signal }), /refusing/);
    await assert.rejects(session.remove('/home/..', { signal: new AbortController().signal }), /refusing/);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(session.remove('/home/demo/project/logs', { signal: abort.signal }), TransferCancelled);
    assert.ok(sftp.nodes.has('/home/demo/project/logs/a.log'));
  });

  it('renames, and never over an existing name', async () => {
    const sftp = tree();
    const session = sessionOf(sftp);
    await session.rename('/home/demo/project/notes.txt', '/home/demo/project/todo.txt');
    assert.equal(sftp.text('/home/demo/project/todo.txt'), 'hello');
    await assert.rejects(session.rename('/home/demo/project/todo.txt', '/home/demo/project/logs'), /Cannot rename .*logs already exists/);
    assert.equal(sftp.text('/home/demo/project/todo.txt'), 'hello');
  });

  it('stats a path and downloads to the exact path picked, replacing a file there', async () => {
    const session = sessionOf(tree());
    const found = await session.stat('/home/demo/project/notes.txt');
    assert.deepEqual(found, { kind: 'file', size: 5, mtime: 1_700_000_000_000 });
    assert.equal((await session.stat('/home/demo/project/logs')).kind, 'dir');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'easyssh-actions-'));
    try {
      const local = path.join(dir, 'sub', 'copy.txt');
      const first = await session.downloadTo('/home/demo/project/notes.txt', local, transfer());
      assert.equal(first.localPath, local);
      assert.equal(await fs.promises.readFile(local, 'utf8'), 'hello');
      await fs.promises.writeFile(local, 'old contents');
      await session.downloadTo('/home/demo/project/logs/a.log', local, transfer());
      assert.equal(await fs.promises.readFile(local, 'utf8'), 'a');
      assert.deepEqual(fs.readdirSync(path.join(dir, 'sub')), ['copy.txt']);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
