# Changelog

All notable changes to Easy SSH. Dates are in UTC+8.

If Easy SSH helps you, a rating on the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=easy-ssh.easy-ssh&ssr=false#review-details) or [Open VSX](https://open-vsx.org/extension/easy-ssh/easy-ssh/reviews) helps others find it.

## [Unreleased]

### Changed

- **Ctrl+click on a file or folder name now opens an action menu** (Cmd+click on macOS, or a plain click with `easySsh.plainClick`) instead of downloading right away. The menu's title shows the name and its folder (`report.log — /var/log/app`), the placeholder its size or item count, and **Download** is first, so Enter downloads:
  - **Download** asks where to save: a save dialog for a file, a folder picker for a folder, both starting in your download folder. It shows the progress notification with Cancel. Cancelling the dialog does nothing.
  - **Upload…** (folders only) picks local files (and folders on macOS) and uploads them into the clicked folder with the progress notification. The dialog names the target folder, and existing names ask Replace, Keep Both or Skip as before. Dropping files on the terminal still uploads into the current folder.
  - **Open** (text files only) opens the file in a VS Code editor tab (`easyssh://<connection>/<path>`), read and saved over the terminal's SFTP connection. Ctrl+S / Cmd+S saves it back to the server and keeps its permissions, owner and symlinks. Saving asks before overwriting a file that changed on the server, and says so clearly when the terminal is disconnected or closed. Text files over 5 MB ask first (Open Anyway, Download, Cancel). Open is hidden for archives, images, programs and other binary files: by name, or for unknown names by reading the first 8 KB (NUL bytes or invalid UTF-8).
  - **Rename…** suggests the current name with the part before the extension selected, refuses empty names, `/` and names that already exist, and asks once more before renaming over SFTP.
  - **Delete…** always asks. For a folder it counts the files first (`Delete folder "logs" and its 128 files?`, or `5000+ files`), then deletes it with everything in it over SFTP, with progress and Cancel for big folders. For a symlink only the link is deleted.
- Link tooltips and the hint above the shell list the actions instead of "Download".

### Fixed

- Names created, renamed or deleted by a command (`mv`, `touch`, `mkdir`, `cp`, `tar`…) are clickable, or stop being links, as soon as the prompt is back. Before, the folder was only listed again after a `cd`. Easy SSH now lists it again after every command (once for several quick prompts; a folder with more than 2000 names only when its modification time changed).
- A Ctrl+click could act on the name a row showed earlier: when the pointer stayed on a row while its text changed (for example after `clear && ls`), VS Code kept offering the old link. Easy SSH now checks that the row still shows the text the link was made for. If not, it uses the name now under the link, or asks you to click again when that is unclear.

## [0.2.0] - 2026-10-03

### Changed

- **Ctrl+click on a folder now downloads it** (Cmd+click on macOS, or a plain click with `easySsh.plainClick`). Before, the click ran `cd`; that's gone. The download:
  - copies the whole folder over SFTP, keeping its structure and permission bits;
  - shows progress and has Cancel;
  - names it `logs (1)` when `logs` already exists;
  - is written into a hidden temporary folder and only renamed into place when complete;
  - is limited to `easySsh.maxTransferFiles` (5000) files;
  - skips symbolic links and special files, and lists them afterwards.

  Hovering a folder name says **Download folder**.
- **Downloads go to your Downloads folder by default**, not the Desktop. On Windows and Linux this is the localized or redirected Downloads folder. A folder set with `/folder` or `easySsh.downloadFolder` is kept.
- **New servers show their host key fingerprint and connect only after you accept it.** Keys already in `~/.ssh/known_hosts` are trusted without asking, and `@revoked` keys are refused. `easySsh.hostKeyPolicy: trustFirst` brings back the old trust-on-first-use behaviour. **Forget Trusted Host Keys…** (was Reset Trusted Host Keys) now lets you pick hosts and asks before it forgets anything.
- **Uploads ask before replacing remote files:** Replace, Keep Both (`notes (1).txt`), or Skip. A file is written to a hidden temporary name and renamed into place, so a failed upload never leaves a half-written file.
- The login message (MOTD, "Last login", system notices) stays visible. The folder-tracking hook is sent after it, its echo is hidden, and it is kept out of shell history.
- `Ctrl+C` always goes to the remote program. It no longer cancels a running transfer; use the **Cancel** button in the progress notification, or **Easy SSH: Cancel Transfer**.
- The panel is maximized only if it wasn't already, and restored on close only if Easy SSH maximized it and it still is. Turn this off with `easySsh.maximizePanel`.

