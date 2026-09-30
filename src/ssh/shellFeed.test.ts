import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SHELL_HOOK } from './shellFeed';

describe('login shell hook', () => {
  it('installs a prompt hook for bash and zsh', () => {
    assert.match(SHELL_HOOK, /precmd_functions/);
    assert.match(SHELL_HOOK, /PROMPT_COMMAND/);
  });
});
