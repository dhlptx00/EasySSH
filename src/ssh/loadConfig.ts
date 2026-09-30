import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseSshConfig, type ParsedHost } from './parseConfig';

export class MissingSshConfig extends Error {
  constructor(readonly filePath: string) {
    super(`No SSH config at ${filePath}`);
    this.name = 'MissingSshConfig';
  }
}

const WILDCARD = /[*?[]/;

/** Translate one path segment of a glob(3) pattern into a regular expression. */
function segmentRegExp(segment: string): RegExp {
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else if (ch === '[') {
      const end = segment.indexOf(']', i + 2);
      if (end === -1) {
        source += '\\[';
        continue;
      }
      let body = segment.slice(i + 1, end);
      if (body.startsWith('!')) body = '^' + body.slice(1);
      source += '[' + body.replace(/\\/g, '\\\\') + ']';
      i = end;
    } else source += ch.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  return new RegExp('^' + source + '$');
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Expand `*`, `?` and `[...]` in an absolute path, one segment at a time.
 * Like glob(3), a wildcard does not match a leading dot and results are sorted.
 * Written by hand because fs.globSync needs Node 22 and the editor may ship Node 18 or 20.
 */
export function expandGlob(pattern: string): string[] {
  if (!WILDCARD.test(pattern)) return fs.existsSync(pattern) ? [pattern] : [];
  const { root } = path.parse(pattern);
  const segments = pattern.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let matches = [root];
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    const next: string[] = [];
    for (const base of matches) {
      if (!WILDCARD.test(segment)) {
        const full = path.join(base, segment);
        if (last ? fs.existsSync(full) : isDirectory(full)) next.push(full);
        continue;
      }
      const re = segmentRegExp(segment);
      for (const name of listDir(base).sort()) {
        if (name.startsWith('.') && !segment.startsWith('.')) continue;
        if (!re.test(name)) continue;
        const full = path.join(base, name);
        if (last || isDirectory(full)) next.push(full);
      }
    }
    matches = next;
  });
  return matches;
}

/** Resolve an Include argument the way ssh does for a user config: `~` is home, relative is under ~/.ssh. */
export function resolveInclude(pattern: string, sshDir: string, home = os.homedir()): string {
  if (pattern === '~') return home;
  if (pattern.startsWith('~/')) return path.join(home, pattern.slice(2));
  return path.isAbsolute(pattern) ? pattern : path.join(sshDir, pattern);
}

/** Read ~/.ssh/config and follow Include directives, up to five levels deep. */
export function loadSshConfig(
  start = path.join(os.homedir(), '.ssh', 'config'),
  sshDir = path.join(os.homedir(), '.ssh'),
): ParsedHost[] {
  if (!fs.existsSync(start)) throw new MissingSshConfig(start);
  const seen = new Set<string>();
  const hosts: ParsedHost[] = [];

  const visit = (file: string, depth: number) => {
    if (depth > 5 || !fs.existsSync(file)) return;
    let real = file;
    try {
      real = fs.realpathSync(file);
    } catch {
      real = file;
    }
    if (seen.has(real)) return;
    seen.add(real);
    const parsed = parseSshConfig(fs.readFileSync(file, 'utf8'));
    hosts.push(...parsed.hosts);
    for (const pattern of parsed.includes) {
      const full = resolveInclude(pattern, sshDir);
      for (const match of expandGlob(full)) visit(match, depth + 1);
    }
  };

  visit(start, 0);
  return hosts;
}
