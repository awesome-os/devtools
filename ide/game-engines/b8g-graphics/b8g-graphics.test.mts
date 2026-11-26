import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  B8gWebGPURenderer,
  BoxGeometry,
  CompactNeuralBrdfMlp,
  GaussianSplatMesh,
  Mesh,
  MultiLayerReservoirBuffer,
  NEURAL_MLP_MAX_BYTES,
  NeuralMaterial,
  OrcaStatelessRadianceCache,
  PBRMaterial,
  PerspectiveCamera,
  Scene,
  TileBased3dgsRenderer,
  VISBUF_CLEAR_VALUE,
  VisibilityBufferArena,
  buildHzbPyramid,
  computeAnalyticalBarycentrics,
  computeNeighborCompatibility,
  createDefaultNeuralMaterial,
  cullMeshletsTwoPassHzb,
  evaluateBindlessVisibilityPass,
  packVisibilityId,
  rasterizeMicropolygons64,
  unpackVisibilityId,
} from './index.mts';

const GRAPHICS_DIR = import.meta.dirname;
const ROOT_DIR = path.resolve(GRAPHICS_DIR, '..', '..');

function resolveZigOrCc(): { bin: string; prefix: string[] } {
  const candidates = [
    process.env.ZIG_BIN,
    path.join(ROOT_DIR, 'bin', process.platform === 'win32' ? 'zig.cmd' : 'zig'),
    process.platform === 'win32' ? 'e:\\awesome-os\\bin\\zig.cmd' : undefined,
    'zig',
  ].filter((x): x is string => Boolean(x));

  for (const cand of candidates) {
    if (cand.includes('\\') || cand.includes('/')) {
      if (fs.existsSync(cand)) return { bin: cand, prefix: ['cc'] };
      continue;
    }
    const probe = spawnSync(cand, ['version'], { stdio: 'pipe', shell: process.platform === 'win32' });
    if (probe.status === 0) return { bin: cand, prefix: ['cc'] };
  }
  for (const cc of ['cc', 'gcc', 'clang']) {
    const probe = spawnSync(cc, ['--version'], { stdio: 'pipe' });
    if (probe.status === 0) return { bin: cc, prefix: [] };
  }
  throw new Error('No C11 compiler (zig cc / cc / gcc / clang) available');
}

test('1. 64-bit Visibility Buffer atomicMin + analytical ddx/ddy + Two-Pass HZB culling', () => {
  const keyNear = packVisibilityId(0x10000000, 2, 17);
  const keyFar = packVisibilityId(0x90000000, 5, 3);
  assert.ok(keyNear < keyFar);
  const up = unpackVisibilityId(keyNear);
  assert.deepEqual(up, { depthU32: 0x10000000, instanceId: 2, triangleId: 17, valid: true });
  assert.equal(unpackVisibilityId(VISBUF_CLEAR_VALUE).valid, false);

  const arena = new VisibilityBufferArena(32, 32, 64, 32);
  // Two overlapping front/back NDC triangles directly projected under identity MVP
  arena.setVertex(0, -0.8, -0.8, 0.2, 1, 0, 0, 0, 0);
  arena.setVertex(1, 0.8, -0.8, 0.2, 1, 1, 0, 0, 0);
  arena.setVertex(2, 0.0, 0.8, 0.2, 1, 0.5, 1, 0, 0);
  arena.setTriangle(0, 0, 1, 2);

  arena.setVertex(3, -0.9, -0.9, 0.8, 1, 0, 0, 0, 0);
  arena.setVertex(4, 0.9, -0.9, 0.8, 1, 1, 0, 0, 0);
  arena.setVertex(5, 0.0, 0.9, 0.8, 1, 0.5, 1, 0, 0);
  arena.setTriangle(1, 3, 4, 5);

  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const rStats = rasterizeMicropolygons64(
    arena,
    [
      { instanceId: 1, indexOffset: 3, triangleCount: 1, triangleOffset: 1, boundsCenter: [0, 0, 0.8], boundsRadius: 0.9 },
      { instanceId: 0, indexOffset: 0, triangleCount: 1, triangleOffset: 0, boundsCenter: [0, 0, 0.2], boundsRadius: 0.8 },
    ],
    identity,
  );
  assert.equal(rStats.trianglesSubmitted, 2);
  assert.ok(rStats.atomicWrites > 50);

  const bary = computeAnalyticalBarycentrics(arena.vertices, 0, 1, 2, identity, 32, 32, 16.5, 16.5);
  assert.ok(Math.abs(bary.duDx) > 0);
  assert.ok(Math.abs(bary.dvDy) > 0);

  const outRgba = new Uint8ClampedArray(32 * 32 * 4);
  const evalStats = evaluateBindlessVisibilityPass(
    arena,
    [{ baseColor: [0.2, 0.8, 1.0] }, { baseColor: [1.0, 0.2, 0.2] }],
    outRgba,
    identity,
  );
  assert.ok(evalStats.shadedPixels > 40);

  const prevHzb = buildHzbPyramid(new Float32Array(32 * 32).fill(0.1), 32, 32);
  const hzbRes = cullMeshletsTwoPassHzb(
    [
      { instanceId: 0, indexOffset: 0, triangleCount: 1, boundsCenter: [0, 0, 0.05], boundsRadius: 0.2 },
      { instanceId: 1, indexOffset: 3, triangleCount: 1, boundsCenter: [0, 0, 0.9], boundsRadius: 0.2 },
    ],
    prevHzb,
    identity,
  );
  assert.equal(hzbRes.pass1Visible.length, 1);
  assert.equal(hzbRes.culledMeshlets.length, 1);
  assert.ok(hzbRes.overdrawEliminatedPct > 40);
});

