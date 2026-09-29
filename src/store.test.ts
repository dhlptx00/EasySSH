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
    await store.trustHost('10.0.0.8', 22, 'abc');
    assert.equal(store.getHostKey('10.0.0.8', 22), 'abc');
    await store.delete('1');
    assert.equal((await store.list()).length, 0);
    assert.equal((await store.secret('1')).password, undefined);
  });
});
