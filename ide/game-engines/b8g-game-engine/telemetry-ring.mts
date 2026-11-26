/**
 * @file sections/b8g-game-engine/telemetry-ring.mts
 * @description Zero-Serialization `B8G_ARENA_V1` Binary Telemetry Ring Buffer.
 *
 * Capabilities:
 *   1. Fixed 64-byte cache-line aligned header (`TELEM_HEADER_BYTES = 64`) and
 *      64-byte cache-line aligned telemetry slots (`TELEM_SLOT_BYTES = 64`, 16 x 4B fields)
 *      over `SharedArrayBuffer` with automatic `ArrayBuffer` fallback.
 *   2. `TelemetryRingWriter`: zero-allocation hot-loop `pushFrame(sample)` and `pushFrameRaw(...)`
 *      using `Atomics.add` on `writeCursor` (and `droppedCount` on wrap-around) when SAB-backed.
 *   3. `TelemetryRingReader`: lock-free `readLatest()`, chronological `readWindow(count)`, and
 *      `computeSummary()` returning exact `avgFrameMs`, `p95FrameMs`, `maxPhysicsUs`, and
 *      `under60FpsBudget` (`p95FrameMs < 16.6 ms`).
 *
 * Strictly 100% portable: ZERO `node:*` imports, ZERO ambient host globals, `erasableSyntaxOnly: true`.
 */

// ============================================================================
// 1. Binary Layout Constants (B8G_ARENA_V1 64-Byte Cache-Line Aligned)
// ============================================================================

/** Little-endian ASCII `'B8GT'` (`0x42='B'`, `0x38='8'`, `0x47='G'`, `0x54='T'`). */
export const TELEM_MAGIC = 0x54473842
export const TELEM_MAGIC_STRING = 'B8GT'
export const TELEM_VERSION = 1

/** Fixed 64-byte header (16 x Uint32 words). */
export const TELEM_HEADER_BYTES = 64
export const TELEM_HEADER_WORDS = 16

/** Fixed 64-byte per-frame slot (16 x 4-byte fields). */
export const TELEM_SLOT_BYTES = 64
export const TELEM_SLOT_WORDS = 16

/** Default power-of-2 ring capacity (1024 frames = ~17 seconds @ 60 Hz). */
export const TELEM_DEFAULT_CAPACITY = 1024

/** Maximum supported power-of-2 ring capacity (16,777,216 slots = 1 GiB). */
export const TELEM_MAX_CAPACITY = 1 << 24

/** Strict 60 FPS frame-time budget threshold in milliseconds. */
export const TELEM_60FPS_BUDGET_MS = 16.6

// Header Uint32 word offsets (0..15)
export const TELEM_HDR_MAGIC = 0
export const TELEM_HDR_VERSION = 1
export const TELEM_HDR_CAPACITY = 2
export const TELEM_HDR_WRITE_CURSOR = 3
export const TELEM_HDR_DROPPED_COUNT = 4

// Slot 4-byte word offsets (0..15)
export const TELEM_SLOT_FRAME_INDEX = 0
export const TELEM_SLOT_TIMESTAMP_MS = 1
export const TELEM_SLOT_PHYSICS_US = 2
export const TELEM_SLOT_CONTACTS = 3
export const TELEM_SLOT_MAX_QUAT_ERR = 4
export const TELEM_SLOT_T1_SECTORS = 5
export const TELEM_SLOT_T2_SECTORS = 6
export const TELEM_SLOT_T3_SECTORS = 7
export const TELEM_SLOT_PURGE_US = 8
export const TELEM_SLOT_DRAW_CALLS = 9
export const TELEM_SLOT_TRIANGLES = 10
export const TELEM_SLOT_FRAME_MS = 11
export const TELEM_SLOT_V8_HEAP_MB = 12
export const TELEM_SLOT_ACTIVE_SPLATS = 13
export const TELEM_SLOT_CULL_RATIO_PCT = 14
export const TELEM_SLOT_FLAGS = 15

// ============================================================================
// 2. Data Contracts
// ============================================================================

export type TelemetryBackingBuffer = SharedArrayBuffer | ArrayBuffer

