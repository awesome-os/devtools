/**
 * @file sections/b8g-game-engine/b8g-world.mts
 * @description Unified, Scriptable `B8gWorld` Scene Graph + Live Hot-Reload Scripting +
 * Deterministic `O(Δ)` Binary State-Delta Multiplayer Replication.
 *
 * Unifies:
 *   - `./world-streaming.mts` (`WorldStreamingEngine`, 3-tier bubble + `B8G_ARENA_V1` O(1) purge)
 *   - `./asset-pipeline.mts`  (`B8pAssetPipeline` + Mathematical Total Asset Closure `verifyAssetClosure`)
 *   - `./physics-locomotion.mts` (`RigidBodyWorld`, `RigidBody`, `UnitQuaternion`, `ProceduralTerrain`)
 *
 * Strictly 100% portable: ZERO `node:*` imports, ZERO ambient host globals, `erasableSyntaxOnly: true`.
 */

import {
  WorldStreamingEngine,
  type StreamingTickReport,
  type Vec3,
  type WorldStreamingConfig,
} from './world-streaming.mts'
import {
  B8pAssetPipeline,
  verifyAssetClosure,
  type AssetClosureProof,
  type AssetKind,
  type AssetManifestEntry,
  type AssetReference,
} from './asset-pipeline.mts'
import {
  ProceduralTerrain,
  RigidBody,
  RigidBodyWorld,
  UnitQuaternion,
} from './physics-locomotion.mts'

export const B8G_DELTA_PACKET_MAGIC = 0x44384231 // '1B8D'
export const B8G_DELTA_HEADER_BYTES = 16
export const B8G_DELTA_RECORD_BYTES = 32 // uint32 netId + 7 x float32 (px, py, pz, qw, qx, qy, qz)
export const DEFAULT_DELTA_EPSILON = 1e-4

export type Vec3Like = Vec3 | readonly [number, number, number]

export interface ScriptStepContext {
  readonly world: B8gWorld
  readonly tick: number
  readonly dt: number
  readonly cameraPos: Vec3
  readonly cameraVel: Vec3
}

export type EntityScriptFn = (entity: B8gEntity, dt: number, ctx: ScriptStepContext) => void

export interface ScriptErrorRecord {
  readonly tick: number
  readonly entityId: string
  readonly message: string
}

export interface SpawnEntityOptions {
  readonly id?: string
  readonly netId?: number
  readonly assetId?: string
  readonly pos?: Vec3Like
  readonly vel?: Vec3Like
  readonly angVel?: Vec3Like
  readonly orientation?: UnitQuaternion
  readonly mass?: number
  readonly radius?: number
  readonly buoyancyVolume?: number
  readonly linearDamping?: number
  readonly angularDamping?: number
  readonly restitution?: number
  readonly friction?: number
  readonly isStatic?: boolean
  readonly tags?: readonly string[]
  readonly data?: Record<string, unknown>
  readonly onTick?: EntityScriptFn
}

export interface B8gWorldConfig {
  readonly manifestId?: string
  readonly streaming?: Partial<WorldStreamingConfig>
  readonly fixedDt?: number
  readonly gravity?: number
  readonly waterDensity?: number
  readonly terrain?: ProceduralTerrain
  readonly deltaEpsilon?: number
  readonly verifyAssetsOnSpawn?: boolean
}

export interface WorldStepReport {
  readonly tick: number
  readonly dt: number
  readonly streaming: StreamingTickReport
  readonly physicsSubSteps: number
  readonly scriptsExecuted: number
  readonly scriptErrors: readonly ScriptErrorRecord[]
  readonly changedEntityCount: number
  readonly totalEntityCount: number
}

export interface StateDeltaApplyReport {
  readonly tick: number
  readonly sinceTick: number
  readonly packetBytes: number
  readonly recordCount: number
  readonly appliedCount: number
  readonly skippedCount: number
}

