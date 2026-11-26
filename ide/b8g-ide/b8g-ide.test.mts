import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  B8G_DISPLAY_ABI_MAGIC,
  decodeDevPlaneFrame,
  encodeDevPlaneFrame,
} from './devplane/protocol.mts';
import {
  activate,
  deactivate,
  type VsCodeApiSubset,
  type VsCodeFileSystemProviderLike,
  type VsCodePseudoterminalLike,
} from './extensions/b8g-devplane/src/extension.mts';
import { buildWebRendererBootPlan } from './host/webrenderer-host.mts';

const HERE = dirname(fileURLToPath(import.meta.url));

test('b8g-devplane VS Code extension manifest is valid and declares env/display/terminal', () => {
  const pkgPath = join(HERE, 'extensions', 'b8g-devplane', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    name: string;
    publisher: string;
    engines: { vscode: string };
    contributes: {
      commands: Array<{ command: string }>;
      terminal: { profiles: Array<{ id: string }> };
    };
  };
  assert.equal(pkg.name, 'b8g-devplane');
  assert.equal(pkg.publisher, 'awesome-os');
  assert.ok(pkg.engines.vscode.startsWith('^1.'));
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'b8g.devplane.showEnv'));
  assert.ok(pkg.contributes.commands.some((c) => c.command === 'b8g.devplane.rebindDisplayMode'));
  assert.ok(pkg.contributes.terminal.profiles.some((p) => p.id === 'b8g-devplane.tty'));
});

test('activate() supplies env (with secret redaction), B8G_DISPLAY_V1 display, FS, ttyS0 terminal, and event stream', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'b8g-ide-ws-'));
  const prevSecret = process.env['DUMMY_TEST_API_KEY'];
  process.env['DUMMY_TEST_API_KEY'] = 'super-secret-value';

  try {
    let registeredFs: VsCodeFileSystemProviderLike | null = null;
    let registeredPtyFactory: (() => { name: string; pty: VsCodePseudoterminalLike }) | null = null;
    const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();
    const infoMessages: string[] = [];

    const mockVsCode: VsCodeApiSubset = {
      workspace: {
        registerFileSystemProvider(scheme, provider) {
          assert.equal(scheme, 'b8g-devplane');
          registeredFs = provider;
          return { dispose() {} };
        },
      },
      commands: {
        registerCommand(command, cb) {
          registeredCommands.set(command, cb);
          return { dispose() {} };
        },
      },
      window: {
        registerTerminalProfileProvider(id, provider) {
          assert.equal(id, 'b8g-devplane.tty');
          registeredPtyFactory = () => provider.provideTerminalProfile();
          return { dispose() {} };
        },
        showInformationMessage(msg) {
          infoMessages.push(msg);
        },
      },
    };

    const subscriptions: Array<{ dispose(): void }> = [];
    const api = activate({ subscriptions, workspaceRoot: workspace, baselineTag: 'v0.5.0-baseline' }, mockVsCode);

    // 1. Env provider redacts secrets and advertises baseline + Lumi White Dragon
    const snap = registeredCommands.get('b8g.devplane.showEnv')!() as ReturnType<typeof api.getEnvSnapshot>;
    assert.equal(snap.baselineTag, 'v0.5.0-baseline');
    assert.equal(snap.brand, 'Lumi White Dragon');
    assert.equal(snap.env['DUMMY_TEST_API_KEY'], undefined);
    assert.equal(infoMessages.length, 1);

    // 2. Display provider allocates B8G_DISPLAY_V1 surface & supports 2D <-> 3D rebind
    assert.equal(api.primarySurface.abiMagic, B8G_DISPLAY_ABI_MAGIC);
    assert.equal(api.primarySurface.mode, '2d');
    const rebound = registeredCommands.get('b8g.devplane.rebindDisplayMode')!() as typeof api.primarySurface;
    assert.equal(rebound.mode, '3d');

    // 3. FS provider reads/writes inside workspace and blocks path traversal
    assert.ok(registeredFs !== null);
    const fsProv = registeredFs as VsCodeFileSystemProviderLike;
    fsProv.writeFile({ scheme: 'b8g-devplane', path: '/hello.txt' }, new TextEncoder().encode('lumi-dragon'));
    const readBack = new TextDecoder().decode(fsProv.readFile({ scheme: 'b8g-devplane', path: '/hello.txt' }));
    assert.equal(readBack, 'lumi-dragon');
    assert.throws(() => fsProv.readFile({ scheme: 'b8g-devplane', path: '/../../etc/passwd' }), /Path traversal blocked/);

    // 4. Terminal provider routes strictly over channel='command' (never 'display')
    assert.ok(registeredPtyFactory !== null);
    const { pty } = (registeredPtyFactory as () => { name: string; pty: VsCodePseudoterminalLike })();
    pty.open();
    pty.handleInput('echo hello\n');
    pty.close();

    // 5. Event stream captures both channels cleanly and round-trips NDJSON
    const reader = api.createEventStream().getReader();
    const frames = [];
    for (let i = 0; i < 5; i++) {
      const { value } = await reader.read();
      assert.ok(value);
      const roundTripped = decodeDevPlaneFrame(encodeDevPlaneFrame(value));
      frames.push(roundTripped);
    }
    await reader.cancel();

    assert.ok(frames.some((f) => f.channel === 'display' && f.topic === 'b8g.display.surface.create'));
    assert.ok(frames.some((f) => f.channel === 'display' && f.topic === 'b8g.display.surface.rebind'));
    assert.ok(frames.some((f) => f.channel === 'command' && f.topic === 'b8g.pty.open'));
    assert.ok(frames.every((f) => !(f.topic.startsWith('b8g.pty.') && f.channel === 'display')));

    assert.equal(subscriptions.length, 5);
    deactivate();
  } finally {
    if (prevSecret === undefined) delete process.env['DUMMY_TEST_API_KEY'];
    else process.env['DUMMY_TEST_API_KEY'] = prevSecret;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildWebRendererBootPlan binds stock VS Code OSS to Sectium WebRenderer with 0 B duplicate Electron', () => {
  const plan = buildWebRendererBootPlan({ baselineTag: 'v0.5.0-baseline' });
  assert.equal(plan.schema, 'b8g-ide-webrenderer-v1');
  assert.equal(plan.renderer.engine, 'sectium-browser-webrenderer');
  assert.equal(plan.renderer.brand, 'Lumi White Dragon');
  assert.equal(plan.renderer.duplicateElectronBytes, 0);
  assert.equal(plan.vscodeSource.isUpstreamUnmodified, true);
  assert.equal(plan.builtinExtensions.length, 1);
});
