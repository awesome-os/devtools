import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha512Hex } from '../../shared/holo-v11-cas.mts';
import {
  AWESOME_OS_BUNDLED_EXTENSIONS,
  ensureSharedExtensionsDir,
  fetchCodeOssManifest,
  getAbiShimAssetKey,
  getCodeOssBinaryKey,
  getElectronAssetKey,
  getSharedExtensionsDir,
  getTypeScriptAssetKey,
  hydrateLocalCasPayload,
  parseCliArgs,
  resolveAbiShimEntry,
  resolveCodeOssEntry,
  resolveElectronEntry,
  resolveTypeScriptEntry,
  type LaunchPlan,
} from '../src/index.mts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = resolve(REPO_ROOT, 'src', 'cli.mts');
const SHA512_RE = /^[a-f0-9]{128}$/;

test('resolves shared Electron, Code-OSS, B8G ABI shim, and TS AST from live Holo v11 manifest', async () => {
  const manifest = await fetchCodeOssManifest(true);
  assert.equal(manifest.schema, 'awesome-os-cas-v11-manifest-v1');
  assert.equal(manifest.abiMagic, '0x33564742');
  assert.ok(manifest.entries.length > 0, 'Expected non-empty Holo v11 manifest');

  const electron = await resolveElectronEntry(getElectronAssetKey(), manifest);
  assert.equal(electron.repo, 'electron');
  assert.match(electron.sha512, SHA512_RE);
  assert.ok(electron.size > 0);

  const codeOss = await resolveCodeOssEntry(getCodeOssBinaryKey(), manifest);
  assert.equal(codeOss.repo, 'code-oss');
  assert.match(codeOss.sha512, SHA512_RE);

  const abiShim = await resolveAbiShimEntry(getAbiShimAssetKey(), manifest);
  assert.equal(abiShim.repo, 'holo-compiler');
  assert.match(abiShim.sha512, SHA512_RE);

  const tsEntry = await resolveTypeScriptEntry(getTypeScriptAssetKey(), manifest);
  assert.match(tsEntry.sha512, SHA512_RE);
  assert.ok(tsEntry.size > 100_000);
});

test('stores and deduplicates Holo v11 SHA-512 CAS blobs locally with cache hit', () => {
  const prevCasDir = process.env.B8G_CAS_DIR;
  const tmpCas = mkdtempSync(join(tmpdir(), 'code-oss-v11-cas-'));
  process.env.B8G_CAS_DIR = tmpCas;
  try {
    const payload = new TextEncoder().encode('holo-v11-code-oss-cas-fixture');
    const digest = sha512Hex(payload);
    const first = hydrateLocalCasPayload(digest, payload);
    assert.equal(first.cacheHit, false);
    assert.equal(existsSync(first.blobFile), true);

    const second = hydrateLocalCasPayload(digest, payload);
    assert.equal(second.cacheHit, true);
    assert.equal(second.blobFile, first.blobFile);
  } finally {
    if (prevCasDir === undefined) delete process.env.B8G_CAS_DIR;
    else process.env.B8G_CAS_DIR = prevCasDir;
    rmSync(tmpCas, { recursive: true, force: true });
  }
});

test('exports all 5 Awesome-OS bundled extensions and shared extensions dir', () => {
  assert.equal(AWESOME_OS_BUNDLED_EXTENSIONS.length, 5);
  assert.deepEqual(
    AWESOME_OS_BUNDLED_EXTENSIONS.map((ext) => ext.id),
    ['stealifylang-vscode', 'unreal-ghost', 'godot-ghost', 'blender-ghost', 'obs-ghost'],
  );
  const sharedDir = getSharedExtensionsDir();
  assert.ok(sharedDir.endsWith('extensions'));
  assert.equal(ensureSharedExtensionsDir(), sharedDir);
  assert.equal(existsSync(sharedDir), true);
});

test('parses CLI flags (--sectium, --upstream, --dry-run, --version, passthrough)', () => {
  const sectium = parseCliArgs(['--sectium', '--dry-run', '.', '--', '--version']);
  assert.equal(sectium.backend, 'sectium');
  assert.equal(sectium.dryRun, true);
  assert.deepEqual(sectium.forwardArgs, ['.', '--', '--version']);

  assert.equal(parseCliArgs(['.'], { CODE_OSS_BACKEND: 'sectium' }).backend, 'sectium');
  assert.equal(parseCliArgs(['--upstream', '.'], { CODE_OSS_BACKEND: 'sectium' }).backend, 'upstream');
});

test('CLI --version and --dry-run resolve Holo v11 CAS launch plan', () => {
  const versionOut = execFileSync(process.execPath, [CLI_PATH, '--version'], {
    encoding: 'utf8',
  }).trim();
  assert.match(versionOut, /^@awesome-os\/code-oss /);
  assert.ok(versionOut.includes(getElectronAssetKey()));
  assert.ok(versionOut.includes(getCodeOssBinaryKey()));

  const dryRunOut = execFileSync(process.execPath, [CLI_PATH, '--dry-run', 'workspace'], {
    encoding: 'utf8',
  });
  const plan = JSON.parse(dryRunOut) as LaunchPlan;
  assert.equal(plan.casLayout, 'v11');
  assert.equal(plan.backend, 'upstream');
  assert.match(plan.electron.sha512, SHA512_RE);
  assert.match(plan.abiShim.sha512, SHA512_RE);
  assert.match(plan.typescript.sha512, SHA512_RE);
  assert.equal(plan.bundledExtensions.length, 5);
  assert.deepEqual(plan.forwardArgs, ['workspace']);
});
