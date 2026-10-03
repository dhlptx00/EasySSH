# Easy SSH – SSH Client & SFTP Drag-and-Drop

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/easy-ssh.easy-ssh?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=easy-ssh.easy-ssh)
[![Open VSX](https://img.shields.io/open-vsx/v/easy-ssh/easy-ssh?label=Open%20VSX)](https://open-vsx.org/extension/easy-ssh/easy-ssh)
[![CI](https://github.com/dhlptx00/EasySSH/actions/workflows/ci.yml/badge.svg)](https://github.com/dhlptx00/EasySSH/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

An SSH client in a VS Code or Cursor terminal tab. Save your hosts, hop through jump hosts, import `~/.ssh/config`, Ctrl+click a file or folder name to download it, and drag files onto the terminal to upload them.

Easy SSH talks SSH directly from your editor. **Nothing is installed on the server**, and no remote editor server is downloaded, so it works on old, small, and locked-down machines where Remote-SSH can't run.

![Easy SSH overview: saved connections, sign-in options, jump hosts, a real login shell, Ctrl+click or Cmd+click to download a file or folder, and drop to upload](media/readme/infographic.png)

![Demo: pick a connection, open the remote shell, Ctrl+click a folder to download it with progress, and Ctrl+click a file to download it](media/readme/connect-and-download.gif)

*Quick demo: connect, Ctrl+click a folder to download it, then Ctrl+click a file. On macOS, use Cmd+click.*

## Install

- **VS Code:** open the Extensions view, search for **Easy SSH**, or run `ext install easy-ssh.easy-ssh` in Quick Open (Ctrl+P / Cmd+P).
- **Cursor, VSCodium and other Open VSX editors:** search for **Easy SSH** in the Extensions view ([Open VSX page](https://open-vsx.org/extension/easy-ssh/easy-ssh)).
- **Offline:** download the `.vsix` from [GitHub Releases](https://github.com/dhlptx00/EasySSH/releases), then run **Extensions: Install from VSIX…**.

## What you can do

- Save, edit, and delete SSH connections
- Sign in with a password (saved, or asked every time), a private key, an SSH agent or Pageant. Two-factor prompts are shown in the terminal
- Hop through one or more jump hosts
- Import hosts from `~/.ssh/config`, including `Host *` defaults and `ProxyJump` chains
- Open your remote login shell (bash, zsh, fish and others) and use it exactly as over `ssh`, including `vim`, `top` and `sudo`
- **Download a file:** Ctrl+click its name (Cmd+click on macOS)
- **Download a folder** with everything in it: Ctrl+click its name (Cmd+click on macOS)
- **Upload:** drag files or folders onto the terminal. They go into the current remote folder
- Follow big transfers in a progress notification with **Cancel**
- Reconnect after a dropped connection, back into the same folder
- Open several sessions, each in its own terminal tab named after the server

## Requirements and limitations

- **Your side:** VS Code 1.85 or newer, or Cursor, on Windows, macOS or Linux.
- **Server:** a Linux or Unix server with OpenSSH or a compatible SSH server. Windows servers aren't supported.
- **Downloads and uploads need SFTP.** On a server without SFTP you still get the terminal, but no file transfers.
- **Folder tracking needs bash, zsh or fish.** In these shells the terminal follows `cd`, so clicks and drops use the right folder. Other shells work, but names aren't linked until Easy SSH knows the folder.
- After `sudo su`, `su` or a nested `ssh`, Easy SSH follows the `cd` commands it can see. Transfers still run as the user you signed in as.
- `ProxyCommand` isn't supported. Imported hosts that need it are listed and skipped; use `ProxyJump` instead.
- A single upload or folder download is limited to 5000 files (`easySsh.maxTransferFiles`).

## Open it

Click the **Easy SSH** icon in the activity bar, or run **Easy SSH: New Terminal**. Each opens another terminal tab with its own connection list. Each terminal connects on its own: the first is named Easy SSH, the next Easy SSH 2, Easy SSH 3, and so on. Close the tab, or type `/quit` in it, to dismiss it.

![The Easy SSH connection list in the terminal panel](media/readme/01-connection-list.png)

*The connection list. Up and Down select a connection, Enter connects.*

## Commands

On the connection panel, type `/` to open the command list. Connections and system commands are listed in separate groups. Up and Down move through the list, further typing filters it, and Enter runs the highlighted row.

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

Passwords and key passphrases are hidden while you type. Press Enter on a saved secret to keep it. Sign-in method and jump host are choices: move with Up and Down, then press Enter. For a custom jump host, type `user@host:port`, and separate extra hops with commas.

For password sign-in you choose whether Easy SSH saves the password or asks for it at every connect. If you change a connection's sign-in method or key, jump hosts that signed in the same way change with it.

## Remote shell

A connection opens your login shell in the home folder (or in the connection's start folder), the same kind of shell `ssh` starts. The login message and "Last login" line are shown as usual. What you type goes to the server, and what the server prints is shown as-is. Aliases, functions and the current folder stay in effect. `vim`, `less`, `top` and `sudo` work as in any terminal, and resizing the panel updates the window size on the server.

![A remote login shell running in the Easy SSH terminal](media/readme/07-terminal-session.png)

*A remote login shell, the same as over `ssh`.*

### Download a folder

Ctrl+click a folder name (Cmd+click on macOS) to download the whole folder, including subfolders. Hovering the name shows **Download folder** and where it goes.

- The folder keeps its structure and permission bits.
- If a folder with that name already exists locally, the download is named `logs (1)`.
- Symbolic links and special files are skipped. Easy SSH lists them when the download finishes.
- The download is written into a hidden temporary folder and renamed when it's complete. A cancelled or failed download leaves nothing behind.

![Hovering a folder name shows "Download folder logs to ~/Downloads (ctrl + click)"](media/readme/08-click-folder-to-download.png)

*Ctrl+click a folder name (Cmd+click on macOS) to download it with everything in it.*

Big downloads and uploads, and any folder, show a notification with the size, speed, time left, file count and a **Cancel** button. If you start another transfer in the same terminal, it waits in a queue.

![A progress notification for a folder download, with speed, time left and Cancel](media/readme/14-transfer-progress.png)

### Download a file

Ctrl+click a file name (Cmd+click on macOS). The status bar shows where it was saved. If the name is taken, Easy SSH adds a number, such as `notes (1).txt`.

![Hovering a file name shows "Download access.log to ~/Downloads (ctrl + click)"; the status bar shows where the file was saved](media/readme/09-click-file-to-download.png)

*Ctrl+click a file name (Cmd+click on macOS) to download it.*

### Upload

Drag files or folders from your computer onto the Easy SSH terminal. They're written into the current remote folder of the terminal you drop them on. In a split view, a drop goes to the pane under the mouse.

- A folder is uploaded with its contents, keeping its permission bits. Symbolic links inside it are skipped.
- If something with the same name already exists, Easy SSH asks first: **Replace**, **Keep Both** (uploads as `name (1)`), or **Skip**.
- Each file is written to a hidden temporary name, then renamed into place.

| Drag onto the terminal | Upload finished |
| --- | --- |
| ![Dragging files from the desktop onto the Easy SSH terminal](media/readme/10-upload-drag-onto-terminal.png) | ![The uploaded file in the current remote directory](media/readme/11-upload-complete.png) |

A path you **paste** is typed, never uploaded, when it matches what's on your clipboard. Inside full-screen programs such as `vim`, a dropped path is always typed. A drop from outside your home folder asks before it uploads.

### When the connection drops

Easy SSH sends a keepalive every 15 seconds. If the server stops answering, or the network goes away, the terminal says so and offers **Reconnect**, which signs in again and opens the shell in the same folder. Turn on `easySsh.autoReconnect` to retry by itself after 2, 5 and 10 seconds.

![The connection-lost screen with Reconnect and Back to the list](media/readme/15-connection-lost.png)

### Keyboard and mouse

| Action | Result |
| --- | --- |
| Type, arrows, Tab, Ctrl+R, Ctrl+L | The remote shell handles the keys. Tab finishes a path such as `cd /tm` |
| Ctrl+click a file name (Cmd+click on macOS) | Download the file |
| Ctrl+click a folder name (Cmd+click on macOS) | Download the folder with everything in it |
| Drag with the mouse | Select text |
| Drag files or folders onto the terminal | Upload into the current remote folder |
| Ctrl+C | Stop the running remote command. It never cancels a transfer |
| Ctrl+Z | Suspend the running command (`fg` continues it) |
| **Easy SSH: Cancel Transfer**, or Cancel in the notification | Stop the running transfer |
| Paste | Keep line breaks, including a heredoc |
| `exit` | Disconnect and go back to the connection list |

If `editor.multiCursorModifier` is set to `ctrlCmd`, names open with Alt+click instead, like other VS Code terminal links. With **Easy SSH: Plain Click** (`easySsh.plainClick`) a plain click downloads, and selecting text needs Shift+drag. On macOS, turn on `terminal.integrated.macOptionClickForcesSelection` and use Option+drag.

## Downloads

Downloads go to your **Downloads** folder: the one your system actually uses, including a localized or redirected folder on Windows and Linux. If there's none, they go to the Desktop. Type `/folder` on the connection panel, or run **Easy SSH: Set Download Folder**, to choose another folder. The folder in use is shown at the bottom of the connection panel and in **Output → Easy SSH**.

## Jump hosts and `~/.ssh/config`

Use a hostname, an IP address, or one or more jump hosts when the server is only reachable through a bastion. Jump hosts entered in the terminal sign in the same way as the connection. A saved password is tried once on each password hop, and Easy SSH asks when it doesn't work.

![A shell on staging-db, reached through a jump host](media/readme/12-jump-host-session.png)

*A session on `staging-db`, reached through `bastion.example.com`.*

`/import` reads `~/.ssh/config`, including `Include` files under `~/.ssh`. It keeps each host's user, port, identity file and `ProxyJump` chain, and applies `Host *` and wildcard defaults the way `ssh` does: the first value wins. Hosts that need a `ProxyCommand` are listed and skipped. Importing again updates hosts without losing your manual edits or start folder.

![Importing hosts from ~/.ssh/config](media/readme/06-import-ssh-config.png)

*`/import` reads the hosts from `~/.ssh/config`.*

With SSH agent sign-in, Easy SSH tries the agent first, then `~/.ssh/id_ed25519`, `id_ecdsa` and `id_rsa`, like `ssh`. On Windows it uses the OpenSSH Authentication Agent service, or Pageant (`easySsh.windowsAgent`).

## Security

- **Host keys.** The first time you connect to a server, Easy SSH shows its key fingerprint and connects only if you accept it. Keys listed in `~/.ssh/known_hosts` are trusted without asking, and `@revoked` keys are refused. If a key changes, Easy SSH shows the old and the new fingerprint and asks again. Behind jump hosts, each hop is checked separately. `known_hosts` is only read, unless you turn on `easySsh.knownHostsWriteBack`.

  ![A new server's host key fingerprint, shown before connecting](media/readme/13-host-key-prompt.png)

- **Forget Trusted Host Keys…** lets you pick hosts, or all of them, and asks before it forgets anything.
- **Passwords and key passphrases** are kept in the editor's secret storage. That's the OS keychain: Windows Credential Manager, macOS Keychain, or the Secret Service / libsecret keyring on Linux. On Linux without a keyring, VS Code may fall back to weaker storage; choose **ask every time** for those connections. Private keys stay in the files you point at.
- **The saved password is only sent where it belongs:** to the password prompt, once. Two-factor and other keyboard-interactive prompts are always shown to you.
- **Connection details** (host, user, port, key path, jump hosts) and trusted fingerprints are stored in the editor's extension storage. They're not secrets, but they're not synced either.
- **Defaults stay strict.** Easy SSH uses ssh2's modern algorithms. It doesn't enable legacy ones such as `ssh-rsa` with SHA-1 or `diffie-hellman-group1`, and it has no agent forwarding.
- **Transfers** keep permission bits: a downloaded `0600` file stays `0600`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `easySsh.downloadFolder` | *(Downloads)* | Where downloads go |
| `easySsh.plainClick` | `false` | Download with a plain click instead of Ctrl/Cmd+click |
| `easySsh.hostKeyPolicy` | `ask` | `ask` shows a new server's fingerprint; `trustFirst` trusts it on first connect |
| `easySsh.knownHostsWriteBack` | `false` | Also add accepted keys to `~/.ssh/known_hosts` |
| `easySsh.transferConcurrency` | `32` | SFTP requests in flight per file (1–64) |
| `easySsh.maxTransferFiles` | `5000` | Most files per upload or folder download |
| `easySsh.keepaliveInterval` | `15000` | Milliseconds between keepalives; `0` turns them off |
| `easySsh.keepaliveCountMax` | `3` | Unanswered keepalives before the connection counts as lost |
| `easySsh.autoReconnect` | `false` | Reconnect by itself after a drop (2, 5, 10 s) |
| `easySsh.maximizePanel` | `true` | Maximize the panel while Easy SSH is open |
| `easySsh.terminalLocation` | `panel` | Open Easy SSH in the panel or as an editor tab |
| `easySsh.windowsAgent` | `auto` | Windows agent: `auto`, `openssh` or `pageant` |
| `easySsh.readyTimeout` | `20000` | Handshake timeout in ms; time spent on prompts doesn't count |

## How it compares

| | Easy SSH | Remote-SSH | SSH FS | `ssh` in a terminal |
| --- | --- | --- | --- | --- |
| Installs on the server | Nothing | VS Code Server | Nothing | Nothing |
| Works on old, small or locked-down servers | Yes | Often not | Yes | Yes |
| Works in Cursor and VSCodium | Yes | Microsoft builds only | Yes | Yes |
| Saved hosts and jump hosts | Yes | Through `~/.ssh/config` | Yes | Through `~/.ssh/config` |
| Download with Ctrl+click on a name | Files and folders | No | No | No |
| Upload by dropping onto the terminal | Yes | Into the explorer | Into the explorer | No |
| Edit remote files in the editor | No | Yes | Yes | No |
| Remote language servers, debugging | No | Yes | No | No |

Use Remote-SSH when you want to develop *on* the server. Use Easy SSH when you want a quick, reliable shell with easy file transfer, especially on servers you can't or don't want to install anything on.

## FAQ

**Does it work with two-factor authentication?** Yes. Keyboard-interactive prompts (OTP codes, Duo, PAM questions) are shown in the terminal. The saved password only answers the password prompt.

**My host uses `ProxyCommand`.** Easy SSH can't run proxy commands. If it's an `ssh -W` hop, use `ProxyJump` instead. `/import` lists the hosts it skipped.

**Where did my download go?** To your Downloads folder, unless you chose another one with `/folder`. The status bar and **Output → Easy SSH** show the full path.

**How do I download a folder?** Ctrl+click its name (Cmd+click on macOS). It downloads with all its files and subfolders.

**How do I change directory?** Type `cd`, as in any shell. Tab completes remote paths.

**I can't select text with the mouse.** Easy SSH doesn't turn on mouse reporting, so a normal drag selects text. Some full-screen programs (`vim` with `mouse=a`, `tmux` with mouse on, `htop`, `mc`) do. While they run, or with `easySsh.plainClick` on, hold Shift and drag (on macOS: Option+drag with `terminal.integrated.macOptionClickForcesSelection`).

**An upload after `sudo su` asks where to put the file.** Uploads go over SFTP as the user you signed in as, not as `root`. If Easy SSH can't tell which folder the switched shell is in, it asks: upload to the last known folder, your home folder, or a folder you type. To put a file where only root can write, upload it to your home folder, then `sudo mv` it. Easy SSH shows that command after the upload.

**Upload fails with "Permission denied".** The server refused the write for the signed-in user. The message names the path. Check it with `ls -ld <folder>`.

**The connection drops when idle.** Lower `easySsh.keepaliveInterval`, for example to `10000`. Turn on `easySsh.autoReconnect` to reconnect by itself.

**Sign-in fails with the agent.** Make sure an agent is running and holds your key (`ssh-add -l`). On Windows, start the "OpenSSH Authentication Agent" service or Pageant. The error message says what Easy SSH tried.

## Develop

```bash
npm install
npm run check     # typecheck
npm run lint
npm test          # unit tests
npm run compile
```

To run the integration tests, start the test server from `test/integration/Dockerfile` (the file explains how), then set `EASYSSH_IT_PORT` and `EASYSSH_IT_KEY` and run `npm run test:integration`. Press F5 in VS Code or Cursor to run the extension. Both editors use the same extension API, so there is no separate Cursor build.

Questions and ideas: [GitHub Discussions](https://github.com/dhlptx00/EasySSH/discussions). Bugs: [issues](https://github.com/dhlptx00/EasySSH/issues).

## Rate it

If Easy SSH helps you, a rating on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=easy-ssh.easy-ssh&ssr=false#review-details) or [Open VSX](https://open-vsx.org/extension/easy-ssh/easy-ssh/reviews) helps others find it.

## Support

If Easy SSH saves you time, you can support its development:

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/dhlptx00)
