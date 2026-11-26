/**
 * @file sections/b8g-game-engine/spatial-audio.mts
 * @description Zero-Dependency, 100% Portable 3D Spatial Audio & Physical Doppler Engine.
 *
 * Capabilities:
 *   1. `SpatialAudioEngine` computing per-emitter 3D acoustic parameters relative to a moving
 *      `AudioListener` (position, forward, up, velocity):
 *      - Inverse-distance clamped gain rolloff (`refDistance`, `maxDistance`, `rolloffFactor`).
 *      - Stereo azimuth panning in `[-1, +1]` via orthonormal listener right-vector dot product,
 *        plus full spherical `(azimuthRad, elevationRad)` for HRTF/binaural backends.
 *      - Exact physical Doppler pitch shift:
 *        `f_obs = f_src * (c + v_listener_rel) / (c + v_emitter_rel)`, `c = 343 m/s`,
 *        with supersonic/singularity safety clamping.
 *   2. Zero-GC Structure-of-Arrays (`SpatialAudioBatchBuffer`) batch evaluation for hundreds
 *      of simultaneous emitters with zero per-frame heap allocations.
 *   3. Capability-injected `SpatialAudioHostPort` scalar ABI so Web Audio (`PannerNode`/HRTF)
 *      or native C11 audio backends plug in with zero ambient globals.
 *
 * Strictly 100% portable: ZERO `node:*` imports, ZERO ambient host globals, `erasableSyntaxOnly: true`.
 */

import type { Vec3 } from './world-streaming.mts'

// ============================================================================
// 1. Acoustic Constants & Data Contracts
// ============================================================================

/** Standard speed of sound in dry air at 20 °C (meters per second). */
export const SPEED_OF_SOUND_MPS = 343.0

export const DEFAULT_MIN_DOPPLER_RATIO = 0.25
export const DEFAULT_MAX_DOPPLER_RATIO = 4.0
export const DEFAULT_REF_DISTANCE = 1.0
export const DEFAULT_MAX_DISTANCE = 100.0
export const DEFAULT_ROLLOFF_FACTOR = 1.0
export const DEFAULT_BASE_FREQUENCY_HZ = 440.0

export interface AudioListener {
  position: Vec3
  forward: Vec3
  up: Vec3
  velocity: Vec3
}

export interface SpatialAudioEmitter {
  /** Numeric handle for zero-GC host port dispatch. */
  id: number
  /** Optional logical sound asset identifier (e.g. `audio/engine_loop.ogg`). */
  soundId?: string
  position: Vec3
  velocity: Vec3
  /** Linear source gain at or within `refDistance` (default `1.0`). */
  baseGain?: number
  /** Distance at which attenuation begins (default `1.0` m). */
  refDistance?: number
  /** Maximum distance at which attenuation clamps (default `100.0` m). */
  maxDistance?: number
  /** Inverse-distance rolloff exponent/factor (default `1.0`). */
  rolloffFactor?: number
  /** Source carrier frequency in Hz for `observedFrequencyHz` reporting (default `440.0`). */
  baseFrequencyHz?: number
  /** Whether the emitter is active during batch evaluation (default `true`). */
  active?: boolean
}

export interface SpatialAudioFrame {
  emitterId: number
  distance: number
  gain: number
  /** Stereo azimuth pan in `[-1, +1]` (`-1` = full left, `0` = center, `+1` = full right). */
  pan: number
  /** Physical Doppler pitch multiplier `f_obs / f_src` (clamped safely). */
  dopplerRatio: number
  /** Shifted frequency in Hz (`baseFrequencyHz * dopplerRatio`). */
  observedFrequencyHz: number
  /** Listener-relative horizontal azimuth angle in radians (`[-π, +π]`, `0` = dead ahead). */
  azimuthRad: number
  /** Listener-relative vertical elevation angle in radians (`[-π/2, +π/2]`). */
  elevationRad: number
}

