import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loginTerminalModes, terminalWindow } from './session';

describe('terminal window', () => {
  it('asks the server for a normal Linux terminal', () => {
    const modes = loginTerminalModes();
    assert.equal(modes.ECHO, 1);
    assert.equal(modes.ICANON, 1);
    assert.equal(modes.ISIG, 1);
    assert.equal(modes.ICRNL, 1);
    assert.equal(modes.ONLCR, 1);
    assert.equal(modes.VERASE, 127);
    assert.equal(modes.VSUSP, 26);
  });

  it('follows both rows and columns', () => {
    assert.deepEqual(terminalWindow(120, 40), { cols: 120, rows: 40 });
    assert.deepEqual(terminalWindow(10, 1), { cols: 20, rows: 2 });
    assert.deepEqual(terminalWindow(Number.NaN, Number.NaN), { cols: 80, rows: 24 });
  });
});
