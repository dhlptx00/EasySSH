import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConnectionStore, type SecretStore, type StateStore } from './store';
import type { ConnectionRecord } from './types';

function memory(): { state: StateStore; secrets: SecretStore } {
  const data = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  return {
    state: {
      get: <T>(key: string) => data.get(key) as T | undefined,
      update: (key, value) => {
        data.set(key, value);
        return Promise.resolve();
      },
    },
    secrets: {
      get: (key) => Promise.resolve(secrets.get(key)),
      store: (key, value) => {
        secrets.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => {
        secrets.delete(key);
        return Promise.resolve();
      },
    },
  };
}

describe('connection store', () => {
  it('saves a connection and its secret, then deletes both', async () => {
    const backing = memory();
    const store = new ConnectionStore(backing.state, backing.secrets);
    const record: ConnectionRecord = {
      id: '1',
      name: 'prod',
      host: '10.0.0.8',
      port: 22,
      username: 'root',
      auth: 'password',
      jumps: [],
    };
    await store.save(record, { action: 'set', password: 'secret' });
    assert.equal((await store.list())[0]?.name, 'prod');
    assert.equal((await store.secret('1')).password, 'secret');
    await store.trustHost('10.0.0.8:22', 'abc');
    await store.trustHost('bastion:22>10.0.0.8:22', 'def');
    assert.equal(store.getHostKey('10.0.0.8:22'), 'abc');
    assert.deepEqual(store.listHostKeys().map((item) => item.id), ['10.0.0.8:22', 'bastion:22>10.0.0.8:22']);
    await store.forgetHostKeys(['10.0.0.8:22']);
    assert.equal(store.getHostKey('10.0.0.8:22'), undefined);
    assert.equal(store.getHostKey('bastion:22>10.0.0.8:22'), 'def');
    await store.delete('1');
    assert.equal((await store.list()).length, 0);
    assert.equal((await store.secret('1')).password, undefined);
  });

  it('saves a password typed at connect time and keeps the passphrase', async () => {
    const backing = memory();
    const store = new ConnectionStore(backing.state, backing.secrets);
    await store.save({ id: '2', name: 'k', host: 'h', port: 22, username: 'u', auth: 'password', jumps: [] }, { action: 'set', passphrase: 'pp' });
    await store.savePassword('2', 'typed');
    assert.deepEqual(await store.secret('2'), { password: 'typed', passphrase: 'pp' });
  });

  it('keeps "ask each time" and drops it when false', async () => {
    const backing = memory();
    const store = new ConnectionStore(backing.state, backing.secrets);
    await store.save({ id: '3', name: 'a', host: 'h', port: 22, username: 'u', auth: 'password', jumps: [], askPassword: true }, { action: 'clear' });
    await store.save({ id: '4', name: 'b', host: 'h', port: 22, username: 'u', auth: 'password', jumps: [], askPassword: false }, { action: 'clear' });
    const list = await store.list();
    assert.equal(list.find((item) => item.id === '3')?.askPassword, true);
    assert.equal('askPassword' in (list.find((item) => item.id === '4') ?? {}), false);
  });

  it('keeps last-used times and the theme in globalState, and forgets a deleted connection', async () => {
    const backing = memory();
    const store = new ConnectionStore(backing.state, backing.secrets);
    assert.deepEqual(store.lastUsed(), {});
    await store.markUsed('a', 1000);
    await store.markUsed('b', 2000);
    await store.markUsed('a', 3000);
    assert.deepEqual(store.lastUsed(), { a: 3000, b: 2000 });
    await store.delete('a');
    assert.deepEqual(store.lastUsed(), { b: 2000 });
    await backing.state.update('easySsh.lastUsed', { c: 'x', d: -1, e: 5 });
    assert.deepEqual(store.lastUsed(), { e: 5 });
    assert.equal(store.theme(), undefined);
    await store.setTheme('light');
    assert.equal(store.theme(), 'light');
  });
});
