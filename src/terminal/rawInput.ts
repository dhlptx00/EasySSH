const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export interface RawInputPiece {
  kind: 'bytes' | 'paste';
  text: string;
}

/**
 * Split terminal input into keystrokes and bracketed pastes.
 * A trailing prefix of the paste marker is kept so Escape can still be recognized
 * on the next chunk. Newlines inside a paste are preserved.
 */
export function pullRawInput(buffer: string): { pieces: RawInputPiece[]; rest: string } {
  const pieces: RawInputPiece[] = [];
  let index = 0;
  while (index < buffer.length) {
    const start = buffer.indexOf(PASTE_START, index);
    if (start < 0) {
      const keep = markerPrefix(buffer.slice(index), PASTE_START);
      const emit = buffer.slice(index, buffer.length - keep);
      if (emit) pieces.push({ kind: 'bytes', text: emit });
      return { pieces, rest: buffer.slice(buffer.length - keep) };
    }
    if (start > index) pieces.push({ kind: 'bytes', text: buffer.slice(index, start) });
    const end = buffer.indexOf(PASTE_END, start + PASTE_START.length);
    if (end < 0) {
      if (buffer.length - start > 4_000_000) {
        pieces.push({ kind: 'paste', text: buffer.slice(start + PASTE_START.length) });
        return { pieces, rest: '' };
      }
      return { pieces, rest: buffer.slice(start) };
    }
    pieces.push({ kind: 'paste', text: buffer.slice(start + PASTE_START.length, end) });
    index = end + PASTE_END.length;
  }
  return { pieces, rest: '' };
}

export function encodePaste(text: string, bracketed: boolean): string {
  return bracketed ? `${PASTE_START}${text}${PASTE_END}` : text;
}

function markerPrefix(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let length = max; length > 0; length -= 1) {
    if (marker.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}
