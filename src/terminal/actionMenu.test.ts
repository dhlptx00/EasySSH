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
];

interface Script {
  /** The menu choice. */
  pick?: FileAction;
  save?: string;
  parent?: string;
  uploads?: string[];
  rename?: string;
  /** Answers to confirm(), in order. Missing answers are false. */
  confirms?: boolean[];
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
  focused: number;
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
    focused: 0,
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
    focusTerminal: () => {
      state.focused += 1;
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
    assert.deepEqual(r.menus[0].items.map((item) => item.action ?? '---'), ['download', 'view', 'edit', '---', 'rename', '---', 'delete']);
    assert.deepEqual(r.remote.downloads, []);
    assert.deepEqual(r.downloadsTo, []);
    assert.deepEqual(r.remote.written.filter((line) => !line.includes('PROMPT')), []);
    r.app.dispose();
  });

  it('counts a folder\'s items for the placeholder and offers Upload but no View or Edit', async () => {
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
    assert.deepEqual(links.map((link) => link.tooltip).sort(), ['Folder logs: download, upload into, rename, delete', 'notes.txt: download, view, edit, rename, delete']);
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

describe('View and Edit from the menu', () => {
  it('types cat or vi with the quoted absolute path at the prompt', async () => {
    const r = await rig({ pick: 'view' });
    await click(r, `${HOME}/notes.txt`);
    assert.equal(r.remote.written.at(-1), `cat '${HOME}/notes.txt'\r`);
    assert.equal(r.focused, 1);
    r.remote.push(`hello\r\n\x1b]7;${HOME}\x07$ `);
    await flush();
    r.script.pick = 'edit';
    await sleep(310);
    await click(r, `${HOME}/notes.txt`);
    assert.equal(r.remote.written.at(-1), `vi '${HOME}/notes.txt'\r`);
    r.app.dispose();
  });

  it('asks before printing a big file', async () => {
    const r = await rig({ pick: 'view', confirms: [false] });
    await click(r, `${HOME}/it's big.log`);
    assert.match(r.confirms[0].message, /^Print all 30 MB of "it's big\.log" in the terminal\?$/);
    assert.ok(!r.remote.written.some((line) => line.startsWith('cat ')));
    r.app.dispose();
    const yes = await rig({ pick: 'view', confirms: [true] });
    await click(yes, `${HOME}/it's big.log`);
    assert.equal(yes.remote.written.at(-1), `cat '${HOME}/it'\\''s big.log'\r`);
    yes.app.dispose();
  });

  it('types nothing while a full-screen program runs or text is typed at the prompt', async () => {
    const r = await rig({ pick: 'edit' });
    // A program started (e.g. top) while the menu was open.
    r.script.pick = undefined;
    const menuHost = r.app as unknown as { host: AppHost };
    const show = menuHost.host.showActionMenu;
    menuHost.host.showActionMenu = async (menu, update) => {
      await show?.(menu, update);
      r.remote.push('\x1b[?1049h');
      return 'edit';
    };
    await click(r, `${HOME}/notes.txt`);
    menuHost.host.showActionMenu = show;
    r.script.pick = 'edit';
    assert.ok(!r.remote.written.some((line) => line.startsWith('vi ')));
    assert.match(r.remote.notes.at(-1)?.text ?? '', /A program is running in the terminal/);
    r.remote.push(`\x1b[?1049l\x1b]7;${HOME}\x07$ `);
    await flush();
    r.app.onRawInput('ls -');
    await sleep(60);
    await sleep(300);
    await click(r, `${HOME}/notes.txt`);
    assert.ok(!r.remote.written.some((line) => line.startsWith('vi ')));
    assert.match(r.remote.notes.at(-1)?.text ?? '', /Text is typed at the terminal prompt/);
    r.app.dispose();
  });

  it('asks before typing while an earlier command has not returned to the prompt', async () => {
    const r = await rig({ pick: 'view', confirms: [false] });
    r.app.onRawInput('tail -f x.log\r');
    await sleep(60);
    await click(r, `${HOME}/notes.txt`);
    assert.match(r.confirms[0].message, /"tail -f x\.log" may still be running/);
    assert.equal(r.confirms[0].action, 'Send Anyway');
    assert.ok(!r.remote.written.some((line) => line.startsWith('cat ')));
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
