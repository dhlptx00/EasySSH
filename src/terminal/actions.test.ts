import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  actionMenu,
  actionTitle,
  deleteQuestion,
  onlyActions,
  renameProblem,
  renameQuestion,
  renameSelection,
  shortRemote,
  targetSummary,
  terminalCommand,
  uploadDir,
  type ActionTarget,
  type FileAction,
} from './actions';

const file: ActionTarget = { name: 'report.log', path: '/var/log/app/report.log', kind: 'file', size: 48 * 1024 * 1024 };
const folder: ActionTarget = { name: 'logs', path: '/home/demo/project/logs', kind: 'folder' };

describe('action menu', () => {
  it('lists Download first, then View, Edit, Rename, and Delete last under a separator, for a file (no Upload)', () => {
    const menu = actionMenu(file, { downloadLabel: '~/Downloads' });
    assert.equal(menu.title, 'report.log — /var/log/app');
    assert.deepEqual(menu.items.map((item) => item.action ?? '---'), ['download', 'view', 'edit', '---', 'rename', '---', 'delete']);
    assert.deepEqual(menu.items.filter((item) => !item.separator).map((item) => item.icon), ['cloud-download', 'eye', 'edit', 'pencil', 'trash']);
    assert.ok(menu.items.every((item) => item.separator || item.description), 'every action says what it does');
    assert.match(menu.items[0].description ?? '', /~\/Downloads/);
    assert.match(menu.placeholder, /^File · 48 MB/);
  });

  it('has Upload but no View or Edit for a folder, and uploads into the folder itself', () => {
    const menu = actionMenu(folder, { downloadLabel: '~/Downloads', items: 'counting' });
    assert.equal(menu.title, 'logs — /home/demo/project');
    assert.deepEqual(menu.items.map((item) => item.action ?? '---'), ['download', 'upload', '---', 'rename', '---', 'delete']);
    assert.match(menu.items[1].description ?? '', /into \/home\/demo\/project\/logs$/);
    assert.match(menu.placeholder, /^Folder · counting items…/);
    assert.equal(uploadDir(folder), '/home/demo/project/logs');
    assert.equal(uploadDir(file), '/var/log/app');
  });

  it('summarizes size, item count and the modified time', () => {
    const mtime = new Date(2026, 8, 30, 14, 2).getTime();
    const now = new Date(2026, 9, 4).getTime();
    assert.equal(targetSummary({ ...file, size: 2048, mtime }, undefined, now), 'File · 2 KB · modified Sep 30 14:02 — Enter downloads');
    assert.equal(targetSummary(folder, 12), 'Folder · 12 items — Enter downloads');
    assert.equal(targetSummary(folder, 1), 'Folder · 1 item — Enter downloads');
    assert.equal(targetSummary(folder, 0), 'Folder · empty — Enter downloads');
    assert.match(targetSummary({ ...folder, linkTarget: '/srv/logs' }, 3), /^Folder link → \/srv\/logs · 3 items/);
    assert.equal(actionTitle({ name: 'etc', path: '/etc', kind: 'folder' }), 'etc — /');
  });

  it('drops actions a session cannot do without leaving stray separators', () => {
    const menu = actionMenu(file, { downloadLabel: '~' });
    const only = (can: FileAction[]) => onlyActions(menu.items, new Set(can)).map((item) => item.action ?? '---');
    assert.deepEqual(only(['download', 'view']), ['download', 'view']);
    assert.deepEqual(only(['download', 'delete']), ['download', '---', 'delete']);
    assert.deepEqual(only(['download', 'upload', 'view', 'edit', 'rename', 'delete']), ['download', 'view', 'edit', '---', 'rename', '---', 'delete']);
  });
});

