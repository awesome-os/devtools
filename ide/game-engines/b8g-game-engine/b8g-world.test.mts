/**
 * @file sections/b8g-game-engine/b8g-world.test.mts
 * @description Verification Suite for the Unified `B8gWorld` Scene Graph, Live Script Hot-Swap,
 * Mathematical Total Asset Closure Gate, Script Error Isolation, and `O(Δ)` Binary State-Delta
 * Multiplayer Replication.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  B8G_DELTA_HEADER_BYTES,
  B8G_DELTA_PACKET_MAGIC,
  B8G_DELTA_RECORD_BYTES,
  B8gWorld,
} from './b8g-world.mts'
import { AssetClosureError } from './asset-pipeline.mts'
import { ProceduralTerrain } from './physics-locomotion.mts'

test('1. Entity spawning, unified streaming + S^3 physics stepping, and error-isolated scripting', () => {
  const terrain = new ProceduralTerrain(42, -5.0, 0.0, 0.05) // flat ground at y = 0
  const world = new B8gWorld({
    manifestId: 'sandbox-island',
    gravity: 9.81,
    fixedDt: 1 / 60,
    terrain,
    streaming: {
      sectorSize: 64,
      tier1Radius: 1,
      tier2Radius: 2,
      tier3Radius: 2,
    },
  })

  world.registerAsset('hero.mesh', 'mesh', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
  world.registerAsset('buggy.mesh', 'mesh', new Uint8Array([9, 10, 11, 12]))

  const hero = world.spawn({
    id: 'hero',
    assetId: 'hero.mesh',
    pos: { x: 2, y: 10, z: 3 },
    mass: 2,
    radius: 0.5,
    onTick: (e, dt) => {
      e.vx = 4.0
      e.wy = 1.5
      e.data['ticks'] = ((e.data['ticks'] as number | undefined) ?? 0) + 1
      assert.ok(dt > 0)
    },
  })

  const buggy = world.spawn({
    id: 'buggy-npc',
    assetId: 'buggy.mesh',
    pos: [0, 5, 0],
    mass: 1,
    radius: 0.5,
    onTick: () => {
      throw new Error('simulated kid script typo')
    },
  })

  const report = world.step(1 / 60, { x: 2, y: 10, z: 3 }, { x: 4, y: 0, z: 0 })
  assert.equal(report.tick, 1)
  assert.equal(report.physicsSubSteps, 1)
  assert.equal(report.scriptsExecuted, 2)
  assert.equal(report.streaming.loadedSectors, 25) // 5x5 grid with tier3Radius=2

  // Error isolation: buggy script failed, but hero script + physics still ran cleanly
  assert.equal(report.scriptErrors.length, 1)
  assert.equal(report.scriptErrors[0]!.entityId, 'buggy-npc')
  assert.match(report.scriptErrors[0]!.message, /simulated kid script typo/)
  assert.equal(buggy.lastError, 'simulated kid script typo')
  assert.equal(hero.data['ticks'], 1)
  assert.ok(hero.x > 2.0, 'hero must advance along +X under script velocity')
  assert.ok(hero.y < 10.0, 'hero must fall under gravity')
  assert.ok(
    hero.orientation.normError() < 1e-12,
    `hero quaternion must remain on S^3 (err=${hero.orientation.normError()})`
  )
})

test('2. Live hotSwapScript swaps behavior without losing position, velocity, orientation, or custom state', () => {
  const world = new B8gWorld({ gravity: 0, fixedDt: 1 / 60 })

  const rocket = world.spawn({
    id: 'rocket',
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 6, y: 0, z: 0 },
    angVel: { x: 0, y: 2.0, z: 0 },
    mass: 1,
    radius: 0.5,
    linearDamping: 0,
    angularDamping: 0,
    data: { fuel: 100 },
    onTick: (e) => {
      e.data['fuel'] = (e.data['fuel'] as number) - 1
    },
  })

  // Step 30 frames (0.5 seconds) with script v1
  for (let i = 0; i < 30; i++) {
    world.step(1 / 60)
  }

  const posBeforeSwap = rocket.pos
  const velBeforeSwap = rocket.vel
  const quatBeforeSwap = {
    w: rocket.orientation.w,
    x: rocket.orientation.x,
    y: rocket.orientation.y,
    z: rocket.orientation.z,
  }
  assert.ok(posBeforeSwap.x > 2.9, `expected x ≈ 3.0 before swap, got ${posBeforeSwap.x}`)
  assert.equal(rocket.data['fuel'], 70)
  assert.equal(rocket.scriptVersion, 1)

  // Hot-swap script live: now accelerate upward (+Y) instead of burning fuel
  world.hotSwapScript('rocket', (e, dt) => {
    e.vy += 12.0 * dt
    e.data['boosted'] = true
  })

  assert.equal(rocket.scriptVersion, 2)
  // Immediate state preservation check: zero reset of transform, velocity, quaternion, or custom data
  assert.equal(rocket.x, posBeforeSwap.x)
  assert.equal(rocket.y, posBeforeSwap.y)
  assert.equal(rocket.z, posBeforeSwap.z)
  assert.equal(rocket.vx, velBeforeSwap.x)
  assert.equal(rocket.orientation.w, quatBeforeSwap.w)
  assert.equal(rocket.orientation.y, quatBeforeSwap.y)
  assert.equal(rocket.data['fuel'], 70)

  // Continue stepping with new script v2: preserves X momentum AND adds Y boost
  for (let i = 0; i < 30; i++) {
    world.step(1 / 60)
  }

  assert.ok(rocket.x > posBeforeSwap.x + 2.9, 'preserved +X velocity must continue after hot-swap')
  assert.ok(rocket.y > 1.0, 'new hot-swapped +Y boost script must take effect immediately')
  assert.equal(rocket.data['fuel'], 70, 'old fuel-burn script must no longer run')
  assert.equal(rocket.data['boosted'], true)
})

test('3. Mathematical Total Asset Closure Gate via B8gWorld.verifyAssets()', () => {
  const world = new B8gWorld({ manifestId: 'closure-test' })
  world.registerAsset('tree.mesh', 'mesh', new Uint8Array([1, 3, 5, 7, 9]))
  world.registerAsset('water.shader', 'shader', new Uint8Array([2, 4, 6, 8]))

  world.spawn({ id: 'palm-1', assetId: 'tree.mesh', pos: [0, 0, 0], isStatic: true })
  world.spawn({ id: 'palm-2', assetId: 'tree.mesh', pos: [5, 0, 0], isStatic: true })
  world.spawn({ id: 'ocean', assetId: 'water.shader', pos: [0, -1, 0], isStatic: true })

  // All referenced assets exist -> closure proof succeeds
  const proof = world.verifyAssets()
  assert.equal(proof.closed, true)
  assert.equal(proof.missingCount, 0)
  assert.equal(proof.requiredCount, 2) // deduplicated: tree.mesh + water.shader

  // Spawn an entity referencing a missing asset -> verifyAssets() MUST fail fast
  world.spawn({ id: 'ghost', assetId: 'missing/boss.mesh', pos: [10, 0, 0], isStatic: true })
  assert.throws(
    () => world.verifyAssets(),
    (err: unknown) => {
      assert.ok(err instanceof AssetClosureError)
      assert.equal(err.missingAssets.length, 1)
      assert.equal(err.missingAssets[0]!.assetId, 'missing/boss.mesh')
      assert.equal(err.missingAssets[0]!.reason, 'missing-in-manifest')
      return true
    }
  )
})

test('4. O(Δ) Binary State-Delta Replication: 500 entities with 5 moving -> >95% bandwidth reduction & exact sync', () => {
  const server = new B8gWorld({ gravity: 0, fixedDt: 1 / 60, deltaEpsilon: 1e-4 })
  const client = new B8gWorld({ gravity: 0, fixedDt: 1 / 60, deltaEpsilon: 1e-4 })

  const TOTAL_ENTITIES = 500
  const MOVING_COUNT = 5

  // Spawn 500 identical entities on both server and client
  for (let i = 0; i < TOTAL_ENTITIES; i++) {
    const isMover = i < MOVING_COUNT
    const baseOpts = {
      id: `ent_${i}`,
      pos: { x: (i % 25) * 4, y: 0, z: Math.floor(i / 25) * 4 },
      mass: isMover ? 1 : 0, // 495 static/sleeping, 5 dynamic movers
      linearDamping: 0,
      angularDamping: 0,
    }
    server.spawn({
      ...baseOpts,
      vel: isMover ? { x: 10 + i, y: 0.5, z: -2 } : { x: 0, y: 0, z: 0 },
      angVel: isMover ? { x: 0, y: 1.2, z: 0 } : { x: 0, y: 0, z: 0 },
    })
    client.spawn(baseOpts)
  }

  // Baseline full snapshot size for 500 entities
  const fullSnapshot = server.encodeFullSnapshot()
  assert.equal(
    fullSnapshot.byteLength,
    B8G_DELTA_HEADER_BYTES + TOTAL_ENTITIES * B8G_DELTA_RECORD_BYTES
  )

  // Step server by 1 frame: only the 5 dynamic entities move beyond 1e-4
  const stepReport = server.step(1 / 60)
  assert.equal(stepReport.changedEntityCount, MOVING_COUNT)

  // Encode O(Δ) delta since tick 0
  const deltaPacket = server.encodeStateDelta(0)
  const deltaView = new DataView(deltaPacket.buffer, deltaPacket.byteOffset, deltaPacket.byteLength)
  assert.equal(deltaView.getUint32(0, true), B8G_DELTA_PACKET_MAGIC)
  assert.equal(deltaView.getUint32(4, true), 1) // tick 1
  assert.equal(deltaView.getInt32(8, true), 0) // sinceTick 0
  assert.equal(deltaView.getUint32(12, true), MOVING_COUNT) // ONLY 5 records!
  assert.equal(
    deltaPacket.byteLength,
    B8G_DELTA_HEADER_BYTES + MOVING_COUNT * B8G_DELTA_RECORD_BYTES
  )

  // Verify >95% bandwidth reduction vs full snapshot (5/500 -> ~98.9% reduction!)
  const bandwidthReduction = 1 - deltaPacket.byteLength / fullSnapshot.byteLength
  assert.ok(
    bandwidthReduction > 0.95,
    `expected >95% bandwidth reduction, got ${(bandwidthReduction * 100).toFixed(2)}% (${deltaPacket.byteLength} vs ${fullSnapshot.byteLength} bytes)`
  )

  // Apply delta packet to client and verify exact synchronization
  const applyReport = client.applyStateDelta(deltaPacket)
  assert.equal(applyReport.recordCount, MOVING_COUNT)
  assert.equal(applyReport.appliedCount, MOVING_COUNT)
  assert.equal(applyReport.skippedCount, 0)
  assert.equal(client.tick, 1)

  for (let i = 0; i < TOTAL_ENTITIES; i++) {
    const sEnt = server.getEntity(`ent_${i}`)!
    const cEnt = client.getEntity(`ent_${i}`)!
    assert.ok(Math.abs(sEnt.x - cEnt.x) < 1e-4, `entity ${i} x mismatch`)
    assert.ok(Math.abs(sEnt.y - cEnt.y) < 1e-4, `entity ${i} y mismatch`)
    assert.ok(Math.abs(sEnt.z - cEnt.z) < 1e-4, `entity ${i} z mismatch`)
    assert.ok(Math.abs(sEnt.orientation.w - cEnt.orientation.w) < 1e-4, `entity ${i} qw mismatch`)
    assert.ok(Math.abs(sEnt.orientation.y - cEnt.orientation.y) < 1e-4, `entity ${i} qy mismatch`)
    assert.ok(cEnt.orientation.normError() < 1e-12, `replicated quaternion must remain on S^3`)
  }

  // Zero-movement tick: 0 entity records encoded (0 bytes for sleeping/unchanged entities)
  const emptyDelta = server.encodeStateDelta(1)
  assert.equal(emptyDelta.byteLength, B8G_DELTA_HEADER_BYTES)

  // Sub-epsilon jitter (< 1e-4) must NOT trigger replication
  const sleeper = server.getEntity('ent_100')!
  sleeper.x += 5e-5
  sleeper.orientation.integrateAngularVelocityInPlace(0, 1e-5, 0, 1)
  const jitterDelta = server.encodeStateDelta(1)
  assert.equal(jitterDelta.byteLength, B8G_DELTA_HEADER_BYTES)
})