export interface SpatialAudioConfig {
  /** Speed of sound `c` in m/s (default `343.0`). */
  speedOfSound?: number
  /** Global Doppler scaling factor (default `1.0`; `0.0` disables Doppler shift). */
  dopplerFactor?: number
  /** Minimum clamped Doppler ratio (default `0.25`). */
  minDopplerRatio?: number
  /** Maximum clamped Doppler ratio (default `4.0`). */
  maxDopplerRatio?: number
  /** Default reference distance when emitter omits `refDistance` (default `1.0`). */
  defaultRefDistance?: number
  /** Default max distance when emitter omits `maxDistance` (default `100.0`). */
  defaultMaxDistance?: number
  /** Default rolloff factor when emitter omits `rolloffFactor` (default `1.0`). */
  defaultRolloffFactor?: number
  /** Pre-allocated batch capacity for zero-GC evaluation (default `256`). */
  initialBatchCapacity?: number
}

/**
 * Capability-injected host audio port (Web Audio `PannerNode`/HRTF, native C11 audio, or test double).
 * Uses a flat scalar ABI so host synchronization incurs zero per-frame object allocations.
 */
export interface SpatialAudioHostPort {
  setListenerPose(
    posX: number,
    posY: number,
    posZ: number,
    fwdX: number,
    fwdY: number,
    fwdZ: number,
    upX: number,
    upY: number,
    upZ: number,
    velX: number,
    velY: number,
    velZ: number
  ): void

  updateEmitter(
    emitterId: number,
    posX: number,
    posY: number,
    posZ: number,
    velX: number,
    velY: number,
    velZ: number,
    gain: number,
    pan: number,
    dopplerRatio: number,
    distance: number,
    azimuthRad: number,
    elevationRad: number
  ): void

  onEmitterAdded?(emitterId: number, soundId: string): void
  onEmitterRemoved?(emitterId: number): void
  commitFrame?(activeCount: number): void
}

// ============================================================================
// 2. Zero-GC Structure-of-Arrays Batch Buffer
// ============================================================================

/**
 * Pre-allocated Structure-of-Arrays output buffer for zero-GC batch evaluation.
 * All typed arrays are allocated once at construction (or explicit `ensureCapacity`).
 */
export class SpatialAudioBatchBuffer {
  public capacity: number
  public count: number
  public emitterIds: Uint32Array
  public distances: Float64Array
  public gains: Float64Array
  public pans: Float64Array
  public dopplerRatios: Float64Array
  public observedFrequencies: Float64Array
  public azimuths: Float64Array
  public elevations: Float64Array

  public constructor(capacity: number = 256) {
    const cap = Math.max(1, Math.trunc(capacity))
    this.capacity = cap
    this.count = 0
    this.emitterIds = new Uint32Array(cap)
    this.distances = new Float64Array(cap)
    this.gains = new Float64Array(cap)
    this.pans = new Float64Array(cap)
    this.dopplerRatios = new Float64Array(cap)
    this.observedFrequencies = new Float64Array(cap)
    this.azimuths = new Float64Array(cap)
    this.elevations = new Float64Array(cap)
  }

  public ensureCapacity(required: number): void {
    if (required <= this.capacity) return
    let nextCap = this.capacity
    while (nextCap < required) {
      nextCap *= 2
    }
    this.capacity = nextCap
    this.emitterIds = new Uint32Array(nextCap)
    this.distances = new Float64Array(nextCap)
    this.gains = new Float64Array(nextCap)
    this.pans = new Float64Array(nextCap)
    this.dopplerRatios = new Float64Array(nextCap)
    this.observedFrequencies = new Float64Array(nextCap)
    this.azimuths = new Float64Array(nextCap)
    this.elevations = new Float64Array(nextCap)
  }

  /**
   * Copies slot `index` into a caller-provided `SpatialAudioFrame` (zero allocation when `out` is passed).
   */
  public readFrame(index: number, out?: SpatialAudioFrame): SpatialAudioFrame {
    const target: SpatialAudioFrame = out ?? {
      emitterId: 0,
      distance: 0,
      gain: 0,
      pan: 0,
      dopplerRatio: 1,
      observedFrequencyHz: DEFAULT_BASE_FREQUENCY_HZ,
      azimuthRad: 0,
      elevationRad: 0,
    }
    target.emitterId = this.emitterIds[index] ?? 0
    target.distance = this.distances[index] ?? 0
    target.gain = this.gains[index] ?? 0
    target.pan = this.pans[index] ?? 0
    target.dopplerRatio = this.dopplerRatios[index] ?? 1
    target.observedFrequencyHz = this.observedFrequencies[index] ?? DEFAULT_BASE_FREQUENCY_HZ
    target.azimuthRad = this.azimuths[index] ?? 0
    target.elevationRad = this.elevations[index] ?? 0
    return target
  }
}

