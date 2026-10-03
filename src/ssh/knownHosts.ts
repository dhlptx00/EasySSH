import { createHash, createHmac } from 'crypto';

/**
 * Read-only matching against OpenSSH known_hosts files, plus helpers for host key
 * fingerprints. Supports plain and hashed (|1|salt|hash) host fields, [host]:port,
 * wildcards (* ?), negation (!pattern), and the @revoked marker. @cert-authority
 * lines are ignored (certificates are not used).
 */

export interface KnownHostEntry {
  marker?: 'revoked' | 'cert-authority';
  patterns: string[];
  keyType: string;
  key: Buffer;
}

export type KnownHostsVerdict =
  | { status: 'match' }
  | { status: 'revoked' }
  /** The host is listed with another key of the same type. */
  | { status: 'mismatch'; previous: string }
  | { status: 'unknown' };

/** SHA-256 of a host key blob, hex. The same value ssh2 reports with hostHash: 'sha256'. */
export function keyFingerprint(blob: Buffer): string {
  return createHash('sha256').update(blob).digest('hex');
}

/** The key type name stored at the start of an SSH public key blob, e.g. "ssh-ed25519". */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return '';
  const length = blob.readUInt32BE(0);
  if (length <= 0 || length > 64 || blob.length < 4 + length) return '';
  return blob.subarray(4, 4 + length).toString('latin1');
}

export function parseKnownHosts(text: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    let marker: KnownHostEntry['marker'];
    if (fields[0].startsWith('@')) {
      const name = fields.shift()?.slice(1);
      if (name === 'revoked') marker = 'revoked';
      else if (name === 'cert-authority') marker = 'cert-authority';
      else continue;
    }
    if (fields.length < 3) continue;
    const [hosts, keyType, keyText] = fields;
    if (!/^[A-Za-z0-9+/=]+$/.test(keyText)) continue;
    const key = Buffer.from(keyText, 'base64');
    if (key.length === 0) continue;
    entries.push({ marker, patterns: hosts.split(','), keyType, key });
  }
  return entries;
}

/** The host name as known_hosts writes it: "host" on port 22, "[host]:port" otherwise. */
export function hostField(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function globMatch(pattern: string, value: string): boolean {
  let source = '^';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(source + '$', 'i').test(value);
}

function hashedMatch(pattern: string, value: string): boolean {
  const parts = pattern.split('|');
  if (parts.length !== 4 || parts[1] !== '1') return false;
  try {
    const salt = Buffer.from(parts[2], 'base64');
    const expected = Buffer.from(parts[3], 'base64');
    const actual = createHmac('sha1', salt).update(value).digest();
    return actual.length === expected.length && actual.equals(expected);
  } catch {
    return false;
  }
}

/** True when the host field list matches host:port, honoring negation. */
export function hostMatches(patterns: string[], host: string, port: number): boolean {
  const name = hostField(host, port);
  let matched = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    const hit = pattern.startsWith('|') ? hashedMatch(pattern, name) : globMatch(pattern, name);
    if (!hit) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

/** Look a server key up the way OpenSSH does: any matching line trusts it; @revoked wins. */
export function checkKnownHosts(entries: KnownHostEntry[], host: string, port: number, key: Buffer): KnownHostsVerdict {
  const type = keyTypeOf(key);
  let found = false;
  let previous: string | undefined;
  for (const entry of entries) {
    if (entry.marker === 'cert-authority') continue;
    if (!hostMatches(entry.patterns, host, port)) continue;
    const same = entry.key.equals(key);
    if (entry.marker === 'revoked') {
      if (same) return { status: 'revoked' };
      continue;
    }
    if (same) found = true;
    else if (entry.keyType === type && previous === undefined) previous = keyFingerprint(entry.key);
  }
  if (found) return { status: 'match' };
  if (previous !== undefined) return { status: 'mismatch', previous };
  return { status: 'unknown' };
}

/** One known_hosts line for a trusted key, as OpenSSH would append it (unhashed). */
export function knownHostsLine(host: string, port: number, key: Buffer): string {
  return `${hostField(host, port)} ${keyTypeOf(key)} ${key.toString('base64')}`;
}
