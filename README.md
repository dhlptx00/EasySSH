# Easy SSH

A terminal for SSH connections inside VS Code and Cursor.

Easy SSH talks SSH directly from your computer. It does not install anything on the server, and it does not download a remote editor when you connect. The same terminal works on an internal network and on the public internet.

## What you can do

- Save, edit, and delete SSH connections
- Sign in with a password, a private key, or an SSH agent
- Hop through one or more jump hosts
- Import hosts from `~/.ssh/config`
- Open a remote Linux shell in your home directory
- Type a command and press Enter. `cd` changes the directory
- Click a file name in the command output to download it to your Desktop
- Drag a file or folder onto the terminal to upload it into the current directory

## Open it

Click the **Easy SSH** icon in the activity bar. The connection panel opens as a tab in the Terminal. Click the icon again to hide it.

## Commands

On the connection panel, type `/` to open the command list. Connections and system commands are listed in separate groups. Up and Down move through the list, further typing filters it, and Enter runs the highlighted row. With the list closed, Up and Down move the connection selection.

| Command | Action |
| --- | --- |
| /name | Connect to the saved connection with that name |
| /new | New connection |
| /edit | Choose a connection, then edit it |
| /delete | Choose a connection, then delete it |
| /import | Import `~/.ssh/config` |
| /folder | Choose the local download folder |
| /quit | Close the terminal |
| Enter | Connect to the selected connection |

### Remote shell

A connection opens in the remote home directory. The window has three boxes: a centered hint at the top, the remote output in the middle, and the `$` prompt at the bottom. Type a Linux command and press Enter. The middle box shows that command's output as the server printed it. `cd` and `cd /path` move to that directory. `exit` disconnects. Up and Down recall earlier commands.

The top box says how files move: click a file name in the output to download it to the Desktop, and drag a file or folder onto the terminal to upload it into the current directory. Moving the pointer over a file name underlines it. Pressing the mouse button highlights that name until you release it.

| Action | Result |
| --- | --- |
| Enter | Run the typed command |
| `cd` path | Change the current directory |
| Click a file name | Download it to the Desktop |
| Click a directory name | `cd` into it |
| Drag a file or folder here | Upload it into the current directory |
| Ctrl+C | Cancel a command or transfer, clear the line, or disconnect |
| `exit` | Disconnect |

Passwords and key passphrases are hidden while you type. Press Enter on a saved secret to keep it. Authentication and the jump host are choices: move with Up and Down, then press Enter. A custom jump host is the only extra text. Type `user@host:port`. Separate extra hops with commas.

## Downloads and uploads

Downloaded files go to your Desktop. Type `/folder` on the connection panel, or run **Easy SSH: Set Download Folder**, to choose another folder. If the file name already exists, Easy SSH adds a number, such as `notes (1).txt`.

To upload, drag a file or a folder from your desktop onto the Easy SSH terminal. It is written into the current Linux directory. A folder is uploaded with its contents. Symbolic links inside a folder are skipped. A single drop is limited to 5000 files.

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

SSH FS mounts a remote system as a workspace folder and also provides tasks and remote shells. Easy SSH is the connection list and a shell in the current directory: type a command, click a file name in the output to download it, and drop a file or folder to upload it.
