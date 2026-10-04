import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrowseEntry } from '../types';
import { homeTips, nameSpans, render, type Frame } from './render';
import type { ConnectionItem, Screen } from './screen';
import { DARK, LIGHT, mix, type PaintTheme } from './theme';
import { emptyDraft } from './wizard';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const packageVersion: string = (require('../../package.json') as { version: string }).version;

const now = Date.UTC(2026, 9, 4, 12, 0, 0);
const view = {
  cols: 100,
  rows: 30,
  downloadFolder: '/Users/me/Downloads',
  home: '/Users/me',
  now,
  tip: 0,
  click: 'Ctrl+click',
};

const items: ConnectionItem[] = [
  { id: 'b', name: 'bastion', userHost: 'dev@bastion.example.com:22', detail: 'key', auth: 'privateKey', lastUsed: now - 3 * 86400e3 },
  { id: 'd', name: 'dev-box', userHost: 'dev@dev-box.example.com:22', detail: 'password', auth: 'password' },
  { id: 'p', name: 'prod-web', userHost: 'deploy@prod-web.example.com:22', detail: 'key', auth: 'privateKey', lastUsed: now - 2 * 3600e3 },
  { id: 's', name: 'staging-db', userHost: 'dev@staging-db.example.com:22', detail: 'agent via bastion', auth: 'agent', via: 'bastion', lastUsed: now - 26 * 3600e3 },
];

function home(selected = 2, command = ''): Screen {
  return { kind: 'connections', items, selected, command, pick: 0 };
}

function text(frame: Frame): string {
  return frame.lines.map((line) => line.plain).join('\n');
}

function rgb(color: readonly number[]): string {
  return color.join(';');
}

