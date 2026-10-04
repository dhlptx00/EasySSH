import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConnectionRecord } from '../types';
import { applyChoice, applyStep, draftFromRecord, emptyDraft, fieldOf, fieldValue, nextStep, sshCommand, stepPosition, toConnection, wizardPath } from './wizard';

const ctx = {
  takenNames: ['Lab'],
  keyExists: (file: string) => file === '/Users/me/.ssh/id_ed25519',
  home: '/Users/me',
};

describe('connection wizard', () => {
  it('walks a new key connection', () => {
    let draft = emptyDraft();
    const name = applyStep('name', 'prod', draft, ctx);
    assert.equal(name.error, undefined);
    draft = name.draft;
    assert.equal(nextStep('name', draft), 'host');

    draft = applyStep('host', '10.0.0.8', draft, ctx).draft;
    draft = applyStep('port', '', draft, ctx).draft;
    assert.equal(draft.port, '22');
    draft = applyStep('username', 'root', draft, ctx).draft;
    draft = applyStep('auth', 'key', draft, ctx).draft;
    assert.equal(draft.auth, 'privateKey');
    const missing = applyStep('keyPath', '/nope', draft, ctx);
    assert.match(missing.error ?? '', /not found/);
    draft = applyStep('keyPath', '~/.ssh/id_ed25519', draft, ctx).draft;
    assert.equal(draft.keyPath, '/Users/me/.ssh/id_ed25519');
    draft = applyStep('passphrase', '', draft, ctx).draft;
    draft = applyStep('startPath', 'home', draft, ctx).draft;
    draft = applyStep('jump', 'jump@10.0.0.1:2222', draft, ctx).draft;

    const { record, secret } = toConnection(draft, 'id-1');
    assert.equal(record.host, '10.0.0.8');
    assert.equal(record.auth, 'privateKey');
    assert.equal(record.startPath, undefined);
    assert.equal(record.jumps[0]?.host, '10.0.0.1');
    assert.equal(record.jumps[0]?.port, 2222);
    assert.equal(secret.action, 'set');
  });

  it('rejects a duplicate name and a bad port', () => {
    const draft = emptyDraft();
    assert.match(applyStep('name', 'lab', draft, ctx).error ?? '', /already exists/);
    assert.match(applyStep('name', 'new', draft, ctx).error ?? '', /system command/);
    const withPort = { ...draft, port: '22' };
    assert.match(applyStep('port', '70000', withPort, ctx).error ?? '', /65535/);
  });

  it('chooses auth and a jump host without asking for a directory', () => {
    let draft = emptyDraft();
    draft = applyStep('auth', 'agent', draft, ctx).draft;
    assert.equal(draft.auth, 'agent');
    assert.equal(nextStep('auth', draft), 'jumpChoice');
    draft = applyStep('jumpChoice', 'none', draft, ctx).draft;
    assert.equal(nextStep('jumpChoice', draft), 'done');
    assert.equal(draft.jump, '');
  });

  it('moves unedited jump hosts to the new sign-in method (B3 regression)', () => {
    const record: ConnectionRecord = {
      id: '1', name: 'prod', host: '10.0.0.8', port: 22, username: 'root', auth: 'password',
      jumps: [
        { host: 'bastion', port: 22, username: 'root', auth: 'password' },
        { host: 'gw', port: 22, username: 'ops', auth: 'privateKey', privateKeyPath: '/Users/me/.ssh/gw' },
      ],
    };
    let draft = draftFromRecord(record, { password: true, passphrase: false });
    draft = applyChoice('auth', 'privateKey', draft).draft;
    draft = applyStep('keyPath', '~/.ssh/id_ed25519', draft, ctx).draft;
    const { record: saved } = toConnection(draft, '1');
    // The jump that signed in like the server follows it; the one with its own key keeps it.
    assert.deepEqual(saved.jumps[0], { host: 'bastion', port: 22, username: 'root', auth: 'privateKey', privateKeyPath: '/Users/me/.ssh/id_ed25519' });
    assert.deepEqual(saved.jumps[1], record.jumps[1]);

    let agent = draftFromRecord({ ...record, auth: 'privateKey', privateKeyPath: '/k', jumps: [{ host: 'b', port: 22, username: 'u', auth: 'privateKey', privateKeyPath: '/k' }] }, { password: false, passphrase: false });
    agent = applyChoice('auth', 'agent', agent).draft;
    assert.deepEqual(toConnection(agent, '1').record.jumps[0], { host: 'b', port: 22, username: 'u', auth: 'agent', privateKeyPath: undefined });
  });

  it('can ask for the password at every connect instead of saving it (S3)', () => {
    let draft = emptyDraft();
    draft = { ...draft, name: 'db', host: 'db01', username: 'dev' };
    draft = applyChoice('auth', 'password', draft).draft;
    assert.equal(nextStep('auth', draft), 'passwordMode');
    draft = applyChoice('passwordMode', 'ask', draft).draft;
    assert.equal(nextStep('passwordMode', draft), 'jumpChoice');
    const asked = toConnection(draft, '9');
    assert.equal(asked.record.askPassword, true);
    assert.deepEqual(asked.secret, { action: 'clear' });

    draft = applyChoice('passwordMode', 'save', draft).draft;
    assert.equal(nextStep('passwordMode', draft), 'password');
    draft = applyStep('password', 'hunter2', draft, ctx).draft;
    const saved = toConnection(draft, '9');
    assert.equal(saved.record.askPassword, undefined);
    assert.deepEqual(saved.secret, { action: 'set', password: 'hunter2' });

    const reopened = draftFromRecord({ ...asked.record }, { password: false, passphrase: false });
    assert.equal(reopened.passwordMode, 'ask');
  });

  it('does not store an empty password', () => {
    let draft = { ...emptyDraft(), name: 'db', host: 'db01', username: 'dev' };
    draft = applyChoice('auth', 'password', draft).draft;
    draft = applyChoice('passwordMode', 'save', draft).draft;
    draft = applyStep('password', '', draft, ctx).draft;
    assert.deepEqual(toConnection(draft, '9').secret, { action: 'clear' });
  });

  it('counts the steps the draft walks through', () => {
    const draft = emptyDraft();
    assert.deepEqual(wizardPath(draft), ['name', 'host', 'port', 'username', 'auth', 'jumpChoice']);
    assert.deepEqual(stepPosition('host', draft), { index: 2, total: 6 });
    const key = { ...draft, auth: 'privateKey' as const, jumpMode: 'custom' as const };
    assert.deepEqual(stepPosition('keyPath', key), { index: 6, total: 9 });
    assert.deepEqual(stepPosition('passwordMode', { ...draft, auth: 'password' }, 'auth'), { index: 2, total: 3 });
    assert.equal(fieldOf('passphrase'), 'auth');
    assert.equal(fieldOf('jump'), 'jump');
  });

  it('rejects an empty host and a port that is not a number', () => {
    assert.match(applyStep('host', '', emptyDraft(), ctx).error ?? '', /Host is required/);
    assert.match(applyStep('host', 'a b', emptyDraft(), ctx).error ?? '', /spaces/);
    assert.match(applyStep('port', 'abc', emptyDraft(), ctx).error ?? '', /must be a number/);
    assert.match(applyStep('port', '0', emptyDraft(), ctx).error ?? '', /between 1 and 65535/);
  });

  it('previews the ssh command and never shows secrets', () => {
    const draft = {
      ...emptyDraft(),
      name: 'db',
      host: 'db.internal',
      port: '2200',
      username: 'pg',
      auth: 'password' as const,
      passwordMode: 'save' as const,
      password: 'hunter2',
      jumpMode: 'custom' as const,
      jump: 'jump.example.com:2222, ops@[fd00::1]',
    };
    assert.equal(sshCommand(draft), 'ssh -p 2200 -o PreferredAuthentications=password,keyboard-interactive -J pg@jump.example.com:2222,ops@[fd00::1] pg@db.internal');
    assert.equal(fieldValue('auth', draft), 'Password (new, stored securely)');
    assert.ok(!sshCommand(draft).includes('hunter2'));
    const key = { ...emptyDraft(), host: 'h', username: 'u', auth: 'privateKey' as const, keyPath: '/Users/me/.ssh/my key' };
    assert.equal(sshCommand(key, '/Users/me'), "ssh -i ~/'.ssh/my key' u@h");
    assert.equal(fieldValue('jump', key), 'None, direct connection');
  });
});