test('2. ORCA stateless frame reset + Multi-Layer ReSTIR disocclusion + HPG 2026 neighbor compatibility', () => {
  const orca = new OrcaStatelessRadianceCache(256, 0.5);
  assert.equal(orca.insertRadianceSample([1.2, 0.4, 2.1], [0, 1, 0], [0.9, 0.6, 0.2]), true);
  const hit = orca.queryRadiance([1.2, 0.4, 2.1], [0, 1, 0]);
  assert.equal(hit.found, true);
  assert.equal(hit.count, 1);

  // Zero temporal history on next frame: no ghosting left behind
  orca.resetFrame();
  assert.equal(orca.queryRadiance([1.2, 0.4, 2.1], [0, 1, 0]).found, false);

  // HPG 2026 thin-wall compatibility rejection
  const sameSurface = computeNeighborCompatibility([0, 0, 0], [0, 0, 1], [0.2, 0.1, 0.01], [0, 0, 1]);
  assert.equal(sameSurface.compatible, true);
  const oppositeSide = computeNeighborCompatibility([0, 0, 0], [0, 0, 1], [0.05, 0, -0.05], [0, 0, -1]);
  assert.equal(oppositeSide.compatible, false);

  // Multi-Layer ReSTIR background promotion on foreground disocclusion
  const reservoirs = new MultiLayerReservoirBuffer(4, 4, 2);
  reservoirs.splatMultiLayer(1, 1, 0, [0, 0, 1], [0.1, 0.1, 0.1], 1, 1, 0.2, [0, 1, 0], 0.01);
  reservoirs.splatMultiLayer(1, 1, 1, [0, 0, 0], [0.8, 0.7, 0.2], 2, 1, 0.7, [0, 0, 1], 0.01);
  const promoted = reservoirs.resolveDisoccludedPixel(1, 1, [0, 0, 0], [0, 0, 1], { expectedDepth: 0.7 });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.sourceLayer, 1);
  assert.ok(reservoirs.getReservoir(1, 1, 0).radianceR > 0.7);
});

test('3. Compact Neural BRDF MLP (<= 8 KB L1) + Three.js-compatible Scene & 3DGS Hybrid BMP Render', () => {
  const mlp = createDefaultNeuralMaterial(2026);
  assert.ok(mlp instanceof CompactNeuralBrdfMlp);
  assert.ok(mlp.byteLength <= NEURAL_MLP_MAX_BYTES, `MLP ${mlp.byteLength}B exceeded 8KB`);

  const scene = new Scene();
  const camera = new PerspectiveCamera(55, 64 / 48, 0.1, 50);
  camera.position.set(0, 0.9, 3.2);
  camera.lookAt(0, 0, 0);

  const neuralCube = new Mesh(new BoxGeometry(1.1, 1.1, 1.1), new NeuralMaterial(2026, mlp));
  neuralCube.position.set(-0.4, 0, 0);
  scene.add(neuralCube);

  const metalBox = new Mesh(
    new BoxGeometry(0.9, 0.9, 0.9),
    new PBRMaterial({ color: [0.95, 0.55, 0.25], roughness: 0.2, metallic: 0.9 }),
  );
  metalBox.position.set(0.6, -0.1, -0.6);
  scene.add(metalBox);

  const gs = new TileBased3dgsRenderer(2);
  // 1 foreground splat in front of boxes, 1 occluded splat deep behind meshes
  gs.setGaussian(0, 0.1, 0.1, 1.4, 0.28, 0.28, 0.28, 0, 0, 0, 1, 0.2, 0.95, 0.85, 0.75);
  gs.setGaussian(1, -0.4, 0.0, -4.0, 0.35, 0.35, 0.35, 0, 0, 0, 1, 1.0, 0.1, 0.1, 0.9);
  scene.add(new GaussianSplatMesh(gs));

  const renderer = new B8gWebGPURenderer(64, 48);
  const { bmpBytes, width, height, stats } = renderer.renderToBmp(scene, camera);

  assert.equal(width, 64);
  assert.equal(height, 48);
  assert.equal(bmpBytes[0], 0x42);
  assert.equal(bmpBytes[1], 0x4d);
  assert.equal(bmpBytes.length, 54 + 64 * 48 * 3);
  assert.ok(stats.rasterStats.atomicWrites > 100);
  assert.ok(stats.bindlessStats.shadedPixels > 100);
  assert.ok(stats.orcaSeededCells >= 2);
  assert.ok(stats.gsStats.splatEvaluations > 0);
  assert.ok(stats.gsStats.earlyDepthTerminations > 0, 'Expected behind-mesh 3DGS splat to early-terminate against visDepth');

  const sha512 = crypto.createHash('sha512').update(bmpBytes).digest('hex');
  assert.equal(sha512.length, 128);
});

