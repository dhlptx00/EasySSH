import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodePaste, pullRawInput } from './rawInput';

describe('raw terminal input', () => {
  it('keeps newlines inside a bracketed paste', () => {
    const heredoc = 'cat <<EOF\nhello\nEOF\n';
    const pulled = pullRawInput(`\x1b[200~${heredoc}\x1b[201~`);
    assert.deepEqual(pulled.pieces, [{ kind: 'paste', text: heredoc }]);
    assert.equal(pulled.rest, '');
    assert.equal(encodePaste(heredoc, false), heredoc);
    assert.equal(encodePaste(heredoc, true), `\x1b[200~${heredoc}\x1b[201~`);
  });

  it('forwards control keys and arrows as raw bytes', () => {
    const keys = '\x03\x1a\x0c\x12\x7f\t\x1b[A\x1b[B';
    const pulled = pullRawInput(keys);
    assert.deepEqual(pulled.pieces, [{ kind: 'bytes', text: keys }]);
  });

  it('holds an unfinished paste and a trailing escape', () => {
    const open = pullRawInput('ls\x1b[200~hi');
    assert.deepEqual(open.pieces, [{ kind: 'bytes', text: 'ls' }]);
    assert.equal(open.rest, '\x1b[200~hi');
    const escape = pullRawInput('vim\x1b');
    assert.deepEqual(escape.pieces, [{ kind: 'bytes', text: 'vim' }]);
    assert.equal(escape.rest, '\x1b');
  });
});
