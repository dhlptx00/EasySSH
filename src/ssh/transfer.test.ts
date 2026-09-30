import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';
import { describe, it } from 'node:test';
import type { SFTPWrapper } from 'ssh2';
import { DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, SshSession, pipeTransfer, uploadMode } from './session';
import { TransferCancelled } from './errors';

/** Matches ssh2's write stream: destroy inside _final, then close and no finish. */
class RemoteWrite extends Writable {
  constructor() {
    super({ emitClose: false, autoDestroy: false });
  }

  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.destroy();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    callback(error);
    if (!error) this.emit('close');
  }
}

describe('file transfer', () => {
  it('finishes an upload when the remote stream only emits close', async () => {
    let done = 0;
    await pipeTransfer(
      Readable.from([Buffer.from('hello')]),
      new RemoteWrite(),
      5,
      (transferred) => {
        done = transferred;
      },
      new AbortController().signal,
    );
    assert.equal(done, 5);
  });

  it('stops when the transfer is cancelled', async () => {
    const abort = new AbortController();
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        abort.abort();
        callback();
      },
    });
    await assert.rejects(
      pipeTransfer(Readable.from([Buffer.from('hello')]), destination, 5, () => {}, abort.signal),
      TransferCancelled,
    );
  });
});

/** Just enough of SFTPWrapper for upload(): records the modes it is given. */
class FakeSftp {
  readonly dirs = new Map<string, number>([['/home/dev', 0o755]]);
  readonly files = new Map<string, number | undefined>();

  stat(target: string, cb: (err: Error | undefined, stats?: { isDirectory(): boolean; isFile(): boolean }) => void): void {
    if (this.dirs.has(target)) cb(undefined, { isDirectory: () => true, isFile: () => false });
    else if (this.files.has(target)) cb(undefined, { isDirectory: () => false, isFile: () => true });
    else cb(new Error('No such file'));
  }

  mkdir(target: string, attrs: { mode?: number }, cb: (err?: Error) => void): void {
    if (this.dirs.has(target)) {
      cb(new Error('Failure'));
      return;
    }
    this.dirs.set(target, attrs.mode ?? -1);
    cb();
  }

  createWriteStream(target: string, options?: { mode?: number }): Writable {
    this.files.set(target, options?.mode);
    return new RemoteWrite();
  }
}

describe('upload permissions', () => {
  it('keeps the local permission bits and falls back to 0644 / 0755', () => {
    assert.equal(uploadMode(0o100640, DEFAULT_FILE_MODE, 'linux'), 0o640);
    assert.equal(uploadMode(0o100755, DEFAULT_FILE_MODE, 'darwin'), 0o755);
    assert.equal(uploadMode(0o40750, DEFAULT_DIR_MODE, 'linux'), 0o750);
    assert.equal(uploadMode(undefined, DEFAULT_FILE_MODE, 'linux'), 0o644);
    assert.equal(uploadMode(0o100000, DEFAULT_FILE_MODE, 'linux'), 0o644);
    assert.equal(uploadMode(0o100666, DEFAULT_FILE_MODE, 'win32'), 0o644);
    assert.equal(uploadMode(0o40666, DEFAULT_DIR_MODE, 'win32'), 0o755);
  });

  it('does not upload files as 0666 and creates folders with the local mode', { skip: process.platform === 'win32' }, async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'easy-ssh-upload-'));
    try {
      const folder = path.join(root, 'site');
      await fs.promises.mkdir(path.join(folder, 'bin'), { recursive: true });
      await fs.promises.writeFile(path.join(folder, 'notes.txt'), 'hello');
      await fs.promises.writeFile(path.join(folder, 'bin', 'run.sh'), '#!/bin/sh\n');
      await fs.promises.chmod(path.join(folder, 'notes.txt'), 0o640);
      await fs.promises.chmod(path.join(folder, 'bin', 'run.sh'), 0o750);
      await fs.promises.chmod(path.join(folder, 'bin'), 0o700);
      await fs.promises.chmod(folder, 0o750);

      const sftp = new FakeSftp();
      const session = new SshSession([], sftp as unknown as SFTPWrapper, () => {});
      const result = await session.upload([folder], '/home/dev', () => {}, new AbortController().signal);

      assert.deepEqual(result, { uploaded: 2, skipped: 0 });
      assert.equal(sftp.files.get('/home/dev/site/notes.txt'), 0o640);
      assert.equal(sftp.files.get('/home/dev/site/bin/run.sh'), 0o750);
      assert.equal(sftp.dirs.get('/home/dev/site'), 0o750);
      assert.equal(sftp.dirs.get('/home/dev/site/bin'), 0o700);
      assert.equal(sftp.dirs.get('/home/dev'), 0o755);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
