/**
 * @file src/hydrate.mts
 * @description Resolves and hydrates rolling-latest Blender from
 * `awesome-os/holo-v11` (`casLayout: "v11"`, SHA-512 verified, Keep-Last-5 pinning).
 */

import { join } from 'node:path';
import {
  applyKeepLast5PinV11,
  fetchHoloV11Manifest,
  findHoloV11Entry,
  getB8gCasDir,
  HOLO_V11_CAS_BASE_URL,
  HOLO_V11_INDEX_URL,
  normalizeHoloTarget,
  storeVerifiedLocalBlobV11,
  type HoloV11Entry,
  type HoloV11GlobalManifest,
} from '../../../shared/holo-v11-cas.mts';

export {
  HOLO_V11_CAS_BASE_URL,
  HOLO_V11_INDEX_URL,
  type HoloV11Entry,
  type HoloV11GlobalManifest,
};

export function getCasCacheDir(): string {
  return getB8gCasDir();
}

export function getBlenderAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') return 'blender.exe';
  if (platform === 'darwin') return 'blender-macos-arm64';
  return arch === 'arm64' ? 'blender-linux-arm64' : 'blender-linux-x64';
}

export function getBlenderExecutableRelPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'blender.exe';
  if (platform === 'darwin') return 'blender-macos-arm64';
  return process.arch === 'arm64' ? 'blender-linux-arm64' : 'blender-linux-x64';
}

export async function fetchBlenderManifest(forceRefresh = false): Promise<HoloV11GlobalManifest> {
  return fetchHoloV11Manifest(forceRefresh);
}

export function applyKeepLast5Pin(entry: HoloV11Entry, pinnedSha512?: string): HoloV11Entry {
  return applyKeepLast5PinV11(entry, pinnedSha512);
}

export async function tryResolveBlenderEntry(
  assetKey = getBlenderAssetKey(),
  manifest?: HoloV11GlobalManifest,
): Promise<HoloV11Entry | null> {
  const idx = manifest ?? (await fetchBlenderManifest());
  const target = normalizeHoloTarget();
  const entry =
    findHoloV11Entry(idx, 'blender', (e) => e.filename === assetKey) ??
    findHoloV11Entry(idx, 'blender', (e) => e.target === target && !e.filename.endsWith('.pdb'));
  if (!entry) return null;
  return applyKeepLast5Pin(entry, process.env.BLENDER_HOLO_SHA512);
}

export async function resolveBlenderEntry(
  assetKey = getBlenderAssetKey(),
  manifest?: HoloV11GlobalManifest,
): Promise<HoloV11Entry> {
  const idx = manifest ?? (await fetchBlenderManifest());
  const entry = await tryResolveBlenderEntry(assetKey, idx);
  if (!entry) {
    throw new Error(`Blender asset "${assetKey}" not found in Holo v11 manifest (${idx.entries.length} entries)`);
  }
  return entry;
}

export function hydrateLocalBlenderPayload(
  expectedSha512: string,
  payload: Uint8Array,
): { blobFile: string; cacheHit: boolean; sha512: string } {
  return storeVerifiedLocalBlobV11(getCasCacheDir(), expectedSha512, payload);
}

export function getBlenderInstallPath(entry: HoloV11Entry): string {
  return join(getCasCacheDir(), 'blender', entry.sha512.slice(0, 16), entry.filename);
}
