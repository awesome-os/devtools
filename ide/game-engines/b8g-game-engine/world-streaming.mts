/**
 * @file sections/b8g-game-engine/world-streaming.mts
 * @description Zero-Dependency Hierarchical World Streaming Engine for the B8G Holonomic Game Engine SDK.
 *
 * Features:
 *   - Hierarchical 3D spatial grid (`SectorCoord`, `WorldSector`)
 *   - Predictive camera-velocity vector prefetch (`updateStreamingBubble(pos, velocity, dt)`)
 *   - 3-tier simulation zoning (`Tier1_FullPhysics`, `Tier2_Simplified`, `Tier3_HorizonImposter`)
 *   - `B8G_ARENA_V1` `O(1)` sector purge (contiguous 64-byte aligned `ArrayBuffer` slabs zeroed
 *     and recycled through an `O(1)` free-list pool with zero per-entity GC churn).
 *
 * Strictly 100% portable: ZERO `node:*` imports, ZERO ambient host globals, `erasableSyntaxOnly: true`.
 */

export const B8G_ARENA_V1_MAGIC = 0x42384731 // 'B8G1'
export const B8G_ARENA_HEADER_BYTES = 64
export const B8G_ENTITY_STRIDE_BYTES = 64 // 8 x float64 (id, x, y, z, vx, vy, vz, flags)
export const B8G_ENTITY_STRIDE_F64 = 8

export const SimTier = {
  Tier1_FullPhysics: 1,
  Tier2_Simplified: 2,
  Tier3_HorizonImposter: 3,
} as const

export type SimTierCode = (typeof SimTier)[keyof typeof SimTier]
export type SimTierName = keyof typeof SimTier

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface SectorCoord {
  readonly sx: number
  readonly sy: number
  readonly sz: number
}

export interface WorldStreamingConfig {
  readonly sectorSize: number
  readonly tier1Radius: number
  readonly tier2Radius: number
  readonly tier3Radius: number
  readonly prefetchHorizonSeconds: number
  readonly prefetchCorridorRadius: number
  readonly maxEntitiesPerSector: number
  readonly slabPoolCapacity: number
  readonly verticalStreaming: boolean
}

export const DEFAULT_STREAMING_CONFIG: WorldStreamingConfig = {
  sectorSize: 64,
  tier1Radius: 1,
  tier2Radius: 2,
  tier3Radius: 3,
  prefetchHorizonSeconds: 2.0,
  prefetchCorridorRadius: 1,
  maxEntitiesPerSector: 256,
  slabPoolCapacity: 256,
  verticalStreaming: false,
}

export interface SectorArenaSlab {
  readonly slabId: number
  readonly buffer: ArrayBuffer
  readonly u8: Uint8Array
  readonly view: DataView
  readonly f64: Float64Array
  readonly maxEntities: number
  generation: number
}

export interface WorldSector {
  readonly key: string
  readonly coord: SectorCoord
  readonly slab: SectorArenaSlab
  tier: SimTierCode
  tierName: SimTierName
  prefetched: boolean
  entityCount: number
  lastTouchedTick: number
}

export interface StreamingTickReport {
  readonly tick: number
  readonly cameraSector: SectorCoord
  readonly predictedSector: SectorCoord
  readonly loadedSectors: number
  readonly newlyLoadedSectors: number
  readonly prefetchedSectors: number
  readonly purgedSectors: number
  readonly tier1Count: number
  readonly tier2Count: number
  readonly tier3Count: number
  readonly activeEntities: number
  readonly poolAvailableSlabs: number
  readonly totalPurgedBytes: number
}

/**
 * Deterministic canonical key for a 3D integer sector coordinate.
 */
export function sectorCoordKey(sx: number, sy: number, sz: number): string {
  return `${sx | 0}:${sy | 0}:${sz | 0}`
}

/**
 * Maps a world-space position to its enclosing `SectorCoord`.
 */
export function worldToSectorCoord(
  pos: Vec3,
  sectorSize: number,
  verticalStreaming: boolean = false
): SectorCoord {
  const inv = 1.0 / sectorSize
  return {
    sx: Math.floor(pos.x * inv),
    sy: verticalStreaming ? Math.floor(pos.y * inv) : 0,
    sz: Math.floor(pos.z * inv),
  }
}

/**
 * Maps a numeric simulation tier code to its canonical tier name.
 */