export interface TelemetryFrameSample {
  /** Monotonic frame index (`u32`). */
  frameIndex: number
  /** Frame timestamp in milliseconds (`f32`). */
  timestampMs: number
  /** Physics step duration in microseconds (`f32`). */
  physicsUs: number
  /** Active collision contact count (`u32`). */
  contacts: number
  /** Maximum unit-quaternion norm error `| ||q|| - 1 |` (`f32`). */
  maxQuatErr: number
  /** Tier-1 full-physics active sector count (`u32`). */
  t1Sectors: number
  /** Tier-2 simplified-sim active sector count (`u32`). */
  t2Sectors: number
  /** Tier-3 horizon-imposter active sector count (`u32`). */
  t3Sectors: number
  /** O(1) arena sector purge duration in microseconds (`f32`). */
  purgeUs: number
  /** GPU draw call count (`u32`). */
  drawCalls: number
  /** Rendered triangle count (`u32`). */
  triangles: number
  /** Total frame duration in milliseconds (`f32`). */
  frameMs: number
  /** V8 / JS heap usage in megabytes (`f32`). */
  v8HeapMb: number
  /** Active Gaussian splats / instanced primitives (`u32`). */
  activeSplats: number
  /** Frustum/occlusion cull ratio percentage in `[0, 100]` (`f32`). */
  cullRatioPct: number
  /** Bitmask flags (`u32`). */
  flags: number
}

export interface TelemetryRingOptions {
  /** Power-of-2 slot capacity (default `1024`). */
  capacity?: number
  /** Prefer `SharedArrayBuffer` when available (default `true`; falls back to `ArrayBuffer`). */
  shared?: boolean
  /** Optional pre-allocated backing buffer (overrides `capacity`/`shared`). */
  buffer?: TelemetryBackingBuffer
}

export interface TelemetryRingHeader {
  readonly magic: number
  readonly version: number
  readonly capacity: number
  readonly writeCursor: number
  readonly droppedCount: number
  readonly isShared: boolean
}

export interface TelemetrySummary {
  readonly sampleCount: number
  readonly writeCursor: number
  readonly droppedCount: number
  readonly avgFrameMs: number
  readonly minFrameMs: number
  readonly maxFrameMs: number
  readonly p50FrameMs: number
  readonly p95FrameMs: number
  readonly p99FrameMs: number
  readonly avgPhysicsUs: number
  readonly maxPhysicsUs: number
  readonly under60FpsBudget: boolean
}

// ============================================================================
// 3. Buffer Helpers & Validation
// ============================================================================

export function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= TELEM_MAX_CAPACITY && (value & (value - 1)) === 0
}

export function isSharedTelemetryBuffer(buffer: TelemetryBackingBuffer): buffer is SharedArrayBuffer {
  return typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer
}

export function computeTelemetryBufferBytes(capacity: number): number {
  if (!isPowerOfTwo(capacity)) {
    throw new RangeError(
      `TelemetryRing capacity must be a power of 2 in [1, ${TELEM_MAX_CAPACITY}], got ${capacity}`
    )
  }
  return TELEM_HEADER_BYTES + capacity * TELEM_SLOT_BYTES
}

/**
 * Allocates and initializes a 64-byte aligned `B8G_ARENA_V1` telemetry ring buffer.
 * Uses `SharedArrayBuffer` by default when available, seamlessly falling back to `ArrayBuffer`.
 */
export function createTelemetryRingBuffer(
  capacity: number = TELEM_DEFAULT_CAPACITY,
  shared: boolean = true
): TelemetryBackingBuffer {
  const totalBytes = computeTelemetryBufferBytes(capacity)
  let buffer: TelemetryBackingBuffer
  if (shared && typeof SharedArrayBuffer === 'function') {
    try {
      buffer = new SharedArrayBuffer(totalBytes)
    } catch {
      buffer = new ArrayBuffer(totalBytes)
    }
  } else {
    buffer = new ArrayBuffer(totalBytes)
  }

  const headerU32 = new Uint32Array(buffer, 0, TELEM_HEADER_WORDS)
  headerU32[TELEM_HDR_MAGIC] = TELEM_MAGIC
  headerU32[TELEM_HDR_VERSION] = TELEM_VERSION
  headerU32[TELEM_HDR_CAPACITY] = capacity >>> 0
  headerU32[TELEM_HDR_WRITE_CURSOR] = 0
  headerU32[TELEM_HDR_DROPPED_COUNT] = 0

  return buffer
}

