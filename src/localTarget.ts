import fs from 'fs';
import path from 'path';

/**
 * Local names handed out but not written yet. Two terminals downloading
 * "x.txt" at the same moment would otherwise both pick "x.txt" (B13).
 */
const reserved = new Set<string>();

function keyOf(file: string, platform: NodeJS.Platform): string {
  return platform === 'win32' || platform === 'darwin' ? file.toLowerCase() : file;
}

/** "name (1).ext" for files, "name (1)" for folders. */
export function numberedName(name: string, index: number, kind: 'file' | 'folder'): string {
  if (index === 0) return name;
  const dot = kind === 'file' ? name.lastIndexOf('.') : -1;
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${stem} (${index})${ext}`;
}

export interface LocalTarget {
  path: string;
  release(): void;
}

/**
 * A free local path in dir for name, numbered when taken, and reserved in this
 * process until release() so a concurrent download cannot pick it too.
 */
export function reserveLocalTarget(
  dir: string,
  name: string,
  kind: 'file' | 'folder',
  exists: (file: string) => boolean = fs.existsSync,
  platform: NodeJS.Platform = process.platform,
): LocalTarget {
  const join = /^[A-Za-z]:|\\/.test(dir) ? path.win32.join : path.posix.join;
  for (let index = 0; index < 10000; index += 1) {
    const candidate = join(dir, numberedName(name, index, kind));
    const key = keyOf(candidate, platform);
    if (reserved.has(key) || exists(candidate)) continue;
    reserved.add(key);
    let released = false;
    return {
      path: candidate,
      release: () => {
        if (released) return;
        released = true;
        reserved.delete(key);
      },
    };
  }
  throw new Error(`No free name for ${name} in ${dir}`);
}

/**
 * Unique names inside one folder being written, e.g. two remote files that differ
 * only in case on a case-insensitive disk, or that sanitize to the same name.
 */
export class NameSet {
  private readonly used = new Set<string>();

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  take(name: string, kind: 'file' | 'folder'): string {
    for (let index = 0; ; index += 1) {
      const candidate = numberedName(name, index, kind);
      const key = keyOf(candidate, this.platform);
      if (this.used.has(key)) continue;
      this.used.add(key);
      return candidate;
    }
  }
}
