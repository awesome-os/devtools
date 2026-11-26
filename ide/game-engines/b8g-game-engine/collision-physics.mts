/**
 * @file sections/b8g-game-engine/collision-physics.mts
 * @description Zero-Dependency 3D Rigid-Body Collision & Raycast Vehicle Physics Engine:
 *   1. Spatial-Hash Broadphase (`BroadphaseGrid`) generating candidate AABB pairs in O(N) expected time.
 *   2. Narrowphase Contact Manifold Generation:
 *      - Sphere-vs-Sphere
 *      - Sphere-vs-GroundPlane / Heightfield (and Box-vs-GroundPlane / Heightfield)
 *      - AABB-vs-AABB (box-box MTV normal & penetration)
 *      - Sphere-vs-AABB
 *   3. Sequential-Impulse Contact Solver:
 *      - Restitution, isotropic Coulomb friction cone, Baumgarte position stabilization,
 *        and full 3D rotational impulse integrated onto `UnitQuaternion` (preserving ‖q‖ = 1 ± 1e-12).
 *   4. 4-Wheel Raycast Vehicle Suspension (`RaycastVehicle`):
 *      - Hooke's law spring + velocity damper + Ackermann/front steering + throttle/brake + lateral tire grip.
 *
 * Strictly 100% portable: ZERO `node:*` imports, ZERO ambient host globals, `erasableSyntaxOnly: true`.
 */

import { UnitQuaternion, ProceduralTerrain, type TerrainSample } from './physics-locomotion.mts'
import type { Vec3 } from './world-streaming.mts'

// ============================================================================
// 1. Collider Shapes, AABB & Spatial-Hash Broadphase (`BroadphaseGrid`)
// ============================================================================

export const ColliderShape = {
  Sphere: 0,
  Box: 1,
} as const

export type ColliderShapeCode = (typeof ColliderShape)[keyof typeof ColliderShape]

export interface AABB {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export interface BroadphasePair {
  readonly a: number
  readonly b: number
}

export function aabbOverlaps(a: AABB, b: AABB): boolean {
  return (
    a.minX <= b.maxX &&
    a.maxX >= b.minX &&
    a.minY <= b.maxY &&
    a.maxY >= b.minY &&
    a.minZ <= b.maxZ &&
    a.maxZ >= b.minZ
  )
}

/**
 * Spatial-Hash Broadphase Grid generating unique candidate overlapping AABB pairs
 * in O(N) expected time with bucket pooling to minimize per-frame GC churn.
 */
export class BroadphaseGrid {
  public readonly cellSize: number
  private readonly invCellSize: number
  private readonly cells: Map<number, number[]>
  private readonly bucketPool: number[][]
  private readonly seenPairs: Set<number>
  private readonly aabbList: AABB[]
  private insertedCount: number

  public constructor(cellSize: number = 2.0) {
    this.cellSize = Math.max(0.1, cellSize)
    this.invCellSize = 1.0 / this.cellSize
    this.cells = new Map()
    this.bucketPool = []
    this.seenPairs = new Set()
    this.aabbList = []
    this.insertedCount = 0
  }

  public get activeCellCount(): number {
    return this.cells.size
  }

  public get bodyCount(): number {
    return this.insertedCount
  }

  /**
   * Resets all occupied hash cells, recycling bucket arrays back to the pool.
   */
  public clear(): void {
    for (const bucket of this.cells.values()) {
      bucket.length = 0
      this.bucketPool.push(bucket)
    }
    this.cells.clear()
    this.seenPairs.clear()
    this.aabbList.length = 0
    this.insertedCount = 0
  }

  /**
   * 3D integer cell coordinate hash (large prime XOR mixing).
   */
  private hashCell(cx: number, cy: number, cz: number): number {
    return ((cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791)) | 0
  }

  /**
   * Inserts a body index and its world-space AABB into all overlapped hash cells.
   */
  public insert(bodyIndex: number, aabb: AABB): void {
    const inv = this.invCellSize
    const minCx = Math.floor(aabb.minX * inv)
    const maxCx = Math.floor(aabb.maxX * inv)
    const minCy = Math.floor(aabb.minY * inv)
    const maxCy = Math.floor(aabb.maxY * inv)
    const minCz = Math.floor(aabb.minZ * inv)
    const maxCz = Math.floor(aabb.maxZ * inv)

    this.aabbList[bodyIndex] = aabb
    this.insertedCount += 1

    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
          const key = this.hashCell(cx, cy, cz)
          let bucket = this.cells.get(key)
          if (bucket === undefined) {
            bucket = this.bucketPool.length > 0 ? this.bucketPool.pop()! : []
            this.cells.set(key, bucket)
          }
          bucket.push(bodyIndex)
        }
      }
    }
  }

  /**
   * Generates all unique candidate pairs `(a, b)` with `a < b` whose AABBs overlap.
   * Exact IEEE-754 pair key supports up to 67,108,864 bodies without collisions.
   */
  public queryCandidatePairs(out?: BroadphasePair[]): BroadphasePair[] {
    const pairs: BroadphasePair[] = out ?? []
    pairs.length = 0
    const seen = this.seenPairs
    seen.clear()
    const aabbs = this.aabbList

    for (const bucket of this.cells.values()) {
      const len = bucket.length
      if (len < 2) continue
      for (let i = 0; i < len; i++) {
        const idxI = bucket[i]!
        const aabbI = aabbs[idxI]!
        for (let j = i + 1; j < len; j++) {
          const idxJ = bucket[j]!
          if (idxI === idxJ) continue
          const a = idxI < idxJ ? idxI : idxJ
          const b = idxI < idxJ ? idxJ : idxI
          const pairKey = a * 67108864 + b
          if (seen.has(pairKey)) continue
          seen.add(pairKey)
          if (aabbOverlaps(aabbI, aabbs[idxJ]!)) {
            pairs.push({ a, b })
          }
        }
      }
    }

    return pairs
  }
}

// ============================================================================
// 2. Rigid Body with 3D Inertia Tensor & S^3 Orientation
// ============================================================================

export interface CollisionBodyConfig {
  readonly shape?: ColliderShapeCode
  readonly radius?: number
  readonly halfExtents?: Vec3
  readonly mass?: number // <= 0 or Infinity creates a static body (invMass = 0)
  readonly isStatic?: boolean
  readonly lockRotation?: boolean
  readonly restitution?: number
  readonly friction?: number
  readonly linearDamping?: number
  readonly angularDamping?: number
}

/**
 * 3D Rigid Body with Sphere or Box (AABB) collider, principal inertia tensor,
 * and `UnitQuaternion` orientation preserving `‖q‖ = 1 ± 1e-12`.
 */
export class CollisionBody {
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

  public readonly shape: ColliderShapeCode
  public readonly radius: number
  public readonly hx: number
  public readonly hy: number
  public readonly hz: number

  public readonly mass: number
  public readonly invMass: number
  public readonly invIx: number
  public readonly invIy: number
  public readonly invIz: number
  public readonly isStatic: boolean
  public readonly lockRotation: boolean

  public restitution: number
  public friction: number
  public linearDamping: number
  public angularDamping: number
  public grounded: boolean
  public readonly aabb: AABB

