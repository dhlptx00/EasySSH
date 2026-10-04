import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  downloadFolderLabel,
  expandWindowsEnv,
  parseRegValue,
  parseXdgDir,
  resolveDownloadFolder,
  resolveKnownFolder,
  type FolderProbe,
} from './localFolders';

const env = { USERPROFILE: 'C:\\Users\\hqxrd', USERNAME: 'hqxrd', OneDrive: 'C:\\Users\\hqxrd\\OneDrive - LGroup' };

function winProbe(folders: Set<string>, answers: Record<string, string | undefined>): FolderProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    platform: 'win32',
    home: 'C:\\Users\\hqxrd',
    env,
    exists: (file) => folders.has(file),
    run: async (file, args) => {
      const key = file === 'reg' ? args[1].split('\\').pop() ?? '' : file;
      calls.push(key);
      return answers[key];
    },
    readFile: () => undefined,
  };
}

const reg = (value: string, type = 'REG_EXPAND_SZ') => `\r\nHKEY_CURRENT_USER\\Software\\...\\User Shell Folders\r\n    Desktop    ${type}    ${value}\r\n\r\n`;

describe('local Desktop folder', () => {
  it('parses reg.exe output and expands %VARS% case-insensitively', () => {
    assert.equal(parseRegValue(reg('%USERPROFILE%\\Desktop'), 'Desktop'), '%USERPROFILE%\\Desktop');
    assert.equal(parseRegValue('ERROR: The system was unable to find the specified registry key', 'Desktop'), undefined);
    assert.equal(expandWindowsEnv('\\\\fs01\\home$\\%username%\\Desktop', env), '\\\\fs01\\home$\\hqxrd\\Desktop');
  });

  it('follows domain folder redirection to a network share', async () => {
    const redirected = '\\\\fs01\\home$\\hqxrd\\Desktop';
    const probe = winProbe(new Set([redirected]), { 'User Shell Folders': reg('\\\\fs01\\home$\\%USERNAME%\\Desktop') });
    assert.equal(await resolveKnownFolder(probe, 'Desktop'), redirected);
    assert.deepEqual(probe.calls, ['User Shell Folders']);
  });

  it('follows OneDrive folder backup', async () => {
    const onedrive = 'C:\\Users\\hqxrd\\OneDrive - LGroup\\Desktop';
    const probe = winProbe(new Set([onedrive, 'C:\\Users\\hqxrd\\Desktop']), { 'User Shell Folders': reg('%OneDrive%\\Desktop') });
    assert.equal(await resolveKnownFolder(probe, 'Desktop'), onedrive);
  });

  it('asks PowerShell when reg.exe prints a path it cannot decode', async () => {
    const chinese = 'D:\\桌面';
    const probe = winProbe(new Set([chinese]), {
      'User Shell Folders': reg('D:\\����', 'REG_SZ'),
      'Shell Folders': reg('D:\\����', 'REG_SZ'),
      'powershell.exe': `${chinese}\r\n`,
    });
    assert.equal(await resolveKnownFolder(probe, 'Desktop'), chinese);
    assert.deepEqual(probe.calls, ['User Shell Folders', 'Shell Folders', 'powershell.exe']);
  });

  it('falls back to %USERPROFILE%\\Desktop with Windows separators on any OS', async () => {
    const desktop = 'C:\\Users\\hqxrd\\Desktop';
    assert.equal(await resolveKnownFolder(winProbe(new Set([desktop]), {}), 'Desktop'), desktop);
    const have = new Set(['C:\\Users\\hqxrd\\Downloads']);
    assert.equal(resolveDownloadFolder(undefined, {}, 'C:\\Users\\hqxrd', (file) => have.has(file)), 'C:\\Users\\hqxrd\\Downloads');
  });

  it('returns undefined when there is no Desktop, as on some servers', async () => {
    assert.equal(await resolveKnownFolder(winProbe(new Set(), {}), 'Desktop'), undefined);
  });

  it('reads the XDG Desktop on Linux', async () => {
    assert.equal(parseXdgDir('XDG_DESKTOP_DIR="$HOME/桌面"\n', '/home/me', 'XDG_DESKTOP_DIR'), '/home/me/桌面');
    assert.equal(parseXdgDir('XDG_DESKTOP_DIR="$HOME/"\n', '/home/me', 'XDG_DESKTOP_DIR'), '/home/me/');
    const probe: FolderProbe = {
      platform: 'linux',
      home: '/home/me',
      env: {},
      exists: (file) => file === '/home/me/桌面',
      run: async () => undefined,
      readFile: () => 'XDG_DESKTOP_DIR="$HOME/桌面"',
    };
    assert.equal(await resolveKnownFolder(probe, 'Desktop'), '/home/me/桌面');
  });

  it('picks the download folder and labels it', () => {
    const have = new Set(['/home/me/Downloads', '/data/in']);
    const exists = (file: string) => have.has(file);
    assert.equal(resolveDownloadFolder('/data/in', {}, '/home/me', exists), '/data/in');
    assert.equal(resolveDownloadFolder('/gone', {}, '/home/me', exists), '/home/me/Downloads');
    assert.equal(resolveDownloadFolder('', { desktop: '/home/me/Desktop' }, '/home/me', (file) => file === '/home/me/Desktop'), '/home/me/Desktop');
    assert.equal(resolveDownloadFolder(undefined, {}, '/home/me', () => false), '/home/me');
    assert.equal(downloadFolderLabel('/home/me/Desktop', '/home/me/Desktop', '/home/me'), 'the Desktop');
    assert.equal(downloadFolderLabel('/home/me/Downloads', undefined, '/home/me'), '~/Downloads');
    assert.equal(downloadFolderLabel('/data/in', undefined, '/home/me'), '/data/in');
  });

  it('defaults to Downloads before the Desktop (U12)', () => {
    const both = new Set(['/home/me/Downloads', '/home/me/Desktop']);
    assert.equal(resolveDownloadFolder('', { desktop: '/home/me/Desktop' }, '/home/me', (file) => both.has(file)), '/home/me/Downloads');
    const xdg = new Set(['/home/me/Téléchargements', '/home/me/Desktop']);
    assert.equal(
      resolveDownloadFolder('', { downloads: '/home/me/Téléchargements', desktop: '/home/me/Desktop' }, '/home/me', (file) => xdg.has(file)),
      '/home/me/Téléchargements',
    );
  });

  it('finds the Windows Downloads known folder by its GUID, without blocking (B15)', async () => {
    const guid = '{374DE290-123F-4565-9164-39C4925E467B}';
    const out = `\r\nHKEY_CURRENT_USER\\...\r\n    ${guid}    REG_EXPAND_SZ    %USERPROFILE%\\Downloads\r\n`;
    assert.equal(parseRegValue(out, guid), '%USERPROFILE%\\Downloads');
    const probe = winProbe(new Set(['C:\\Users\\hqxrd\\Downloads']), { 'User Shell Folders': out });
    const pending = resolveKnownFolder(probe, 'Downloads');
    assert.ok(pending instanceof Promise);
    assert.equal(await pending, 'C:\\Users\\hqxrd\\Downloads');
  });

  it('reads XDG_DOWNLOAD_DIR on Linux', async () => {
    const probe: FolderProbe = {
      platform: 'linux',
      home: '/home/me',
      env: {},
      exists: (file) => file === '/home/me/Téléchargements',
      run: async () => undefined,
      readFile: () => 'XDG_DESKTOP_DIR="$HOME/Bureau"\nXDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n',
    };
    assert.equal(await resolveKnownFolder(probe, 'Downloads'), '/home/me/Téléchargements');
  });
});
