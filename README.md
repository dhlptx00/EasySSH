# Easy SSH

A terminal for SSH connections inside VS Code and Cursor.

Easy SSH talks SSH directly from your computer. It does not install anything on the server, and it does not download a remote editor when you connect. The same terminal works on an internal network and on the public internet.

## What you can do

- Save, edit, and delete SSH connections
- Sign in with a password, a private key, or an SSH agent
- Hop through one or more jump hosts
- Import hosts from `~/.ssh/config`
- Open a remote Linux directory
- Click a file to download it to your computer
- Drop local files or folders onto the terminal to upload them into the current directory

## Open it

Click the **Easy SSH** icon in the activity bar. The connection panel opens as a tab in the Terminal. Click the icon again to hide it.

## Commands

On the connection panel, type a command and press Enter. Up and Down move the selection.

| Command | Action |
| --- | --- |
| /new | New connection |
| /edit | Edit the selected connection |
| /delete | Delete the selected connection |
| /import | Import `~/.ssh/config` |
| /folder | Choose the local download folder |
| /quit | Close the terminal |
| Enter | Connect to the selected connection |

### Remote directory

| Key | Action |
| --- | --- |
| Enter | Open a directory, or download a file |
| Click the name | Same as Enter. Hold Command on macOS, or Ctrl on Windows and Linux. |
| Drop files | Upload them into the current directory |
| u | Pick local files to upload |
| Backspace | Go up one directory |
| g | Go to a path |
| r | Refresh |
| q | Disconnect |
| Ctrl+C | Cancel a transfer, or leave the current prompt |

Passwords and key passphrases are hidden while you type. Press Enter on a saved secret to keep it. For a jump host, type `user@host:port`. Separate extra hops with commas. Type `none` to clear a jump host, and `home` to open your remote home directory.

## Downloads and uploads

Downloaded files go to your Desktop. Type `/folder` on the connection panel, press `o` while browsing, or run **Easy SSH: Set Download Folder**, to choose another folder. If the file name already exists, Easy SSH adds a number, such as `notes (1).txt`.

To upload, drag files or folders from your desktop onto the Easy SSH terminal. They are written into the directory shown at the top. Press `u` when you want a file picker instead. Folders are uploaded with their contents. Symbolic links are skipped. A single drop is limited to 5000 files.

## Internal and external networks

A connection is a normal SSH session from the editor to the host you enter. Use a hostname, an IP address, or a jump host when the server is only reachable through a bastion. Jump hosts entered in the terminal use the same password, key, or agent as the connection.

Hosts imported from `~/.ssh/config` keep their user, port, identity file, and `ProxyJump` chain. `Host *` wildcard blocks are skipped. `Include` files under `~/.ssh` are read.

The first time you connect, the server's host key is saved. If that key changes later, the terminal asks before trusting the new one. **Easy SSH: Reset Trusted Host Keys** forgets the saved keys.

Passwords and passphrases are stored in the editor's secret storage. Private keys stay in the files you point at.

## Develop

```bash
npm install
npm test
npm run compile
```

Press F5 in VS Code or Cursor. Both hosts use the same extension API, so there is no separate Cursor build.

## Compared with SSH FS

SSH FS mounts a remote system as a workspace folder and also provides tasks and remote shells. Easy SSH is only the connection list and the directory you are in: click a file to download it, and drop files to upload them.
