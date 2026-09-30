import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrowseEntry } from '../types';
import { render } from './render';
import { emptyDraft } from './wizard';

const view = {
  cols: 80,
  rows: 24,
  downloadFolder: '/Users/me/Desktop',
  home: '/Users/me',
  clickHint: 'cmd-click a file to download',
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

  it('shows Linux output in a box and links a file name', () => {
    const file: BrowseEntry = {
      name: 'README.md',
      path: '/var/www/README.md',
      kind: 'file',
      size: 1200,
      mtime: Date.parse('2026-09-29T18:10:00'),
    };
    const frame = render({
      kind: 'browse',
      title: 'prod',
      userHost: 'root@10.0.0.8:22',
      cwd: '/var/www',
      entries: [
        { name: '..', path: '/var', kind: 'dir', size: 0, mtime: 0 },
        file,
        { name: 'secret-list-only', path: '/var/www/secret-list-only', kind: 'file', size: 1, mtime: 0 },
      ],
      selected: 1,
      command: '',
      output: 'README.md\nnotes',
    }, view);
    const text = frame.lines.map((line) => line.plain).join('\n');
    assert.match(text, /README\.md/);
    assert.doesNotMatch(text, /secret-list-only/);
    assert.doesNotMatch(text, /4 KB/);
    const hintAt = frame.lines.findIndex((line) => line.plain.includes('Click a file name'));
    const outputAt = frame.lines.findIndex((line) => line.plain.includes('README.md'));
    assert.ok(hintAt > 0 && hintAt < outputAt);
    assert.match(frame.lines[hintAt - 1].plain, /╭/);
    assert.ok(frame.lines[hintAt - 1].plain.indexOf('╭') > 0);
    assert.match(frame.lines[hintAt].plain, /│/);
    const hint = text.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');
    assert.match(hint, /Click a file name to download it to the Desktop/);
    assert.match(hint, /Drag a folder here to upload it into this directory/);
    const row = frame.lines[outputAt];
    const link = frame.links.get(row.plain.trimEnd())?.[0];
    assert.equal(link?.remotePath, '/var/www/README.md');
    assert.equal(link?.kind, 'file');
    assert.equal(row.plain.indexOf('README.md'), link?.start);
    assert.ok(frame.cursor);
    assert.match(frame.lines[frame.cursor.row].plain, /\$ /);
  });

  it('underlines a file name on hover and shows a pressed click', () => {
    const file: BrowseEntry = {
      name: 'README.md',
      path: '/var/www/README.md',
      kind: 'file',
      size: 1200,
      mtime: Date.parse('2026-09-29T18:10:00'),
    };
    const base = {
      kind: 'browse' as const,
      title: 'prod',
      userHost: 'root@10.0.0.8:22',
      cwd: '/var/www',
      entries: [file],
      selected: 0,
      command: '',
      output: 'README.md',
    };
    const hover = render({ ...base, hoverPath: file.path }, view);
    const hovered = hover.lines.find((line) => line.plain.includes('README.md'));
    assert.ok(hovered);
    assert.match(hovered.styled, /\x1b\[4m/);
    const pressed = render({ ...base, pressedPath: file.path }, view);
    const row = pressed.lines.find((line) => line.plain.includes('README.md'));
    assert.ok(row);
    assert.match(row.styled, /48;2;48;48;48/);
    assert.match(row.plain, /README\.md/);
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

    const shell = render({
      kind: 'browse',
      title: 'prod',
      userHost: 'root@10.0.0.8:22',
      cwd: '/var/www',
      entries: [],
      selected: 0,
      command: '',
      output: 'README.md',
    }, wide);
    const shellBar = shell.lines[0].plain.trim();
    assert.ok(shellBar.startsWith('╭') && shellBar.length >= 150);
    assert.ok(shell.cursor);
    assert.ok(shell.lines[shell.cursor.row - 1].plain.trim().length >= 150);
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
});
