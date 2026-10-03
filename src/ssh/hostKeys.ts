import { checkKnownHosts, keyFingerprint, type KnownHostEntry } from './knownHosts';

export type HostKeyPolicy = 'ask' | 'trustFirst';

/** One hop of a connection, for host key checks. */
export interface HostKeyHop {
  host: string;
  port: number;
  /**
   * Where Easy SSH stores the key: "host:port" for the first hop, and
   * "jump:22>host:port" behind jump hosts, so the same private address on two
   * networks does not collide.
   */
  id: string;
  /** The key used before 0.2.0 ("host:port" for every hop). */
  legacyId: string;
}

export interface HostKeyLookup {
  get(id: string): string | undefined;
}

export type HostKeyDecision =
  | { action: 'trust'; source: 'known_hosts' | 'easy-ssh' | 'accepted' }
  | { action: 'ask'; kind: 'unknown' | 'changed'; fingerprint: string; previous?: string }
  | { action: 'store'; fingerprint: string }
  | { action: 'reject'; kind: 'revoked'; fingerprint: string };

/** Ids for each hop of a chain, outermost first. */
export function hopIds(hops: { host: string; port: number }[]): HostKeyHop[] {
  const result: HostKeyHop[] = [];
  let chain = '';
  for (const hop of hops) {
    const self = `${hop.host}:${hop.port}`;
    const id = chain ? `${chain}>${self}` : self;
    result.push({ host: hop.host, port: hop.port, id, legacyId: self });
    chain = id;
  }
  return result;
}

/**
 * Decide what to do with a server's host key:
 * 1. a matching line in ~/.ssh/known_hosts trusts it, and @revoked rejects it;
 * 2. a key the user accepted on this attempt, or the one Easy SSH stored, trusts it;
 * 3. a different stored key (Easy SSH or known_hosts, same type) is "changed" and asks;
 * 4. an unknown key asks (policy "ask") or is stored (policy "trustFirst").
 */
export function decideHostKey(
  hop: HostKeyHop,
  key: Buffer,
  knownHosts: KnownHostEntry[],
  store: HostKeyLookup,
  policy: HostKeyPolicy,
  accepted: ReadonlyMap<string, string>,
): HostKeyDecision {
  const fingerprint = keyFingerprint(key);
  const verdict = checkKnownHosts(knownHosts, hop.host, hop.port, key);
  if (verdict.status === 'revoked') return { action: 'reject', kind: 'revoked', fingerprint };
  if (verdict.status === 'match') return { action: 'trust', source: 'known_hosts' };
  if (accepted.get(hop.id) === fingerprint) return { action: 'trust', source: 'accepted' };
  const stored = store.get(hop.id) ?? (hop.id === hop.legacyId ? undefined : store.get(hop.legacyId));
  if (stored === fingerprint) return { action: 'trust', source: 'easy-ssh' };
  if (stored !== undefined) return { action: 'ask', kind: 'changed', fingerprint, previous: stored };
  if (verdict.status === 'mismatch') return { action: 'ask', kind: 'changed', fingerprint, previous: verdict.previous };
  if (policy === 'trustFirst') return { action: 'store', fingerprint };
  return { action: 'ask', kind: 'unknown', fingerprint };
}
