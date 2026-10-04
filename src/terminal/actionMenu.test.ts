import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrowseEntry } from '../types';
import type { ActionMenu, FileAction, TreeCount } from './actions';
import { EasySshApp } from './app';
import type { AppHost, ProgressHandle, RenameRequest } from './host';
import { fakeRemote, flush, sleep, type FakeRemote } from './testHost';

const HOME = '/home/demo/project';
const entries: BrowseEntry[] = [
  { name: 'logs', path: `${HOME}/logs`, kind: 'dir', size: 0, mtime: 0 },
  { name: 'notes.txt', path: `${HOME}/notes.txt`, kind: 'file', size: 120, mtime: 0 },
  { name: "it's big.log", path: `${HOME}/it's big.log`, kind: 'file', size: 30 * 1024 * 1024, mtime: 0 },
  { name: 'backup.tar.gz', path: `${HOME}/backup.tar.gz`, kind: 'file', size: 4096, mtime: 0 },
  { name: 'run', path: `${HOME}/run`, kind: 'file', size: 9000, mtime: 0 },
  { name: 'notes', path: `${HOME}/notes`, kind: 'file', size: 50, mtime: 0 },
  { name: 'stuck', path: `${HOME}/stuck`, kind: 'file', size: 50, mtime: 0 },
  { name: 'broken', path: `${HOME}/broken`, kind: 'file', size: 50, mtime: 0 },
];

/** First bytes of the files the menu has to sniff. */
const heads: Record<string, Buffer | 'slow' | 'fail'> = {
  [`${HOME}/run`]: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
  [`${HOME}/notes`]: Buffer.from('remember the milk\n'),
  [`${HOME}/stuck`]: 'slow',
  [`${HOME}/broken`]: 'fail',
};

interface Script {
  /** The menu choice. */
  pick?: FileAction;
  save?: string;
  parent?: string;
  uploads?: string[];
  rename?: string;
  /** Answers to confirm(), in order. Missing answers are false. */
  confirms?: boolean[];
  /** Answers to choose(), in order. Missing answers cancel. */
  chooses?: (string | undefined)[];
  /** openRemoteFile fails with this message. */
  openFails?: string;
}

interface Rig {
  app: EasySshApp;
  remote: FakeRemote;
  menus: ActionMenu[];
  placeholders: (string | undefined)[];
  saves: [string, string][];
  parents: [string, string][];
  uploadPickers: string[];
  renames: RenameRequest[];
  confirms: { message: string; detail: string; action: string }[];
  downloadsTo: [string, string][];
  renamed: [string, string][];
  removed: string[];
  progress: string[];
  opened: string[];
  chosen: { message: string; detail: string; answers: string[] }[];
  sniffed: string[];
  script: Script;
}

