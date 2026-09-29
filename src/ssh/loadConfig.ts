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

function expandGlob(pattern: string): string[] {
  if (!/[*?\[]/.test(pattern)) return fs.existsSync(pattern) ? [pattern] : [];
  return fs.globSync(pattern).map((entry) => String(entry));
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
      const full = path.isAbsolute(pattern) ? pattern : path.join(sshDir, pattern);
      for (const match of expandGlob(full)) visit(match, depth + 1);
    }
  };

  visit(start, 0);
  return hosts;
}
