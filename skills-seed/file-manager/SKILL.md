---
name: file-manager
description: Browse, open, move, rename, create and delete files and folders in the user's home directory. Backs the File Manager desktop app.
---

# File Manager

Manage files and folders under the user's home directory.

When the user asks to find, open, move, rename, copy, create or delete files/folders, use your shell and file tools:
- List a directory and report names, sizes and modified dates.
- Read a file's contents on request.
- Create folders, rename, move (mv) or delete (rm) when explicitly asked. Confirm before deleting anything irreversibly.
- Report absolute paths so the user can locate items.

The desktop File Manager app exposes the same actions through `/api/fs` (list/read/write/mkdir/rename/delete), rooted at the home directory.
