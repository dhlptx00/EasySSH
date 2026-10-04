import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SFTPWrapper } from 'ssh2';
import { EDITOR_MAX_BYTES, RemoteFileError, RemoteFiles, overwriteText, type EditorSession, type OverwriteQuestion } from './remoteFiles';
import { SshSession } from './ssh/session';
import { FakeSftp } from './ssh/testSftp';

const DIR = '/home/demo/project';

function setup(options: { answer?: boolean; posixRename?: boolean } = {}) {
  const sftp = new FakeSftp({ posixRename: options.posixRename ?? true })
    .dir('/home').dir('/home/demo').dir(DIR)
    .file(`${DIR}/notes.txt`, 'hello\n', 0o640);
  const session = new SshSession([], sftp as unknown as SFTPWrapper, () => {});
  let connected: SshSession | null = session;
  const questions: OverwriteQuestion[] = [];
  const files = new RemoteFiles(
    (authority) => (authority === 'web-01' ? { label: 'web-01', session: () => connected as unknown as EditorSession | null } : undefined),
    async (question) => {
      questions.push(question);
      return options.answer ?? false;
    },
  );
  return {
    sftp,
    files,
    questions,
    disconnect: () => {
      connected = null;
    },
  };
}

const text = (data: Uint8Array) => Buffer.from(data).toString();

describe('remote files in editor tabs', () => {
  it('reads, saves, and keeps the file mode; no temporary files are left', async () => {
    const { sftp, files } = setup();
    assert.equal(text(await files.read('web-01', `${DIR}/notes.txt`)), 'hello\n');
    sftp.clock = 1_700_000_100;
    await files.write('web-01', `${DIR}/notes.txt`, Buffer.from('hello, world\n'), { create: true, overwrite: true });
    assert.equal(sftp.text(`${DIR}/notes.txt`), 'hello, world\n');
    assert.equal(sftp.nodes.get(`${DIR}/notes.txt`)?.mode, 0o640);
    assert.deepEqual(sftp.leftovers(), []);
    // The next save does not ask: the editor saw its own save.
    sftp.clock = 1_700_000_200;
    await files.write('web-01', `${DIR}/notes.txt`, Buffer.from('third\n'), { create: true, overwrite: true });
    assert.equal(sftp.text(`${DIR}/notes.txt`), 'third\n');
  });

  it('saves without posix-rename too (remove, then rename)', async () => {
    const { sftp, files } = setup({ posixRename: false });
    await files.read('web-01', `${DIR}/notes.txt`);
    await files.write('web-01', `${DIR}/notes.txt`, Buffer.from('v2'), { create: true, overwrite: true });
    assert.equal(sftp.text(`${DIR}/notes.txt`), 'v2');
    assert.equal(sftp.nodes.get(`${DIR}/notes.txt`)?.mode, 0o640);
    assert.deepEqual(sftp.leftovers(), []);
  });

  it('asks before overwriting a file that changed on the server; No keeps the server copy', async () => {
    const { sftp, files, questions } = setup({ answer: false });
    await files.read('web-01', `${DIR}/notes.txt`);
    sftp.file(`${DIR}/notes.txt`, 'changed by someone else\n', 0o640);
    sftp.nodes.get(`${DIR}/notes.txt`)!.mtime = 1_700_000_500;
    await assert.rejects(
      files.write('web-01', `${DIR}/notes.txt`, Buffer.from('mine\n'), { create: true, overwrite: true }),
      (err: unknown) => err instanceof RemoteFileError && /Not saved: notes\.txt changed on web-01/.test(err.message),
    );
    assert.equal(questions.length, 1);
    assert.equal(questions[0].opened.size, 6);
    assert.equal(questions[0].now?.size, 24);
    assert.equal(sftp.text(`${DIR}/notes.txt`), 'changed by someone else\n');
    const asked = overwriteText(questions[0]);
    assert.equal(asked.message, '"notes.txt" changed on web-01 after you opened it. Overwrite it with your version?');
    assert.match(asked.detail, /When you opened or last saved it: 6 B/);
  });

  it('overwrites a changed file when the answer is yes, and asks when it was deleted', async () => {
    const { sftp, files, questions } = setup({ answer: true });
    await files.read('web-01', `${DIR}/notes.txt`);
    sftp.nodes.get(`${DIR}/notes.txt`)!.mtime = 1_700_000_900;
    await files.write('web-01', `${DIR}/notes.txt`, Buffer.from('mine\n'), { create: true, overwrite: true });
    assert.equal(sftp.text(`${DIR}/notes.txt`), 'mine\n');
    assert.equal(questions.length, 1);
    sftp.nodes.delete(`${DIR}/notes.txt`);
    await files.write('web-01', `${DIR}/notes.txt`, Buffer.from('again\n'), { create: false, overwrite: true });
    assert.equal(questions.length, 2);
    assert.equal(questions[1].now, undefined);
    assert.match(overwriteText(questions[1]).message, /was deleted on web-01/);
    assert.equal(sftp.text(`${DIR}/notes.txt`), 'again\n');
  });

  it('reports what the editor last saw, so VS Code does not raise its own conflict first', async () => {
    const { sftp, files } = setup();
    await files.read('web-01', `${DIR}/notes.txt`);
    sftp.nodes.get(`${DIR}/notes.txt`)!.mtime = 1_700_000_900;
    const seen = await files.stat('web-01', `${DIR}/notes.txt`);
    assert.equal(seen.mtime, 1_700_000_000 * 1000);
    files.forget('web-01', `${DIR}/notes.txt`);
    assert.equal((await files.stat('web-01', `${DIR}/notes.txt`)).mtime, 1_700_000_900 * 1000);
  });

  it('saves through a symlink into the file it points to, keeping the link', async () => {
    const { sftp, files } = setup();
    sftp.dir('/srv').file('/srv/app.conf', 'a=1\n', 0o600);
    sftp.aliases.set(`${DIR}/app.conf`, '/srv/app.conf');
    assert.equal(text(await files.read('web-01', `${DIR}/app.conf`)), 'a=1\n');
    await files.write('web-01', `${DIR}/app.conf`, Buffer.from('a=2\n'), { create: true, overwrite: true });
    assert.equal(sftp.text('/srv/app.conf'), 'a=2\n');
    assert.equal(sftp.nodes.get('/srv/app.conf')?.mode, 0o600);
    assert.equal(sftp.nodes.has(`${DIR}/app.conf`), false, 'the link was not replaced by a file');
  });

  it('rewrites in place when replacing would change the owner, or the folder is not writable', async () => {
    const { sftp, files } = setup();
    sftp.nodes.get(`${DIR}/notes.txt`)!.uid = 0;
    await files.read('web-01', `${DIR}/notes.txt`);
    await files.write('web-01', `${DIR}/notes.txt`, Buffer.from('shared\n'), { create: true, overwrite: true });
    assert.equal(sftp.text(`${DIR}/notes.txt`), 'shared\n');
    assert.equal(sftp.nodes.get(`${DIR}/notes.txt`)?.uid, 0, 'owner kept');
    assert.deepEqual(sftp.leftovers(), []);
    const locked = new FakeSftp({ noCreate: new Set(['/etc']) }).dir('/etc').file('/etc/motd', 'hi', 0o664);
    const session = new SshSession([], locked as unknown as SFTPWrapper, () => {});
    await session.writeWhole('/etc/motd', Buffer.from('welcome'), { create: true, overwrite: true });
    assert.equal(locked.text('/etc/motd'), 'welcome');
    assert.equal(locked.nodes.get('/etc/motd')?.mode, 0o664);
  });

  it('creates a new file, and refuses to create when asked not to', async () => {
    const { sftp, files } = setup();
    await files.write('web-01', `${DIR}/new.md`, Buffer.from('# new'), { create: true, overwrite: false });
    assert.equal(sftp.text(`${DIR}/new.md`), '# new');
    await assert.rejects(files.write('web-01', `${DIR}/other.md`, Buffer.from('x'), { create: false, overwrite: true }), (err: unknown) => err instanceof RemoteFileError && err.kind === 'notFound');
    await assert.rejects(files.write('web-01', `${DIR}/new.md`, Buffer.from('x'), { create: true, overwrite: false }), (err: unknown) => err instanceof RemoteFileError && err.kind === 'exists');
  });

  it('gives clear errors: missing file, closed terminal, disconnected session, too large', async () => {
    const { sftp, files, disconnect } = setup();
    await assert.rejects(files.read('web-01', `${DIR}/missing.txt`), (err: unknown) => err instanceof RemoteFileError && err.kind === 'notFound' && /missing\.txt does not exist on web-01/.test(err.message));
    await assert.rejects(files.read('gone', `${DIR}/notes.txt`), (err: unknown) => err instanceof RemoteFileError && err.kind === 'unavailable' && /terminal .* is closed/.test(err.message));
    sftp.file(`${DIR}/huge.log`, 'x', 0o644, EDITOR_MAX_BYTES + 1);
    await assert.rejects(files.read('web-01', `${DIR}/huge.log`), /too large to open in an editor/);
    disconnect();
    await assert.rejects(files.write('web-01', `${DIR}/notes.txt`, Buffer.from('x'), { create: true, overwrite: true }), (err: unknown) => err instanceof RemoteFileError && err.kind === 'unavailable' && /web-01 is disconnected/.test(err.message));
  });

  it('lists folders and reads the first bytes for the text check', async () => {
    const { sftp, files } = setup();
    sftp.file(`${DIR}/tool`, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]));
    assert.deepEqual((await files.list('web-01', DIR)).sort(), [['notes.txt', 'file'], ['tool', 'file']]);
    const session = new SshSession([], sftp as unknown as SFTPWrapper, () => {});
    assert.deepEqual([...(await session.readHead(`${DIR}/tool`, 4))], [0x7f, 0x45, 0x4c, 0x46]);
    assert.equal((await session.readHead(`${DIR}/notes.txt`, 8192)).toString(), 'hello\n');
  });
});

