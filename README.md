# Awesome-OS DevTools (`awesome-os/devtools`)

Unified Awesome-OS DevTools Monorepo consolidating IDEs, VS Code / Open VSX extensions, Game Engines, native C11 dynamic-loading splashscreen launchers, and 4DGS / Holonomic Game Engine research over **Holo v11 CAS** (`awesome-os/holo-v11`, `B8G_ABI_MAGIC_V3 = 0x33564742`).

## Architecture & Directory Map

### 1. IDEs (`ide/`)

| Component | Path | Description |
| :--- | :--- | :--- |
| **Code - OSS** | [`ide/code-oss/`](ide/code-oss/README.md) | Telemetry-free Code - OSS hydrated via Holo v11 CAS (`electron`, `code-oss`, `ts-morph`, `b8g-shim`) |
| **Eclipse Theia** | [`ide/theia/`](ide/theia/README.md) | Theia IDE adapter over Sectium Display (`B8G_ARENA_V1`) or shared Electron + Holo v11 CAS |
| **B8G IDE** | [`ide/b8g-ide/`](ide/b8g-ide/README.md) | Sectium WebRenderer DevPlane (`B8G_DISPLAY_V1`, `b8g-devplane` extension, `ttyS0` terminal) |

### 2. VS Code / Open VSX Extensions (`ide/extensions/`)

| Extension | Path | Scope |
| :--- | :--- | :--- |
| **`stealifylang-vscode`** | [`ide/extensions/stealifylang-vscode/`](ide/extensions/stealifylang-vscode/README.md) | StealifyLang LSP (`--stdio`), `stealify-lint` (`B8G001`-`B8G016`), governance rules, Holo v11 TS resolver |
| **`obs-vscode`** | [`ide/extensions/obs-vscode/`](ide/extensions/obs-vscode/README.md) | Portable OBS Studio 33 + `libsectium_display` overlay bridge over Holo v11 CAS |
| **`godot-vscode`** | [`ide/extensions/godot-vscode/`](ide/extensions/godot-vscode/README.md) | Godot 4 + .NET SDK + `b8g-shim` plan & command builder |
| **`blender-vscode`** | [`ide/extensions/blender-vscode/`](ide/extensions/blender-vscode/README.md) | Blender 5 + `bpy` script / addon hot-reload + `libsectium_display` bridge |
| **`unity-vscode`** | [`ide/extensions/unity-vscode/`](ide/extensions/unity-vscode/README.md) | Unity 6 `.NET` Roslyn build + batchmode runner over Holo v11 CAS |
| **`unreal-vscode`** | [`ide/extensions/unreal-vscode/`](ide/extensions/unreal-vscode/README.md) | Zero-VS UE5 UBT toolchain + C11/C++20 [`b8g_unreal_bridge.h`](ide/extensions/unreal-vscode/native/b8g_unreal_bridge.h) |

### 3. Game Engines (`ide/game-engines/`)

| Engine | Path | Description |
| :--- | :--- | :--- |
| **B8G Game Engine** | [`ide/game-engines/b8g-game-engine/`](ide/game-engines/b8g-game-engine/index.mts) | Predictive streaming, `.b8p` CAS closure gate, $S^3$ quaternion physics, 15-axis OBB-SAT, spatial audio, telemetry ring, C11 ABI v3 |
| **Asymmetric Hunt 3D** | [`ide/game-engines/asymmetric-hunt/`](ide/game-engines/asymmetric-hunt/index.mts) | 3v4 Compound & 1v4 Trials 3D survival-hunt engine, GLB drop-in loader, utility AI bots, LAN server |
| **Godot** | [`ide/game-engines/godot/`](ide/game-engines/godot/README.md) | Rolling-latest MIT Godot 4 launcher + Holo v11 Keep-Last-5 CAS hydration |
| **Blender** | [`ide/game-engines/blender/`](ide/game-engines/blender/README.md) | Rolling-latest Blender launcher + Holo v11 Keep-Last-5 CAS hydration |

### 4. Native C11 Dynamic Launchers & 24-Bit BMP Splashes (`ide/launchers/`)

- [`holo_devtools_cli.c`](ide/launchers/holo_devtools_cli.c): Standalone C11 CLI launcher (`holo-devtools-launcher`) over `dynamic_loader.c` and `splash_blitter.c`, verifying `B8G_ABI_MAGIC_V3 = 0x33564742`.
- [`splash_blitter.c`](ide/launchers/splash_blitter.c) & [`splash_blitter.h`](ide/launchers/splash_blitter.h): C11 24-bit uncompressed BMP splashscreen generator with branded palettes (`godot`, `blender`, `unity`, `unreal`, `asymmetric-hunt`, `code-oss`, `theia`) and Holo v11 SHA-512 progress bar.
- [`dynamic_loader.c`](ide/launchers/dynamic_loader.c) & [`dynamic_loader.h`](ide/launchers/dynamic_loader.h): Native C11 dynamic loader (`LoadLibraryA`/`GetProcAddress` on Windows, `dlopen`/`dlsym` on POSIX) verifying `B8G_ABI_MAGIC_V3 = 0x33564742`, updating 24-bit BMP splash progress (`25% -> 70% -> 100%`), and invoking `b8g_engine_entry_v3`.
- [`sample_engine_plugin.c`](ide/launchers/sample_engine_plugin.c) & [`launcher_selftest.c`](ide/launchers/launcher_selftest.c): End-to-end dynamic shared library (`.dll`/`.so`) + splash verification harness.
- [`generate-splashes.mts`](ide/launchers/generate-splashes.mts) & [`launchers.test.mts`](ide/launchers/launchers.test.mts): Deterministic `480x180` 24-bit BMP asset generator (`ide/launchers/assets/*.bmp`) and native compile/exec suite.
- **Live Native Release ([`v11-devtools-launchers-latest`](https://github.com/awesome-os/devtools/releases/tag/v11-devtools-launchers-latest)):** Built and verified via [`.github/workflows/release-v11-launchers.yml`](.github/workflows/release-v11-launchers.yml) on `linux-x86_64` — publishing `holo-devtools-launcher`, `libsample_engine_plugin.so`, 7 branded 24-bit BMP splashscreens in `devtools-launchers-linux-x86_64-holo-v11.tar.gz`, `holo-v11-manifest.json`, and `SHA512SUMS.txt`.

### 5. Research (`research/`)

- [`01-asog-trigs-4d-gaussian-splatting-analysis.md`](research/01-asog-trigs-4d-gaussian-splatting-analysis.md)
- [`03-rage9-vs-b8g-holonomic-game-engine.md`](research/03-rage9-vs-b8g-holonomic-game-engine.md)
- [`04-holonomic-entity-section-visual-physics-identity.md`](research/04-holonomic-entity-section-visual-physics-identity.md)

## Verification & `holo-ci@v1`

Verified across **`88/88` tests** (`npm test`) and centralized **`holo-ci@v1`** ([`.github/workflows/holo-ci.yml`](.github/workflows/holo-ci.yml) + [`holo-ci.json`](holo-ci.json)) on Node 22+ (`erasableSyntaxOnly: true`, zero build step):

```bash
npm test
node alignment/verify-devtools.mts
holo-ci verify --cwd .
```
