import type { AuthMethod, ConnectionRecord, JumpSpec } from '../types';
import { expandHome, globMatch } from '../text';
import { parseJumpToken } from './jump';
import type { ParsedHost } from './parseConfig';

/** Which fields ~/.ssh/config actually set (the rest are defaults). */
export interface DefinedFields {
  host: boolean;
  port: boolean;
  user: boolean;
  identity: boolean;
  jumps: boolean;
}

export interface ImportedConnection {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: Extract<AuthMethod, 'privateKey' | 'agent'>;
  privateKeyPath?: string;
  jumps: JumpSpec[];
  defined: DefinedFields;
}

export interface ImportResult {
  connections: ImportedConnection[];
  /** Wildcard and negated patterns. They are defaults for other hosts, not connections. */
  skipped: number;
  /** Hosts reached through ProxyCommand, which Easy SSH cannot run. */
  proxyCommand: string[];
}

function portOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fallback;
  return port;
}

function isWildcard(pattern: string): boolean {
  return pattern.startsWith('!') || /[*?]/.test(pattern);
}

/** OpenSSH Host matching: any pattern matches, and a matching !pattern excludes. */
export function hostBlockMatches(patterns: string[], name: string): boolean {
  let matched = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    if (!pattern || !globMatch(pattern, name)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

/**
 * The settings ssh would use for a host name: every matching Host block in file
 * order, and the first value of each keyword wins (so `Host *` at the end gives
 * defaults, and at the top it overrides).
 */
export function effectiveConfig(hosts: ParsedHost[], name: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const block of hosts) {
    if (!hostBlockMatches(block.patterns, name)) continue;
    for (const [key, values] of Object.entries(block.values)) {
      if (result[key] === undefined && values.length > 0) result[key] = values[0];
    }
  }
  return result;
}

/** %d (home), %u (local user), %h (host), %r (remote user), %% in IdentityFile. */
function expandTokens(value: string, tokens: { home: string; localUser: string; host: string; user: string }): string {
  return value.replace(/%([%dhur])/g, (_whole, token: string) => {
    switch (token) {
      case 'd':
        return tokens.home;
      case 'u':
        return tokens.localUser;
      case 'h':
        return tokens.host;
      case 'r':
        return tokens.user;
      default:
        return '%';
    }
  });
}

interface Resolved {
  host: string;
  port: number;
  username: string;
  keyPath?: string;
  proxyJump?: string;
  proxyCommand?: string;
  defined: DefinedFields;
}

function resolveHost(hosts: ParsedHost[], name: string, envUser: string, home: string): Resolved {
  const config = effectiveConfig(hosts, name);
  const host = config.hostname ? config.hostname.replace(/%h/g, name) : name;
  const username = config.user || envUser;
  const identity = config.identityfile && config.identityfile.toLowerCase() !== 'none' ? config.identityfile : undefined;
  const keyPath = identity ? expandHome(expandTokens(identity, { home, localUser: envUser, host, user: username }), home) : undefined;
  const proxyJump = config.proxyjump && config.proxyjump.toLowerCase() !== 'none' ? config.proxyjump : undefined;
  const proxyCommand = config.proxycommand && config.proxycommand.toLowerCase() !== 'none' ? config.proxycommand : undefined;
  return {
    host,
    port: portOr(config.port, 22),
    username,
    keyPath,
    proxyJump,
    proxyCommand,
    defined: {
      host: config.hostname !== undefined,
      port: config.port !== undefined,
      user: config.user !== undefined,
      identity: keyPath !== undefined,
      jumps: proxyJump !== undefined,
    },
  };
}

function expandProxy(
  field: string | undefined,
  hosts: ParsedHost[],
  aliases: Set<string>,
  envUser: string,
  home: string,
  stack: Set<string>,
): JumpSpec[] {
  if (!field) return [];
  const specs: JumpSpec[] = [];
  for (const token of field.split(',').map((part) => part.trim()).filter(Boolean)) {
    let parsed: ReturnType<typeof parseJumpToken>;
    try {
      parsed = parseJumpToken(token);
    } catch {
      continue;
    }
    // ssh applies the config of the jump's own name (an alias or a plain host).
    const resolved = resolveHost(hosts, parsed.host, envUser, home);
    if (aliases.has(parsed.host) && !stack.has(parsed.host)) {
      const next = new Set(stack);
      next.add(parsed.host);
      specs.push(...expandProxy(resolved.proxyJump, hosts, aliases, envUser, home, next));
    }
    specs.push({
      host: resolved.host,
      port: parsed.port ?? resolved.port,
      username: parsed.username || resolved.username,
      auth: resolved.keyPath ? 'privateKey' : 'agent',
      privateKeyPath: resolved.keyPath,
    });
  }
  return specs;
}

/**
 * Turn parsed host blocks into concrete connections. Wildcard blocks such as
 * `Host *` supply defaults with OpenSSH's first-match rule. Hosts that need a
 * ProxyCommand are reported instead of being imported as direct connections.
 * Without an IdentityFile a host uses the SSH agent, then the default key files.
 */
export function connectionsFromHosts(hosts: ParsedHost[], envUser: string, home: string): ImportResult {
  const names: string[] = [];
  const aliases = new Set<string>();
  let skipped = 0;
  for (const host of hosts) {
    for (const pattern of host.patterns) {
      if (!pattern || isWildcard(pattern)) {
        skipped += 1;
        continue;
      }
      if (!aliases.has(pattern)) {
        aliases.add(pattern);
        names.push(pattern);
      }
    }
  }

  const connections: ImportedConnection[] = [];
  const proxyCommand: string[] = [];
  for (const name of names) {
    const resolved = resolveHost(hosts, name, envUser, home);
    if (resolved.proxyCommand && !resolved.proxyJump) {
      proxyCommand.push(name);
      continue;
    }
    connections.push({
      name,
      host: resolved.host,
      port: resolved.port,
      username: resolved.username,
      auth: resolved.keyPath ? 'privateKey' : 'agent',
      privateKeyPath: resolved.keyPath,
      jumps: expandProxy(resolved.proxyJump, hosts, aliases, envUser, home, new Set([name])),
      defined: resolved.defined,
    });
  }
  return { connections, skipped, proxyCommand };
}

/**
 * Update an existing connection from ~/.ssh/config without losing manual work
 * (B4): fields the config sets are taken from it, the rest (start path, a user
 * or sign-in method set by hand, "ask each time") stay as they are.
 * Returns the merged record and the names of the fields that changed.
 */
export function mergeImported(existing: ConnectionRecord, imported: ImportedConnection): { record: ConnectionRecord; changed: string[] } {
  const record: ConnectionRecord = { ...existing, jumps: existing.jumps.map((jump) => ({ ...jump })) };
  const changed: string[] = [];
  const take = <K extends keyof ConnectionRecord>(key: K, value: ConnectionRecord[K], label: string) => {
    if (JSON.stringify(record[key]) === JSON.stringify(value)) return;
    record[key] = value;
    changed.push(label);
  };
  if (imported.defined.host || existing.host === imported.name) take('host', imported.host, 'host');
  if (imported.defined.port) take('port', imported.port, 'port');
  if (imported.defined.user) take('username', imported.username, 'user');
  if (imported.defined.identity) {
    take('auth', 'privateKey', 'sign-in');
    take('privateKeyPath', imported.privateKeyPath, 'key');
  }
  if (imported.defined.jumps) take('jumps', imported.jumps, 'jump hosts');
  return { record, changed };
}
