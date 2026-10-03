import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { BASH_HOOK, FISH_HOOK, POSIX_HOOK, ZSH_HOOK, hookFor, quoteFor, setupLine, shellKindFromProbe } from './shellFeed';

function has(program: string): boolean {
  if (process.platform === 'win32') return false;
  return spawnSync('sh', ['-c', `command -v ${program}`]).status === 0;
}

const OSC7 = '\x1b]7;';

describe('login shell hook', () => {
  it('starts every hook with a space so history skips it (B11)', () => {
    for (const hook of [BASH_HOOK, ZSH_HOOK, FISH_HOOK, POSIX_HOOK]) assert.ok(hook.startsWith(' '), hook);
    assert.match(ZSH_HOOK, /precmd_functions/);
    assert.match(BASH_HOOK, /PROMPT_COMMAND/);
    assert.match(BASH_HOOK, /history -d/);
    assert.match(FISH_HOOK, /--on-event fish_prompt/);
  });

  it('joins PROMPT_COMMAND with a newline, never ";" (B2)', () => {
    assert.doesNotMatch(BASH_HOOK, /PROMPT_COMMAND;/);
    assert.match(BASH_HOOK, /\$'\\n'/);
  });

  it('picks the hook from the probed login shell (U7)', () => {
    assert.equal(shellKindFromProbe('/bin/bash'), 'bash');
    assert.equal(shellKindFromProbe('/usr/bin/zsh\n'), 'zsh');
    assert.equal(shellKindFromProbe('/usr/local/bin/fish'), 'fish');
    assert.equal(shellKindFromProbe('/bin/tcsh'), 'other');
    assert.equal(shellKindFromProbe('$SHELL'), 'other');
    assert.equal(shellKindFromProbe(''), 'other');
    assert.equal(shellKindFromProbe(undefined), 'unknown');
    assert.equal(hookFor('bash'), BASH_HOOK);
    assert.equal(hookFor('fish'), FISH_HOOK);
    assert.equal(hookFor('unknown'), POSIX_HOOK);
    assert.equal(hookFor('other'), undefined);
  });

  it('adds a cd to the folder to restore, quoted for the shell', () => {
    assert.equal(setupLine('bash', "/srv/it's"), `${BASH_HOOK}; cd -- '/srv/it'\\''s' 2>/dev/null`);
    assert.equal(setupLine('fish', '/srv/a\\b'), `${FISH_HOOK}; cd '/srv/a\\\\b' 2>/dev/null`);
    assert.equal(setupLine('other', '/srv'), undefined);
    assert.equal(quoteFor('fish', "it's"), "'it\\'s'");
  });

  it('keeps a PROMPT_COMMAND that ends in ";" working in real bash (B2 regression)', { skip: !has('bash') }, () => {
    for (const before of ['history -a;', 'history -a', '', 'echo -n x; ']) {
      const script = `PROMPT_COMMAND=${JSON.stringify(before)}\n${BASH_HOOK}\neval "$PROMPT_COMMAND"`;
      const run = spawnSync('bash', ['--norc', '-c', script], { encoding: 'utf8', cwd: '/' });
      assert.equal(run.status, 0, `${before}: ${run.stderr}`);
      assert.equal(run.stderr, '', before);
      assert.ok(run.stdout.includes(`${OSC7}/\x07`), before);
    }
  });

  it('reports the folder from zsh precmd', { skip: !has('zsh') }, () => {
    const run = spawnSync('zsh', ['-f', '-c', `${ZSH_HOOK}\nfor f in $precmd_functions; do $f; done`], { encoding: 'utf8', cwd: '/' });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(`${OSC7}/\x07`));
  });

  it('reports the folder from fish on each prompt', { skip: !has('fish') }, () => {
    const run = spawnSync('fish', ['--no-config', '-c', `${FISH_HOOK}; emit fish_prompt`], { encoding: 'utf8', cwd: '/' });
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes(`${OSC7}/\x07`));
  });

  it('is valid sh syntax, so a shell that could not be probed shows no error', { skip: !has('sh') }, () => {
    const run = spawnSync('sh', ['-c', POSIX_HOOK], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
  });
});
