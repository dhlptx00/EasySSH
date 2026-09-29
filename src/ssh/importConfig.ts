import type { AuthMethod, JumpSpec } from '../types';
import { expandHome } from '../text';
import { parseJumpToken } from './jump';
import type { ParsedHost } from './parseConfig';

export interface ImportedConnection {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: Extract<AuthMethod, 'privateKey' | 'agent'>;
  privateKeyPath?: string;
  jumps: JumpSpec[];
}

function first(values: string[] | undefined): string | undefined {
  return values && values.length > 0 ? values[0] : undefined;
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

function expandProxy(
  field: string | undefined,
  blocks: Map<string, ParsedHost>,
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
    const alias = blocks.get(parsed.host);
    if (alias && !stack.has(parsed.host)) {
      const next = new Set(stack);
      next.add(parsed.host);
      specs.push(...expandProxy(first(alias.values.proxyjump), blocks, envUser, home, next));
    }
    const identity = alias ? first(alias.values.identityfile) : undefined;
    const keyPath = identity ? expandHome(identity, home) : undefined;
    specs.push({
      host: alias ? first(alias.values.hostname) || parsed.host : parsed.host,
      port: parsed.port ?? portOr(alias ? first(alias.values.port) : undefined, 22),
      username: parsed.username || (alias ? first(alias.values.user) : undefined) || envUser,
      auth: keyPath ? 'privateKey' : 'agent',
      privateKeyPath: keyPath,
    });
  }
  return specs;
}

/** Turn parsed host blocks into concrete connections. The first Host wins. */
export function connectionsFromHosts(
  hosts: ParsedHost[],
  envUser: string,
  home: string,
): { connections: ImportedConnection[]; skipped: number } {
  const blocks = new Map<string, ParsedHost>();
  let skipped = 0;
  for (const host of hosts) {
    for (const pattern of host.patterns) {
      if (!pattern || isWildcard(pattern)) {
        skipped += 1;
        continue;
      }
      if (!blocks.has(pattern)) blocks.set(pattern, host);
    }
  }

  const connections: ImportedConnection[] = [];
  for (const [name, block] of blocks) {
    const identity = first(block.values.identityfile);
    const keyPath = identity ? expandHome(identity, home) : undefined;
    connections.push({
      name,
      host: first(block.values.hostname) || name,
      port: portOr(first(block.values.port), 22),
      username: first(block.values.user) || envUser,
      auth: keyPath ? 'privateKey' : 'agent',
      privateKeyPath: keyPath,
      jumps: expandProxy(first(block.values.proxyjump), blocks, envUser, home, new Set([name])),
    });
  }
  return { connections, skipped };
}