  public constructor(x: number, y: number, z: number, cfg?: CollisionBodyConfig) {
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

    this.shape = cfg?.shape ?? ColliderShape.Sphere
    this.radius = Math.max(0.02, cfg?.radius ?? 0.5)
    const he = cfg?.halfExtents
    if (this.shape === ColliderShape.Box) {
      this.hx = Math.max(0.02, he?.x ?? 0.5)
      this.hy = Math.max(0.02, he?.y ?? 0.5)
      this.hz = Math.max(0.02, he?.z ?? 0.5)
    } else {
      this.hx = this.radius
      this.hy = this.radius
      this.hz = this.radius
    }

    const rawMass = cfg?.mass ?? 1.0
    this.isStatic = Boolean(cfg?.isStatic) || rawMass <= 0 || !Number.isFinite(rawMass)
    this.lockRotation = Boolean(cfg?.lockRotation) || this.isStatic
    this.mass = this.isStatic ? 0 : rawMass
    this.invMass = this.isStatic ? 0 : 1.0 / rawMass

    if (this.lockRotation || this.isStatic) {
      this.invIx = 0
      this.invIy = 0
      this.invIz = 0
    } else if (this.shape === ColliderShape.Sphere) {
      const inertia = 0.4 * this.mass * this.radius * this.radius
      const invI = inertia > 1e-12 ? 1.0 / inertia : 0
      this.invIx = invI
      this.invIy = invI
      this.invIz = invI
    } else {
      const w2 = (2.0 * this.hx) * (2.0 * this.hx)
      const h2 = (2.0 * this.hy) * (2.0 * this.hy)
      const d2 = (2.0 * this.hz) * (2.0 * this.hz)
      const ix = (this.mass * (h2 + d2)) / 12.0
      const iy = (this.mass * (w2 + d2)) / 12.0
      const iz = (this.mass * (w2 + h2)) / 12.0
      this.invIx = ix > 1e-12 ? 1.0 / ix : 0
      this.invIy = iy > 1e-12 ? 1.0 / iy : 0
      this.invIz = iz > 1e-12 ? 1.0 / iz : 0
    }

    this.restitution = Math.min(1.0, Math.max(0.0, cfg?.restitution ?? 0.2))
    this.friction = Math.max(0.0, cfg?.friction ?? 0.5)
    this.linearDamping = Math.max(0.0, cfg?.linearDamping ?? 0.01)
    this.angularDamping = Math.max(0.0, cfg?.angularDamping ?? 0.02)
    this.grounded = false
    this.aabb = {
      minX: 0,
      minY: 0,
      minZ: 0,
      maxX: 0,
      maxY: 0,
      maxZ: 0,
    }
    this.updateAABB()
  }

  /**
   * Recomputes the world-space AABB in place (zero allocation).
   */
  public updateAABB(): void {
    this.aabb.minX = this.px - this.hx
    this.aabb.minY = this.py - this.hy
    this.aabb.minZ = this.pz - this.hz
    this.aabb.maxX = this.px + this.hx
    this.aabb.maxY = this.py + this.hy
    this.aabb.maxZ = this.pz + this.hz
  }

  /**
   * Computes `I_world^-1 * v` into `out` without allocating:
   *   `out = q * (I_local^-1 * (q* * v))`
   */
  public multiplyInvInertiaWorld(vx: number, vy: number, vz: number, out: Vec3): void {
    if (this.lockRotation || this.isStatic) {
      out.x = 0
      out.y = 0
      out.z = 0
      return
    }
    const qx = this.orientation.x
    const qy = this.orientation.y
    const qz = this.orientation.z
    const qw = this.orientation.w

    // Rotate v into body local frame using conjugate q* = (qw, -qx, -qy, -qz)
    const tx1 = 2.0 * (-qy * vz + qz * vy)
    const ty1 = 2.0 * (-qz * vx + qx * vz)
    const tz1 = 2.0 * (-qx * vy + qy * vx)

    const lx = (vx + qw * tx1 + (-qy * tz1 + qz * ty1)) * this.invIx
    const ly = (vy + qw * ty1 + (-qz * tx1 + qx * tz1)) * this.invIy
    const lz = (vz + qw * tz1 + (-qx * ty1 + qy * tx1)) * this.invIz

    // Rotate scaled vector back to world frame using q
    const tx2 = 2.0 * (qy * lz - qz * ly)
    const ty2 = 2.0 * (qz * lx - qx * lz)
    const tz2 = 2.0 * (qx * ly - qy * lx)

    out.x = lx + qw * tx2 + (qy * tz2 - qz * ty2)
    out.y = ly + qw * ty2 + (qz * tx2 - qx * tz2)
    out.z = lz + qw * tz2 + (qx * ty2 - qy * tx2)
  }

  /**
   * Applies a world-space impulse `(jx, jy, jz)` at world-space lever arm `(rx, ry, rz)` from CoM.
   */
  public applyImpulse(
    jx: number,
    jy: number,
    jz: number,
    rx: number,
    ry: number,
    rz: number,
    scratch: Vec3
  ): void {
    if (this.isStatic) return
    this.vx += jx * this.invMass
    this.vy += jy * this.invMass
    this.vz += jz * this.invMass

    if (!this.lockRotation) {
      // torque impulse = r × J
      const tx = ry * jz - rz * jy
      const ty = rz * jx - rx * jz
      const tz = rx * jy - ry * jx
      this.multiplyInvInertiaWorld(tx, ty, tz, scratch)
      this.wx += scratch.x
      this.wy += scratch.y
      this.wz += scratch.z
    }
  }

  /**
   * Applies a world-space force `(fx, fy, fz)` at world-space point `(wx, wy, wz)` over timestep `dt`.
   */
  public applyForceAtWorldPoint(
    fx: number,
    fy: number,
    fz: number,
    worldX: number,
    worldY: number,
    worldZ: number,
    dt: number,
    scratch: Vec3
  ): void {
    this.applyImpulse(
      fx * dt,
      fy * dt,
      fz * dt,
      worldX - this.px,
      worldY - this.py,
      worldZ - this.pz,
      scratch
    )
  }
}

// ============================================================================
// 3. Narrowphase Contact Manifold Generation
// ============================================================================

/**
 * Contact manifold between `bodyA` and `bodyB` (`bodyB === -1` for static ground/terrain).
 * Convention: unit normal `(nx, ny, nz)` points from `B` toward `A` (direction to separate `A` from `B`).
 */
export interface ContactManifold {
  bodyA: number
  bodyB: number
  nx: number
  ny: number
  nz: number
  penetration: number
  px: number
  py: number
  pz: number
  normalImpulse: number
  tangentImpulse1: number
  tangentImpulse2: number
  initialVn: number
}

export function createContactManifold(): ContactManifold {
  return {
    bodyA: -1,
    bodyB: -1,
    nx: 0,
    ny: 1,
    nz: 0,
    penetration: 0,
    px: 0,
    py: 0,
    pz: 0,
    normalImpulse: 0,
    tangentImpulse1: 0,
    tangentImpulse2: 0,
    initialVn: 0,
  }
}

function resetContact(
  out: ContactManifold,
  bodyA: number,
  bodyB: number,
  nx: number,
  ny: number,
  nz: number,
  penetration: number,
  px: number,
  py: number,
  pz: number
): ContactManifold {
  out.bodyA = bodyA
  out.bodyB = bodyB
  out.nx = nx
  out.ny = ny
  out.nz = nz
  out.penetration = penetration
  out.px = px
  out.py = py
  out.pz = pz
  out.normalImpulse = 0
  out.tangentImpulse1 = 0
  out.tangentImpulse2 = 0
  out.initialVn = 0
  return out
}

