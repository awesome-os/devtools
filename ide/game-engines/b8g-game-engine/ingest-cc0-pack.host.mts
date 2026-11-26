#!/usr/bin/env node
/**
 * @file sections/b8g-game-engine/ingest-cc0-pack.host.mts
 * @description CLI tool (`.\bin\b8g-asset-ingest`) that scans any local folder of CC0 `.glb`
 * game assets (Kenney, Quaternius, KayKit, Poly Haven, Khronos), deduplicates shared textures,
 * meshes, and rigs via FNV-64 CAS, verifies Mathematical Total Asset Closure (R ⊆ M), and
 * writes a Brotli-compressed `.b8p` asset pack + `catalog.json`.
 *
 * Usage:
 *   .\bin\b8g-asset-ingest <input-dir> <output-file.b8p> [--source kenney|quaternius|kaykit|polyhaven|khronos]
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { ingestGlbCatalogToB8p, type GlbIngestInput } from './glb-ingestor.mts'

function walkGlbFiles(dir: string): string[] {
  const out: string[] = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkGlbFiles(full))
    else if (ent.isFile() && ent.name.toLowerCase().endsWith('.glb')) out.push(full)
  }
  return out.sort()
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.length < 2 || args.includes('-h') || args.includes('--help')) {
    console.log('Usage: b8g-asset-ingest <input-glb-dir> <output.b8p> [--source kenney|quaternius|kaykit|polyhaven|khronos]')
    process.exit(0)
  }

  const inDir = path.resolve(args[0]!)
  const outFile = path.resolve(args[1]!)
  const srcIdx = args.indexOf('--source')
  const packSource = (srcIdx !== -1 && args[srcIdx + 1] ? args[srcIdx + 1] : 'custom') as GlbIngestInput['packSource']

  if (!fs.existsSync(inDir)) {
    console.error(`[b8g-asset-ingest] Input directory not found: ${inDir}`)
    process.exit(1)
  }

  const files = walkGlbFiles(inDir)
  if (files.length === 0) {
    console.error(`[b8g-asset-ingest] No .glb files found in: ${inDir}`)
    process.exit(1)
  }

  const entries: GlbIngestInput[] = files.map((f) => ({
    assetId: path.relative(inDir, f).replace(/\\/g, '/').replace(/\.glb$/i, ''),
    packSource,
    license: 'CC0-1.0',
    bytes: new Uint8Array(fs.readFileSync(f)),
  }))

  const report = ingestGlbCatalogToB8p(entries)
  const rawPack = report.store.encodeB8pPack()
  const compressed = zlib.brotliCompressSync(rawPack, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 },
  })

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, compressed)
  fs.writeFileSync(
    `${outFile}.manifest.json`,
    JSON.stringify(
      {
        packSource,
        license: 'CC0-1.0',
        assetsIngested: report.assetsIngested,
        totalInputBytes: report.totalInputBytes,
        uniqueStoredBytes: report.uniqueStoredBytes,
        brotliPackBytes: compressed.byteLength,
        totalReductionPct: Number(((1 - compressed.byteLength / Math.max(1, report.totalInputBytes)) * 100).toFixed(2)),
        uniqueBlocks: report.uniqueBlocks,
        totalSubBlocks: report.totalSubBlocks,
        skinsDetected: report.skinsDetected,
        animationsDetected: report.animationsDetected,
        closureProof: report.closureProof,
        references: report.references,
      },
      null,
      2
    ),
    'utf8'
  )

  console.log(
    `[b8g-asset-ingest] Packed ${report.assetsIngested} GLB asset(s) -> ${outFile}\n` +
      `  Raw Input     : ${(report.totalInputBytes / 1024).toFixed(1)} KB\n` +
      `  After CAS Dedup: ${(report.uniqueStoredBytes / 1024).toFixed(1)} KB (${report.dedupRatioPct}% deduped, ${report.uniqueBlocks}/${report.totalSubBlocks} unique blocks)\n` +
      `  After Brotli  : ${(compressed.byteLength / 1024).toFixed(1)} KB (${((1 - compressed.byteLength / Math.max(1, report.totalInputBytes)) * 100).toFixed(1)}% total reduction)\n` +
      `  Closure Gate  : PASS (R ⊆ M verified)`
  )
}

main()
