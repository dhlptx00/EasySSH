import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { describe, it } from 'node:test';
import { checkKnownHosts, hostField, hostMatches, keyFingerprint, keyTypeOf, knownHostsLine, parseKnownHosts } from './knownHosts';
import { decideHostKey, hopIds } from './hostKeys';

/** A fake SSH public key blob: string type, then random-looking bytes. */
function blob(type: string, fill: number): Buffer {
  const name = Buffer.from(type, 'latin1');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(name.length);
  return Buffer.concat([head, name, Buffer.alloc(32, fill)]);
}

const ED_A = blob('ssh-ed25519', 1);
const ED_B = blob('ssh-ed25519', 2);
const RSA = blob('ssh-rsa', 3);

function hashed(name: string): string {
  const salt = Buffer.alloc(20, 9);
  return `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update(name).digest('base64')}`;
}

describe('known_hosts (S1)', () => {
  it('reads plain, hashed, bracketed and marked lines', () => {
    const text = [
      '# comment',
      `web01,10.0.0.8 ssh-ed25519 ${ED_A.toString('base64')}`,
      `${hashed('db01')} ssh-ed25519 ${ED_B.toString('base64')}`,
      `[git.example.com]:2222 ssh-rsa ${RSA.toString('base64')} comment here`,
      `@revoked * ssh-ed25519 ${ED_B.toString('base64')}`,
      `@cert-authority *.corp ssh-ed25519 ${ED_A.toString('base64')}`,
      'broken line',
      '',
    ].join('\n');
    const entries = parseKnownHosts(text);
    assert.equal(entries.length, 5);
    assert.deepEqual(entries[0].patterns, ['web01', '10.0.0.8']);
    assert.equal(entries[3].marker, 'revoked');
    assert.equal(entries[4].marker, 'cert-authority');
  });

  it('matches hosts the way OpenSSH does', () => {
    assert.equal(hostField('h', 22), 'h');
    assert.equal(hostField('h', 2222), '[h]:2222');
    assert.ok(hostMatches(['web01', '10.0.0.8'], '10.0.0.8', 22));
    assert.ok(hostMatches(['*.example.com'], 'a.example.com', 22));
    assert.ok(!hostMatches(['*.example.com'], 'a.example.com', 2222));
    assert.ok(hostMatches(['[a.example.com]:2222'], 'a.example.com', 2222));
    assert.ok(hostMatches(['web0?'], 'WEB01', 22));
    assert.ok(!hostMatches(['*.corp', '!bad.corp'], 'bad.corp', 22));
    assert.ok(hostMatches([hashed('db01')], 'db01', 22));
    assert.ok(!hostMatches([hashed('db01')], 'db02', 22));
    assert.ok(hostMatches([hashed('[db01]:2200')], 'db01', 2200));
  });

  it('trusts a listed key, flags a different one, and rejects a revoked one', () => {
    const entries = parseKnownHosts([
      `web01 ssh-ed25519 ${ED_A.toString('base64')}`,
      `web01 ssh-rsa ${RSA.toString('base64')}`,
      `@revoked * ssh-ed25519 ${ED_B.toString('base64')}`,
    ].join('\n'));
    assert.deepEqual(checkKnownHosts(entries, 'web01', 22, ED_A), { status: 'match' });
    assert.deepEqual(checkKnownHosts(entries, 'web01', 22, RSA), { status: 'match' });
    assert.deepEqual(checkKnownHosts(entries, 'web01', 22, ED_B), { status: 'revoked' });
    const other = blob('ssh-ed25519', 7);
    assert.deepEqual(checkKnownHosts(entries, 'web01', 22, other), { status: 'mismatch', previous: keyFingerprint(ED_A) });
    // A key of a type known_hosts has no line for is unknown, not changed (like OpenSSH).
    assert.deepEqual(checkKnownHosts(entries, 'web01', 22, blob('ecdsa-sha2-nistp256', 4)), { status: 'unknown' });
    assert.deepEqual(checkKnownHosts(entries, 'web02', 22, other), { status: 'unknown' });
  });

  it('writes a line OpenSSH can read back', () => {
    const line = knownHostsLine('git.example.com', 2222, ED_A);
    assert.ok(line.startsWith('[git.example.com]:2222 ssh-ed25519 '));
    assert.equal(keyTypeOf(ED_A), 'ssh-ed25519');
    assert.deepEqual(checkKnownHosts(parseKnownHosts(line), 'git.example.com', 2222, ED_A), { status: 'match' });
  });
});

