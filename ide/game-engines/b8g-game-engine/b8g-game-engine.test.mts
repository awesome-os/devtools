/**
 * @file sections/b8g-game-engine/b8g-game-engine.test.mts
 * @description Comprehensive Verification Suite & Real-Silicon Benchmark for the
 * B8G Holonomic Game Engine SDK:
 *   1. Predictive camera-velocity vector streaming + 3-tier zoning + B8G_ARENA_V1 O(1) sector purge
 *   2. Section/Intersection `.b8p` CAS asset deduplication + Mathematical Total Asset Closure Gate
 *   3. S^3 UnitQuaternion rigid-body integrator (‖q‖ = 1 ± 1e-12), terrain slope/buoyancy, & zero-slide foot IK
 *   4. Real-silicon benchmark: 64 world sectors / 10,000 entities streaming tick + O(1) purge latency
 *   5. Native C11 `b8g_game_engine_abi.h` compilation & execution via `zig cc -std=c11 -O2 -Wall -Wextra -Werror`
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import {
  B8G_ARENA_V1_MAGIC,
  SimTier,
  WorldStreamingEngine,
  AssetManifestSection,
  B8gGameEngineSection,
  B8gGameEngineIntersection,
  AssetClosureError,
  B8pAssetPipeline,
  verifyAssetClosure,
  fnv64Bytes,
  UnitQuaternion,
  ProceduralTerrain,
  RigidBody,
  RigidBodyWorld,
  FootPlacementSolver,
} from './index.mts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = path.resolve(HERE, '../..')

test('1. Predictive velocity-vector streaming + 3-tier zoning + B8G_ARENA_V1 O(1) sector purge', () => {
  const engine = new WorldStreamingEngine({
    sectorSize: 64,
    tier1Radius: 1,
    tier2Radius: 2,
    tier3Radius: 3,
    prefetchHorizonSeconds: 2.0,
    prefetchCorridorRadius: 1,
    maxEntitiesPerSector: 64,
    slabPoolCapacity: 128,
  })

  // Stationary camera at origin: pure concentric 7x7 = 49 sectors
  // Tier1 = 3x3 = 9, Tier2 = 5x5 - 9 = 16, Tier3 = 7x7 - 25 = 24
  const r0 = engine.updateStreamingBubble({ x: 32, y: 0, z: 32 }, { x: 0, y: 0, z: 0 }, 1 / 60)
  assert.equal(r0.loadedSectors, 49)
  assert.equal(r0.tier1Count, 9)
  assert.equal(r0.tier2Count, 16)
  assert.equal(r0.tier3Count, 24)
  assert.equal(r0.prefetchedSectors, 0)

  // Spawn an entity in sector (-3, 0, 0) and inspect its B8G_ARENA_V1 slab header
  const originSector = engine.getSector(-3, 0, 0)
  assert.ok(originSector)
  assert.equal(originSector.slab.view.getUint32(0, true), B8G_ARENA_V1_MAGIC)
  const eid = engine.spawnEntity(-3 * 64 + 10, 5, 10, 1, 0, 0)
  assert.ok(eid > 0)
  assert.equal(originSector.entityCount, 1)
  const oldSlabRef = originSector.slab

  // High-speed camera moving +X at 160 m/s -> 2.0s lookahead = +320m = +5 sectors ahead!
  const r1 = engine.updateStreamingBubble({ x: 32, y: 0, z: 32 }, { x: 160, y: 0, z: 0 }, 1 / 60)
  assert.equal(r1.predictedSector.sx, 5)
  assert.ok(r1.prefetchedSectors > 0, 'velocity vector must prefetch sectors ahead of camera')
  const aheadSector = engine.getSector(5, 0, 0)
  assert.ok(aheadSector, 'sector (5,0,0) along velocity vector must be prefetched')
  assert.equal(aheadSector.tier, SimTier.Tier2_Simplified)
  assert.equal(aheadSector.prefetched, true)

  // Move camera far away (+X = 1024m, sector 16) so old sector (-3, 0, 0) leaves bubble & is purged in O(1)
  const r2 = engine.updateStreamingBubble({ x: 1024, y: 0, z: 32 }, { x: 0, y: 0, z: 0 }, 1 / 60)
  assert.ok(r2.purgedSectors > 0, 'departed sectors must be purged')
  assert.equal(engine.getSector(-3, 0, 0), undefined)
  assert.ok(r2.totalPurgedBytes > 0)

  // Verify slab pool zeroed and recycled slabs (O(1) memory reuse, zero unbounded slab leak)
  assert.ok(engine.slabPool.purgedSlabCount >= r2.purgedSectors)
  // If oldSlabRef was not yet re-acquired, its bytes are zeroed; if re-acquired, its generation incremented
  assert.ok(oldSlabRef.generation >= 2, 'purged slab generation must advance on O(1) wipe/recycle')
  assert.ok(
    engine.slabPool.allocatedCount < 110,
    `slab pool should recycle slabs rather than leak (allocated=${engine.slabPool.allocatedCount})`
  )
})

test('2. Section/Intersection .b8p CAS asset dedup + Mathematical Total Asset Closure Gate', () => {
  assert.equal(AssetManifestSection.id, 'b8g-asset-manifest')
  assert.equal(B8gGameEngineSection.id, 'b8g-game-engine')
  assert.equal(B8gGameEngineIntersection.id, 'b8g-game-engine-runtime')

  const pipeline = new B8pAssetPipeline('archipelago-v1')
  const meshPayload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
  const texPayload = new Uint8Array(64).fill(0xab)
  const asogPayload = new Uint8Array(128).map((_, i) => (i * 17) & 0xff)
  const audioPayload = new Uint8Array(96).map((_, i) => (i * 31) & 0xff)
  const shaderPayload = new Uint8Array(48).map((_, i) => (i + 65) & 0xff)

  const eMeshA = pipeline.registerAsset('islands/palm_a.mesh', 'mesh', meshPayload)
  const eMeshB = pipeline.registerAsset('islands/palm_b_lod0.mesh', 'mesh', meshPayload) // identical bytes -> CAS dedup!
  const eTex = pipeline.registerAsset('textures/ocean_foam.tex', 'texture', texPayload)
  const eAsog = pipeline.registerAsset('splats/sunset_harbor.asog4dgs', 'asog4dgs', asogPayload)
  const eAudio = pipeline.registerAsset('audio/surf_loop.ogg', 'audio', audioPayload)
  const eShader = pipeline.registerAsset('shaders/water_pbr.wgsl', 'shader', shaderPayload)

  // Verify FNV-64 deduplication
  assert.equal(eMeshA.hash64, eMeshB.hash64)
  assert.equal(eMeshA.hash64, fnv64Bytes(meshPayload))
  const stats = pipeline.getStats()
  assert.equal(stats.assetCount, 6)
  assert.equal(stats.uniqueBlockCount, 5)
  assert.equal(stats.dedupSavedBytes, meshPayload.byteLength)

  // Verify binary .b8p pack encode/decode round-trip
  const packed = pipeline.encodeB8pPack()
  const unpacked = B8pAssetPipeline.decodeB8pPack(packed)
  assert.equal(unpacked.size, 5)
  assert.deepEqual(unpacked.get(eAsog.hash64)?.bytes, asogPayload)

  // Closure Gate PASS: R ⊆ M (|R \ M| = 0)
  const proof = verifyAssetClosure(
    [
      { assetId: 'islands/palm_a.mesh', kind: 'mesh', expectedHash64: eMeshA.hash64 },
      { assetId: 'islands/palm_b_lod0.mesh', kind: 'mesh', expectedHash64: eMeshB.hash64 },
      { assetId: 'textures/ocean_foam.tex', kind: 'texture', expectedHash64: eTex.hash64 },
      { assetId: 'splats/sunset_harbor.asog4dgs', kind: 'asog4dgs', expectedHash64: eAsog.hash64 },
      { assetId: 'audio/surf_loop.ogg', kind: 'audio', expectedHash64: eAudio.hash64 },
      { assetId: 'shaders/water_pbr.wgsl', kind: 'shader', expectedHash64: eShader.hash64 },
    ],
    pipeline
  )
  assert.equal(proof.closed, true)
  assert.equal(proof.missingCount, 0)
  assert.equal(proof.requiredCount, 6)

  // Closure Gate FAIL-FAST: missing asset throws AssetClosureError
  assert.throws(
    () =>
      verifyAssetClosure(
        ['islands/palm_a.mesh', 'meshes/missing_lighthouse.mesh'],
        pipeline
      ),
    (err: unknown) => {
      assert.ok(err instanceof AssetClosureError)
      assert.equal(err.missingAssets.length, 1)
      assert.equal(err.missingAssets[0]?.assetId, 'meshes/missing_lighthouse.mesh')
      assert.equal(err.missingAssets[0]?.reason, 'missing-in-manifest')
      return true
    }
  )

  // Closure Gate FAIL-FAST: tampered hash throws AssetClosureError
  assert.throws(
    () =>
      verifyAssetClosure(
        [{ assetId: 'shaders/water_pbr.wgsl', kind: 'shader', expectedHash64: '0000000000000000' }],
        pipeline
      ),
    (err: unknown) => {
      assert.ok(err instanceof AssetClosureError)
      assert.equal(err.missingAssets[0]?.reason, 'hash-mismatch')
      return true
    }
  )
})

test('3. S^3 UnitQuaternion rigid-body integrator (||q|| = 1 +/- 1e-12), terrain/buoyancy, & zero-slide foot IK', () => {
  // 3a. 10,000 fixed-timestep S^3 quaternion integrations
  const q = UnitQuaternion.fromAxisAngle(0.3, 0.7, -0.6, 0.85)
  let maxErr = q.normError()
  for (let i = 0; i < 10_000; i++) {
    q.integrateAngularVelocityInPlace(2.7, -1.9, 3.3, 1 / 120)
    const e = q.normError()
    if (e > maxErr) maxErr = e
  }
  assert.ok(maxErr <= 1e-12, `S^3 unit norm drift exceeded 1e-12: ${maxErr}`)

  // 3b. Rigid-body world with procedural terrain + water buoyancy
  const terrain = new ProceduralTerrain(42, 0.0, 8.0, 0.04)
  const world = new RigidBodyWorld(1 / 60, 9.81, 1000.0)

  // Body dropped onto high dry ground
  const dryX = 10
  const dryZ = 0
  const groundH = terrain.sampleHeight(dryX, dryZ)
  const landBody = new RigidBody(dryX, groundH + 5.0, dryZ, { mass: 2.0, radius: 0.5 })
  landBody.wx = 4.0
  landBody.wy = -2.5
  landBody.wz = 1.8
  world.addBody(landBody)

  // Buoyant body dropped into deep water (find a submerged coordinate)
  let waterX = 0
  let waterZ = 0
  for (let x = -100; x <= 100; x += 4) {
    if (terrain.sampleHeight(x, 0) < -4.0) {
      waterX = x
      break
    }
  }
  const buoyBody = new RigidBody(waterX, 1.0, waterZ, {
    mass: 1.0,
    radius: 0.5,
    buoyancyVolume: 0.0025, // floats cleanly near waterLevel = 0
  })
  world.addBody(buoyBody)

  for (let frame = 0; frame < 300; frame++) {
    world.step(1 / 60, terrain)
  }

  assert.ok(world.maxQuatNormError <= 1e-12, `RigidBodyWorld maxQuatNormError=${world.maxQuatNormError}`)
  assert.ok(landBody.py >= terrain.sampleHeight(landBody.px, landBody.pz) + landBody.radius - 1e-6)
  assert.equal(buoyBody.inWater, true, 'buoyant body must float in water')
  assert.ok(buoyBody.py > terrain.sampleHeight(buoyBody.px, buoyBody.pz) + 1.0, 'buoyant body must stay afloat above seabed')

  // 3c. Zero-GC foot-placement & weight-transfer solver (0 foot-sliding in stance)
  const footSolver = new FootPlacementSolver(0, 0, terrain)
  let px = 0
  const pz = 0
  const walkSpeed = 2.4
  for (let frame = 0; frame < 180; frame++) {
    const dt = 1 / 60
    px += walkSpeed * dt
    footSolver.update(px, pz, walkSpeed, 0, 0, terrain, dt)
    assert.ok(
      Math.abs(footSolver.leftWeight + footSolver.rightWeight - 1.0) < 1e-12,
      'weight transfer must sum to 1.0'
    )
  }
  assert.equal(footSolver.maxStanceSlide, 0, 'stance foot must have strictly zero foot-sliding')
  // Feet must have walked forward with the pelvis
  assert.ok(footSolver.state[0]! > 5.0 && footSolver.state[3]! > 5.0, 'feet must advance with pelvis locomotion')
})

test('4. Real-silicon benchmark: 64 world sectors / 10,000 entities streaming tick + O(1) purge timing', () => {
  // 8x8 = 64 sectors with 157 entities/sector (~10,048 entities -> cap at exactly 10,000)
  const engine = new WorldStreamingEngine({
    sectorSize: 64,
    tier1Radius: 1,
    tier2Radius: 2,
    tier3Radius: 4, // covers 9x9 >= 64 sectors
    prefetchHorizonSeconds: 1.5,
    prefetchCorridorRadius: 1,
    maxEntitiesPerSector: 256,
    slabPoolCapacity: 128,
  })

  // Pre-populate 64 sectors (8x8 grid: sx in [0..7], sz in [0..7]) with 10,000 entities
  let spawned = 0
  const targetEntities = 10_000
  for (let sx = 0; sx < 8; sx++) {
    for (let sz = 0; sz < 8; sz++) {
      engine.ensureSector(sx, 0, sz, SimTier.Tier1_FullPhysics, false)
      const perSector = Math.min(157, targetEntities - spawned)
      for (let i = 0; i < perSector; i++) {
        const x = sx * 64 + ((i * 7) % 60) + 2
        const z = sz * 64 + ((i * 13) % 60) + 2
        const id = engine.spawnEntity(x, 0, z, 1.5, 0, -0.8)
        assert.ok(id > 0)
        spawned += 1
      }
    }
  }
  assert.equal(spawned, 10_000)
  assert.equal(engine.activeSectorCount, 64)

  // Benchmark 100 streaming ticks over 64+ sectors / 10,000 entities
  const tickCount = 100
  const tStart = performance.now()
  let lastReport = engine.updateStreamingBubble({ x: 256, y: 0, z: 256 }, { x: 12, y: 0, z: 4 }, 1 / 60)
  for (let t = 1; t < tickCount; t++) {
    lastReport = engine.updateStreamingBubble(
      { x: 256 + t * 0.2, y: 0, z: 256 + t * 0.05 },
      { x: 12, y: 0, z: 4 },
      1 / 60
    )
  }
  const tickTotalMs = performance.now() - tStart
  const avgTickMs = tickTotalMs / tickCount
  assert.ok(lastReport.activeEntities >= 10_000, `expected >= 10,000 active entities, got ${lastReport.activeEntities}`)

  // Benchmark O(1) purge of all 64 populated sectors by teleporting far outside the bubble
  const pStart = performance.now()
  const purgeReport = engine.updateStreamingBubble({ x: 50_000, y: 0, z: 50_000 }, { x: 0, y: 0, z: 0 }, 1 / 60)
  const purgeTotalMs = performance.now() - pStart
  const perSectorPurgeUs = (purgeTotalMs * 1000) / Math.max(1, purgeReport.purgedSectors)

  assert.ok(purgeReport.purgedSectors >= 64, `expected >= 64 purged sectors, got ${purgeReport.purgedSectors}`)
  assert.ok(avgTickMs < 16.67, `streaming tick must beat 60 FPS frame budget (got ${avgTickMs.toFixed(3)} ms)`)

  console.log(
    `[B8G-GAME-ENGINE BENCH] 64+ sectors / 10,000 entities: avg_tick=${avgTickMs.toFixed(3)} ms (${(1000 / Math.max(avgTickMs, 1e-6)).toFixed(0)} Hz), ` +
      `O(1)_purge=${purgeReport.purgedSectors} sectors (${(purgeReport.totalPurgedBytes / 1024).toFixed(1)} KB) in ${purgeTotalMs.toFixed(3)} ms (${perSectorPurgeUs.toFixed(2)} us/sector)`
  )
})

test('5. Native C11 b8g_game_engine_abi.h compiles & passes with zig cc -std=c11 -O2 -Wall -Wextra -Werror (0 warnings)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-game-abi-'))
  const testCPath = path.join(tmpDir, 'b8g_game_engine_abi_test.c')
  const outExe = path.join(
    tmpDir,
    process.platform === 'win32' ? 'b8g_game_engine_abi_test.exe' : 'b8g_game_engine_abi_test'
  )

  const headerIncludePath = path.join(HERE, 'b8g_game_engine_abi.h').replace(/\\/g, '/')
  const cSource = [
    '#include <stddef.h>',
    '#include <stdint.h>',
    '#include <stdio.h>',
    '#include <string.h>',
    `#include "${headerIncludePath}"`,
    '',
    'static uint32_t g_active_sectors = 64u;',
    'static uint64_t g_active_slabs = 0u;',
    '',
    'static uint32_t mock_update_bubble(const B8gVec3f64* pos, const B8gVec3f64* vel, double dt, uint32_t* out_loaded, uint32_t* out_purged) {',
    '  (void)pos; (void)vel; (void)dt;',
    '  if (out_loaded) *out_loaded = g_active_sectors;',
    '  if (out_purged) *out_purged = 0u;',
    '  return 1u;',
    '}',
    'static uint32_t mock_purge_o1(int32_t sx, int32_t sy, int32_t sz) {',
    '  (void)sx; (void)sy; (void)sz;',
    '  if (g_active_sectors > 0u) g_active_sectors -= 1u;',
    '  return 16448u;',
    '}',
    'static uint32_t mock_active_sectors(void) { return g_active_sectors; }',
    'static const B8gWorldStreamingDispatchTable g_streaming = { mock_update_bubble, mock_purge_o1, mock_active_sectors };',
    '',
    'static uint64_t mock_fnv64(const uint8_t* data, size_t len) {',
    '  uint64_t h = 0xcbf29ce484222325ULL;',
    '  for (size_t i = 0; i < len; ++i) { h ^= (uint64_t)data[i]; h *= 0x100000001b3ULL; }',
    '  return h;',
    '}',
    'static int32_t mock_verify_closure(const uint64_t* req, size_t count, size_t* out_missing) {',
    '  (void)req; (void)count;',
    '  if (out_missing) *out_missing = 0u;',
    '  return 0;',
    '}',
    'static uint32_t mock_unique_blocks(void) { return 5u; }',
    'static const B8gAssetClosureDispatchTable g_assets = { mock_fnv64, mock_verify_closure, mock_unique_blocks };',
    '',
    'static uint32_t mock_step_s3(double frame_dt, double* out_err) {',
    '  (void)frame_dt;',
    '  if (out_err) *out_err = 1.11e-16;',
    '  return 1u;',
    '}',
    'static double mock_height(double x, double z) { return (x + z) * 0.0; }',
    'static int32_t mock_foot_ik(double px, double pz, double dt, B8gFootContact32C* l, B8gFootContact32C* r) {',
    '  (void)dt;',
    '  l->x = px - 0.22; l->y = 0.0; l->z = pz; l->weight = 0.5;',
    '  r->x = px + 0.22; r->y = 0.0; r->z = pz; r->weight = 0.5;',
    '  return 0;',
    '}',
    'static const B8gPhysicsDispatchTable g_physics = { mock_step_s3, mock_height, mock_foot_ik };',
    '',
    'static uint8_t g_slab_mem[256];',
    'static void* mock_acquire_slab(int32_t sx, int32_t sy, int32_t sz, size_t* out_bytes) {',
    '  (void)sx; (void)sy; (void)sz;',
    '  g_active_slabs += 1u;',
    '  if (out_bytes) *out_bytes = sizeof(g_slab_mem);',
    '  return g_slab_mem;',
    '}',
    'static uint32_t mock_wipe_slab(void* ptr, size_t bytes) {',
    '  memset(ptr, 0, bytes);',
    '  if (g_active_slabs > 0u) g_active_slabs -= 1u;',
    '  return 0u;',
    '}',
    'static uint64_t mock_active_slabs(void) { return g_active_slabs; }',
    'static const B8gArenaSlabDispatchTable g_arena = { mock_acquire_slab, mock_wipe_slab, mock_active_slabs };',
    '',
    'int main(void) {',
    '  B8gGameEngineAbiTable tbl = {',
    '    .v2 = {',
    '      .magic = B8G_GAME_ENGINE_ABI_MAGIC,',
    '      .abi_version = B8G_GAME_ENGINE_ABI_VERSION_V3,',
    '      .streaming = &g_streaming,',
    '      .assets = &g_assets,',
    '      .physics = &g_physics,',
    '    },',
    '    .struct_size = (uint32_t)sizeof(B8gGameEngineAbiTable),',
    '    .capability_flags = B8G_GAME_CAP_VELOCITY_PREFETCH | B8G_GAME_CAP_ASSET_CLOSURE_GATE | B8G_GAME_CAP_S3_QUAT_PHYSICS | B8G_GAME_CAP_FOOT_PLACEMENT_IK | B8G_GAME_CAP_ARENA_V1_O1_PURGE,',
    '    .arena_slab = &g_arena,',
    '  };',
    '  const B8gGameEngineAbiTableV2* as_v2 = (const B8gGameEngineAbiTableV2*)&tbl;',
    '  if (!b8g_game_engine_abi_is_v3(as_v2)) return 1;',
    '  size_t slab_bytes = 0;',
    '  void* slab = tbl.arena_slab->acquire_slab(0, 0, 0, &slab_bytes);',
    '  if (tbl.arena_slab->active_slab_count() != 1u) return 2;',
    '  tbl.arena_slab->wipe_and_release_o1(slab, slab_bytes);',
    '  if (tbl.arena_slab->active_slab_count() != 0u) return 3;',
    '  uint64_t h = tbl.v2.assets->fnv64_bytes((const uint8_t*)"b8g", 3u);',
    '  if (h == 0u) return 4;',
    '  double q_err = 1.0;',
    '  tbl.v2.physics->step_fixed_s3(1.0 / 60.0, &q_err);',
    '  if (q_err > 1e-12) return 5;',
    '  printf("PASS: B8G-GAME-ENGINE ABI v3 verified (struct_size=%u caps=0x%02x fnv64=0x%016llx)\\n",',
    '         tbl.struct_size, tbl.capability_flags, (unsigned long long)h);',
    '  return 0;',
    '}',
    '',
  ].join('\n')

  try {
    fs.writeFileSync(testCPath, cSource, 'utf8')
    const zigCandidates = [
      process.env.ZIG_BIN,
      path.join(WORKSPACE_ROOT, 'bin', process.platform === 'win32' ? 'zig.cmd' : 'zig'),
      process.platform === 'win32' ? 'e:\\awesome-os\\bin\\zig.cmd' : undefined,
      'zig',
    ].filter((v): v is string => Boolean(v))

    let compilerBin = ''
    let compilerPrefix: string[] = []
    for (const candidate of zigCandidates) {
      if (candidate.includes('\\') || candidate.includes('/')) {
        if (fs.existsSync(candidate)) {
          compilerBin = candidate
          compilerPrefix = ['cc']
          break
        }
        continue
      }
      const probe = spawnSync(candidate, ['version'], { stdio: 'pipe', shell: process.platform === 'win32' })
      if (probe.status === 0) {
        compilerBin = candidate
        compilerPrefix = ['cc']
        break
      }
    }
    if (!compilerBin) {
      for (const ccName of ['cc', 'gcc', 'clang']) {
        const probe = spawnSync(ccName, ['--version'], { stdio: 'pipe' })
        if (probe.status === 0) {
          compilerBin = ccName
          compilerPrefix = []
          break
        }
      }
    }
    assert.ok(compilerBin, 'Expected zig cc or system C11 compiler (cc/gcc/clang) to be available')

    const ccRes = spawnSync(
      compilerBin,
      [...compilerPrefix, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', testCPath, '-o', outExe],
      {
        cwd: HERE,
        encoding: 'utf8',
        shell: process.platform === 'win32' && compilerBin.toLowerCase().endsWith('.cmd'),
      }
    )
    assert.equal(ccRes.status, 0, `${compilerBin} failed: ${ccRes.stderr || ccRes.stdout}`)

    const runRes = spawnSync(outExe, [], { encoding: 'utf8' })
    assert.equal(runRes.status, 0, `b8g_game_engine_abi_test failed: ${runRes.stderr || runRes.stdout}`)
    assert.match(runRes.stdout, /PASS: B8G-GAME-ENGINE ABI v3 verified/)
    console.log(runRes.stdout.trim())
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('6. GLB 2.0 binary parser & multi-asset CC0 .b8p CAS deduplication (shared Kenney/Quaternius palettes)', async () => {
  const { buildMinimalGlb, ingestGlbCatalogToB8p, parseGlb } = await import('./glb-ingestor.mts')

  const sharedPaletteTex = new Uint8Array(16_384)
  for (let i = 0; i < sharedPaletteTex.length; i++) sharedPaletteTex[i] = (i * 31) & 0xff

  const entries = []
  for (let idx = 0; idx < 50; idx++) {
    const uniqueMesh = new Uint8Array(1024)
    uniqueMesh[0] = idx & 0xff
    uniqueMesh[1] = (idx * 7) & 0xff
    const bin = new Uint8Array(sharedPaletteTex.byteLength + uniqueMesh.byteLength)
    bin.set(sharedPaletteTex, 0)
    bin.set(uniqueMesh, sharedPaletteTex.byteLength)

    const glb = buildMinimalGlb(
      {
        asset: { version: '2.0', generator: 'b8g-cc0-test' },
        meshes: [{ name: `asset_${idx}`, primitives: [{}] }],
        materials: [{ name: 'kenney_palette' }],
        images: [{ name: 'palette', mimeType: 'image/png', bufferView: 0 }],
        skins: idx % 5 === 0 ? [{ name: 'humanoid_rig', joints: [0, 1, 2] }] : [],
        animations: idx % 5 === 0 ? [{ name: 'walk', channels: [{}] }] : [],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: sharedPaletteTex.byteLength },
          { buffer: 0, byteOffset: sharedPaletteTex.byteLength, byteLength: uniqueMesh.byteLength },
        ],
      },
      bin
    )
    if (idx === 0) {
      const parsed = parseGlb(glb)
      assert.equal(parsed.meshCount, 1)
      assert.equal(parsed.imageCount, 1)
      assert.equal(parsed.skinCount, 1)
      assert.equal(parsed.animationCount, 1)
    }
    entries.push({
      assetId: `kenney/city/building_${idx}`,
      packSource: 'kenney' as const,
      license: 'CC0-1.0' as const,
      bytes: glb,
    })
  }

  const report = ingestGlbCatalogToB8p(entries)
  assert.equal(report.assetsIngested, 50)
  assert.equal(report.skinsDetected, 10)
  assert.equal(report.animationsDetected, 10)
  assert.equal(report.closureProof.closed, true)
  assert.ok(report.dedupRatioPct > 85, `expected >85% CAS dedup across shared palette, got ${report.dedupRatioPct}%`)
  console.log(
    `[GLB->B8P CAS] 50 CC0 .glb assets | raw=${(report.totalInputBytes / 1024).toFixed(1)} KB -> ` +
    `unique=${(report.uniqueStoredBytes / 1024).toFixed(1)} KB (${report.dedupRatioPct}% deduped, ${report.uniqueBlocks}/${report.totalSubBlocks} blocks)`
  )
})
