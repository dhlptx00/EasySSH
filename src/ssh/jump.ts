import type { JumpSpec } from '../types';

export interface ParsedJump {
  host: string;
  port?: number;
  username?: string;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('Jump port must be a number');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Jump port must be between 1 and 65535');
  }
  return port;
}

/** Parse `user@host`, `host:port`, `user@host:port`, or `[ipv6]:port`. */
export function parseJumpToken(token: string): ParsedJump {
  let rest = token.trim();
  if (!rest) throw new Error('Jump host is empty');
  let username: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    username = rest.slice(0, at);
    rest = rest.slice(at + 1);
    if (!username || !rest) throw new Error('Jump host is invalid');
  }

  let host = rest;
  let port: number | undefined;
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end <= 1) throw new Error('Jump host is invalid');
    host = rest.slice(1, end);
    const tail = rest.slice(end + 1);
    if (tail) {
      if (!tail.startsWith(':')) throw new Error('Jump host is invalid');
      port = parsePort(tail.slice(1));
    }
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(rest.slice(colon + 1))) {
      host = rest.slice(0, colon);
      port = parsePort(rest.slice(colon + 1));
    }
  }
  if (!host || /\s/.test(host)) throw new Error('Jump host is invalid');
  return { host, port, username };
}

export function parseJumpList(input: string): ParsedJump[] {
  const parts = input.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  return parts.map(parseJumpToken);
}

export function formatJumps(jumps: JumpSpec[]): string {
  return jumps
    .map((jump) => {
      const host = jump.host.includes(':') ? `[${jump.host}]` : jump.host;
      return `${jump.username}@${host}:${jump.port}`;
    })
    .join(',');
}