describe('host key decisions', () => {
  const store = (values: Record<string, string>) => ({ get: (id: string) => values[id] });

  it('keys hops behind a jump host by the chain (B16)', () => {
    const hops = hopIds([{ host: 'bastion', port: 22 }, { host: '10.0.0.8', port: 22 }, { host: '10.1.0.2', port: 2222 }]);
    assert.deepEqual(hops.map((hop) => hop.id), ['bastion:22', 'bastion:22>10.0.0.8:22', 'bastion:22>10.0.0.8:22>10.1.0.2:2222']);
    assert.deepEqual(hops.map((hop) => hop.legacyId), ['bastion:22', '10.0.0.8:22', '10.1.0.2:2222']);
  });

  it('asks about an unknown key by default and stores it with trustFirst', () => {
    const [hop] = hopIds([{ host: 'web01', port: 22 }]);
    assert.deepEqual(decideHostKey(hop, ED_A, [], store({}), 'ask', new Map()), { action: 'ask', kind: 'unknown', fingerprint: keyFingerprint(ED_A) });
    assert.deepEqual(decideHostKey(hop, ED_A, [], store({}), 'trustFirst', new Map()), { action: 'store', fingerprint: keyFingerprint(ED_A) });
  });

  it('trusts ~/.ssh/known_hosts first and honours @revoked', () => {
    const [hop] = hopIds([{ host: 'web01', port: 22 }]);
    const known = parseKnownHosts(`web01 ssh-ed25519 ${ED_A.toString('base64')}\n@revoked web01 ssh-ed25519 ${ED_B.toString('base64')}`);
    assert.deepEqual(decideHostKey(hop, ED_A, known, store({ 'web01:22': 'stale' }), 'ask', new Map()), { action: 'trust', source: 'known_hosts' });
    assert.equal(decideHostKey(hop, ED_B, known, store({}), 'trustFirst', new Map()).action, 'reject');
  });

  it('treats a different stored key as changed, even with trustFirst', () => {
    const [hop] = hopIds([{ host: 'web01', port: 22 }]);
    const decision = decideHostKey(hop, ED_B, [], store({ 'web01:22': keyFingerprint(ED_A) }), 'trustFirst', new Map());
    assert.deepEqual(decision, { action: 'ask', kind: 'changed', fingerprint: keyFingerprint(ED_B), previous: keyFingerprint(ED_A) });
    const known = parseKnownHosts(`web01 ssh-ed25519 ${ED_A.toString('base64')}`);
    assert.equal(decideHostKey(hop, ED_B, known, store({}), 'trustFirst', new Map()).action, 'ask');
  });

  it('only trusts what was accepted for that hop (B16)', () => {
    const hops = hopIds([{ host: 'bastion', port: 22 }, { host: '10.0.0.8', port: 22 }]);
    const accepted = new Map([[hops[0].id, keyFingerprint(ED_B)]]);
    const saved = store({ 'bastion:22': keyFingerprint(ED_A), 'bastion:22>10.0.0.8:22': keyFingerprint(ED_A) });
    assert.deepEqual(decideHostKey(hops[0], ED_B, [], saved, 'ask', accepted), { action: 'trust', source: 'accepted' });
    assert.equal(decideHostKey(hops[1], ED_B, [], saved, 'ask', accepted).action, 'ask');
  });

  it('still finds keys saved by 0.1.x under host:port', () => {
    const hops = hopIds([{ host: 'bastion', port: 22 }, { host: '10.0.0.8', port: 22 }]);
    assert.deepEqual(decideHostKey(hops[1], ED_A, [], store({ '10.0.0.8:22': keyFingerprint(ED_A) }), 'ask', new Map()), { action: 'trust', source: 'easy-ssh' });
  });
});