/**
 * Creates a mutable zero-initialized `TelemetryFrameSample` for reuse in hot loops.
 */
export function createEmptyTelemetrySample(): TelemetryFrameSample {
  return {
    frameIndex: 0,
    timestampMs: 0,
    physicsUs: 0,
    contacts: 0,
    maxQuatErr: 0,
    t1Sectors: 0,
    t2Sectors: 0,
    t3Sectors: 0,
    purgeUs: 0,
    drawCalls: 0,
    triangles: 0,
    frameMs: 0,
    v8HeapMb: 0,
    activeSplats: 0,
    cullRatioPct: 0,
    flags: 0,
  }
}

function validateAndReadHeader(buffer: TelemetryBackingBuffer): {
  capacity: number
  isShared: boolean
} {
  if (buffer.byteLength < TELEM_HEADER_BYTES + TELEM_SLOT_BYTES) {
    throw new RangeError(
      `TelemetryRing buffer too small: expected at least ${TELEM_HEADER_BYTES + TELEM_SLOT_BYTES} bytes, got ${buffer.byteLength}`
    )
  }
  const isShared = isSharedTelemetryBuffer(buffer)
  const headerU32 = new Uint32Array(buffer, 0, TELEM_HEADER_WORDS)
  const magic = isShared ? (Atomics.load(headerU32, TELEM_HDR_MAGIC) >>> 0) : (headerU32[TELEM_HDR_MAGIC] >>> 0)
  if (magic !== TELEM_MAGIC) {
    throw new Error(
      `Invalid TelemetryRing magic: expected 0x${TELEM_MAGIC.toString(16)} (${TELEM_MAGIC_STRING}), got 0x${magic.toString(16)}`
    )
  }
  const version = isShared
    ? (Atomics.load(headerU32, TELEM_HDR_VERSION) >>> 0)
    : (headerU32[TELEM_HDR_VERSION] >>> 0)
  if (version !== TELEM_VERSION) {
    throw new Error(`Unsupported TelemetryRing version: expected ${TELEM_VERSION}, got ${version}`)
  }
  const capacity = isShared
    ? (Atomics.load(headerU32, TELEM_HDR_CAPACITY) >>> 0)
    : (headerU32[TELEM_HDR_CAPACITY] >>> 0)
  if (!isPowerOfTwo(capacity)) {
    throw new RangeError(`Invalid TelemetryRing header capacity (must be power of 2): ${capacity}`)
  }
  const requiredBytes = TELEM_HEADER_BYTES + capacity * TELEM_SLOT_BYTES
  if (buffer.byteLength < requiredBytes) {
    throw new RangeError(
      `TelemetryRing buffer truncated: capacity=${capacity} requires ${requiredBytes} bytes, got ${buffer.byteLength}`
    )
  }
  return { capacity, isShared }
}

// ============================================================================
// 4. TelemetryRingWriter (Zero-Allocation Hot Loop)
// ============================================================================

export class TelemetryRingWriter {
  readonly buffer: TelemetryBackingBuffer
  readonly capacity: number
  readonly isShared: boolean

  private readonly mask: number
  private readonly u32: Uint32Array
  private readonly f32: Float32Array

  constructor(bufferOrOptions?: TelemetryBackingBuffer | TelemetryRingOptions) {
    let buffer: TelemetryBackingBuffer
    if (bufferOrOptions === undefined) {
      buffer = createTelemetryRingBuffer(TELEM_DEFAULT_CAPACITY, true)
    } else if (
      bufferOrOptions instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer === 'function' && bufferOrOptions instanceof SharedArrayBuffer)
    ) {
      buffer = bufferOrOptions
    } else if (bufferOrOptions.buffer !== undefined) {
      buffer = bufferOrOptions.buffer
    } else {
      buffer = createTelemetryRingBuffer(
        bufferOrOptions.capacity ?? TELEM_DEFAULT_CAPACITY,
        bufferOrOptions.shared ?? true
      )
    }

