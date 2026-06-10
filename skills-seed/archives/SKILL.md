---
name: archives
description: List, extract and create archive files (zip, 7z, rar, tar, gz) with the archive tool (7-Zip). Use for "unzip this", "what's inside that archive", "zip these files up".
---

# Archives (7-Zip)

The `archive` tool wraps the installed 7-Zip:

- Contents: `action="list", archive="C:\path\file.zip"`.
- Unpack: `action="extract"` (+ optional `dest`; default = folder named after the archive).
- Pack: `action="create", archive="out.zip", paths=["file1", "folder2"]`.

Use absolute paths. Confirm before overwriting an existing archive with create.