/**
 * Narrowphase: Sphere vs Sphere. Normal points from B toward A.
 */
export function collideSphereSphere(
  a: CollisionBody,
  idxA: number,
  b: CollisionBody,
  idxB: number,
  out?: ContactManifold
): ContactManifold | null {
  const dx = a.px - b.px
  const dy = a.py - b.py
  const dz = a.pz - b.pz
  const rSum = a.radius + b.radius
  const distSq = dx * dx + dy * dy + dz * dz
  if (distSq >= rSum * rSum) return null

  const target = out ?? createContactManifold()
  const dist = Math.sqrt(distSq)
  let nx = 0
  let ny = 1
  let nz = 0
  if (dist > 1e-12) {
    const invD = 1.0 / dist
    nx = dx * invD
    ny = dy * invD
    nz = dz * invD
  }
  const penetration = rSum - dist
  const offsetFromB = b.radius - 0.5 * penetration
  return resetContact(
    target,
    idxA,
    idxB,
    nx,
    ny,
    nz,
    penetration,
    b.px + nx * offsetFromB,
    b.py + ny * offsetFromB,
    b.pz + nz * offsetFromB
  )
}

/**
 * Narrowphase: Sphere vs flat horizontal GroundPlane (`y = planeY`).
 */
export function collideSphereGroundPlane(
  a: CollisionBody,
  idxA: number,
  planeY: number = 0.0,
  out?: ContactManifold
): ContactManifold | null {
  const penetration = planeY + a.radius - a.py
  if (penetration <= 0) return null
  const target = out ?? createContactManifold()
  return resetContact(target, idxA, -1, 0, 1, 0, penetration, a.px, planeY, a.pz)
}

/**
 * Narrowphase: Sphere vs `ProceduralTerrain` heightfield.
 */
export function collideSphereHeightfield(
  a: CollisionBody,
  idxA: number,
  terrain: ProceduralTerrain,
  scratchSample: TerrainSample,
  out?: ContactManifold
): ContactManifold | null {
  terrain.sampleInto(a.px, a.pz, scratchSample, a.py)
  const dy = a.py - scratchSample.height
  const dPerp = dy * scratchSample.normalY
  const penetration = a.radius - dPerp
  if (penetration <= 0) return null

  const nx = scratchSample.normalX
  const ny = scratchSample.normalY
  const nz = scratchSample.normalZ
  const contactDist = a.radius - penetration
  const target = out ?? createContactManifold()
  return resetContact(
    target,
    idxA,
    -1,
    nx,
    ny,
    nz,
    penetration,
    a.px - nx * contactDist,
    a.py - ny * contactDist,
    a.pz - nz * contactDist
  )
}

/**
 * Narrowphase: Box (AABB) vs flat horizontal GroundPlane (`y = planeY`).
 */
export function collideBoxGroundPlane(
  a: CollisionBody,
  idxA: number,
  planeY: number = 0.0,
  out?: ContactManifold
): ContactManifold | null {
  const penetration = planeY + a.hy - a.py
  if (penetration <= 0) return null
  const target = out ?? createContactManifold()
  return resetContact(target, idxA, -1, 0, 1, 0, penetration, a.px, planeY, a.pz)
}

/**
 * Narrowphase: Box (AABB) vs `ProceduralTerrain` heightfield.
 */
export function collideBoxHeightfield(
  a: CollisionBody,
  idxA: number,
  terrain: ProceduralTerrain,
  scratchSample: TerrainSample,
  out?: ContactManifold
): ContactManifold | null {
  terrain.sampleInto(a.px, a.pz, scratchSample, a.py)
  const nx = scratchSample.normalX
  const ny = scratchSample.normalY
  const nz = scratchSample.normalZ
  const effHalf = Math.abs(nx) * a.hx + Math.abs(ny) * a.hy + Math.abs(nz) * a.hz
  const dPerp = (a.py - scratchSample.height) * ny
  const penetration = effHalf - dPerp
  if (penetration <= 0) return null

  const contactDist = effHalf - penetration
  const target = out ?? createContactManifold()
  return resetContact(
    target,
    idxA,
    -1,
    nx,
    ny,
    nz,
    penetration,
    a.px - nx * contactDist,
    a.py - ny * contactDist,
    a.pz - nz * contactDist
  )
}

/**
 * Narrowphase: AABB vs AABB (Box-Box Minimum Translation Vector normal & penetration).
 * Normal points from B toward A along the axis of minimum overlap.
 */
export function collideAabbAabb(
  a: CollisionBody,
  idxA: number,
  b: CollisionBody,
  idxB: number,
  out?: ContactManifold
): ContactManifold | null {
  const dx = a.px - b.px
  const dy = a.py - b.py
  const dz = a.pz - b.pz

  const ox = a.hx + b.hx - Math.abs(dx)
  if (ox <= 0) return null
  const oy = a.hy + b.hy - Math.abs(dy)
  if (oy <= 0) return null
  const oz = a.hz + b.hz - Math.abs(dz)
  if (oz <= 0) return null

  // Overlap region center for contact point coordinates
  const cMinX = Math.max(a.px - a.hx, b.px - b.hx)
  const cMaxX = Math.min(a.px + a.hx, b.px + b.hx)
  const cMinY = Math.max(a.py - a.hy, b.py - b.hy)
  const cMaxY = Math.min(a.py + a.hy, b.py + b.hy)
  const cMinZ = Math.max(a.pz - a.hz, b.pz - b.hz)
  const cMaxZ = Math.min(a.pz + a.hz, b.pz + b.hz)

  const px = 0.5 * (cMinX + cMaxX)
  const py = 0.5 * (cMinY + cMaxY)
  const pz = 0.5 * (cMinZ + cMaxZ)

  const target = out ?? createContactManifold()

  if (ox <= oy && ox <= oz) {
    const nx = dx >= 0 ? 1 : -1
    return resetContact(target, idxA, idxB, nx, 0, 0, ox, px, py, pz)
  }
  if (oy <= oz) {
    const ny = dy >= 0 ? 1 : -1
    return resetContact(target, idxA, idxB, 0, ny, 0, oy, px, py, pz)
  }
  const nz = dz >= 0 ? 1 : -1
  return resetContact(target, idxA, idxB, 0, 0, nz, oz, px, py, pz)
}

/**
 * Narrowphase: Sphere vs AABB (Box).
 * If `sphereIsA` is true, `idxA` is the sphere and normal points from Box -> Sphere.
 * If `sphereIsA` is false, `idxA` is the box and normal points from Sphere -> Box.
 */
