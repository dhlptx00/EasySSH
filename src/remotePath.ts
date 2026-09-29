/** POSIX paths for the remote Linux filesystem. */
export function normalizeRemote(input: string): string {
  const absolute = input.startsWith('/');
  const parts: string[] = [];
  for (const part of input.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  if (absolute) return '/' + parts.join('/') || '/';
  return parts.join('/') || '.';
}

export function remoteJoin(dir: string, name: string): string {
  if (!name || name === '.') return normalizeRemote(dir || '/');
  if (name.startsWith('/')) return normalizeRemote(name);
  const base = !dir || dir === '/' ? '' : dir.replace(/\/+$/, '');
  return normalizeRemote(`${base}/${name}`);
}

export function remoteDirname(input: string): string {
  const path = normalizeRemote(input);
  if (path === '/' || path === '.') return '/';
  const index = path.lastIndexOf('/');
  if (index <= 0) return '/';
  return path.slice(0, index);
}

export function remoteBasename(input: string): string {
  const path = normalizeRemote(input);
  if (path === '/') return '/';
  const index = path.lastIndexOf('/');
  return path.slice(index + 1);
}
