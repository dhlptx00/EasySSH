import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';
import type { SFTPWrapper } from 'ssh2';
import { DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, SshSession, collectUploads, downloadMode, renameWithRetry, uploadMode } from './session';
import { TooManyFiles, TransferCancelled, TransferError, humanizeSshError } from './errors';
import { FakeSftp } from './testSftp';
import { CHUNK_SIZE, IncompleteTransfer, downloadHandle, sftpOpen, uploadHandle, type LocalFile, type SftpHandleApi } from './transfer';
import type { ConflictChoice, TransferProgress, UploadOptions } from '../types';
import { numberedName, reserveLocalTarget } from '../localTarget';

const windows = process.platform === 'win32';

/** A local file in memory. */
function memoryFile(source?: Buffer): LocalFile & { data: Buffer } {
  const file = {
    data: source ?? Buffer.alloc(0),
    async write(buffer: Buffer, offset: number, length: number, position: number) {
      if (file.data.length < position + length) {
        const grown = Buffer.alloc(position + length);
        file.data.copy(grown);
        file.data = grown;
      }
      buffer.copy(file.data, position, offset, offset + length);
    },
    async read(buffer: Buffer, offset: number, length: number, position: number) {
      const bytesRead = Math.max(0, file.data.copy(buffer, offset, position, Math.min(file.data.length, position + length)));
      return { bytesRead };
    },
  };
  return file;
}

function pattern(size: number): Buffer {
  const data = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) data[index] = (index * 31 + 7) & 0xff;
  return data;
}

function chunkOptions(signal = new AbortController().signal, concurrency = 8) {
  let reported = 0;
  return {
    options: { concurrency, signal, onBytes: (bytes: number) => (reported += bytes) },
    reported: () => reported,
  };
}

async function openRemote(sftp: FakeSftp, target: string, flags = 'r'): Promise<Buffer> {
  return sftpOpen(sftp as unknown as SftpHandleApi, target, flags);
}

describe('parallel SFTP transfer (U2)', () => {
  it('reads chunks in parallel, out of order, into the right places', async () => {
    const data = pattern(CHUNK_SIZE * 10 + 123);
    const sftp = new FakeSftp({ jitter: 3 }).file('/big.bin', data);
    const local = memoryFile();
    const { options, reported } = chunkOptions(undefined, 8);
    const result = await downloadHandle(sftp as unknown as SftpHandleApi, await openRemote(sftp, '/big.bin'), data.length, local, options);
    assert.equal(result.bytes, data.length);
    assert.ok(local.data.equals(data));
    assert.equal(reported(), data.length);
    assert.ok(sftp.maxInFlight > 1, `in flight: ${sftp.maxInFlight}`);
    assert.ok(sftp.maxInFlight <= 8);
  });

  it('copes with servers that return fewer bytes per read', async () => {
    const data = pattern(CHUNK_SIZE * 3);
    const sftp = new FakeSftp({ maxRead: 1000 }).file('/a', data);
    const local = memoryFile();
    await downloadHandle(sftp as unknown as SftpHandleApi, await openRemote(sftp, '/a'), data.length, local, chunkOptions().options);
    assert.ok(local.data.equals(data));
  });

  it('reads a file that reports size 0, like /proc files (B6)', async () => {
    const sftp = new FakeSftp().file('/proc/cpuinfo', 'processor : 0\nmodel name : x\n', 0o444, 0);
    const local = memoryFile();
    const result = await downloadHandle(sftp as unknown as SftpHandleApi, await openRemote(sftp, '/proc/cpuinfo'), 0, local, chunkOptions().options);
    assert.equal(local.data.toString(), 'processor : 0\nmodel name : x\n');
    assert.equal(result.bytes, local.data.length);
  });

  it('keeps reading a file that grew since it was opened', async () => {
    const data = pattern(CHUNK_SIZE * 2 + 50);
    const sftp = new FakeSftp().file('/log', data);
    const local = memoryFile();
    const result = await downloadHandle(sftp as unknown as SftpHandleApi, await openRemote(sftp, '/log'), CHUNK_SIZE, local, chunkOptions().options);
    assert.equal(result.bytes, data.length);
    assert.equal(result.expected, CHUNK_SIZE);
    assert.ok(local.data.equals(data));
  });

  it('fails a download that ends early instead of reporting success (B5)', async () => {
    const data = pattern(CHUNK_SIZE * 4);
    const sftp = new FakeSftp().file('/cut', data);
    sftp.truncateAt.set('/cut', CHUNK_SIZE + 10);
    await assert.rejects(
      downloadHandle(sftp as unknown as SftpHandleApi, await openRemote(sftp, '/cut'), data.length, memoryFile(), chunkOptions().options),
      (err: unknown) => err instanceof IncompleteTransfer && err.expected === data.length,
    );
    assert.match(humanizeSshError(new IncompleteTransfer(10, 20)), /incomplete|10 of 20|connection/i);
  });

  it('fails an upload whose local file shrank (B5)', async () => {
    const sftp = new FakeSftp().dir('/up');
    const handle = await openRemote(sftp, '/up/x', 'w');
    await assert.rejects(
      uploadHandle(sftp as unknown as SftpHandleApi, handle, 100, memoryFile(pattern(60)), chunkOptions().options),
      IncompleteTransfer,
    );
  });

  it('uploads every byte in parallel', async () => {
    const data = pattern(CHUNK_SIZE * 5 + 1);
    const sftp = new FakeSftp().dir('/up');
    const handle = await openRemote(sftp, '/up/x', 'w');
    const result = await uploadHandle(sftp as unknown as SftpHandleApi, handle, data.length, memoryFile(data), chunkOptions().options);
    assert.equal(result.bytes, data.length);
    assert.ok(sftp.nodes.get('/up/x')?.data.equals(data));
  });

  it('stops when cancelled', async () => {
    const data = pattern(CHUNK_SIZE * 20);
    const sftp = new FakeSftp({ jitter: 2 }).file('/a', data);
    const abort = new AbortController();
    const local = memoryFile();
    const pending = downloadHandle(sftp as unknown as SftpHandleApi, await openRemote(sftp, '/a'), data.length, local, {
      concurrency: 2,
      signal: abort.signal,
      onBytes: () => abort.abort(),
    });
    await assert.rejects(pending, TransferCancelled);
  });
});

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

