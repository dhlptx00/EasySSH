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
      command: '/edit',
      items: [{ id: '1', name: 'prod', userHost: 'root@10.0.0.8:22', detail: 'key' }],
    }, view);
    const text = frame.lines.map((line) => line.plain).join('\n');
    assert.match(text, /prod/);
    assert.match(text, /root@10\.0\.0\.8:22/);
    assert.match(text, /~\/Desktop/);
    assert.match(text, /\/edit/);
    assert.match(text, /Easy SSH/);
    assert.match(text, /0\.1\.0/);
    assert.match(text, /╭/);
    assert.ok(frame.cursor);
    assert.match(frame.lines[frame.cursor.row].plain, /> \/edit/);
    const newer = frame.lines.find((line) => line.plain.includes('New connection'));
    const quit = frame.lines.find((line) => line.plain.includes('Quit'));
    assert.ok(newer && quit);
    assert.equal(newer.plain.lastIndexOf('/new') + '/new'.length, quit.plain.lastIndexOf('/quit') + '/quit'.length);
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
    }, view);
    const text = frame.lines.map((line) => line.plain).join('\n');
    assert.match(text, /10\.0\.0\.8/);
    assert.match(text, /host/);
  });
});
