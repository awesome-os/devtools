import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_ASSETS_DIR,
  generateAllSplashes,
  resolveC11Compiler,
  runC11Compiler,
  SPLASH_BMP_BYTES,
  SPLASH_BRANDS,
  SPLASH_HEIGHT,
  SPLASH_WIDTH,
} from './generate-splashes.mts';

const HERE = dirname(fileURLToPath(import.meta.url));

function assertValidBmp24(filePath: string): void {
  assert.equal(existsSync(filePath), true, `Expected BMP file at ${filePath}`);
  const buf = readFileSync(filePath);
  assert.equal(buf.byteLength, SPLASH_BMP_BYTES, `Expected exact ${SPLASH_BMP_BYTES} bytes for ${filePath}`);
  assert.equal(buf.subarray(0, 2).toString('ascii'), 'BM');
  assert.equal(buf.readUInt32LE(2), SPLASH_BMP_BYTES);
  assert.equal(buf.readUInt32LE(10), 54);
  assert.equal(buf.readUInt32LE(14), 40);
  assert.equal(buf.readUInt32LE(18), SPLASH_WIDTH);
  assert.equal(buf.readUInt32LE(22), SPLASH_HEIGHT);
  assert.equal(buf.readUInt16LE(26), 1);
  assert.equal(buf.readUInt16LE(28), 24);
}

test('all 7 deterministic 24-bit BMP splash assets exist and match BMP headers', () => {
  const tempOut = mkdtempSync(join(tmpdir(), 'b8g-splashes-verify-'));
  try {
    const generated = generateAllSplashes(tempOut);
    assert.equal(generated.length, 7);

    for (const brand of SPLASH_BRANDS) {
      const committedPath = join(DEFAULT_ASSETS_DIR, `${brand}.bmp`);
      const freshPath = join(tempOut, `${brand}.bmp`);
      assertValidBmp24(committedPath);
      assertValidBmp24(freshPath);
      assert.equal(
        Buffer.compare(readFileSync(committedPath), readFileSync(freshPath)),
        0,
        `Committed ${brand}.bmp must be byte-identical to deterministic C11 render`,
      );
    }
  } finally {
    rmSync(tempOut, { recursive: true, force: true });
  }
});

test('C11 dynamic loader compiles companion shared library (.dll/.so) and verifies B8G_ABI_MAGIC_V3 handshake', () => {
  const comp = resolveC11Compiler();
  const workDir = mkdtempSync(join(tmpdir(), 'b8g-dynloader-test-'));
  const libExt = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
  const pluginPath = join(workDir, `sample_engine_plugin${libExt}`);
  const exePath = join(workDir, process.platform === 'win32' ? 'launcher_selftest.exe' : 'launcher_selftest');

  try {
    const pluginFlags = [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-shared',
      ...(process.platform === 'win32' ? [] : ['-fPIC']),
      `-I${HERE}`,
      join(HERE, 'sample_engine_plugin.c'),
      '-o',
      pluginPath,
    ];
    runC11Compiler(comp, pluginFlags);
    assert.equal(existsSync(pluginPath), true);

    const exeFlags = [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      `-I${HERE}`,
      join(HERE, 'launcher_selftest.c'),
      join(HERE, 'dynamic_loader.c'),
      join(HERE, 'splash_blitter.c'),
      '-o',
      exePath,
      ...(process.platform === 'linux' ? ['-ldl'] : []),
    ];
    runC11Compiler(comp, exeFlags);
    assert.equal(existsSync(exePath), true);

    for (const brand of ['godot', 'blender', 'asymmetric-hunt', 'code-oss', 'theia'] as const) {
      const outBmp = join(workDir, `${brand}-live.bmp`);
      const stdout = execFileSync(exePath, [pluginPath, outBmp, brand], { encoding: 'utf8' });
      assert.match(stdout, /PASS: B8G dynamic launcher v3 verified \(magic=0x33564742/);
      assert.ok(stdout.includes(`engine=b8g-dynamic-${brand}`));
      assert.ok(stdout.includes('palettes=7'));
      assertValidBmp24(outBmp);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
