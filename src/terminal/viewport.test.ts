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
