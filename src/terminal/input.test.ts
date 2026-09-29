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
});