function normalizeVec3(input: Vec3Like | undefined, fallbackX: number, fallbackY: number, fallbackZ: number): Vec3 {
  if (!input) {
    return { x: fallbackX, y: fallbackY, z: fallbackZ }
  }
  if (Array.isArray(input)) {
    return {
      x: input[0] ?? fallbackX,
      y: input[1] ?? fallbackY,
      z: input[2] ?? fallbackZ,
    }
  }
  const vec = input as Vec3
  return { x: vec.x, y: vec.y, z: vec.z }
}

/**
 * First-class entity inside `B8gWorld`, binding a physics `RigidBody`, optional `.b8p` asset reference,
 * live hot-swappable `onTick` script, and delta-replication baseline.
 */
export class B8gEntity {
  public readonly id: string
  public readonly netId: number
  public readonly assetId: string | undefined
  public readonly body: RigidBody
  public readonly isStatic: boolean
  public readonly streamingEntityId: number
  public readonly tags: Set<string>
  public readonly data: Record<string, unknown>
  public onTick: EntityScriptFn | undefined
  public scriptVersion: number
  public lastError: string | undefined

  // Replicated transform baseline for O(Δ) change detection
  public lastPx: number
  public lastPy: number
  public lastPz: number
  public lastQw: number
  public lastQx: number
  public lastQy: number
  public lastQz: number
  public lastChangedTick: number

  public constructor(
    id: string,
    netId: number,
    assetId: string | undefined,
    body: RigidBody,
    isStatic: boolean,
    streamingEntityId: number,
    onTick: EntityScriptFn | undefined,
    initialTick: number,
    tags?: readonly string[],
    data?: Record<string, unknown>
  ) {
    this.id = id
    this.netId = netId
    this.assetId = assetId
    this.body = body
    this.isStatic = isStatic
    this.streamingEntityId = streamingEntityId
    this.tags = new Set(tags ?? [])
    this.data = data ? { ...data } : {}
    this.onTick = onTick
    this.scriptVersion = onTick ? 1 : 0
    this.lastError = undefined

    this.lastPx = body.px
    this.lastPy = body.py
    this.lastPz = body.pz
    this.lastQw = body.orientation.w
    this.lastQx = body.orientation.x
    this.lastQy = body.orientation.y
    this.lastQz = body.orientation.z
    this.lastChangedTick = initialTick
  }

  public get x(): number {
    return this.body.px
  }

  public set x(v: number) {
    this.body.px = v
  }

  public get y(): number {
    return this.body.py
  }

  public set y(v: number) {
    this.body.py = v
  }

  public get z(): number {
    return this.body.pz
  }

  public set z(v: number) {
    this.body.pz = v
  }

  public get vx(): number {
    return this.body.vx
  }

  public set vx(v: number) {
    this.body.vx = v
  }

  public get vy(): number {
    return this.body.vy
  }

  public set vy(v: number) {
    this.body.vy = v
  }

  public get vz(): number {
    return this.body.vz
  }

  public set vz(v: number) {
    this.body.vz = v
  }

  public get wx(): number {
    return this.body.wx
  }

  public set wx(v: number) {
    this.body.wx = v
  }

  public get wy(): number {
    return this.body.wy
  }

  public set wy(v: number) {
    this.body.wy = v
  }

  public get wz(): number {
    return this.body.wz
  }

  public set wz(v: number) {
    this.body.wz = v
  }

  public get orientation(): UnitQuaternion {
    return this.body.orientation
  }

  public get pos(): Vec3 {
    return { x: this.body.px, y: this.body.py, z: this.body.pz }
  }

  public get vel(): Vec3 {
    return { x: this.body.vx, y: this.body.vy, z: this.body.vz }
  }

  public setPos(x: number, y: number, z: number): this {
    this.body.px = x
    this.body.py = y
    this.body.pz = z
    return this
  }

  public moveBy(dx: number, dy: number, dz: number): this {
    this.body.px += dx
    this.body.py += dy
    this.body.pz += dz
    return this
  }

