/**
 * @file glb-loader.mts
 * @description Custom `.glb` character & prop drop-in bridge over
 * `sections/b8g-game-engine/glb-ingestor.mts`.
 *
 * Drop any rigged or static `.glb` files (e.g. `stalker.glb`, `goliath.glb`,
 * `echo.glb`, `human.glb`) into `intersections/b8g-asymmetric-hunt/assets/`
 * and they are automatically validated, parsed via zero-dep `parseGlb`, and
 * indexed into `.b8p` CAS metadata for the 3D renderer.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ingestGlbCatalogToB8p,
  parseGlb,
  type GlbIngestInput,
} from '../b8g-game-engine/glb-ingestor.mts';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
export const DEFAULT_HUNT_ASSETS_DIR = join(__dirname, 'assets');

export interface HuntGlbAssetSummary {
  slot: string;
  fileName: string;
  bytes: number;
  meshCount: number;
  materialCount: number;
  skinCount: number;
  animationCount: number;
  valid: boolean;
  error?: string;
}

export interface HuntGlbManifest {
  assetsDir: string;
  exists: boolean;
  assets: HuntGlbAssetSummary[];
  b8pPackBytes: number;
  deduplicatedSubAssets: number;
}

export function scanHuntGlbAssets(assetsDir = DEFAULT_HUNT_ASSETS_DIR): HuntGlbManifest {
  if (!existsSync(assetsDir)) {
    return {
      assetsDir,
      exists: false,
      assets: [],
      b8pPackBytes: 0,
      deduplicatedSubAssets: 0,
    };
  }

  const files = readdirSync(assetsDir).filter((f) => extname(f).toLowerCase() === '.glb');
  const assets: HuntGlbAssetSummary[] = [];
  const ingestInputs: GlbIngestInput[] = [];

  for (const fileName of files) {
    const full = join(assetsDir, fileName);
    const slot = basename(fileName, '.glb').toLowerCase();
    try {
      const bytes = new Uint8Array(readFileSync(full));
      const parsed = parseGlb(bytes);
      assets.push({
        slot,
        fileName,
        bytes: parsed.totalBytes,
        meshCount: parsed.meshCount,
        materialCount: parsed.materialCount,
        skinCount: parsed.skinCount,
        animationCount: parsed.animationCount,
        valid: true,
      });
      ingestInputs.push({
        assetId: `hunt/${slot}`,
        packSource: 'custom',
        license: 'CC0-1.0',
        bytes,
      });
    } catch (err) {
      assets.push({
        slot,
        fileName,
        bytes: 0,
        meshCount: 0,
        materialCount: 0,
        skinCount: 0,
        animationCount: 0,
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let b8pPackBytes = 0;
  let deduplicatedSubAssets = 0;
  if (ingestInputs.length > 0) {
    const report = ingestGlbCatalogToB8p(ingestInputs);
    b8pPackBytes = report.uniqueStoredBytes;
    deduplicatedSubAssets = report.totalSubBlocks;
  }

  return {
    assetsDir,
    exists: true,
    assets,
    b8pPackBytes,
    deduplicatedSubAssets,
  };
}
