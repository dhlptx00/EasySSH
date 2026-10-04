import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BINARY_EXTENSIONS, TEXT_EXTENSIONS, classifyName, extensionOf, looksLikeText } from './fileTypes';

describe('file types: which files the menu offers to Open', () => {
  it('knows text files by extension and by whole name, ignoring case', () => {
    for (const name of ['notes.txt', 'README.md', 'app.YAML', 'config.yml', 'report.log', 'nginx.conf', 'deploy.sh', 'main.py', 'index.ts', 'data.CSV', '.env', 'prod.env', 'id_ed25519.pub', '.gitignore', 'package-lock.json', 'app.min.js', 'site.nginx']) {
      assert.equal(classifyName(name), 'text', name);
    }
    for (const name of ['Dockerfile', 'dockerfile', 'Makefile', 'Jenkinsfile', 'README', 'LICENSE', '.bashrc', '.bash_profile', 'authorized_keys', 'known_hosts', 'config', 'hosts', 'crontab', 'CHANGELOG']) {
      assert.equal(classifyName(name), 'text', name);
    }
  });

  it('knows binary files by extension, including versioned shared libraries', () => {
    for (const name of ['backup-2026-10-01.tar.gz', 'site.TGZ', 'photo.JPG', 'logo.png', 'manual.pdf', 'app.jar', 'tool.exe', 'libc.so', 'libssl.so.3', 'libfoo.so.1.2', 'disk.iso', 'db.sqlite3', 'cert.p12', '.main.c.swp', 'archive.7z', 'font.woff2']) {
      assert.equal(classifyName(name), 'binary', name);
    }
  });

  it('leaves other names to a sniff of the content', () => {
    for (const name of ['notes', 'run', 'data.xyz', 'backup.2026', 'trailing.', '.hidden', 'id_ed25519', 'libfoo.so.x']) {
      assert.equal(classifyName(name), 'unknown', name);
    }
  });

  it('takes the extension after the last dot, lower-cased', () => {
    assert.equal(extensionOf('a.tar.GZ'), 'gz');
    assert.equal(extensionOf('.env'), 'env');
    assert.equal(extensionOf('Makefile'), '');
    assert.equal(extensionOf('name.'), '');
  });

  it('the lists do not overlap', () => {
    for (const extension of TEXT_EXTENSIONS) assert.equal(BINARY_EXTENSIONS.has(extension), false, extension);
  });

  it('sniffs: no NUL and valid UTF-8 is text, a cut-off last character is fine', () => {
    assert.equal(looksLikeText(Buffer.from('#!/bin/sh\necho hi\n')), true);
    assert.equal(looksLikeText(Buffer.alloc(0)), true);
    assert.equal(looksLikeText(Buffer.from('Grüße, 日本語, emoji 😀\n')), true);
    const euro = Buffer.from('price €');
    assert.equal(looksLikeText(euro.subarray(0, euro.length - 1)), true, 'truncated multibyte at the end');
    assert.equal(looksLikeText(Buffer.from([0x68, 0x00, 0x69])), false, 'NUL byte');
    assert.equal(looksLikeText(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])), false, 'ELF header');
    assert.equal(looksLikeText(Buffer.from([0x1f, 0x8b, 0x08, 0x00])), false, 'gzip header');
    assert.equal(looksLikeText(Buffer.from('caf\xe9 latin-1', 'latin1')), false, 'Latin-1 is not UTF-8');
    assert.equal(looksLikeText(Buffer.from([0xc0, 0xaf])), false, 'overlong');
    assert.equal(looksLikeText(Buffer.from([0xed, 0xa0, 0x80])), false, 'surrogate');
    assert.equal(looksLikeText(Buffer.from([0xe2, 0x28, 0xa1])), false, 'bad continuation');
  });
});