  public applyImpulse(ix: number, iy: number, iz: number): this {
    this.body.vx += ix * this.body.invMass
    this.body.vy += iy * this.body.invMass
    this.body.vz += iz * this.body.invMass
    return this
  }

  public spin(wx: number, wy: number, wz: number): this {
    this.body.wx = wx
    this.body.wy = wy
    this.body.wz = wz
    return this
  }

  /**
   * Computes whether this entity's position or unit quaternion has diverged beyond `epsilon`
   * from its last committed delta baseline (handling S^3 double-cover `q` vs `-q`).
   */
  public hasTransformChangedBeyond(epsilon: number): boolean {
    const b = this.body
    if (
      Math.abs(b.px - this.lastPx) > epsilon ||
      Math.abs(b.py - this.lastPy) > epsilon ||
      Math.abs(b.pz - this.lastPz) > epsilon
    ) {
      return true
    }

    const q = b.orientation
    const dot = q.w * this.lastQw + q.x * this.lastQx + q.y * this.lastQy + q.z * this.lastQz
    const sign = dot < 0 ? -1.0 : 1.0
    if (
      Math.abs(q.w - sign * this.lastQw) > epsilon ||
      Math.abs(q.x - sign * this.lastQx) > epsilon ||
      Math.abs(q.y - sign * this.lastQy) > epsilon ||
      Math.abs(q.z - sign * this.lastQz) > epsilon
    ) {
      return true
    }
    return false
  }

  /**
   * Commits the entity's current transform as its new delta-replication baseline.
   */
  public commitTransformBaseline(tick: number): void {
    const b = this.body
    this.lastPx = b.px
    this.lastPy = b.py
    this.lastPz = b.pz
    this.lastQw = b.orientation.w
    this.lastQx = b.orientation.x
    this.lastQy = b.orientation.y
    this.lastQz = b.orientation.z
    this.lastChangedTick = tick
  }
}

/**
 * Unified, Scriptable `B8gWorld` Scene Graph + Hot-Reload Scripting + Binary State-Delta Replication.
 */
export class B8gWorld {
  public readonly streaming: WorldStreamingEngine
  public readonly assets: B8pAssetPipeline
  public readonly physics: RigidBodyWorld
  public readonly terrain: ProceduralTerrain | undefined
  public readonly deltaEpsilon: number
  public readonly verifyAssetsOnSpawn: boolean

  private readonly entitiesById: Map<string, B8gEntity>
  private readonly entitiesByNetId: Map<number, B8gEntity>
  private readonly entityList: B8gEntity[]
  private tickCounter: number
  private nextAutoId: number
  private nextNetId: number

  public constructor(config?: B8gWorldConfig) {
    this.streaming = new WorldStreamingEngine(config?.streaming)
    this.assets = new B8pAssetPipeline(config?.manifestId ?? 'b8g-world-manifest')
    this.physics = new RigidBodyWorld(
      config?.fixedDt ?? 1 / 60,
      config?.gravity ?? 9.81,
      config?.waterDensity ?? 1000.0
    )
    this.terrain = config?.terrain
    this.deltaEpsilon = config?.deltaEpsilon ?? DEFAULT_DELTA_EPSILON
    this.verifyAssetsOnSpawn = config?.verifyAssetsOnSpawn ?? false

    this.entitiesById = new Map()
    this.entitiesByNetId = new Map()
    this.entityList = []
    this.tickCounter = 0
    this.nextAutoId = 1
    this.nextNetId = 1
  }

  public get tick(): number {
    return this.tickCounter
  }

  public get entityCount(): number {
    return this.entityList.length
  }

  public getEntity(entityId: string): B8gEntity | undefined {
    return this.entitiesById.get(entityId)
  }

  public getEntityByNetId(netId: number): B8gEntity | undefined {
    return this.entitiesByNetId.get(netId)
  }

  public listEntities(): readonly B8gEntity[] {
    return this.entityList
  }

