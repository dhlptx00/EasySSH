import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadSshConfig, MissingSshConfig } from './loadConfig';

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
});
