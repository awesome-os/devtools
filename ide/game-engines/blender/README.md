# `@awesome-os/blender`

Debloated rolling-latest **Blender** hydrated on demand from [`awesome-os/holo-v11`](https://github.com/awesome-os/holo-v11) (`holo-v11`) with a `~118 KB` native C11 **Lumi Hydration Splash** launcher (Keep-Last-5, zero installer).

## Quick Install & Usage

### Windows (PowerShell 1-liner)

```powershell
irm https://github.com/awesome-os/blender/releases/latest/download/install.ps1 | iex
```

### Linux (x64 / ARM64) & macOS (Apple Silicon)

```sh
curl -fsSL https://github.com/awesome-os/blender/releases/latest/download/install.sh | sh
```

### CLI Usage

```powershell
# Inspect installed launcher version & help
blender --version
blender --help

# Launch Blender or open a .blend scene directly
blender
blender ./scene.blend

# Optional: store hydrated CAS layers on a custom drive/path
$env:B8G_CAS_DIR = "D:\b8g-cas"   # POSIX: export B8G_CAS_DIR=/data/b8g-cas
blender ./scene.blend
```

### Releases & Verification

- **Latest Release:** [`awesome-os/blender` Releases](https://github.com/awesome-os/blender/releases/latest) — includes `SHA256SUMS.txt` and the 5-OS matrix (`win64`, `linux-x64`, `linux-arm64`, `macos-arm64`, `wasm32-wasi`) built via [`awesome-os/maintenance-workflows`](https://github.com/awesome-os/maintenance-workflows).

## Highlights

- **Zero Installer & Zero Bloat:** Hydrates directly into `~/.b8g/cas/blender/<sha256>/` and spawns `blender.exe` / `blender` detached with forwarded user arguments.
- **SHA-256 Verified Ghost CAS (`holo-v11`):** Downloads `blender-win64.tar.zst` / `blender-linux-x64.tar.zst`, verifies SHA-256 before extraction, and supports Keep-Last-5 rollback via `BLENDER_GHOST_SHA256=<sha256>`.
- **Instant `< 15 ms` Lumi Hydration Splash:** Native Win32 GDI / POSIX C11 launcher (`src/blender_launcher.c`) displays the embedded Lumi White Dragon icon and streams live `GHOST_PROGRESS <pct> <msg>` updates during cold CAS hydration.
- **Erasable TypeScript Direct Execution:** Zero build/transpile step (`erasableSyntaxOnly: true`, `noEmit: true`), runs directly on Node 22.18+ / Node 24.

## Usage

### Native Launcher (`blender.exe` / `blender`)

```powershell
# Launch Blender with Lumi Hydration Splash
.\dist\blender.exe scene.blend

# Inspect version & CAS asset key
.\dist\blender.exe --version
```

### Node CLI (`src/cli.mts`)

```powershell
# Print version and platform CAS key
node src/cli.mts --version

# Resolve CAS index and print launch plan JSON without spawning
node src/cli.mts --dry-run scene.blend

# Stream GHOST_PROGRESS lines during hydration
$env:BLENDER_PROGRESS="1"; node src/cli.mts
```

## Environment Variables

| Variable | Description |
| :--- | :--- |
| `BLENDER_GHOST_SHA256` | Pin to a Keep-Last-5 historical SHA-256 from `holo-v11 @ holo-v11`. |
| `BLENDER_PROGRESS=1` | Emit `GHOST_PROGRESS <pct> <msg>` lines on stdout during hydration. |
| `BLENDER_CLI_PATH` | Override path to `src/cli.mts` for the native C11 launcher. |
| `B8G_CAS_DIR` | Override default `~/.b8g/cas` cache directory. |

## Build & Test

```powershell
# Run CAS & CLI test suite
node --test test/blender-cas.test.mts

# Compile Windows native launcher (~118 KB with embedded Lumi icon)
zig cc -target x86_64-windows-gnu -std=c11 -Os -s -Wl,--subsystem,windows -Wall -Wextra src/blender_launcher.c lumi.res -lgdi32 -luser32 -o dist/blender.exe

# Compile Linux native launcher
gcc -std=c11 -Os -s -Wall -Wextra src/blender_launcher.c -o dist/blender
```

## License

Dual-licensed under **GPL-3.0-or-later OR MIT**.

## Quick Install & Run (Windows / Linux / macOS)

```sh
# Install / hydrate from v11 CAS via holo-pm
holo-pm install repository://github.com/awesome-os/blender@main

# Or project & run directly via holo-project (0-byte hardlink)
holo-project "project://node/blender?from=repository://github.com/awesome-os/blender@main"
```
