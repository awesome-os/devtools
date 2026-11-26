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
  fetchGodotManifest,
  getGodotAssetKey,
  getGodotExecutableRelPath,
  hydrateLocalGodotPayload,
  parseCliArgs,
  tryResolveGodotEntry,
  type HoloV11Entry,
} from '../src/index.mts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = resolve(REPO_ROOT, 'src', 'cli.mts');
const SHA512_RE = /^[a-f0-9]{128}$/;

test('fetches live Holo v11 manifest and resolves godot binary entry', async () => {
  const manifest = await fetchGodotManifest(true);
  assert.equal(manifest.schema, 'awesome-os-cas-v11-manifest-v1');
  assert.ok(manifest.entries.length > 0);

  const godotKey = getGodotAssetKey();
  const godotEntry = await tryResolveGodotEntry(godotKey, manifest);
  assert.ok(godotEntry, `Expected live Godot entry for ${godotKey}`);
  assert.equal(godotEntry.repo, 'godot');
  assert.match(godotEntry.sha512, SHA512_RE);
  assert.ok(godotEntry.size > 10_000);
});

test('maps platform asset keys and executable paths accurately', () => {
  assert.equal(getGodotAssetKey('win32', 'x64'), 'godot.exe');
  assert.equal(getGodotAssetKey('linux', 'x64'), 'godot-linux-x64');
  assert.equal(getGodotAssetKey('linux', 'arm64'), 'godot-linux-arm64');
  assert.equal(getGodotAssetKey('darwin', 'arm64'), 'godot-macos-arm64');

  assert.equal(getGodotExecutableRelPath('win32'), 'godot.exe');
  assert.equal(getGodotExecutableRelPath('darwin'), 'godot-macos-arm64');
});

test('applies Keep-Last-5 GODOT_HOLO_SHA512 pin and local CAS cache hit', () => {
  const latestSha = 'a'.repeat(128);
  const prevSha = 'b'.repeat(128);
  const entry: HoloV11Entry = {
    id: 'awesome-os/godot@v0.2.0/godot.exe',
    repo: 'godot',
    tag: 'v0.2.0',
    filename: 'godot.exe',
    target: 'win64',
    sha512: latestSha,
    size: 186_880,
    blobPath: `v11/files/aa/${latestSha}`,
    downloadUrl: `https://github.com/awesome-os/godot/releases/download/v0.2.0/godot.exe`,
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

  const unpinned = applyKeepLast5Pin(entry, 'c'.repeat(128));
  assert.equal(unpinned.sha512, latestSha);

  const prevDir = process.env.B8G_CAS_DIR;
  const tmpCas = mkdtempSync(join(tmpdir(), 'godot-v11-cas-'));
  process.env.B8G_CAS_DIR = tmpCas;
  try {
    const payload = new TextEncoder().encode('godot-v11-cas-fixture');
    const digest = sha512Hex(payload);
    const first = hydrateLocalGodotPayload(digest, payload);
    assert.equal(first.cacheHit, false);
    assert.ok(existsSync(first.blobFile));
    const second = hydrateLocalGodotPayload(digest, payload);
    assert.equal(second.cacheHit, true);
  } finally {
    if (prevDir === undefined) delete process.env.B8G_CAS_DIR;
    else process.env.B8G_CAS_DIR = prevDir;
    rmSync(tmpCas, { recursive: true, force: true });
  }
});

test('parses CLI flags and executes --version / --dry-run cleanly', async () => {
  const parsed = parseCliArgs(['--dry-run', '--no-splash', '--editor', '--', '--version']);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.showVersion, false);
  assert.deepEqual(parsed.forwardArgs, ['--editor', '--', '--version']);

  const versionOut = execFileSync(process.execPath, [CLI_PATH, '--version'], {
    encoding: 'utf8',
  }).trim();
  assert.match(versionOut, /^@awesome-os\/godot /);
  assert.ok(versionOut.includes(getGodotAssetKey()));

  const dryRunOut = execFileSync(process.execPath, [CLI_PATH, '--dry-run', '--editor'], {
    encoding: 'utf8',
  });
  const plan = JSON.parse(dryRunOut) as Awaited<ReturnType<typeof buildLaunchPlan>>;
  assert.equal(plan.casLayout, 'v11');
  assert.equal(plan.godot.assetKey, getGodotAssetKey());
  assert.equal(plan.godot.status, 'resolved');
  assert.match(plan.godot.sha512 ?? '', SHA512_RE);
  assert.equal(plan.godot.workingDir, dirname(plan.godot.executablePath!));
  assert.deepEqual(plan.forwardArgs, ['--editor']);
});
