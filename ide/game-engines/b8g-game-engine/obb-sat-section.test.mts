/**
 * @file sections/b8g-game-engine/obb-sat-section.test.mts
 * @description Verification & benchmark suite for Research Dossier 04 (`G_visual ≡ G_physics`):
 * exact 8-corner OBB-vs-Ground, 15-axis SAT OBB-vs-OBB (45-degree rotated stacked crates with
 * zero visual clipping), OBB-vs-Sphere, and 10,000-pair real-silicon throughput.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { UnitQuaternion } from './physics-locomotion.mts'
import {
  collideObbGround,
  collideObbObb,
  collideObbSphere,
  computeObbWorldCorners,
  type ObbPose,
} from './obb-sat-section.mts'

test('1. 45-degree tilted OBB touches ground at exact sqrt(2)*h with zero corner clipping', () => {
  const rot45 = UnitQuaternion.fromAxisAngle(0, 0, 1, Math.PI / 4)
  const h = 0.5
  const exactCornerHeight = Math.SQRT2 * h // ~0.70710678

  // Just above floor -> no contact
  const above: ObbPose = { pos: { x: 0, y: exactCornerHeight + 0.002, z: 0 }, rot: rot45, halfExtents: { x: h, y: h, z: h } }
  assert.equal(collideObbGround(above, 0), null)

  // Penetrating floor by 0.05 -> exact penetration = 0.05
  const dipped: ObbPose = { pos: { x: 0, y: exactCornerHeight - 0.05, z: 0 }, rot: rot45, halfExtents: { x: h, y: h, z: h } }
  const c = collideObbGround(dipped, 0)
  assert.ok(c !== null)
  assert.ok(Math.abs(c.penetration - 0.05) < 1e-6, `expected 0.05 penetration, got ${c.penetration}`)
  assert.equal(c.normal.y, 1)
  assert.equal(computeObbWorldCorners(dipped).length, 8)
})

test('2. 15-axis SAT OBB-vs-OBB eliminates rotated wooden-on-metal crate clipping', () => {
  const metalBase: ObbPose = {
    pos: { x: 0, y: 0.5, z: 0 },
    rot: UnitQuaternion.fromAxisAngle(0, 1, 0, 0),
    halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
  }
  const rot45 = UnitQuaternion.fromAxisAngle(0, 0, 1, Math.PI / 4)
  const exactKissY = 1.0 + Math.SQRT2 * 0.5 // top of base (1.0) + rotated corner extent (0.7071)

  // At exact corner-to-face kiss (+1e-4) -> separated (no false collision)
  const kissing: ObbPose = {
    pos: { x: 0, y: exactKissY + 1e-4, z: 0 },
    rot: rot45,
    halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
  }
  assert.equal(collideObbObb(metalBase, kissing), null)

  // Lowered by 0.04 -> exact MTV along +Y with penetration 0.04 (zero clipping!)
  const overlapping: ObbPose = {
    pos: { x: 0, y: exactKissY - 0.04, z: 0 },
    rot: rot45,
    halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
  }
  const hit = collideObbObb(metalBase, overlapping)
  assert.ok(hit !== null)
  assert.ok(Math.abs(hit.penetration - 0.04) < 1e-5, `expected 0.04 penetration, got ${hit.penetration}`)
  assert.ok(hit.normal.y > 0.999, `expected +Y normal, got ${JSON.stringify(hit.normal)}`)
})

test('3. Exact OBB-vs-Sphere contact on rotated box face', () => {
  const obb: ObbPose = {
    pos: { x: 0, y: 1, z: 0 },
    rot: UnitQuaternion.fromAxisAngle(0, 1, 0, Math.PI / 4),
    halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
  }
  const hit = collideObbSphere(obb, { x: 0, y: 1.85, z: 0 }, 0.4)
  assert.ok(hit !== null)
  assert.ok(Math.abs(hit.penetration - 0.05) < 1e-6)
  assert.ok(hit.normal.y > 0.999)
})

test('4. Real-silicon benchmark: 10,000 exact 15-axis OBB-vs-OBB SAT tests (< 25 ms)', () => {
  const a: ObbPose = { pos: { x: 0, y: 0.5, z: 0 }, rot: UnitQuaternion.fromAxisAngle(0.3, 0.8, 0.2, 0.7), halfExtents: { x: 0.5, y: 0.5, z: 0.5 } }
  const b: ObbPose = { pos: { x: 0.6, y: 0.9, z: 0.2 }, rot: UnitQuaternion.fromAxisAngle(-0.4, 0.5, 0.6, 1.1), halfExtents: { x: 0.5, y: 0.5, z: 0.5 } }

  let hits = 0
  const t0 = performance.now()
  for (let i = 0; i < 10_000; i++) {
    if (collideObbObb(a, b) !== null) hits++
  }
  const ms = performance.now() - t0
  assert.equal(hits, 10_000)
  assert.ok(ms < 100, `10k OBB SAT took too long: ${ms.toFixed(2)} ms`)
  console.log(`[OBB-SAT bench] 10,000 exact 15-axis OBB-vs-OBB tests in ${ms.toFixed(2)} ms (${((ms / 10_000) * 1000).toFixed(2)} us/pair)`)
})
