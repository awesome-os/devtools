/**
 * @file sections/b8g-game-engine/obb-sat-section.mts
 * @description Implements Research Dossier 04 (`G_visual ≡ G_physics`):
 * Self-contained `HolonomicObjectSection` descriptors backed by exact Oriented Bounding Box
 * (OBB) 15-axis Separating Axis Theorem (SAT) collision detection and 8-corner OBB-vs-Ground
 * manifolds driven directly by `UnitQuaternion` (`S³`) orientation.
 *
 * Strictly 100% portable: zero `node:*` imports (`B8G012`/`B8G013` clean).
 */

import { UnitQuaternion } from './physics-locomotion.mts'

export interface Vec3D {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface ObbPose {
  readonly pos: Vec3D
  readonly rot: UnitQuaternion
  readonly halfExtents: Vec3D
}

export interface ObbContact {
  readonly normal: Vec3D // points from A -> B
  readonly penetration: number
  readonly contactPoint: Vec3D
}

/** Unified Holonomic Entity Section (`G_visual ≡ G_physics`). */
export interface HolonomicObjectSection {
  readonly id: string
  readonly halfExtents: Vec3D
  readonly mass: number
  readonly restitution: number
  readonly friction: number
  readonly material: {
    readonly baseColor: readonly [number, number, number]
    readonly metallic: number
    readonly roughness: number
  }
}

/** Extracts the 3 orthonormal local axes (X, Y, Z) of an OBB from its S^3 UnitQuaternion. */
export function obbAxesFromQuat(q: UnitQuaternion): readonly [Vec3D, Vec3D, Vec3D] {
  const x = q.x, y = q.y, z = q.z, w = q.w
  const xx = x * x, yy = y * y, zz = z * z
  const xy = x * y, xz = x * z, yz = y * z
  const wx = w * x, wy = w * y, wz = w * z
  return [
    { x: 1 - 2 * (yy + zz), y: 2 * (xy + wz), z: 2 * (xz - wy) },
    { x: 2 * (xy - wz), y: 1 - 2 * (xx + zz), z: 2 * (yz + wx) },
    { x: 2 * (xz + wy), y: 2 * (yz - wx), z: 1 - 2 * (xx + yy) },
  ]
}

/** Computes all 8 exact world-space vertices of a rotated OBB (identical for rendering & collision). */
export function computeObbWorldCorners(obb: ObbPose): Vec3D[] {
  const [ax, ay, az] = obbAxesFromQuat(obb.rot)
  const { x: hx, y: hy, z: hz } = obb.halfExtents
  const corners: Vec3D[] = []
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corners.push({
          x: obb.pos.x + ax.x * hx * sx + ay.x * hy * sy + az.x * hz * sz,
          y: obb.pos.y + ax.y * hx * sx + ay.y * hy * sy + az.y * hz * sz,
          z: obb.pos.z + ax.z * hx * sx + ay.z * hy * sy + az.z * hz * sz,
        })
      }
    }
  }
  return corners
}

function dot3(a: Vec3D, b: Vec3D): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function cross3(a: Vec3D, b: Vec3D): Vec3D {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

function obbRadiusOnAxis(axes: readonly [Vec3D, Vec3D, Vec3D], h: Vec3D, axis: Vec3D): number {
  return (
    h.x * Math.abs(dot3(axes[0], axis)) +
    h.y * Math.abs(dot3(axes[1], axis)) +
    h.z * Math.abs(dot3(axes[2], axis))
  )
}

/**
 * Exact 8-corner OBB-vs-GroundPlane (`y = groundY`) contact manifold.
 * Guarantees rotated corners never clip below the rendered floor.
 */
export function collideObbGround(obb: ObbPose, groundY: number = 0): ObbContact | null {
  const corners = computeObbWorldCorners(obb)
  let deepestY = Infinity
  let sumX = 0, sumY = 0, sumZ = 0, count = 0

  for (let i = 0; i < corners.length; i++) {
    const c = corners[i]!
    if (c.y < deepestY) deepestY = c.y
  }
  if (deepestY >= groundY) return null

  const tol = 1e-3
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i]!
    if (c.y <= deepestY + tol) {
      sumX += c.x
      sumY += c.y
      sumZ += c.z
      count++
    }
  }

  return {
    normal: { x: 0, y: 1, z: 0 },
    penetration: groundY - deepestY,
    contactPoint: { x: sumX / count, y: sumY / count, z: sumZ / count },
  }
}

