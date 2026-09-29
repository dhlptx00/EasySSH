export interface ParsedHost {
  patterns: string[];
  values: Record<string, string[]>;
}

export interface ParsedConfig {
  hosts: ParsedHost[];
  includes: string[];
}

/** Tokenize one ssh_config line. `=` between a keyword and its value is optional. */
export function tokenizeConfigLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) {
        i += 1;
        current += line[i];
      } else current += ch;
      continue;
    }
    if (ch === '#') break;
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '=') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function cloneValues(source: Record<string, string[]>): Record<string, string[]> {
  const copy: Record<string, string[]> = {};
  for (const [key, values] of Object.entries(source)) copy[key] = [...values];
  return copy;
}

/**
 * Parse an OpenSSH config file.
 * Keywords that appear before the first Host are defaults for every host.
 * Match blocks are ignored.
 */
export function parseSshConfig(text: string): ParsedConfig {
  const hosts: ParsedHost[] = [];
  const includes: string[] = [];
  const globals: Record<string, string[]> = {};
  let current: ParsedHost | undefined;
  let skipping = false;

  for (const raw of text.split(/\r?\n/)) {
    const tokens = tokenizeConfigLine(raw);
    if (tokens.length === 0) continue;
    const key = tokens[0].toLowerCase();
    const args = tokens.slice(1);
    if (key === 'host') {
      skipping = false;
      current = { patterns: args, values: cloneValues(globals) };
      hosts.push(current);
      continue;
    }
    if (key === 'match') {
      skipping = true;
      current = undefined;
      continue;
    }
    if (key === 'include') {
      includes.push(...args);
      continue;
    }
    if (skipping || args.length === 0) continue;
    const target = current ? current.values : globals;
    if (!target[key]) target[key] = [];
    target[key].push(args.join(' '));
  }

  return { hosts, includes };
}