// ============================================================================
// 3. Pure Scalar Acoustic Helpers (Zero Allocation)
// ============================================================================

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Inverse-distance clamped gain attenuation:
 *   `d_c = clamp(distance, refDistance, maxDistance)`
 *   `attenuation = refDistance / (refDistance + rolloffFactor * (d_c - refDistance))`
 */
export function computeInverseDistanceGain(
  distance: number,
  refDistance: number = DEFAULT_REF_DISTANCE,
  maxDistance: number = DEFAULT_MAX_DISTANCE,
  rolloffFactor: number = DEFAULT_ROLLOFF_FACTOR,
  baseGain: number = 1.0
): number {
  const safeBase = baseGain > 0 ? baseGain : 0
  if (safeBase === 0) return 0
  const safeRef = refDistance > 1e-6 ? refDistance : 1e-6
  const safeMax = maxDistance >= safeRef ? maxDistance : safeRef
  const safeRolloff = rolloffFactor >= 0 ? rolloffFactor : 0
  const dClamped = clamp(distance >= 0 ? distance : 0, safeRef, safeMax)
  const denom = safeRef + safeRolloff * (dClamped - safeRef)
  return denom > 1e-12 ? safeBase * (safeRef / denom) : safeBase
}

/**
 * Exact physical classical Doppler pitch ratio:
 *   `f_obs / f_src = (c + dopplerFactor * v_listener_rel) / (c + dopplerFactor * v_emitter_rel)`
 *
 * Sign convention along unit line-of-sight vector `u = (emitterPos - listenerPos) / distance`:
 *   - `v_listener_rel = dot(listenerVel, u)` (> 0 when listener moves TOWARD emitter -> pitch rises)
 *   - `v_emitter_rel  = dot(emitterVel,  u)` (> 0 when emitter moves AWAY from listener -> pitch drops)
 *
 * Clamped safely against supersonic singularities (`c + v <= 0`) and bounded to `[minRatio, maxRatio]`.
 */
export function computeDopplerRatio(
  vListenerRel: number,
  vEmitterRel: number,
  speedOfSound: number = SPEED_OF_SOUND_MPS,
  dopplerFactor: number = 1.0,
  minRatio: number = DEFAULT_MIN_DOPPLER_RATIO,
  maxRatio: number = DEFAULT_MAX_DOPPLER_RATIO
): number {
  const c = speedOfSound > 1e-3 ? speedOfSound : SPEED_OF_SOUND_MPS
  const factor = dopplerFactor >= 0 ? dopplerFactor : 0
  if (factor === 0) return 1.0

  // Prevent supersonic denominator collapse or negative numerator frequency inversion
  const minWaveSpeed = c * 0.05
  const numerator = Math.max(minWaveSpeed, c + factor * vListenerRel)
  const denominator = Math.max(minWaveSpeed, c + factor * vEmitterRel)
  return clamp(numerator / denominator, minRatio, maxRatio)
}

// ============================================================================
// 4. SpatialAudioEngine
// ============================================================================

export class SpatialAudioEngine {
  public readonly speedOfSound: number
  public readonly dopplerFactor: number
  public readonly minDopplerRatio: number
  public readonly maxDopplerRatio: number
  public readonly defaultRefDistance: number
  public readonly defaultMaxDistance: number
  public readonly defaultRolloffFactor: number

  private readonly listenerPos: Vec3 = { x: 0, y: 0, z: 0 }
  private readonly listenerVel: Vec3 = { x: 0, y: 0, z: 0 }
  /** Orthonormalized listener basis vectors (computed once per listener update). */
  private fwdX = 0.0
  private fwdY = 0.0
  private fwdZ = -1.0
  private upX = 0.0
  private upY = 1.0
  private upZ = 0.0
  private rightX = 1.0
  private rightY = 0.0
  private rightZ = 0.0

