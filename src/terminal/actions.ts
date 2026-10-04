import { remoteBasename, remoteDirname } from '../remotePath';
import { formatSize, formatTime } from '../text';

/** What Ctrl/Cmd+click on a name in the remote shell can do. */
export type FileAction = 'download' | 'upload' | 'open' | 'rename' | 'delete';

/** The file or folder a click landed on. Symlinks are already resolved to what they point at. */
export interface ActionTarget {
  name: string;
  /** Absolute remote path. */
  path: string;
  kind: 'file' | 'folder';
  /** Bytes, for files. Undefined when not known. */
  size?: number;
  /** Milliseconds since the epoch. Zero or undefined when not known. */
  mtime?: number;
  /** Set when the name is a symlink: the absolute path it points to. */
  linkTarget?: string;
}

/** One row of the action menu, or a separator line between groups. */
export interface ActionMenuItem {
  action?: FileAction;
  /** A codicon name, e.g. "cloud-download". */
  icon?: string;
  label: string;
  description?: string;
  separator?: boolean;
}

export interface ActionMenu {
  title: string;
  placeholder: string;
  items: ActionMenuItem[];
}

/** Text files bigger than this ask before Open loads them into an editor tab. */
export const OPEN_ASK_BYTES = 5 * 1024 * 1024;
/** How long the menu waits for the first bytes of a file it cannot classify by name. */
export const SNIFF_MS = 800;
/** Folder delete stops counting at this many files and says "5000+". */
export const DELETE_COUNT_CAP = 5000;
/** Folder delete stops counting after this long. */
export const DELETE_COUNT_MS = 4000;

/** The menu title: the name and the folder it is in, e.g. "report.log — /var/log/app". */
export function actionTitle(target: ActionTarget): string {
  return `${target.name} — ${remoteDirname(target.path)}`;
}

/** Where Upload writes: into a clicked folder (for a file, the folder it is in). */
export function uploadDir(target: ActionTarget): string {
  return target.kind === 'folder' ? target.path : remoteDirname(target.path);
}

/** "File · 48 MB · Sep 30 14:02" or "Folder · 12 items". */
export function targetSummary(target: ActionTarget, items?: number | 'counting', now = Date.now()): string {
  const kind = target.kind === 'folder' ? 'Folder' : 'File';
  const parts: string[] = [target.linkTarget ? `${kind} link → ${target.linkTarget}` : kind];
  if (target.kind === 'file' && target.size !== undefined) parts.push(formatSize(target.size));
  if (target.kind === 'folder' && items === 'counting') parts.push('counting items…');
  else if (target.kind === 'folder' && items !== undefined) parts.push(items === 0 ? 'empty' : `${items} item${items === 1 ? '' : 's'}`);
  const when = target.mtime ? formatTime(target.mtime, now).replace(/\s+/g, ' ') : '';
  if (when) parts.push(`modified ${when}`);
  return `${parts.join(' · ')} — Enter downloads`;
}

/**
 * The action menu for a clicked name. Download comes first, so Enter downloads.
 * Upload is only offered for folders, Open only for text files. Delete is last, on its own.
 */
export function actionMenu(target: ActionTarget, options: { downloadLabel: string; items?: number | 'counting'; now?: number }): ActionMenu {
  const file = target.kind === 'file';
  const into = uploadDir(target);
  const items: ActionMenuItem[] = [
    {
      action: 'download',
      icon: 'cloud-download',
      label: 'Download',
      description: file ? `Save a copy on this computer (${options.downloadLabel})` : `Save the folder and everything in it (${options.downloadLabel})`,
    },
  ];
  // Upload goes into a folder; a file's own folder takes a drop on the terminal instead.
  if (!file) {
    items.push({
      action: 'upload',
      icon: 'cloud-upload',
      label: 'Upload…',
      description: `Upload files from this computer into ${into}`,
    });
  }
  if (file) {
    items.push(
      { action: 'open', icon: 'go-to-file', label: 'Open', description: 'Edit it in a VS Code tab. Saving writes it back to the server' },
    );
  }
  items.push(
    { separator: true, label: '' },
    { action: 'rename', icon: 'pencil', label: 'Rename…', description: `Give the ${file ? 'file' : 'folder'} a new name on the server` },
    { separator: true, label: '' },
    {
      action: 'delete',
      icon: 'trash',
      label: 'Delete…',
      description: file ? 'Delete the file from the server' : 'Delete the folder and everything in it from the server',
    },
  );
  return { title: actionTitle(target), placeholder: targetSummary(target, options.items, options.now), items };
}

