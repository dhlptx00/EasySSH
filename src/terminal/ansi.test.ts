import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emphasize, sanitizeTerminal, wrapTerminal } from './ansi';

describe('terminal output', () => {
  it('keeps color and drops cursor movement', () => {
    const text = sanitizeTerminal('a\x1b[01;34mb\x1b[0m\x1b[2J\x1b[Hc');
    assert.equal(text, 'a\x1b[01;34mb\x1b[0mc');
    const lines = wrapTerminal(text, 20);
    assert.equal(lines.map((line) => line.plain).join('\n'), 'abc');
    assert.match(lines[0].styled, /\x1b\[01;34m/);
  });

  it('wraps long lines and keeps newlines', () => {
    const lines = wrapTerminal('hello\nworld', 3);
    assert.deepEqual(lines.map((line) => line.plain), ['hel', 'lo', 'wor', 'ld']);
  });

  it('underlines a span without changing the text', () => {
    const line = wrapTerminal('README.md notes', 40)[0];
    const marked = emphasize(line, [{ start: 0, length: 9, selected: false }]);
    assert.equal(marked.plain, 'README.md notes');
    assert.match(marked.styled, /\x1b\[4mREADME\.md/);
    const pressed = emphasize(line, [{ start: 0, length: 9, selected: true }]);
    assert.match(pressed.styled, /48;2;48;48;48/);
    assert.match(pressed.styled, /\x1b\[4m|\x1b\[1;4;/);
  });
});