describe('rename', () => {
  it('selects the name without its extension, or the whole name', () => {
    assert.deepEqual(renameSelection('report.log', 'file'), [0, 6]);
    assert.deepEqual(renameSelection('archive.tar.gz', 'file'), [0, 11]);
    assert.deepEqual(renameSelection('.bashrc', 'file'), [0, 7]);
    assert.deepEqual(renameSelection('Makefile', 'file'), [0, 8]);
    assert.deepEqual(renameSelection('my.folder', 'folder'), [0, 9]);
  });

  it('refuses empty names, slashes, dot names, and the same name', () => {
    assert.equal(renameProblem('', 'a.txt'), 'Enter a name');
    assert.equal(renameProblem('   ', 'a.txt'), 'Enter a name');
    assert.equal(renameProblem('x/y', 'a.txt'), 'A name cannot contain /');
    assert.equal(renameProblem('..', 'a.txt'), '".." is not a valid name');
    assert.equal(renameProblem('a.txt', 'a.txt'), 'Enter a different name');
    assert.equal(renameProblem('b.txt', 'a.txt'), undefined);
    assert.equal(renameProblem('my notes.txt', 'a.txt'), undefined);
  });

  it('asks with both names', () => {
    assert.deepEqual(renameQuestion({ name: 'a.txt', path: '/srv/a.txt', kind: 'file' }, 'b.txt'), { message: 'Rename "a.txt" to "b.txt"?', detail: 'In /srv' });
  });
});

describe('delete confirmation', () => {
  it('names a file and its full path', () => {
    const question = deleteQuestion(file);
    assert.equal(question.message, 'Delete file "report.log"?');
    assert.match(question.detail, /^\/var\/log\/app\/report\.log\n/);
    assert.match(question.detail, /cannot be undone/);
  });

  it('counts a folder\'s files and subfolders, and says 5000+ when counting stopped', () => {
    assert.equal(deleteQuestion(folder, { files: 12, folders: 3, capped: false }).message, 'Delete folder "logs" and its 12 files?');
    assert.match(deleteQuestion(folder, { files: 12, folders: 3, capped: false }).detail, /Contains 12 files in 3 subfolders\./);
    assert.equal(deleteQuestion(folder, { files: 1, folders: 0, capped: false }).message, 'Delete folder "logs" and its 1 file?');
    assert.equal(deleteQuestion(folder, { files: 5000, folders: 40, capped: true }).message, 'Delete folder "logs" and its 5000+ files?');
    assert.match(deleteQuestion(folder, { files: 5000, folders: 40, capped: true }).detail, /5000\+ files in 40\+ subfolders/);
    assert.equal(deleteQuestion(folder, { files: 0, folders: 0, capped: false }).message, 'Delete empty folder "logs"?');
    assert.equal(deleteQuestion(folder).message, 'Delete folder "logs" and everything in it?');
  });

  it('deletes only the link for a symlink', () => {
    const question = deleteQuestion({ ...folder, linkTarget: '/srv/logs' });
    assert.equal(question.message, 'Delete link "logs"?');
    assert.match(question.detail, /Only the link is deleted/);
  });
});

describe('view and edit command lines', () => {
  it('quotes the absolute path for the shell', () => {
    assert.equal(terminalCommand('view', '/home/demo/project/notes.txt', 'bash'), "cat '/home/demo/project/notes.txt'");
    assert.equal(terminalCommand('edit', "/srv/it's here.txt", 'zsh'), "vi '/srv/it'\\''s here.txt'");
    assert.equal(terminalCommand('edit', "/srv/it's here.txt", 'fish'), "vi '/srv/it\\'s here.txt'");
    assert.equal(terminalCommand('view', '/tmp/$(rm -rf ~).txt', 'bash'), "cat '/tmp/$(rm -rf ~).txt'");
  });

  it('shortens a long remote folder for a button', () => {
    assert.equal(shortRemote('/home/demo/project'), '/home/demo/project');
    assert.equal(shortRemote('/srv/very/long/path/to/some/deeply/nested/project'), '…/project');
  });
});