/** The part of the name the rename box selects: the name without its extension, for files. */
export function renameSelection(name: string, kind: 'file' | 'folder'): [number, number] {
  if (kind === 'folder') return [0, name.length];
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [0, dot] : [0, name.length];
}

/** Why a new name cannot be used, or undefined when it can (existence is checked separately). */
export function renameProblem(value: string, old: string): string | undefined {
  if (value.length === 0 || value.trim().length === 0) return 'Enter a name';
  if (value.includes('/')) return 'A name cannot contain /';
  if (value.includes('\u0000')) return 'A name cannot contain a NUL character';
  if (value === '.' || value === '..') return `"${value}" is not a valid name`;
  if (value === old) return 'Enter a different name';
  return undefined;
}

export interface TreeCount {
  files: number;
  folders: number;
  /** True when counting stopped at the cap or the time limit, so the real numbers are higher. */
  capped: boolean;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The delete confirmation: a question, and a detail line with the full path. */
export function deleteQuestion(target: ActionTarget, count?: TreeCount): { message: string; detail: string } {
  if (target.linkTarget) {
    return {
      message: `Delete link "${target.name}"?`,
      detail: `${target.path} → ${target.linkTarget}\n\nOnly the link is deleted, not the ${target.kind} it points to.`,
    };
  }
  if (target.kind === 'file') {
    return { message: `Delete file "${target.name}"?`, detail: `${target.path}\n\nThis cannot be undone.` };
  }
  if (!count) {
    return {
      message: `Delete folder "${target.name}" and everything in it?`,
      detail: `${target.path}\n\nThe files in it could not be counted. This cannot be undone.`,
    };
  }
  if (count.files === 0 && count.folders === 0) {
    return { message: `Delete empty folder "${target.name}"?`, detail: `${target.path}\n\nThis cannot be undone.` };
  }
  const files = count.capped ? `${count.files}+ files` : plural(count.files, 'file');
  const folders = count.folders > 0 ? ` in ${count.capped ? `${count.folders}+` : count.folders} subfolder${count.folders === 1 && !count.capped ? '' : 's'}` : '';
  return {
    message: `Delete folder "${target.name}" and its ${files}?`,
    detail: `${target.path}\n\nContains ${files}${folders}. Everything in it is deleted. This cannot be undone.`,
  };
}

/** The question before Open loads a big text file into an editor tab. */
export function largeOpenQuestion(target: ActionTarget, size: number): { message: string; detail: string } {
  return {
    message: `"${target.name}" is ${formatSize(size)}. Open it in an editor?`,
    detail: `${target.path}

The whole file is loaded over SSH before the tab opens, and saving sends all of it back. Download saves a copy on this computer instead.`,
  };
}

/** The rename confirmation. */
export function renameQuestion(target: ActionTarget, next: string): { message: string; detail: string } {
  return {
    message: `Rename "${target.name}" to "${next}"?`,
    detail: `In ${remoteDirname(target.path)}`,
  };
}

/** A short form of a remote folder for a button label, e.g. "…/project". */
export function shortRemote(dir: string, width = 40): string {
  if (dir.length <= width) return dir;
  return `…/${remoteBasename(dir)}`;
}

/** Keep only the actions in can, without leading, trailing, or doubled separators. */
export function onlyActions(items: ActionMenuItem[], can: ReadonlySet<FileAction>): ActionMenuItem[] {
  const kept = items.filter((item) => item.separator || (item.action !== undefined && can.has(item.action)));
  const out: ActionMenuItem[] = [];
  for (const item of kept) {
    if (item.separator && (out.length === 0 || out[out.length - 1].separator)) continue;
    out.push(item);
  }
  while (out.length > 0 && out[out.length - 1].separator) out.pop();
  return out;
}
