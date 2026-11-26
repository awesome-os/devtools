/**
 * @file sections/b8g-game-engine/glb-ingestor.mts
 * @description Zero-dependency binary glTF 2.0 (`.glb`) parser & sub-asset `.b8p` CAS
 * deduplicating ingestor for CC0 libraries (Kenney, Quaternius, KayKit, Poly Haven, Khronos).
 *
 * Strictly portable: zero `node:*` imports, zero ambient host authority (`B8G012`/`B8G013` clean).
 */

import {
  B8pAssetPipeline,
  fnv64String,
  verifyAssetClosure,
  type AssetClosureProof,
  type AssetKind,
  type AssetReference,
} from './asset-pipeline.mts'

export const GLB_MAGIC = 0x46546c67 // "glTF"
export const GLB_VERSION_2 = 2
export const GLB_CHUNK_JSON = 0x4e4f534a // "JSON"
export const GLB_CHUNK_BIN = 0x004e4942 // "BIN\0"

export interface GlbBufferView {
  readonly buffer: number
  readonly byteOffset?: number
  readonly byteLength: number
}

export interface GlbImage {
  readonly name?: string
  readonly mimeType?: string
  readonly bufferView?: number
  readonly uri?: string
}

export interface GlbDocumentJson {
  readonly asset?: { readonly version?: string; readonly generator?: string }
  readonly meshes?: readonly { readonly name?: string; readonly primitives?: readonly unknown[] }[]
  readonly materials?: readonly { readonly name?: string }[]
  readonly images?: readonly GlbImage[]
  readonly skins?: readonly { readonly name?: string; readonly joints?: readonly number[] }[]
  readonly animations?: readonly { readonly name?: string; readonly channels?: readonly unknown[] }[]
  readonly bufferViews?: readonly GlbBufferView[]
}

export interface ParsedGlb {
  readonly version: number
  readonly totalBytes: number
  readonly json: GlbDocumentJson
  readonly bin: Uint8Array
  readonly meshCount: number
  readonly materialCount: number
  readonly imageCount: number
  readonly skinCount: number
  readonly animationCount: number
}

export interface GlbIngestInput {
  readonly assetId: string
  readonly packSource: 'kenney' | 'quaternius' | 'kaykit' | 'polyhaven' | 'khronos' | 'custom'
  readonly license: 'CC0-1.0' | 'MIT' | 'Apache-2.0'
  readonly bytes: Uint8Array
}

export interface GlbIngestReport {
  readonly assetsIngested: number
  readonly totalInputBytes: number
  readonly uniqueStoredBytes: number
  readonly bytesSavedByDedup: number
  readonly dedupRatioPct: number
  readonly uniqueBlocks: number
  readonly totalSubBlocks: number
  readonly skinsDetected: number
  readonly animationsDetected: number
  readonly closureProof: AssetClosureProof
  readonly references: readonly AssetReference[]
  readonly store: B8pAssetPipeline
}

/** Parses a standard binary glTF 2.0 (`.glb`) buffer with zero external dependencies. */
export function parseGlb(bytes: Uint8Array): ParsedGlb {
  if (bytes.byteLength < 20) {
    throw new Error(`Invalid GLB: file too small (${bytes.byteLength} bytes)`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint32(0, true)
  const version = view.getUint32(4, true)
  const totalBytes = view.getUint32(8, true)

  if (magic !== GLB_MAGIC) {
    throw new Error(`Invalid GLB magic: 0x${magic.toString(16)} (expected 0x46546c67)`)
  }
  if (version !== GLB_VERSION_2) {
    throw new Error(`Unsupported GLB version: ${version} (expected 2)`)
  }

  let offset = 12
  let json: GlbDocumentJson | null = null
  let bin: Uint8Array = new Uint8Array(0)

  while (offset + 8 <= bytes.byteLength && offset < totalBytes) {
    const chunkLen = view.getUint32(offset, true)
    const chunkType = view.getUint32(offset + 4, true)
    offset += 8
    const chunkSlice = bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkLen))
    offset += chunkLen

    if (chunkType === GLB_CHUNK_JSON) {
      const jsonText = new TextDecoder().decode(chunkSlice).replace(/\0+$/, '').trim()
      json = JSON.parse(jsonText) as GlbDocumentJson
    } else if (chunkType === GLB_CHUNK_BIN) {
      bin = chunkSlice
    }
  }

  if (!json) {
    throw new Error('Invalid GLB: missing JSON chunk')
  }

  return {
    version,
    totalBytes,
    json,
    bin,
    meshCount: json.meshes?.length ?? 0,
    materialCount: json.materials?.length ?? 0,
    imageCount: json.images?.length ?? 0,
    skinCount: json.skins?.length ?? 0,
    animationCount: json.animations?.length ?? 0,
  }
}

