import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string }[]; configuration: { properties: Record<string, { default?: unknown; markdownDescription?: string }> } };
};

function source(file: string): string {
  return fs.readFileSync(path.join(root, 'src', file), 'utf8');
}

describe('package.json', () => {
  it('declares every setting the code reads, with a default and a description', () => {
    const code = source('controller.ts') + source('sidebar.ts');
    const read = new Set([...code.matchAll(/settings\(\)\.get(?:<[^>]+>)?\('([A-Za-z]+)'\)|config\.get(?:<[^>]+>)?\('([A-Za-z]+)'\)/g)].map((match) => match[1] ?? match[2]));
    const declared = manifest.contributes.configuration.properties;
    assert.ok(read.size >= 10, [...read].join(','));
    for (const key of read) {
      const entry = declared[`easySsh.${key}`];
      assert.ok(entry, `easySsh.${key} is not in package.json`);
      assert.ok('default' in entry, `easySsh.${key} has no default`);
      assert.ok(entry.markdownDescription, `easySsh.${key} has no description`);
    }
  });

  it('contributes every command the extension registers', () => {
    const registered = [...source('extension.ts').matchAll(/registerCommand\('([^']+)'/g)].map((match) => match[1]);
    const contributed = manifest.contributes.commands.map((item) => item.command);
    assert.deepEqual([...registered].sort(), [...contributed].sort());
  });

  it('ships the Pageant helper next to the bundle', () => {
    const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split(/\r?\n/);
    assert.ok(!ignore.some((line) => /^dist\b/.test(line) || line === '**/*.exe'));
    assert.match(fs.readFileSync(path.join(root, 'esbuild.js'), 'utf8'), /pagent\.exe/);
  });

  it('never describes folder clicks as cd anymore', () => {
    const settings = JSON.stringify(manifest.contributes.configuration.properties);
    assert.doesNotMatch(settings, /\bcd\b|change directory|enter (the )?folder/i);
  });
});