export function collideSphereAabb(
  sphere: CollisionBody,
  sphereIdx: number,
  box: CollisionBody,
  boxIdx: number,
  sphereIsA: boolean = true,
  out?: ContactManifold
): ContactManifold | null {
  const minX = box.px - box.hx
  const maxX = box.px + box.hx
  const minY = box.py - box.hy
  const maxY = box.py + box.hy
  const minZ = box.pz - box.hz
  const maxZ = box.pz + box.hz

  const cx = Math.min(maxX, Math.max(minX, sphere.px))
  const cy = Math.min(maxY, Math.max(minY, sphere.py))
  const cz = Math.min(maxZ, Math.max(minZ, sphere.pz))

  const dx = sphere.px - cx
  const dy = sphere.py - cy
  const dz = sphere.pz - cz
  const distSq = dx * dx + dy * dy + dz * dz
  const r = sphere.radius

  if (distSq >= r * r) return null

  let nx = 0
  let ny = 1
  let nz = 0
  let penetration = 0
  let px = cx
  let py = cy
  let pz = cz

  if (distSq > 1e-18) {
    const dist = Math.sqrt(distSq)
    const invD = 1.0 / dist
    nx = dx * invD
    ny = dy * invD
    nz = dz * invD
    penetration = r - dist
  } else {
    // Sphere center is inside the box: push out along nearest box face
    const dPosX = maxX - sphere.px
    const dNegX = sphere.px - minX
    const dPosY = maxY - sphere.py
    const dNegY = sphere.py - minY
    const dPosZ = maxZ - sphere.pz
    const dNegZ = sphere.pz - minZ

    let minFace = dPosX
    nx = 1
    ny = 0
    nz = 0
    px = maxX

    if (dNegX < minFace) {
      minFace = dNegX
      nx = -1
      ny = 0
      nz = 0
      px = minX
    }
    if (dPosY < minFace) {
      minFace = dPosY
      nx = 0
      ny = 1
      nz = 0
      px = cx
      py = maxY
    }
    if (dNegY < minFace) {
      minFace = dNegY
      nx = 0
      ny = -1
      nz = 0
      px = cx
      py = minY
    }
    if (dPosZ < minFace) {
      minFace = dPosZ
      nx = 0
      ny = 0
      nz = 1
      px = cx
      py = cy
      pz = maxZ
    }
    if (dNegZ < minFace) {
      minFace = dNegZ
      nx = 0
      ny = 0
      nz = -1
      px = cx
      py = cy
      pz = minZ
    }
    penetration = r + minFace
  }

  const target = out ?? createContactManifold()
  if (sphereIsA) {
    return resetContact(target, sphereIdx, boxIdx, nx, ny, nz, penetration, px, py, pz)
  }
  return resetContact(target, boxIdx, sphereIdx, -nx, -ny, -nz, penetration, px, py, pz)
}

// ============================================================================
// 4. 4-Wheel Raycast Vehicle Suspension (`RaycastVehicle`)
// ============================================================================

export interface WheelConfig {
  readonly attachLocalX: number
  readonly attachLocalY: number
  readonly attachLocalZ: number
  readonly restLength?: number
  readonly wheelRadius?: number
  readonly springStiffness?: number
  readonly damperRate?: number
  readonly steerable?: boolean
  readonly driven?: boolean
  readonly lateralGrip?: number
  readonly tireFriction?: number
}

export interface WheelState {
  readonly attachLocalX: number
  readonly attachLocalY: number
  readonly attachLocalZ: number
  readonly restLength: number
  readonly wheelRadius: number
  readonly springStiffness: number
  readonly damperRate: number
  readonly steerable: boolean
  readonly driven: boolean
  readonly lateralGrip: number
  readonly tireFriction: number
  inContact: boolean
  springLength: number
  compression: number
  suspensionForce: number
  steerAngle: number
  spinAngle: number
  contactX: number
  contactY: number
  contactZ: number
  contactNormalX: number
  contactNormalY: number
  contactNormalZ: number
}

export interface RaycastVehicleConfig {
  readonly chassisMass?: number
  readonly chassisHalfExtents?: Vec3
  readonly maxEngineForce?: number
  readonly maxBrakeForce?: number
  readonly maxSteerAngle?: number
  readonly rollingResistance?: number
  readonly rollInfluence?: number
  readonly wheels?: readonly WheelConfig[]
}

const DEFAULT_WHEELS: readonly WheelConfig[] = [
  // Front-Left, Front-Right (steerable)
  { attachLocalX: -0.85, attachLocalY: -0.2, attachLocalZ: 1.35, steerable: true, driven: false },
  { attachLocalX: 0.85, attachLocalY: -0.2, attachLocalZ: 1.35, steerable: true, driven: false },
  // Rear-Left, Rear-Right (driven)
  { attachLocalX: -0.85, attachLocalY: -0.2, attachLocalZ: -1.35, steerable: false, driven: true },
  { attachLocalX: 0.85, attachLocalY: -0.2, attachLocalZ: -1.35, steerable: false, driven: true },
]

/**
 * 4-Wheel Raycast Suspension Vehicle with Hooke spring + damper, steering, throttle/brake,
 * and Coulomb-clamped lateral tire grip.
 * Chassis local frame: +X right, +Y up, +Z forward.
 */
export class RaycastVehicle {
  public readonly chassis: CollisionBody
  public readonly wheels: WheelState[]
  public readonly maxEngineForce: number
  public readonly maxBrakeForce: number
  public readonly maxSteerAngle: number
  public readonly rollingResistance: number
  public readonly rollInfluence: number

  public throttle: number
  public brake: number
  public steerInput: number

  private readonly scratchRight: Vec3
  private readonly scratchUp: Vec3
  private readonly scratchForward: Vec3
  private readonly scratchLocal: Vec3
  private readonly scratchAttach: Vec3
  private readonly scratchInertia: Vec3
  private readonly scratchTerrain: TerrainSample

  public constructor(x: number, y: number, z: number, cfg?: RaycastVehicleConfig) {
    const mass = Math.max(100, cfg?.chassisMass ?? 1200)
    const halfExtents = cfg?.chassisHalfExtents ?? { x: 0.95, y: 0.4, z: 2.05 }

    this.chassis = new CollisionBody(x, y, z, {
      shape: ColliderShape.Box,
      halfExtents,
      mass,
      restitution: 0.05,
      friction: 0.6,
      linearDamping: 0.03,
      angularDamping: 0.15,
    })

    this.maxEngineForce = cfg?.maxEngineForce ?? 5500
    this.maxBrakeForce = cfg?.maxBrakeForce ?? 7000
    this.maxSteerAngle = cfg?.maxSteerAngle ?? 0.52
    this.rollingResistance = cfg?.rollingResistance ?? 18.0
    this.rollInfluence = cfg?.rollInfluence ?? 0.25

    this.throttle = 0
    this.brake = 0
    this.steerInput = 0

    const wheelConfigs = cfg?.wheels ?? DEFAULT_WHEELS
    this.wheels = []
    for (let i = 0; i < wheelConfigs.length; i++) {
      const wc = wheelConfigs[i]!
      const restLen = wc.restLength ?? 0.55
      this.wheels.push({
        attachLocalX: wc.attachLocalX,
        attachLocalY: wc.attachLocalY,
        attachLocalZ: wc.attachLocalZ,
        restLength: restLen,
        wheelRadius: wc.wheelRadius ?? 0.35,
        springStiffness: wc.springStiffness ?? 32000,
        damperRate: wc.damperRate ?? 4600,
        steerable: Boolean(wc.steerable),
        driven: Boolean(wc.driven),
        lateralGrip: wc.lateralGrip ?? 10.0,
        tireFriction: wc.tireFriction ?? 1.15,
        inContact: false,
        springLength: restLen,
        compression: 0,
        suspensionForce: 0,
        steerAngle: 0,
        spinAngle: 0,
        contactX: 0,
        contactY: 0,
        contactZ: 0,
        contactNormalX: 0,
        contactNormalY: 1,
        contactNormalZ: 0,
      })
    }

    this.scratchRight = { x: 1, y: 0, z: 0 }
    this.scratchUp = { x: 0, y: 1, z: 0 }
    this.scratchForward = { x: 0, y: 0, z: 1 }
    this.scratchLocal = { x: 0, y: 0, z: 0 }
    this.scratchAttach = { x: 0, y: 0, z: 0 }
    this.scratchInertia = { x: 0, y: 0, z: 0 }
    this.scratchTerrain = {
      height: 0,
      normalX: 0,
      normalY: 1,
      normalZ: 0,
      slopeAngleRad: 0,
      submergedDepth: 0,
    }
  }

