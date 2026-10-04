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

export interface SlashCommand {
  name: string;
  aliases: string[];
  description: string;
  /** Connections and system commands stay in separate menu groups. */
  group: 'connection' | 'command';
  connectionId?: string;
}

export interface SlashTarget {
  id: string;
  name: string;
  description: string;
}

/** System commands shown in the slash picker, in menu order. */
const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'new', aliases: ['add'], description: 'Add a connection', group: 'command' },
  { name: 'edit', aliases: ['modify'], description: 'Choose a connection to edit', group: 'command' },
  { name: 'delete', aliases: ['del', 'rm', 'remove'], description: 'Choose a connection to delete', group: 'command' },
  { name: 'import', aliases: [], description: 'Import hosts from ~/.ssh/config', group: 'command' },
  { name: 'folder', aliases: ['download'], description: 'Choose the download folder', group: 'command' },
  { name: 'quit', aliases: ['exit', 'q'], description: 'Close the terminal', group: 'command' },
];

const RESERVED = new Set(SLASH_COMMANDS.flatMap((command) => [command.name, ...command.aliases]));

/** True when a connection name would steal a system command such as /new or /quit. */
export function isReservedCommand(name: string): boolean {
  return RESERVED.has(rawConnectionToken(name).toLowerCase());
}

/** Slash token for a connection name. Spaces become hyphens. The typed case is kept. */
export function rawConnectionToken(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  if (!/\s/.test(trimmed)) return trimmed;
  return trimmed.replace(/\s+/g, '-');
}

/** Stable tokens for the current connection list. Reserved names and duplicates gain a numeric suffix. */
export function assignConnectionTokens(targets: SlashTarget[]): Map<string, string> {
  const used = new Set<string>(RESERVED);
  const tokens = new Map<string, string>();
  for (const target of targets) {
    const base = rawConnectionToken(target.name) || 'host';
    let token = base;
    let suffix = 2;
    while (used.has(token.toLowerCase())) {
      token = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(token.toLowerCase());
    tokens.set(target.id, token);
  }
  return tokens;
}

/**
 * Slash matches for a typed line. Connections come first, then system commands.
 * A system-command name prefix wins over that command's aliases, so `/e` matches
 * edit and not quit's `exit`. A space, or text that does not start with `/`, closes the list.
 */
export function matchSlashCommands(input: string, targets: SlashTarget[] = []): SlashCommand[] {
  const text = input.trim();
  if (!text.startsWith('/')) return [];
  const query = text.slice(1).toLowerCase();
  if (/\s/.test(query)) return [];
  const tokens = assignConnectionTokens(targets);
  const connections: SlashCommand[] = targets.map((target) => ({
    name: tokens.get(target.id) ?? target.name,
    aliases: [],
    description: target.description,
    group: 'connection',
    connectionId: target.id,
  }));
  const connectionMatches = query
    ? connections.filter((command) => command.name.toLowerCase().startsWith(query))
    : connections;
  return [...connectionMatches, ...systemMatches(query)];
}

function systemMatches(query: string): SlashCommand[] {
  if (!query) return SLASH_COMMANDS.slice();
  const byName = SLASH_COMMANDS.filter((command) => command.name.startsWith(query));
  if (byName.length > 0) return byName;
  return SLASH_COMMANDS.filter((command) => command.aliases.some((alias) => alias.startsWith(query)));
}

/** Highlight an exact system command before a connection that merely shares a prefix. */
export function defaultSlashPick(matches: SlashCommand[], input: string): number {
  const query = input.trim().replace(/^\//, '').toLowerCase();
  if (!query) return 0;
  const command = matches.findIndex((item) => item.group === 'command' && (item.name === query || item.aliases.includes(query)));
  if (command >= 0) return command;
  const connection = matches.findIndex((item) => item.group === 'connection' && item.name.toLowerCase() === query);
  if (connection >= 0) return connection;
  return 0;
}

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
