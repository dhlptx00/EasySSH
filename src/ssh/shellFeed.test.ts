import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SHELL_HOOK, ShellFeed } from './shellFeed';

describe('login shell output', () => {
  it('hides the setup line and keeps the prompt that follows the directory report', () => {
    const feed = new ShellFeed();
    const first = feed.push(`if [ -n "$BASH_VERSION" ]; then PROMPT_COMMAND=ok; fi\r\n\x1b]7;/home/user\x07user@host:~$ `);
    assert.equal(first.prompted, true);
    assert.equal(first.cwd, '/home/user');
    assert.equal(first.text, 'user@host:~$ ');
    assert.equal(feed.ready, true);

    const next = feed.push('ll\r\nbin\r\n\x1b]7;/tmp\x07user@host:/tmp$ ');
    assert.equal(next.cwd, '/tmp');
    assert.equal(next.prompted, true);
    assert.equal(next.text, 'll\nbin\nuser@host:/tmp$ ');
  });

  it('keeps color and waits for an escape sequence split across chunks', () => {
    const feed = new ShellFeed();
    assert.deepEqual(feed.push('\x1b]7;/ho'), { text: '', prompted: false });
    const rest = feed.push('me/user\x07\x1b[01;34mbin\x1b[0m');
    assert.equal(rest.cwd, '/home/user');
    assert.match(rest.text, /\x1b\[01;34mbin/);
  });

  it('shows later output when the shell never reports a directory', () => {
    const feed = new ShellFeed();
    assert.equal(feed.push('welcome\n').text, '');
    feed.release();
    assert.equal(feed.push('$ ').text, '$ ');
  });

  it('installs a prompt hook for bash and zsh', () => {
    assert.match(SHELL_HOOK, /precmd_functions/);
    assert.match(SHELL_HOOK, /PROMPT_COMMAND/);
  });
});
