import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSshConfig } from './parseConfig';

describe('ssh config parser', () => {
  it('reads hosts, defaults, comments, and includes', () => {
    const parsed = parseSshConfig(`
      # lab
      User ubuntu
      Include config.d/*.conf

      Host web
        HostName=10.0.0.8
        Port 2200

      Match host *.internal
        User nope

      Host bastion app
        HostName jump.example
    `);
    assert.deepEqual(parsed.includes, ['config.d/*.conf']);
    assert.equal(parsed.hosts[0]?.patterns[0], 'web');
    assert.equal(parsed.hosts[0]?.values.user[0], 'ubuntu');
    assert.equal(parsed.hosts[0]?.values.hostname[0], '10.0.0.8');
    assert.equal(parsed.hosts[0]?.values.port[0], '2200');
    assert.equal(parsed.hosts[1]?.patterns.join(' '), 'bastion app');
    assert.equal(parsed.hosts[1]?.values.user?.[0], 'ubuntu');
  });
});
