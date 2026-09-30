import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RawShellTap, normalizeCwd } from './rawShell';

describe('raw shell tap', () => {
  it('hides the setup echo and forwards the prompt unchanged', () => {
    const tap = new RawShellTap();
    const first = tap.push('if [ -n "$ZSH_VERSION" ]; then echo; fi\r\n\x1b]7;/home/user\x07user@host:~$ ');
    assert.equal(first.text, 'user@host:~$ ');
    assert.equal(first.cwd, '/home/user');
    assert.equal(tap.ready, true);
  });

  it('keeps carriage returns, color, clears, and control bytes', () => {
    const tap = new RawShellTap();
    tap.push('\x1b]7;/\x07');
    const chunk = '\r\n\x1b[H\x1b[2J\x1b[01;31mred\x1b[0m\x1a\x03';
    assert.equal(tap.push(chunk).text, chunk);
  });

  it('waits for a directory report split across chunks', () => {
    const tap = new RawShellTap();
    assert.equal(tap.push('banner\x1b]7;/ho').text, '');
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
    assert.equal(partial.text, '');
    assert.equal(partial.altScreen, false);
    const done = tap.push('9h');
    assert.equal(done.text, '\x1b[?1049h');
    assert.equal(done.altScreen, true);
  });

  it('releases held bytes when the shell never reports a directory', () => {
    const tap = new RawShellTap();
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