  public setControls(throttle: number, steer: number, brake: number = 0): void {
    this.throttle = Math.min(1.0, Math.max(-1.0, throttle))
    this.steerInput = Math.min(1.0, Math.max(-1.0, steer))
    this.brake = Math.min(1.0, Math.max(0.0, brake))
  }

  public get groundedWheelCount(): number {
    let count = 0
    for (let i = 0; i < this.wheels.length; i++) {
      if (this.wheels[i]!.inContact) count += 1
    }
    return count
  }

  public get forwardSpeed(): number {
    const fwd = this.scratchForward
    fwd.x = 0
    fwd.y = 0
    fwd.z = 1
    this.chassis.orientation.rotateVec3(fwd, fwd)
    return this.chassis.vx * fwd.x + this.chassis.vy * fwd.y + this.chassis.vz * fwd.z
  }

  /**
   * Evaluates all 4 wheel raycasts, Hooke spring + damper suspension forces,
   * steering, throttle/brake drive forces, and lateral tire grip forces.
   */
  public applySuspensionAndTireForces(
    dt: number,
    groundPlaneY: number = 0.0,
    terrain?: ProceduralTerrain
  ): void {
    const body = this.chassis
    const q = body.orientation

    const right = this.scratchRight
    const up = this.scratchUp
    const fwd = this.scratchForward
    right.x = 1
    right.y = 0
    right.z = 0
    up.x = 0
    up.y = 1
    up.z = 0
    fwd.x = 0
    fwd.y = 0
    fwd.z = 1

    q.rotateVec3(right, right)
    q.rotateVec3(up, up)
    q.rotateVec3(fwd, fwd)

    const maxSuspForce = body.mass * 9.81 * 2.5
    const steerAngleRad = this.steerInput * this.maxSteerAngle
    const sample = this.scratchTerrain

    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!
      w.steerAngle = w.steerable ? steerAngleRad : 0

      // World-space wheel attachment point
      this.scratchLocal.x = w.attachLocalX
      this.scratchLocal.y = w.attachLocalY
      this.scratchLocal.z = w.attachLocalZ
      q.rotateVec3(this.scratchLocal, this.scratchAttach)

      const attachX = body.px + this.scratchAttach.x
      const attachY = body.py + this.scratchAttach.y
      const attachZ = body.pz + this.scratchAttach.z

      const maxRayDist = w.restLength + w.wheelRadius
      let hit = false
      let hitDist = maxRayDist
      let hitX = attachX - up.x * maxRayDist
      let hitY = attachY - up.y * maxRayDist
      let hitZ = attachZ - up.z * maxRayDist
      let cnx = 0
      let cny = 1
      let cnz = 0

      if (up.y > 0.15) {
        if (terrain) {
          // 2-step iterative ray-heightfield intersection along -up
          let t = w.restLength
          for (let iter = 0; iter < 2; iter++) {
            const px = attachX - up.x * t
            const pz = attachZ - up.z * t
            const h = terrain.sampleHeight(px, pz)
            t = (attachY - h) / up.y
          }
          if (t >= 0 && t <= maxRayDist) {
            hit = true
            hitDist = t
            hitX = attachX - up.x * t
            hitZ = attachZ - up.z * t
            terrain.sampleInto(hitX, hitZ, sample, attachY - up.y * t)
            hitY = sample.height
            cnx = sample.normalX
            cny = sample.normalY
            cnz = sample.normalZ
          }
        } else {
          const t = (attachY - groundPlaneY) / up.y
          if (t >= 0 && t <= maxRayDist) {
            hit = true
            hitDist = t
            hitX = attachX - up.x * t
            hitY = groundPlaneY
            hitZ = attachZ - up.z * t
          }
        }
      }

      if (!hit) {
        w.inContact = false
        w.springLength = w.restLength
        w.compression = 0
        w.suspensionForce = 0
        continue
      }

      w.inContact = true
      w.contactX = hitX
      w.contactY = hitY
      w.contactZ = hitZ
      w.contactNormalX = cnx
      w.contactNormalY = cny
      w.contactNormalZ = cnz

      w.springLength = Math.max(0, hitDist - w.wheelRadius)
      const compression = Math.max(0, w.restLength - w.springLength)
      w.compression = compression

      // Lever arm from chassis CoM to wheel attachment point for suspension velocity
      const rxAttach = attachX - body.px
      const ryAttach = attachY - body.py
      const rzAttach = attachZ - body.pz

      const vAttachX = body.vx + (body.wy * rzAttach - body.wz * ryAttach)
      const vAttachY = body.vy + (body.wz * rxAttach - body.wx * rzAttach)
      const vAttachZ = body.vz + (body.wx * ryAttach - body.wy * rxAttach)

      // Positive when chassis is moving downward into the spring (compressing)
      const compressionVel = -(vAttachX * up.x + vAttachY * up.y + vAttachZ * up.z)

      // Hooke's law spring + viscous damper (unilateral: suspension can only push, not pull)
      let fSusp = w.springStiffness * compression + w.damperRate * compressionVel
      if (fSusp < 0) fSusp = 0
      if (fSusp > maxSuspForce) fSusp = maxSuspForce
      w.suspensionForce = fSusp

      if (fSusp <= 0) continue

      // Apply suspension force along contact normal at attachment point
      body.applyForceAtWorldPoint(
        cnx * fSusp,
        cny * fSusp,
        cnz * fSusp,
        attachX,
        attachY,
        attachZ,
        dt,
        this.scratchInertia
      )

      // Build steered tire forward & lateral tangent basis on the ground surface
      const cosS = Math.cos(w.steerAngle)
      const sinS = Math.sin(w.steerAngle)
      let tfx = fwd.x * cosS + right.x * sinS
      let tfy = fwd.y * cosS + right.y * sinS
      let tfz = fwd.z * cosS + right.z * sinS

      // Project tire forward onto contact plane
      const dotFn = tfx * cnx + tfy * cny + tfz * cnz
      tfx -= dotFn * cnx
      tfy -= dotFn * cny
      tfz -= dotFn * cnz
      const tfLen = Math.hypot(tfx, tfy, tfz)
      if (tfLen > 1e-9) {
        const invTf = 1.0 / tfLen
        tfx *= invTf
        tfy *= invTf
        tfz *= invTf
      }

      // Tire right = contactNormal × tireForward (right-handed: +Y × +Z = +X)
      let trx = cny * tfz - cnz * tfy
      let try_ = cnz * tfx - cnx * tfz
      let trz = cnx * tfy - cny * tfx
      const trLen = Math.hypot(trx, try_, trz)
      if (trLen > 1e-9) {
        const invTr = 1.0 / trLen
        trx *= invTr
        try_ *= invTr
        trz *= invTr
      }

      // Tire contact patch velocity
      const rxPatch = hitX - body.px
      const ryPatch = hitY - body.py
      const rzPatch = hitZ - body.pz

      const vPatchX = body.vx + (body.wy * rzPatch - body.wz * ryPatch)
      const vPatchY = body.vy + (body.wz * rxPatch - body.wx * rzPatch)
      const vPatchZ = body.vz + (body.wx * ryPatch - body.wy * rxPatch)

      const vFwd = vPatchX * tfx + vPatchY * tfy + vPatchZ * tfz
      const vLat = vPatchX * trx + vPatchY * try_ + vPatchZ * trz

      w.spinAngle += (vFwd / w.wheelRadius) * dt

      // Longitudinal force: throttle (driven wheels) + braking + rolling resistance
      let fLong = w.driven ? this.throttle * this.maxEngineForce : 0
      if (this.brake > 0 && Math.abs(vFwd) > 1e-3) {
        const brakeSign = vFwd > 0 ? -1 : 1
        const maxStopForce = (Math.abs(vFwd) * body.mass) / (Math.max(1, this.wheels.length) * dt)
        fLong += brakeSign * Math.min(this.brake * this.maxBrakeForce, maxStopForce)
      }
      fLong -= this.rollingResistance * vFwd

      // Lateral tire grip force opposing sideways slip
      const wheelShareMass = body.mass / Math.max(1, this.wheels.length)
      let fLat = -vLat * w.lateralGrip * wheelShareMass
      // Clamp lateral force so a single step never overshoots zero slip
      const maxNoOvershootLat = Math.abs(vLat) * wheelShareMass / dt
      if (Math.abs(fLat) > maxNoOvershootLat) {
        fLat = fLat > 0 ? maxNoOvershootLat : -maxNoOvershootLat
      }

      // Isotropic Coulomb friction circle clamp: sqrt(fLong^2 + fLat^2) <= mu * fSusp
      const maxTireForce = w.tireFriction * fSusp
      const tireForceMag = Math.hypot(fLong, fLat)
      if (tireForceMag > maxTireForce && tireForceMag > 1e-9) {
        const scale = maxTireForce / tireForceMag
        fLong *= scale
        fLat *= scale
      }

      // Apply tire forces at roll-adjusted contact point to prevent artificial roll-over
      const applyY = body.py + (hitY - body.py) * this.rollInfluence
      body.applyForceAtWorldPoint(
        tfx * fLong + trx * fLat,
        tfy * fLong + try_ * fLat,
        tfz * fLong + trz * fLat,
        hitX,
        applyY,
        hitZ,
        dt,
        this.scratchInertia
      )
    }
  }
}