/** Builds a valid binary glTF 2.0 (`.glb`) buffer from a JSON descriptor and raw BIN payload. */
export function buildMinimalGlb(doc: GlbDocumentJson, binPayload: Uint8Array): Uint8Array {
  const jsonBytesRaw = new TextEncoder().encode(JSON.stringify(doc))
  const jsonPad = (4 - (jsonBytesRaw.byteLength % 4)) % 4
  const jsonLen = jsonBytesRaw.byteLength + jsonPad

  const binPad = (4 - (binPayload.byteLength % 4)) % 4
  const binLen = binPayload.byteLength + binPad

  const totalLen = 12 + 8 + jsonLen + (binLen > 0 ? 8 + binLen : 0)
  const out = new Uint8Array(totalLen)
  const view = new DataView(out.buffer)

  view.setUint32(0, GLB_MAGIC, true)
  view.setUint32(4, GLB_VERSION_2, true)
  view.setUint32(8, totalLen, true)

  // JSON chunk (space-padded per glTF 2.0 spec)
  view.setUint32(12, jsonLen, true)
  view.setUint32(16, GLB_CHUNK_JSON, true)
  out.set(jsonBytesRaw, 20)
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBytesRaw.byteLength + i] = 0x20

  // BIN chunk (zero-padded per glTF 2.0 spec)
  if (binLen > 0) {
    const binHdr = 20 + jsonLen
    view.setUint32(binHdr, binLen, true)
    view.setUint32(binHdr + 4, GLB_CHUNK_BIN, true)
    out.set(binPayload, binHdr + 8)
  }

  return out
}

/**
 * Ingests a batch of CC0 `.glb` files into a deduplicated `.b8p` CAS store:
 * - Splits embedded textures (`images` -> `bufferViews`) and mesh/skeleton binary buffers
 *   into content-addressed blocks so shared palettes/textures across hundreds of Kenney/Quaternius
 *   assets are stored ONCE (`O(1)`).
 * - Proves Mathematical Total Asset Closure (`R ⊆ M`) before returning.
 */
export function ingestGlbCatalogToB8p(entries: readonly GlbIngestInput[]): GlbIngestReport {
  const store = new B8pAssetPipeline(`cc0-glb-catalog-${entries.length}`)
  const refs: AssetReference[] = []

  let totalInputBytes = 0
  let totalSubBlocks = 0
  let skinsDetected = 0
  let animationsDetected = 0

  for (const entry of entries) {
    totalInputBytes += entry.bytes.byteLength
    const parsed = parseGlb(entry.bytes)
    skinsDetected += parsed.skinCount
    animationsDetected += parsed.animationCount

    const bvs = parsed.json.bufferViews ?? []
    const usedImageBvs = new Set<number>()

    // 1. Content-address every embedded texture/image bufferView (huge dedup win across Kenney/KayKit packs!)
    if (parsed.json.images && parsed.bin.byteLength > 0) {
      for (let imgIdx = 0; imgIdx < parsed.json.images.length; imgIdx++) {
        const img = parsed.json.images[imgIdx]!
        if (img.bufferView === undefined) continue
        const bv = bvs[img.bufferView]
        if (!bv) continue
        usedImageBvs.add(img.bufferView)
        const start = bv.byteOffset ?? 0
        const slice = parsed.bin.subarray(start, Math.min(parsed.bin.byteLength, start + bv.byteLength))
        const assetId = `${entry.assetId}/tex_${imgIdx}`
        const reg = store.registerAsset(assetId, 'texture', slice)
        totalSubBlocks++
        refs.push({ assetId, kind: 'texture', expectedHash64: reg.hash64 })
      }
    }

    // 2. Content-address every remaining binary bufferView (geometry, skin joints, animation keyframes)
    if (bvs.length > 0 && parsed.bin.byteLength > 0) {
      for (let bvIdx = 0; bvIdx < bvs.length; bvIdx++) {
        if (usedImageBvs.has(bvIdx)) continue
        const bv = bvs[bvIdx]!
        const start = bv.byteOffset ?? 0
        const slice = parsed.bin.subarray(start, Math.min(parsed.bin.byteLength, start + bv.byteLength))
        const kind: AssetKind = 'mesh'
        const assetId = `${entry.assetId}/bv_${bvIdx}`
        const reg = store.registerAsset(assetId, kind, slice)
        totalSubBlocks++
        refs.push({ assetId, kind, expectedHash64: reg.hash64 })
      }
    } else {
      const reg = store.registerAsset(entry.assetId, 'mesh', entry.bytes)
      totalSubBlocks++
      refs.push({ assetId: entry.assetId, kind: 'mesh', expectedHash64: reg.hash64 })
    }

    // 3. Store compact scene JSON metadata block
    const metaBytes = new TextEncoder().encode(
      JSON.stringify({
        assetId: entry.assetId,
        packSource: entry.packSource,
        license: entry.license,
        meshes: parsed.meshCount,
        materials: parsed.materialCount,
        skins: parsed.skinCount,
        animations: parsed.animationCount,
        jsonHash: fnv64String(JSON.stringify(parsed.json)),
      })
    )
    const metaId = `${entry.assetId}/meta`
    const metaReg = store.registerAsset(metaId, 'shader', metaBytes)
    totalSubBlocks++
    refs.push({ assetId: metaId, kind: 'shader', expectedHash64: metaReg.hash64 })
  }

  // Enforce Mathematical Total Asset Closure Gate (R ⊆ M)
  const closureProof = verifyAssetClosure(refs, store)

  const stats = store.getStats()
  const uniqueStoredBytes = stats.uniqueStoredBytes
  const bytesSavedByDedup = Math.max(0, totalInputBytes - uniqueStoredBytes)
  const dedupRatioPct =
    totalInputBytes > 0 ? Number(((bytesSavedByDedup / totalInputBytes) * 100).toFixed(2)) : 0

  return {
    assetsIngested: entries.length,
    totalInputBytes,
    uniqueStoredBytes,
    bytesSavedByDedup,
    dedupRatioPct,
    uniqueBlocks: stats.uniqueBlockCount,
    totalSubBlocks,
    skinsDetected,
    animationsDetected,
    closureProof,
    references: refs,
    store,
  }
}
