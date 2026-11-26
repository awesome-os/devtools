import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha512Hex } from '../../shared/holo-v11-cas.mts';
import {
  AWESOME_OS_BUNDLED_EXTENSIONS,
  buildLaunchPlan,
  ensureSharedExtensionsDir,
  fetchTheiaManifest,
  getAbiShimAssetKey,
  getElectronAssetKey,
  getSharedExtensionsDir,
  getTheiaDefaultPluginsEnv,
  getTypeScriptAssetKey,
  hydrateLocalCasPayload,
  parseCliArgs,
  resolveAbiShimEntry,
  resolveElectronEntry,
  resolveTheiaBundleEntry,
  resolveTypeScriptEntry,
  type TheiaLaunchPlan,
} from '../src/index.mts';

const cliPath = fileURLToPath(new URL('../src/cli.mts', import.meta.url));
const tempCacheDir = mkdtempSync(join(tmpdir(), 'b8g-theia-v11-test-'));
const originalCacheDir = process.env.B8G_CAS_DIR;
process.env.B8G_CAS_DIR = tempCacheDir;
const SHA512_RE = /^[0-9a-f]{128}$/;

after(() => {
  if (originalCacheDir === undefined) {
    delete process.env.B8G_CAS_DIR;
  } else {
    process.env.B8G_CAS_DIR = originalCacheDir;
  }
  rmSync(tempCacheDir, { recursive: true, force: true });
});

describe('@awesome-os/theia Holo v11 hydration & CLI', () => {
  it('resolves live Holo v11 Theia bundle, shared Electron, ABI shim, and TS AST', async () => {
    const manifest = await fetchTheiaManifest(true);
    assert.equal(manifest.schema, 'awesome-os-cas-v11-manifest-v1');
    assert.equal(manifest.abiMagic, '0x33564742');
    assert.ok(manifest.entries.length > 0);

    const theia = await resolveTheiaBundleEntry(manifest);
    assert.equal(theia.repo, 'theia');
    assert.match(theia.sha512, SHA512_RE);
    assert.ok(theia.size > 0);

    const electron = await resolveElectronEntry(getElectronAssetKey(), manifest);
    assert.match(electron.sha512, SHA512_RE);

    const ts = await resolveTypeScriptEntry(getTypeScriptAssetKey(), manifest);
    assert.match(ts.sha512, SHA512_RE);

    const abi = await resolveAbiShimEntry(getAbiShimAssetKey(), manifest);
    assert.match(abi.sha512, SHA512_RE);
  });

  it('stores and deduplicates Holo v11 SHA-512 blobs locally with cache hit', () => {
    const payload = new TextEncoder().encode('holo-v11-theia-blob-fixture');
    const digest = sha512Hex(payload);
    const first = hydrateLocalCasPayload(digest, payload);
    assert.equal(first.cacheHit, false);
    assert.ok(existsSync(first.blobFile));

    const second = hydrateLocalCasPayload(digest, payload);
    assert.equal(second.cacheHit, true);
    assert.equal(second.blobFile, first.blobFile);
  });

  it('exports all 5 default Awesome-OS bundled extensions and shared extensions cache', () => {
    assert.equal(AWESOME_OS_BUNDLED_EXTENSIONS.length, 5);
    const sharedDir = getSharedExtensionsDir();
    assert.equal(sharedDir, join(tempCacheDir, 'extensions'));

    const res = ensureSharedExtensionsDir();
    assert.ok(existsSync(res.extensionsDir));
    assert.equal(res.theiaDefaultPlugins, `local-dir:${sharedDir}`);
    assert.equal(getTheiaDefaultPluginsEnv(), `local-dir:${sharedDir}`);

    const sampleVsix = join(sharedDir, 'sample.extension-1.0.0.vsix');
    writeFileSync(sampleVsix, 'vsix-stub', 'utf8');
    const refreshed = ensureSharedExtensionsDir();
    assert.ok(refreshed.entries.includes('sample.extension-1.0.0.vsix'));
  });

  it('supports --dry-run CLI for --sectium / --browser (zero Electron), --electron, and --version', async () => {
    const expectedBundledIds =
      'stealifylang-vscode,unreal-ghost,godot-ghost,blender-ghost,obs-ghost';

    const versionOut = execFileSync(process.execPath, [cliPath, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, B8G_CAS_DIR: tempCacheDir },
    }).trim();
    assert.match(versionOut, /^@awesome-os\/theia \d+\.\d+\.\d+$/);

    const sectiumRaw = execFileSync(process.execPath, [cliPath, '--sectium', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, B8G_CAS_DIR: tempCacheDir },
    });
    const sectiumPlan = JSON.parse(sectiumRaw) as TheiaLaunchPlan;
    assert.equal(sectiumPlan.casLayout, 'v11');
    assert.equal(sectiumPlan.mode, 'sectium');
    assert.equal(sectiumPlan.zeroElectron, true);
    assert.equal(sectiumPlan.ipcProtocol, 'B8G_ARENA_V1');
    assert.equal(sectiumPlan.sectium?.target, 'sectium-browser');
    assert.match(sectiumPlan.theiaBundle.sha512, SHA512_RE);
    assert.match(sectiumPlan.typescript.sha512, SHA512_RE);
    assert.equal(sectiumPlan.env.AWESOME_OS_BUNDLED_EXTENSIONS, expectedBundledIds);

    const browserPlan = await buildLaunchPlan(parseCliArgs(['--browser', '--dry-run']));
    assert.equal(browserPlan.mode, 'sectium');
    assert.equal(browserPlan.zeroElectron, true);

    const electronRaw = execFileSync(process.execPath, [cliPath, '--electron', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, B8G_CAS_DIR: tempCacheDir },
    });
    const electronPlan = JSON.parse(electronRaw) as TheiaLaunchPlan;
    assert.equal(electronPlan.mode, 'electron');
    assert.equal(electronPlan.zeroElectron, false);
    assert.match(electronPlan.electron?.sha512 ?? '', SHA512_RE);
    assert.match(electronPlan.abiShim?.sha512 ?? '', SHA512_RE);
    assert.equal(electronPlan.env.B8G_ABI_PATH, electronPlan.abiShim?.shimPath);
  });
});
