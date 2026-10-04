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

describe('listing and docs (L1–L9)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    version: string;
    displayName: string;
    description: string;
    keywords: string[];
    galleryBanner?: { color: string; theme: string };
    qna?: string;
    activationEvents?: string[];
  };
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

  it('has listing metadata within Marketplace limits', () => {
    assert.ok(pkg.keywords.length >= 10 && pkg.keywords.length <= 30, `${pkg.keywords.length} keywords`);
    assert.equal(new Set(pkg.keywords.map((k) => k.toLowerCase())).size, pkg.keywords.length);
    assert.match(pkg.displayName, /SSH/);
    assert.ok(pkg.description.length <= 200);
    assert.equal(pkg.galleryBanner?.theme, 'dark');
    assert.match(pkg.qna ?? '', /^https:\/\/github\.com\/.+\/discussions$/);
    // Views and commands activate the extension on their own; a restored easyssh: tab needs the file system.
    assert.deepEqual(pkg.activationEvents, ['onFileSystem:easyssh']);
  });

  it('documents the current version in the CHANGELOG with a date', () => {
    assert.match(changelog, new RegExp(`^## \\[${pkg.version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
    assert.match(changelog, new RegExp(`^\\[${pkg.version.replace(/\./g, '\\.')}\\]: https://`, 'm'));
  });

  it('references only images that exist and never describes click-to-cd', () => {
    const images = [...readme.matchAll(/\]\((media\/readme\/[^)]+)\)/g)].map((match) => match[1]);
    assert.ok(images.length >= 15);
    for (const image of images) assert.ok(fs.existsSync(path.join(root, image)), `${image} is missing`);
    assert.doesNotMatch(readme, /click(?:ing)? (?:a |the )?(?:folder|directory)[^.\n]*\bcd\b|`cd` into/i);
    assert.doesNotMatch(readme, /Download[^\n]*to the Desktop \(/);
  });

  it('documents every setting', () => {
    for (const key of Object.keys(manifest.contributes.configuration.properties)) {
      assert.ok(readme.includes(`\`${key}\``), `${key} is not in the README settings table`);
    }
  });
});
