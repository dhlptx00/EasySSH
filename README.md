# Easy SSH

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/dhlptx00)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/dhlptx00)

![Easy SSH overview: saved connections, sign-in options, jump hosts, a real login shell, click to download, and drop to upload](media/readme/infographic.png)

A terminal for SSH connections inside VS Code and Cursor.

Easy SSH talks SSH directly from your computer. It does not install anything on the server, and it does not download a remote editor when you connect. The same terminal works on an internal network and on the public internet.

![Demo: pick a connection, open the remote shell, click a directory to cd into it, and click a file to download it](media/readme/connect-and-download.gif)

*Quick demo: connect, click a directory to `cd` into it, click a file to download it.*

## What you can do

- Save, edit, and delete SSH connections
- Sign in with a password, a private key, or an SSH agent
- Hop through one or more jump hosts
- Import hosts from `~/.ssh/config`
- Open a remote Linux shell in your home directory
- Run commands, full-screen programs, and `sudo` the same way you would over `ssh`
- Click a file name to download it to your Desktop
- Drag a file or folder onto the terminal to upload it into the current directory
- Open another session from the activity-bar icon or **Easy SSH: New Terminal**

## Open it

Click the **Easy SSH** icon in the activity bar. Each click opens another terminal tab with its own connection list. Close that tab, or type `/quit` in it, to dismiss it.

![The Easy SSH connection list in the terminal panel](media/readme/01-connection-list.png)

*The connection list. Up and Down select a connection, Enter connects.*

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

![The slash command list, with connections and system commands in separate groups](media/readme/02-slash-command-palette.png)

*Type `/` to open the command list.*

### New, edit, and delete

| `/new` | `/edit` | `/delete` |
| --- | --- | --- |
| ![New connection form](media/readme/03-new-connection-form.png) | ![Editing a connection and choosing a jump host](media/readme/04-edit-connection-jump-host.png) | ![Delete confirmation for a saved connection](media/readme/05-delete-connection-confirm.png) |
| Fill in the fields for a new connection | Change a connection, here adding a jump host | Confirm before a connection is removed |

### Remote shell

A connection opens your login shell in the home directory, the same kind of shell `ssh` starts. The terminal is passed through: what you type goes to the server, and what the server prints is shown as-is. Aliases such as `ll`, functions, and the current directory stay in effect. `vim`, `less`, `top`, and `sudo` work as they do in a normal terminal. The password you type for `sudo` is not echoed. `clear` and `reset` clear the screen. Resizing the panel updates both the width and the height, so `stty size` follows the window.

![A remote login shell running in the Easy SSH terminal](media/readme/07-terminal-session.png)

*A remote login shell, the same as over `ssh`.*

Click a file name to download it to the Desktop. Click a directory name to `cd` into it. Drag a file or folder onto the terminal to upload it into the current directory. Progress for those transfers is shown in the status bar. `exit` closes the shell and returns to the connection list.

![Clicking a directory name runs cd into it](media/readme/08-click-directory-to-cd.png)

*Click a directory name to `cd` into it.*

Each click of the activity-bar icon opens another terminal, and so does **Easy SSH: New Terminal**. Each one connects on its own. The first terminal is named Easy SSH, and the next are Easy SSH 2, Easy SSH 3, and so on.

Hold Option on macOS, or Shift on Windows and Linux, and drag to select text.

| Action | Result |
| --- | --- |
| Type, arrows, Tab, Ctrl+R, Ctrl+L | The remote shell handles the keys. Tab finishes a path such as `cd /tm` |
| Click a file name | Download it to the Desktop |
| Click a directory name | `cd` into it |
| Drag a file or folder here | Upload it into the current directory |
| Ctrl+C | Stop the running command |
| Ctrl+Z | Suspend the running command (`fg` continues it) |
| Paste | Keep line breaks, including a heredoc |
| `exit` | Disconnect |

Passwords and key passphrases are hidden while you type. Press Enter on a saved secret to keep it. Authentication and the jump host are choices: move with Up and Down, then press Enter. A custom jump host is the only extra text. Type `user@host:port`. Separate extra hops with commas.

## Downloads and uploads

Downloaded files go to your Desktop. Type `/folder` on the connection panel, or run **Easy SSH: Set Download Folder**, to choose another folder. If the file name already exists, Easy SSH adds a number, such as `notes (1).txt`.

![Clicking a file name downloads it to the Desktop](media/readme/09-click-file-to-download.png)

*Click a file name to download it. The status bar shows where it was saved.*

To upload, drag a file or a folder from your desktop onto the Easy SSH terminal. It is written into the current Linux directory. A folder is uploaded with its contents. Symbolic links inside a folder are skipped. A single drop is limited to 5000 files.

| Drag onto the terminal | Upload finished |
| --- | --- |
| ![Dragging files from the desktop onto the Easy SSH terminal](media/readme/10-upload-drag-onto-terminal.png) | ![The uploaded file in the current remote directory](media/readme/11-upload-complete.png) |

## Internal and external networks

A connection is a normal SSH session from the editor to the host you enter. Use a hostname, an IP address, or a jump host when the server is only reachable through a bastion. Jump hosts entered in the terminal use the same password, key, or agent as the connection.

![A shell on staging-db, reached through a jump host](media/readme/12-jump-host-session.png)

*A session on `staging-db`, reached through `bastion.example.com`.*

Hosts imported from `~/.ssh/config` keep their user, port, identity file, and `ProxyJump` chain. `Host *` wildcard blocks are skipped. `Include` files under `~/.ssh` are read.

![Importing hosts from ~/.ssh/config](media/readme/06-import-ssh-config.png)

*`/import` reads the hosts from `~/.ssh/config`, including the `ProxyJump` chain. `Host *` is skipped.*

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

SSH FS mounts a remote system as a workspace folder and also provides tasks and remote shells. Easy SSH is the connection list and a login shell: type commands the way you would over `ssh`, click a file name to download it, and drop a file or folder to upload it.

## Support

If Easy SSH saves you time, you can support its development:

- [GitHub Sponsors](https://github.com/sponsors/dhlptx00)
- [Buy Me a Coffee](https://buymeacoffee.com/dhlptx00)
