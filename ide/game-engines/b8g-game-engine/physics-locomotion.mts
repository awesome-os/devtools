/**
 * @file sections/b8g-game-engine/physics-locomotion.mts
 * @description Fixed-Timestep `S^3` Unit-Quaternion Rigid-Body Integrator, Procedural Terrain
 * Heightfield + Slope/Buoyancy Solver, and Zero-GC Runtime Foot-Placement / Weight-Transfer Solver.
 *
 * Invariants:
 *   - `‖q‖ = 1 ± 1e-12` preserved across arbitrary fixed-timestep integrations on `S^3`
 *   - Analytical/central-difference terrain heightfield normals, slope angle, and Archimedes buoyancy
 *   - Zero foot-sliding in stance phase, `leftWeight + rightWeight = 1`, zero per-frame heap allocations
 *
 * Strictly 100% portable: ZERO `node:*` imports, ZERO ambient host globals, `erasableSyntaxOnly: true`.
 */

import type { Vec3 } from './world-streaming.mts'

// ============================================================================
// 1. Unit Quaternion Algebra on S^3 (‖q‖ = 1 ± 1e-12)
// ============================================================================

export class UnitQuaternion {
  public w: number
  public x: number
  public y: number
  public z: number

  public constructor(w: number = 1.0, x: number = 0.0, y: number = 0.0, z: number = 0.0) {
    this.w = w
    this.x = x
    this.y = y
    this.z = z
    this.normalize()
  }

  public norm(): number {
    return Math.hypot(this.w, this.x, this.y, this.z)
  }

  public normError(): number {
    return Math.abs(this.norm() - 1.0)
  }

  public normalize(): this {
    const mag = this.norm()
    if (mag > 1e-15) {
      const inv = 1.0 / mag
      this.w *= inv
      this.x *= inv
      this.y *= inv
      this.z *= inv
    } else {
      this.w = 1.0
      this.x = 0.0
      this.y = 0.0
      this.z = 0.0
    }
    return this
  }

  public conjugate(): UnitQuaternion {
    return new UnitQuaternion(this.w, -this.x, -this.y, -this.z)
  }

  public multiply(other: UnitQuaternion): UnitQuaternion {
    return new UnitQuaternion(
      this.w * other.w - this.x * other.x - this.y * other.y - this.z * other.z,
      this.w * other.x + this.x * other.w + this.y * other.z - this.z * other.y,
      this.w * other.y - this.x * other.z + this.y * other.w + this.z * other.x,
      this.w * other.z + this.x * other.y - this.y * other.x + this.z * other.w
    )
  }

  /**
   * Exact exponential-map integration on S^3 in place (zero allocation):
   *   q(t + dt) = exp(0.5 * ω * dt) * q(t), renormalized to machine precision.
   */
  public integrateAngularVelocityInPlace(wx: number, wy: number, wz: number, dt: number): this {
    const omegaMag = Math.hypot(wx, wy, wz)
    const halfAngle = 0.5 * omegaMag * dt
    let dw = 1.0
    let dx = 0.0
    let dy = 0.0
    let dz = 0.0

    if (omegaMag > 1e-12) {
      const s = Math.sin(halfAngle) / omegaMag
      dw = Math.cos(halfAngle)
      dx = wx * s
      dy = wy * s
      dz = wz * s
    } else {
      dx = 0.5 * wx * dt
      dy = 0.5 * wy * dt
      dz = 0.5 * wz * dt
    }

    const nw = dw * this.w - dx * this.x - dy * this.y - dz * this.z
    const nx = dw * this.x + dx * this.w + dy * this.z - dz * this.y
    const ny = dw * this.y - dx * this.z + dy * this.w + dz * this.x
    const nz = dw * this.z + dx * this.y - dy * this.x + dz * this.w

    const mag = Math.hypot(nw, nx, ny, nz)
    const inv = mag > 1e-15 ? 1.0 / mag : 1.0
    this.w = nw * inv
    this.x = nx * inv
    this.y = ny * inv
    this.z = nz * inv
    return this
  }

