> [!NOTE] Consolidated into the unified Holo v11 OS monorepo at https://github.com/awesome-os/awesome-os

# `@awesome-os/code-oss`

Telemetry-free **Code - OSS** (VS Code MIT) hydrated on **shared debloated Electron** + **`holo-v11` CAS (`holo-v11`)** + **Wave 2 TypeScript `6.0.3` (`14.3x` faster Zero-AST CAS)** + **5 default Awesome-OS extensions** with a **`~120 KB` native C11 launcher** — eliminating VSCodium's `~350 MB` duplicate installers and per-app Chromium/Electron bloat.

## Quick Install & Usage

### Windows (PowerShell 1-liner)

```powershell
irm https://github.com/awesome-os/code-oss/releases/latest/download/install.ps1 | iex
```

### Linux (x64 / ARM64) & macOS (Apple Silicon)

```sh
curl -fsSL https://github.com/awesome-os/code-oss/releases/latest/download/install.sh | sh
```

### CLI Usage

```powershell
# Inspect installed launcher version & help
code-oss --version
code-oss --help

# Open current workspace or a specific project directory
code-oss .
code-oss ./my-project

# Optional: store hydrated CAS layers on a custom drive/path
$env:B8G_CAS_DIR = "D:\b8g-cas"   # POSIX: export B8G_CAS_DIR=/data/b8g-cas
code-oss .
```

### Releases & Verification