  private readonly emitters: SpatialAudioEmitter[] = []
  private readonly emitterIndexById: Map<number, number> = new Map()
  private readonly batchBuffer: SpatialAudioBatchBuffer
  private hostPort: SpatialAudioHostPort | null

  public constructor(config: SpatialAudioConfig = {}, hostPort: SpatialAudioHostPort | null = null) {
    this.speedOfSound =
      config.speedOfSound != null && config.speedOfSound > 1e-3
        ? config.speedOfSound
        : SPEED_OF_SOUND_MPS
    this.dopplerFactor =
      config.dopplerFactor != null && config.dopplerFactor >= 0 ? config.dopplerFactor : 1.0
    this.minDopplerRatio =
      config.minDopplerRatio != null && config.minDopplerRatio > 0
        ? config.minDopplerRatio
        : DEFAULT_MIN_DOPPLER_RATIO
    this.maxDopplerRatio =
      config.maxDopplerRatio != null && config.maxDopplerRatio >= this.minDopplerRatio
        ? config.maxDopplerRatio
        : DEFAULT_MAX_DOPPLER_RATIO
    this.defaultRefDistance =
      config.defaultRefDistance != null && config.defaultRefDistance > 1e-6
        ? config.defaultRefDistance
        : DEFAULT_REF_DISTANCE
    this.defaultMaxDistance =
      config.defaultMaxDistance != null && config.defaultMaxDistance >= this.defaultRefDistance
        ? config.defaultMaxDistance
        : DEFAULT_MAX_DISTANCE
    this.defaultRolloffFactor =
      config.defaultRolloffFactor != null && config.defaultRolloffFactor >= 0
        ? config.defaultRolloffFactor
        : DEFAULT_ROLLOFF_FACTOR

    this.batchBuffer = new SpatialAudioBatchBuffer(config.initialBatchCapacity ?? 256)
    this.hostPort = hostPort
  }

  public setHostPort(hostPort: SpatialAudioHostPort | null): void {
    this.hostPort = hostPort
  }

  public get emitterCount(): number {
    return this.emitters.length
  }

  public getBatchBuffer(): SpatialAudioBatchBuffer {
    return this.batchBuffer
  }

  /**
   * Updates listener pose and velocity, orthonormalizing `(forward, up, right)` in place with zero allocations.
   * Uses right-handed convention: `right = normalize(forward × up)`, `orthoUp = right × forward`.
   */
  public setListener(listener: AudioListener): void {
    this.listenerPos.x = listener.position.x
    this.listenerPos.y = listener.position.y
    this.listenerPos.z = listener.position.z
    this.listenerVel.x = listener.velocity.x
    this.listenerVel.y = listener.velocity.y
    this.listenerVel.z = listener.velocity.z

    let fx = listener.forward.x
    let fy = listener.forward.y
    let fz = listener.forward.z
    const fLen = Math.hypot(fx, fy, fz)
    if (fLen > 1e-12) {
      const invF = 1.0 / fLen
      fx *= invF
      fy *= invF
      fz *= invF
    } else {
      fx = 0.0
      fy = 0.0
      fz = -1.0
    }

    let ux = listener.up.x
    let uy = listener.up.y
    let uz = listener.up.z
    const uLen = Math.hypot(ux, uy, uz)
    if (uLen > 1e-12) {
      const invU = 1.0 / uLen
      ux *= invU
      uy *= invU
      uz *= invU
    } else {
      ux = 0.0
      uy = 1.0
      uz = 0.0
    }

    // right = forward × up
    let rx = fy * uz - fz * uy
    let ry = fz * ux - fx * uz
    let rz = fx * uy - fy * ux
    let rLen = Math.hypot(rx, ry, rz)

    // Guard against collinear forward & up vectors
    if (rLen <= 1e-9) {
      const altX = Math.abs(fy) < 0.9 ? 0.0 : 1.0
      const altY = Math.abs(fy) < 0.9 ? 1.0 : 0.0
      const altZ = 0.0
      rx = fy * altZ - fz * altY
      ry = fz * altX - fx * altZ
      rz = fx * altY - fy * altX
      rLen = Math.hypot(rx, ry, rz)
    }

    const invR = rLen > 1e-12 ? 1.0 / rLen : 1.0
    rx *= invR
    ry *= invR
    rz *= invR

    // Re-orthogonalize up = right × forward
    const oux = ry * fz - rz * fy
    const ouy = rz * fx - rx * fz
    const ouz = rx * fy - ry * fx

    this.fwdX = fx
    this.fwdY = fy
    this.fwdZ = fz
    this.rightX = rx
    this.rightY = ry
    this.rightZ = rz
    this.upX = oux
    this.upY = ouy
    this.upZ = ouz
  }

