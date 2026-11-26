import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  activate,
  buildBlenderScriptCommand,
  deactivate,
  EXTENSION_COMMANDS,
  getAbiShimAssetKey,
  getBlenderAssetKey,
  getSectiumDisplayAssetKey,
  resolveBlenderStudioPlan,
} from '../src/extension.mts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA512_RE = /^[a-f0-9]{128}$/;

test('resolves live Holo v11 Blender + libsectium_display + b8g-shim for win64 and linux-x64', async () => {
  const winPlan = await resolveBlenderStudioPlan({ platform: 'win32', arch: 'x64', forceRefresh: true });
  assert.equal(winPlan.indexSchema, 'awesome-os-cas-v11-manifest-v1');
  assert.equal(winPlan.blender.filename, 'blender.exe');
  assert.match(winPlan.blender.sha512, SHA512_RE);
  assert.equal(winPlan.sectiumDisplay.filename, 'libsectium_display.dll');
  assert.match(winPlan.sectiumDisplay.sha512, SHA512_RE);
  assert.equal(winPlan.abiShim.filename, 'b8g-shim.exe');
  assert.equal(winPlan.viewportBridge.pipePath, '\\\\.\\pipe\\sectium-dev');
  assert.equal(winPlan.viewportBridge.channel, 'display');

  const linuxPlan = await resolveBlenderStudioPlan({ platform: 'linux', arch: 'x64' });
  assert.equal(linuxPlan.blender.filename, 'blender-linux-x64');
  assert.match(linuxPlan.blender.sha512, SHA512_RE);
  assert.equal(linuxPlan.sectiumDisplay.filename, 'libsectium_display-linux-x64.so');
  assert.equal(linuxPlan.abiShim.filename, 'b8g-shim-linux-x64');
  assert.equal(linuxPlan.viewportBridge.pipePath, '/tmp/sectium-dev.sock');
});

test('maps platform asset keys for Blender, libsectium_display, and b8g-shim', () => {
  assert.equal(getBlenderAssetKey('win32', 'x64'), 'blender.exe');
  assert.equal(getBlenderAssetKey('linux', 'x64'), 'blender-linux-x64');
  assert.equal(getSectiumDisplayAssetKey('win32', 'x64'), 'libsectium_display.dll');
  assert.equal(getSectiumDisplayAssetKey('linux', 'x64'), 'libsectium_display-linux-x64.so');
  assert.equal(getSectiumDisplayAssetKey('linux', 'arm64'), 'libsectium_display-linux-arm64.so');
  assert.equal(getSectiumDisplayAssetKey('darwin', 'arm64'), 'libsectium_display-macos-arm64.dylib');
  assert.equal(getAbiShimAssetKey('win32', 'x64'), 'b8g-shim.exe');
  assert.equal(getAbiShimAssetKey('linux', 'x64'), 'b8g-shim-linux-x64');
});

test('buildBlenderScriptCommand builds bpy script and addon live-reload commands', async () => {
  const plan = await resolveBlenderStudioPlan({ platform: 'linux', arch: 'x64' });

  const scriptCmd = buildBlenderScriptCommand({
    plan,
    blendFile: 'scenes/demo.blend',
    scriptPath: 'scripts/bake.py',
    background: true,
    factoryStartup: true,
    extraArgs: ['--samples', '64'],
  });
  assert.equal(scriptCmd.mode, 'runScript');
  assert.equal(scriptCmd.executable, plan.executablePath);
  assert.deepEqual(scriptCmd.args, [
    '--background',
    '--factory-startup',
    'scenes/demo.blend',
    '--python-exit-code',
    '1',
    '--python',
    'scripts/bake.py',
    '--',
    '--samples',
    '64',
  ]);
  assert.equal(scriptCmd.env.SECTIUM_DISPLAY_PIPE, '/tmp/sectium-dev.sock');
  assert.equal(scriptCmd.env.SECTIUM_DISPLAY_CHANNEL, 'display');
  assert.equal(scriptCmd.env.B8G_BLENDER_SHA512, plan.blender.sha512);
  assert.equal(scriptCmd.env.SECTIUM_DISPLAY_SHA512, plan.sectiumDisplay.sha512);

  const reloadCmd = buildBlenderScriptCommand({
    plan,
    addonModule: 'awesome_os_viewport',
  });
  assert.equal(reloadCmd.mode, 'reloadAddon');
  assert.ok(reloadCmd.args[3].includes('awesome_os_viewport'));
  assert.ok(reloadCmd.args[3].includes('importlib.reload'));
});

test('package.json defines valid Open VSX / VS Code extension manifest and contributions', async () => {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    name: string;
    publisher: string;
    type: string;
    license: string;
    main: string;
    contributes: { commands: Array<{ command: string }> };
  };

  assert.equal(pkg.name, 'blender-ghost');
  assert.equal(pkg.publisher, 'awesome-os');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.main, './src/extension.mts');
  assert.deepEqual(
    pkg.contributes.commands.map((c) => c.command),
    [...EXTENSION_COMMANDS],
  );
  await activate();
  deactivate();
});