describe('permissions', () => {
  it('keeps the local permission bits on upload and falls back to 0644 / 0755', () => {
    assert.equal(uploadMode(0o100640, DEFAULT_FILE_MODE, 'linux'), 0o640);
    assert.equal(uploadMode(0o100755, DEFAULT_FILE_MODE, 'darwin'), 0o755);
    assert.equal(uploadMode(0o40750, DEFAULT_DIR_MODE, 'linux'), 0o750);
    assert.equal(uploadMode(undefined, DEFAULT_FILE_MODE, 'linux'), 0o644);
    assert.equal(uploadMode(0o100000, DEFAULT_FILE_MODE, 'linux'), 0o644);
    assert.equal(uploadMode(0o100666, DEFAULT_FILE_MODE, 'win32'), 0o644);
    assert.equal(uploadMode(0o40666, DEFAULT_DIR_MODE, 'win32'), 0o755);
  });

  it('keeps the remote bits on download, always owner-readable (S6)', () => {
    assert.equal(downloadMode(0o100600, 'file'), 0o600);
    assert.equal(downloadMode(0o100755, 'file'), 0o755);
    assert.equal(downloadMode(0o100444, 'file'), 0o644);
    assert.equal(downloadMode(0o100000, 'file'), 0o600);
    assert.equal(downloadMode(undefined, 'file'), 0o644);
    assert.equal(downloadMode(0o40500, 'folder'), 0o700);
    assert.equal(downloadMode(undefined, 'folder'), 0o755);
  });
});

async function tempDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), 'easy-ssh-test-'));
}

function sessionOf(sftp: FakeSftp): SshSession {
  return new SshSession([], sftp as unknown as SFTPWrapper, () => {});
}

function transferOptions(extra: Partial<UploadOptions> = {}): UploadOptions & { seen: TransferProgress[]; conflicts: string[][] } {
  const seen: TransferProgress[] = [];
  const conflicts: string[][] = [];
  return {
    signal: new AbortController().signal,
    concurrency: 8,
    maxFiles: 100,
    onProgress: (progress) => seen.push(progress),
    resolveConflict: async (existing) => {
      conflicts.push(existing);
      return 'replace';
    },
    ...extra,
    seen,
    conflicts,
  };
}

