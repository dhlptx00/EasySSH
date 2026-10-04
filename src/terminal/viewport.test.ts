import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BrowseEntry } from '../types';
import { linkAt } from './render';
import { Viewport } from './viewport';

const notes: BrowseEntry = { name: 'notes', path: '/tmp/notes', kind: 'file', size: 1, mtime: 0 };

function text(cells: readonly string[]): string {
  return cells.filter((cell) => cell).join('');
}

describe('click viewport', () => {
  it('finds a file name under the clicked column', () => {
    const view = new Viewport(40, 8);
    view.write('\x1b[32mnotes\x1b[0m\r\n');
    const cells = view.cells(1);
    assert.equal(text(cells), 'notes');
    assert.equal(linkAt(cells, 0, [notes])?.remotePath, '/tmp/notes');
    assert.equal(linkAt(cells, 4, [notes])?.remotePath, '/tmp/notes');
    assert.equal(linkAt(cells, 5, [notes]), undefined);
  });

  it('ignores a directory report and scrolls the oldest line off', () => {
    const view = new Viewport(20, 2);
    view.write('\x1b]7;file://host/tmp\x07one\r\ntwo\r\nthree');
    assert.equal(text(view.cells(1)), 'two');
    assert.equal(text(view.cells(2)), 'three');
  });

  it('restores the shell screen after a full-screen program', () => {
    const view = new Viewport(20, 4);
    view.write('notes.txt\r\n');
    view.write('\x1b[?1049h');
    view.write('vim');
    assert.equal(text(view.cells(1)), 'vim');
    view.write('\x1b[?1049l');
    assert.equal(text(view.cells(1)), 'notes.txt');
    assert.equal(text(view.cells(2)), '');
  });

  it('clears the screen without printing the escape', () => {
    const view = new Viewport(20, 4);
    view.write('old\x1b[2J\x1b[HClick');
    assert.equal(text(view.cells(1)), 'Click');
    assert.equal(text(view.cells(2)), '');
  });
});

describe('viewport row anchors (stale link check)', () => {
  it('a row keeps its anchor while it scrolls and loses it when redrawn', () => {
    const view = new Viewport(40, 3);
    view.write('README.md\r\nnotes.txt\r\n');
    const [anchor] = view.anchor('README.md');
    assert.deepEqual(anchor && anchor.row, 1);
    assert.equal(view.unchanged(anchor), true);
    // Scrolling moves the row (and finally off the top) without changing it.
    view.write('a\r\nb\r\n');
    assert.equal(view.unchanged(anchor), true);
    // clear: the same row now shows other text.
    view.write('\x1b[H\x1b[2Japp.yaml\r\n');
    assert.equal(view.text(1), 'app.yaml');
    const [fresh] = view.anchor('app.yaml');
    assert.equal(view.unchanged(fresh), true);
    const again = new Viewport(40, 3);
    again.write('README.md\r\n');
    const [first] = again.anchor('README.md');
    again.write('\x1b[H\x1b[2JREADME.md\r\n');
    // Identical text redrawn is a new row content: the caller re-reads the row.
    assert.equal(again.unchanged(first), false);
    assert.equal(again.text(first.row), 'README.md');
  });

  it('erasing or overwriting a row changes it; other rows keep their anchors', () => {
    const view = new Viewport(40, 4);
    view.write('one\r\ntwo\r\nthree');
    const one = view.anchor('one')[0];
    const two = view.anchor('two')[0];
    view.write('\x1b[2;1H\x1b[2Kzwei');
    assert.equal(view.unchanged(two), false);
    assert.equal(view.unchanged(one), true);
    assert.deepEqual(view.anchor('missing'), []);
    assert.deepEqual(view.anchor(''), []);
  });

  it('a full-screen program and back keeps the shell rows', () => {
    const view = new Viewport(40, 4);
    view.write('notes.txt\r\n');
    const anchor = view.anchor('notes.txt')[0];
    view.write('\x1b[?1049h~\r\n~\x1b[?1049l');
    assert.equal(view.unchanged(anchor), true);
  });
});
