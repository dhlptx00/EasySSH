# Changelog

## 0.1.4

- Fixed: file and folder names sometimes got no link (no underline on hover, nothing on Ctrl+click) in one terminal while another terminal on the same server worked, for example in split view. This happened after `sudo su` (or `su`, `sudo -i`, a nested `bash`, or a login shell without the prompt hook). That shell does not report its folder, so Easy SSH kept matching names against the folder you were in before the switch. Easy SSH now follows the `cd` commands you type in such a shell, checks each folder on the server, and links names in the folder you are actually in. Ctrl+clicking a folder there is followed too, and `exit` returns to the folder the switched shell started from.
- When Easy SSH cannot follow a command in such a shell (a line recalled from history, `cd ~`, `cd $VAR`, `pushd`, a pipe), it shows **folder unknown** in the status bar and does not link names, instead of linking files from the wrong folder. Any `cd /absolute/path` finds the folder again.
- Uploads after `sudo su` offer the folder Easy SSH followed, not the folder from before the switch. They still ask first, because the file is written over SFTP as the login user.
- Windows: downloads fall back to `Desktop` and `Downloads` folders with Windows path separators.
- CI runs typecheck and tests on Windows, macOS, and Linux with Node 20 and 22, and checks that the extension packages.

## 0.1.3

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

## 0.1.2

- Add Buy Me a Coffee sponsor link.

## 0.1.1

- Add screenshots, a demo GIF, and an infographic to the README.
- Uploaded files now keep the local file's permissions instead of becoming world-writable (0666). Folders created during an upload keep the local folder's permissions; new parent folders use 0755.

## 0.1.0

- Manage SSH connections from a terminal: add, edit, delete, and import `~/.ssh/config`.
- Open a remote directory, click a file to download it, and drop local files to upload them.
- Connect with a password, a private key, or an SSH agent, including one or more jump hosts.