async function rig(script: Script = {}, options: { count?: TreeCount; existing?: string[] } = {}): Promise<Rig> {
  const remote = fakeRemote({ cwd: HOME, files: entries });
  const state: Rig = {
    app: undefined as unknown as EasySshApp,
    remote,
    menus: [],
    placeholders: [],
    saves: [],
    parents: [],
    uploadPickers: [],
    renames: [],
    confirms: [],
    downloadsTo: [],
    renamed: [],
    removed: [],
    progress: [],
    opened: [],
    chosen: [],
    sniffed: [],
    script,
  };
  const session = remote.session;
  session.list = async (dir) => (dir === HOME ? entries : [entries[1]]);
  session.downloadTo = async (remotePath, localPath, transfer) => {
    state.downloadsTo.push([remotePath, localPath]);
    transfer.onProgress({ phase: 'copy', bytes: 1, totalBytes: 2, files: 0, totalFiles: 1 });
    await sleep(350);
    transfer.onProgress({ phase: 'copy', bytes: 2, totalBytes: 2, files: 1, totalFiles: 1 });
    return { localPath, bytes: 2, grew: false };
  };
  session.stat = async () => ({ kind: 'file', size: 10, mtime: 0 });
  session.exists = async (path) => (options.existing ?? []).includes(path);
  session.rename = async (from, to) => {
    state.renamed.push([from, to]);
  };
  session.remove = async (path, removal) => {
    state.removed.push(path);
    removal.onProgress?.(1);
    return { files: 12, folders: 4 };
  };
  session.countTree = async () => options.count ?? { files: 12, folders: 3, capped: false };
  session.readHead = async (path) => {
    state.sniffed.push(path);
    const head = heads[path];
    if (head === 'slow') return new Promise<Buffer>(() => {});
    if (head === 'fail' || head === undefined) throw new Error('read failed');
    return head;
  };
  session.readWhole = async () => ({ data: Buffer.from('x'), stat: { kind: 'file', size: 1, mtime: 0 } });
  session.writeWhole = async () => ({ kind: 'file', size: 1, mtime: 0 });
  const chooses = [...(script.chooses ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const host: AppHost = {
    ...remote.host,
    showActionMenu: async (menu, update) => {
      state.menus.push(menu);
      state.placeholders.push(await update);
      return state.script.pick;
    },
    pickSaveFile: async (folder, name) => {
      state.saves.push([folder, name]);
      return state.script.save;
    },
    pickDownloadParent: async (folder, name) => {
      state.parents.push([folder, name]);
      return state.script.parent;
    },
    pickUploadFiles: async (dir) => {
      state.uploadPickers.push(dir);
      return state.script.uploads;
    },
    askRename: async (request) => {
      state.renames.push(request);
      return state.script.rename;
    },
    confirm: async (message, detail, action) => {
      state.confirms.push({ message, detail, action });
      return confirms.shift() ?? false;
    },
    showProgress: (title: string): ProgressHandle => ({ report: (text) => state.progress.push(`${title}: ${text}`), close: () => {} }),
    openRemoteFile: async (path) => {
      if (state.script.openFails) throw new Error(state.script.openFails);
      state.opened.push(path);
    },
    choose: async (message, detail, answers) => {
      state.chosen.push({ message, detail, answers });
      return chooses.shift();
    },
  };
  const app = new EasySshApp(host, () => {});
  app.setSize(100, 30);
  app.open();
  await flush();
  app.onInput([{ type: 'key', key: 'enter' }]);
  await flush();
  remote.push(`\x1b]7;${HOME}\x07$ `);
  await flush();
  state.app = app;
  return state;
}

async function click(r: Rig, path: string, wait = 20): Promise<void> {
  r.app.activatePath(path);
  await flush();
  await sleep(wait);
  await flush();
}

describe('Ctrl+click action menu', () => {
  it('opens a menu for a file instead of downloading, and Escape does nothing', async () => {
    const r = await rig();
    await click(r, `${HOME}/notes.txt`);
    assert.equal(r.menus.length, 1);
    assert.equal(r.menus[0].title, `notes.txt — ${HOME}`);
    assert.deepEqual(r.menus[0].items.map((item) => item.action ?? '---'), ['download', 'open', '---', 'rename', '---', 'delete']);
    assert.deepEqual(r.remote.downloads, []);
    assert.deepEqual(r.downloadsTo, []);
    assert.deepEqual(r.remote.written.filter((line) => !line.includes('PROMPT')), []);
    r.app.dispose();
  });

  it('counts a folder\'s items for the placeholder and offers Upload but no Open', async () => {
    const r = await rig();
    await click(r, `${HOME}/logs`);
    assert.deepEqual(r.menus[0].items.map((item) => item.action ?? '---'), ['download', 'upload', '---', 'rename', '---', 'delete']);
    assert.match(r.menus[0].placeholder, /counting items/);
    assert.equal(r.placeholders[0], 'Folder · 1 item — Enter downloads');
    r.app.dispose();
  });

  it('links names with a tooltip and hint that list the actions', async () => {
    const r = await rig();
    const links = r.app.linkFor('logs notes.txt');
    assert.deepEqual(links.map((link) => link.tooltip).sort(), ['Folder logs: download, upload into, rename, delete', 'notes.txt: download, open, rename, delete']);
    r.app.dispose();
  });
});

describe('Download from the menu', () => {
  it('saves a file where the save dialog says, with a progress notification', async () => {
    const r = await rig({ pick: 'download', save: '/tmp/picked/notes-copy.txt' });
    await click(r, `${HOME}/notes.txt`, 450);
    assert.deepEqual(r.saves, [['C:\\Users\\me\\Desktop', 'notes.txt']]);
    assert.deepEqual(r.downloadsTo, [[`${HOME}/notes.txt`, '/tmp/picked/notes-copy.txt']]);
    assert.ok(r.progress.some((line) => line.startsWith('Easy SSH: notes.txt')), r.progress.join('\n'));
    assert.ok(r.remote.notes.some((note) => note.text === 'Downloaded notes.txt to /tmp/picked/notes-copy.txt'));
    r.app.dispose();
  });

  it('downloads nothing when the save dialog is cancelled', async () => {
    const r = await rig({ pick: 'download' });
    await click(r, `${HOME}/notes.txt`);
    assert.equal(r.saves.length, 1);
    assert.deepEqual(r.downloadsTo, []);
    assert.deepEqual(r.remote.downloads, []);
    r.app.dispose();
  });

  it('downloads a folder into the picked parent folder', async () => {
    const r = await rig({ pick: 'download', parent: '/tmp/backup' });
    await click(r, `${HOME}/logs`);
    assert.deepEqual(r.parents, [['C:\\Users\\me\\Desktop', 'logs']]);
    assert.deepEqual(r.remote.downloads, [{ remotePath: `${HOME}/logs`, folder: '/tmp/backup', name: 'logs', kind: 'folder' }]);
    r.app.dispose();
  });
});

describe('Upload from the menu', () => {
  it('uploads into a clicked folder', async () => {
    const r = await rig({ pick: 'upload', uploads: ['/local/a.txt', '/local/b.txt'] });
    await click(r, `${HOME}/logs`);
    assert.deepEqual(r.uploadPickers, [`${HOME}/logs`]);
    assert.deepEqual(r.remote.uploads, [{ paths: ['/local/a.txt', '/local/b.txt'], dir: `${HOME}/logs` }]);
    assert.ok(r.remote.notes.some((note) => note.text === `Uploaded 2 to ${HOME}/logs`), JSON.stringify(r.remote.notes));
    r.app.dispose();
  });

  it('uploads nothing when the picker is cancelled', async () => {
    const r = await rig({ pick: 'upload' });
    await click(r, `${HOME}/logs`);
    assert.equal(r.uploadPickers.length, 1);
    assert.deepEqual(r.remote.uploads, []);
    r.app.dispose();
  });

  it('is not offered for a file: a drop on the terminal uploads into its folder', async () => {
    const r = await rig();
    await click(r, `${HOME}/notes.txt`);
    assert.ok(!r.menus[0].items.some((item) => item.action === 'upload'));
    r.app.dispose();
  });
});

describe('Open from the menu (editor tab)', () => {
  const actions = (r: Rig) => r.menus[0].items.map((item) => item.action ?? '---');

  it('opens a text file in an editor tab, without reading it first by name', async () => {
    const r = await rig({ pick: 'open' });
    await click(r, `${HOME}/notes.txt`);
    assert.deepEqual(actions(r), ['download', 'open', '---', 'rename', '---', 'delete']);
    assert.deepEqual(r.opened, [`${HOME}/notes.txt`]);
    assert.deepEqual(r.chosen, []);
    assert.deepEqual(r.sniffed, []);
    r.app.dispose();
  });

  it('hides Open for a binary file by name: Download, Rename, Delete', async () => {
    const r = await rig();
    await click(r, `${HOME}/backup.tar.gz`);
    assert.deepEqual(actions(r), ['download', '---', 'rename', '---', 'delete']);
    assert.deepEqual(r.sniffed, []);
    r.app.dispose();
  });

  it('sniffs a name it does not know: NUL bytes hide Open, text shows it', async () => {
    const binary = await rig();
    await click(binary, `${HOME}/run`);
    assert.deepEqual(binary.sniffed, [`${HOME}/run`]);
    assert.ok(!binary.menus[0].items.some((item) => item.action === 'open'));
    binary.app.dispose();
    const text = await rig();
    await click(text, `${HOME}/notes`);
    assert.ok(text.menus[0].items.some((item) => item.action === 'open'));
    text.app.dispose();
  });

  it('shows Open when the sniff fails or is slow', async () => {
    const failed = await rig();
    await click(failed, `${HOME}/broken`);
    assert.ok(failed.menus[0].items.some((item) => item.action === 'open'));
    failed.app.dispose();
    const slow = await rig();
    const started = Date.now();
    await click(slow, `${HOME}/stuck`, 900);
    assert.equal(slow.menus.length, 1);
    assert.ok(slow.menus[0].items.some((item) => item.action === 'open'));
    assert.ok(Date.now() - started < 2000);
    assert.ok(slow.remote.logs.some((line) => line.includes('offering Open')));
    slow.app.dispose();
  });

  it('asks before opening a text file over 5 MB: Open Anyway, Download, or Cancel', async () => {
    const cancel = await rig({ pick: 'open' });
    await click(cancel, `${HOME}/it's big.log`);
    assert.equal(cancel.chosen.length, 1);
    assert.equal(cancel.chosen[0].message, '"it\'s big.log" is 30 MB. Open it in an editor?');
    assert.deepEqual(cancel.chosen[0].answers, ['Open Anyway', 'Download']);
    assert.deepEqual(cancel.opened, []);
    cancel.app.dispose();
    const anyway = await rig({ pick: 'open', chooses: ['Open Anyway'] });
    await click(anyway, `${HOME}/it's big.log`);
    assert.deepEqual(anyway.opened, [`${HOME}/it's big.log`]);
    anyway.app.dispose();
    const download = await rig({ pick: 'open', chooses: ['Download'] });
    await click(download, `${HOME}/it's big.log`);
    assert.deepEqual(download.opened, []);
    assert.deepEqual(download.saves, [['C:\\Users\\me\\Desktop', "it's big.log"]]);
    download.app.dispose();
  });

  it('reports a file that cannot be opened', async () => {
    const r = await rig({ pick: 'open', openFails: 'notes.txt does not exist on demo' });
    await click(r, `${HOME}/notes.txt`);
    assert.ok(r.remote.notes.some((note) => note.tone === 'error' && note.text.includes('Could not open notes.txt')));
    r.app.dispose();
  });
});

describe('Rename from the menu', () => {
  it('validates the new name, confirms, renames, and reports it', async () => {
    const r = await rig({ pick: 'rename', rename: 'todo.txt', confirms: [true] }, { existing: [`${HOME}/logs`] });
    await click(r, `${HOME}/notes.txt`);
    const request = r.renames[0];
    assert.equal(request.name, 'notes.txt');
    assert.deepEqual(request.selection, [0, 5]);
    assert.equal(await request.validate('notes.txt'), 'Enter a different name');
    assert.equal(await request.validate('a/b'), 'A name cannot contain /');
    assert.equal(await request.validate('logs'), `"logs" already exists in ${HOME}`);
    assert.equal(await request.validate('todo.txt'), undefined);
    assert.deepEqual(r.confirms, [{ message: 'Rename "notes.txt" to "todo.txt"?', detail: `In ${HOME}`, action: 'Rename' }]);
    assert.deepEqual(r.renamed, [[`${HOME}/notes.txt`, `${HOME}/todo.txt`]]);
    assert.deepEqual(r.remote.notes.at(-1), { tone: 'info', text: 'Renamed "notes.txt" to "todo.txt"' });
    r.app.dispose();
  });

  it('renames nothing when the confirmation is declined or the box is cancelled', async () => {
    const r = await rig({ pick: 'rename', rename: 'todo.txt', confirms: [false] });
    await click(r, `${HOME}/notes.txt`);
    r.script.rename = undefined;
    await sleep(310);
    await click(r, `${HOME}/notes.txt`);
    assert.equal(r.renames.length, 2);
    assert.equal(r.confirms.length, 1);
    assert.deepEqual(r.renamed, []);
    r.app.dispose();
  });
});

describe('Delete from the menu', () => {
  it('asks with the folder\'s file count and deletes only after Delete', async () => {
    const r = await rig({ pick: 'delete', confirms: [true] });
    await click(r, `${HOME}/logs`);
    assert.equal(r.confirms[0].message, 'Delete folder "logs" and its 12 files?');
    assert.match(r.confirms[0].detail, new RegExp(`^${HOME}/logs\\n`));
    assert.equal(r.confirms[0].action, 'Delete');
    assert.deepEqual(r.removed, [`${HOME}/logs`]);
    assert.deepEqual(r.remote.notes.at(-1), { tone: 'info', text: 'Deleted folder "logs" (12 files, 3 subfolders)' });
    r.app.dispose();
  });

  it('says 5000+ when counting stops, and deletes nothing when declined', async () => {
    const r = await rig({ pick: 'delete', confirms: [false] }, { count: { files: 5000, folders: 70, capped: true } });
    await click(r, `${HOME}/logs`);
    assert.equal(r.confirms[0].message, 'Delete folder "logs" and its 5000+ files?');
    assert.deepEqual(r.removed, []);
    r.app.dispose();
  });

  it('asks about a file by name', async () => {
    const r = await rig({ pick: 'delete', confirms: [true] });
    await click(r, `${HOME}/notes.txt`);
    assert.equal(r.confirms[0].message, 'Delete file "notes.txt"?');
    assert.deepEqual(r.removed, [`${HOME}/notes.txt`]);
    assert.deepEqual(r.remote.notes.at(-1), { tone: 'info', text: 'Deleted file "notes.txt"' });
    r.app.dispose();
  });
});
