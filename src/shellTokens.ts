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
 * Returns those paths only when every token is an existing local file or folder.
 */
export function classifyDrop(input: string, exists: (path: string) => boolean, home: string): string[] | null {
  const tokens = splitShellTokens(input.trim()).map(fromFileUrl);
  if (tokens.length === 0) return null;
  const paths: string[] = [];
  for (const token of tokens) {
    const expanded = expandHome(token, home);
    if (!looksLikePath(expanded) || isFilesystemRoot(expanded) || !exists(expanded)) return null;
    paths.push(expanded);
  }
  return paths;
}

function isFilesystemRoot(path: string): boolean {
  return path === '/' || path === '\\' || /^[A-Za-z]:\\?$/.test(path);
}
