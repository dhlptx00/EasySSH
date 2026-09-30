/**
 * One line sent to a new login shell. Bash and zsh then report $PWD
 * before each prompt so the file list stays in the same directory.
 */
export const SHELL_HOOK =
  'if [ -n "$ZSH_VERSION" ]; then easy_ssh_cwd() { printf \'\\033]7;%s\\007\' "$PWD"; }; precmd_functions+=(easy_ssh_cwd); elif [ -n "$BASH_VERSION" ]; then PROMPT_COMMAND=${PROMPT_COMMAND:+"$PROMPT_COMMAND;"}' +
  '\'printf "\\033]7;%s\\007" "$PWD"\'; fi';

/** Quote one argument for a remote POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