// ============================================================================
// 5. Sequential-Impulse Contact Solver & Collision World
// ============================================================================

export interface CollisionWorldConfig {
  readonly fixedDt?: number
  readonly gravity?: number
  readonly cellSize?: number
  readonly solverIterations?: number
  readonly baumgarteBeta?: number
  readonly penetrationSlop?: number
  readonly restitutionVelocityThreshold?: number
  readonly groundPlaneY?: number | null
}

export interface CollisionStepStats {
  readonly broadphasePairs: number
  readonly activeContacts: number
  readonly maxQuatNormError: number
}

/**
 * 3D Rigid-Body Collision World combining `BroadphaseGrid`, narrowphase manifold generation,
 * Sequential-Impulse Contact Solver (restitution, Coulomb friction, Baumgarte stabilization,
 * rotational impulses), S^3 `UnitQuaternion` integration, and `RaycastVehicle` simulation.
 */
export class CollisionWorld {
  public readonly fixedDt: number
  public readonly gravity: number
  public readonly solverIterations: number
  public readonly baumgarteBeta: number
  public readonly penetrationSlop: number
  public readonly restitutionVelocityThreshold: number
  public groundPlaneY: number | null
  public readonly broadphase: BroadphaseGrid
  public readonly bodies: CollisionBody[]
  public readonly vehicles: RaycastVehicle[]

  private readonly contactPool: ContactManifold[]
  private activeContactCount: number
  private readonly pairBuffer: BroadphasePair[]
  private readonly scratchTerrain: TerrainSample
  private readonly scratchVecA: Vec3
  private readonly scratchVecB: Vec3
  private readonly scratchVecC: Vec3
  private maxObservedNormError: number
  private stepCount: number

  public constructor(cfg?: CollisionWorldConfig) {
    this.fixedDt = cfg?.fixedDt ?? 1 / 60
    this.gravity = cfg?.gravity ?? 9.81
    this.solverIterations = Math.max(1, cfg?.solverIterations ?? 10)
    this.baumgarteBeta = cfg?.baumgarteBeta ?? 0.22
    this.penetrationSlop = cfg?.penetrationSlop ?? 0.004
    this.restitutionVelocityThreshold = cfg?.restitutionVelocityThreshold ?? 0.25
    this.groundPlaneY = cfg?.groundPlaneY === undefined ? 0.0 : cfg.groundPlaneY

    this.broadphase = new BroadphaseGrid(cfg?.cellSize ?? 2.0)
    this.bodies = []
    this.vehicles = []
    this.contactPool = []
    this.activeContactCount = 0
    this.pairBuffer = []
    this.scratchTerrain = {
      height: 0,
      normalX: 0,
      normalY: 1,
      normalZ: 0,
      slopeAngleRad: 0,
      submergedDepth: 0,
    }
    this.scratchVecA = { x: 0, y: 0, z: 0 }
    this.scratchVecB = { x: 0, y: 0, z: 0 }
    this.scratchVecC = { x: 0, y: 0, z: 0 }
    this.maxObservedNormError = 0
    this.stepCount = 0
  }

  public get stepsExecuted(): number {
    return this.stepCount
  }

  public get maxQuatNormError(): number {
    return this.maxObservedNormError
  }

  public addBody(body: CollisionBody): number {
    this.bodies.push(body)
    return this.bodies.length - 1
  }

  public addVehicle(vehicle: RaycastVehicle): number {
    this.addBody(vehicle.chassis)
    this.vehicles.push(vehicle)
    return this.vehicles.length - 1
  }

  private acquireContactSlot(): ContactManifold {
    if (this.activeContactCount < this.contactPool.length) {
      return this.contactPool[this.activeContactCount]!
    }
    const c = createContactManifold()
    this.contactPool.push(c)
    return c
  }

  /**
   * Advances the physics world by a single timestep `dt` (defaults to `fixedDt`).
   */
  public step(dt: number = this.fixedDt, terrain?: ProceduralTerrain): CollisionStepStats {
    const bodies = this.bodies
    const n = bodies.length

    // 1. Apply gravity and linear/angular damping
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!
      b.grounded = false
      if (b.isStatic) continue

      b.vy -= this.gravity * dt
      if (b.linearDamping > 0) {
        const ld = Math.exp(-b.linearDamping * dt)
        b.vx *= ld
        b.vy *= ld
        b.vz *= ld
      }
      if (b.angularDamping > 0 && !b.lockRotation) {
        const ad = Math.exp(-b.angularDamping * dt)
        b.wx *= ad
        b.wy *= ad
        b.wz *= ad
      }
    }

