> [!NOTE] Consolidated into the unified Holo v11 OS monorepo at https://github.com/awesome-os/awesome-os

# B8G IDE (`awesome-os/b8g-ide`)

**Zero-Electron VS Code OSS running on the Sectium WebRenderer (`sectium-browser @ v0.5.0-baseline`), with all missing desktop capabilities supplied by the `b8g-devplane` VS Code Extension.**

## Architecture

Instead of maintaining a brittle Electron + Chromium + VS Code C++ fork, **`b8g-ide`** keeps **upstream VS Code OSS source 100% unmodified** and layers only two thin, update-proof pieces around it:

1. **Sectium WebRenderer Host (`host/webrenderer-host.mts`)** — Boots standard upstream VS Code workbench source inside the **Sectium Browser** pure-art display appliance (`sectium-browser @ v0.5.0-baseline`, Lumi White Dragon branded, `0 B` duplicate Chromium/V8).
2. **`b8g-devplane` VS Code Extension (`extensions/b8g-devplane/`)** — A standard VS Code extension (`activate` / `deactivate`) that works in both WebRenderer mode and stock desktop VS Code, supplying every missing host capability over the Sectium DevPlane pipe (`\\.\pipe\sectium-dev` / `/tmp/sectium-dev.sock`):
   - **`env`** (`b8g.devplane.env`): Filtered host/workspace environment, `b8g-shim` virtualized toolchain paths, and pinned `sectium-browser` baseline metadata.
   - **`display`** (`b8g.devplane.display`): `B8G_DISPLAY_V1` (`libsectium_display`) surface allocation, split-pane binding, `2D <-> 3D` rebind, and Lumi White Dragon theme/icon state.
   - **`fs`** (`b8g-devplane://` `FileSystemProvider`): Path-traversal-guarded host/workspace file access without Electron Node integration.
   - **`terminal`** (`b8g-devplane.tty` `Pseudoterminal`): Integrated terminal routed strictly over `channel: 'command'` (`ttyS0` NDJSON) + `b8g-shim` (keeping `channel: 'display'` pure art).
   - **`devtools`**: Live `ReadableStream` event feed (`createEventStream()`) for cross-tab IDE & agent observation.

## Quick Verification

```bash
node --test b8g-ide.test.mts
```

## License

BSD-3-Clause — Awesome-OS Contributors.

## Quick Install & Run (Windows / Linux / macOS)

```sh
# Install / hydrate from v11 CAS via holo-pm
holo-pm install repository://github.com/awesome-os/b8g-ide@main

# Or project & run directly via holo-project (0-byte hardlink)
holo-project "project://cpp/b8g-ide?from=repository://github.com/awesome-os/b8g-ide@main"
```
