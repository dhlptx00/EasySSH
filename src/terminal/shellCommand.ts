export type RemoteCommand =
  | { type: 'empty' }
  | { type: 'exit' }
  | { type: 'cd'; path: string }
  | { type: 'run'; command: string };

/** Drop terminal control sequences so command output cannot redraw the screen. */
export function visibleOutput(text: string): string {
  const stripped = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
  let out = '';
  for (const char of stripped) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code >= 32) out += char;
  }
  return out;
}

/** A bare `cd` changes the listed directory. Anything else runs on the server. */
export function parseRemoteCommand(line: string): RemoteCommand {
  const trimmed = line.trim();
  if (!trimmed) return { type: 'empty' };
  if (trimmed === 'exit' || trimmed === 'logout') return { type: 'exit' };
  if (!/[;&|]/.test(trimmed)) {
    const cd = /^cd(?:\s+([\s\S]+))?$/.exec(trimmed);
    if (cd) {
      const raw = (cd[1] ?? '').trim();
      return { type: 'cd', path: raw ? unquote(raw) : '~' };
    }
  }
  return { type: 'run', command: trimmed };
}

function unquote(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}
