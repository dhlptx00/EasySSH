import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectionsFromHosts, effectiveConfig, hostBlockMatches, mergeImported } from './importConfig';
import type { ConnectionRecord } from '../types';
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
    // Host * gives the default user to hosts without one (F7).
    assert.equal(connections.find((item) => item.name === 'bastion')?.username, 'jump');
  });

  it('applies Host * and wildcard defaults with first-match rules (F7)', () => {
    const parsed = parseSshConfig(`
      Host web
        HostName web.example.com

      Host db
        HostName db.example.com
        User postgres
        Port 2200

      Host *.example.com !legacy.example.com
        IdentityFile ~/.ssh/work_%r

      Host *
        User deploy
        Port 2222
        IdentityFile ~/.ssh/id_default
    `);
    const { connections, skipped } = connectionsFromHosts(parsed.hosts, 'me', '/home/me');
    assert.equal(skipped, 3);
    const web = connections.find((item) => item.name === 'web');
    assert.equal(web?.username, 'deploy');
    assert.equal(web?.port, 2222);
    assert.equal(web?.privateKeyPath, '/home/me/.ssh/id_default');
    const db = connections.find((item) => item.name === 'db');
    assert.equal(db?.username, 'postgres');
    assert.equal(db?.port, 2200);
    assert.ok(hostBlockMatches(['*.example.com', '!legacy.example.com'], 'a.example.com'));
    assert.ok(!hostBlockMatches(['*.example.com', '!legacy.example.com'], 'legacy.example.com'));
    assert.equal(effectiveConfig(parsed.hosts, 'a.example.com').identityfile, '~/.ssh/work_%r');
  });

  it('reports ProxyCommand hosts instead of importing them as direct (F7)', () => {
    const parsed = parseSshConfig(`
      Host old
        HostName 10.9.0.1
        ProxyCommand ssh -W %h:%p gateway

      Host both
        HostName 10.9.0.2
        ProxyJump gateway
        ProxyCommand nc %h %p

      Host gateway
        HostName gw.example.com
    `);
    const result = connectionsFromHosts(parsed.hosts, 'me', '/home/me');
    assert.deepEqual(result.proxyCommand, ['old']);
    assert.deepEqual(result.connections.map((item) => item.name).sort(), ['both', 'gateway']);
  });

  it('uses the agent and default keys when IdentityFile is none or missing', () => {
    const parsed = parseSshConfig(`
      Host a
        HostName a.example.com
        IdentityFile none
    `);
    const [a] = connectionsFromHosts(parsed.hosts, 'me', '/home/me').connections;
    assert.equal(a.auth, 'agent');
    assert.equal(a.privateKeyPath, undefined);
  });

  it('keeps manual edits and the start folder when imported again (B4)', () => {
    const existing: ConnectionRecord = {
      id: 'sshconfig:web', name: 'web', host: 'web.example.com', port: 22, username: 'manual', auth: 'password',
      startPath: '/srv/app', askPassword: true, jumps: [],
    };
    const parsed = parseSshConfig(`
      Host web
        HostName web2.example.com
    `);
    const [imported] = connectionsFromHosts(parsed.hosts, 'me', '/home/me').connections;
    const { record, changed } = mergeImported(existing, imported);
    assert.equal(record.host, 'web2.example.com');
    assert.equal(record.username, 'manual');
    assert.equal(record.auth, 'password');
    assert.equal(record.startPath, '/srv/app');
    assert.equal(record.askPassword, true);
    assert.deepEqual(changed, ['host']);
    assert.deepEqual(mergeImported(record, imported).changed, []);
  });
});
