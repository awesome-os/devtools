/**
 * @file sections/b8g-game-engine/asset-pipeline.mts
 * @description First-Class Section/Intersection Content-Addressed `.b8p` Asset Pipeline
 * with Mathematical Total Asset Closure Gate (`R ⊆ M ⟺ |R \ M| = 0`).
 *
 * Features:
 *   - Portable FNV-1a 64-bit content hashing (zero `node:crypto`, zero host globals)
 *   - Content-addressed `.b8p` asset blocks for `mesh`, `texture`, `asog4dgs`, `audio`, `shader`
 *   - Automatic binary deduplication + `.b8p` linear pack serialization/deserialization
 *   - `AssetManifestSection` & `B8gGameEngineSection` defined via `@awesome-os/stealify-schema`
 *   - Fail-fast `verifyAssetClosure`: proves R ⊆ M (0 missing assets, 0 hash mismatches)
 *
 * Strictly 100% portable: ZERO `node:*` imports, ZERO ambient host globals, `erasableSyntaxOnly: true`.
 */

import {
  defineIntersection,
  defineSection,
  f,
  p,
  s,
  type SectionDefinition,
} from './stealify-schema-shim.mts'

export type AssetKind = 'mesh' | 'texture' | 'asog4dgs' | 'audio' | 'shader'

export const B8P_ASSET_PACK_MAGIC = 0x31503842 // 'B8P1'
export const B8P_ASSET_PACK_VERSION = 1

const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV64_PRIME = 0x100000001b3n
const FNV64_MASK = 0xffffffffffffffffn

/**
 * Pure portable UTF-8 encoder (avoids any ambient host global dependency).
 */
export function encodeUtf8Portable(text: string): Uint8Array {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00)
        i += 1
      }
    }
    if (cp < 0x80) {
      bytes.push(cp)
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      )
    }
  }
  return new Uint8Array(bytes)
}

/**
 * Portable 64-bit FNV-1a hash returning a 16-character zero-padded lowercase hex digest.
 */
export function fnv64Bytes(data: Uint8Array): string {
  let hash = FNV64_OFFSET_BASIS
  for (let i = 0; i < data.length; i++) {
    hash ^= BigInt(data[i]!)
    hash = (hash * FNV64_PRIME) & FNV64_MASK
  }
  return hash.toString(16).padStart(16, '0')
}

export function fnv64String(text: string): string {
  return fnv64Bytes(encodeUtf8Portable(text))
}

// ============================================================================
// First-Class Stealify Section & Intersection Definitions
// ============================================================================

export const AssetManifestSection: SectionDefinition<any, any> = defineSection({
  id: 'b8g-asset-manifest',
  version: '1.0.0',
  layout: 'binary-packed',
  storage: { engine: 'b8g-cas' },
  substrate: s.uvsCas({ prefix: 'refs/b8p/assets' }),
  fields: {
    manifestId: f.string({ maxBytes: 64 }).primaryKey(),
    packHash: f.string({ maxBytes: 16 }).indexed(),
    assetCount: f.int32().default(0),
    uniqueBlockCount: f.int32().default(0),
    totalLogicalBytes: f.int32().default(0),
    uniqueStoredBytes: f.int32().default(0),
    dedupSavedBytes: f.int32().default(0),
    closureVerified: f.boolean().default(false),
    updatedAt: f.timestamp().default(() => Date.now()),
  },
  protocols: {
    manifestIn: p.input('b8g-mesh', '/dev/b8g_asset_manifest'),
    closureOut: p.output('b8g-mesh', '/dev/b8g_asset_closure'),
  },
})

