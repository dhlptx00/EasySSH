import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InputDecoder } from './input';

describe('terminal input', () => {
  it('decodes keys, text, and bracketed paste', () => {
    const decoder = new InputDecoder();
    assert.deepEqual(decoder.push('n'), [{ type: 'text', text: 'n' }]);
    assert.deepEqual(decoder.push('\x1b[A'), [{ type: 'key', key: 'up' }]);
    assert.deepEqual(decoder.push('\x1b'), [{ type: 'key', key: 'escape' }]);
    assert.deepEqual(decoder.push('\x7f'), [{ type: 'key', key: 'backspace' }]);
    assert.deepEqual(decoder.push('\r'), [{ type: 'key', key: 'enter' }]);
    assert.deepEqual(decoder.push('\x1b[200~/tmp/a.txt\x1b[201~'), [{ type: 'paste', text: '/tmp/a.txt' }]);
  });

  it('keeps an unfinished escape sequence', () => {
    const decoder = new InputDecoder();
    assert.deepEqual(decoder.push('\x1b['), []);
    assert.deepEqual(decoder.push('B'), [{ type: 'key', key: 'down' }]);
  });

  it('decodes SGR mouse hover, press, release, and wheel', () => {
    const decoder = new InputDecoder();
    assert.deepEqual(decoder.push('\x1b[<0;12;5M'), [{ type: 'mouse', action: 'down', button: 0, col: 12, row: 5 }]);
    assert.deepEqual(decoder.push('\x1b[<0;12;5m'), [{ type: 'mouse', action: 'up', button: 0, col: 12, row: 5 }]);
    assert.deepEqual(decoder.push('\x1b[<35;4;8M'), [{ type: 'mouse', action: 'move', button: 3, col: 4, row: 8 }]);
    assert.deepEqual(decoder.push('\x1b[<64;1;1M'), [{ type: 'mouse', action: 'wheel', button: 0, col: 1, row: 1 }]);
    assert.deepEqual(decoder.push('\x1b[<'), []);
    assert.deepEqual(decoder.push('0;3;4M'), [{ type: 'mouse', action: 'down', button: 0, col: 3, row: 4 }]);
    assert.deepEqual(decoder.push(`\x1b[M ${String.fromCharCode(33)}${String.fromCharCode(36)}`), [
      { type: 'mouse', action: 'down', button: 0, col: 1, row: 4 },
    ]);
    assert.deepEqual(decoder.push(`\x1b[M#${String.fromCharCode(33)}${String.fromCharCode(36)}`), [
      { type: 'mouse', action: 'up', button: 0, col: 1, row: 4 },
    ]);
  });
});
