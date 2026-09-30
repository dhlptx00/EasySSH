import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  downloadFolderLabel,
  expandWindowsEnv,
  parseRegDesktop,
  parseXdgDesktop,
  resolveDesktop,
  resolveDownloadFolder,
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
    run: (file, args) => {
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
    assert.equal(parseRegDesktop(reg('%USERPROFILE%\\Desktop')), '%USERPROFILE%\\Desktop');
    assert.equal(parseRegDesktop('ERROR: The system was unable to find the specified registry key'), undefined);
    assert.equal(expandWindowsEnv('\\\\fs01\\home$\\%username%\\Desktop', env), '\\\\fs01\\home$\\hqxrd\\Desktop');
  });

  it('follows domain folder redirection to a network share', () => {
    const redirected = '\\\\fs01\\home$\\hqxrd\\Desktop';
    const probe = winProbe(new Set([redirected]), { 'User Shell Folders': reg('\\\\fs01\\home$\\%USERNAME%\\Desktop') });
    assert.equal(resolveDesktop(probe), redirected);
    assert.deepEqual(probe.calls, ['User Shell Folders']);
  });

  it('follows OneDrive folder backup', () => {
    const onedrive = 'C:\\Users\\hqxrd\\OneDrive - LGroup\\Desktop';
    const probe = winProbe(new Set([onedrive, 'C:\\Users\\hqxrd\\Desktop']), { 'User Shell Folders': reg('%OneDrive%\\Desktop') });
    assert.equal(resolveDesktop(probe), onedrive);
  });

  it('asks PowerShell when reg.exe prints a path it cannot decode', () => {
    const chinese = 'D:\\桌面';
    const probe = winProbe(new Set([chinese]), {
      'User Shell Folders': reg('D:\\����', 'REG_SZ'),
      'Shell Folders': reg('D:\\����', 'REG_SZ'),
      'powershell.exe': `${chinese}\r\n`,
    });
    assert.equal(resolveDesktop(probe), chinese);
    assert.deepEqual(probe.calls, ['User Shell Folders', 'Shell Folders', 'powershell.exe']);
  });

  it('returns undefined when there is no Desktop, as on some servers', () => {
    assert.equal(resolveDesktop(winProbe(new Set(), {})), undefined);
  });

  it('reads the XDG Desktop on Linux', () => {
    assert.equal(parseXdgDesktop('XDG_DESKTOP_DIR="$HOME/桌面"\n', '/home/me'), '/home/me/桌面');
    assert.equal(parseXdgDesktop('XDG_DESKTOP_DIR="$HOME/"\n', '/home/me'), '/home/me/');
    const probe: FolderProbe = {
      platform: 'linux',
      home: '/home/me',
      env: {},
      exists: (file) => file === '/home/me/桌面',
      run: () => undefined,
      readFile: () => 'XDG_DESKTOP_DIR="$HOME/桌面"',
    };
    assert.equal(resolveDesktop(probe), '/home/me/桌面');
  });

  it('picks the download folder and labels it', () => {
    const have = new Set(['/home/me/Downloads', '/data/in']);
    const exists = (file: string) => have.has(file);
    assert.equal(resolveDownloadFolder('/data/in', undefined, '/home/me', exists), '/data/in');
    assert.equal(resolveDownloadFolder('/gone', undefined, '/home/me', exists), '/home/me/Downloads');
    assert.equal(resolveDownloadFolder('', '/home/me/Desktop', '/home/me', (file) => file === '/home/me/Desktop'), '/home/me/Desktop');
    assert.equal(resolveDownloadFolder(undefined, undefined, '/home/me', () => false), '/home/me');
    assert.equal(downloadFolderLabel('/home/me/Desktop', '/home/me/Desktop', '/home/me'), 'the Desktop');
    assert.equal(downloadFolderLabel('/home/me/Downloads', undefined, '/home/me'), '~/Downloads');
    assert.equal(downloadFolderLabel('/data/in', undefined, '/home/me'), '/data/in');
  });
});