  /**
   * Registers a content-addressed `.b8p` asset into the world's asset pipeline.
   */
  public registerAsset(assetId: string, kind: AssetKind, payload: Uint8Array): AssetManifestEntry {
    return this.assets.registerAsset(assetId, kind, payload)
  }

  /**
   * Runs the Mathematical Total Asset Closure Gate (`R ⊆ M ⟺ |R \ M| = 0`) across every
   * asset referenced by spawned entities (plus any optional extra references).
   */
  public verifyAssets(extraRefs?: readonly (string | AssetReference)[]): AssetClosureProof {
    const required: (string | AssetReference)[] = []
    const seen = new Set<string>()

    for (let i = 0; i < this.entityList.length; i++) {
      const assetId = this.entityList[i]!.assetId
      if (assetId !== undefined && !seen.has(assetId)) {
        seen.add(assetId)
        required.push(assetId)
      }
    }

    if (extraRefs) {
      for (let i = 0; i < extraRefs.length; i++) {
        required.push(extraRefs[i]!)
      }
    }

    return verifyAssetClosure(required, this.assets)
  }

  /**
   * Spawns a new entity into the unified scene graph, streaming arena, and physics world.
   */
  public spawn(options: SpawnEntityOptions = {}): B8gEntity {
    const id = options.id ?? `entity_${this.nextAutoId++}`
    if (this.entitiesById.has(id)) {
      throw new Error(`Entity already exists with id "${id}"`)
    }

    if (this.verifyAssetsOnSpawn && options.assetId !== undefined) {
      verifyAssetClosure([options.assetId], this.assets)
    }

    const netId = options.netId !== undefined ? options.netId >>> 0 : this.nextNetId++
    if (this.entitiesByNetId.has(netId)) {
      throw new Error(`Entity already exists with netId ${netId}`)
    }
    if (netId >= this.nextNetId) {
      this.nextNetId = netId + 1
    }

    const pos = normalizeVec3(options.pos, 0, 0, 0)
    const vel = normalizeVec3(options.vel, 0, 0, 0)
    const angVel = normalizeVec3(options.angVel, 0, 0, 0)
    const isStatic = options.isStatic === true || options.mass === 0

    const body = new RigidBody(pos.x, pos.y, pos.z, {
      mass: isStatic ? 1.0 : options.mass,
      radius: options.radius,
      buoyancyVolume: options.buoyancyVolume,
      linearDamping: options.linearDamping,
      angularDamping: options.angularDamping,
      restitution: options.restitution,
      friction: options.friction,
    })
    body.vx = vel.x
    body.vy = vel.y
    body.vz = vel.z
    body.wx = angVel.x
    body.wy = angVel.y
    body.wz = angVel.z

    if (options.orientation) {
      body.orientation.w = options.orientation.w
      body.orientation.x = options.orientation.x
      body.orientation.y = options.orientation.y
      body.orientation.z = options.orientation.z
      body.orientation.normalize()
    }

    if (!isStatic) {
      this.physics.addBody(body)
    }

    const streamingEntityId = this.streaming.spawnEntity(
      pos.x,
      pos.y,
      pos.z,
      vel.x,
      vel.y,
      vel.z,
      isStatic ? 0 : 1
    )

    const entity = new B8gEntity(
      id,
      netId,
      options.assetId,
      body,
      isStatic,
      streamingEntityId,
      options.onTick,
      this.tickCounter,
      options.tags,
      options.data
    )

    this.entitiesById.set(id, entity)
    this.entitiesByNetId.set(netId, entity)
    this.entityList.push(entity)
    return entity
  }

  /**
   * Removes an entity from the scene graph and physics world.
   */
  public despawn(entityId: string): boolean {
    const entity = this.entitiesById.get(entityId)
    if (!entity) return false

    this.entitiesById.delete(entityId)
    this.entitiesByNetId.delete(entity.netId)

    const idx = this.entityList.indexOf(entity)
    if (idx !== -1) {
      this.entityList.splice(idx, 1)
    }

    if (!entity.isStatic) {
      const bIdx = this.physics.bodies.indexOf(entity.body)
      if (bIdx !== -1) {
        this.physics.bodies.splice(bIdx, 1)
      }
    }
    return true
  }

