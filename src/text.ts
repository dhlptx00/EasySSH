const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Display columns for a single code point. */
export function charWidth(code: number): number {
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += charWidth(code);
  }
  return width;
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  if (width === 1) return '…';
  let used = 0;
  let out = '';
  for (const char of text) {
    const w = charWidth(char.codePointAt(0) ?? 0);
    if (used + w > width - 1) break;
    out += char;
    used += w;
  }
  return `${out}…`;
}

export function padRight(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

export function padLeft(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? ' '.repeat(gap) + text : text;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '');
  return `${rounded} ${units[unit]}`;
}

export function formatTime(ms: number, now = Date.now()): string {
  if (!ms) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const month = MONTHS[date.getMonth()];
  const day = String(date.getDate()).padStart(2, ' ');
  if (date.getFullYear() !== new Date(now).getFullYear()) {
    return `${month} ${day}  ${date.getFullYear()}`;
  }
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month} ${day} ${hours}:${minutes}`;
}

export function shortenPath(input: string, home: string, width: number): string {
  let text = input;
  if (home && (text === home || text.startsWith(home + '/') || text.startsWith(home + '\\'))) {
    text = '~' + text.slice(home.length);
  }
  if (displayWidth(text) <= width) return text;
  if (width <= 1) return '…';
  const keep = width - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return text.slice(0, head) + '…' + text.slice(text.length - tail);
}

export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() || 'download';
  const cleaned = base.replace(/[\u0000-\u001f]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'download';
  return cleaned;
}

export function uniqueLocalPath(dir: string, name: string, exists: (path: string) => boolean): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  const root = dir.replace(/[/\\]+$/, '');
  const target = `${root}${sep}${name}`;
  if (!exists(target)) return target;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${root}${sep}${stem} (${i})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return target;
}

export function expandHome(input: string, home: string): string {
  if (input === '~') return home;
  if (input.startsWith('~/') || input.startsWith('~\\')) return home + input.slice(1);
  return input;
}

export function formatFingerprint(hex: string): string {
  const compact = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(compact) || compact.length % 2 !== 0) return hex;
  const bytes = Buffer.from(compact, 'hex');
  return `SHA256:${bytes.toString('base64').replace(/=+$/, '')}`;
}
