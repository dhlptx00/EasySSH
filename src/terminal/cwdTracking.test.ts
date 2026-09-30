import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyStale, isHostSwitch, isUserSwitch, staleUploadQuestion } from './cwdTracking';

describe('shell switch detection', () => {
  it('recognizes commands that start a shell as another user', () => {
    for (const line of ['sudo su', 'sudo su -', 'sudo -i', 'sudo -s', 'sudo -iu app', 'sudo -u app bash', 'sudo -E su', 'su', 'su - app', 'sudo /bin/bash', 'doas -s', 'newgrp docker', 'machinectl shell app@']) {
      assert.equal(isUserSwitch(line), true, line);
    }
    for (const line of ['sudo systemctl restart nginx', 'sudo -S ls', 'sudo -l', 'sudo -u app ls', 'ls', 'sudoku', 'summary', '', null]) {
      assert.equal(isUserSwitch(line), false, String(line));
    }
  });

  it('recognizes commands that open another machine or container', () => {
    assert.equal(isHostSwitch('ssh db01'), true);
    assert.equal(isHostSwitch('docker exec -it web bash'), true);
    assert.equal(isHostSwitch('kubectl exec -it pod -- sh'), true);
    assert.equal(isHostSwitch('docker ps'), false);
    assert.equal(classifyStale(['cd /tmp', 'sudo su', 'ssh x']), 'user');
    assert.equal(classifyStale([null, 'vim a']), 'unknown');
  });

  it('explains a stale folder in words the user can act on', () => {
    const question = staleUploadQuestion({ kind: 'host', command: 'ssh db01', everReported: true }, '/home/hqxrd', 'hqxrd', 'web01', ['a.txt'], '/home/hqxrd');
    assert.match(question.detail, /Uploads still go to web01 as hqxrd/);
    const never = staleUploadQuestion({ kind: 'unknown', command: null, everReported: false }, '/root', 'root', 'h', ['a', 'b']);
    assert.match(never.message, /Upload 2 items\?/);
    assert.match(never.detail, /does not report its current folder/);
  });
});
