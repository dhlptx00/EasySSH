/**
 * Setup lines sent to a new login shell so it reports $PWD (OSC 7) before each
 * prompt. Each starts with a space: bash with HISTCONTROL=ignorespace/ignoreboth,
 * zsh with HIST_IGNORE_SPACE, and fish keep such lines out of history. The bash
 * line also removes itself from history when it was recorded anyway.
 */

export type ShellKind = 'bash' | 'zsh' | 'fish' | 'other' | 'unknown';

/**
 * Bash: append to PROMPT_COMMAND with a newline, not ";", so a PROMPT_COMMAND
 * that already ends in ";" (e.g. "history -a;") stays valid. For an array
 * PROMPT_COMMAND (bash 5.1+) this changes element 0 only and keeps the rest.
 */
const BASH_PROMPT =
  ` PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND$'\\n'}"'printf "\\033]7;%s\\007" "$PWD"'`;

export const BASH_HOOK =
  `${BASH_PROMPT}; read -r __es_n __es_l <<< "$(HISTTIMEFORMAT= history 1)";`
  + ` [[ $__es_l == *__es_n* ]] && history -d "$__es_n" 2>/dev/null; unset __es_n __es_l`;

export const ZSH_HOOK =
  ` easy_ssh_cwd() { printf '\\033]7;%s\\007' "$PWD"; }; typeset -ga precmd_functions; precmd_functions+=(easy_ssh_cwd)`;

export const FISH_HOOK =
  ` function __easy_ssh_cwd --on-event fish_prompt; printf '\\e]7;%s\\a' $PWD; end`;

/**
 * Used when the login shell could not be detected (the server refused the probe).
 * Works in bash and zsh and is a harmless no-op in other POSIX shells.
 */
export const POSIX_HOOK =
  ` if [ -n "$ZSH_VERSION" ]; then eval 'easy_ssh_cwd() { printf "\\033]7;%s\\007" "$PWD"; }; typeset -ga precmd_functions; precmd_functions+=(easy_ssh_cwd)'; elif [ -n "$BASH_VERSION" ]; then${BASH_PROMPT}; fi`;

/** The hook line for a login shell, or undefined when it cannot report its folder. */
export function hookFor(kind: ShellKind): string | undefined {
  switch (kind) {
    case 'bash':
      return BASH_HOOK;
    case 'zsh':
      return ZSH_HOOK;
    case 'fish':
      return FISH_HOOK;
    case 'unknown':
      return POSIX_HOOK;
    default:
      return undefined;
  }
}

/** Command run on a separate exec channel to learn the login shell. */
export const SHELL_PROBE = 'printf "%s" "$SHELL"';

/**
 * The shell family from the probe output. Empty output, a literal "$SHELL"
 * (cmd.exe), or a non-path means a shell that cannot run the hook.
 */
export function shellKindFromProbe(output: string | undefined): ShellKind {
  if (output === undefined) return 'unknown';
  const text = output.trim();
  if (!text || !/^[/\\A-Za-z]/.test(text) || text.includes('$')) return 'other';
  const base = text.split(/[/\\]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
  if (base === 'bash' || base === 'rbash') return 'bash';
  if (base === 'zsh') return 'zsh';
  if (base === 'fish') return 'fish';
  return 'other';
}

/** Quote one argument for a remote POSIX shell (also valid in fish). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote one argument for the given shell. fish treats backslashes in quotes differently. */
export function quoteFor(kind: ShellKind | undefined, value: string): string {
  if (kind === 'fish') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return shellQuote(value);
}

/** The setup line: the hook, then a cd to the folder to restore (start path or reconnect). */
export function setupLine(kind: ShellKind, restoreDir?: string): string | undefined {
  const hook = hookFor(kind);
  if (!hook) return undefined;
  if (!restoreDir) return hook;
  const target = quoteFor(kind, restoreDir);
  return kind === 'fish' ? `${hook}; cd ${target} 2>/dev/null` : `${hook}; cd -- ${target} 2>/dev/null`;
}