export function simTierName(tier: SimTierCode): SimTierName {
  if (tier === SimTier.Tier1_FullPhysics) return 'Tier1_FullPhysics'
  if (tier === SimTier.Tier2_Simplified) return 'Tier2_Simplified'
  return 'Tier3_HorizonImposter'
}

/**
 * `B8G_ARENA_V1` contiguous slab pool providing `O(1)` acquisition and `O(1)` zero-wipe purge.
 */
export class B8gArenaV1SlabPool {
  private readonly slabBytes: number
  private readonly maxEntitiesPerSlab: number
  private readonly maxPoolCapacity: number
  private readonly freeList: SectorArenaSlab[]
  private nextSlabId: number
  private totalAllocated: number
  private totalPurgedSlabs: number
  private totalPurgedBytes: number

  public constructor(maxEntitiesPerSlab: number = 256, maxPoolCapacity: number = 256) {
    this.maxEntitiesPerSlab = Math.max(1, maxEntitiesPerSlab | 0)
    this.maxPoolCapacity = Math.max(1, maxPoolCapacity | 0)
    const rawBytes = B8G_ARENA_HEADER_BYTES + this.maxEntitiesPerSlab * B8G_ENTITY_STRIDE_BYTES
    this.slabBytes = Math.ceil(rawBytes / 64) * 64
    this.freeList = []
    this.nextSlabId = 1
    this.totalAllocated = 0
    this.totalPurgedSlabs = 0
    this.totalPurgedBytes = 0
  }

  public get bytesPerSlab(): number {
    return this.slabBytes
  }

  public get availableCount(): number {
    return this.freeList.length
  }

  public get allocatedCount(): number {
    return this.totalAllocated
  }

  public get purgedSlabCount(): number {
    return this.totalPurgedSlabs
  }

  public get purgedByteCount(): number {
    return this.totalPurgedBytes
  }

  public prewarm(count: number): void {
    const target = Math.min(count | 0, this.maxPoolCapacity)
    while (this.freeList.length < target) {
      this.freeList.push(this.createFreshSlab())
    }
  }

  private createFreshSlab(): SectorArenaSlab {
    const buffer = new ArrayBuffer(this.slabBytes)
    const u8 = new Uint8Array(buffer)
    const view = new DataView(buffer)
    const f64 = new Float64Array(buffer, B8G_ARENA_HEADER_BYTES, this.maxEntitiesPerSlab * B8G_ENTITY_STRIDE_F64)
    const slab: SectorArenaSlab = {
      slabId: this.nextSlabId++,
      buffer,
      u8,
      view,
      f64,
      maxEntities: this.maxEntitiesPerSlab,
      generation: 0,
    }
    this.totalAllocated += 1
    return slab
  }

  /**
   * Acquires a 64-byte aligned `B8G_ARENA_V1` slab in `O(1)` time and stamps its header.
   */
  public acquire(sx: number, sy: number, sz: number, tier: SimTierCode): SectorArenaSlab {
    const slab = this.freeList.length > 0 ? this.freeList.pop()! : this.createFreshSlab()
    slab.generation += 1
    slab.view.setUint32(0, B8G_ARENA_V1_MAGIC, true)
    slab.view.setUint32(4, this.slabBytes, true)
    slab.view.setInt32(8, sx | 0, true)
    slab.view.setInt32(12, sy | 0, true)
    slab.view.setInt32(16, sz | 0, true)
    slab.view.setUint32(20, tier, true)
    slab.view.setUint32(24, 0, true) // entityCount = 0
    slab.view.setUint32(28, slab.generation >>> 0, true)
    return slab
  }

  /**
   * `O(1)` sector purge: zeroes the entire contiguous `B8G_ARENA_V1` slab in a single
   * vectorized `Uint8Array.fill(0)` pass and returns it to the free-list pool.
   */
  public purgeO1(slab: SectorArenaSlab): number {
    slab.u8.fill(0)
    slab.generation += 1
    this.totalPurgedSlabs += 1
    this.totalPurgedBytes += this.slabBytes
    if (this.freeList.length < this.maxPoolCapacity) {
      this.freeList.push(slab)
    }
    return this.slabBytes
  }
}

/**
 * Hierarchical 3-Tier World Streaming Controller with Predictive Velocity-Vector Prefetch
 * and `B8G_ARENA_V1` `O(1)` sector slab purging.
 */