describe('remote files: VS Code version stamps', () => {
  it('a reload after a server change saves without a conflict (stat keeps the version VS Code holds)', async () => {
    const { sftp, files, questions } = setup();
    const path = `${DIR}/notes.txt`;
    // Open: VS Code stats, then reads.
    const first = await files.stat('web-01', path);
    await files.read('web-01', path);
    sftp.clock = 1_700_000_100;
    await files.write('web-01', path, Buffer.from('v1\n'), { create: true, overwrite: true });
    const afterSave = await files.stat('web-01', path);
    assert.notEqual(afterSave.mtime, first.mtime);
    // Someone changes it; the user reverts (stat, then read), edits and saves.
    sftp.file(path, 'from ops\n', 0o640);
    sftp.nodes.get(path)!.mtime = 1_700_000_300;
    const versionBefore = await files.stat('web-01', path);
    await files.read('web-01', path);
    const versionAfter = await files.stat('web-01', path);
    assert.deepEqual([versionAfter.mtime, versionAfter.size], [versionBefore.mtime, versionBefore.size], 'VS Code sees the version it holds');
    sftp.clock = 1_700_000_400;
    await files.write('web-01', path, Buffer.from('from ops\nmine\n'), { create: true, overwrite: true });
    assert.equal(questions.length, 0, 'no conflict: the editor had the server copy');
    assert.equal(sftp.text(path), 'from ops\nmine\n');
  });
});