    const meta = validateAndReadHeader(buffer)
    this.buffer = buffer
    this.capacity = meta.capacity
    this.isShared = meta.isShared
    this.mask = meta.capacity - 1
    this.u32 = new Uint32Array(buffer)
    this.f32 = new Float32Array(buffer)
  }

  /**
   * Pushes one 64-byte frame sample into the ring with ZERO heap allocations.
   * Returns the 0-based monotonic sequence index assigned to this frame.
   */
  pushFrame(sample: TelemetryFrameSample): number {
    const u32 = this.u32
    const f32 = this.f32
    let seq: number

    if (this.isShared) {
      seq = Atomics.add(u32, TELEM_HDR_WRITE_CURSOR, 1) >>> 0
      if (seq >= this.capacity) {
        Atomics.add(u32, TELEM_HDR_DROPPED_COUNT, 1)
      }
    } else {
      seq = u32[TELEM_HDR_WRITE_CURSOR] >>> 0
      u32[TELEM_HDR_WRITE_CURSOR] = (seq + 1) >>> 0
      if (seq >= this.capacity) {
        u32[TELEM_HDR_DROPPED_COUNT] = (u32[TELEM_HDR_DROPPED_COUNT] + 1) >>> 0
      }
    }

    const base = TELEM_HEADER_WORDS + ((seq & this.mask) << 4)
    u32[base] = sample.frameIndex >>> 0
    f32[base + 1] = sample.timestampMs
    f32[base + 2] = sample.physicsUs
    u32[base + 3] = sample.contacts >>> 0
    f32[base + 4] = sample.maxQuatErr
    u32[base + 5] = sample.t1Sectors >>> 0
    u32[base + 6] = sample.t2Sectors >>> 0
    u32[base + 7] = sample.t3Sectors >>> 0
    f32[base + 8] = sample.purgeUs
    u32[base + 9] = sample.drawCalls >>> 0
    u32[base + 10] = sample.triangles >>> 0
    f32[base + 11] = sample.frameMs
    f32[base + 12] = sample.v8HeapMb
    u32[base + 13] = sample.activeSplats >>> 0
    f32[base + 14] = sample.cullRatioPct
    u32[base + 15] = sample.flags >>> 0

    return seq
  }

  /**
   * Scalar-ABI push variant requiring zero wrapper objects at the call site.
   * Returns the 0-based monotonic sequence index assigned to this frame.
   */
  pushFrameRaw(
    frameIndex: number,
    timestampMs: number,
    physicsUs: number,
    contacts: number,
    maxQuatErr: number,
    t1Sectors: number,
    t2Sectors: number,
    t3Sectors: number,
    purgeUs: number,
    drawCalls: number,
    triangles: number,
    frameMs: number,
    v8HeapMb: number,
    activeSplats: number,
    cullRatioPct: number,
    flags: number
  ): number {
    const u32 = this.u32
    const f32 = this.f32
    let seq: number

    if (this.isShared) {
      seq = Atomics.add(u32, TELEM_HDR_WRITE_CURSOR, 1) >>> 0
      if (seq >= this.capacity) {
        Atomics.add(u32, TELEM_HDR_DROPPED_COUNT, 1)
      }
    } else {
      seq = u32[TELEM_HDR_WRITE_CURSOR] >>> 0
      u32[TELEM_HDR_WRITE_CURSOR] = (seq + 1) >>> 0
      if (seq >= this.capacity) {
        u32[TELEM_HDR_DROPPED_COUNT] = (u32[TELEM_HDR_DROPPED_COUNT] + 1) >>> 0
      }
    }

    const base = TELEM_HEADER_WORDS + ((seq & this.mask) << 4)
    u32[base] = frameIndex >>> 0
    f32[base + 1] = timestampMs
    f32[base + 2] = physicsUs
    u32[base + 3] = contacts >>> 0
    f32[base + 4] = maxQuatErr
    u32[base + 5] = t1Sectors >>> 0
    u32[base + 6] = t2Sectors >>> 0
    u32[base + 7] = t3Sectors >>> 0
    f32[base + 8] = purgeUs
    u32[base + 9] = drawCalls >>> 0
    u32[base + 10] = triangles >>> 0
    f32[base + 11] = frameMs
    f32[base + 12] = v8HeapMb
    u32[base + 13] = activeSplats >>> 0
    f32[base + 14] = cullRatioPct
    u32[base + 15] = flags >>> 0

    return seq
  }

  /** Explicitly increments the header `droppedCount` counter. */
  recordDropped(count: number = 1): number {
    const delta = count >>> 0
    if (delta === 0) {
      return this.getDroppedCount()
    }
    if (this.isShared) {
      return (Atomics.add(this.u32, TELEM_HDR_DROPPED_COUNT, delta) + delta) >>> 0
    }
    const next = (this.u32[TELEM_HDR_DROPPED_COUNT] + delta) >>> 0
    this.u32[TELEM_HDR_DROPPED_COUNT] = next
    return next
  }

  getWriteCursor(): number {
    return this.isShared
      ? (Atomics.load(this.u32, TELEM_HDR_WRITE_CURSOR) >>> 0)
      : (this.u32[TELEM_HDR_WRITE_CURSOR] >>> 0)
  }

  getDroppedCount(): number {
    return this.isShared
      ? (Atomics.load(this.u32, TELEM_HDR_DROPPED_COUNT) >>> 0)
      : (this.u32[TELEM_HDR_DROPPED_COUNT] >>> 0)
  }

  /** Resets writeCursor and droppedCount back to 0 without reallocating the arena. */
  reset(): void {
    if (this.isShared) {
      Atomics.store(this.u32, TELEM_HDR_WRITE_CURSOR, 0)
      Atomics.store(this.u32, TELEM_HDR_DROPPED_COUNT, 0)
    } else {
      this.u32[TELEM_HDR_WRITE_CURSOR] = 0
      this.u32[TELEM_HDR_DROPPED_COUNT] = 0
    }
  }
}

