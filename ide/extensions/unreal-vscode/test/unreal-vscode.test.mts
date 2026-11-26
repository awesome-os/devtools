import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  activate,
  COMMAND_IDS,
  createViewportWebviewHtml,
  deactivate,
  type ExtensionContextLike,
  type VscodeApiLike,
} from '../src/extension.mts';
import {
  buildUbtCommand,
  fetchCasIndex,
  resolveUnrealGhostToolchain,
  type HoloV11GlobalManifest,
} from '../src/toolchain.mts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SHA512_RE = /^[0-9a-f]{128}$/;

let liveIndexPromise: Promise<HoloV11GlobalManifest> | null = null;
function getLiveCasIndex(): Promise<HoloV11GlobalManifest> {
  if (!liveIndexPromise) {
    liveIndexPromise = fetchCasIndex();
  }
  return liveIndexPromise;
}

function resolveCompilers(): {
  kind: 'zig' | 'system';
  cBin: string;
  cBaseArgs: string[];
  cxxBin: string;
  cxxBaseArgs: string[];
} {
  const zigCandidates = [
    process.env.ZIG_BIN,
    process.platform === 'win32' ? 'e:\\awesome-os\\bin\\zig.cmd' : undefined,
    'zig',
  ].filter((v): v is string => Boolean(v));

  for (const candidate of zigCandidates) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (existsSync(candidate)) {
        return {
          kind: 'zig',
          cBin: candidate,
          cBaseArgs: ['cc'],
          cxxBin: candidate,
          cxxBaseArgs: ['c++'],
        };
      }
      continue;
    }
    const probe = spawnSync(candidate, ['version'], { stdio: 'pipe' });
    if (probe.status === 0) {
      return {
        kind: 'zig',
        cBin: candidate,
        cBaseArgs: ['cc'],
        cxxBin: candidate,
        cxxBaseArgs: ['c++'],
      };
    }
  }

  for (const [cName, cxxName] of [
    ['cc', 'c++'],
    ['gcc', 'g++'],
    ['clang', 'clang++'],
  ] as const) {
    if (spawnSync(cName, ['--version'], { stdio: 'pipe' }).status === 0) {
      return { kind: 'system', cBin: cName, cBaseArgs: [], cxxBin: cxxName, cxxBaseArgs: [] };
    }
  }

  throw new Error('No C11/C++20 compiler (zig, cc/c++, gcc/g++, clang/clang++) found');
}

test('live Holo v11 manifest resolves all Win64 UE5 zero-VS prerequisites', async () => {
  const manifest = await getLiveCasIndex();
  assert.equal(manifest.schema, 'awesome-os-cas-v11-manifest-v1');
  assert.equal(manifest.abiMagic, '0x33564742');

  const tc = resolveUnrealGhostToolchain(manifest, 'win32');
  assert.equal(tc.casTag, 'v11');
  assert.equal(tc.platform, 'win32');
  assert.equal(tc.ubtPlatform, 'Win64');

  assert.equal(tc.dotnetSdk.filename, 'dotnet.exe');
  assert.equal(tc.holoCompiler.filename, 'b8g-shim.exe');
  assert.equal(tc.sectiumDisplay.filename, 'libsectium_display.dll');
  assert.equal(tc.abiShim.filename, 'libholo-pm-windows-x86_64.dll');

  for (const artifact of [tc.dotnetSdk, tc.holoCompiler, tc.sectiumDisplay, tc.abiShim]) {
    assert.match(artifact.sha512, SHA512_RE);
    assert.ok(artifact.bytes > 0);
  }
});

test('live Holo v11 manifest resolves all Linux x64 UE5 zero-VS prerequisites', async () => {
  const manifest = await getLiveCasIndex();
  const tc = resolveUnrealGhostToolchain(manifest, 'linux');
  assert.equal(tc.platform, 'linux');
  assert.equal(tc.ubtPlatform, 'Linux');

  assert.equal(tc.dotnetSdk.filename, 'dotnet-linux-x64');
  assert.equal(tc.holoCompiler.filename, 'b8g-shim-linux-x64');
  assert.equal(tc.sectiumDisplay.filename, 'libsectium_display-linux-x64.so');
  assert.equal(tc.abiShim.filename, 'libholo-pm-linux-x86_64.so');
  assert.ok(tc.totalBytes > 50_000);
});