export const B8gGameEngineSection: SectionDefinition<any, any> = defineSection({
  id: 'b8g-game-engine',
  version: '1.0.0',
  layout: 'arena-aligned',
  storage: { engine: 'memory-arena' },
  substrate: s.sabRing({ ringBytes: 65536 }),
  fields: {
    engineId: f.string({ maxBytes: 64 }).primaryKey(),
    worldSeed: f.int32().default(1337),
    activeSectors: f.int32().default(0),
    tier1Sectors: f.int32().default(0),
    tier2Sectors: f.int32().default(0),
    tier3Sectors: f.int32().default(0),
    activeEntities: f.int32().default(0),
    manifestPackHash: f.string({ maxBytes: 16 }).default('0000000000000000'),
    closureVerified: f.boolean().default(false),
    fixedDt: f.float64().default(1 / 60),
    simTick: f.int32().default(0),
    maxQuatNormError: f.float64().default(0),
    updatedAt: f.timestamp().default(() => Date.now()),
  },
  protocols: {
    frameInput: p.input('b8g-mesh', '/dev/b8g_game_engine_tick'),
    frameOutput: p.output('udp', 'b8g-game-engine-state'),
  },
})

export const B8gGameEngineIntersection = defineIntersection({
  id: 'b8g-game-engine-runtime',
  version: '1.0.0',
  layout: 'arena-aligned',
  storage: { engine: 'memory-arena' },
  sections: [B8gGameEngineSection, AssetManifestSection] as const,
})

// ============================================================================
// Content-Addressed `.b8p` Asset Pack & Manifest
// ============================================================================

export interface B8pAssetBlock {
  readonly hash64: string
  readonly kind: AssetKind
  readonly byteLength: number
  readonly bytes: Uint8Array
}

export interface AssetManifestEntry {
  readonly assetId: string
  readonly kind: AssetKind
  readonly hash64: string
  readonly byteLength: number
}

export interface AssetReference {
  readonly assetId: string
  readonly kind?: AssetKind
  readonly expectedHash64?: string
}

export interface AssetClosureFailureDetail {
  readonly assetId: string
  readonly reason: 'missing-in-manifest' | 'missing-cas-block' | 'kind-mismatch' | 'hash-mismatch'
  readonly expected?: string
  readonly actual?: string
}

export interface AssetClosureProof {
  readonly closed: true
  readonly requiredCount: number
  readonly manifestCount: number
  readonly uniqueBlockCount: number
  readonly missingCount: 0
  readonly closureDigest: string
}

export class AssetClosureError extends Error {
  public readonly missingAssets: readonly AssetClosureFailureDetail[]

  public constructor(missingAssets: readonly AssetClosureFailureDetail[]) {
    const summary = missingAssets
      .map((d) => `${d.assetId} (${d.reason}${d.expected ? `: expected=${d.expected}, actual=${d.actual ?? 'none'}` : ''})`)
      .join(', ')
    super(`AssetClosureError: Mathematical Total Asset Closure Gate failed (|R \\ M| = ${missingAssets.length}): ${summary}`)
    this.name = 'AssetClosureError'
    this.missingAssets = missingAssets
  }
}

export interface AssetPackStats {
  readonly assetCount: number
  readonly uniqueBlockCount: number
  readonly totalLogicalBytes: number
  readonly uniqueStoredBytes: number
  readonly dedupSavedBytes: number
  readonly dedupRatio: number
  readonly packHash: string
}

const KIND_TO_CODE: Record<AssetKind, number> = {
  mesh: 1,
  texture: 2,
  asog4dgs: 3,
  audio: 4,
  shader: 5,
}

const CODE_TO_KIND: Record<number, AssetKind> = {
  1: 'mesh',
  2: 'texture',
  3: 'asog4dgs',
  4: 'audio',
  5: 'shader',
}

/**
 * Content-addressed `.b8p` asset store & manifest builder.
 * Automatically deduplicates identical payloads across asset IDs by 64-bit FNV-1a digest.
 */
export class B8pAssetPipeline {
  public readonly manifestId: string
  private readonly blocks: Map<string, B8pAssetBlock>
  private readonly entries: Map<string, AssetManifestEntry>
  private totalLogicalBytes: number
  private uniqueStoredBytes: number

  public constructor(manifestId: string = 'default-world-manifest') {
    this.manifestId = manifestId
    this.blocks = new Map()
    this.entries = new Map()
    this.totalLogicalBytes = 0
    this.uniqueStoredBytes = 0
  }

