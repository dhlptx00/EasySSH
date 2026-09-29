import type { BrowseEntry } from './types';
import { remoteDirname } from './remotePath';

function rank(entry: BrowseEntry): number {
  return entry.kind === 'dir' ? 0 : 1;
}

export function withParent(cwd: string, entries: BrowseEntry[]): BrowseEntry[] {
  const sorted = [...entries].sort((a, b) => {
    const byKind = rank(a) - rank(b);
    if (byKind !== 0) return byKind;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });
  if (cwd !== '/') {
    sorted.unshift({
      name: '..',
      path: remoteDirname(cwd),
      kind: 'dir',
      size: 0,
      mtime: 0,
    });
  }
  return sorted;
}
