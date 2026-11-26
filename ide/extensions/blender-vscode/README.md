# Awesome-OS Blender 5.3 Ghost (`blender-ghost`)

MIT-licensed Blender 5.3 extension for **Awesome-OS Code - OSS** and **Eclipse Theia** (Open VSX / VS Code compatible).

## Install & Usage

### 1-Command `.vsix` Install (Awesome-OS Code - OSS / Eclipse Theia / VS Code)

```powershell
gh release download -R awesome-os/blender-vscode --pattern "*.vsix" --dir "$HOME/.b8g/cas/extensions" --clobber
```

Or download the `.vsix` from [`Releases`](https://github.com/awesome-os/blender-vscode/releases/latest) and run `code-oss --install-extension <file>.vsix` (or install from Open VSX once published).

### Usage

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

- **Blender Ghost: Hydrate Blender 5.3 from holo-v11 holo-v11** (`blenderGhost.hydrate`)
- **Blender Ghost: Launch Blender 5.3 with libsectium_display Bridge** (`blenderGhost.launch`)
- **Blender Ghost: Run Active bpy Script** (`blenderGhost.runScript`)
- **Blender Ghost: Live Reload Addon** (`blenderGhost.reloadAddon`)

Run tests locally (Node.js 22+):

```powershell
node --test test/*.test.mts
```

## Features

- **Instant `holo-v11 @ holo-v11` Hydration:** Resolves and verifies rolling-latest Blender `5.3.0` (`blender-win64.tar.zst` / `blender-linux-x64.tar.zst`) alongside `libsectium_display` and `b8g-abi` directly from [`awesome-os/holo-v11`](https://github.com/awesome-os/holo-v11) (`holo-v11`).
- **`bpy` Script Execution & Addon Live Reload:** Builds deterministic Blender command invocations with `--python`, `--python-expr`, `--python-exit-code 1`, and optional `--background` execution.
- **`libsectium_display` Viewport Bridge:** Wires native host pipe IPC (`\\.\pipe\sectium-dev` on Windows, `/tmp/sectium-dev.sock` on POSIX) so Blender viewports stream cleanly into Sectium without local HTTP servers.
- **Erasable TypeScript (`erasableSyntaxOnly: true`):** Runs directly on Node 22+ / 24+ with zero transpilation or bundler overhead.

## Contributed Commands & Tasks

| Contribution | ID / Type | Description |
| :--- | :--- | :--- |
| Command | `blenderGhost.hydrate` | Hydrate Blender 5.3 + `libsectium_display` + `b8g-abi` from `holo-v11 @ holo-v11` |
| Command | `blenderGhost.launch` | Launch Blender 5.3 with the `libsectium_display` viewport bridge |
| Command | `blenderGhost.runScript` | Run the active `bpy` Python script in Blender 5.3 |
| Command | `blenderGhost.reloadAddon` | Live-reload a Blender addon module via `bpy` |
| Task Definition | `blender-ghost` | Declarative VS Code / Theia task type (`hydrate`, `launch`, `runScript`, `reloadAddon`) |

## Usage

```ts
import {
  resolveBlenderStudioPlan,
  buildBlenderScriptCommand,
} from './src/extension.mts';

const plan = await resolveBlenderStudioPlan({ platform: 'win32', arch: 'x64' });
const cmd = buildBlenderScriptCommand({
  plan,
  scriptPath: 'scripts/export_scene.py',
  blendFile: 'scenes/hero.blend',
  background: true,
});
console.log(cmd.executable, cmd.args);
```

## Testing

```bash
node --test test/blender-vscode.test.mts
```

## License

[MIT](./LICENSE)

## Quick Install & Run (Windows / Linux / macOS)

```sh
# Install / hydrate from v11 CAS via holo-pm
holo-pm install repository://github.com/awesome-os/blender-vscode@main

# Or project & run directly via holo-project (0-byte hardlink)
holo-project "project://node/blender-vscode?from=repository://github.com/awesome-os/blender-vscode@main"
```