  /**
   * Registers an asset into the content-addressed `.b8p` store.
   * Identical byte payloads share a single CAS block (`O(1)` dedup).
   */
  public registerAsset(assetId: string, kind: AssetKind, payload: Uint8Array): AssetManifestEntry {
    const hash64 = fnv64Bytes(payload)
    const previous = this.entries.get(assetId)
    if (previous) {
      this.totalLogicalBytes -= previous.byteLength
    }

    if (!this.blocks.has(hash64)) {
      const copy = new Uint8Array(payload.byteLength)
      copy.set(payload)
      this.blocks.set(hash64, {
        hash64,
        kind,
        byteLength: copy.byteLength,
        bytes: copy,
      })
      this.uniqueStoredBytes += copy.byteLength
    }

    const entry: AssetManifestEntry = {
      assetId,
      kind,
      hash64,
      byteLength: payload.byteLength,
    }
    this.entries.set(assetId, entry)
    this.totalLogicalBytes += payload.byteLength
    return entry
  }

  public getEntry(assetId: string): AssetManifestEntry | undefined {
    return this.entries.get(assetId)
  }

  public getBlock(hash64: string): B8pAssetBlock | undefined {
    return this.blocks.get(hash64)
  }

  public getAssetBytes(assetId: string): Uint8Array | undefined {
    const entry = this.entries.get(assetId)
    if (!entry) return undefined
    return this.blocks.get(entry.hash64)?.bytes
  }

  public listEntries(): AssetManifestEntry[] {
    return Array.from(this.entries.values())
  }

  public computePackHash(): string {
    const sorted = Array.from(this.entries.values()).sort((a, b) =>
      a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0
    )
    let acc = this.manifestId
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i]!
      acc += `|${e.assetId}:${e.kind}:${e.hash64}:${e.byteLength}`
    }
    return fnv64String(acc)
  }

  public getStats(): AssetPackStats {
    const dedupSavedBytes = Math.max(0, this.totalLogicalBytes - this.uniqueStoredBytes)
    const dedupRatio =
      this.totalLogicalBytes > 0 ? this.uniqueStoredBytes / this.totalLogicalBytes : 1.0
    return {
      assetCount: this.entries.size,
      uniqueBlockCount: this.blocks.size,
      totalLogicalBytes: this.totalLogicalBytes,
      uniqueStoredBytes: this.uniqueStoredBytes,
      dedupSavedBytes,
      dedupRatio,
      packHash: this.computePackHash(),
    }
  }

  /**
   * Serializes all unique `.b8p` CAS blocks into a compact binary `.b8p` pack buffer.
   * Layout:
   *   [0..15] Header: magic ('B8P1'), version (1), blockCount, reserved (0)
   *   For each block:
   *     [0..7]   hash64 (uint64 LE)
   *     [8..11]  kindCode (uint32 LE)
   *     [12..15] byteLength (uint32 LE)
   *     [16..16+byteLength-1] payload bytes
   */
  public encodeB8pPack(): Uint8Array {
    const blockList = Array.from(this.blocks.values()).sort((a, b) =>
      a.hash64 < b.hash64 ? -1 : a.hash64 > b.hash64 ? 1 : 0
    )
    let totalBytes = 16
    for (let i = 0; i < blockList.length; i++) {
      totalBytes += 16 + blockList[i]!.byteLength
    }
    const out = new Uint8Array(totalBytes)
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
    view.setUint32(0, B8P_ASSET_PACK_MAGIC, true)
    view.setUint32(4, B8P_ASSET_PACK_VERSION, true)
    view.setUint32(8, blockList.length, true)
    view.setUint32(12, 0, true)

    let offset = 16
    for (let i = 0; i < blockList.length; i++) {
      const blk = blockList[i]!
      view.setBigUint64(offset, BigInt(`0x${blk.hash64}`), true)
      view.setUint32(offset + 8, KIND_TO_CODE[blk.kind], true)
      view.setUint32(offset + 12, blk.byteLength, true)
      out.set(blk.bytes, offset + 16)
      offset += 16 + blk.byteLength
    }
    return out
  }

  /**
   * Decodes a binary `.b8p` pack buffer back into a map of verified `B8pAssetBlock`s.
   */
  public static decodeB8pPack(packBytes: Uint8Array): Map<string, B8pAssetBlock> {
    if (packBytes.byteLength < 16) {
      throw new Error('Invalid .b8p pack: truncated header')
    }
    const view = new DataView(packBytes.buffer, packBytes.byteOffset, packBytes.byteLength)
    const magic = view.getUint32(0, true)
    if (magic !== B8P_ASSET_PACK_MAGIC) {
      throw new Error(`Invalid .b8p pack magic: 0x${magic.toString(16)}`)
    }
    const count = view.getUint32(8, true)
    const decoded = new Map<string, B8pAssetBlock>()
    let offset = 16
    for (let i = 0; i < count; i++) {
      const hashBig = view.getBigUint64(offset, true)
      const hash64 = hashBig.toString(16).padStart(16, '0')
      const kindCode = view.getUint32(offset + 8, true)
      const byteLength = view.getUint32(offset + 12, true)
      const kind = CODE_TO_KIND[kindCode]
      if (!kind) {
        throw new Error(`Invalid .b8p block kind code: ${kindCode}`)
      }
      const bytes = packBytes.slice(offset + 16, offset + 16 + byteLength)
      const actualHash = fnv64Bytes(bytes)
      if (actualHash !== hash64) {
        throw new Error(`Corrupt .b8p block ${hash64}: recomputed hash ${actualHash}`)
      }
      decoded.set(hash64, { hash64, kind, byteLength, bytes })
      offset += 16 + byteLength
    }
    return decoded
  }
}