test('4. Native C11 -O3 graphics core compiles with zero warnings & verifies shader WGSL files exist', () => {
  for (const wgsl of ['visbuf-curast.wgsl', 'orca-restir.wgsl', 'neural-brdf-3dgs.wgsl']) {
    const src = fs.readFileSync(path.join(GRAPHICS_DIR, 'shaders', wgsl), 'utf8');
    assert.match(src, /@compute/);
  }

  const { bin, prefix } = resolveZigOrCc();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-gfx-bench-'));
  try {
    const exeName = process.platform === 'win32' ? 'gfx_bench.exe' : 'gfx_bench';
    const exePath = path.join(tmpDir, exeName);
    const harnessC = path.join(tmpDir, 'harness.c');
    fs.writeFileSync(
      harnessC,
      [
        '#include <stdio.h>',
        '#include "b8g_graphics_abi.h"',
        '#define CHECK(c) do { if (!(c)) { fprintf(stderr, "CHECK FAILED line %d\\n", __LINE__); return 1; } } while (0)',
        'int main(void) {',
        '  B8gGraphicsDispatchTable tbl;',
        '  b8g_graphics_init_dispatch_table(&tbl, B8G_GRAPHICS_CAP_VISBUF | B8G_GRAPHICS_CAP_ORCA_GI | B8G_GRAPHICS_CAP_RESTIR | B8G_GRAPHICS_CAP_NEURAL_BRDF | B8G_GRAPHICS_CAP_3DGS_HYBRID);',
        '  CHECK(tbl.magic == B8G_GRAPHICS_ABI_MAGIC);',
        '  uint64_t pk = tbl.pack64(0x12345678u, 3u, 99u);',
        '  CHECK((pk >> 32) == 0x12345678u);',
        '  float pbr[5] = {0};',
        '  float vn[3] = {0.0f, 0.0f, 1.0f};',
        '  tbl.neural_brdf_eval(NULL, 0.5f, 0.5f, vn, pbr);',
        '  CHECK(pbr[0] > 0.0f && pbr[3] > 0.0f);',
        '  float c_pos[3] = {0,0,0}, c_n[3] = {0,0,1};',
        '  float n_pos[3] = {0.1f,0,0.01f}, n_n[3] = {0,0,1};',
        '  float w_pos[3] = {0.1f,0,-0.02f}, w_n[3] = {0,0,-1};',
        '  CHECK(tbl.restir_neighbor_compatible(c_pos, c_n, n_pos, n_n, 0.1f, 0.85f) == 1);',
        '  CHECK(tbl.restir_neighbor_compatible(c_pos, c_n, w_pos, w_n, 0.1f, 0.85f) == 0);',
        '  printf("PASS_B8G_GRAPHICS_C11_O3\\n");',
        '  return 0;',
        '}',
      ].join('\n'),
      'utf8',
    );

    const compileArgs = [
      ...prefix,
      '-std=c11',
      '-O3',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-I',
      GRAPHICS_DIR,
      harnessC,
      path.join(GRAPHICS_DIR, 'b8g_graphics_core.c'),
      '-lm',
      '-o',
      exePath,
    ];
    execFileSync(bin, compileArgs, { encoding: 'utf8', shell: process.platform === 'win32' });
    const out = execFileSync(exePath, { encoding: 'utf8' });
    assert.match(out, /PASS_B8G_GRAPHICS_C11_O3/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