  /**
   * Live hot-swaps an entity's `onTick` behavior script WITHOUT losing position, velocity,
   * angular velocity, orientation, physics state, or custom `entity.data`.
   */
  public hotSwapScript(entityId: string, newOnTick: EntityScriptFn | undefined): B8gEntity {
    const entity = this.entitiesById.get(entityId)
    if (!entity) {
      throw new Error(`Cannot hot-swap script: entity "${entityId}" not found`)
    }
    entity.onTick = newOnTick
    entity.scriptVersion += 1
    entity.lastError = undefined
    return entity
  }

  /**
   * Advances the entire world by `dt` seconds:
   *   1. Updates the 3-tier predictive streaming bubble around `(cameraPos, cameraVel)`.
   *   2. Executes every entity's `onTick` script safely with per-entity error isolation.
   *   3. Steps the fixed-timestep `S^3` rigid-body physics integrator.
   *   4. Tracks entities whose position or quaternion changed beyond `deltaEpsilon`.
   */
  public step(
    dt: number,
    cameraPos: Vec3 = { x: 0, y: 0, z: 0 },
    cameraVel: Vec3 = { x: 0, y: 0, z: 0 }
  ): WorldStepReport {
    this.tickCounter += 1
    const tick = this.tickCounter

    // 1. Streaming bubble update
    const streaming = this.streaming.updateStreamingBubble(cameraPos, cameraVel, dt)

    // 2. Entity scripts with per-entity error isolation
    const scriptErrors: ScriptErrorRecord[] = []
    let scriptsExecuted = 0
    const ctx: ScriptStepContext = {
      world: this,
      tick,
      dt,
      cameraPos,
      cameraVel,
    }

    for (let i = 0; i < this.entityList.length; i++) {
      const entity = this.entityList[i]!
      const fn = entity.onTick
      if (!fn) continue
      scriptsExecuted += 1
      try {
        fn(entity, dt, ctx)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        entity.lastError = message
        scriptErrors.push({ tick, entityId: entity.id, message })
      }
    }

    // 3. Fixed-timestep S^3 rigid-body physics integration
    const physicsSubSteps = this.physics.step(dt, this.terrain)

    // 4. Delta change detection beyond epsilon (1e-4)
    let changedEntityCount = 0
    const eps = this.deltaEpsilon
    for (let i = 0; i < this.entityList.length; i++) {
      const entity = this.entityList[i]!
      if (entity.hasTransformChangedBeyond(eps)) {
        entity.commitTransformBaseline(tick)
        changedEntityCount += 1
      }
    }

    return {
      tick,
      dt,
      streaming,
      physicsSubSteps,
      scriptsExecuted,
      scriptErrors,
      changedEntityCount,
      totalEntityCount: this.entityList.length,
    }
  }

  /**
   * Encodes ONLY entities whose position or quaternion changed beyond `deltaEpsilon` since
   * `sinceTick` into a compact, deterministic binary `Uint8Array` packet (`O(Δ)` bandwidth).
   *
   * Pass `sinceTick = -1` (or call `encodeFullSnapshot()`) to emit a full baseline snapshot.
   */
  public encodeStateDelta(sinceTick: number = 0): Uint8Array {
    const eps = this.deltaEpsilon
    const dirty: B8gEntity[] = []

    for (let i = 0; i < this.entityList.length; i++) {
      const entity = this.entityList[i]!
      if (entity.hasTransformChangedBeyond(eps)) {
        const bumpTick = this.tickCounter > sinceTick ? this.tickCounter : sinceTick + 1
        entity.commitTransformBaseline(bumpTick)
      }
      if (entity.lastChangedTick > sinceTick) {
        dirty.push(entity)
      }
    }

    // Deterministic ordering by uint32 netId
    dirty.sort((a, b) => a.netId - b.netId)

    const byteLength = B8G_DELTA_HEADER_BYTES + dirty.length * B8G_DELTA_RECORD_BYTES
    const packet = new Uint8Array(byteLength)
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)

