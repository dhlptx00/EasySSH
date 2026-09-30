import { expandHome } from './text';

/** Split a shell-like string, honoring quotes and backslash escapes. */
export function splitShellTokens(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < input.length) {
        i += 1;
        current += input[i];
      } else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      i += 1;
      current += input[i];
      continue;
    }
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
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

function fromFileUrl(token: string): string {
  if (!token.toLowerCase().startsWith('file://')) return token;
  let rest = token.slice('file://'.length);
  if (rest.toLowerCase().startsWith('localhost')) rest = rest.slice('localhost'.length);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    // Keep the raw token when the escape sequence is invalid.
  }
  return rest;
}

function looksLikePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~/') || path.startsWith('~\\') || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * A desktop drop into the terminal arrives as one or more local paths.
 * A single path may contain spaces and may be unquoted. Returns those paths
 * only when every path is an existing local file or folder.
 */
export function classifyDrop(input: string, exists: (path: string) => boolean, home: string): string[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const whole = existingPath(trimmed, exists, home);
  if (whole) return [whole];
  const tokens = splitShellTokens(trimmed).map(fromFileUrl);
  if (tokens.length === 0) return null;
  const paths: string[] = [];
  for (const token of tokens) {
    const found = existingPath(token, exists, home);
    if (!found) return null;
    paths.push(found);
  }
  return paths;
}

function existingPath(token: string, exists: (path: string) => boolean, home: string): string | null {
  let text = token.trim();
  if (text.startsWith("$'") && text.endsWith("'") && text.length >= 3) {
    text = text.slice(2, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  text = fromFileUrl(text);
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    text = text.slice(1, -1);
  }
  const expanded = expandHome(text, home);
  if (!looksLikePath(expanded) || isFilesystemRoot(expanded) || !exists(expanded)) return null;
  return expanded;
}

function isFilesystemRoot(path: string): boolean {
  return path === '/' || path === '\\' || /^[A-Za-z]:\\?$/.test(path);
}
