import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConnectionCommand } from './commands';

describe('connection commands', () => {
  it('connects when the line is empty', () => {
    assert.deepEqual(parseConnectionCommand(''), { type: 'connect' });
    assert.deepEqual(parseConnectionCommand('   '), { type: 'connect' });
  });

  it('accepts add, edit, and delete', () => {
    assert.deepEqual(parseConnectionCommand('/new'), { type: 'new' });
    assert.deepEqual(parseConnectionCommand('/add'), { type: 'new' });
    assert.deepEqual(parseConnectionCommand('/Edit'), { type: 'edit' });
    assert.deepEqual(parseConnectionCommand('/modify'), { type: 'edit' });
    assert.deepEqual(parseConnectionCommand('/delete'), { type: 'delete' });
    assert.deepEqual(parseConnectionCommand('/rm'), { type: 'delete' });
  });

  it('rejects a command without a slash', () => {
    assert.deepEqual(parseConnectionCommand('new'), { type: 'unknown', text: 'new' });
    assert.deepEqual(parseConnectionCommand('/new extra'), { type: 'unknown', text: '/new extra' });
  });
});