async function modeOf(file: string): Promise<number> {
  return (await fs.promises.stat(file)).mode & 0o777;
}

async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string) => {
    for (const name of (await fs.promises.readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const relName = rel ? `${rel}/${name}` : name;
      out.push(relName);
      if ((await fs.promises.stat(full)).isDirectory()) await walk(full, relName);
    }
  };
  await walk(root, '');
  return out;
}

describe('file download', () => {
  it('saves under a numbered name when taken, keeping the remote mode, with no .part left', async () => {
    const root = await tempDir();
    try {
      await fs.promises.writeFile(path.join(root, 'id.txt'), 'old');
      const sftp = new FakeSftp().dir('/srv').file('/srv/id.txt', 'secret', 0o600);
      const result = await sessionOf(sftp).download('/srv/id.txt', root, 'id.txt', transferOptions());
      assert.equal(result.localPath, path.join(root, 'id (1).txt'));
      assert.equal(await fs.promises.readFile(result.localPath, 'utf8'), 'secret');
      assert.equal(await fs.promises.readFile(path.join(root, 'id.txt'), 'utf8'), 'old');
      if (!windows) assert.equal(await modeOf(result.localPath), 0o600);
      assert.deepEqual(await listTree(root), ['id (1).txt', 'id.txt']);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('removes the .part file when the transfer fails (B5)', async () => {
    const root = await tempDir();
    try {
      const sftp = new FakeSftp().dir('/srv').file('/srv/a.bin', pattern(CHUNK_SIZE * 3));
      sftp.truncateAt.set('/srv/a.bin', 100);
      await assert.rejects(sessionOf(sftp).download('/srv/a.bin', root, 'a.bin', transferOptions()), IncompleteTransfer);
      assert.deepEqual(await listTree(root), []);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('gives two downloads of the same name at once different files (B13)', async () => {
    const root = await tempDir();
    try {
      const sftp = new FakeSftp({ jitter: 3 }).dir('/a').dir('/b').file('/a/x.log', pattern(CHUNK_SIZE * 4)).file('/b/x.log', 'b');
      const session = sessionOf(sftp);
      const [first, second] = await Promise.all([
        session.download('/a/x.log', root, 'x.log', transferOptions()),
        session.download('/b/x.log', root, 'x.log', transferOptions()),
      ]);
      assert.notEqual(first.localPath, second.localPath);
      assert.deepEqual(await listTree(root), ['x (1).log', 'x.log']);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('reserves local names and numbers files and folders', () => {
    assert.equal(numberedName('a.tar.gz', 1, 'file'), 'a.tar (1).gz');
    assert.equal(numberedName('.bashrc', 2, 'file'), '.bashrc (2)');
    assert.equal(numberedName('site.v2', 1, 'folder'), 'site.v2 (1)');
    const first = reserveLocalTarget('/d', 'x.txt', 'file', () => false, 'linux');
    const second = reserveLocalTarget('/d', 'x.txt', 'file', () => false, 'linux');
    const upper = reserveLocalTarget('/d', 'X.TXT', 'file', () => false, 'darwin');
    assert.equal(first.path, '/d/x.txt');
    assert.equal(second.path, '/d/x (1).txt');
    assert.equal(upper.path, '/d/X (2).TXT');
    first.release();
    assert.equal(reserveLocalTarget('/d', 'x.txt', 'file', () => false, 'linux').path, '/d/x.txt');
  });
});

function siteTree(): FakeSftp {
  return new FakeSftp({ jitter: 1 })
    .dir('/home')
    .dir('/home/dev')
    .dir('/home/dev/site', 0o750)
    .file('/home/dev/site/index.html', '<h1>hi</h1>')
    .dir('/home/dev/site/bin', 0o700)
    .file('/home/dev/site/bin/run.sh', '#!/bin/sh\n', 0o750)
    .dir('/home/dev/site/empty')
    .dir('/home/dev/site/assets')
    .file('/home/dev/site/assets/logo.png', pattern(CHUNK_SIZE * 2 + 5))
    .link('/home/dev/site/current')
    .special('/home/dev/site/fifo');
}

describe('folder download', () => {
  it('copies the tree, keeps modes, skips and reports symlinks and special files', async () => {
    const root = await tempDir();
    try {
      const sftp = siteTree();
      const options = transferOptions();
      const result = await sessionOf(sftp).downloadFolder('/home/dev/site', root, 'site', options);
      const local = path.join(root, 'site');
      assert.equal(result.localPath, local);
      assert.equal(result.files, 3);
      assert.deepEqual(result.skipped, [
        { path: 'current', reason: 'symlink' },
        { path: 'fifo', reason: 'special file' },
      ]);
      assert.deepEqual(await listTree(local), ['assets', 'assets/logo.png', 'bin', 'bin/run.sh', 'empty', 'index.html']);
      assert.ok((await fs.promises.readFile(path.join(local, 'assets', 'logo.png'))).equals(pattern(CHUNK_SIZE * 2 + 5)));
      if (!windows) {
        assert.equal(await modeOf(path.join(local, 'bin', 'run.sh')), 0o750);
        assert.equal(await modeOf(path.join(local, 'bin')), 0o700);
      }
      assert.deepEqual(await listTree(root), ['site', ...(await listTree(local)).map((item) => `site/${item}`)]);
      const last = options.seen[options.seen.length - 1];
      assert.equal(last.files, 3);
      assert.ok(options.seen.some((item) => item.phase === 'scan' || item.phase === 'copy'));
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('names it "site (1)" when site already exists locally', async () => {
    const root = await tempDir();
    try {
      await fs.promises.mkdir(path.join(root, 'site'));
      const result = await sessionOf(siteTree()).downloadFolder('/home/dev/site', root, 'site', transferOptions());
      assert.equal(result.localPath, path.join(root, 'site (1)'));
      assert.deepEqual(await fs.promises.readdir(path.join(root, 'site')), []);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a folder over the file cap and leaves nothing behind', async () => {
    const root = await tempDir();
    try {
      await assert.rejects(
        sessionOf(siteTree()).downloadFolder('/home/dev/site', root, 'site', transferOptions({ maxFiles: 2 })),
        (err: unknown) => err instanceof TooManyFiles && /maxTransferFiles/.test(err.message),
      );
      assert.deepEqual(await listTree(root), []);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('cleans up the partial folder when cancelled', async () => {
    const root = await tempDir();
    try {
      const abort = new AbortController();
      const options = transferOptions({ signal: abort.signal });
      options.onProgress = (progress) => {
        if (progress.phase === 'copy' && progress.bytes > 0) abort.abort();
      };
      await assert.rejects(sessionOf(siteTree()).downloadFolder('/home/dev/site', root, 'site', options), TransferCancelled);
      assert.deepEqual(await listTree(root), []);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('skips a subfolder it cannot read and reports it', async () => {
    const root = await tempDir();
    try {
      const sftp = siteTree().dir('/home/dev/site/private', 0);
      const result = await sessionOf(sftp).downloadFolder('/home/dev/site', root, 'site', transferOptions());
      assert.ok(result.skipped.some((item) => item.path === 'private' && /not readable/.test(item.reason)));
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

async function localSite(root: string): Promise<string> {
  const folder = path.join(root, 'site');
  await fs.promises.mkdir(path.join(folder, 'bin'), { recursive: true });
  await fs.promises.writeFile(path.join(folder, 'notes.txt'), 'hello');
  await fs.promises.writeFile(path.join(folder, 'bin', 'run.sh'), '#!/bin/sh\n');
  await fs.promises.chmod(path.join(folder, 'notes.txt'), 0o640);
  await fs.promises.chmod(path.join(folder, 'bin', 'run.sh'), 0o750);
  await fs.promises.chmod(path.join(folder, 'bin'), 0o700);
  await fs.promises.chmod(folder, 0o750);
  return folder;
}

describe('upload', () => {
  // Windows has no POSIX permission bits (stat reports 0666/0777 and chmod only toggles
  // read-only), so there uploads use 0644 for files and 0755 for new folders.
  it('keeps local modes and writes through hidden temporary files', async () => {
    const root = await tempDir();
    try {
      const folder = await localSite(root);
      const sftp = new FakeSftp().dir('/home').dir('/home/dev');
      const result = await sessionOf(sftp).upload([folder], '/home/dev', transferOptions());
      assert.deepEqual(result, { uploaded: 2, skipped: 0, kept: 0, renamed: [] });
      assert.equal(sftp.text('/home/dev/site/notes.txt'), 'hello');
      assert.equal(sftp.nodes.get('/home/dev/site/notes.txt')?.mode, windows ? 0o644 : 0o640);
      assert.equal(sftp.nodes.get('/home/dev/site/bin/run.sh')?.mode, windows ? 0o644 : 0o750);
      assert.equal(sftp.nodes.get('/home/dev/site')?.mode, windows ? 0o755 : 0o750);
      assert.equal(sftp.nodes.get('/home/dev/site/bin')?.mode, windows ? 0o755 : 0o700);
      assert.ok(sftp.opened.every((item) => item.flags === 'wx' && /\/\.[^/]+\.part$/.test(item.path)));
      assert.deepEqual(sftp.leftovers(), []);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  const conflictCases: [ConflictChoice, (sftp: FakeSftp) => void][] = [
    ['replace', (sftp) => {
      assert.equal(sftp.text('/home/dev/notes.txt'), 'new');
    }],
    ['keep', (sftp) => {
      assert.equal(sftp.text('/home/dev/notes.txt'), 'old');
      assert.equal(sftp.text('/home/dev/notes (1).txt'), 'new');
    }],
    ['skip', (sftp) => {
      assert.equal(sftp.text('/home/dev/notes.txt'), 'old');
      assert.equal(sftp.nodes.has('/home/dev/notes (1).txt'), false);
    }],
  ];
  for (const [choice, check] of conflictCases) {
    it(`asks before replacing an existing remote file: ${choice} (U6)`, async () => {
      const root = await tempDir();
      try {
        const file = path.join(root, 'notes.txt');
        await fs.promises.writeFile(file, 'new');
        for (const posixRename of [false, true]) {
          const sftp = new FakeSftp({ posixRename }).dir('/home').dir('/home/dev').file('/home/dev/notes.txt', 'old');
          const options = transferOptions({ resolveConflict: async () => choice });
          const result = await sessionOf(sftp).upload([file], '/home/dev', options);
          check(sftp);
          assert.deepEqual(sftp.leftovers(), []);
          if (choice === 'skip') assert.equal(result.kept, 1);
          if (choice === 'keep') assert.deepEqual(result.renamed, ['notes.txt -> notes (1).txt']);
        }
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    });
  }

  it('changes nothing when the conflict question is cancelled', async () => {
    const root = await tempDir();
    try {
      const file = path.join(root, 'notes.txt');
      await fs.promises.writeFile(file, 'new');
      const sftp = new FakeSftp().dir('/home').dir('/home/dev').file('/home/dev/notes.txt', 'old');
      await assert.rejects(sessionOf(sftp).upload([file], '/home/dev', transferOptions({ resolveConflict: async () => 'cancel' })), TransferCancelled);
      assert.equal(sftp.text('/home/dev/notes.txt'), 'old');
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('does not ask when nothing would be replaced', async () => {
    const root = await tempDir();
    try {
      const file = path.join(root, 'fresh.txt');
      await fs.promises.writeFile(file, 'x');
      const options = transferOptions();
      await sessionOf(new FakeSftp().dir('/home').dir('/home/dev')).upload([file], '/home/dev', options);
      assert.deepEqual(options.conflicts, []);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('writes in place where only existing files may be replaced', async () => {
    const root = await tempDir();
    try {
      const file = path.join(root, 'app.conf');
      await fs.promises.writeFile(file, 'new');
      const sftp = new FakeSftp({ noCreate: new Set(['/etc/app']) }).dir('/etc').dir('/etc/app').file('/etc/app/app.conf', 'old');
      await sessionOf(sftp).upload([file], '/etc/app', transferOptions());
      assert.equal(sftp.text('/etc/app/app.conf'), 'new');
      assert.deepEqual(sftp.leftovers(), []);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('stops scanning a big drop at the file cap (B14)', async () => {
    const root = await tempDir();
    try {
      const folder = path.join(root, 'many');
      await fs.promises.mkdir(folder);
      for (let index = 0; index < 30; index += 1) await fs.promises.writeFile(path.join(folder, `f${index}`), '');
      await assert.rejects(collectUploads([folder], '/r', { signal: new AbortController().signal, maxFiles: 10 }), TooManyFiles);
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(collectUploads([folder], '/r', { signal: abort.signal, maxFiles: 100 }), TransferCancelled);
      const all = await collectUploads([folder], '/r', { signal: new AbortController().signal, maxFiles: 30 });
      assert.equal(all.files.length, 30);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