    // 2. Evaluate all 4-wheel raycast vehicles (Hooke spring + damper + steering + tire grip)
    const groundY = this.groundPlaneY ?? 0.0
    for (let v = 0; v < this.vehicles.length; v++) {
      this.vehicles[v]!.applySuspensionAndTireForces(dt, groundY, terrain)
    }

    // 3. Broadphase spatial-hash insertion & candidate pair extraction
    const grid = this.broadphase
    grid.clear()
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!
      b.updateAABB()
      grid.insert(i, b.aabb)
    }
    const pairs = grid.queryCandidatePairs(this.pairBuffer)

    // 4. Narrowphase contact manifold generation
    this.activeContactCount = 0

    // 4a. Body-vs-Body narrowphase
    for (let p = 0; p < pairs.length; p++) {
      const pair = pairs[p]!
      const bodyA = bodies[pair.a]!
      const bodyB = bodies[pair.b]!
      if (bodyA.isStatic && bodyB.isStatic) continue

      const slot = this.acquireContactSlot()
      let hit: ContactManifold | null = null

      if (bodyA.shape === ColliderShape.Sphere && bodyB.shape === ColliderShape.Sphere) {
        hit = collideSphereSphere(bodyA, pair.a, bodyB, pair.b, slot)
      } else if (bodyA.shape === ColliderShape.Box && bodyB.shape === ColliderShape.Box) {
        hit = collideAabbAabb(bodyA, pair.a, bodyB, pair.b, slot)
      } else if (bodyA.shape === ColliderShape.Sphere && bodyB.shape === ColliderShape.Box) {
        hit = collideSphereAabb(bodyA, pair.a, bodyB, pair.b, true, slot)
      } else {
        hit = collideSphereAabb(bodyB, pair.b, bodyA, pair.a, false, slot)
      }

      if (hit !== null) {
        this.activeContactCount += 1
      }
    }

    // 4b. Body-vs-GroundPlane / Heightfield narrowphase
    if (terrain !== undefined || this.groundPlaneY !== null) {
      for (let i = 0; i < n; i++) {
        const b = bodies[i]!
        if (b.isStatic) continue
        const slot = this.acquireContactSlot()
        let hit: ContactManifold | null = null
        if (terrain !== undefined) {
          hit =
            b.shape === ColliderShape.Sphere
              ? collideSphereHeightfield(b, i, terrain, this.scratchTerrain, slot)
              : collideBoxHeightfield(b, i, terrain, this.scratchTerrain, slot)
        } else if (this.groundPlaneY !== null) {
          hit =
            b.shape === ColliderShape.Sphere
              ? collideSphereGroundPlane(b, i, this.groundPlaneY, slot)
              : collideBoxGroundPlane(b, i, this.groundPlaneY, slot)
        }
        if (hit !== null) {
          b.grounded = true
          this.activeContactCount += 1
        }
      }
    }

    // 5. Sequential-Impulse Contact Solver
    this.solveContacts(dt)

    // 6. Integrate positions & exact S^3 exponential-map orientations
    for (let i = 0; i < n; i++) {
      const b = bodies[i]!
      if (b.isStatic) continue

      b.px += b.vx * dt
      b.py += b.vy * dt
      b.pz += b.vz * dt

      if (!b.lockRotation) {
        b.orientation.integrateAngularVelocityInPlace(b.wx, b.wy, b.wz, dt)
        const err = b.orientation.normError()
        if (err > this.maxObservedNormError) {
          this.maxObservedNormError = err
        }
      }
      b.updateAABB()
    }

    this.stepCount += 1
    return {
      broadphasePairs: pairs.length,
      activeContacts: this.activeContactCount,
      maxQuatNormError: this.maxObservedNormError,
    }
  }

  /**
   * Sequential-Impulse velocity solver with restitution, isotropic Coulomb friction,
   * Baumgarte position stabilization, and full 3D rotational impulses.
   */
  private solveContacts(dt: number): void {
    const count = this.activeContactCount
    if (count === 0) return

    const bodies = this.bodies
    const contacts = this.contactPool
    const betaOverDt = this.baumgarteBeta / dt
    const slop = this.penetrationSlop
    const restThresh = this.restitutionVelocityThreshold
    const vecA = this.scratchVecA
    const vecB = this.scratchVecB
    const vecC = this.scratchVecC

    // Pre-pass: record pre-solve normal impact velocity for accurate restitution
    for (let i = 0; i < count; i++) {
      const c = contacts[i]!
      const a = bodies[c.bodyA]!
      const b = c.bodyB >= 0 ? bodies[c.bodyB]! : null

      const rAx = c.px - a.px
      const rAy = c.py - a.py
      const rAz = c.pz - a.pz
      const vAx = a.vx + (a.wy * rAz - a.wz * rAy)
      const vAy = a.vy + (a.wz * rAx - a.wx * rAz)
      const vAz = a.vz + (a.wx * rAy - a.wy * rAx)

      let vBx = 0
      let vBy = 0
      let vBz = 0
      if (b !== null) {
        const rBx = c.px - b.px
        const rBy = c.py - b.py
        const rBz = c.pz - b.pz
        vBx = b.vx + (b.wy * rBz - b.wz * rBy)
        vBy = b.vy + (b.wz * rBx - b.wx * rBz)
        vBz = b.vz + (b.wx * rBy - b.wy * rBx)
      }

      c.initialVn = (vAx - vBx) * c.nx + (vAy - vBy) * c.ny + (vAz - vBz) * c.nz
      c.normalImpulse = 0
      c.tangentImpulse1 = 0
      c.tangentImpulse2 = 0
    }

    // Iterative Gauss-Seidel sequential impulses
    for (let iter = 0; iter < this.solverIterations; iter++) {
      for (let i = 0; i < count; i++) {
        const c = contacts[i]!
        const a = bodies[c.bodyA]!
        const b = c.bodyB >= 0 ? bodies[c.bodyB]! : null

        const nx = c.nx
        const ny = c.ny
        const nz = c.nz

        const rAx = c.px - a.px
        const rAy = c.py - a.py
        const rAz = c.pz - a.pz

        let rBx = 0
        let rBy = 0
        let rBz = 0
        if (b !== null) {
          rBx = c.px - b.px
          rBy = c.py - b.py
          rBz = c.pz - b.pz
        }

        // Relative velocity at contact point
        const vAx = a.vx + (a.wy * rAz - a.wz * rAy)
        const vAy = a.vy + (a.wz * rAx - a.wx * rAz)
        const vAz = a.vz + (a.wx * rAy - a.wy * rAx)

        let vBx = 0
        let vBy = 0
        let vBz = 0
        if (b !== null) {
          vBx = b.vx + (b.wy * rBz - b.wz * rBy)
          vBy = b.vy + (b.wz * rBx - b.wx * rBz)
          vBz = b.vz + (b.wx * rBy - b.wy * rBx)
        }

        const rvx = vAx - vBx
        const rvy = vAy - vBy
        const rvz = vAz - vBz

        // ---- 1. Normal Impulse (Restitution + Baumgarte Stabilization) ----
        const vn = rvx * nx + rvy * ny + rvz * nz

        // Effective mass along normal: invMassA + invMassB + (rA×n)·(I_A^-1(rA×n)) + (rB×n)·(I_B^-1(rB×n))
        const rnAx = rAy * nz - rAz * ny
        const rnAy = rAz * nx - rAx * nz
        const rnAz = rAx * ny - rAy * nx
        a.multiplyInvInertiaWorld(rnAx, rnAy, rnAz, vecA)
        let kN = a.invMass + (rnAx * vecA.x + rnAy * vecA.y + rnAz * vecA.z)

        if (b !== null) {
          const rnBx = rBy * nz - rBz * ny
          const rnBy = rBz * nx - rBx * nz
          const rnBz = rBx * ny - rBy * nx
          b.multiplyInvInertiaWorld(rnBx, rnBy, rnBz, vecB)
          kN += b.invMass + (rnBx * vecB.x + rnBy * vecB.y + rnBz * vecB.z)
        }

        if (kN <= 1e-12) continue
        const effMassN = 1.0 / kN

        const restitution = b !== null ? Math.max(a.restitution, b.restitution) : a.restitution
        const restBias = c.initialVn < -restThresh ? -restitution * c.initialVn : 0.0
        const baumgarteBias = betaOverDt * Math.max(0.0, c.penetration - slop)
        const targetVn = restBias > baumgarteBias ? restBias : baumgarteBias

        const deltaJn = effMassN * (targetVn - vn)
        const prevJn = c.normalImpulse
        const nextJn = prevJn + deltaJn > 0 ? prevJn + deltaJn : 0
        const applyJn = nextJn - prevJn
        c.normalImpulse = nextJn

        if (applyJn !== 0) {
          const jx = nx * applyJn
          const jy = ny * applyJn
          const jz = nz * applyJn
          a.applyImpulse(jx, jy, jz, rAx, rAy, rAz, vecC)
          if (b !== null) {
            b.applyImpulse(-jx, -jy, -jz, rBx, rBy, rBz, vecC)
          }
        }

        // ---- 2. Isotropic Coulomb Friction (2 Orthogonal Tangents) ----
        const mu = b !== null ? Math.sqrt(a.friction * b.friction) : a.friction
        if (mu <= 0 || c.normalImpulse <= 0) continue

        // Orthonormal tangent basis (t1, t2) perpendicular to n
        let t1x = 0
        let t1y = 0
        let t1z = 0
        if (Math.abs(nx) < 0.9) {
          // n × (1, 0, 0) = (0, nz, -ny)
          const invLen = 1.0 / Math.hypot(nz, ny)
          t1x = 0
          t1y = nz * invLen
          t1z = -ny * invLen
        } else {
          // n × (0, 1, 0) = (-nz, 0, nx)
          const invLen = 1.0 / Math.hypot(nz, nx)
          t1x = -nz * invLen
          t1y = 0
          t1z = nx * invLen
        }
        // t2 = n × t1
        const t2x = ny * t1z - nz * t1y
        const t2y = nz * t1x - nx * t1z
        const t2z = nx * t1y - ny * t1x

        // Recompute relative velocity after normal impulse
        const vAx2 = a.vx + (a.wy * rAz - a.wz * rAy)
        const vAy2 = a.vy + (a.wz * rAx - a.wx * rAz)
        const vAz2 = a.vz + (a.wx * rAy - a.wy * rAx)
        let vBx2 = 0
        let vBy2 = 0
        let vBz2 = 0
        if (b !== null) {
          vBx2 = b.vx + (b.wy * rBz - b.wz * rBy)
          vBy2 = b.vy + (b.wz * rBx - b.wx * rBz)
          vBz2 = b.vz + (b.wx * rBy - b.wy * rBx)
        }
        const rvx2 = vAx2 - vBx2
        const rvy2 = vAy2 - vBy2
        const rvz2 = vAz2 - vBz2

        // Tangent 1 effective mass & impulse
        const vt1 = rvx2 * t1x + rvy2 * t1y + rvz2 * t1z
        const rt1Ax = rAy * t1z - rAz * t1y
        const rt1Ay = rAz * t1x - rAx * t1z
        const rt1Az = rAx * t1y - rAy * t1x
        a.multiplyInvInertiaWorld(rt1Ax, rt1Ay, rt1Az, vecA)
        let kT1 = a.invMass + (rt1Ax * vecA.x + rt1Ay * vecA.y + rt1Az * vecA.z)
        if (b !== null) {
          const rt1Bx = rBy * t1z - rBz * t1y
          const rt1By = rBz * t1x - rBx * t1z
          const rt1Bz = rBx * t1y - rBy * t1x
          b.multiplyInvInertiaWorld(rt1Bx, rt1By, rt1Bz, vecB)
          kT1 += b.invMass + (rt1Bx * vecB.x + rt1By * vecB.y + rt1Bz * vecB.z)
        }

        // Tangent 2 effective mass & impulse
        const vt2 = rvx2 * t2x + rvy2 * t2y + rvz2 * t2z
        const rt2Ax = rAy * t2z - rAz * t2y
        const rt2Ay = rAz * t2x - rAx * t2z
        const rt2Az = rAx * t2y - rAy * t2x
        a.multiplyInvInertiaWorld(rt2Ax, rt2Ay, rt2Az, vecA)
        let kT2 = a.invMass + (rt2Ax * vecA.x + rt2Ay * vecA.y + rt2Az * vecA.z)
        if (b !== null) {
          const rt2Bx = rBy * t2z - rBz * t2y
          const rt2By = rBz * t2x - rBx * t2z
          const rt2Bz = rBx * t2y - rBy * t2x
          b.multiplyInvInertiaWorld(rt2Bx, rt2By, rt2Bz, vecB)
          kT2 += b.invMass + (rt2Bx * vecB.x + rt2By * vecB.y + rt2Bz * vecB.z)
        }

        const deltaJt1 = kT1 > 1e-12 ? -vt1 / kT1 : 0
        const deltaJt2 = kT2 > 1e-12 ? -vt2 / kT2 : 0

        const prevJt1 = c.tangentImpulse1
        const prevJt2 = c.tangentImpulse2
        let nextJt1 = prevJt1 + deltaJt1
        let nextJt2 = prevJt2 + deltaJt2

        // Clamp combined tangent impulse to isotropic Coulomb friction cone
        const maxJt = mu * c.normalImpulse
        const jtMag = Math.hypot(nextJt1, nextJt2)
        if (jtMag > maxJt && jtMag > 1e-12) {
          const scale = maxJt / jtMag
          nextJt1 *= scale
          nextJt2 *= scale
        }

        const applyJt1 = nextJt1 - prevJt1
        const applyJt2 = nextJt2 - prevJt2
        c.tangentImpulse1 = nextJt1
        c.tangentImpulse2 = nextJt2

        if (applyJt1 !== 0 || applyJt2 !== 0) {
          const fjx = t1x * applyJt1 + t2x * applyJt2
          const fjy = t1y * applyJt1 + t2y * applyJt2
          const fjz = t1z * applyJt1 + t2z * applyJt2
          a.applyImpulse(fjx, fjy, fjz, rAx, rAy, rAz, vecC)
          if (b !== null) {
            b.applyImpulse(-fjx, -fjy, -fjz, rBx, rBy, rBz, vecC)
          }
        }
      }
    }
  }
}