// ============================================================================
// 5. TelemetryRingReader (Lock-Free Inspection & Percentile Summary)
// ============================================================================

export class TelemetryRingReader {
  readonly buffer: TelemetryBackingBuffer
  readonly capacity: number
  readonly isShared: boolean

  private readonly mask: number
  private readonly u32: Uint32Array
  private readonly f32: Float32Array
  private readonly scratchFrameMs: Float32Array

  constructor(buffer: TelemetryBackingBuffer) {
    const meta = validateAndReadHeader(buffer)
    this.buffer = buffer
    this.capacity = meta.capacity
    this.isShared = meta.isShared
    this.mask = meta.capacity - 1
    this.u32 = new Uint32Array(buffer)
    this.f32 = new Float32Array(buffer)
    this.scratchFrameMs = new Float32Array(meta.capacity)
  }

  readHeader(): TelemetryRingHeader {
    return {
      magic: TELEM_MAGIC,
      version: TELEM_VERSION,
      capacity: this.capacity,
      writeCursor: this.getWriteCursor(),
      droppedCount: this.getDroppedCount(),
      isShared: this.isShared,
    }
  }

  getWriteCursor(): number {
    return this.isShared
      ? (Atomics.load(this.u32, TELEM_HDR_WRITE_CURSOR) >>> 0)
      : (this.u32[TELEM_HDR_WRITE_CURSOR] >>> 0)
  }

  getDroppedCount(): number {
    return this.isShared
      ? (Atomics.load(this.u32, TELEM_HDR_DROPPED_COUNT) >>> 0)
      : (this.u32[TELEM_HDR_DROPPED_COUNT] >>> 0)
  }

  getAvailableCount(): number {
    const cursor = this.getWriteCursor()
    return cursor < this.capacity ? cursor : this.capacity
  }

  /**
   * Reads the most recently written frame sample, or `null` if no frames have been pushed.
   * Pass a reusable `out` object for zero-allocation reads.
   */
  readLatest(out?: TelemetryFrameSample): TelemetryFrameSample | null {
    const cursor = this.getWriteCursor()
    if (cursor === 0) {
      return null
    }
    const slotIdx = (cursor - 1) & this.mask
    return this.readSlotInto(slotIdx, out ?? createEmptyTelemetrySample())
  }

  /**
   * Reads up to `count` most recent frames in chronological order (oldest -> newest).
   */
  readWindow(count: number): TelemetryFrameSample[] {
    const cursor = this.getWriteCursor()
    const available = cursor < this.capacity ? cursor : this.capacity
    const n = count <= 0 ? 0 : count < available ? Math.floor(count) : available
    if (n === 0) {
      return []
    }

    const result: TelemetryFrameSample[] = new Array<TelemetryFrameSample>(n)
    const startSeq = cursor - n
    for (let i = 0; i < n; i++) {
      const slotIdx = (startSeq + i) & this.mask
      result[i] = this.readSlotInto(slotIdx, createEmptyTelemetrySample())
    }
    return result
  }

