/**
 * @file sections/b8g-game-engine/collision-physics.test.mts
 * @description Verification Suite & Real-Silicon Benchmark for the Zero-Dependency 3D Rigid-Body
 * Collision & Raycast Vehicle Physics Engine (`collision-physics.mts`):
 *   1. Spatial-Hash Broadphase (`BroadphaseGrid`) O(N) pair generation & deduplication
 *   2. Narrowphase manifolds: Sphere-Sphere, Sphere-Ground/Heightfield, AABB-AABB MTV, Sphere-AABB
 *   3. Elastic & inelastic sphere-ground bounce
 *   4. Sphere-sphere momentum conservation, elastic energy conservation & rotational impulse on S^3
 *   5. Box-box vertical stacking stability (Baumgarte stabilization + Coulomb friction)
 *   6. 4-Wheel Raycast Vehicle suspension settling on terrain + forward acceleration with steering
 *   7. Real-silicon benchmark: 250 colliding dynamic rigid bodies + 1 active raycast vehicle
 *      stepping 60 frames at 60 Hz (`avg_step_ms`, ‖q‖ drift < 1e-12, zero NaN)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

import { ProceduralTerrain, type TerrainSample } from './physics-locomotion.mts'
import {
  BroadphaseGrid,
  ColliderShape,
  CollisionBody,
  CollisionWorld,
  RaycastVehicle,
  collideAabbAabb,
  collideSphereAabb,
  collideSphereGroundPlane,
  collideSphereHeightfield,
  collideSphereSphere,
} from './collision-physics.mts'

test('1. Spatial-Hash BroadphaseGrid exact pair deduplication & O(N) culling', () => {
  const grid = new BroadphaseGrid(2.0)

  // 3 bodies: 0 & 1 overlap across multiple cells; 2 is far away
  grid.insert(0, { minX: -1.5, minY: -1.5, minZ: -1.5, maxX: 1.5, maxY: 1.5, maxZ: 1.5 })
  grid.insert(1, { minX: 0.5, minY: 0.5, minZ: 0.5, maxX: 3.5, maxY: 3.5, maxZ: 3.5 })
  grid.insert(2, { minX: 100.0, minY: 0.0, minZ: 100.0, maxX: 102.0, maxY: 2.0, maxZ: 102.0 })

  const pairs = grid.queryCandidatePairs()
  assert.equal(pairs.length, 1, 'multi-cell overlap must be deduplicated into exactly 1 pair')
  assert.equal(pairs[0]!.a, 0)
  assert.equal(pairs[0]!.b, 1)

  // Verify O(N) sparse grid with 500 non-overlapping bodies produces 0 pairs quickly
  grid.clear()
  for (let i = 0; i < 500; i++) {
    const x = i * 5.0
    grid.insert(i, { minX: x, minY: 0, minZ: 0, maxX: x + 1.0, maxY: 1.0, maxZ: 1.0 })
  }
  const sparsePairs = grid.queryCandidatePairs()
  assert.equal(sparsePairs.length, 0)
})

test('2. Narrowphase contact manifolds (Sphere-Sphere, Sphere-Ground/Heightfield, AABB-AABB, Sphere-AABB)', () => {
  // Sphere vs Sphere
  const sA = new CollisionBody(0, 1.0, 0, { shape: ColliderShape.Sphere, radius: 1.0 })
  const sB = new CollisionBody(1.5, 1.0, 0, { shape: ColliderShape.Sphere, radius: 1.0 })
  const ss = collideSphereSphere(sA, 0, sB, 1)
  assert.ok(ss)
  assert.ok(Math.abs(ss.penetration - 0.5) < 1e-12)
  assert.ok(Math.abs(ss.nx - -1.0) < 1e-12, 'normal must point from B toward A (-X)')
  assert.ok(Math.abs(ss.ny) < 1e-12)
  assert.ok(Math.abs(ss.nz) < 1e-12)

  // Sphere vs GroundPlane
  const sGround = new CollisionBody(0, 0.3, 0, { shape: ColliderShape.Sphere, radius: 0.5 })
  const sg = collideSphereGroundPlane(sGround, 0, 0.0)
  assert.ok(sg)
  assert.ok(Math.abs(sg.penetration - 0.2) < 1e-12)
  assert.equal(sg.ny, 1)

  // Sphere vs Heightfield
  const terrain = new ProceduralTerrain(42, -5.0, 2.0, 0.05)
  const sample: TerrainSample = {
    height: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    slopeAngleRad: 0,
    submergedDepth: 0,
  }
  const h0 = terrain.sampleHeight(4.0, -3.0)
  const sTerrain = new CollisionBody(4.0, h0 + 0.2, -3.0, { shape: ColliderShape.Sphere, radius: 0.5 })
  const sh = collideSphereHeightfield(sTerrain, 0, terrain, sample)
  assert.ok(sh)
  assert.ok(sh.penetration > 0.2)
  assert.ok(Math.abs(Math.hypot(sh.nx, sh.ny, sh.nz) - 1.0) < 1e-12)

  // AABB vs AABB (MTV along Y axis)
  const bA = new CollisionBody(0, 1.8, 0, { shape: ColliderShape.Box, halfExtents: { x: 1, y: 1, z: 1 } })
  const bB = new CollisionBody(0.1, 0.0, 0.05, { shape: ColliderShape.Box, halfExtents: { x: 1, y: 1, z: 1 } })
  const bb = collideAabbAabb(bA, 0, bB, 1)
  assert.ok(bb)
  assert.ok(Math.abs(bb.penetration - 0.2) < 1e-12)
  assert.equal(bb.nx, 0)
  assert.equal(bb.ny, 1)
  assert.equal(bb.nz, 0)

  // Sphere vs AABB (exterior closest-point)
  const sp = new CollisionBody(1.3, 0.0, 0.0, { shape: ColliderShape.Sphere, radius: 0.5 })
  const bx = new CollisionBody(0.0, 0.0, 0.0, { shape: ColliderShape.Box, halfExtents: { x: 1, y: 1, z: 1 } })
  const sb = collideSphereAabb(sp, 0, bx, 1, true)
  assert.ok(sb)
  assert.ok(Math.abs(sb.penetration - 0.2) < 1e-12)
  assert.ok(Math.abs(sb.nx - 1.0) < 1e-12)

  // Sphere vs AABB (sphere center inside box)
  const spInside = new CollisionBody(0.85, 0.0, 0.0, { shape: ColliderShape.Sphere, radius: 0.5 })
  const sbIn = collideSphereAabb(spInside, 0, bx, 1, true)
  assert.ok(sbIn)
  assert.ok(Math.abs(sbIn.penetration - 0.65) < 1e-12)
  assert.equal(sbIn.nx, 1)
})

test('3. Elastic & inelastic sphere-ground bounce', () => {
  // 3a. Elastic bounce (restitution = 1.0, zero damping)
  const elasticWorld = new CollisionWorld({
    fixedDt: 1 / 120,
    gravity: 9.81,
    groundPlaneY: 0.0,
    solverIterations: 12,
  })
  const dropHeight = 5.0
  const elasticSphere = new CollisionBody(0, dropHeight, 0, {
    shape: ColliderShape.Sphere,
    radius: 0.5,
    mass: 1.0,
    restitution: 1.0,
    friction: 0.0,
    linearDamping: 0.0,
    angularDamping: 0.0,
  })
  elasticWorld.addBody(elasticSphere)

  let touchedGround = false
  let maxReboundHeight = 0
  for (let i = 0; i < 360; i++) {
    elasticWorld.step()
    if (elasticSphere.grounded) touchedGround = true
    if (touchedGround && elasticSphere.py > maxReboundHeight) {
      maxReboundHeight = elasticSphere.py
    }
  }
  assert.equal(touchedGround, true, 'elastic sphere must contact ground')
  assert.ok(
    Math.abs(maxReboundHeight - dropHeight) < 0.35,
    `elastic rebound height (${maxReboundHeight.toFixed(3)}) must stay close to dropHeight (${dropHeight})`
  )

  // 3b. Inelastic drop (restitution = 0.0)
  const inelasticWorld = new CollisionWorld({
    fixedDt: 1 / 60,
    gravity: 9.81,
    groundPlaneY: 0.0,
  })
  const inelasticSphere = new CollisionBody(0, 4.0, 0, {
    shape: ColliderShape.Sphere,
    radius: 0.5,
    mass: 1.0,
    restitution: 0.0,
    friction: 0.5,
    linearDamping: 0.01,
  })
  inelasticWorld.addBody(inelasticSphere)

  for (let i = 0; i < 180; i++) {
    inelasticWorld.step()
  }
  assert.ok(
    Math.abs(inelasticSphere.py - 0.5) < 0.02,
    `inelastic sphere must rest on ground at y=0.5 (got ${inelasticSphere.py.toFixed(4)})`
  )
  assert.ok(Math.abs(inelasticSphere.vy) < 0.05, `inelastic sphere vy must settle near 0 (got ${inelasticSphere.vy})`)
})

test('4. Sphere-sphere momentum & elastic energy conservation + rotational impulse on S^3', () => {
  // Zero-gravity, zero-damping isolated two-body elastic collision with unequal masses
  const world = new CollisionWorld({
    fixedDt: 1 / 120,
    gravity: 0.0,
    groundPlaneY: null,
    solverIterations: 16,
    baumgarteBeta: 0.0,
  })

  const a = new CollisionBody(-1.2, 0, 0, {
    shape: ColliderShape.Sphere,
    radius: 0.5,
    mass: 2.0,
    restitution: 1.0,
    friction: 0.0,
    linearDamping: 0.0,
    angularDamping: 0.0,
  })
  const b = new CollisionBody(1.2, 0, 0, {
    shape: ColliderShape.Sphere,
    radius: 0.5,
    mass: 5.0,
    restitution: 1.0,
    friction: 0.0,
    linearDamping: 0.0,
    angularDamping: 0.0,
  })
  a.vx = 6.0
  b.vx = -2.0

  world.addBody(a)
  world.addBody(b)

  const initialPx = a.mass * a.vx + b.mass * b.vx
  const initialKE = 0.5 * a.mass * a.vx * a.vx + 0.5 * b.mass * b.vx * b.vx

  for (let i = 0; i < 60; i++) {
    world.step()
  }

  const finalPx = a.mass * a.vx + b.mass * b.vx
  const finalKE = 0.5 * a.mass * a.vx * a.vx + 0.5 * b.mass * b.vx * b.vx

  assert.ok(a.vx < 0 && b.vx > 0, 'spheres must rebound in opposite directions')
  assert.ok(
    Math.abs(finalPx - initialPx) < 1e-12,
    `linear momentum must be conserved to < 1e-12 (diff=${Math.abs(finalPx - initialPx)})`
  )
  assert.ok(
    Math.abs(finalKE - initialKE) < 1e-10,
    `elastic kinetic energy must be conserved (diff=${Math.abs(finalKE - initialKE)})`
  )

  // Verify rotational impulse from Coulomb friction on ground impact + UnitQuaternion ||q|| = 1 +/- 1e-12
  const spinWorld = new CollisionWorld({
    fixedDt: 1 / 60,
    gravity: 9.81,
    groundPlaneY: 0.0,
  })
  const rollingBall = new CollisionBody(0, 0.52, 0, {
    shape: ColliderShape.Sphere,
    radius: 0.5,
    mass: 1.5,
    restitution: 0.1,
    friction: 0.8,
    linearDamping: 0.0,
    angularDamping: 0.0,
  })
  rollingBall.vx = 8.0
  spinWorld.addBody(rollingBall)

  for (let i = 0; i < 60; i++) {
    spinWorld.step()
  }

  assert.ok(
    Math.abs(rollingBall.wz) > 1.0,
    `ground Coulomb friction must induce rolling angular velocity wz (got ${rollingBall.wz.toFixed(3)})`
  )
  assert.ok(
    spinWorld.maxQuatNormError < 1e-12,
    `UnitQuaternion norm drift must stay < 1e-12 (got ${spinWorld.maxQuatNormError})`
  )
})

test('5. Box-box vertical stacking stability', () => {
  const world = new CollisionWorld({
    fixedDt: 1 / 60,
    gravity: 9.81,
    groundPlaneY: 0.0,
    solverIterations: 16,
    baumgarteBeta: 0.25,
    penetrationSlop: 0.004,
  })

  const stackCount = 5
  const boxes: CollisionBody[] = []
  for (let i = 0; i < stackCount; i++) {
    const box = new CollisionBody(0, 0.5 + i * 1.0, 0, {
      shape: ColliderShape.Box,
      halfExtents: { x: 0.5, y: 0.5, z: 0.5 },
      mass: 2.0,
      restitution: 0.0,
      friction: 0.7,
      linearDamping: 0.05,
      angularDamping: 0.1,
      lockRotation: true,
    })
    boxes.push(box)
    world.addBody(box)
  }

  // Step 3 seconds (180 frames at 60 Hz)
  for (let frame = 0; frame < 180; frame++) {
    world.step()
  }

  for (let i = 0; i < stackCount; i++) {
    const expectedY = 0.5 + i * 1.0
    const b = boxes[i]!
    assert.ok(
      Math.abs(b.py - expectedY) < 0.08,
      `box[${i}] y=${b.py.toFixed(4)} drifted too far from expected ${expectedY}`
    )
    assert.ok(Math.abs(b.px) < 0.05 && Math.abs(b.pz) < 0.05, `box[${i}] slid laterally`)
    assert.ok(Math.abs(b.vy) < 0.15, `box[${i}] vertical velocity unstable: ${b.vy.toFixed(4)}`)
  }
})

test('6. 4-Wheel RaycastVehicle suspension settling on terrain & accelerating with steering', () => {
  // Gentle rolling terrain
  const terrain = new ProceduralTerrain(2026, -10.0, 1.2, 0.025)
  const startH = terrain.sampleHeight(0, 0)

  const world = new CollisionWorld({
    fixedDt: 1 / 60,
    gravity: 9.81,
    groundPlaneY: null,
    solverIterations: 10,
  })

  const vehicle = new RaycastVehicle(0, startH + 1.15, 0, {
    chassisMass: 1200,
    maxEngineForce: 6000,
    maxSteerAngle: 0.45,
  })
  world.addVehicle(vehicle)

  // Phase A: Settle suspension for 1.5s (90 frames) with zero throttle
  for (let i = 0; i < 90; i++) {
    world.step(1 / 60, terrain)
  }

  assert.equal(vehicle.groundedWheelCount, 4, 'all 4 wheels must settle onto terrain')
  assert.ok(
    Math.abs(vehicle.chassis.vy) < 0.25,
    `chassis vertical velocity must settle (got ${vehicle.chassis.vy.toFixed(4)})`
  )
  for (let w = 0; w < 4; w++) {
    const wheel = vehicle.wheels[w]!
    assert.ok(wheel.compression > 0.01 && wheel.compression < wheel.restLength, `wheel[${w}] compression out of range`)
    assert.ok(wheel.suspensionForce > 1000, `wheel[${w}] must carry chassis weight`)
  }

  // Phase B: Accelerate forward (+Z) with right steering (+0.5) for 2.0s (120 frames)
  const startX = vehicle.chassis.px
  const startZ = vehicle.chassis.pz
  vehicle.setControls(1.0, 0.5, 0.0)

  for (let i = 0; i < 120; i++) {
    world.step(1 / 60, terrain)
  }

  const speed = vehicle.forwardSpeed
  const displacedZ = vehicle.chassis.pz - startZ
  const displacedX = vehicle.chassis.px - startX

  assert.ok(speed > 5.0, `vehicle must accelerate forward (got speed=${speed.toFixed(2)} m/s)`)
  assert.ok(displacedZ > 4.0, `vehicle must travel forward along +Z (got dz=${displacedZ.toFixed(2)} m)`)
  assert.ok(
    Math.abs(displacedX) > 0.5,
    `steering must curve trajectory laterally (got dx=${displacedX.toFixed(2)} m)`
  )
  assert.ok(
    world.maxQuatNormError < 1e-12,
    `vehicle UnitQuaternion norm drift must stay < 1e-12 (got ${world.maxQuatNormError})`
  )
})

test('7. Real-silicon benchmark: 250 colliding dynamic rigid bodies + 1 active RaycastVehicle (60 frames @ 60 Hz)', () => {
  const world = new CollisionWorld({
    fixedDt: 1 / 60,
    gravity: 9.81,
    cellSize: 2.0,
    groundPlaneY: 0.0,
    solverIterations: 8,
  })

  // Spawn 250 colliding dynamic rigid bodies in a dense 5x5x10 cluster above the ground
  const bodyCount = 250
  for (let i = 0; i < bodyCount; i++) {
    const gx = i % 5
    const gz = Math.floor(i / 5) % 5
    const gy = Math.floor(i / 25)
    const isBox = (i & 1) === 1
    const body = new CollisionBody(
      (gx - 2) * 1.05 + (gy % 2) * 0.12,
      0.7 + gy * 1.08,
      (gz - 2) * 1.05 - 6.0,
      isBox
        ? {
            shape: ColliderShape.Box,
            halfExtents: { x: 0.45, y: 0.45, z: 0.45 },
            mass: 2.0,
            restitution: 0.2,
            friction: 0.55,
          }
        : {
            shape: ColliderShape.Sphere,
            radius: 0.45,
            mass: 1.5,
            restitution: 0.35,
            friction: 0.5,
          }
    )
    body.vx = ((i * 7) % 5 - 2) * 0.4
    body.vz = ((i * 11) % 5 - 2) * 0.4
    world.addBody(body)
  }

  // Spawn 1 active 4-wheel RaycastVehicle driving with throttle + steering
  const vehicle = new RaycastVehicle(8.0, 1.0, 0.0, {
    chassisMass: 1200,
    maxEngineForce: 5800,
  })
  vehicle.setControls(0.85, 0.3, 0.0)
  world.addVehicle(vehicle)

  assert.equal(world.bodies.length, 251)

  const frames = 60
  let totalContacts = 0
  let totalBroadphasePairs = 0

  const t0 = performance.now()
  for (let f = 0; f < frames; f++) {
    const stats = world.step(1 / 60)
    totalContacts += stats.activeContacts
    totalBroadphasePairs += stats.broadphasePairs
  }
  const elapsedMs = performance.now() - t0
  const avgStepMs = elapsedMs / frames

  // Verify zero NaN/Infinity across all 251 bodies
  for (let i = 0; i < world.bodies.length; i++) {
    const b = world.bodies[i]!
    const q = b.orientation
    const vals = [b.px, b.py, b.pz, b.vx, b.vy, b.vz, b.wx, b.wy, b.wz, q.w, q.x, q.y, q.z]
    for (let k = 0; k < vals.length; k++) {
      assert.ok(Number.isFinite(vals[k]), `body[${i}] field[${k}] produced non-finite value: ${vals[k]}`)
    }
  }

  assert.ok(totalContacts > 0, 'benchmark scene must generate and resolve real contacts')
  assert.ok(
    world.maxQuatNormError < 1e-12,
    `benchmark max ‖q‖ drift must stay < 1e-12 (got ${world.maxQuatNormError})`
  )
  assert.ok(
    avgStepMs < 16.67,
    `real-silicon 60 Hz budget exceeded: avg_step_ms=${avgStepMs.toFixed(3)}ms (must be < 16.67ms)`
  )

  console.log(
    `[collision-physics-bench] bodies=250+1vehicle frames=${frames} avg_step_ms=${avgStepMs.toFixed(3)} total_pairs=${totalBroadphasePairs} total_contacts=${totalContacts} max_quat_err=${world.maxQuatNormError.toExponential(2)} vehicle_speed=${vehicle.forwardSpeed.toFixed(2)}m/s`
  )
})
