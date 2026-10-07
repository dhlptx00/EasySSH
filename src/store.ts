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
const LAST_USED = 'easySsh.lastUsed';
const RATING = 'easySsh.ratingPrompt';
/** Successful connections before the one-time rating prompt. */
export const RATING_AFTER = 5;

function secretKey(id: string): string {
  return `easySsh.secret.${id}`;
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

/** Drop unknown fields and fix types of a stored record. */
function cleanRecord(record: ConnectionRecord): ConnectionRecord {
  const clean: ConnectionRecord = { ...record, jumps: record.jumps ?? [] };
  if (record.askPassword !== true) delete clean.askPassword;
  return clean;
}

export class ConnectionStore {
  constructor(
    private readonly state: StateStore,
    private readonly secrets: SecretStore,
  ) {}

  async list(): Promise<ConnectionRecord[]> {
    const stored = this.state.get<unknown>(CONNECTIONS);
    if (!Array.isArray(stored)) return [];
    return stored.filter(isRecord).map(cleanRecord);
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
    const used = this.lastUsed();
    if (id in used) {
      delete used[id];
      await this.state.update(LAST_USED, used);
    }
  }

  /** When each connection last connected (milliseconds since the epoch), by id. */
  lastUsed(): Record<string, number> {
    const stored = this.state.get<unknown>(LAST_USED);
    if (!stored || typeof stored !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [id, value] of Object.entries(stored as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[id] = value;
    }
    return out;
  }

  async markUsed(id: string, when = Date.now()): Promise<void> {
    await this.state.update(LAST_USED, { ...this.lastUsed(), [id]: when });
  }

  /** Counts a successful connection. True exactly once, on the RATING_AFTER-th; never again after that. */
  async countConnect(): Promise<boolean> {
    const stored = this.state.get<unknown>(RATING);
    if (stored === 'done') return false;
    const count = (typeof stored === 'number' ? stored : 0) + 1;
    await this.state.update(RATING, count >= RATING_AFTER ? 'done' : count);
    return count >= RATING_AFTER;
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

  /** Save a password typed at connect time, keeping a saved passphrase. */
  async savePassword(id: string, password: string): Promise<void> {
    const current = await this.secret(id);
    const payload: SecretPayload = { ...current, password };
    await this.secrets.store(secretKey(id), JSON.stringify(payload));
  }

  /**
   * The trusted fingerprint for a host id: "host:port" for a direct server,
   * "jump:22>host:port" behind jump hosts.
   */
  getHostKey(id: string): string | undefined {
    const table = this.state.get<Record<string, string>>(HOST_KEYS) ?? {};
    return table[id];
  }

  async trustHost(id: string, fingerprint: string): Promise<void> {
    const table = { ...(this.state.get<Record<string, string>>(HOST_KEYS) ?? {}) };
    table[id] = fingerprint;
    await this.state.update(HOST_KEYS, table);
  }

  /** Host ids with a trusted key, sorted. */
  listHostKeys(): { id: string; fingerprint: string }[] {
    const table = this.state.get<Record<string, string>>(HOST_KEYS) ?? {};
    return Object.entries(table)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([id, fingerprint]) => ({ id, fingerprint }))
      .sort((a, b) => a.id.localeCompare(b.id, 'en'));
  }

  async forgetHostKeys(ids: string[]): Promise<void> {
    const table = { ...(this.state.get<Record<string, string>>(HOST_KEYS) ?? {}) };
    for (const id of ids) delete table[id];
    await this.state.update(HOST_KEYS, table);
  }

  async resetHostKeys(): Promise<void> {
    await this.state.update(HOST_KEYS, {});
  }
}
