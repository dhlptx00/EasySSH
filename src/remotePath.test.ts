import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeRemote, remoteBasename, remoteDirname, remoteJoin } from './remotePath';

describe('remote paths', () => {
  it('joins and normalizes linux paths', () => {
    assert.equal(remoteJoin('/var/www', 'app'), '/var/www/app');
    assert.equal(remoteJoin('/var/www', '/etc/hosts'), '/etc/hosts');
    assert.equal(remoteJoin('/', '..'), '/');
    assert.equal(normalizeRemote('/a/b/../c//'), '/a/c');
    assert.equal(remoteDirname('/var/www'), '/var');
    assert.equal(remoteDirname('/'), '/');
    assert.equal(remoteBasename('/var/www/README.md'), 'README.md');
  });
});
