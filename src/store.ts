import type { ConnectionRecord, SecretPayload, SecretUpdate } from './types';

export interface StateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

const CONNECTIONS = 'easySsh.connections';
const HOST_KEYS = 'easySsh.knownHosts';

function secretKey(id: string): string {
  return `easySsh.secret.${id}`;
}

function hostKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function isRecord(value: unknown): value is ConnectionRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as ConnectionRecord;
  return Boolean(
    typeof record.id === 'string' &&
      typeof record.name === 'string' &&
      typeof record.host === 'string' &&
      typeof record.port === 'number' &&
      typeof record.username === 'string' &&
      (record.auth === 'password' || record.auth === 'privateKey' || record.auth === 'agent') &&
      Array.isArray(record.jumps),
  );
}

export class ConnectionStore {
  constructor(
    private readonly state: StateStore,
    private readonly secrets: SecretStore,
  ) {}

  async list(): Promise<ConnectionRecord[]> {
    const stored = this.state.get<unknown>(CONNECTIONS);
    if (!Array.isArray(stored)) return [];
    return stored.filter(isRecord).map((record) => ({ ...record, jumps: record.jumps ?? [] }));
  }

  async save(record: ConnectionRecord, secret: SecretUpdate): Promise<void> {
    const all = await this.list();
    const next = all.filter((item) => item.id !== record.id);
    next.push(record);
    next.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    await this.state.update(CONNECTIONS, next);
    if (secret.action === 'clear') {
      await this.secrets.delete(secretKey(record.id));
      return;
    }
    if (secret.action === 'set') {
      const payload: SecretPayload = {};
      if (secret.password) payload.password = secret.password;
      if (secret.passphrase) payload.passphrase = secret.passphrase;
      if (!payload.password && !payload.passphrase) await this.secrets.delete(secretKey(record.id));
      else await this.secrets.store(secretKey(record.id), JSON.stringify(payload));
    }
  }

  async delete(id: string): Promise<void> {
    const next = (await this.list()).filter((item) => item.id !== id);
    await this.state.update(CONNECTIONS, next);
    await this.secrets.delete(secretKey(id));
  }

  async secret(id: string): Promise<SecretPayload> {
    const raw = await this.secrets.get(secretKey(id));
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as SecretPayload;
      return {
        password: typeof parsed.password === 'string' ? parsed.password : undefined,
        passphrase: typeof parsed.passphrase === 'string' ? parsed.passphrase : undefined,
      };
    } catch {
      return {};
    }
  }

  async secretFlags(id: string): Promise<{ password: boolean; passphrase: boolean }> {
    const payload = await this.secret(id);
    return { password: Boolean(payload.password), passphrase: Boolean(payload.passphrase) };
  }

  getHostKey(host: string, port: number): string | undefined {
    const table = this.state.get<Record<string, string>>(HOST_KEYS) ?? {};
    return table[hostKey(host, port)];
  }

  async trustHost(host: string, port: number, fingerprint: string): Promise<void> {
    const table = { ...(this.state.get<Record<string, string>>(HOST_KEYS) ?? {}) };
    table[hostKey(host, port)] = fingerprint;
    await this.state.update(HOST_KEYS, table);
  }

  async resetHostKeys(): Promise<void> {
    await this.state.update(HOST_KEYS, {});
  }
}
