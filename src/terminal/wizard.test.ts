import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyStep, emptyDraft, nextStep, toConnection } from './wizard';

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

  it('chooses auth, the remote path, and a jump host', () => {
    let draft = emptyDraft();
    draft = applyStep('auth', 'agent', draft, ctx).draft;
    assert.equal(draft.auth, 'agent');
    assert.equal(nextStep('auth', draft), 'startPathChoice');
    draft = applyStep('startPathChoice', 'home', draft, ctx).draft;
    assert.equal(nextStep('startPathChoice', draft), 'jumpChoice');
    draft = applyStep('jumpChoice', 'none', draft, ctx).draft;
    assert.equal(nextStep('jumpChoice', draft), 'done');
    assert.equal(draft.jump, '');
  });
});
