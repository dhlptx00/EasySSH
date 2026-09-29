import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  displayWidth,
  expandHome,
  formatFingerprint,
  formatSize,
  formatTime,
  safeFileName,
  shortenPath,
  truncate,
  uniqueLocalPath,
} from './text';

describe('text', () => {
  it('measures wide characters', () => {
    assert.equal(displayWidth('abc'), 3);
    assert.equal(displayWidth('A\uff21'), 3);
  });

  it('truncates by display width', () => {
    assert.equal(truncate('abcdef', 4), 'abc…');
    assert.equal(truncate('ab', 4), 'ab');
  });

  it('formats sizes and times', () => {
    assert.equal(formatSize(512), '512 B');
    assert.equal(formatSize(1536), '1.5 KB');
    assert.equal(formatTime(Date.parse('2026-09-29T18:10:00'), Date.parse('2026-09-29T00:00:00')), 'Sep 29 18:10');
    assert.equal(formatTime(Date.parse('2024-01-02T00:00:00'), Date.parse('2026-09-29T00:00:00')), 'Jan  2  2024');
  });

  it('shortens a home path and avoids name collisions', () => {
    assert.equal(shortenPath('/Users/me/Desktop/a.txt', '/Users/me', 40), '~/Desktop/a.txt');
    assert.equal(safeFileName('../notes.txt'), 'notes.txt');
    const exists = (file: string) => file === '/tmp/notes.txt';
    assert.equal(uniqueLocalPath('/tmp', 'notes.txt', exists), '/tmp/notes (1).txt');
  });

  it('expands a tilde and formats a host key', () => {
    assert.equal(expandHome('~/.ssh/id_ed25519', '/Users/me'), '/Users/me/.ssh/id_ed25519');
    assert.equal(
      formatFingerprint('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'),
      'SHA256:ABEiM0RVZneImaq7zN3u/wARIjNEVWZ3iJmqu8zd7v8',
    );
  });
});
