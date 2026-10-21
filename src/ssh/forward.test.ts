import assert from 'node:assert/strict';
import net from 'net';
import { describe, it } from 'node:test';
import { formatForward, listenForward, parseForward, parseForwardList, parseLocalForward } from './forward';

describe('forward specs', () => {
  it('reads port, local:remote and local:host:remote in ssh -L order', () => {
    assert.deepEqual(parseForward('3000'), { localPort: 3000, remoteHost: 'localhost', remotePort: 3000 });
    assert.deepEqual(parseForward('8080:3000'), { localPort: 8080, remoteHost: 'localhost', remotePort: 3000 });
    assert.deepEqual(parseForward('5432:db.internal:5432'), { localPort: 5432, remoteHost: 'db.internal', remotePort: 5432 });
    assert.deepEqual(parseForward('9000:[fe80::1]:80'), { localPort: 9000, remoteHost: 'fe80::1', remotePort: 80 });
    assert.throws(() => parseForward('0'), /between 1 and 65535/);
    assert.throws(() => parseForward('abc'), /between 1 and 65535/);
    assert.throws(() => parseForward('80:70000'), /remote port/);
  });

  it('formats back to the short form and reads lists', () => {
    for (const text of ['3000', '8080:3000', '5432:db:5432', '9000:[fe80::1]:80']) assert.equal(formatForward(parseForward(text)), text);
    assert.deepEqual(parseForwardList('3000, 8080:3000').map(formatForward), ['3000', '8080:3000']);
    assert.deepEqual(parseForwardList('none'), []);
    assert.deepEqual(parseForwardList(''), []);
    assert.throws(() => parseForwardList('3000, 3000:4000'), /used twice/);
  });

  it('reads LocalForward lines from ~/.ssh/config', () => {
    assert.deepEqual(parseLocalForward('5432 db:5432'), { localPort: 5432, remoteHost: 'db', remotePort: 5432 });
    assert.deepEqual(parseLocalForward('127.0.0.1:8080 localhost:80'), { localPort: 8080, remoteHost: 'localhost', remotePort: 80 });
    assert.deepEqual(parseLocalForward('9000 [::1]:9000'), { localPort: 9000, remoteHost: '::1', remotePort: 9000 });
    assert.equal(parseLocalForward('/tmp/sock /var/run/x.sock'), undefined);
    assert.equal(parseLocalForward('5432'), undefined);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe('listenForward', () => {
  it('carries a local connection through the tunnel and closes it', async () => {
    const port = await freePort();
    const opened: string[] = [];
    // The "server side" is a local echo socket pair.
    const active = await listenForward({ localPort: port, remoteHost: 'db', remotePort: 5432 }, async (host, remote) => {
      opened.push(`${host}:${remote}`);
      const echo = new net.Socket();
      const server = net.createServer((socket) => socket.pipe(socket));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      echo.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
      echo.on('close', () => server.close());
      return echo;
    }, () => {});
    const reply = await new Promise<string>((resolve) => {
      const client = net.connect(port, '127.0.0.1', () => client.write('ping'));
      client.on('data', (data) => {
        resolve(data.toString());
        client.end();
      });
    });
    assert.equal(reply, 'ping');
    assert.deepEqual(opened, ['db:5432']);
    active.close();
    await assert.rejects(new Promise((resolve, reject) => {
      const again = net.connect(port, '127.0.0.1', () => resolve(again.end()));
      again.on('error', reject);
    }));
  });

  it('refuses a local port that is in use, and logs a tunnel the server refused', async () => {
    const port = await freePort();
    const busy = net.createServer();
    await new Promise<void>((resolve) => busy.listen(port, '127.0.0.1', resolve));
    await assert.rejects(listenForward({ localPort: port, remoteHost: 'localhost', remotePort: 1 }, async () => new net.Socket(), () => {}), /already in use/);
    busy.close();

    const logs: string[] = [];
    const other = await freePort();
    const active = await listenForward({ localPort: other, remoteHost: 'localhost', remotePort: 1 }, async () => {
      throw new Error('administratively prohibited');
    }, (line) => logs.push(line));
    await new Promise<void>((resolve) => {
      const client = net.connect(other, '127.0.0.1');
      client.on('close', () => resolve());
      client.on('error', () => undefined);
    });
    assert.match(logs[0], /^Forward \d+:1: administratively prohibited$/);
    active.close();
  });
});
