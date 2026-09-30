import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRemoteCommand, visibleOutput } from './shellCommand';

describe('remote command line', () => {
  it('treats cd as a directory change and everything else as a command', () => {
    assert.deepEqual(parseRemoteCommand(''), { type: 'empty' });
    assert.deepEqual(parseRemoteCommand('   '), { type: 'empty' });
    assert.deepEqual(parseRemoteCommand('cd'), { type: 'cd', path: '~' });
    assert.deepEqual(parseRemoteCommand('cd /var/www'), { type: 'cd', path: '/var/www' });
    assert.deepEqual(parseRemoteCommand('cd "~/projects"'), { type: 'cd', path: '~/projects' });
    assert.deepEqual(parseRemoteCommand('exit'), { type: 'exit' });
    assert.deepEqual(parseRemoteCommand('ls -la'), { type: 'run', command: 'ls -la' });
    assert.deepEqual(parseRemoteCommand('cd /tmp && ls'), { type: 'run', command: 'cd /tmp && ls' });
  });

  it('strips color codes from command output', () => {
    assert.equal(visibleOutput('a\x1b[01;34mb\x1b[0m'), 'ab');
    assert.equal(visibleOutput('keep\nline'), 'keep\nline');
  });
});