  /**
   * Computes frame-time and physics statistics over the latest `windowCount` frames
   * (defaulting to all currently retained slots in the ring).
   *
   * Uses nearest-rank percentiles (`ceil(p * N) - 1`) and checks `p95FrameMs < 16.6 ms`
   * for `under60FpsBudget`.
   */
  computeSummary(windowCount?: number): TelemetrySummary {
    const cursor = this.getWriteCursor()
    const droppedCount = this.getDroppedCount()
    const available = cursor < this.capacity ? cursor : this.capacity
    const n =
      windowCount === undefined
        ? available
        : windowCount <= 0
          ? 0
          : windowCount < available
            ? Math.floor(windowCount)
            : available

    if (n === 0) {
      return {
        sampleCount: 0,
        writeCursor: cursor,
        droppedCount,
        avgFrameMs: 0,
        minFrameMs: 0,
        maxFrameMs: 0,
        p50FrameMs: 0,
        p95FrameMs: 0,
        p99FrameMs: 0,
        avgPhysicsUs: 0,
        maxPhysicsUs: 0,
        under60FpsBudget: true,
      }
    }

    const f32 = this.f32
    const mask = this.mask
    const scratch = this.scratchFrameMs
    const startSeq = cursor - n

    let sumFrameMs = 0
    let sumPhysicsUs = 0
    let maxPhysicsUs = 0

    for (let i = 0; i < n; i++) {
      const base = TELEM_HEADER_WORDS + (((startSeq + i) & mask) << 4)
      const frameMs = f32[base + TELEM_SLOT_FRAME_MS]
      const physicsUs = f32[base + TELEM_SLOT_PHYSICS_US]
      scratch[i] = frameMs
      sumFrameMs += frameMs
      sumPhysicsUs += physicsUs
      if (physicsUs > maxPhysicsUs) {
        maxPhysicsUs = physicsUs
      }
    }

    const sorted = scratch.subarray(0, n)
    sorted.sort()

    const p50Idx = Math.min(n - 1, Math.max(0, Math.ceil(0.5 * n) - 1))
    const p95Idx = Math.min(n - 1, Math.max(0, Math.ceil(0.95 * n) - 1))
    const p99Idx = Math.min(n - 1, Math.max(0, Math.ceil(0.99 * n) - 1))
    const p95FrameMs = sorted[p95Idx]

    return {
      sampleCount: n,
      writeCursor: cursor,
      droppedCount,
      avgFrameMs: sumFrameMs / n,
      minFrameMs: sorted[0],
      maxFrameMs: sorted[n - 1],
      p50FrameMs: sorted[p50Idx],
      p95FrameMs,
      p99FrameMs: sorted[p99Idx],
      avgPhysicsUs: sumPhysicsUs / n,
      maxPhysicsUs,
      under60FpsBudget: p95FrameMs < TELEM_60FPS_BUDGET_MS,
    }
  }

  private readSlotInto(slotIdx: number, target: TelemetryFrameSample): TelemetryFrameSample {
    const base = TELEM_HEADER_WORDS + (slotIdx << 4)
    const u32 = this.u32
    const f32 = this.f32

    target.frameIndex = u32[base] >>> 0
    target.timestampMs = f32[base + 1]
    target.physicsUs = f32[base + 2]
    target.contacts = u32[base + 3] >>> 0
    target.maxQuatErr = f32[base + 4]
    target.t1Sectors = u32[base + 5] >>> 0
    target.t2Sectors = u32[base + 6] >>> 0
    target.t3Sectors = u32[base + 7] >>> 0
    target.purgeUs = f32[base + 8]
    target.drawCalls = u32[base + 9] >>> 0
    target.triangles = u32[base + 10] >>> 0
    target.frameMs = f32[base + 11]
    target.v8HeapMb = f32[base + 12]
    target.activeSplats = u32[base + 13] >>> 0
    target.cullRatioPct = f32[base + 14]
    target.flags = u32[base + 15] >>> 0

    return target
  }
}