  /**
   * Rotates vector `v` by `q * (0, v) * q*` without allocating if `out` is provided.
   */
  public rotateVec3(v: Vec3, out?: Vec3): Vec3 {
    const qx = this.x
    const qy = this.y
    const qz = this.z
    const qw = this.w

    const tx = 2.0 * (qy * v.z - qz * v.y)
    const ty = 2.0 * (qz * v.x - qx * v.z)
    const tz = 2.0 * (qx * v.y - qy * v.x)

    const rx = v.x + qw * tx + (qy * tz - qz * ty)
    const ry = v.y + qw * ty + (qz * tx - qx * tz)
    const rz = v.z + qw * tz + (qx * ty - qy * tx)

    if (out) {
      out.x = rx
      out.y = ry
      out.z = rz
      return out
    }
    return { x: rx, y: ry, z: rz }
  }

  public static fromAxisAngle(ax: number, ay: number, az: number, angleRad: number): UnitQuaternion {
    const mag = Math.hypot(ax, ay, az)
    if (mag <= 1e-15) return new UnitQuaternion(1, 0, 0, 0)
    const half = 0.5 * angleRad
    const s = Math.sin(half) / mag
    return new UnitQuaternion(Math.cos(half), ax * s, ay * s, az * s)
  }
}

// ============================================================================
// 2. Procedural Terrain Heightfield + Slope & Archimedes Buoyancy Solver
// ============================================================================

export interface TerrainSample {
  height: number
  normalX: number
  normalY: number
  normalZ: number
  slopeAngleRad: number
  submergedDepth: number
}

export class ProceduralTerrain {
  public readonly seed: number
  public readonly waterLevel: number
  public readonly amplitude: number
  public readonly frequency: number

  public constructor(
    seed: number = 1337,
    waterLevel: number = 0.0,
    amplitude: number = 12.0,
    frequency: number = 0.035
  ) {
    this.seed = seed | 0
    this.waterLevel = waterLevel
    this.amplitude = amplitude
    this.frequency = frequency
  }

  /**
   * Deterministic multi-octave procedural heightfield (zero allocation).
   */
  public sampleHeight(x: number, z: number): number {
    const p1 = (this.seed & 0xff) * 0.13
    const p2 = ((this.seed >> 8) & 0xff) * 0.29
    const fx = x * this.frequency
    const fz = z * this.frequency

    const h1 = Math.sin(fx + p1) * Math.cos(fz - p2)
    const h2 = 0.5 * Math.sin(fx * 2.13 - fz * 1.47 + p2)
    const h3 = 0.25 * Math.cos(fx * 4.31 + fz * 3.79 - p1)
    return this.amplitude * (h1 + h2 + h3)
  }

  /**
   * Samples height, unit surface normal, slope angle, and water submergence into `out` (zero GC).
   */
  public sampleInto(x: number, z: number, out: TerrainSample, entityY?: number): TerrainSample {
    const eps = 0.25
    const hC = this.sampleHeight(x, z)
    const hL = this.sampleHeight(x - eps, z)
    const hR = this.sampleHeight(x + eps, z)
    const hD = this.sampleHeight(x, z - eps)
    const hU = this.sampleHeight(x, z + eps)

    const dhdx = (hR - hL) / (2.0 * eps)
    const dhdz = (hU - hD) / (2.0 * eps)

    const nx = -dhdx
    const ny = 1.0
    const nz = -dhdz
    const invLen = 1.0 / Math.hypot(nx, ny, nz)

    out.height = hC
    out.normalX = nx * invLen
    out.normalY = ny * invLen
    out.normalZ = nz * invLen
    out.slopeAngleRad = Math.acos(Math.min(1.0, Math.max(-1.0, out.normalY)))
    const probeY = entityY !== undefined ? entityY : hC
    out.submergedDepth = Math.max(0.0, this.waterLevel - probeY)
    return out
  }
}