  /**
   * Writes the current orthonormalized listener right vector into `out` (zero allocation when `out` is provided).
   */
  public getListenerRight(out?: Vec3): Vec3 {
    if (out) {
      out.x = this.rightX
      out.y = this.rightY
      out.z = this.rightZ
      return out
    }
    return { x: this.rightX, y: this.rightY, z: this.rightZ }
  }

  public addEmitter(emitter: SpatialAudioEmitter): void {
    const existingIdx = this.emitterIndexById.get(emitter.id)
    if (existingIdx !== undefined) {
      this.emitters[existingIdx] = emitter
      return
    }
    const idx = this.emitters.length
    this.emitters.push(emitter)
    this.emitterIndexById.set(emitter.id, idx)
    this.batchBuffer.ensureCapacity(this.emitters.length)
    if (this.hostPort?.onEmitterAdded) {
      this.hostPort.onEmitterAdded(emitter.id, emitter.soundId ?? '')
    }
  }

  /**
   * Removes an emitter by ID in O(1) swap-and-pop time.
   */
  public removeEmitter(emitterId: number): boolean {
    const idx = this.emitterIndexById.get(emitterId)
    if (idx === undefined) return false
    const lastIdx = this.emitters.length - 1
    if (idx !== lastIdx) {
      const moved = this.emitters[lastIdx]
      if (moved !== undefined) {
        this.emitters[idx] = moved
        this.emitterIndexById.set(moved.id, idx)
      }
    }
    this.emitters.pop()
    this.emitterIndexById.delete(emitterId)
    if (this.hostPort?.onEmitterRemoved) {
      this.hostPort.onEmitterRemoved(emitterId)
    }
    return true
  }

  public getEmitter(emitterId: number): SpatialAudioEmitter | undefined {
    const idx = this.emitterIndexById.get(emitterId)
    return idx !== undefined ? this.emitters[idx] : undefined
  }

