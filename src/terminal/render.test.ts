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
    assert.match(menu, /Edit the selected connection/);
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

  it('links a file name so a click can download it', () => {
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
      ],
      selected: 1,
      goto: null,
    }, view);
    const row = frame.lines.find((line) => line.plain.includes('README.md'));
    assert.ok(row);
    const link = frame.links.get(row.plain.trimEnd());
    assert.equal(link?.remotePath, '/var/www/README.md');
    assert.equal(link?.kind, 'file');
    assert.equal(row.plain.indexOf('README.md'), link?.start);
    const text = frame.lines.map((line) => line.plain).join('\n');
    assert.match(text, /cmd-click a file to download/);
    assert.match(text, /drop files to upload/);
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