export class WorldStreamingEngine {
  public readonly config: WorldStreamingConfig
  public readonly slabPool: B8gArenaV1SlabPool
  private readonly sectors: Map<string, WorldSector>
  private readonly desiredTiers: Map<string, { sx: number; sy: number; sz: number; tier: SimTierCode; prefetched: boolean }>
  private tickCounter: number
  private nextEntityId: number
  private lastPurgeCount: number

  public constructor(partialConfig?: Partial<WorldStreamingConfig>) {
    this.config = {
      sectorSize: partialConfig?.sectorSize ?? DEFAULT_STREAMING_CONFIG.sectorSize,
      tier1Radius: partialConfig?.tier1Radius ?? DEFAULT_STREAMING_CONFIG.tier1Radius,
      tier2Radius: partialConfig?.tier2Radius ?? DEFAULT_STREAMING_CONFIG.tier2Radius,
      tier3Radius: partialConfig?.tier3Radius ?? DEFAULT_STREAMING_CONFIG.tier3Radius,
      prefetchHorizonSeconds:
        partialConfig?.prefetchHorizonSeconds ?? DEFAULT_STREAMING_CONFIG.prefetchHorizonSeconds,
      prefetchCorridorRadius:
        partialConfig?.prefetchCorridorRadius ?? DEFAULT_STREAMING_CONFIG.prefetchCorridorRadius,
      maxEntitiesPerSector:
        partialConfig?.maxEntitiesPerSector ?? DEFAULT_STREAMING_CONFIG.maxEntitiesPerSector,
      slabPoolCapacity: partialConfig?.slabPoolCapacity ?? DEFAULT_STREAMING_CONFIG.slabPoolCapacity,
      verticalStreaming:
        partialConfig?.verticalStreaming ?? DEFAULT_STREAMING_CONFIG.verticalStreaming,
    }
    this.slabPool = new B8gArenaV1SlabPool(
      this.config.maxEntitiesPerSector,
      this.config.slabPoolCapacity
    )
    this.sectors = new Map()
    this.desiredTiers = new Map()
    this.tickCounter = 0
    this.nextEntityId = 1
    this.lastPurgeCount = 0
  }

  public get activeSectorCount(): number {
    return this.sectors.size
  }

  public get tick(): number {
    return this.tickCounter
  }

  public get lastPurgedSectorCount(): number {
    return this.lastPurgeCount
  }

  public getSector(sx: number, sy: number, sz: number): WorldSector | undefined {
    return this.sectors.get(sectorCoordKey(sx, sy, sz))
  }

  public listSectors(): WorldSector[] {
    return Array.from(this.sectors.values())
  }

  /**
   * Ensures a sector is resident in memory, acquiring a `B8G_ARENA_V1` slab if needed.
   */
  public ensureSector(
    sx: number,
    sy: number,
    sz: number,
    tier: SimTierCode = SimTier.Tier1_FullPhysics,
    prefetched: boolean = false
  ): WorldSector {
    const key = sectorCoordKey(sx, sy, sz)
    const existing = this.sectors.get(key)
    if (existing) {
      existing.tier = tier
      existing.tierName = simTierName(tier)
      existing.prefetched = prefetched
      existing.lastTouchedTick = this.tickCounter
      existing.slab.view.setUint32(20, tier, true)
      return existing
    }
    const slab = this.slabPool.acquire(sx, sy, sz, tier)
    const sector: WorldSector = {
      key,
      coord: { sx: sx | 0, sy: sy | 0, sz: sz | 0 },
      slab,
      tier,
      tierName: simTierName(tier),
      prefetched,
      entityCount: 0,
      lastTouchedTick: this.tickCounter,
    }
    this.sectors.set(key, sector)
    return sector
  }

