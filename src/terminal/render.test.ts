import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrowseEntry } from '../types';
import { nameSpans, render } from './render';
import { emptyDraft } from './wizard';

const view = {
  cols: 80,
  rows: 24,
  downloadFolder: '/Users/me/Desktop',
  home: '/Users/me',
};

describe('terminal screen', () => {
  it('lists connections and the download folder', () => {
    const frame = render({
      kind: 'connections',
      selected: 0,
      command: '',
      pick: 0,
      items: [{ id: '1', name: 'prod', userHost: 'root@10.0.0.8:22', detail: 'key' }],
    }, view);
    const text = frame.lines.map((line) => line.plain).join('\n');
    assert.match(text, /prod/);
    assert.match(text, /root@10\.0\.0\.8:22/);
    assert.match(text, /~\/Desktop/);
    assert.match(text, /\/prod/);
    assert.match(text, /Connections/);
    assert.match(text, /Commands/);
    assert.match(text, /Easy SSH/);
    assert.match(text, /0\.1\.0/);
    assert.match(text, /╭/);
    assert.ok(frame.cursor);
    assert.match(frame.lines[frame.cursor.row].plain, /> /);
    const newer = frame.lines.find((line) => line.plain.includes('New connection'));
    const quit = frame.lines.find((line) => line.plain.includes('Quit'));
    assert.ok(newer && quit);
    assert.equal(newer.plain.lastIndexOf('/new') + '/new'.length, quit.plain.lastIndexOf('/quit') + '/quit'.length);
  });

  it('opens a slash menu above the prompt and filters it', () => {
    const open = render({
      kind: 'connections',
      selected: 0,
      command: '/',
      pick: 0,
      items: [{ id: '1', name: 'prod', userHost: 'root@10.0.0.8:22', detail: 'key' }],
    }, view);
    const selected = open.lines.find((line) => line.plain.includes('> /prod'));
    assert.ok(selected);
    assert.match(selected.plain, /root@10\.0\.0\.8:22/);
    assert.match(selected.styled, /48;2;48;48;48/);
    const text = open.lines.map((line) => line.plain).join('\n');
    assert.match(text, /Connections/);
    assert.match(text, /Commands/);
    assert.match(text, /\/new/);
    assert.match(text, /Add a connection/);
    assert.match(text, /Close the terminal/);
    assert.ok(open.cursor);
    assert.match(open.lines[open.cursor.row].plain, /> \//);
    assert.doesNotMatch(open.lines[open.cursor.row].plain, /> \/new/);

    const filtered = render({
      kind: 'connections',
      selected: 0,
      command: '/ed',
      pick: 0,
      items: [{ id: '1', name: 'prod', userHost: 'root@10.0.0.8:22', detail: 'key' }],
    }, view);
    const menu = filtered.lines.map((line) => line.plain).join('\n');
    assert.match(menu, /> \/edit/);
    assert.match(menu, /Choose a connection to edit/);
    assert.match(menu, /Commands/);
    assert.doesNotMatch(menu, /Add a connection/);
    assert.doesNotMatch(menu, /> \/prod/);
  });

  it('renders a choice step as a picker and a typed step in the prompt', () => {
    const auth = render({
      kind: 'wizard',
      title: 'new connection',
      draft: { ...emptyDraft(), name: 'prod', host: '10.0.0.8', port: '22', username: 'root' },
      step: 'auth',
      input: '',
      pick: 1,
    }, view);
    const authText = auth.lines.map((line) => line.plain).join('\n');
    assert.match(authText, /New connection/);
    assert.match(authText, /> Private key/);
    assert.match(authText, /Password/);
    assert.match(authText, /SSH agent/);
    assert.equal(auth.cursor, undefined);
    assert.match(authText, /╭/);

    const typed = render({
      kind: 'wizard',
      title: 'new connection',
      draft: emptyDraft(),
      step: 'host',
      input: '10.0.0.8',
      pick: 0,
    }, view);
    const typedText = typed.lines.map((line) => line.plain).join('\n');
    assert.match(typedText, /10\.0\.0\.8/);
    assert.match(typedText, /host/);
    assert.ok(typed.cursor);
    assert.match(typed.lines[typed.cursor.row].plain, /> 10\.0\.0\.8/);
  });

  it('lists connections before edit or delete', () => {
    const items = [
      { id: '1', name: 'prod', userHost: 'root@10.0.0.8:22', detail: 'key' },
      { id: '2', name: 'beta', userHost: 'admin@10.0.0.9:22', detail: 'password' },
    ];
    const frame = render({ kind: 'pick', mode: 'edit', items, selected: 1 }, view);
    const text = frame.lines.map((line) => line.plain).join('\n');
    assert.match(text, /Edit connection/);
    assert.match(text, /prod/);
    assert.match(text, /beta/);
    assert.match(text, /admin@10\.0\.0\.9:22/);
    const selected = frame.lines.find((line) => line.plain.includes('beta'));
    assert.match(selected?.styled ?? '', /48;2;48;48;48/);
    assert.doesNotMatch(text, /Delete beta\?/);
  });

  it('grows each page with the terminal', () => {
    const wide = { ...view, cols: 160, rows: 40 };
    const home = render({
      kind: 'connections',
      selected: 0,
      command: '',
      pick: 0,
      items: [{ id: '1', name: 'prod', userHost: 'root@10.0.0.8:22', detail: 'key' }],
    }, wide);
    assert.ok(home.cursor);
    const homeBar = home.lines[0].plain.trim();
    assert.ok(homeBar.startsWith('╭') && homeBar.endsWith('╮'));
    assert.ok(homeBar.length >= 150);
    const promptTop = home.cursor.row - 1;
    let cardBottom = -1;
    for (let index = 0; index < promptTop; index += 1) {
      if (home.lines[index].plain.includes('╰')) cardBottom = index;
    }
    assert.equal(promptTop - cardBottom, 2);
    assert.ok(home.lines[promptTop].plain.trim().length >= 150);

    const wizard = render({
      kind: 'wizard',
      title: 'new connection',
      draft: emptyDraft(),
      step: 'host',
      input: '',
      pick: 0,
    }, wide);
    assert.ok(wizard.lines[0].plain.trim().startsWith('╭'));
    assert.ok(wizard.lines[0].plain.trim().length >= 150);
  });

  it('shows the wizard prompt', () => {
    const frame = render({
      kind: 'wizard',
      title: 'new connection',
      draft: emptyDraft(),
      step: 'host',
      input: '10.0.0.8',
      pick: 0,
    }, view);
    const text = frame.lines.map((line) => line.plain).join('\n');
    assert.match(text, /10\.0\.0\.8/);
    assert.match(text, /host/);
  });

  it('links ls names and leaves a user@host prompt alone', () => {
    const entries: BrowseEntry[] = [
      { name: 'root', path: '/var/root', kind: 'dir', size: 0, mtime: 0 },
      { name: 'notes', path: '/var/notes', kind: 'file', size: 1, mtime: 0 },
    ];
    assert.deepEqual(nameSpans('root@host:~$ ', entries).map((link) => link.remotePath), []);
    assert.deepEqual(nameSpans('notes@ notes', entries).map((link) => link.remotePath), ['/var/notes', '/var/notes']);
  });
});