describe('terminal screen', () => {
  it('shows the brand mark, the Recent line, the table and the footer hints', () => {
    const frame = render(home(), { ...view, cols: 120 });
    const shown = text(frame);
    assert.ok(shown.includes(`Easy SSH  ${packageVersion}`), 'wordmark with the package.json version');
    assert.match(shown, />_/);
    assert.doesNotMatch(shown, /·····/, 'the old dotted logo is gone');
    assert.match(shown, /Last: prod-web · deploy@prod-web\.example\.com · 2 h ago — Enter to reconnect/);
    const header = frame.lines.find((line) => /NAME\s+HOST\s+AUTH\s+LAST USED/.test(line.plain));
    assert.ok(header, 'column headers');
    const row = frame.lines.find((line) => line.plain.includes('staging-db') && line.plain.includes('/staging-db'));
    assert.ok(row);
    assert.match(row.plain, /dev@staging-db\.example\.com:22\s+agent via bastion\s+1 d ago\s+\/staging-db/);
    const never = frame.lines.find((line) => line.plain.includes('dev-box') && line.plain.includes('password'));
    assert.match(never?.plain ?? '', /—/);
    assert.match(shown, /\/new New · \/edit Edit · \/delete Delete · \/import Import · ↑↓ Select · Enter Connect · \/quit\s+│/);
    assert.doesNotMatch(shown, /Commands/);
    assert.doesNotMatch(shown, /download →/);
    assert.ok(frame.cursor);
    assert.match(frame.lines[frame.cursor.row].plain, /> /);
    assert.match(frame.lines[frame.cursor.row].plain, /Tip: Ctrl\+click a file name to download, open, rename or delete it/);
  });

  it('aligns the columns and paints the selected row as a full-width bar', () => {
    const frame = render(home(2), view);
    const rows = frame.lines.filter((line) => /bastion\.example|dev-box\.example|prod-web\.example|staging-db\.example/.test(line.plain) && !line.plain.includes('Last:') && !/Host {2,}/.test(line.plain));
    assert.equal(rows.length, 4);
    const hostColumn = rows.map((line) => line.plain.indexOf('@') - line.plain.slice(0, line.plain.indexOf('@')).split(' ').pop()!.length);
    assert.equal(new Set(hostColumn).size, 1, 'hosts start in one column');
    const selected = rows.find((line) => line.plain.includes('prod-web.example'));
    assert.ok(selected);
    assert.match(selected.plain, /› prod-web/);
    const bar = `48;2;${rgb(DARK.selection)}`;
    // The bar runs from the card's left padding to its right padding.
    assert.ok(selected.styled.split(bar).length > 6, 'every piece of the row is on the bar');
    const other = rows.find((line) => line.plain.includes('dev-box.example'));
    assert.ok(other && !other.styled.includes(bar));
  });

  it('colors sign-in methods: key green, password yellow, agent cyan', () => {
    const frame = render(home(0), view);
    const line = (name: string) => frame.lines.find((row) => row.plain.includes(`${name}.example`) && !row.plain.includes('Last:'))?.styled ?? '';
    assert.ok(line('dev-box').includes(`38;2;${rgb(DARK.fg.warn)}`));
    assert.ok(line('prod-web').includes(`38;2;${rgb(DARK.fg.success)}`));
    assert.ok(line('staging-db').includes(`38;2;${rgb(DARK.fg.info)}`));
  });

  it('hides the Recent line when nothing was used and invites /new when empty', () => {
    const unused = items.map((item) => ({ ...item, lastUsed: undefined }));
    assert.doesNotMatch(text(render({ kind: 'connections', items: unused, selected: 0, command: '', pick: 0 }, view)), /Last:/);
    const empty = text(render({ kind: 'connections', items: [], selected: 0, command: '', pick: 0 }, view));
    assert.match(empty, /Start with \/new or \/import/);
    assert.doesNotMatch(empty, /\/delete Delete/);
  });

  it('drops columns and wraps the hints in a narrow terminal', () => {
    const narrow = render(home(1), { ...view, cols: 54, rows: 28 });
    const shown = text(narrow);
    assert.ok(narrow.lines.every((line) => line.plain.length === 54));
    assert.doesNotMatch(shown, /LAST USED/);
    assert.doesNotMatch(shown, /\/staging-db\s*│/);
    assert.match(shown, /NAME\s+HOST/);
    assert.match(shown, /Last: prod-web · 2 h ago/);
    const hintRows = narrow.lines.filter((line) => /\/new New|\/quit|↑↓ Select/.test(line.plain));
    assert.ok(hintRows.length >= 2, 'hints wrap onto more lines');
    const small = text(render(home(1), { ...view, cols: 34, rows: 24 }));
    assert.match(small, /dev@bastion…/);
    const tiny = text(render(home(1), { ...view, cols: 26, rows: 24 }));
    assert.match(tiny, /prod-web/);
    assert.doesNotMatch(tiny, /HOST/);
  });

  it('truncates long names and hosts with an ellipsis', () => {
    const long: ConnectionItem[] = [{
      id: 'x',
      name: 'a-very-long-connection-name-for-testing',
      userHost: 'someone@an-extremely-long-host-name.internal.example.com:2222',
      detail: 'key',
      auth: 'privateKey',
    }];
    const shown = text(render({ kind: 'connections', items: long, selected: 0, command: '', pick: 0 }, { ...view, cols: 80 }));
    assert.match(shown, /a-very-long-connection-…/);
    assert.match(shown, /someone@an-extremely-long-host-name\.inter…/);
    assert.match(shown, /…/);
  });

  it('opens a slash menu with the palette selection bar', () => {
    const open = render(home(2, '/'), view);
    const selected = open.lines.find((line) => line.plain.includes('› /bastion'));
    assert.ok(selected);
    assert.ok(selected.styled.includes(`48;2;${rgb(DARK.selection)}`));
    const shown = text(open);
    assert.match(shown, /Connections/);
    assert.match(shown, /Commands/);
    assert.match(shown, /\/folder/);
    assert.doesNotMatch(shown, /\/theme/);
    assert.match(shown, /Close the terminal/);
    const filtered = text(render(home(2, '/ed'), view));
    assert.match(filtered, /› \/edit/);
    assert.doesNotMatch(filtered, /Add a connection/);
  });

  it('paints every screen only in the active palette, on the terminal background', () => {
    const screens: Screen[] = [
      home(2),
      home(2, '/'),
      { kind: 'connections', items, selected: 2, command: '', pick: 0, notice: { tone: 'ok', text: 'Imported 2 hosts' } },
      { kind: 'connections', items: [], selected: 0, command: '', pick: 0 },
      { kind: 'wizard', title: 'new connection', draft: emptyDraft(), step: 'host', input: 'x', pick: 0 },
      { kind: 'wizard', title: 'new connection', draft: emptyDraft(), step: 'port', input: 'x', pick: 0, error: 'Port must be a number, such as 22' },
      { kind: 'wizard', title: 'new connection', draft: emptyDraft(), step: 'auth', input: '', pick: 1 },
      { kind: 'summary', mode: 'new', title: 'new connection', draft: { ...emptyDraft(), name: 'a', host: 'h', username: 'u', auth: 'agent', jumpMode: 'none' }, choice: 7, test: { ok: true, text: 'Connected' } },
      { kind: 'summary', mode: 'edit', title: 'edit a', draft: { ...emptyDraft(), name: 'a', host: 'h', username: 'u', auth: 'agent', jumpMode: 'none' }, choice: 1, test: { ok: false, text: 'Could not resolve the host' } },
      { kind: 'pick', mode: 'edit', items, selected: 1 },
      { kind: 'confirm', item: items[1], choice: 1 },
    ];
    for (const palette of [DARK, LIGHT]) {
      const theme: PaintTheme = { palette, depth: 'truecolor' };
      const badge = Array.from({ length: 7 }, (_, index) => rgb(mix(palette.badgeFrom, palette.badgeTo, index / 6)));
      const backgrounds = new Set([rgb(palette.selection), rgb(palette.danger), ...badge]);
      const foregrounds = new Set([...Object.values(palette.fg).map(rgb), '255;255;255']);
      for (const screen of screens) {
        const styled = render(screen, { ...view, theme }).lines.map((line) => line.styled).join('');
        for (const [, color] of styled.matchAll(/48;2;(\d+;\d+;\d+)/g)) {
          assert.ok(backgrounds.has(color), `${palette.name} ${screen.kind}: background ${color} is the selection, the delete tint or the badge`);
        }
        for (const [, color] of styled.matchAll(/38;2;(\d+;\d+;\d+)/g)) {
          assert.ok(foregrounds.has(color), `${palette.name} ${screen.kind}: text color ${color} is from the palette`);
        }
      }
      const prompt = render(home(2), { ...view, theme });
      assert.ok(prompt.cursor);
      assert.ok(prompt.lines[prompt.cursor.row].styled.includes(`38;2;${rgb(palette.fg.accent)}`), 'the > prompt is in the accent');
    }
  });

  it('uses 256-color codes when asked', () => {
    const styled = render(home(2), { ...view, theme: { palette: DARK, depth: '256' } }).lines.map((line) => line.styled).join('');
    assert.doesNotMatch(styled, /[34]8;2;/);
    assert.match(styled, /48;5;\d+/);
  });

  it('rotates the tips and skips one that does not fit', () => {
    const tips = homeTips('Cmd+click', '~/Downloads');
    assert.match(tips[0], /^Cmd\+click a file name/);
    const second = render(home(2), { ...view, tip: 1 });
    assert.ok(second.cursor);
    assert.match(second.lines[second.cursor.row].plain, /Tip: Drag files onto the terminal to upload them/);
    const typing = render(home(2, 'abc'), view);
    assert.ok(typing.cursor);
    assert.doesNotMatch(typing.lines[typing.cursor.row].plain, /Tip:/);
  });

  it('shows a wizard step with a header, a field box, help and inline errors', () => {
    const frame = render({
      kind: 'wizard',
      title: 'new connection',
      draft: { ...emptyDraft(), name: 'prod-api' },
      step: 'host',
      input: 'prod-api.example.com',
      pick: 0,
    }, view);
    const shown = text(frame);
    assert.match(shown, /New connection\s+Step 2 of 6/);
    assert.match(shown, /╭─ Host ─/);
    assert.match(shown, /│ prod-api\.example\.com/);
    assert.match(shown, /Hostname or IP address of the server/);
    assert.match(shown, /So far {2}prod-api/);
    assert.match(shown, /Enter Next · Esc Back · Ctrl\+C Cancel/);
    assert.ok(frame.cursor, 'the cursor sits in the field box');
    assert.match(frame.lines[frame.cursor.row].plain, /│ prod-api\.example\.com/);
    assert.equal(frame.lines[frame.cursor.row].plain[frame.cursor.col - 1], ' ');
    assert.equal(frame.lines[frame.cursor.row].plain[frame.cursor.col - 2], 'm');

    const error = render({
      kind: 'wizard',
      title: 'new connection',
      draft: { ...emptyDraft(), name: 'prod-api', host: 'h' },
      step: 'port',
      input: '22x',
      pick: 0,
      error: 'Port must be a number, such as 22',
    }, view);
    const errorLine = error.lines.find((line) => line.plain.includes('Port must be a number'));
    assert.ok(errorLine);
    assert.match(errorLine.plain, /✗ Port must be a number/);
    assert.ok(errorLine.styled.includes(`38;2;${rgb(DARK.fg.error)}`));
  });

  it('masks typed passwords and picks choices inside the box', () => {
    const secret = text(render({ kind: 'wizard', title: 'new connection', draft: { ...emptyDraft(), auth: 'password', passwordMode: 'save' }, step: 'password', input: 'hunter2', pick: 0 }, view));
    assert.doesNotMatch(secret, /hunter2/);
    assert.match(secret, /•••••••/);
    const choice = render({ kind: 'wizard', title: 'new connection', draft: emptyDraft(), step: 'auth', input: '', pick: 1 }, view);
    const shown = text(choice);
    assert.match(shown, /╭─ Sign-in method/);
    assert.match(shown, /› Private key/);
    assert.match(shown, /↑↓ Choose/);
    assert.equal(choice.cursor, undefined);
  });

  it('summarises a draft with the ssh command, Test connection, Save and Back', () => {
    const draft = {
      ...emptyDraft(),
      name: 'prod-api',
      host: 'prod-api.example.com',
      port: '2222',
      username: 'deploy',
      auth: 'privateKey' as const,
      keyPath: '/Users/me/.ssh/id_ed25519',
      passphrase: 'very secret',
      jumpMode: 'custom' as const,
      jump: 'dev@bastion.example.com',
    };
    const frame = render({ kind: 'summary', mode: 'new', title: 'new connection', draft, choice: 7, test: { ok: false, text: 'Test failed: Authentication failed' } }, { ...view, cols: 120 });
    const shown = text(frame);
    assert.match(shown, /Name\s+prod-api/);
    assert.match(shown, /Sign-in\s+Key ~\/\.ssh\/id_ed25519 · new passphrase/);
    assert.doesNotMatch(shown, /very secret/);
    assert.match(shown, /\$ ssh -p 2222 -i ~\/\.ssh\/id_ed25519 -J dev@bastion\.example\.com deploy@prod-api\.example\.com/);
    assert.match(shown, /✗ Test failed: Authentication failed/);
    assert.match(shown, /› Save/);
    assert.match(shown, /Test connection/);
    assert.match(shown, /Back/);
  });

  it('lists the fields to change for /edit', () => {
    const draft = { ...emptyDraft(), name: 'prod', host: 'h', username: 'u', auth: 'password' as const, passwordMode: 'save' as const, keepPassword: true, hasSavedPassword: true };
    const shown = text(render({ kind: 'summary', mode: 'edit', title: 'edit prod', draft, choice: 4 }, view));
    assert.match(shown, /Edit prod\s+Choose a field/);
    assert.match(shown, /› Sign-in\s+Password \(saved\)\s+Enter to change/);
  });

  it('asks before delete in red with the name and host', () => {
    const frame = render({ kind: 'confirm', item: items[3], choice: 1 }, view);
    const shown = text(frame);
    assert.match(shown, /✗ Delete staging-db\?/);
    assert.match(shown, /Host\s+dev@staging-db\.example\.com:22/);
    assert.match(shown, /agent via bastion/);
    const title = frame.lines.find((line) => line.plain.includes('Delete staging-db?'));
    assert.ok(title?.styled.includes(`38;2;${rgb(DARK.fg.error)}`));
    const yes = frame.lines.find((line) => line.plain.includes('Yes, delete'));
    assert.ok(yes?.styled.includes(`48;2;${rgb(DARK.danger)}`), 'the chosen Yes is on a red bar');
    const border = frame.lines[0].styled;
    assert.ok(border.includes(`38;2;${rgb(DARK.fg.error)}`), 'red border');
  });

  it('lists connections before edit or delete', () => {
    const frame = render({ kind: 'pick', mode: 'edit', items, selected: 1 }, view);
    const shown = text(frame);
    assert.match(shown, /Edit connection/);
    const selected = frame.lines.find((line) => line.plain.includes('› dev-box'));
    assert.ok(selected?.styled.includes(`48;2;${rgb(DARK.selection)}`));
  });

  it('grows each page with the terminal', () => {
    const wide = { ...view, cols: 160, rows: 40 };
    const page = render(home(), wide);
    assert.ok(page.cursor);
    const bar = page.lines[0].plain.trim();
    assert.ok(bar.startsWith('╭') && bar.endsWith('╮'));
    assert.ok(bar.length >= 150);
    const promptTop = page.cursor.row - 1;
    let cardBottom = -1;
    for (let index = 0; index < promptTop; index += 1) if (page.lines[index].plain.includes('╰')) cardBottom = index;
    assert.equal(promptTop - cardBottom, 2);
    const wizard = render({ kind: 'wizard', title: 'new connection', draft: emptyDraft(), step: 'host', input: '', pick: 0 }, wide);
    assert.ok(wizard.lines[0].plain.trim().length >= 150);
  });

  it('links ls names and leaves a user@host prompt alone', () => {
    const entries: BrowseEntry[] = [
      { name: 'root', path: '/var/root', kind: 'dir', size: 0, mtime: 0 },
      { name: 'notes', path: '/var/notes', kind: 'file', size: 1, mtime: 0 },
    ];
    assert.deepEqual(nameSpans('root@host:~$ ', entries).map((link) => link.remotePath), []);
    assert.deepEqual(nameSpans('notes@ notes', entries).map((link) => link.remotePath), ['/var/notes', '/var/notes']);
  });

  describe('vertical layout', () => {
    const detailed = items.map((item) => ({ ...item, host: item.userHost.split('@')[1].replace(/:22$/, ''), username: item.userHost.split('@')[0], port: 22 }));
    const screen: Screen = { kind: 'connections', items: detailed, selected: 2, command: '', pick: 0 };
    const rowOf = (frame: Frame, pattern: RegExp) => frame.lines.findIndex((line) => pattern.test(line.plain));

    it('puts the key hints near the bottom of the card and the details of the selected row in between', () => {
      const frame = render(screen, { ...view, cols: 110, rows: 40 });
      const cardBottom = rowOf(frame, /╰─+╯/);
      const footer = rowOf(frame, /\/new New/);
      assert.ok(cardBottom - footer <= 3, `hints at ${footer}, card ends at ${cardBottom}`);
      assert.match(text(frame), /─ prod-web ─/, 'a details box titled with the selected name');
      assert.match(text(frame), /Sign-in\s+Key/);
      assert.match(text(frame), /Jump host\s+None, direct connection/);
      const brand = rowOf(frame, /Easy SSH/);
      assert.ok(brand > 2, 'the content is centered, not stuck to the top');
    });

    it('drops the details box first on a shorter terminal, then the details', () => {
      const medium = text(render(screen, { ...view, cols: 110, rows: 23 }));
      assert.doesNotMatch(medium, /─ prod-web ─/);
      assert.match(medium, /Sign-in/);
      const short = render(screen, { ...view, cols: 110, rows: 16 });
      assert.doesNotMatch(text(short), /Jump host/);
      assert.match(text(short), /\/new New/, 'the hints always stay');
      assert.equal(short.lines.length, 16);
    });

    it('keeps only list rows when the slash menu leaves a tiny card', () => {
      const frame = render({ ...screen, command: '/' }, { ...view, cols: 110, rows: 25 });
      const top = frame.lines.findIndex((line) => line.plain.includes('╭'));
      const bottom = frame.lines.findIndex((line, index) => index > top && line.plain.includes('╰'));
      const card = frame.lines.slice(top + 1, bottom).map((line) => line.plain).join('\n');
      assert.ok(bottom - top - 1 <= 4, 'the card is small');
      assert.match(card, /› prod-web/);
      assert.match(card, /staging-db/);
      assert.doesNotMatch(card, /Last:|Easy SSH/);
    });

    it('shows Getting started on an empty list', () => {
      const shown = text(render({ kind: 'connections', items: [], selected: 0, command: '', pick: 0 }, { ...view, rows: 30 }));
      assert.match(shown, /Getting started/);
      assert.match(shown, /\/import\s+Bring in the hosts/);
    });
  });

});
