/**
 * @file sections/b8g-game-engine/telemetry-ring.test.mts
 * @description Verification Suite & Real-Silicon Zero-GC Benchmark for the
 * `B8G_ARENA_V1` Binary Telemetry Ring (`telemetry-ring.mts`):
 *   1. Binary layout & header invariants (64B header, 64B slot, `B8GT` magic, version 1, power-of-2 guard)
 *   2. Wrap-around ring semantics (`readLatest`, chronological `readWindow`, `droppedCount`)
 *   3. `SharedArrayBuffer` / `Atomics` safety + `ArrayBuffer` fallback parity
 *   4. Exact `p95FrameMs`, `avgFrameMs`, `maxPhysicsUs`, and `< 16.6 ms` 60 FPS budget gate
 *   5. Real-silicon 100,000-frame zero-GC push benchmark (`< 50 ms`)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

import {
  TELEM_60FPS_BUDGET_MS,
  TELEM_HEADER_BYTES,
  TELEM_HDR_CAPACITY,
  TELEM_HDR_DROPPED_COUNT,
  TELEM_HDR_MAGIC,
  TELEM_HDR_VERSION,
  TELEM_HDR_WRITE_CURSOR,
  TELEM_MAGIC,
  TELEM_SLOT_BYTES,
  TELEM_VERSION,
  TelemetryRingReader,
  TelemetryRingWriter,
  computeTelemetryBufferBytes,
  createEmptyTelemetrySample,
  createTelemetryRingBuffer,
  type TelemetryFrameSample,
} from './telemetry-ring.mts'

function assertNear(actual: number, expected: number, eps: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${label}: expected ${expected} ± ${eps}, got ${actual}`
  )
}

function makeSample(frameIndex: number, frameMs: number, physicsUs: number): TelemetryFrameSample {
  return {
    frameIndex,
    timestampMs: frameIndex * 16.5,
    physicsUs,
    contacts: (frameIndex * 3) & 0xff,
    maxQuatErr: 1e-7 * (frameIndex % 10),
    t1Sectors: 9,
    t2Sectors: 27,
    t3Sectors: 64,
    purgeUs: 12.25,
    drawCalls: 140 + (frameIndex % 20),
    triangles: 250000 + frameIndex * 10,
    frameMs,
    v8HeapMb: 42.5,
    activeSplats: 120000,
    cullRatioPct: 68.75,
    flags: 0x0000_0005,
  }
}

test('1. Binary layout & 64-byte cache-line header invariants', () => {
  assert.equal(TELEM_HEADER_BYTES, 64)
  assert.equal(TELEM_SLOT_BYTES, 64)
  assert.equal(TELEM_MAGIC, 0x54473842) // 'B8GT'
  assert.equal(TELEM_VERSION, 1)
  assert.equal(computeTelemetryBufferBytes(16), 64 + 16 * 64)

  // Non-power-of-2 capacity must be rejected
  assert.throws(() => createTelemetryRingBuffer(0), RangeError)
  assert.throws(() => createTelemetryRingBuffer(12), RangeError)
  assert.throws(() => createTelemetryRingBuffer(-8), RangeError)

  const buf = createTelemetryRingBuffer(16, true)
  const u32 = new Uint32Array(buf)
  assert.equal(u32[TELEM_HDR_MAGIC], TELEM_MAGIC)
  assert.equal(u32[TELEM_HDR_VERSION], TELEM_VERSION)
  assert.equal(u32[TELEM_HDR_CAPACITY], 16)
  assert.equal(u32[TELEM_HDR_WRITE_CURSOR], 0)
  assert.equal(u32[TELEM_HDR_DROPPED_COUNT], 0)

  // Corrupted magic must be rejected by reader
  const badBuf = new ArrayBuffer(128)
  assert.throws(() => new TelemetryRingReader(badBuf), /Invalid TelemetryRing magic/)
})

test('2. Wrap-around ring semantics, chronological window, and field fidelity', () => {
  const writer = new TelemetryRingWriter({ capacity: 8, shared: true })
  const reader = new TelemetryRingReader(writer.buffer)

  assert.equal(reader.readLatest(), null)
  assert.deepEqual(reader.readWindow(5), [])

  // Push 20 frames into an 8-slot ring (wraps 2.5 times; 12 frames overwritten/dropped)
  for (let i = 1; i <= 20; i++) {
    const seq = writer.pushFrame(makeSample(i, 8.0 + i * 0.25, 400 + i * 15))
    assert.equal(seq, i - 1)
  }

  assert.equal(writer.getWriteCursor(), 20)
  assert.equal(reader.getWriteCursor(), 20)
  assert.equal(reader.getDroppedCount(), 12)
  assert.equal(reader.getAvailableCount(), 8)

  // Latest must be frame 20 with exact 16-field fidelity (within f32 precision)
  const latest = reader.readLatest()
  assert.ok(latest !== null)
  assert.equal(latest.frameIndex, 20)
  assertNear(latest.timestampMs, 20 * 16.5, 1e-3, 'timestampMs')
  assertNear(latest.physicsUs, 700, 1e-4, 'physicsUs')
  assert.equal(latest.contacts, 60)
  assertNear(latest.maxQuatErr, 0, 1e-7, 'maxQuatErr')
  assert.equal(latest.t1Sectors, 9)
  assert.equal(latest.t2Sectors, 27)
  assert.equal(latest.t3Sectors, 64)
  assertNear(latest.purgeUs, 12.25, 1e-5, 'purgeUs')
  assert.equal(latest.drawCalls, 140)
  assert.equal(latest.triangles, 250200)
  assertNear(latest.frameMs, 13.0, 1e-5, 'frameMs')
  assertNear(latest.v8HeapMb, 42.5, 1e-5, 'v8HeapMb')
  assert.equal(latest.activeSplats, 120000)
  assertNear(latest.cullRatioPct, 68.75, 1e-5, 'cullRatioPct')
  assert.equal(latest.flags, 0x0000_0005)

  // Full window (8 retained slots) must be frames 13..20 in chronological order
  const fullWin = reader.readWindow(32)
  assert.equal(fullWin.length, 8)
  assert.deepEqual(
    fullWin.map((f) => f.frameIndex),
    [13, 14, 15, 16, 17, 18, 19, 20]
  )

  // Partial window (3 latest slots) must be frames 18, 19, 20
  const tail3 = reader.readWindow(3)
  assert.deepEqual(
    tail3.map((f) => f.frameIndex),
    [18, 19, 20]
  )
})

test('3. SharedArrayBuffer / Atomics safety and ArrayBuffer fallback parity', () => {
  // SAB mode with two independent writers sharing one SAB backing buffer
  const sabBuf = createTelemetryRingBuffer(32, true)
  assert.ok(sabBuf instanceof SharedArrayBuffer, 'Expected SharedArrayBuffer on Node/V8 host')

  const writerA = new TelemetryRingWriter(sabBuf)
  const writerB = new TelemetryRingWriter(sabBuf)
  const sabReader = new TelemetryRingReader(sabBuf)

  assert.equal(writerA.isShared, true)
  assert.equal(writerB.isShared, true)
  assert.equal(sabReader.isShared, true)

  for (let i = 0; i < 10; i++) {
    writerA.pushFrame(makeSample(100 + i, 10.0, 500))
    writerB.pushFrame(makeSample(200 + i, 11.0, 600))
  }

  // Atomics.load on header cursor must match exactly 20 total pushes
  const headerU32 = new Uint32Array(sabBuf, 0, 16)
  assert.equal(Atomics.load(headerU32, TELEM_HDR_WRITE_CURSOR), 20)
  assert.equal(sabReader.getWriteCursor(), 20)
  assert.equal(sabReader.readWindow(20).length, 20)

  // ArrayBuffer fallback mode
  const abWriter = new TelemetryRingWriter({ capacity: 16, shared: false })
  const abReader = new TelemetryRingReader(abWriter.buffer)
  assert.equal(abWriter.isShared, false)
  assert.equal(abReader.isShared, false)
  assert.ok(abWriter.buffer instanceof ArrayBuffer)

  abWriter.pushFrameRaw(1, 16.0, 320.5, 4, 1e-8, 4, 8, 16, 5.5, 50, 10000, 9.25, 30.0, 5000, 55.0, 1)
  const reused = createEmptyTelemetrySample()
  const out = abReader.readLatest(reused)
  assert.equal(out, reused)
  assert.equal(reused.frameIndex, 1)
  assertNear(reused.frameMs, 9.25, 1e-5, 'ArrayBuffer fallback frameMs')
  assertNear(reused.physicsUs, 320.5, 1e-4, 'ArrayBuffer fallback physicsUs')
})

test('4. Exact p95FrameMs, avgFrameMs, maxPhysicsUs, and < 16.6 ms 60 FPS budget gate', () => {
  const writer = new TelemetryRingWriter({ capacity: 128, shared: true })
  const reader = new TelemetryRingReader(writer.buffer)

  // Push 100 frames with frameMs = 1.0, 2.0, ..., 100.0 (shuffled insertion order)
  // Using stride coprime to 100 (stride = 37) to prove sorting works regardless of write order
  for (let k = 0; k < 100; k++) {
    const val = ((k * 37) % 100) + 1 // permutation of 1..100
    writer.pushFrame(makeSample(k + 1, val * 0.15, 200 + val * 12.5))
  }

  // Values are 0.15, 0.30, ..., 15.00 ms
  // Exact avg = 7.575 ms, exact p95 = 95 * 0.15 = 14.25 ms (< 16.6 ms), maxPhysicsUs = 200 + 1250 = 1450
  const passSummary = reader.computeSummary()
  assert.equal(passSummary.sampleCount, 100)
  assertNear(passSummary.avgFrameMs, 7.575, 1e-3, 'avgFrameMs')
  assertNear(passSummary.p95FrameMs, 14.25, 1e-4, 'p95FrameMs (under budget)')
  assertNear(passSummary.maxPhysicsUs, 1450.0, 1e-3, 'maxPhysicsUs')
  assert.equal(passSummary.under60FpsBudget, true)
  assert.ok(passSummary.p95FrameMs < TELEM_60FPS_BUDGET_MS)

  // Now reset and push 100 frames where top 6 frames exceed 16.6 ms (e.g. 18.0 ms) -> p95 must fail budget
  writer.reset()
  for (let i = 0; i < 94; i++) {
    writer.pushFrame(makeSample(i + 1, 10.0, 350))
  }
  for (let i = 0; i < 6; i++) {
    writer.pushFrame(makeSample(95 + i, 18.0, 2100))
  }

  const failSummary = reader.computeSummary()
  assert.equal(failSummary.sampleCount, 100)
  assertNear(failSummary.p95FrameMs, 18.0, 1e-4, 'p95FrameMs (over budget)')
  assertNear(failSummary.maxPhysicsUs, 2100.0, 1e-3, 'maxPhysicsUs (over budget)')
  assert.equal(failSummary.under60FpsBudget, false)
})

test('5. Real-silicon 100,000-frame zero-GC push benchmark (< 50 ms)', () => {
  const writer = new TelemetryRingWriter({ capacity: 1024, shared: true })
  const reader = new TelemetryRingReader(writer.buffer)
  const sample = createEmptyTelemetrySample()

  // Warm up JIT cleanly before timing
  for (let i = 0; i < 2000; i++) {
    sample.frameIndex = i
    sample.frameMs = 8.0 + (i & 7) * 0.5
    sample.physicsUs = 450.0
    writer.pushFrame(sample)
  }
  writer.reset()

  const totalFrames = 100_000
  const t0 = performance.now()
  for (let i = 0; i < totalFrames; i++) {
    sample.frameIndex = i
    sample.timestampMs = i * 16.6
    sample.physicsUs = 420.0 + (i & 15) * 10.0
    sample.contacts = i & 63
    sample.maxQuatErr = 1e-7
    sample.t1Sectors = 9
    sample.t2Sectors = 27
    sample.t3Sectors = 64
    sample.purgeUs = 8.5
    sample.drawCalls = 128
    sample.triangles = 320_000
    sample.frameMs = 8.0 + (i & 15) * 0.5
    sample.v8HeapMb = 48.0
    sample.activeSplats = 150_000
    sample.cullRatioPct = 72.5
    sample.flags = 1
    writer.pushFrame(sample)
  }
  const elapsedMs = performance.now() - t0

  assert.equal(reader.getWriteCursor(), totalFrames)
  assert.equal(reader.getDroppedCount(), totalFrames - 1024)

  const summary = reader.computeSummary()
  assert.equal(summary.sampleCount, 1024)
  assert.equal(summary.under60FpsBudget, true)
  assert.ok(
    elapsedMs < 50,
    `100,000 zero-GC SAB pushes exceeded 50 ms budget: ${elapsedMs.toFixed(2)} ms`
  )
})
