import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';
import { describe, it } from 'node:test';
import type { SFTPWrapper } from 'ssh2';
import { DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, SshSession, pipeTransfer, renameWithRetry, uploadMode } from './session';
import { TransferCancelled, TransferError, humanizeSshError } from './errors';

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

describe('transfer errors', () => {
  it('names the operation and the path', async () => {
    const denied = Object.assign(new Error('Permission denied'), { code: 3 });
    const remote = new TransferError('Cannot write', '/srv/app/runtime/app.jar', 'remote', denied);
    assert.equal(humanizeSshError(remote), 'Cannot write /srv/app/runtime/app.jar: Permission denied');
    assert.equal(remote.remotePermissionDenied, true);
    const local = new TransferError('Cannot read', 'C:\\Users\\me\\a.txt', 'local', Object.assign(new Error("EBUSY: resource busy or locked, open 'C:\\Users\\me\\a.txt'"), { code: 'EBUSY' }), 'win32');
    assert.equal(local.message, 'Cannot read C:\\Users\\me\\a.txt: the file is in use by another program');
    assert.equal(local.remotePermissionDenied, false);
  });

  it('labels which side of a transfer failed', async () => {
    const source = new Readable({ read() { this.destroy(Object.assign(new Error('No such file'), { code: 2 })); } });
    await assert.rejects(
      pipeTransfer(source, new RemoteWrite(), 5, () => {}, new AbortController().signal, {
        source: (err) => new TransferError('Cannot read', '/var/log/a.log', 'remote', err),
        destination: (err) => new TransferError('Cannot write', 'C:\\a.log', 'local', err),
      }),
      /Cannot read \/var\/log\/a\.log: No such file/,
    );
  });

  it('retries a rename that antivirus briefly blocks', async () => {
    let tries = 0;
    await renameWithRetry('a.part', 'a', async () => {
      tries += 1;
      if (tries < 3) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    }, 5, 1);
    assert.equal(tries, 3);
    await assert.rejects(renameWithRetry('a.part', 'a', async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }, 5, 1), /ENOENT/);
  });
});

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

  // Windows has no POSIX permission bits (stat reports 0666/0777 and chmod only toggles
  // read-only), so there uploads use 0644 for files and 0755 for new folders.
  const windows = process.platform === 'win32';
  it('does not upload files as 0666 and creates folders with the local mode', async () => {
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
      assert.equal(sftp.files.get('/home/dev/site/notes.txt'), windows ? 0o644 : 0o640);
      assert.equal(sftp.files.get('/home/dev/site/bin/run.sh'), windows ? 0o644 : 0o750);
      assert.equal(sftp.dirs.get('/home/dev/site'), windows ? 0o755 : 0o750);
      assert.equal(sftp.dirs.get('/home/dev/site/bin'), windows ? 0o755 : 0o700);
      assert.equal(sftp.dirs.get('/home/dev'), 0o755);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