  /**
   * Spawns an entity directly into its owning sector's `B8G_ARENA_V1` flat `Float64Array` slab.
   * Returns the assigned entity ID (or `-1` if the sector slab is full).
   */
  public spawnEntity(
    x: number,
    y: number,
    z: number,
    vx: number = 0,
    vy: number = 0,
    vz: number = 0,
    flags: number = 1
  ): number {
    const coord = worldToSectorCoord(
      { x, y, z },
      this.config.sectorSize,
      this.config.verticalStreaming
    )
    const sector = this.ensureSector(coord.sx, coord.sy, coord.sz, SimTier.Tier1_FullPhysics, false)
    if (sector.entityCount >= sector.slab.maxEntities) {
      return -1
    }
    const entityId = this.nextEntityId++
    const base = sector.entityCount * B8G_ENTITY_STRIDE_F64
    const f64 = sector.slab.f64
    f64[base + 0] = entityId
    f64[base + 1] = x
    f64[base + 2] = y
    f64[base + 3] = z
    f64[base + 4] = vx
    f64[base + 5] = vy
    f64[base + 6] = vz
    f64[base + 7] = flags
    sector.entityCount += 1
    sector.slab.view.setUint32(24, sector.entityCount, true)
    return entityId
  }

  /**
   * Explicitly purges a single sector in `O(1)` time by zeroing & recycling its `B8G_ARENA_V1` slab.
   */
  public purgeSectorO1(sx: number, sy: number, sz: number): number {
    const key = sectorCoordKey(sx, sy, sz)
    const sector = this.sectors.get(key)
    if (!sector) return 0
    this.sectors.delete(key)
    sector.entityCount = 0
    return this.slabPool.purgeO1(sector.slab)
  }