// ============================================================================
// 3. Fixed-Timestep S^3 Rigid-Body Integrator with Terrain & Buoyancy
// ============================================================================

export interface RigidBodyConfig {
  readonly mass?: number
  readonly radius?: number
  readonly buoyancyVolume?: number
  readonly linearDamping?: number
  readonly angularDamping?: number
  readonly restitution?: number
  readonly friction?: number
}

export class RigidBody {
  public px: number
  public py: number
  public pz: number
  public vx: number
  public vy: number
  public vz: number
  public wx: number
  public wy: number
  public wz: number
  public readonly orientation: UnitQuaternion
  public readonly mass: number
  public readonly invMass: number
  public readonly radius: number
  public readonly buoyancyVolume: number
  public readonly linearDamping: number
  public readonly angularDamping: number
  public readonly restitution: number
  public readonly friction: number
  public grounded: boolean
  public inWater: boolean

  public constructor(x: number, y: number, z: number, cfg?: RigidBodyConfig) {
    this.px = x
    this.py = y
    this.pz = z
    this.vx = 0
    this.vy = 0
    this.vz = 0
    this.wx = 0
    this.wy = 0
    this.wz = 0
    this.orientation = new UnitQuaternion(1, 0, 0, 0)
    this.mass = Math.max(1e-4, cfg?.mass ?? 1.0)
    this.invMass = 1.0 / this.mass
    this.radius = Math.max(0.05, cfg?.radius ?? 0.5)
    this.buoyancyVolume = cfg?.buoyancyVolume ?? 0.0022 // m^3 -> floats in 1000 kg/m^3 water for 1 kg body
    this.linearDamping = cfg?.linearDamping ?? 0.04
    this.angularDamping = cfg?.angularDamping ?? 0.02
    this.restitution = cfg?.restitution ?? 0.2
    this.friction = cfg?.friction ?? 0.65
    this.grounded = false
    this.inWater = false
  }
}

export class RigidBodyWorld {
  public readonly fixedDt: number
  public readonly gravity: number
  public readonly waterDensity: number
  public readonly bodies: RigidBody[]
  private accumulator: number
  private stepCount: number
  private maxObservedNormError: number
  private readonly scratchSample: TerrainSample

  public constructor(fixedDt: number = 1 / 60, gravity: number = 9.81, waterDensity: number = 1000.0) {
    this.fixedDt = fixedDt
    this.gravity = gravity
    this.waterDensity = waterDensity
    this.bodies = []
    this.accumulator = 0
    this.stepCount = 0
    this.maxObservedNormError = 0
    this.scratchSample = {
      height: 0,
      normalX: 0,
      normalY: 1,
      normalZ: 0,
      slopeAngleRad: 0,
      submergedDepth: 0,
    }
  }

  public get stepsExecuted(): number {
    return this.stepCount
  }

  public get maxQuatNormError(): number {
    return this.maxObservedNormError
  }

  public addBody(body: RigidBody): number {
    this.bodies.push(body)
    return this.bodies.length - 1
  }

  /**
   * Advances simulation using fixed-timestep accumulation (`fixedDt`).
   * Returns the number of fixed sub-steps executed.
   */
  public step(frameDt: number, terrain?: ProceduralTerrain): number {
    this.accumulator += Math.max(0, frameDt)
    let subSteps = 0
    const dt = this.fixedDt
    const maxSubSteps = 16

    while (this.accumulator >= dt - 1e-12 && subSteps < maxSubSteps) {
      this.integrateSubStep(dt, terrain)
      this.accumulator = Math.max(0, this.accumulator - dt)
      subSteps += 1
      this.stepCount += 1
    }
    return subSteps
  }

