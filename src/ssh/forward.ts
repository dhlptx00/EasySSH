import net from 'net';
import type { Duplex } from 'stream';
import type { ForwardSpec } from '../types';

function port(value: string, what: string): number {
  const number = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`${what} must be a port between 1 and 65535`);
  return number;
}

/**
 * One forward in `ssh -L` order: `3000` (the same port on the server), `8080:3000`
 * (local 8080 to server port 3000), or `8080:db.internal:5432` (through the server).
 */
export function parseForward(text: string): ForwardSpec {
  const parts = text.trim().split(':');
  if (parts.length === 1) return { localPort: port(parts[0], 'The port'), remoteHost: 'localhost', remotePort: port(parts[0], 'The port') };
  if (parts.length === 2) return { localPort: port(parts[0], 'The local port'), remoteHost: 'localhost', remotePort: port(parts[1], 'The remote port') };
  const host = parts.slice(1, -1).join(':').replace(/^\[(.*)\]$/, '$1');
  if (!host || /\s/.test(host)) throw new Error('Use port, local:remote, or local:host:remote');
  return { localPort: port(parts[0], 'The local port'), remoteHost: host, remotePort: port(parts[parts.length - 1], 'The remote port') };
}

/** Comma or space separated forwards. Empty, "none" and "-" mean none. */
export function parseForwardList(text: string): ForwardSpec[] {
  const value = text.trim();
  if (!value || value === 'none' || value === '-') return [];
  const specs = value.split(/[\s,]+/).filter(Boolean).map(parseForward);
  const ports = new Set<number>();
  for (const spec of specs) {
    if (ports.has(spec.localPort)) throw new Error(`Local port ${spec.localPort} is used twice`);
    ports.add(spec.localPort);
  }
  return specs;
}

/** The short form parseForward reads back: "3000", "8080:3000" or "8080:db:5432". */
export function formatForward(spec: ForwardSpec): string {
  if (spec.remoteHost === 'localhost') return spec.localPort === spec.remotePort ? String(spec.localPort) : `${spec.localPort}:${spec.remotePort}`;
  const host = spec.remoteHost.includes(':') ? `[${spec.remoteHost}]` : spec.remoteHost;
  return `${spec.localPort}:${host}:${spec.remotePort}`;
}

/** `LocalForward [bind:]port host:hostport` from ~/.ssh/config. Unix sockets are not supported. */
export function parseLocalForward(value: string): ForwardSpec | undefined {
  const [listen, target] = value.trim().split(/\s+/);
  if (!listen || !target) return undefined;
  const local = listen.slice(listen.lastIndexOf(':') + 1);
  const colon = target.lastIndexOf(':');
  if (colon <= 0) return undefined;
  try {
    return parseForward(`${local}:${target.slice(0, colon)}:${target.slice(colon + 1)}`);
  } catch {
    return undefined;
  }
}

export type OpenTunnel = (host: string, port: number) => Promise<Duplex>;

export interface ActiveForward {
  spec: ForwardSpec;
  close(): void;
}

/** Listen on 127.0.0.1:localPort and carry each connection through the SSH server. */
export function listenForward(spec: ForwardSpec, open: OpenTunnel, log: (line: string) => void): Promise<ActiveForward> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.pause();
    open(spec.remoteHost, spec.remotePort).then(
      (stream) => {
        stream.on('error', () => socket.destroy());
        socket.on('close', () => stream.destroy());
        stream.on('close', () => socket.destroy());
        socket.pipe(stream).pipe(socket);
        socket.resume();
      },
      (err: unknown) => {
        log(`Forward ${formatForward(spec)}: ${err instanceof Error ? err.message : String(err)}`);
        socket.destroy();
      },
    );
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(err.code === 'EADDRINUSE' ? `Local port ${spec.localPort} is already in use` : err.message));
    });
    server.listen(spec.localPort, '127.0.0.1', () => {
      resolve({
        spec,
        close: () => {
          server.close();
          for (const socket of sockets) socket.destroy();
        },
      });
    });
  });
}
