import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha512Hex } from '../../../shared/holo-v11-cas.mts';
import {
  applyKeepLast5Pin,
  buildLaunchPlan,
  fetchBlenderManifest,
  getBlenderAssetKey,
  getBlenderExecutableRelPath,
  hydrateLocalBlenderPayload,
  parseCliArgs,
  tryResolveBlenderEntry,
  type HoloV11Entry,
} from '../src/index.mts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = resolve(REPO_ROOT, 'src', 'cli.mts');
const SHA512_RE = /^[a-f0-9]{128}$/;

test('fetches live Holo v11 manifest and resolves blender binary entry', async () => {
  const manifest = await fetchBlenderManifest(true);
  assert.equal(manifest.schema, 'awesome-os-cas-v11-manifest-v1');
  assert.ok(manifest.entries.length > 0);

  const blenderKey = getBlenderAssetKey();
  const blenderEntry = await tryResolveBlenderEntry(blenderKey, manifest);
  assert.ok(blenderEntry, `Expected live Blender entry for ${blenderKey}`);
  assert.equal(blenderEntry.repo, 'blender');
  assert.match(blenderEntry.sha512, SHA512_RE);
  assert.ok(blenderEntry.size > 10_000);
});

test('maps platform asset keys and executable paths accurately', () => {
  assert.equal(getBlenderAssetKey('win32', 'x64'), 'blender.exe');
  assert.equal(getBlenderAssetKey('linux', 'x64'), 'blender-linux-x64');
  assert.equal(getBlenderAssetKey('linux', 'arm64'), 'blender-linux-arm64');
  assert.equal(getBlenderAssetKey('darwin', 'arm64'), 'blender-macos-arm64');

  assert.equal(getBlenderExecutableRelPath('win32'), 'blender.exe');
  assert.equal(getBlenderExecutableRelPath('darwin'), 'blender-macos-arm64');
});

test('applies Keep-Last-5 BLENDER_HOLO_SHA512 pin and local CAS cache hit', () => {
  const latestSha = 'a'.repeat(128);
  const prevSha = 'b'.repeat(128);
  const entry: HoloV11Entry = {
    id: 'awesome-os/blender@v0.2.0/blender.exe',
    repo: 'blender',
    tag: 'v0.2.0',
    filename: 'blender.exe',
    target: 'win64',
    sha512: latestSha,
    size: 186_880,
    blobPath: `v11/files/aa/${latestSha}`,
    downloadUrl: `https://github.com/awesome-os/blender/releases/download/v0.2.0/blender.exe`,
    history: [
      {
        sha512: prevSha,
        size: 185_000,
        tag: 'v0.1.9',
        retiredAt: '2026-11-20T00:00:00Z',
      },
    ],
  };

  const pinned = applyKeepLast5Pin(entry, prevSha);
  assert.equal(pinned.sha512, prevSha);
  assert.equal(pinned.size, 185_000);
  assert.equal(pinned.tag, 'v0.1.9');
  assert.ok(pinned.downloadUrl.endsWith(`/${prevSha}`));

  const prevDir = process.env.B8G_CAS_DIR;
  const tmpCas = mkdtempSync(join(tmpdir(), 'blender-v11-cas-'));
  process.env.B8G_CAS_DIR = tmpCas;
  try {
    const payload = new TextEncoder().encode('blender-v11-cas-fixture');
    const digest = sha512Hex(payload);
    const first = hydrateLocalBlenderPayload(digest, payload);
    assert.equal(first.cacheHit, false);
    assert.ok(existsSync(first.blobFile));
    const second = hydrateLocalBlenderPayload(digest, payload);
    assert.equal(second.cacheHit, true);
  } finally {
    if (prevDir === undefined) delete process.env.B8G_CAS_DIR;
    else process.env.B8G_CAS_DIR = prevDir;
    rmSync(tmpCas, { recursive: true, force: true });
  }
});

test('parses CLI flags and executes --version / --dry-run cleanly', async () => {
  const parsed = parseCliArgs(['--dry-run', '--no-splash', 'scene.blend', '--', '--version']);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.showVersion, false);
  assert.deepEqual(parsed.forwardArgs, ['scene.blend', '--', '--version']);

  const versionOut = execFileSync(process.execPath, [CLI_PATH, '--version'], {
    encoding: 'utf8',
  }).trim();
  assert.match(versionOut, /^@awesome-os\/blender /);
  assert.ok(versionOut.includes(getBlenderAssetKey()));

  const dryRunOut = execFileSync(process.execPath, [CLI_PATH, '--dry-run', 'scene.blend'], {
    encoding: 'utf8',
  });
  const plan = JSON.parse(dryRunOut) as Awaited<ReturnType<typeof buildLaunchPlan>>;
  assert.equal(plan.casLayout, 'v11');
  assert.equal(plan.blender.assetKey, getBlenderAssetKey());
  assert.equal(plan.blender.status, 'resolved');
  assert.match(plan.blender.sha512 ?? '', SHA512_RE);
  assert.deepEqual(plan.forwardArgs, ['scene.blend']);
});