- **Latest Release:** [`awesome-os/code-oss` Releases](https://github.com/awesome-os/code-oss/releases/latest) — includes `SHA256SUMS.txt` and the 5-OS matrix (`win64`, `linux-x64`, `linux-arm64`, `macos-arm64`, `wasm32-wasi`) built via [`awesome-os/maintenance-workflows`](https://github.com/awesome-os/maintenance-workflows).

---

## Why `@awesome-os/code-oss`?

Traditional VSCodium / VS Code installations ship a full, isolated copy of Electron (`~250 MB`), Chromium locales, `icudtl.dat`, `ffmpeg`, and `v8_context_snapshot.bin` inside every IDE build (`~350 MB` total per installation).

`@awesome-os/code-oss` splits the stack into deduplicated, SHA-256-verified CAS layers stored once per machine in `~/.b8g/cas/` (Keep-Last-5 retention):

| Layer | `holo-v11` Asset | Local CAS Path | Purpose |
| :--- | :--- | :--- | :--- |
| **Native Launcher** | `code-oss.exe` / `code-oss` (`src/code_oss_launcher.c`) | `~120 KB` binary | Zero-dep C11 launcher; direct-spawns warm CAS or hydrates via `src/cli.mts` |
| **Shared Electron** | `electron-<os>.tar.zst` | `~/.b8g/cas/electron/<sha256>/` | Debloated rolling-latest upstream Electron shared across all apps |
| **Code - OSS App** | `code-oss-app-<os>.tar.zst` | `~/.b8g/cas/code-oss/<sha256>/resources/app/` | Pure telemetry-free Code - OSS workbench + built-in extensions only |
| **Ghost ABI Bridge** | `b8g-abi-<os>.node` | `~/.b8g/cas/ghost-abi/<sha256>/` | Injected as `B8G_ABI_PATH` for zero-copy `B8G_ARENA_V1` IPC |
| **Wave 2 TypeScript `6.0.3`** | `typescript-6.0.3-programmable.tar.gz` | `~/.b8g/cas/typescript/<sha256>/` | `14.3x` faster Zero-AST CAS TypeScript SDK injected via `AWESOME_OS_TYPESCRIPT_TSDK` & `TYPESCRIPT_TSDK` |
| **Shared Extensions** | 5 Awesome-OS default extensions | `~/.b8g/cas/extensions/` | Shared extension store injected via `B8G_SHARED_EXTENSIONS_DIR` & `AWESOME_OS_BUNDLED_EXTENSIONS` |

---

## Bundled Wave 2 TypeScript `6.0.3` & Awesome-OS Extensions

### Faster Wave 2 TypeScript (`6.0.3`)

Every launch hydrates `typescript-6.0.3-programmable.tar.gz` (`14.3x` faster Zero-AST CAS compiler & language service) from `awesome-os/holo-v11` into `~/.b8g/cas/typescript/<sha256>/` and injects `AWESOME_OS_TYPESCRIPT_TSDK` and `TYPESCRIPT_TSDK` pointing at its `lib/` directory.

### Default Awesome-OS Extension Bundle (5 Extensions)

All 5 Awesome-OS default extensions share `~/.b8g/cas/extensions/` (`B8G_SHARED_EXTENSIONS_DIR`):

| # | Extension ID | Repository | Capabilities |
| :--- | :--- | :--- | :--- |
| 1 | `stealifylang-vscode` | `awesome-os/stealifylang-vscode` | StealifyLang LSP, `stealify-lint` (`B8G001`–`B8G016`), `.stealify-rules`, governance project rules |
| 2 | `unreal-ghost` | `awesome-os/unreal-vscode` | UE5 UBT + `.NET 11` + `ghost-llvm` + `ghost-winsdk` |
| 3 | `godot-ghost` | `awesome-os/godot-vscode` | Godot `4.7.2` + `.NET 11` + GDScript/C# |
| 4 | `blender-ghost` | `awesome-os/blender-vscode` | Blender `5.3.0` + `bpy` hot-reload |
| 5 | `obs-ghost` | `awesome-os/obs-vscode` | OBS `33.0.3` + HTML5 overlay hot-reload |

---

## Usage

```bash
# Run via Node 22+ erasable TypeScript directly
node src/cli.mts [files/folders...]

# Inspect resolved CAS entries (including Wave 2 TypeScript & 5 bundled extensions) without spawning Electron
node src/cli.mts --dry-run

# Print version and platform CAS asset keys
node src/cli.mts --version

# Route through sovereign sectium-electron instead of upstream Electron
node src/cli.mts --sectium [files/folders...]
```

### Environment Variables

- `B8G_CAS_DIR` — Override local CAS root (default: `~/.b8g/cas`).
- `B8G_HOLO_V11_INDEX_URL` — Override `manifests/index.json` URL.
- `B8G_HOLO_V11_CAS_URL` — Override `holo-v11` base download URL.
- `B8G_SHARED_EXTENSIONS_DIR` — Override shared extensions directory (default: `~/.b8g/cas/extensions`).
- `AWESOME_OS_TYPESCRIPT_TSDK` / `TYPESCRIPT_TSDK` — Injected on launch with hydrated Wave 2 TypeScript `6.0.3` `lib/` path.
- `AWESOME_OS_BUNDLED_EXTENSIONS` — Injected on launch with the 5 bundled Awesome-OS extension IDs.
- `ELECTRON_GHOST_SHA256` — Pin Electron to any SHA-256 in the Keep-Last-5 history.
- `CODE_OSS_GHOST_SHA256` — Pin Code - OSS `resources/app` to any SHA-256 in the Keep-Last-5 history.
- `TYPESCRIPT_GHOST_SHA256` — Pin Wave 2 TypeScript to any SHA-256 in the Keep-Last-5 history.
- `CODE_OSS_BACKEND=sectium` — Default to `sectium-electron`.
- `CODE_OSS_VERBOSE=1` — Print CAS hydration paths and hit/miss status to stderr.

---

## Building the Native C11 Launcher

```bash
# Linux ELF64
mkdir -p dist
gcc -std=c11 -Os -s -Wall -Wextra src/code_oss_launcher.c -o dist/code-oss

# Windows x64 (with Zig cc + Lumi White Dragon icon resource)
zig cc -target x86_64-windows-gnu -std=c11 -Os -s src/code_oss_launcher.c lumi.res -o dist/code-oss.exe
```

---

## Testing

```bash
node --test test/code-oss-cas.test.mts
```

---

## License

MIT — see [LICENSE](./LICENSE).

## Quick Install & Run (Windows / Linux / macOS)

```sh
# Install / hydrate from v11 CAS via holo-pm
holo-pm install repository://github.com/awesome-os/code-oss@main

# Or project & run directly via holo-project (0-byte hardlink)
holo-project "project://node/code-oss?from=repository://github.com/awesome-os/code-oss@main"
```
