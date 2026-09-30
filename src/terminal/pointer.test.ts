import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { peelPointer } from './pointer';

describe('mouse reports', () => {
  it('reads a click and leaves the other keys', () => {
    const peeled = peelPointer('ls\x1b[<0;4;2M\x1b[<0;4;2m');
    assert.equal(peeled.text, 'ls');
    assert.equal(peeled.held, '');
    assert.deepEqual(peeled.events.map((event) => event.action), ['down', 'up']);
    assert.equal(peeled.events[0]?.col, 4);
    assert.equal(peeled.events[0]?.row, 2);
    assert.equal(peeled.events[1]?.button, 0);
  });

  it('holds an unfinished report', () => {
    const partial = peelPointer('cd \x1b[<0;8');
    assert.equal(partial.text, 'cd ');
    assert.equal(partial.held, '\x1b[<0;8');
    assert.deepEqual(partial.events, []);
    const done = peelPointer(partial.held + ';3m');
    assert.equal(done.events[0]?.action, 'up');
    assert.equal(done.events[0]?.row, 3);
  });

  it('tells the wheel from an arrow key', () => {
    const peeled = peelPointer('\x1b[A\x1b[<64;1;9M');
    assert.equal(peeled.text, '\x1b[A');
    assert.equal(peeled.events[0]?.action, 'wheel');
    assert.equal(peeled.events[0]?.button, 0);
  });
});