  private integrateSubStep(dt: number, terrain?: ProceduralTerrain): void {
    const n = this.bodies.length
    const sample = this.scratchSample

    for (let i = 0; i < n; i++) {
      const b = this.bodies[i]!

      // 1. Gravity
      let ay = -this.gravity

      // 2. Archimedes buoyancy + hydrodynamic drag when submerged
      b.inWater = false
      if (terrain) {
        const bottomY = b.py - b.radius
        const depth = terrain.waterLevel - bottomY
        if (depth > 0) {
          b.inWater = true
          const submergeFraction = Math.min(1.0, depth / (2.0 * b.radius))
          const buoyantForce = this.waterDensity * this.gravity * b.buoyancyVolume * submergeFraction
          ay += buoyantForce * b.invMass
          // Hydrodynamic linear & angular drag
          const drag = Math.exp(-3.5 * submergeFraction * dt)
          b.vx *= drag
          b.vy *= drag
          b.vz *= drag
          b.wx *= drag
          b.wy *= drag
          b.wz *= drag
        }
      }

      // 3. Semi-implicit Euler linear integration
      const linDamp = Math.exp(-b.linearDamping * dt)
      b.vx = b.vx * linDamp
      b.vy = (b.vy + ay * dt) * linDamp
      b.vz = b.vz * linDamp

      b.px += b.vx * dt
      b.py += b.vy * dt
      b.pz += b.vz * dt

      // 4. Exact S^3 exponential-map quaternion integration
      const angDamp = Math.exp(-b.angularDamping * dt)
      b.wx *= angDamp
      b.wy *= angDamp
      b.wz *= angDamp
      b.orientation.integrateAngularVelocityInPlace(b.wx, b.wy, b.wz, dt)

      const err = b.orientation.normError()
      if (err > this.maxObservedNormError) {
        this.maxObservedNormError = err
      }

      // 5. Terrain heightfield contact & slope friction
      b.grounded = false
      if (terrain) {
        terrain.sampleInto(b.px, b.pz, sample, b.py)
        const minY = sample.height + b.radius
        if (b.py < minY) {
          b.py = minY
          b.grounded = true
          const vn = b.vx * sample.normalX + b.vy * sample.normalY + b.vz * sample.normalZ
          if (vn < 0) {
            const impulse = -(1.0 + b.restitution) * vn
            b.vx += impulse * sample.normalX
            b.vy += impulse * sample.normalY
            b.vz += impulse * sample.normalZ
          }
          // Tangential friction on terrain slope
          const vnAfter = b.vx * sample.normalX + b.vy * sample.normalY + b.vz * sample.normalZ
          const tx = b.vx - vnAfter * sample.normalX
          const ty = b.vy - vnAfter * sample.normalY
          const tz = b.vz - vnAfter * sample.normalZ
          const fric = Math.max(0.0, 1.0 - b.friction * dt * 10.0)
          b.vx = vnAfter * sample.normalX + tx * fric
          b.vy = vnAfter * sample.normalY + ty * fric
          b.vz = vnAfter * sample.normalZ + tz * fric
        }
      }
    }
  }
}

// ============================================================================
// 4. Zero-GC Runtime Foot-Placement & Weight-Transfer Solver (Zero Foot-Sliding)
// ============================================================================

export const FootPhase = {
  Stance: 0,
  Swing: 1,
} as const

export type FootPhaseCode = (typeof FootPhase)[keyof typeof FootPhase]

export interface FootSolverConfig {
  readonly hipHalfWidth?: number
  readonly strideTriggerDist?: number
  readonly stepDuration?: number
  readonly stepLiftHeight?: number
}

/**
 * Zero-GC bipedal foot-placement & weight-transfer solver backed entirely by a single
 * flat `Float64Array` buffer.
 *
 * Slot layout (16 float64s):
 *   [0..2]  left foot current world (x, y, z)
 *   [3..5]  right foot current world (x, y, z)
 *   [6..8]  swing start world (x, y, z)
 *   [9..11] swing target world (x, y, z)
 *   [12]    left weight  (0..1)
 *   [13]    right weight (0..1), invariant: leftWeight + rightWeight === 1
 *   [14]    active swing progress (0..1)
 *   [15]    max observed stance-phase foot slide distance (invariant: 0)
 */
