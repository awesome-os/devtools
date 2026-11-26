import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  activate,
  buildObsLaunchCommand,
  deactivate,
  resolveObsStudioPlan,
} from '../src/extension.mts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA512_RE = /^[a-f0-9]{128}$/;

test('resolves live Holo v11 obs, libsectium_display, and b8g-shim for win64', async () => {
  const plan = await resolveObsStudioPlan({
    platform: 'win32',
    arch: 'x64',
    forceRefresh: true,
  });

  assert.equal(plan.indexSchema, 'awesome-os-cas-v11-manifest-v1');
  assert.equal(plan.obs.filename, 'obs.exe');
  assert.match(plan.obs.sha512, SHA512_RE);
  assert.ok(plan.obs.size > 10_000);

  assert.equal(plan.sectiumDisplay.filename, 'libsectium_display.dll');
  assert.match(plan.sectiumDisplay.sha512, SHA512_RE);
  assert.ok(plan.sectiumDisplay.size > 10_000);

  assert.equal(plan.abiShim.filename, 'b8g-shim.exe');
  assert.match(plan.abiShim.sha512, SHA512_RE);
});

test('buildObsLaunchCommand sets cwd to bin/64bit and formats portable/scene/recording flags', async () => {
  const plan = await resolveObsStudioPlan({
    platform: 'win32',
    arch: 'x64',
    cacheDir: 'C:\\b8g-cas',
  });

  const launch = buildObsLaunchCommand(plan, {
    portable: true,
    scene: 'Awesome-OS Demo',
    startRecording: true,
    overlayUrl: 'file:///workspace/overlay.html',
    extraArgs: ['--multi'],
  });

  assert.ok(launch.cwd.endsWith('\\bin\\64bit') || launch.cwd.endsWith('/bin/64bit'));
  assert.ok(launch.command.endsWith('\\bin\\64bit\\obs64.exe'));
  assert.deepEqual(launch.args, [
    '--portable',
    '--scene',
    'Awesome-OS Demo',
    '--startrecording',
    '--multi',
  ]);
  assert.equal(launch.env.B8G_OBS_SHA512, plan.obs.sha512);
  assert.equal(launch.env.B8G_SECTIUM_DISPLAY_SHA512, plan.sectiumDisplay.sha512);
  assert.equal(launch.env.B8G_ABI_SHIM_SHA512, plan.abiShim.sha512);
  assert.equal(launch.env.OBS_OVERLAY_URL, 'file:///workspace/overlay.html');
});

test('package.json defines valid Open VSX / VS Code manifest and obs-ghost contributions', () => {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
    name: string;
    publisher: string;
    type: string;
    license: string;
    main: string;
    contributes: {
      commands: Array<{ command: string; title: string }>;
      taskDefinitions: Array<{ type: string }>;
    };
  };

  assert.equal(pkg.name, 'obs-ghost');
  assert.equal(pkg.publisher, 'awesome-os');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.main, './src/extension.mts');

  const commandIds = pkg.contributes.commands.map((c) => c.command);
  assert.deepEqual(commandIds, [
    'obsGhost.hydrate',
    'obsGhost.launch',
    'obsGhost.previewOverlay',
    'obsGhost.startRecording',
  ]);
  assert.equal(pkg.contributes.taskDefinitions[0]?.type, 'obs-ghost');
});

test('activate() and deactivate() run cleanly headless', async () => {
  await activate();
  deactivate();
});
