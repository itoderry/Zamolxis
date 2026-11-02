---
name: sftp-client
description: A FileZilla-style file-transfer client. Browse the local machine and a remote SSH/SFTP server side by side and move files between them (upload/download), plus rename, delete, and make folders on either side. Backs the File Transfer desktop app. Use this when the user wants to copy files to/from a server, deploy something, or manage remote files.
---

# File Transfer (FileZilla-style)

Zamolxis ships a **File Transfer** app (Network category) modelled on FileZilla: a
two-pane window with the **Local site** on the left and the **Remote site** (an
SSH/SFTP server) on the right, and a status log along the bottom that narrates
every connection and transfer.

## What it does

- **Quick-connect bar** — host, port (22), username, password, then **Connect**.
- **Local pane** — browses the machine Zamolxis runs on through the `/api/fs`
  endpoint (drive list on Windows, home directory by default). Up / refresh /
  new-folder, plus per-file **↥ upload**, rename and delete.
- **Remote pane** — a real SSH/SFTP session via `/api/sftp` (ssh2). Same controls,
  with per-file **↧ download**.
- **Transfers** move a file into the *other* pane's current directory: upload reads
  the local file (`/api/fs readB64`) and writes it remotely (`/api/sftp write`);
  download reads the remote file and writes it locally (`/api/fs writeB64`). Each
  step is logged with the destination path and size. Binary-safe, up to 50 MB.

## Driving it from chat

When the user wants to work with remote files you can also use your shell tools
(`ssh`, `sftp`, `scp`, `rsync`):

- Connect to host/port with the user's username (ask for credentials if not
  provided; never store secrets).
- List remote directories, upload/download, rename, move or delete on request.
- Run remote commands when asked.

Confirm destructive remote actions before running them. For anything interactive
or repeated, point the user at the **File Transfer** app — open it from the desktop
icon or the Start menu, connect, and move files across with the transfer arrows.
