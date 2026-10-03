import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RawShellTap, normalizeCwd } from './rawShell';

describe('raw shell tap', () => {
  it('shows the MOTD and first prompt, then hides only the setup echo (B12)', () => {
    const tap = new RawShellTap();
    const motd = 'Welcome to Ubuntu\r\n*** System restart required ***\r\nLast login: Mon\r\n';
    assert.equal(tap.push(motd).text, motd);
    assert.equal(tap.push('user@host:~$ ').text, 'user@host:~$ ');
    assert.equal(tap.promptLike(), true);
    tap.hide();
    assert.equal(tap.hiding, true);
    assert.equal(tap.push(' PROMPT_COMMAND=...; history -d\r\n').text, '');
    const first = tap.push('\x1b]7;/home/user\x07user@host:~$ ');
    // The new prompt replaces the one already on screen.
    assert.equal(first.text, '\r\x1b[Juser@host:~$ ');
    assert.equal(first.cwd, '/home/user');
    assert.equal(tap.hiding, false);
  });

  it('moves up over a two-line prompt before replacing it', () => {
    const tap = new RawShellTap();
    tap.push('┌ user@host ~\r\n└ $ ');
    tap.hide();
    const update = tap.push(' hook\r\n\x1b]7;/home/user\x07┌ user@host ~\r\n└ $ ');
    assert.equal(update.text, '\r\x1b[1A\x1b[J┌ user@host ~\r\n└ $ ');
  });

  it('does not clear anything when no prompt was on screen yet (slow login)', () => {
    const tap = new RawShellTap();
    tap.push('Last login: Mon\r\n');
    tap.hide();
    const update = tap.push(' hook\r\n$  hook\r\n\x1b]7;/srv\x07$ ');
    assert.equal(update.text, '$ ');
    assert.equal(update.cwd, '/srv');
  });

  it('keeps mode changes made while the echo was hidden', () => {
    const tap = new RawShellTap();
    tap.push('$ ');
    tap.hide();
    const update = tap.push('\x1b[?2004l\r hook\r\n\x1b]7;/\x07\x1b[?2004h$ ');
    assert.equal(update.bracketedPaste, true);
  });

  it('keeps carriage returns, color, clears, and control bytes', () => {
    const tap = new RawShellTap();
    tap.push('\x1b]7;/\x07');
    const chunk = '\r\n\x1b[H\x1b[2J\x1b[01;31mred\x1b[0m\x1a\x03';
    assert.equal(tap.push(chunk).text, chunk);
  });

  it('waits for a directory report split across chunks', () => {
    const tap = new RawShellTap();
    tap.hide();
    assert.equal(tap.push('echo\x1b]7;/ho').text, '');
    const rest = tap.push('me/user\x07$ ');
    assert.equal(rest.cwd, '/home/user');
    assert.equal(rest.text, '$ ');
  });

  it('tracks the alternate screen and bracketed paste', () => {
    const tap = new RawShellTap();
    const entered = tap.push('\x1b]7;/tmp\x07\x1b[?1049;2004h');
    assert.equal(entered.altScreen, true);
    assert.equal(entered.bracketedPaste, true);
    assert.equal(entered.cwd, '/tmp');
    const left = tap.push('\x1b[?1049l\x1b[?2004l');
    assert.equal(left.altScreen, false);
    assert.equal(left.bracketedPaste, false);
    assert.equal(tap.push('\x1b[?47h').altScreen, true);
    assert.equal(tap.push('\x1b[?1047l').altScreen, false);
  });

  it('holds an unfinished private mode until it completes', () => {
    const tap = new RawShellTap();
    const partial = tap.push('\x1b]7;/\x07\x1b[?104');
    assert.equal(partial.text, '\x1b]7;/\x07');
    assert.equal(partial.altScreen, false);
    const done = tap.push('9h');
    assert.equal(done.text, '\x1b[?1049h');
    assert.equal(done.altScreen, true);
  });

  it('releases held bytes when the shell never reports a directory', () => {
    const tap = new RawShellTap();
    tap.hide();
    assert.equal(tap.push('welcome\r\n').text, '');
    const released = tap.release();
    assert.equal(released.text, 'welcome\r\n');
    assert.equal(tap.push('$ ').text, '$ ');
  });

  it('forwards a large chunk without trimming it', () => {
    const tap = new RawShellTap();
    tap.push('\x1b]7;/\x07');
    const block = 'x'.repeat(200_000);
    assert.equal(tap.push(block).text.length, block.length);
  });

  it('reads a file URL directory report', () => {
    assert.equal(normalizeCwd('file://host/home/user'), '/home/user');
  });

  it('takes the folder only from the Easy SSH hook, not from other programs', () => {
    const tap = new RawShellTap();
    assert.equal(tap.push('\x1b]7;/home/hqxrd\x07$ ').cwd, '/home/hqxrd');
    // A nested ssh or vte.sh reports a file:// URL for another user or host.
    assert.equal(tap.push('\x1b]7;file://db01/root\x07# ').cwd, undefined);
    assert.equal(tap.push('\x1b]7;file://db01/root\x07\x1b]7;/tmp\x07').cwd, '/tmp');
  });

  it('tracks mouse reporting a remote program turns on', () => {
    const tap = new RawShellTap();
    tap.push('\x1b]7;/\x07');
    assert.equal(tap.push('\x1b[?1000h').mouse, true);
    assert.equal(tap.push('x').mouse, true);
    tap.mouseOff();
    assert.equal(tap.push('y').mouse, false);
    assert.equal(tap.push('\x1b[?1049h\x1b[?1049l').leftAlt, true);
  });
});
