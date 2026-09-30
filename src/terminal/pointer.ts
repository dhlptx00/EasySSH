export interface PointerEvent {
  action: 'down' | 'up' | 'move' | 'wheel';
  button: number;
  /** 1-based terminal column. */
  col: number;
  /** 1-based terminal row. */
  row: number;
  raw: string;
}

/**
 * Take finished SGR mouse reports out of a keystroke buffer.
 * An unfinished report stays in `held` so it is not typed into the shell.
 */
export function peelPointer(buffer: string): { events: PointerEvent[]; text: string; held: string } {
  const hold = incompleteMouse(buffer);
  const body = hold ? buffer.slice(0, -hold) : buffer;
  const held = hold ? buffer.slice(buffer.length - hold) : '';
  const events: PointerEvent[] = [];
  let text = '';
  const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    text += body.slice(last, match.index);
    events.push(pointerEvent(match));
    last = match.index + match[0].length;
  }
  text += body.slice(last);
  return { events, text, held };
}

function pointerEvent(match: RegExpExecArray): PointerEvent {
  const code = Number(match[1]);
  const col = Number(match[2]);
  const row = Number(match[3]);
  const raw = match[0];
  if ((code & 64) !== 0) return { action: 'wheel', button: code & 1, col, row, raw };
  if ((code & 32) !== 0) return { action: 'move', button: code & 3, col, row, raw };
  const button = code & 3;
  if (match[4] === 'm' || button === 3) {
    return { action: 'up', button: button === 3 ? 0 : button, col, row, raw };
  }
  return { action: 'down', button, col, row, raw };
}

function incompleteMouse(text: string): number {
  const start = text.lastIndexOf('\x1b');
  if (start < 0) return 0;
  const tail = text.slice(start);
  if (tail === '\x1b' || tail === '\x1b[' || tail === '\x1b[<') return tail.length;
  if (/^\x1b\[<[\d;]*$/.test(tail)) return tail.length;
  return 0;
}
