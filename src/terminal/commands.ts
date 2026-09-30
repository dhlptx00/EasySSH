export type ConnectionAction =
  | { type: 'connect' }
  | { type: 'new' }
  | { type: 'edit' }
  | { type: 'delete' }
  | { type: 'import' }
  | { type: 'folder' }
  | { type: 'quit' }
  | { type: 'help' }
  | { type: 'unknown'; text: string };

/** Parse a connection-panel command. An empty line connects to the selection. */
export function parseConnectionCommand(input: string): ConnectionAction {
  const text = input.trim();
  if (!text) return { type: 'connect' };
  const match = /^\/(\S+)$/.exec(text);
  if (!match) return { type: 'unknown', text };
  switch (match[1].toLowerCase()) {
    case 'new':
    case 'add':
      return { type: 'new' };
    case 'edit':
    case 'modify':
      return { type: 'edit' };
    case 'delete':
    case 'del':
    case 'rm':
    case 'remove':
      return { type: 'delete' };
    case 'import':
      return { type: 'import' };
    case 'folder':
    case 'download':
      return { type: 'folder' };
    case 'quit':
    case 'exit':
    case 'q':
      return { type: 'quit' };
    case 'help':
    case '?':
      return { type: 'help' };
    default:
      return { type: 'unknown', text };
  }
}