  /**
   * Evaluates a single emitter against the current listener pose & velocity.
   * Zero heap allocations when a caller-supplied `out` object is provided.
   */
  public evaluateEmitter(emitter: SpatialAudioEmitter, out?: SpatialAudioFrame): SpatialAudioFrame {
    const target: SpatialAudioFrame = out ?? {
      emitterId: 0,
      distance: 0,
      gain: 0,
      pan: 0,
      dopplerRatio: 1,
      observedFrequencyHz: DEFAULT_BASE_FREQUENCY_HZ,
      azimuthRad: 0,
      elevationRad: 0,
    }

    const dx = emitter.position.x - this.listenerPos.x
    const dy = emitter.position.y - this.listenerPos.y
    const dz = emitter.position.z - this.listenerPos.z
    const distance = Math.hypot(dx, dy, dz)

    const baseGain = emitter.baseGain ?? 1.0
    const refDist = emitter.refDistance ?? this.defaultRefDistance
    const maxDist = emitter.maxDistance ?? this.defaultMaxDistance
    const rolloff = emitter.rolloffFactor ?? this.defaultRolloffFactor
    const baseFreq = emitter.baseFrequencyHz ?? DEFAULT_BASE_FREQUENCY_HZ

    const gain = computeInverseDistanceGain(distance, refDist, maxDist, rolloff, baseGain)

    let pan = 0.0
    let dopplerRatio = 1.0
    let azimuthRad = 0.0
    let elevationRad = 0.0

    if (distance > 1e-9) {
      const invDist = 1.0 / distance
      const ux = dx * invDist
      const uy = dy * invDist
      const uz = dz * invDist

      // Stereo azimuth pan via listener right-vector dot product
      const dotRight = ux * this.rightX + uy * this.rightY + uz * this.rightZ
      const dotFwd = ux * this.fwdX + uy * this.fwdY + uz * this.fwdZ
      const dotUp = ux * this.upX + uy * this.upY + uz * this.upZ

      pan = clamp(dotRight, -1.0, 1.0)
      azimuthRad = Math.atan2(dotRight, dotFwd)
      elevationRad = Math.asin(clamp(dotUp, -1.0, 1.0))

      // Exact physical Doppler shift along line-of-sight vector u = (emitter - listener) / |d|
      const vListenerRel =
        this.listenerVel.x * ux + this.listenerVel.y * uy + this.listenerVel.z * uz
      const vEmitterRel =
        emitter.velocity.x * ux + emitter.velocity.y * uy + emitter.velocity.z * uz

      dopplerRatio = computeDopplerRatio(
        vListenerRel,
        vEmitterRel,
        this.speedOfSound,
        this.dopplerFactor,
        this.minDopplerRatio,
        this.maxDopplerRatio
      )
    }

    target.emitterId = emitter.id
    target.distance = distance
    target.gain = gain
    target.pan = pan
    target.dopplerRatio = dopplerRatio
    target.observedFrequencyHz = baseFreq * dopplerRatio
    target.azimuthRad = azimuthRad
    target.elevationRad = elevationRad
    return target
  }