### New

- **Progress notification** for big transfers and folders, with speed, time left, file count and **Cancel**. Several transfers in one terminal queue up instead of being refused.
- **Faster transfers:** several SFTP requests in flight per file (`easySsh.transferConcurrency`, default 32), which helps a lot on distant servers.
- **Connection lost** screen: it gives the reason and offers **Reconnect**, which returns to the same folder. `easySsh.autoReconnect` retries by itself after 2, 5 and 10 s.
- **Ask for the password every time:** a per-connection choice, so the password is never saved. When a saved password is rejected, Easy SSH asks again (up to 3 tries), and it can save the one you type.
- Key passphrases are asked in the terminal when needed, for the server and for jump hosts.
- Folder tracking in **zsh and fish** too. The login shell is detected first.
- The terminal tab is named after the connection.
- Servers without SFTP open a terminal-only session instead of failing.
- `~/.ssh/config` import:
  - applies `Host *` and wildcard defaults with OpenSSH's first-match rules;
  - lists `ProxyCommand` hosts instead of importing them as direct connections;
  - keeps your manual edits and start folder when you import again.
- Agent sign-in falls back to `~/.ssh/id_ed25519`, `id_ecdsa` and `id_rsa`, like `ssh`. On Windows it supports **Pageant** as well as the OpenSSH agent (`easySsh.windowsAgent`).
- Sign-in errors say what to try next, for example "Start ssh-agent and run ssh-add" or "the server does not accept passwords".
- New settings:
  - `easySsh.hostKeyPolicy`, `easySsh.knownHostsWriteBack`
  - `easySsh.transferConcurrency`, `easySsh.maxTransferFiles`
  - `easySsh.keepaliveInterval`, `easySsh.keepaliveCountMax`, `easySsh.autoReconnect`
  - `easySsh.maximizePanel`, `easySsh.terminalLocation`, `easySsh.windowsAgent`

### Fixed

- A pasted path that also exists on your computer was uploaded instead of typed. Now it's typed when it matches the clipboard, and always inside full-screen programs such as `vim`. Dropping a file from outside your home folder asks first.
- A `PROMPT_COMMAND` ending in `;` (for example `history -a;`) broke every prompt.
- Changing a connection's sign-in method or key left its jump hosts on the old one.
- A transfer cut short by a dropped connection could be reported as finished. Every byte is checked now.
- Files that report size 0, such as `/proc/cpuinfo`, downloaded empty. Files that grow while being read, such as logs, are read to the end.
- The connection failed, and leaked, when the first folder listing failed.
- Two terminals downloading files with the same name at once wrote to the same file.
- A big folder drop could not be cancelled while it was being scanned. The file limit is now checked during the scan.
- Windows: looking up the Desktop and Downloads folders no longer blocks the editor.
- Accepting one changed host key behind a jump host accepted changed keys for every hop.
- The saved password was sent to every keyboard-interactive prompt, including 2FA codes. It now only answers a single hidden password prompt, once.
- Downloaded files keep the remote permission bits (an `0600` key stays `0600`), and are always readable and writable by you.
- The status bar item now hides when no Easy SSH terminal is open.

### Project

- Integration tests against a real OpenSSH server (Docker) cover:
  - bash, zsh and fish
  - `PROMPT_COMMAND` variants
  - keyboard-interactive sign-in
  - host keys
  - jump hosts
  - upload conflicts and folder downloads
- ESLint, `@types/vscode` pinned to the oldest supported VS Code (1.85), and CI actions pinned by commit.
- A release workflow publishes to Open VSX and GitHub Releases from a version tag.
- Issue templates and GitHub Discussions.
- README rewritten: install, requirements and limitations, settings, security, FAQ, a comparison with Remote-SSH and SSH FS, and new screenshots, infographic and demo GIF. Clearer Marketplace name, description and keywords.

