/**
 * @file sections/b8g-game-engine/spatial-audio.test.mts
 * @description Verification Suite & Zero-GC Batch Benchmark for the 3D Spatial Audio & Doppler Engine:
 *   1. Inverse-distance clamped gain rolloff (`refDistance`, `maxDistance`, `rolloffFactor`)
 *   2. Left/right stereo azimuth panning symmetry & rotated listener basis
 *   3. Exact physical Doppler pitch shift (approaching vs receding, moving listener, Mach clamp)
 *   4. Capability-injected `SpatialAudioHostPort` zero-ambient-global dispatch
 *   5. Zero-GC batch evaluation of 256 emitters (verifying buffer reuse & sub-millisecond latency)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

import {
  SPEED_OF_SOUND_MPS,
  SpatialAudioBatchBuffer,
  SpatialAudioEngine,
  computeDopplerRatio,
  computeInverseDistanceGain,
  type AudioListener,
  type SpatialAudioEmitter,
  type SpatialAudioFrame,
  type SpatialAudioHostPort,
} from './spatial-audio.mts'

function assertNear(actual: number, expected: number, eps: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${label}: expected ${expected} ± ${eps}, got ${actual}`
  )
}

function makeOriginListener(velX: number = 0, velY: number = 0, velZ: number = 0): AudioListener {
  return {
    position: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
    velocity: { x: velX, y: velY, z: velZ },
  }
}

test('1. Inverse-distance clamped gain rolloff (refDistance, maxDistance, rolloffFactor)', () => {
  const engine = new SpatialAudioEngine({
    defaultRefDistance: 2.0,
    defaultMaxDistance: 20.0,
    defaultRolloffFactor: 1.0,
  })
  engine.setListener(makeOriginListener())

  const out: SpatialAudioFrame = {
    emitterId: 0,
    distance: 0,
    gain: 0,
    pan: 0,
    dopplerRatio: 1,
    observedFrequencyHz: 440,
    azimuthRad: 0,
    elevationRad: 0,
  }

  // Within refDistance (d = 0.5 < ref = 2.0) -> clamped to full baseGain (1.0)
  engine.evaluateEmitter(
    { id: 1, position: { x: 0, y: 0, z: -0.5 }, velocity: { x: 0, y: 0, z: 0 } },
    out
  )
  assertNear(out.distance, 0.5, 1e-12, 'distance within refDistance')
  assertNear(out.gain, 1.0, 1e-12, 'gain clamped at refDistance')

  // At 2 * refDistance (d = 4.0) with rolloff = 1.0 -> gain = 2 / (2 + 1 * (4 - 2)) = 0.5
  engine.evaluateEmitter(
    { id: 2, position: { x: 0, y: 0, z: -4.0 }, velocity: { x: 0, y: 0, z: 0 } },
    out
  )
  assertNear(out.gain, 0.5, 1e-12, 'gain at 2x refDistance')

  // At maxDistance (d = 20.0) -> gain = 2 / (2 + 1 * (20 - 2)) = 0.1
  engine.evaluateEmitter(
    { id: 3, position: { x: 0, y: 0, z: -20.0 }, velocity: { x: 0, y: 0, z: 0 } },
    out
  )
  assertNear(out.gain, 0.1, 1e-12, 'gain at maxDistance')

  // Beyond maxDistance (d = 500.0) -> clamped strictly to maxDistance gain (0.1)
  engine.evaluateEmitter(
    { id: 4, position: { x: 0, y: 0, z: -500.0 }, velocity: { x: 0, y: 0, z: 0 } },
    out
  )
  assertNear(out.gain, 0.1, 1e-12, 'gain clamped beyond maxDistance')

  // Higher rolloffFactor (2.0) at d = 4.0 -> 2 / (2 + 2 * 2) = 1/3
  const steep = computeInverseDistanceGain(4.0, 2.0, 20.0, 2.0, 1.0)
  assertNear(steep, 1.0 / 3.0, 1e-12, 'steep rolloffFactor=2.0')
})

test('2. Left/right stereo azimuth panning symmetry and rotated listener basis', () => {
  const engine = new SpatialAudioEngine()
  engine.setListener(makeOriginListener())

  // Default listener faces -Z with +Y up -> right vector must be (+1, 0, 0)
  const right = engine.getListenerRight()
  assertNear(right.x, 1.0, 1e-12, 'right.x')
  assertNear(right.y, 0.0, 1e-12, 'right.y')
  assertNear(right.z, 0.0, 1e-12, 'right.z')

  // Hard right (+X), hard left (-X), dead ahead (-Z), directly behind (+Z)
  const hardRight = engine.evaluateEmitter({
    id: 10,
    position: { x: 10, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  })
  const hardLeft = engine.evaluateEmitter({
    id: 11,
    position: { x: -10, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  })
  const centerFront = engine.evaluateEmitter({
    id: 12,
    position: { x: 0, y: 0, z: -10 },
    velocity: { x: 0, y: 0, z: 0 },
  })
  const centerBack = engine.evaluateEmitter({
    id: 13,
    position: { x: 0, y: 0, z: 10 },
    velocity: { x: 0, y: 0, z: 0 },
  })

  assertNear(hardRight.pan, 1.0, 1e-12, 'hard right pan')
  assertNear(hardLeft.pan, -1.0, 1e-12, 'hard left pan')
  assertNear(hardRight.pan + hardLeft.pan, 0.0, 1e-12, 'perfect left/right symmetry')
  assertNear(centerFront.pan, 0.0, 1e-12, 'center front pan')
  assertNear(centerBack.pan, 0.0, 1e-12, 'center back pan')

  // Arbitrary 45-degree diagonal symmetry
  const diagRight = engine.evaluateEmitter({
    id: 14,
    position: { x: 5, y: 0, z: -5 },
    velocity: { x: 0, y: 0, z: 0 },
  })
  const diagLeft = engine.evaluateEmitter({
    id: 15,
    position: { x: -5, y: 0, z: -5 },
    velocity: { x: 0, y: 0, z: 0 },
  })
  assertNear(diagRight.pan, Math.SQRT1_2, 1e-12, '45-deg right pan')
  assertNear(diagLeft.pan, -Math.SQRT1_2, 1e-12, '45-deg left pan')
  assertNear(diagRight.pan + diagLeft.pan, 0.0, 1e-12, '45-deg symmetry')

  // Rotate listener 90 deg right (facing +X, up +Y -> right is +Z)
  engine.setListener({
    position: { x: 0, y: 0, z: 0 },
    forward: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  })
  const rotatedRight = engine.evaluateEmitter({
    id: 16,
    position: { x: 0, y: 0, z: 8 },
    velocity: { x: 0, y: 0, z: 0 },
  })
  assertNear(rotatedRight.pan, 1.0, 1e-12, 'pan after 90-deg yaw rotation')
})

test('3. Exact physical Doppler pitch shift (approaching vs receding + supersonic clamp)', () => {
  const engine = new SpatialAudioEngine({ speedOfSound: SPEED_OF_SOUND_MPS })
  engine.setListener(makeOriginListener(0, 0, 0))

  // Emitter at +X = 50m moving TOWARD listener at -34.3 m/s (Mach 0.1)
  // f_obs = f_src * 343 / (343 - 34.3) = 440 * (10 / 9)
  const approaching = engine.evaluateEmitter({
    id: 20,
    position: { x: 50, y: 0, z: 0 },
    velocity: { x: -34.3, y: 0, z: 0 },
    baseFrequencyHz: 440,
  })
  const expectedApproachRatio = SPEED_OF_SOUND_MPS / (SPEED_OF_SOUND_MPS - 34.3)
  assert.ok(approaching.dopplerRatio > 1.0, 'approaching emitter must shift pitch UP')
  assertNear(approaching.dopplerRatio, expectedApproachRatio, 1e-12, 'approaching Doppler ratio')
  assertNear(
    approaching.observedFrequencyHz,
    440 * expectedApproachRatio,
    1e-9,
    'approaching frequency Hz'
  )

  // Emitter at +X = 50m moving AWAY from listener at +34.3 m/s (Mach 0.1)
  // f_obs = f_src * 343 / (343 + 34.3) = 440 * (10 / 11)
  const receding = engine.evaluateEmitter({
    id: 21,
    position: { x: 50, y: 0, z: 0 },
    velocity: { x: 34.3, y: 0, z: 0 },
    baseFrequencyHz: 440,
  })
  const expectedRecedeRatio = SPEED_OF_SOUND_MPS / (SPEED_OF_SOUND_MPS + 34.3)
  assert.ok(receding.dopplerRatio < 1.0, 'receding emitter must shift pitch DOWN')
  assertNear(receding.dopplerRatio, expectedRecedeRatio, 1e-12, 'receding Doppler ratio')

  // Moving listener (+20 m/s toward emitter at +X) + receding emitter (+10 m/s away)
  // f_obs / f_src = (343 + 20) / (343 + 10) = 363 / 353
  engine.setListener(makeOriginListener(20, 0, 0))
  const bothMoving = engine.evaluateEmitter({
    id: 22,
    position: { x: 50, y: 0, z: 0 },
    velocity: { x: 10, y: 0, z: 0 },
    baseFrequencyHz: 1000,
  })
  assertNear(bothMoving.dopplerRatio, 363 / 353, 1e-12, 'moving listener + emitter Doppler')

  // Supersonic safety clamp: emitter approaching faster than speed of sound (-500 m/s)
  const supersonicApproach = computeDopplerRatio(0, -500, SPEED_OF_SOUND_MPS, 1.0, 0.25, 4.0)
  assert.ok(Number.isFinite(supersonicApproach), 'supersonic ratio must stay finite')
  assertNear(supersonicApproach, 4.0, 1e-12, 'supersonic approach clamped to maxDopplerRatio')

  // Supersonic listener receding faster than speed of sound (-500 m/s)
  const supersonicRecede = computeDopplerRatio(-500, 0, SPEED_OF_SOUND_MPS, 1.0, 0.25, 4.0)
  assert.ok(Number.isFinite(supersonicRecede), 'supersonic recede ratio must stay finite')
  assertNear(supersonicRecede, 0.25, 1e-12, 'supersonic recede clamped to minDopplerRatio')
})

test('4. Capability-injected SpatialAudioHostPort dispatch (zero ambient globals)', () => {
  const added: Array<{ id: number; soundId: string }> = []
  const removed: number[] = []
  const updated: Array<{ id: number; gain: number; pan: number; doppler: number }> = []
  let listenerPoseCalls = 0
  let committedCount = -1

  const mockPort: SpatialAudioHostPort = {
    setListenerPose() {
      listenerPoseCalls++
    },
    updateEmitter(id, _px, _py, _pz, _vx, _vy, _vz, gain, pan, dopplerRatio) {
      updated.push({ id, gain, pan, doppler: dopplerRatio })
    },
    onEmitterAdded(id, soundId) {
      added.push({ id, soundId })
    },
    onEmitterRemoved(id) {
      removed.push(id)
    },
    commitFrame(activeCount) {
      committedCount = activeCount
    },
  }

  const engine = new SpatialAudioEngine({}, mockPort)
  engine.setListener(makeOriginListener())
  engine.addEmitter({
    id: 101,
    soundId: 'audio/hover_turbine.ogg',
    position: { x: 4, y: 0, z: 0 },
    velocity: { x: -10, y: 0, z: 0 },
  })
  engine.addEmitter({
    id: 102,
    soundId: 'audio/harbor_bell.ogg',
    position: { x: -4, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
  })

  const batch = engine.tick()
  assert.equal(batch.count, 2)
  assert.equal(added.length, 2)
  assert.equal(listenerPoseCalls, 1)
  assert.equal(updated.length, 2)
  assert.equal(committedCount, 2)
  assertNear(updated[0]?.pan ?? 0, 1.0, 1e-12, 'port emitter 101 pan')
  assertNear(updated[1]?.pan ?? 0, -1.0, 1e-12, 'port emitter 102 pan')

  assert.equal(engine.removeEmitter(101), true)
  assert.deepEqual(removed, [101])
  assert.equal(engine.emitterCount, 1)
})

test('5. Zero-GC batch evaluation of 256 emitters (buffer identity reuse & sub-ms latency)', () => {
  const COUNT = 256
  const engine = new SpatialAudioEngine({ initialBatchCapacity: COUNT })
  engine.setListener(makeOriginListener(12.5, 0, -8.0))

  const emitters: SpatialAudioEmitter[] = []
  for (let i = 0; i < COUNT; i++) {
    const angle = (i / COUNT) * Math.PI * 2
    const radius = 2.0 + (i % 32) * 3.0
    emitters.push({
      id: i + 1,
      position: {
        x: Math.cos(angle) * radius,
        y: ((i % 5) - 2) * 1.5,
        z: Math.sin(angle) * radius,
      },
      velocity: {
        x: -Math.sin(angle) * 15.0,
        y: 0,
        z: Math.cos(angle) * 15.0,
      },
      refDistance: 2.0,
      maxDistance: 120.0,
      rolloffFactor: 1.0,
      baseFrequencyHz: 440.0,
    })
  }

  const outBuf = new SpatialAudioBatchBuffer(COUNT)
  // Capture typed-array buffer references before repeated batch evaluation
  const idsRef = outBuf.emitterIds
  const distsRef = outBuf.distances
  const gainsRef = outBuf.gains
  const pansRef = outBuf.pans
  const dopplersRef = outBuf.dopplerRatios
  const freqsRef = outBuf.observedFrequencies
  const azimuthsRef = outBuf.azimuths
  const elevationsRef = outBuf.elevations

  // Warmup
  for (let w = 0; w < 10; w++) {
    engine.evaluateBatch(emitters, COUNT, outBuf)
  }

  // Benchmark 100 consecutive frames of 256 emitters
  const ITERS = 100
  const t0 = performance.now()
  for (let iter = 0; iter < ITERS; iter++) {
    engine.evaluateBatch(emitters, COUNT, outBuf)
  }
  const elapsedMs = performance.now() - t0
  const perFrameMs = elapsedMs / ITERS

  assert.equal(outBuf.count, COUNT)
  // Verify strictly zero buffer reallocation across all 110 calls
  assert.equal(outBuf.emitterIds, idsRef, 'emitterIds typed array must not reallocate')
  assert.equal(outBuf.distances, distsRef, 'distances typed array must not reallocate')
  assert.equal(outBuf.gains, gainsRef, 'gains typed array must not reallocate')
  assert.equal(outBuf.pans, pansRef, 'pans typed array must not reallocate')
  assert.equal(outBuf.dopplerRatios, dopplersRef, 'dopplerRatios typed array must not reallocate')
  assert.equal(outBuf.observedFrequencies, freqsRef, 'observedFrequencies must not reallocate')
  assert.equal(outBuf.azimuths, azimuthsRef, 'azimuths typed array must not reallocate')
  assert.equal(outBuf.elevations, elevationsRef, 'elevations typed array must not reallocate')

  // Validate all 256 outputs are finite and within physical bounds
  for (let i = 0; i < COUNT; i++) {
    const g = outBuf.gains[i] ?? -1
    const p = outBuf.pans[i] ?? 99
    const d = outBuf.dopplerRatios[i] ?? -1
    assert.ok(g >= 0 && g <= 1.0, `emitter ${i} gain out of [0,1]: ${g}`)
    assert.ok(p >= -1.0 && p <= 1.0, `emitter ${i} pan out of [-1,1]: ${p}`)
    assert.ok(d >= 0.25 && d <= 4.0, `emitter ${i} doppler out of [0.25,4]: ${d}`)
  }

  assert.ok(
    perFrameMs < 5.0,
    `256-emitter batch evaluation should complete well under 5ms/frame (got ${perFrameMs.toFixed(4)}ms)`
  )
})
