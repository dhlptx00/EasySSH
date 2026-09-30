import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { expandGlob, loadSshConfig, MissingSshConfig, resolveInclude } from './loadConfig';

describe('loadSshConfig', () => {
  it('follows an include and reports a missing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-ssh-'));
    const ssh = path.join(dir, '.ssh');
    fs.mkdirSync(path.join(ssh, 'config.d'), { recursive: true });
    fs.writeFileSync(path.join(ssh, 'config'), 'Include config.d/*.conf\nHost web\n  HostName 10.1.1.1\n');
    fs.writeFileSync(path.join(ssh, 'config.d', 'extra.conf'), 'Host extra\n  HostName 10.2.2.2\n');
    try {
      const hosts = loadSshConfig(path.join(ssh, 'config'), ssh);
      assert.deepEqual(hosts.map((host) => host.patterns[0]), ['web', 'extra']);
      assert.throws(() => loadSshConfig(path.join(dir, 'missing'), ssh), MissingSshConfig);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expands wildcards in Include paths in sorted order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-ssh-'));
    const ssh = path.join(dir, '.ssh');
    for (const sub of ['a', 'b', 'c']) fs.mkdirSync(path.join(ssh, 'hosts', sub), { recursive: true });
    fs.writeFileSync(path.join(ssh, 'config'), 'Include hosts/*/?.conf hosts/[ab]/extra.conf\n');
    fs.writeFileSync(path.join(ssh, 'hosts', 'b', '2.conf'), 'Host b2\n');
    fs.writeFileSync(path.join(ssh, 'hosts', 'a', '1.conf'), 'Host a1\n');
    fs.writeFileSync(path.join(ssh, 'hosts', 'a', '10.conf'), 'Host a10\n');
    fs.writeFileSync(path.join(ssh, 'hosts', 'a', '.9.conf'), 'Host hidden\n');
    fs.writeFileSync(path.join(ssh, 'hosts', 'b', 'extra.conf'), 'Host bextra\n');
    fs.writeFileSync(path.join(ssh, 'hosts', 'c', 'extra.conf'), 'Host cextra\n');
    try {
      const hosts = loadSshConfig(path.join(ssh, 'config'), ssh);
      assert.deepEqual(hosts.map((host) => host.patterns[0]), ['a1', 'b2', 'bextra']);
      assert.deepEqual(expandGlob(path.join(ssh, 'hosts', 'a', '*.conf')), [
        path.join(ssh, 'hosts', 'a', '1.conf'),
        path.join(ssh, 'hosts', 'a', '10.conf'),
      ]);
      assert.deepEqual(expandGlob(path.join(ssh, 'nope', '*.conf')), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves ~ and relative Include paths', () => {
    const home = path.join(os.tmpdir(), 'home');
    const ssh = path.join(home, '.ssh');
    assert.equal(resolveInclude('~/.ssh/work.conf', ssh, home), path.join(home, '.ssh', 'work.conf'));
    assert.equal(resolveInclude('config.d/*', ssh, home), path.join(ssh, 'config.d', '*'));
    const absolute = path.join(os.tmpdir(), 'x.conf');
    assert.equal(resolveInclude(absolute, ssh, home), absolute);
  });
});