test('buildUbtCommand() emits zero-VS UBT command and clangd database mode', async () => {
  const manifest = await getLiveCasIndex();
  const winToolchain = resolveUnrealGhostToolchain(manifest, 'win32');

  const buildSpec = buildUbtCommand(
    'D:\\Projects\\Lyra\\Lyra.uproject',
    'LyraEditor',
    'Development',
    winToolchain,
    { engineRoot: 'D:\\UE_5.5', cacheDir: 'D:\\.b8g\\unreal-ghost' },
  );

  assert.equal(buildSpec.command, 'D:\\.b8g\\unreal-ghost\\dotnet-sdk\\dotnet.exe');
  assert.ok(buildSpec.args.includes('LyraEditor'));
  assert.ok(buildSpec.args.includes('Win64'));
  assert.ok(buildSpec.args.includes('-Compiler=Clang'));
  assert.equal(buildSpec.env.UE_ZERO_VISUAL_STUDIO, '1');
  assert.equal(buildSpec.env.B8G_DOTNET_SHA512, winToolchain.dotnetSdk.sha512);
  assert.match(buildSpec.env.CC, /clang-cl\.exe$/);

  const clangDbSpec = buildUbtCommand(
    '/work/Lyra/Lyra.uproject',
    'LyraEditor',
    'DebugGame',
    resolveUnrealGhostToolchain(manifest, 'linux'),
    { engineRoot: '/opt/UE_5.5', generateCompileCommands: true },
  );
  assert.ok(clangDbSpec.args.includes('-Mode=GenerateClangDatabase'));
  assert.ok(clangDbSpec.args.includes('Linux'));
  assert.match(clangDbSpec.env.CXX, /clang\+\+$/);
});

test('package.json defines valid Open VSX / VS Code unreal-ghost contributions', () => {
  const pkgPath = resolve(REPO_ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    name: string;
    publisher: string;
    type: string;
    engines: { vscode: string; node: string };
    contributes: {
      commands: Array<{ command: string; title: string }>;
      taskDefinitions: Array<{ type: string }>;
    };
  };

  assert.equal(pkg.name, 'unreal-ghost');
  assert.equal(pkg.publisher, 'awesome-os');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.vscode, '^1.85.0');
  assert.equal(pkg.engines.node, '>=22.18.0');

  const commandIds = pkg.contributes.commands.map((c) => c.command);
  assert.deepEqual(commandIds, [
    'unrealGhost.hydrateToolchain',
    'unrealGhost.buildProject',
    'unrealGhost.generateCompileCommands',
    'unrealGhost.openViewport',
  ]);
  assert.ok(pkg.contributes.taskDefinitions.some((t) => t.type === 'unreal-ghost'));
});

test('extension activate() registers all 4 commands and renders B8G_ARENA_V1 viewport HTML', async () => {
  const registered = new Map<string, (...args: unknown[]) => unknown>();
  let renderedHtml = '';

  const mockVscode: VscodeApiLike = {
    commands: {
      registerCommand(id, cb) {
        registered.set(id, cb);
        return { dispose() {} };
      },
    },
    window: {
      showInformationMessage() {},
      showErrorMessage() {},
      createWebviewPanel() {
        return {
          webview: {
            get html() {
              return renderedHtml;
            },
            set html(value: string) {
              renderedHtml = value;
            },
          },
          dispose() {},
        };
      },
      createTerminal() {
        return { show() {}, sendText() {} };
      },
    },
    workspace: {
      getConfiguration() {
        return {
          get<T>(_section: string, defaultValue?: T): T {
            return defaultValue as T;
          },
        };
      },
    },
  };

  const context: ExtensionContextLike = { subscriptions: [] };
  await activate(context, mockVscode);

  assert.equal(registered.size, 4);
  for (const id of Object.values(COMMAND_IDS)) {
    assert.ok(registered.has(id), `registered command ${id}`);
  }

  registered.get(COMMAND_IDS.openViewport)?.();
  assert.ok(renderedHtml.includes('B8G_ARENA_V1'));
  assert.ok(renderedHtml.includes('0x33564742'));

  const directHtml = createViewportWebviewHtml({
    pipePath: '/tmp/sectium-dev.sock',
    projectName: 'Lyra',
  });
  assert.ok(directHtml.includes('Lyra'));
  assert.ok(directHtml.includes('/tmp/sectium-dev.sock'));
  deactivate();
});

test('native/b8g_unreal_bridge.h compiles cleanly in C11 and C++20', () => {
  const headerPath = resolve(REPO_ROOT, 'native', 'b8g_unreal_bridge.h');
  assert.ok(existsSync(headerPath), 'native/b8g_unreal_bridge.h exists');

  const comp = resolveCompilers();
  const isCmd = (bin: string): boolean =>
    process.platform === 'win32' && bin.toLowerCase().endsWith('.cmd');

  const runCc = (bin: string, args: string[]): void => {
    if (isCmd(bin)) {
      execFileSync('cmd.exe', ['/d', '/s', '/c', bin, ...args], { stdio: 'pipe' });
    } else {
      execFileSync(bin, args, { stdio: 'pipe' });
    }
  };

  const workDir = mkdtempSync(join(tmpdir(), 'unreal-v11-cc-'));
  try {
    runCc(comp.cBin, [
      ...comp.cBaseArgs,
      '-std=c11',
      '-x',
      'c',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-Wno-unused-function',
      '-c',
      '-o',
      join(workDir, 'bridge_c11.o'),
      headerPath,
    ]);
    runCc(comp.cxxBin, [
      ...comp.cxxBaseArgs,
      '-std=c++20',
      '-x',
      'c++',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-Wno-unused-function',
      '-c',
      '-o',
      join(workDir, 'bridge_cpp20.o'),
      headerPath,
    ]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
