import { normalizeRemote, remoteJoin } from '../remotePath';
import type { BrowseEntry } from '../types';

/** A path Tab can finish from a directory listing. */
export interface CompletionQuery {
  /** Absolute directory to list. */
  dir: string;
  /** Name prefix inside that directory. Empty when the token ends in a slash. */
  prefix: string;
  /** `cd` completes directories. Other commands complete files too. */
  dirsOnly: boolean;
}

const DIRECTORY_COMMANDS = new Set(['cd', 'pushd', 'rmdir']);

const PATH_COMMANDS = new Set([
  ...DIRECTORY_COMMANDS,
  'ls', 'll', 'dir', 'cat', 'tac', 'rm', 'cp', 'mv', 'vim', 'vi', 'nvim', 'nano',
  'less', 'more', 'head', 'tail', 'touch', 'mkdir', 'stat', 'file', 'chmod', 'chown',
  'chgrp', 'ln', 'source', '.', 'open', 'tar', 'zip', 'unzip', 'du', 'wc', 'sort',
  'diff', 'bat', 'grep', 'rg', 'find', 'realpath', 'readlink', 'basename', 'dirname',
  'md5sum', 'sha256sum', 'xdg-open',
]);

/**
 * Characters typed since the prompt, when every one of them was sent as itself.
 * Arrows and other cursor moves forget the line so Tab falls through to the shell.
 */
export class InputLine {
  private known = true;
  private value = '';

  reset(): void {
    this.known = true;
    this.value = '';
  }

  forget(): void {
    this.known = false;
    this.value = '';
  }

  /** The line, or null when a cursor move made it unsafe to edit locally. */
  text(): string | null {
    return this.known ? this.value : null;
  }

  /** Apply keystrokes that were forwarded to the shell. */
  observe(text: string): void {
    for (let index = 0; index < text.length; index += 1) {
      const ch = text[index];
      if (ch === '\n' || ch === '\r' || ch === '\x03') {
        this.value = '';
        this.known = true;
        continue;
      }
      if (!this.known) continue;
      if (ch === '\x15') {
        this.value = '';
        continue;
      }
      if (ch === '\x7f' || ch === '\b') {
        this.value = Array.from(this.value).slice(0, -1).join('');
        continue;
      }
      if (ch === '\t') continue;
      if (ch < ' ') {
        this.known = false;
        this.value = '';
        continue;
      }
      this.value += ch;
    }
  }
}

/**
 * Decide whether Tab should finish a path.
 * Quoted text, home shortcuts, and command names return null so the shell receives Tab.
 */
export function completionQuery(line: string, cwd: string): CompletionQuery | null {
  if (!line || /['"`\\]/.test(line)) return null;
  const segment = lastSegment(line);
  if (!segment.trim() || /[<>()]/.test(segment)) return null;
  const trailing = /\s$/.test(segment);
  const parts = segment.trim().split(/[ \t]+/).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const command = parts[0];
  const completingCommand = parts.length === 1 && !trailing;
  const token = completingCommand ? command : trailing ? '' : parts[parts.length - 1];
  if (completingCommand && !token.includes('/')) return null;
  const pathCommand = PATH_COMMANDS.has(command) || command.includes('/');
  if (!pathCommand && !token.includes('/') && !token.startsWith('.')) return null;
  if (token.startsWith('~') || /[*?[\]]/.test(token)) return null;
  const split = splitToken(token, cwd);
  if (!split) return null;
  return {
    dir: split.dir,
    prefix: split.prefix,
    dirsOnly: DIRECTORY_COMMANDS.has(command) && !completingCommand,
  };
}

/**
 * Suffix to insert for a unique name or a longer shared prefix.
 * Null means Tab should be delivered to the shell instead.
 * A directory suffix ends in `/`. A finished file suffix ends in a space.
 */
export function completionSuffix(prefix: string, entries: BrowseEntry[], dirsOnly: boolean): string | null {
  const hidden = prefix.startsWith('.');
  const matches = entries.filter((entry) => {
    if (entry.name === '.' || entry.name === '..') return false;
    if (!hidden && entry.name.startsWith('.')) return false;
    if (!entry.name.startsWith(prefix)) return false;
    if (dirsOnly && entry.kind !== 'dir' && entry.kind !== 'link') return false;
    return true;
  });
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    const only = matches[0];
    const directory = only.kind === 'dir' || (only.kind === 'link' && dirsOnly);
    return escapeBody(only.name.slice(prefix.length)) + (directory ? '/' : ' ');
  }
  const common = sharedPrefix(matches.map((entry) => entry.name));
  if (common.length <= prefix.length) return null;
  return escapeBody(common.slice(prefix.length));
}

function lastSegment(line: string): string {
  let start = 0;
  const marker = /(?:&&|\|\||[|;])/g;
  let found: RegExpExecArray | null;
  while ((found = marker.exec(line))) start = found.index + found[0].length;
  return line.slice(start);
}

function splitToken(token: string, cwd: string): { dir: string; prefix: string } | null {
  const base = cwd.startsWith('/') ? cwd : '/';
  if (token.endsWith('/')) {
    const dir = token.startsWith('/') ? normalizeRemote(token) : remoteJoin(base, token);
    return { dir, prefix: '' };
  }
  const slash = token.lastIndexOf('/');
  if (slash < 0) return { dir: normalizeRemote(base), prefix: token };
  const prefix = token.slice(slash + 1);
  const dirPart = slash === 0 ? '/' : token.slice(0, slash);
  const dir = dirPart.startsWith('/') ? normalizeRemote(dirPart) : remoteJoin(base, dirPart);
  return { dir, prefix };
}

function sharedPrefix(names: string[]): string {
  if (names.length === 0) return '';
  let prefix = names[0];
  for (let index = 1; index < names.length; index += 1) {
    const name = names[index];
    let width = 0;
    const limit = Math.min(prefix.length, name.length);
    while (width < limit && prefix[width] === name[width]) width += 1;
    prefix = prefix.slice(0, width);
    if (!prefix) break;
  }
  return prefix;
}

function escapeBody(body: string): string {
  return body.replace(/[\\ '"$`!*?;&|<>(){}[\]]/g, (ch) => `\\${ch}`);
}
