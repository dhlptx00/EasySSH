import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatJumps, parseJumpList } from './jump';
import type { JumpSpec } from '../types';

describe('jump hosts', () => {
  it('parses one hop and a chain', () => {
    assert.deepEqual(parseJumpList('jump@10.0.0.1:2222'), [{ host: '10.0.0.1', port: 2222, username: 'jump' }]);
    assert.deepEqual(parseJumpList(''), []);
    assert.throws(() => parseJumpList('bad port:nope'));
    assert.deepEqual(parseJumpList('[2001:db8::1]:22'), [{ host: '2001:db8::1', port: 22, username: undefined }]);
  });

  it('formats a saved jump', () => {
    const jump: JumpSpec = { host: '10.0.0.1', port: 22, username: 'jump', auth: 'agent' };
    assert.equal(formatJumps([jump]), 'jump@10.0.0.1:22');
  });
});