  /**
   * Zero-GC batch evaluation of an emitter slice into a pre-allocated `SpatialAudioBatchBuffer`.
   * Performs ZERO heap allocations as long as `outBuffer.capacity >= count`.
   */
  public evaluateBatch(
    emitters: readonly SpatialAudioEmitter[],
    count: number = emitters.length,
    outBuffer: SpatialAudioBatchBuffer = this.batchBuffer
  ): SpatialAudioBatchBuffer {
    const n = Math.min(count, emitters.length)
    outBuffer.ensureCapacity(n)

    const lpx = this.listenerPos.x
    const lpy = this.listenerPos.y
    const lpz = this.listenerPos.z
    const lvx = this.listenerVel.x
    const lvy = this.listenerVel.y
    const lvz = this.listenerVel.z

    const rx = this.rightX
    const ry = this.rightY
    const rz = this.rightZ
    const fx = this.fwdX
    const fy = this.fwdY
    const fz = this.fwdZ
    const oux = this.upX
    const ouy = this.upY
    const ouz = this.upZ

    const c = this.speedOfSound
    const dFactor = this.dopplerFactor
    const minRatio = this.minDopplerRatio
    const maxRatio = this.maxDopplerRatio
    const minWaveSpeed = c * 0.05

    const defRef = this.defaultRefDistance
    const defMax = this.defaultMaxDistance
    const defRolloff = this.defaultRolloffFactor

    const ids = outBuffer.emitterIds
    const dists = outBuffer.distances
    const gains = outBuffer.gains
    const pans = outBuffer.pans
    const dopplers = outBuffer.dopplerRatios
    const freqs = outBuffer.observedFrequencies
    const azimuths = outBuffer.azimuths
    const elevations = outBuffer.elevations

    let outIdx = 0
    for (let i = 0; i < n; i++) {
      const em = emitters[i]
      if (em === undefined || em.active === false) continue

      const dx = em.position.x - lpx
      const dy = em.position.y - lpy
      const dz = em.position.z - lpz
      const distance = Math.hypot(dx, dy, dz)

      const baseGain = em.baseGain ?? 1.0
      const refDist = em.refDistance ?? defRef
      const maxDist = em.maxDistance ?? defMax
      const rolloff = em.rolloffFactor ?? defRolloff
      const baseFreq = em.baseFrequencyHz ?? DEFAULT_BASE_FREQUENCY_HZ

      // Inline inverse-distance clamped rolloff
      let gain = 0.0
      if (baseGain > 0) {
        const safeRef = refDist > 1e-6 ? refDist : 1e-6
        const safeMax = maxDist >= safeRef ? maxDist : safeRef
        const safeRolloff = rolloff >= 0 ? rolloff : 0
        const dClamped = distance < safeRef ? safeRef : distance > safeMax ? safeMax : distance
        const denom = safeRef + safeRolloff * (dClamped - safeRef)
        gain = denom > 1e-12 ? baseGain * (safeRef / denom) : baseGain
      }

      let pan = 0.0
      let dopplerRatio = 1.0
      let azimuthRad = 0.0
      let elevationRad = 0.0

      if (distance > 1e-9) {
        const invDist = 1.0 / distance
        const ux = dx * invDist
        const uy = dy * invDist
        const uz = dz * invDist

        const dotRight = ux * rx + uy * ry + uz * rz
        const dotFwd = ux * fx + uy * fy + uz * fz
        const dotUp = ux * oux + uy * ouy + uz * ouz

        pan = dotRight < -1.0 ? -1.0 : dotRight > 1.0 ? 1.0 : dotRight
        azimuthRad = Math.atan2(dotRight, dotFwd)
        const clampedUp = dotUp < -1.0 ? -1.0 : dotUp > 1.0 ? 1.0 : dotUp
        elevationRad = Math.asin(clampedUp)

        if (dFactor > 0) {
          const vListenerRel = lvx * ux + lvy * uy + lvz * uz
          const vEmitterRel = em.velocity.x * ux + em.velocity.y * uy + em.velocity.z * uz
          const num = c + dFactor * vListenerRel
          const den = c + dFactor * vEmitterRel
          const safeNum = num > minWaveSpeed ? num : minWaveSpeed
          const safeDen = den > minWaveSpeed ? den : minWaveSpeed
          const ratio = safeNum / safeDen
          dopplerRatio = ratio < minRatio ? minRatio : ratio > maxRatio ? maxRatio : ratio
        }
      }

      ids[outIdx] = em.id
      dists[outIdx] = distance
      gains[outIdx] = gain
      pans[outIdx] = pan
      dopplers[outIdx] = dopplerRatio
      freqs[outIdx] = baseFreq * dopplerRatio
      azimuths[outIdx] = azimuthRad
      elevations[outIdx] = elevationRad
      outIdx++
    }

    outBuffer.count = outIdx
    return outBuffer
  }

  /**
   * Evaluates all registered emitters into the internal zero-GC batch buffer and dispatches
   * scalar updates to the capability-injected `SpatialAudioHostPort` (if attached).
   */
  public tick(hostPort: SpatialAudioHostPort | null = this.hostPort): SpatialAudioBatchBuffer {
    const buf = this.evaluateBatch(this.emitters, this.emitters.length, this.batchBuffer)
    if (hostPort !== null) {
      hostPort.setListenerPose(
        this.listenerPos.x,
        this.listenerPos.y,
        this.listenerPos.z,
        this.fwdX,
        this.fwdY,
        this.fwdZ,
        this.upX,
        this.upY,
        this.upZ,
        this.listenerVel.x,
        this.listenerVel.y,
        this.listenerVel.z
      )

      const activeCount = buf.count
      for (let i = 0; i < activeCount; i++) {
        const id = buf.emitterIds[i] ?? 0
        const emIdx = this.emitterIndexById.get(id)
        if (emIdx === undefined) continue
        const em = this.emitters[emIdx]
        if (em === undefined) continue
        hostPort.updateEmitter(
          id,
          em.position.x,
          em.position.y,
          em.position.z,
          em.velocity.x,
          em.velocity.y,
          em.velocity.z,
          buf.gains[i] ?? 0,
          buf.pans[i] ?? 0,
          buf.dopplerRatios[i] ?? 1,
          buf.distances[i] ?? 0,
          buf.azimuths[i] ?? 0,
          buf.elevations[i] ?? 0
        )
      }

      if (hostPort.commitFrame) {
        hostPort.commitFrame(activeCount)
      }
    }
    return buf
  }
}
