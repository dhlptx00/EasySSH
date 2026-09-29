import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectionsFromHosts } from './importConfig';
import { parseSshConfig } from './parseConfig';

describe('ssh config import', () => {
  it('builds connections and resolves a jump alias', () => {
    const parsed = parseSshConfig(`
      Host bastion
        HostName jump.internal
        User jump
        IdentityFile ~/.ssh/bastion

      Host app
        HostName 10.0.0.5
        User app
        ProxyJump bastion

      Host *
        User ubuntu
    `);
    const { connections, skipped } = connectionsFromHosts(parsed.hosts, 'fallback', '/Users/me');
    assert.equal(skipped, 1);
    const app = connections.find((item) => item.name === 'app');
    const bastion = connections.find((item) => item.name === 'bastion');
    assert.equal(app?.host, '10.0.0.5');
    assert.equal(app?.auth, 'agent');
    assert.equal(app?.jumps[0]?.host, 'jump.internal');
    assert.equal(app?.jumps[0]?.username, 'jump');
    assert.equal(app?.jumps[0]?.privateKeyPath, '/Users/me/.ssh/bastion');
    assert.equal(bastion?.auth, 'privateKey');
  });
});