    view.setUint32(0, B8G_DELTA_PACKET_MAGIC, true)
    view.setUint32(4, this.tickCounter >>> 0, true)
    view.setInt32(8, sinceTick | 0, true)
    view.setUint32(12, dirty.length >>> 0, true)

    let offset = B8G_DELTA_HEADER_BYTES
    for (let i = 0; i < dirty.length; i++) {
      const e = dirty[i]!
      const b = e.body
      const q = b.orientation
      view.setUint32(offset + 0, e.netId >>> 0, true)
      view.setFloat32(offset + 4, b.px, true)
      view.setFloat32(offset + 8, b.py, true)
      view.setFloat32(offset + 12, b.pz, true)
      view.setFloat32(offset + 16, q.w, true)
      view.setFloat32(offset + 20, q.x, true)
      view.setFloat32(offset + 24, q.y, true)
      view.setFloat32(offset + 28, q.z, true)
      offset += B8G_DELTA_RECORD_BYTES
    }

    return packet
  }

  /**
   * Encodes a full binary snapshot of all entities in the world (equivalent to `encodeStateDelta(-1)`).
   */
  public encodeFullSnapshot(): Uint8Array {
    return this.encodeStateDelta(-1)
  }

  /**
   * Applies a deterministic binary state-delta packet produced by `encodeStateDelta` onto this world.
   */
  public applyStateDelta(packet: Uint8Array): StateDeltaApplyReport {
    if (packet.byteLength < B8G_DELTA_HEADER_BYTES) {
      throw new Error(`Invalid B8gWorld delta packet: truncated header (${packet.byteLength} bytes)`)
    }
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
    const magic = view.getUint32(0, true)
    if (magic !== B8G_DELTA_PACKET_MAGIC) {
      throw new Error(`Invalid B8gWorld delta packet magic: 0x${magic.toString(16)}`)
    }

    const tick = view.getUint32(4, true)
    const sinceTick = view.getInt32(8, true)
    const recordCount = view.getUint32(12, true)
    const expectedBytes = B8G_DELTA_HEADER_BYTES + recordCount * B8G_DELTA_RECORD_BYTES
    if (packet.byteLength < expectedBytes) {
      throw new Error(
        `Invalid B8gWorld delta packet: expected ${expectedBytes} bytes for ${recordCount} records, got ${packet.byteLength}`
      )
    }

    let appliedCount = 0
    let skippedCount = 0
    let offset = B8G_DELTA_HEADER_BYTES

    for (let i = 0; i < recordCount; i++) {
      const netId = view.getUint32(offset + 0, true)
      const px = view.getFloat32(offset + 4, true)
      const py = view.getFloat32(offset + 8, true)
      const pz = view.getFloat32(offset + 12, true)
      const qw = view.getFloat32(offset + 16, true)
      const qx = view.getFloat32(offset + 20, true)
      const qy = view.getFloat32(offset + 24, true)
      const qz = view.getFloat32(offset + 28, true)
      offset += B8G_DELTA_RECORD_BYTES

      const entity = this.entitiesByNetId.get(netId)
      if (!entity) {
        skippedCount += 1
        continue
      }

      entity.body.px = px
      entity.body.py = py
      entity.body.pz = pz
      entity.body.orientation.w = qw
      entity.body.orientation.x = qx
      entity.body.orientation.y = qy
      entity.body.orientation.z = qz
      entity.body.orientation.normalize()
      entity.commitTransformBaseline(tick)
      appliedCount += 1
    }

    if (tick > this.tickCounter) {
      this.tickCounter = tick
    }

    return {
      tick,
      sinceTick,
      packetBytes: packet.byteLength,
      recordCount,
      appliedCount,
      skippedCount,
    }
  }
}