export class FootPlacementSolver {
  public readonly state: Float64Array
  public leftPhase: FootPhaseCode
  public rightPhase: FootPhaseCode
  private readonly hipHalfWidth: number
  private readonly strideTriggerDist: number
  private readonly stepDuration: number
  private readonly stepLiftHeight: number
  private readonly scratchSample: TerrainSample

  public constructor(
    initialPelvisX: number,
    initialPelvisZ: number,
    terrain: ProceduralTerrain,
    cfg?: FootSolverConfig
  ) {
    this.hipHalfWidth = cfg?.hipHalfWidth ?? 0.22
    this.strideTriggerDist = cfg?.strideTriggerDist ?? 0.65
    this.stepDuration = Math.max(0.05, cfg?.stepDuration ?? 0.24)
    this.stepLiftHeight = cfg?.stepLiftHeight ?? 0.18
    this.state = new Float64Array(16)
    this.leftPhase = FootPhase.Stance
    this.rightPhase = FootPhase.Stance
    this.scratchSample = {
      height: 0,
      normalX: 0,
      normalY: 1,
      normalZ: 0,
      slopeAngleRad: 0,
      submergedDepth: 0,
    }

    const lx = initialPelvisX - this.hipHalfWidth
    const rx = initialPelvisX + this.hipHalfWidth
    this.state[0] = lx
    this.state[1] = terrain.sampleHeight(lx, initialPelvisZ)
    this.state[2] = initialPelvisZ
    this.state[3] = rx
    this.state[4] = terrain.sampleHeight(rx, initialPelvisZ)
    this.state[5] = initialPelvisZ
    this.state[12] = 0.5
    this.state[13] = 0.5
    this.state[14] = 0.0
    this.state[15] = 0.0
  }

  public get leftWeight(): number {
    return this.state[12]!
  }

  public get rightWeight(): number {
    return this.state[13]!
  }

  public get maxStanceSlide(): number {
    return this.state[15]!
  }