/**
 * Mathematical Total Asset Closure Gate:
 *   R ⊆ M  ⟺  |R \ M| = 0
 *
 * Verifies that every required asset reference `r ∈ R` exists in the manifest `M`,
 * matches any expected asset kind and `.b8p` FNV-64 hash, and resolves to a live
 * content-addressed `.b8p` block in the pipeline store.
 *
 * Throws `AssetClosureError` immediately if `|R \ M| > 0` so a game build can never
 * ship a missing or corrupted asset.
 */
export function verifyAssetClosure(
  requiredRefs: readonly (string | AssetReference)[],
  pipeline: B8pAssetPipeline
): AssetClosureProof {
  const failures: AssetClosureFailureDetail[] = []
  let digestInput = pipeline.computePackHash()

  for (let i = 0; i < requiredRefs.length; i++) {
    const raw = requiredRefs[i]!
    const ref: AssetReference = typeof raw === 'string' ? { assetId: raw } : raw
    const entry = pipeline.getEntry(ref.assetId)
    if (!entry) {
      failures.push({ assetId: ref.assetId, reason: 'missing-in-manifest' })
      continue
    }
    if (ref.kind !== undefined && entry.kind !== ref.kind) {
      failures.push({
        assetId: ref.assetId,
        reason: 'kind-mismatch',
        expected: ref.kind,
        actual: entry.kind,
      })
      continue
    }
    if (ref.expectedHash64 !== undefined && entry.hash64 !== ref.expectedHash64) {
      failures.push({
        assetId: ref.assetId,
        reason: 'hash-mismatch',
        expected: ref.expectedHash64,
        actual: entry.hash64,
      })
      continue
    }
    const block = pipeline.getBlock(entry.hash64)
    if (!block) {
      failures.push({
        assetId: ref.assetId,
        reason: 'missing-cas-block',
        expected: entry.hash64,
      })
      continue
    }
    digestInput += `|${entry.assetId}=${entry.hash64}`
  }

  if (failures.length > 0) {
    throw new AssetClosureError(failures)
  }

  const stats = pipeline.getStats()
  return {
    closed: true,
    requiredCount: requiredRefs.length,
    manifestCount: stats.assetCount,
    uniqueBlockCount: stats.uniqueBlockCount,
    missingCount: 0,
    closureDigest: fnv64String(digestInput),
  }
}