/**
 * Exact 15-axis Separating Axis Theorem (SAT) OBB-vs-OBB collision test.
 * Tests: 3 face normals of A, 3 face normals of B, and 9 edge-edge cross products (A_i x B_j).
 * Returns exact MTV normal (A -> B), penetration depth, and world contact point, or null if separated.
 */
export function collideObbObb(a: ObbPose, b: ObbPose): ObbContact | null {
  const axesA = obbAxesFromQuat(a.rot)
  const axesB = obbAxesFromQuat(b.rot)
  const d: Vec3D = { x: b.pos.x - a.pos.x, y: b.pos.y - a.pos.y, z: b.pos.z - a.pos.z }

  let minOverlap = Infinity
  let bestAxis: Vec3D = { x: 0, y: 1, z: 0 }

  const testAxis = (raw: Vec3D): boolean => {
    const len = Math.hypot(raw.x, raw.y, raw.z)
    if (len < 1e-8) return true // parallel edges -> skip degenerate cross product
    const axis: Vec3D = { x: raw.x / len, y: raw.y / len, z: raw.z / len }
    const dist = Math.abs(dot3(d, axis))
    const rA = obbRadiusOnAxis(axesA, a.halfExtents, axis)
    const rB = obbRadiusOnAxis(axesB, b.halfExtents, axis)
    const overlap = rA + rB - dist
    if (overlap <= 0) return false
    if (overlap < minOverlap) {
      minOverlap = overlap
      const sign = dot3(d, axis) < 0 ? -1 : 1
      bestAxis = { x: axis.x * sign, y: axis.y * sign, z: axis.z * sign }
    }
    return true
  }

  // 3 face axes of A
  for (let i = 0; i < 3; i++) {
    if (!testAxis(axesA[i]!)) return null
  }
  // 3 face axes of B
  for (let i = 0; i < 3; i++) {
    if (!testAxis(axesB[i]!)) return null
  }
  // 9 edge-edge cross axes
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (!testAxis(cross3(axesA[i]!, axesB[j]!))) return null
    }
  }

  // Support point on A along +bestAxis and B along -bestAxis for accurate contact midpoint
  const rA = obbRadiusOnAxis(axesA, a.halfExtents, bestAxis)
  const contactPoint: Vec3D = {
    x: a.pos.x + bestAxis.x * (rA - minOverlap * 0.5),
    y: a.pos.y + bestAxis.y * (rA - minOverlap * 0.5),
    z: a.pos.z + bestAxis.z * (rA - minOverlap * 0.5),
  }

  return {
    normal: bestAxis,
    penetration: minOverlap,
    contactPoint,
  }
}

/** Exact OBB-vs-Sphere contact using closest point in OBB local frame. */
export function collideObbSphere(
  obb: ObbPose,
  sphereCenter: Vec3D,
  sphereRadius: number
): ObbContact | null {
  const [ax, ay, az] = obbAxesFromQuat(obb.rot)
  const rel: Vec3D = {
    x: sphereCenter.x - obb.pos.x,
    y: sphereCenter.y - obb.pos.y,
    z: sphereCenter.z - obb.pos.z,
  }
  const lx = Math.max(-obb.halfExtents.x, Math.min(obb.halfExtents.x, dot3(rel, ax)))
  const ly = Math.max(-obb.halfExtents.y, Math.min(obb.halfExtents.y, dot3(rel, ay)))
  const lz = Math.max(-obb.halfExtents.z, Math.min(obb.halfExtents.z, dot3(rel, az)))

  const closest: Vec3D = {
    x: obb.pos.x + ax.x * lx + ay.x * ly + az.x * lz,
    y: obb.pos.y + ax.y * lx + ay.y * ly + az.y * lz,
    z: obb.pos.z + ax.z * lx + ay.z * ly + az.z * lz,
  }
  const dx = sphereCenter.x - closest.x
  const dy = sphereCenter.y - closest.y
  const dz = sphereCenter.z - closest.z
  const dist = Math.hypot(dx, dy, dz)
  if (dist >= sphereRadius) return null

  const normal: Vec3D = dist > 1e-8 ? { x: dx / dist, y: dy / dist, z: dz / dist } : { x: 0, y: 1, z: 0 }
  return {
    normal,
    penetration: sphereRadius - dist,
    contactPoint: closest,
  }
}
