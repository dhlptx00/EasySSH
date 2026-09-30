export type Key =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'enter'
  | 'backspace'
  | 'escape'
  | 'tab'
  | 'ctrl-c'
  | 'ctrl-d'
  | 'ctrl-u'
  | 'delete'
  | 'pageup'
  | 'pagedown';

export type InputEvent =
  | { type: 'text'; text: string }
  | { type: 'paste'; text: string }
  | { type: 'key'; key: Key }
  | { type: 'mouse'; action: 'down' | 'up' | 'move' | 'wheel'; button: number; col: number; row: number };

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function csiKey(final: string, args: string): Key | undefined {
  if (final === 'A') return 'up';
  if (final === 'B') return 'down';
  if (final === 'C') return 'right';
  if (final === 'D') return 'left';
  if (final === '~' && (args === '3' || args.endsWith(';3'))) return 'delete';
  if (final === '~' && (args === '5' || args.startsWith('5;'))) return 'pageup';
  if (final === '~' && (args === '6' || args.startsWith('6;'))) return 'pagedown';
  return undefined;
}

function isIncomplete(rest: string): boolean {
  if (PASTE_START.startsWith(rest) || PASTE_END.startsWith(rest)) return rest !== PASTE_START && rest !== PASTE_END;
  if (rest === '\x1b' || rest === '\x1b[' || rest === '\x1bO') return true;
  if (/^\x1b\[<[\d;]*$/.test(rest)) return true;
  return /^\x1b\[[0-9;]*$/.test(rest) || /^\x1bO$/.test(rest);
}

function mouseEvent(code: number, col: number, row: number, release: boolean): InputEvent {
  if ((code & 64) !== 0) return { type: 'mouse', action: 'wheel', button: code & 1, col, row };
  if ((code & 32) !== 0) return { type: 'mouse', action: 'move', button: code & 3, col, row };
  const button = code & 3;
  if (release || button === 3) return { type: 'mouse', action: 'up', button: button === 3 ? 0 : button, col, row };
  return { type: 'mouse', action: 'down', button, col, row };
}

/**
 * Decode bytes from the VS Code pseudoterminal into keys, typed text, and pastes.
 * File drops arrive as a paste or as one chunk of quoted paths.
 */
export class InputDecoder {
  private pending = '';
  private pasting = false;
  private paste = '';

  push(chunk: string): InputEvent[] {
    const events: InputEvent[] = [];
    const data = this.pending + chunk;
    this.pending = '';
    let text = '';
    let index = 0;
    const flush = () => {
      if (!text) return;
      events.push({ type: 'text', text });
      text = '';
    };

    while (index < data.length) {
      if (this.pasting) {
        const end = data.indexOf(PASTE_END, index);
        if (end === -1) {
          this.paste += data.slice(index);
          return events;
        }
        this.paste += data.slice(index, end);
        events.push({ type: 'paste', text: this.paste });
        this.paste = '';
        this.pasting = false;
        index = end + PASTE_END.length;
        continue;
      }

      const ch = data[index];
      if (ch !== '\x1b') {
        if (ch === '\r') {
          flush();
          events.push({ type: 'key', key: 'enter' });
          index += 1;
          if (data[index] === '\n') index += 1;
          continue;
        }
        if (ch === '\n') {
          flush();
          events.push({ type: 'key', key: 'enter' });
          index += 1;
          continue;
        }
        if (ch === '\x7f' || ch === '\b') {
          flush();
          events.push({ type: 'key', key: 'backspace' });
          index += 1;
          continue;
        }
        if (ch === '\x03') {
          flush();
          events.push({ type: 'key', key: 'ctrl-c' });
          index += 1;
          continue;
        }
        if (ch === '\x04') {
          flush();
          events.push({ type: 'key', key: 'ctrl-d' });
          index += 1;
          continue;
        }
        if (ch === '\x15') {
          flush();
          events.push({ type: 'key', key: 'ctrl-u' });
          index += 1;
          continue;
        }
        if (ch === '\t') {
          flush();
          events.push({ type: 'key', key: 'tab' });
          index += 1;
          continue;
        }
        if (ch < ' ') {
          index += 1;
          continue;
        }
        text += ch;
        index += 1;
        continue;
      }

      const rest = data.slice(index);
      if (rest === '\x1b') {
        flush();
        events.push({ type: 'key', key: 'escape' });
        index += 1;
        continue;
      }
      if (rest.startsWith(PASTE_START)) {
        flush();
        this.pasting = true;
        index += PASTE_START.length;
        continue;
      }
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
      if (mouse) {
        flush();
        events.push(mouseEvent(Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), mouse[4] === 'm'));
        index += mouse[0].length;
        continue;
      }
      if (rest.startsWith('\x1b[M')) {
        if (rest.length < 6) {
          this.pending = rest;
          break;
        }
        flush();
        events.push(mouseEvent(rest.charCodeAt(3) - 32, rest.charCodeAt(4) - 32, rest.charCodeAt(5) - 32, false));
        index += 6;
        continue;
      }
      if (isIncomplete(rest)) {
        if (rest.length > 32) {
          flush();
          events.push({ type: 'key', key: 'escape' });
          index += 1;
          continue;
        }
        this.pending = rest;
        break;
      }

      const ss3 = /^\x1bO([ABCD])/.exec(rest);
      if (ss3) {
        flush();
        const key = csiKey(ss3[1], '');
        if (key) events.push({ type: 'key', key });
        index += ss3[0].length;
        continue;
      }
      const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
      if (csi) {
        flush();
        const key = csiKey(csi[2], csi[1]);
        if (key) events.push({ type: 'key', key });
        index += csi[0].length;
        continue;
      }
      flush();
      events.push({ type: 'key', key: 'escape' });
      index += 1;
    }

    flush();
    return events;
  }
}
