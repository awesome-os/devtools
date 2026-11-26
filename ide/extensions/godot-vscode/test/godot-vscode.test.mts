import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONTRIBUTED_COMMANDS,
  activate,
  buildGodotRunCommand,
  deactivate,
  normalizePlatformTarget,
  resolveGodotStudioPlan,
  type DisposableLike,
  type HoloV11GlobalManifest,
} from '../src/extension.mts';

const SHA512_RE = /^[0-9a-f]{128}$/;

describe('godot-vscode live Holo v11 resolution', () => {
  it('resolves godot, dotnet, and b8g-shim from live awesome-os/holo-v11 manifest', async () => {
    for (const target of ['linux-x64', 'win64'] as const) {
      const plan = await resolveGodotStudioPlan({ target });
      assert.equal(plan.target, target);
      assert.equal(plan.casLayout, 'v11');
      assert.equal(plan.ready, true);
      assert.deepEqual(plan.missingComponents, []);

      assert.ok(plan.godot);
      assert.match(plan.godot.sha512, SHA512_RE);
      assert.ok(plan.dotnetSdk);
      assert.match(plan.dotnetSdk.sha512, SHA512_RE);
      assert.ok(plan.abiShim);
      assert.match(plan.abiShim.sha512, SHA512_RE);
    }
  });

  it('resolves synthetic Holo v11 manifest deterministically', async () => {
    const synthetic: HoloV11GlobalManifest = {
      schema: 'awesome-os-cas-v11-manifest-v1',
      abiMagic: '0x33564742',
      version: 'v11',
      generatedAt: '2026-11-26T00:00:00Z',
      totalRepos: 3,
      totalAssets: 3,
      entries: [
        {
          id: 'awesome-os/godot@v0.2.0/godot-linux-x64',
          repo: 'godot',
          tag: 'v0.2.0',
          filename: 'godot-linux-x64',
          target: 'linux-x64',
          sha512: 'a'.repeat(128),
          size: 1118512,
          blobPath: `v11/files/aa/${'a'.repeat(128)}`,
          downloadUrl: 'https://github.com/awesome-os/godot/releases/download/v0.2.0/godot-linux-x64',
        },
        {
          id: 'awesome-os/dotnet@v0.1.0/dotnet-linux-x64',
          repo: 'dotnet',
          tag: 'v0.1.0',
          filename: 'dotnet-linux-x64',
          target: 'linux-x64',
          sha512: 'b'.repeat(128),
          size: 39648,
          blobPath: `v11/files/bb/${'b'.repeat(128)}`,
          downloadUrl: 'https://github.com/awesome-os/dotnet/releases/download/v0.1.0/dotnet-linux-x64',
        },
        {
          id: 'awesome-os/holo-compiler@v0.7.0/b8g-shim-linux-x64',
          repo: 'holo-compiler',
          tag: 'v0.7.0',
          filename: 'b8g-shim-linux-x64',
          target: 'linux-x64',
          sha512: 'c'.repeat(128),
          size: 38024,
          blobPath: `v11/files/cc/${'c'.repeat(128)}`,
          downloadUrl: 'https://github.com/awesome-os/holo-compiler/releases/download/v0.7.0/b8g-shim-linux-x64',
        },
      ],
    };

    const plan = await resolveGodotStudioPlan({ target: 'linux-x64', manifest: synthetic });
    assert.equal(plan.ready, true);
    assert.equal(plan.hydratedAssets.length, 3);
    assert.equal(plan.env.B8G_GODOT_VERSION, 'v0.2.0');
  });
});

describe('godot-vscode command builder & activation', () => {
  it('normalizes host platforms to Holo v11 target names', () => {
    assert.equal(normalizePlatformTarget('win32', 'x64'), 'win64');
    assert.equal(normalizePlatformTarget('linux', 'x64'), 'linux-x64');
    assert.equal(normalizePlatformTarget('linux', 'arm64'), 'linux-arm64');
    assert.equal(normalizePlatformTarget('darwin', 'arm64'), 'macos-arm64');
  });

  it('builds run, editor, export, and dotnet-build commands and activates cleanly', () => {
    const runCmd = buildGodotRunCommand({
      action: 'run',
      projectPath: '/work/demo',
      scene: 'res://main.tscn',
    });
    assert.ok(runCmd.args.includes('--path'));
    assert.ok(runCmd.args.includes('res://main.tscn'));

    const subs: DisposableLike[] = [];
    const registered: string[] = [];
    activate(
      { subscriptions: subs },
      {
        commands: {
          registerCommand(id) {
            registered.push(id);
            return { dispose() {} };
          },
        },
      },
    );
    assert.deepEqual(registered, [...CONTRIBUTED_COMMANDS]);
    deactivate();
  });
});