  /**
   * Updates the 3-tier streaming bubble around `pos` with predictive camera-velocity vector prefetch:
   *   1. Assigns concentric Tier 1 / Tier 2 / Tier 3 zones around `pos`.
   *   2. Marches along the velocity ray `pos + velocity * (t * horizon)` to prefetch sectors ahead
   *      of camera motion as warm `Tier2_Simplified` (`prefetched: true`) sectors.
   *   3. Purges every active sector outside the bubble + prefetch corridor in `O(1)` per sector.
   *   4. Advances entity kinematics according to each sector's assigned simulation tier.
   */
  public updateStreamingBubble(pos: Vec3, velocity: Vec3, dt: number): StreamingTickReport {
    this.tickCounter += 1
    this.desiredTiers.clear()

    const {
      sectorSize,
      tier1Radius,
      tier2Radius,
      tier3Radius,
      prefetchHorizonSeconds,
      prefetchCorridorRadius,
      verticalStreaming,
    } = this.config

    const camCoord = worldToSectorCoord(pos, sectorSize, verticalStreaming)
    const lookaheadTime = Math.max(prefetchHorizonSeconds, dt)
    const predictedPos: Vec3 = {
      x: pos.x + velocity.x * lookaheadTime,
      y: pos.y + velocity.y * lookaheadTime,
      z: pos.z + velocity.z * lookaheadTime,
    }
    const predictedCoord = worldToSectorCoord(predictedPos, sectorSize, verticalStreaming)

    const yMin = verticalStreaming ? -tier3Radius : 0
    const yMax = verticalStreaming ? tier3Radius : 0

    // 1. Concentric 3-tier bubble around current camera sector
    for (let dx = -tier3Radius; dx <= tier3Radius; dx++) {
      for (let dy = yMin; dy <= yMax; dy++) {
        for (let dz = -tier3Radius; dz <= tier3Radius; dz++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))
          let tier: SimTierCode
          if (dist <= tier1Radius) {
            tier = SimTier.Tier1_FullPhysics
          } else if (dist <= tier2Radius) {
            tier = SimTier.Tier2_Simplified
          } else {
            tier = SimTier.Tier3_HorizonImposter
          }
          const sx = camCoord.sx + dx
          const sy = camCoord.sy + dy
          const sz = camCoord.sz + dz
          this.desiredTiers.set(sectorCoordKey(sx, sy, sz), {
            sx,
            sy,
            sz,
            tier,
            prefetched: false,
          })
        }
      }
    }

    // 2. Predictive velocity-vector prefetch corridor ahead of camera trajectory
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z)
    if (speed > 1e-4) {
      const travelDist = speed * lookaheadTime
      const samples = Math.max(1, Math.min(32, Math.ceil(travelDist / (sectorSize * 0.5))))
      const pyMin = verticalStreaming ? -prefetchCorridorRadius : 0
      const pyMax = verticalStreaming ? prefetchCorridorRadius : 0

      for (let s = 1; s <= samples; s++) {
        const frac = s / samples
        const samplePos: Vec3 = {
          x: pos.x + velocity.x * lookaheadTime * frac,
          y: pos.y + velocity.y * lookaheadTime * frac,
          z: pos.z + velocity.z * lookaheadTime * frac,
        }
        const sc = worldToSectorCoord(samplePos, sectorSize, verticalStreaming)
        for (let dx = -prefetchCorridorRadius; dx <= prefetchCorridorRadius; dx++) {
          for (let dy = pyMin; dy <= pyMax; dy++) {
            for (let dz = -prefetchCorridorRadius; dz <= prefetchCorridorRadius; dz++) {
              const sx = sc.sx + dx
              const sy = sc.sy + dy
              const sz = sc.sz + dz
              const key = sectorCoordKey(sx, sy, sz)
              const existing = this.desiredTiers.get(key)
              if (!existing) {
                this.desiredTiers.set(key, {
                  sx,
                  sy,
                  sz,
                  tier: SimTier.Tier2_Simplified,
                  prefetched: true,
                })
              } else if (existing.tier === SimTier.Tier3_HorizonImposter) {
                // Promote horizon sectors in the velocity path to warm Tier 2 prefetch
                existing.tier = SimTier.Tier2_Simplified
                existing.prefetched = true
              }
            }
          }
        }
      }
    }

    // 3. O(1) purge sectors that left the bubble + prefetch corridor
    let purgedSectors = 0
    let totalPurgedBytes = 0
    for (const [key, sector] of this.sectors) {
      if (!this.desiredTiers.has(key)) {
        this.sectors.delete(key)
        sector.entityCount = 0
        totalPurgedBytes += this.slabPool.purgeO1(sector.slab)
        purgedSectors += 1
      }
    }
    this.lastPurgeCount = purgedSectors

    // 4. Load / update desired sectors
    let newlyLoadedSectors = 0
    let prefetchedSectors = 0
    let tier1Count = 0
    let tier2Count = 0
    let tier3Count = 0
    let activeEntities = 0

    for (const [key, spec] of this.desiredTiers) {
      let sector = this.sectors.get(key)
      if (!sector) {
        sector = this.ensureSector(spec.sx, spec.sy, spec.sz, spec.tier, spec.prefetched)
        newlyLoadedSectors += 1
      } else {
        sector.tier = spec.tier
        sector.tierName = simTierName(spec.tier)
        sector.prefetched = spec.prefetched
        sector.lastTouchedTick = this.tickCounter
        sector.slab.view.setUint32(20, spec.tier, true)
      }

      if (sector.prefetched) prefetchedSectors += 1
      if (sector.tier === SimTier.Tier1_FullPhysics) {
        tier1Count += 1
      } else if (sector.tier === SimTier.Tier2_Simplified) {
        tier2Count += 1
      } else {
        tier3Count += 1
      }

      // 5. Tier-scaled zero-GC flat-slab entity integration
      const count = sector.entityCount
      if (count > 0 && dt > 0) {
        const f64 = sector.slab.f64
        if (sector.tier === SimTier.Tier1_FullPhysics) {
          for (let i = 0; i < count; i++) {
            const base = i * B8G_ENTITY_STRIDE_F64
            f64[base + 1] += f64[base + 4] * dt
            f64[base + 2] += f64[base + 5] * dt
            f64[base + 3] += f64[base + 6] * dt
          }
        } else if (sector.tier === SimTier.Tier2_Simplified) {
          // Simplified half-rate kinematic integration
          if ((this.tickCounter & 1) === 0) {
            const dt2 = dt * 2.0
            for (let i = 0; i < count; i++) {
              const base = i * B8G_ENTITY_STRIDE_F64
              f64[base + 1] += f64[base + 4] * dt2
              f64[base + 2] += f64[base + 5] * dt2
              f64[base + 3] += f64[base + 6] * dt2
            }
          }
        }
        // Tier 3 (HorizonImposter): frozen imposters (zero physics cost)
      }
      activeEntities += count
    }

    return {
      tick: this.tickCounter,
      cameraSector: camCoord,
      predictedSector: predictedCoord,
      loadedSectors: this.sectors.size,
      newlyLoadedSectors,
      prefetchedSectors,
      purgedSectors,
      tier1Count,
      tier2Count,
      tier3Count,
      activeEntities,
      poolAvailableSlabs: this.slabPool.availableCount,
      totalPurgedBytes,
    }
  }
}