  /**
   * Updates bipedal foot placement & weight transfer in place with zero heap allocations.
   * Stance feet remain strictly anchored to their planted world coordinates (zero foot-sliding).
   */
  public update(
    pelvisX: number,
    pelvisZ: number,
    pelvisVx: number,
    pelvisVz: number,
    yawRad: number,
    terrain: ProceduralTerrain,
    dt: number
  ): void {
    const s = this.state
    const rightDirX = Math.cos(yawRad)
    const rightDirZ = -Math.sin(yawRad)

    // Ideal rest positions under pelvis + small velocity lead
    const lead = 0.15
    const idealLx = pelvisX - rightDirX * this.hipHalfWidth + pelvisVx * lead
    const idealLz = pelvisZ - rightDirZ * this.hipHalfWidth + pelvisVz * lead
    const idealRx = pelvisX + rightDirX * this.hipHalfWidth + pelvisVx * lead
    const idealRz = pelvisZ + rightDirZ * this.hipHalfWidth + pelvisVz * lead

    // Record stance-foot anchors before update to guarantee zero foot-sliding
    const prevLx = s[0]!
    const prevLz = s[2]!
    const prevRx = s[3]!
    const prevRz = s[5]!

    // If neither foot is swinging, check which foot exceeds stride trigger
    if (this.leftPhase === FootPhase.Stance && this.rightPhase === FootPhase.Stance) {
      const distL = Math.hypot(idealLx - s[0]!, idealLz - s[2]!)
      const distR = Math.hypot(idealRx - s[3]!, idealRz - s[5]!)

      if (distL > this.strideTriggerDist && distL >= distR) {
        this.leftPhase = FootPhase.Swing
        s[6] = s[0]!
        s[7] = s[1]!
        s[8] = s[2]!
        s[9] = idealLx
        s[10] = terrain.sampleHeight(idealLx, idealLz)
        s[11] = idealLz
        s[14] = 0.0
      } else if (distR > this.strideTriggerDist) {
        this.rightPhase = FootPhase.Swing
        s[6] = s[3]!
        s[7] = s[4]!
        s[8] = s[5]!
        s[9] = idealRx
        s[10] = terrain.sampleHeight(idealRx, idealRz)
        s[11] = idealRz
        s[14] = 0.0
      }
    }

    // Advance active swing foot along smooth parabolic arc over terrain
    if (this.leftPhase === FootPhase.Swing) {
      const p = Math.min(1.0, s[14]! + dt / this.stepDuration)
      s[14] = p
      const smooth = p * p * (3.0 - 2.0 * p)
      const x = s[6]! + (s[9]! - s[6]!) * smooth
      const z = s[8]! + (s[11]! - s[8]!) * smooth
      const groundY = terrain.sampleHeight(x, z)
      const baseY = s[7]! + (s[10]! - s[7]!) * smooth
      const arcY = 4.0 * p * (1.0 - p) * this.stepLiftHeight
      s[0] = x
      s[1] = Math.max(groundY, baseY) + arcY
      s[2] = z

      // Transfer weight smoothly to planted right foot during left swing
      const rightW = 0.5 + 0.5 * Math.sin(p * Math.PI)
      s[13] = rightW
      s[12] = 1.0 - rightW

      if (p >= 1.0) {
        this.leftPhase = FootPhase.Stance
        s[0] = s[9]!
        s[1] = terrain.sampleHeight(s[9]!, s[11]!)
        s[2] = s[11]!
        s[12] = 0.5
        s[13] = 0.5
        s[14] = 0.0
      }
      // Verify planted right foot did not slide
      const slideR = Math.hypot(s[3]! - prevRx, s[5]! - prevRz)
      if (slideR > s[15]!) s[15] = slideR
    } else if (this.rightPhase === FootPhase.Swing) {
      const p = Math.min(1.0, s[14]! + dt / this.stepDuration)
      s[14] = p
      const smooth = p * p * (3.0 - 2.0 * p)
      const x = s[6]! + (s[9]! - s[6]!) * smooth
      const z = s[8]! + (s[11]! - s[8]!) * smooth
      const groundY = terrain.sampleHeight(x, z)
      const baseY = s[7]! + (s[10]! - s[7]!) * smooth
      const arcY = 4.0 * p * (1.0 - p) * this.stepLiftHeight
      s[3] = x
      s[4] = Math.max(groundY, baseY) + arcY
      s[5] = z

      // Transfer weight smoothly to planted left foot during right swing
      const leftW = 0.5 + 0.5 * Math.sin(p * Math.PI)
      s[12] = leftW
      s[13] = 1.0 - leftW

      if (p >= 1.0) {
        this.rightPhase = FootPhase.Stance
        s[3] = s[9]!
        s[4] = terrain.sampleHeight(s[9]!, s[11]!)
        s[5] = s[11]!
        s[12] = 0.5
        s[13] = 0.5
        s[14] = 0.0
      }
      // Verify planted left foot did not slide
      const slideL = Math.hypot(s[0]! - prevLx, s[2]! - prevLz)
      if (slideL > s[15]!) s[15] = slideL
    } else {
      // Double stance: compute smooth lateral weight distribution without moving feet
      terrain.sampleInto(pelvisX, pelvisZ, this.scratchSample)
      const dl = Math.hypot(pelvisX - s[0]!, pelvisZ - s[2]!)
      const dr = Math.hypot(pelvisX - s[3]!, pelvisZ - s[5]!)
      const denom = dl + dr
      if (denom > 1e-9) {
        const lw = dr / denom
        s[12] = lw
        s[13] = 1.0 - lw
      } else {
        s[12] = 0.5
        s[13] = 0.5
      }
    }
  }
}
