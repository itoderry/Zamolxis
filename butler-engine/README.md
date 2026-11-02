# Butler engine

The native Windows maintenance core that the **John the Butler** agent drives. It scans drivers,
apps, network, system/security health, disk clutter and duplicate photos, and can apply fixes.
John never shows this engine's own UI - he runs it **headless** (`--dumpapps`, `--dumpnet`,
`--dumpsys`, `--dumpdup <folder>`, `--export`) and reads the JSON it writes.

Two builds are shipped in `../bin`:

- **`butler-scan.exe`** - standard user (`asInvoker`). Read-only scans run with **no UAC prompt**.
- **`butler-core.exe`** - elevated (`requireAdministrator`). Used by the silent weekly scheduled
  task and for fixes that need administrator rights.

## Build

1. Restore the WebView2 SDK (NuGet `Microsoft.Web.WebView2`) into `packages/webview2`, or point the
   `WV` env var at an existing restored SDK's `build\native` directory.
2. Run `build_all.bat` (needs MSVC - `cl.exe`, `rc.exe`). It builds BOTH variants and vendors them
   into `../bin` as `butler-core.exe` (requireAdministrator) and `butler-scan.exe` (asInvoker).

`build_app.bat` remains for building just the single `requireAdministrator` `Butler.exe`.
