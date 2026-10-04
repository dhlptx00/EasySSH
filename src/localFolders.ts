import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { expandHome } from './text';

export interface FolderProbe {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  exists(file: string): boolean;
  /** Run a program and return its stdout, or undefined when it fails. Never blocks the extension host (B15). */
  run(file: string, args: string[]): Promise<string | undefined>;
  readFile(file: string): string | undefined;
}

const USER_SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';
const SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders';

/** Expand %VAR% the way Windows does for REG_EXPAND_SZ values. Names are case-insensitive. */
export function expandWindowsEnv(value: string, env: NodeJS.ProcessEnv): string {
  const lower = new Map(Object.entries(env).map(([key, item]) => [key.toLowerCase(), item]));
  return value.replace(/%([^%]+)%/g, (whole, name: string) => lower.get(name.toLowerCase()) ?? whole);
}

export type KnownFolder = 'Desktop' | 'Downloads';

/** Registry value names in User Shell Folders. Downloads has only a GUID. */
const REG_VALUE: Record<KnownFolder, string> = {
  Desktop: 'Desktop',
  Downloads: '{374DE290-123F-4565-9164-39C4925E467B}',
};

const XDG_KEY: Record<KnownFolder, string> = { Desktop: 'XDG_DESKTOP_DIR', Downloads: 'XDG_DOWNLOAD_DIR' };

const POWERSHELL: Record<KnownFolder, string> = {
  Desktop: "[Environment]::GetFolderPath('Desktop')",
  Downloads: "(New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path",
};

/** A value from `reg query ... /v <name>` output. */
export function parseRegValue(output: string | undefined, name: string): string | undefined {
  if (!output) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escaped}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, 'im').exec(output);
  return match?.[1];
}

/** An XDG user dir from ~/.config/user-dirs.dirs, e.g. "$HOME/桌面". */
export function parseXdgDir(content: string | undefined, home: string, key: string): string | undefined {
  if (!content) return undefined;
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, 'm').exec(content);
  if (!match) return undefined;
  const value = match[1].replace(/^\$HOME(?=\/|$)/, home).replace(/^\$\{HOME\}(?=\/|$)/, home);
  if (!value.startsWith('/') || value === home) return undefined;
  return value;
}

/**
 * The user's real Desktop or Downloads folder.
 * Windows: the registry value Explorer uses, which follows folder redirection
 * (for example \\server\share\user\Desktop on a domain) and OneDrive backup;
 * then PowerShell's known-folder lookup, which also handles non-ASCII paths that
 * reg.exe prints in the console code page. Linux: XDG user dirs. Otherwise ~/Desktop
 * or ~/Downloads. Returns undefined when the folder does not exist.
 */
export async function resolveKnownFolder(probe: FolderProbe, folder: KnownFolder): Promise<string | undefined> {
  const paths = probe.platform === 'win32' ? path.win32 : path.posix;
  const candidates: (() => Promise<string | undefined> | string | undefined)[] = [];
  if (probe.platform === 'win32') {
    const value = REG_VALUE[folder];
    candidates.push(async () => {
      const raw = parseRegValue(await probe.run('reg', ['query', USER_SHELL_FOLDERS, '/v', value]), value);
      return raw ? expandWindowsEnv(raw, probe.env) : undefined;
    });
    candidates.push(async () => parseRegValue(await probe.run('reg', ['query', SHELL_FOLDERS, '/v', value]), value));
    candidates.push(async () => (await probe.run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${POWERSHELL[folder]}`,
    ]))?.trim() || undefined);
  } else if (probe.platform === 'linux') {
    candidates.push(() => parseXdgDir(probe.readFile(paths.join(probe.home, '.config', 'user-dirs.dirs')), probe.home, XDG_KEY[folder]));
  }
  candidates.push(() => paths.join(probe.home, folder));
  for (const candidate of candidates) {
    let found: string | undefined;
    try {
      found = await candidate();
    } catch {
      found = undefined;
    }
    if (found && probe.exists(found)) return found;
  }
  return undefined;
}

export function systemProbe(): FolderProbe {
  return {
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    exists: (file) => {
      try {
        return fs.existsSync(file);
      } catch {
        return false;
      }
    },
    run: (file, args) => new Promise((resolve) => {
      try {
        execFile(file, args, { encoding: 'utf8', timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? undefined : stdout));
      } catch {
        resolve(undefined);
      }
    }),
    readFile: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

export interface SystemFolders {
  downloads?: string;
  desktop?: string;
}

/**
 * Where downloads go: the configured folder when it exists, then Downloads,
 * then the Desktop, then the home folder. (Before 0.2.0 the Desktop came first.)
 */
export function resolveDownloadFolder(
  configured: string | undefined,
  folders: SystemFolders,
  home: string,
  exists: (file: string) => boolean,
): string {
  if (configured && configured.trim()) {
    const expanded = expandHome(configured.trim(), home);
    if (exists(expanded)) return expanded;
  }
  if (folders.downloads && exists(folders.downloads)) return folders.downloads;
  const downloads = localJoin(home, 'Downloads');
  if (exists(downloads)) return downloads;
  if (folders.desktop && exists(folders.desktop)) return folders.desktop;
  return home;
}

/** Words for the download folder in a link tooltip, e.g. "the Desktop" or "~/Downloads". */
export function downloadFolderLabel(folder: string, desktop: string | undefined, home: string): string {
  if (desktop && samePath(folder, desktop)) return 'the Desktop';
  if (home && (folder.startsWith(home + '/') || folder.startsWith(home + '\\'))) return '~' + folder.slice(home.length);
  return folder;
}

/** Join with the separator the home path already uses (\\ on Windows, / elsewhere). */
function localJoin(dir: string, name: string): string {
  return /^[A-Za-z]:|\\/.test(dir) ? path.win32.join(dir, name) : path.posix.join(dir, name);
}

function samePath(a: string, b: string): boolean {
  const clean = (value: string) => value.replace(/[/\\]+$/, '');
  return process.platform === 'win32' ? clean(a).toLowerCase() === clean(b).toLowerCase() : clean(a) === clean(b);
}
