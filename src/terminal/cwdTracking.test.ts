import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyStale, FolderFollower, followSteps, isHostSwitch, isUserSwitch, staleUploadQuestion } from './cwdTracking';

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

describe('following cd in a shell without the prompt hook', () => {
  it('turns a submitted line into folder steps', () => {
    assert.deepEqual(followSteps('cd ap', '/www'), [{ kind: 'cd', target: '/www/ap' }]);
    assert.deepEqual(followSteps('cd ..', '/www/phpl'), [{ kind: 'cd', target: '/www' }]);
    assert.deepEqual(followSteps('cd phpl/', '/www'), [{ kind: 'cd', target: '/www/phpl' }]);
    assert.deepEqual(followSteps("cd '/srv/my app'", null), [{ kind: 'cd', target: '/srv/my app' }]);
    assert.deepEqual(followSteps('cd /www && cd ap; ls', '/'), [{ kind: 'cd', target: '/www' }, { kind: 'cd', target: '/www/ap' }]);
    assert.deepEqual(followSteps('cd -P /a/b/../c', null), [{ kind: 'cd', target: '/a/c' }]);
    assert.deepEqual(followSteps('cd -', '/x'), [{ kind: 'back' }]);
    assert.deepEqual(followSteps('ls -la', '/x'), []);
    assert.deepEqual(followSteps('cd~', '/x'), [], 'bash: cd~: command not found');
    assert.deepEqual(followSteps('sudo su', '/x'), [{ kind: 'enter', keepsFolder: true, otherHost: false }]);
    assert.deepEqual(followSteps('sudo su -', '/x'), [{ kind: 'enter', keepsFolder: false, otherHost: false }]);
    assert.deepEqual(followSteps('sudo -i', '/x'), [{ kind: 'enter', keepsFolder: false, otherHost: false }]);
    assert.deepEqual(followSteps('bash', '/x'), [{ kind: 'enter', keepsFolder: true, otherHost: false }]);
    assert.deepEqual(followSteps('bash deploy.sh', '/x'), []);
    assert.deepEqual(followSteps('ssh db01', '/x'), [{ kind: 'enter', keepsFolder: false, otherHost: true }]);
    assert.deepEqual(followSteps('exit', '/x'), [{ kind: 'exit' }]);
    for (const line of [null, 'cd', 'cd ~', 'cd ~/x', 'cd $HOME', 'cd "$(dirname x)"', 'pushd /tmp', 'cd /a || cd /b', 'cd a*', 'cd a b']) {
      assert.deepEqual(followSteps(line, '/x'), [{ kind: 'lost' }], String(line));
    }
    assert.deepEqual(followSteps('cd rel', null), [{ kind: 'lost' }]);
  });

  it('follows the right pane of the report from ~/rocky10.1/redis to /www/ap', async () => {
    const folders = new Set(['/', '/www', '/www/ap', '/www/phpl', '/home/hqxrd/rocky10.1/redis']);
    const isFolder = async (path: string) => folders.has(path);
    const follower = new FolderFollower('/home/hqxrd/rocky10.1/redis');
    for (const line of ['sudo su', 'secret', 'cd /', 'cd~', 'cd /wwww', 'cd wwww', 'cd /www', 'ls', 'cd phpl/', 'cd ..', 'cd ap', 'grok', 'ls']) {
      await follower.apply(line, isFolder);
    }
    assert.equal(follower.cwd, '/www/ap');
    await follower.apply('exit', isFolder);
    assert.equal(follower.cwd, '/home/hqxrd/rocky10.1/redis', 'exit returns to the shell sudo su started from');
  });

  it('forgets the folder instead of guessing, and finds it again on an absolute cd', async () => {
    const isFolder = async () => true;
    const follower = new FolderFollower('/www');
    await follower.apply('sudo su', isFolder);
    await follower.apply(null, isFolder);
    assert.equal(follower.cwd, null);
    await follower.apply('cd sub', isFolder);
    assert.equal(follower.cwd, null);
    await follower.apply('cd /etc', isFolder);
    assert.equal(follower.cwd, '/etc');
    await follower.apply('cd -', isFolder);
    assert.equal(follower.cwd, null);
  });

  it('ignores cd on another machine until it exits', async () => {
    const isFolder = async () => true;
    const follower = new FolderFollower('/srv');
    await follower.apply('ssh db01', isFolder);
    await follower.apply('cd /var/lib/mysql', isFolder);
    assert.equal(follower.cwd, null);
    await follower.apply('exit', isFolder);
    assert.equal(follower.cwd, '/srv');
  });

  it('keeps the folder when the server cannot say, and moves when it is a folder root can enter', async () => {
    const follower = new FolderFollower('/www');
    await follower.apply('cd /root/private', async () => undefined);
    assert.equal(follower.cwd, '/root/private');
    await follower.apply('cd /etc/hosts', async () => false);
    assert.equal(follower.cwd, '/root/private');
  });
});