## [0.1.4] - 2026-10-01

- Fixed: file and folder names sometimes got no link (no underline on hover, nothing on Ctrl+click) in one terminal while another terminal on the same server worked, for example in split view. This happened after `sudo su` (or `su`, `sudo -i`, a nested `bash`, or a login shell without the prompt hook). That shell does not report its folder, so Easy SSH kept matching names against the folder you were in before the switch. Easy SSH now follows the `cd` commands you type in such a shell, checks each folder on the server, and links names in the folder you are actually in. Ctrl+clicking a folder there is followed too, and `exit` returns to the folder the switched shell started from.
- When Easy SSH cannot follow a command in such a shell (a line recalled from history, `cd ~`, `cd $VAR`, `pushd`, a pipe), it shows **folder unknown** in the status bar and does not link names, instead of linking files from the wrong folder. Any `cd /absolute/path` finds the folder again.
- Uploads after `sudo su` offer the folder Easy SSH followed, not the folder from before the switch. They still ask first, because the file is written over SFTP as the login user.
- Windows: downloads fall back to `Desktop` and `Downloads` folders with Windows path separators.
- CI runs typecheck and tests on Windows, macOS, and Linux with Node 20 and 22, and checks that the extension packages.

## [0.1.3] - 2026-09-30

- Text in the remote shell can be selected with the mouse again. File and directory names now open with Ctrl+click (Cmd+click on macOS) through VS Code's terminal links, so Easy SSH no longer turns on terminal mouse reporting. Hovering a name shows what a click does.
- New setting `easySsh.plainClick` brings back plain-click names. That mode uses mouse reporting, so selection needs Shift+drag.
- Mouse reporting that a remote program leaves on (for example `vim` with `mouse=a`, or `tmux`) is turned off when the program leaves the full screen, when the shell prompt returns, and when the session ends.
- After `sudo su`, `su`, `ssh`, or a similar command, the switched shell no longer reports its directory. An upload then asks where to put the file instead of writing it into the last known directory. The dialog offers the last known directory, the home directory, or a typed path. After the upload, Easy SSH names the target and user and shows a `sudo mv` command.
- A drop always uploads into the terminal it lands on, including in split views.
- Upload and download errors name the operation and the path, for example `Cannot write /srv/app/file.txt: Permission denied (SFTP user deploy)`. They open a notification with **Show Log**, and they are written to **Output → Easy SSH**.
- A failure to list the directory after an upload no longer hides the "Uploaded" message.
- Windows: downloads go to the Desktop Windows actually uses, including OneDrive and redirected Desktops, and the hover text names that folder. File names with characters Windows does not allow, or reserved names such as `CON`, are made safe. Saving retries a rename blocked briefly by antivirus or indexing.
- Windows error codes such as `EPERM`, `EBUSY`, and `ENOENT` are shown as plain sentences.
- The connection panel header shows the installed version. It showed 0.1.0 in every release so far.

## [0.1.2] - 2026-09-30

- Add Buy Me a Coffee sponsor link.

## [0.1.1] - 2026-09-30

- Add screenshots, a demo GIF, and an infographic to the README.
- Uploaded files now keep the local file's permissions instead of becoming world-writable (0666). Folders created during an upload keep the local folder's permissions; new parent folders use 0755.

## [0.1.0] - 2026-09-30

- Manage SSH connections from a terminal: add, edit, delete, and import `~/.ssh/config`.
- Open a remote directory, click a file to download it, and drop local files to upload them.
- Connect with a password, a private key, or an SSH agent, including one or more jump hosts.

[Unreleased]: https://github.com/dhlptx00/EasySSH/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/dhlptx00/EasySSH/releases/tag/v0.2.0
[0.1.4]: https://github.com/dhlptx00/EasySSH/releases/tag/v0.1.4
[0.1.3]: https://github.com/dhlptx00/EasySSH/releases/tag/v0.1.3
[0.1.2]: https://github.com/dhlptx00/EasySSH/releases/tag/v0.1.2
[0.1.1]: https://github.com/dhlptx00/EasySSH/releases/tag/v0.1.1
[0.1.0]: https://github.com/dhlptx00/EasySSH/releases/tag/v0.1.0
