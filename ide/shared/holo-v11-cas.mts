/**
 * @file ide/shared/holo-v11-cas.mts
 * @description Canonical Holo v11 Global Auditable CAS client for Awesome-OS DevTools.
 *   Resolves SHA-512 content-addressed artifacts from `awesome-os/holo-v11`
 *   (`B8G_ABI_MAGIC_V3 = 0x33564742`, `casLayout: "v11"`).
 *
 * Strictly `erasableSyntaxOnly: true` & zero external dependencies.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const B8G_ABI_MAGIC_V3 = 0x33564742;
export const B8G_ABI_MAGIC_V3_HEX = '0x33564742';

export const HOLO_V11_INDEX_URL =
  process.env.B8G_HOLO_V11_INDEX_URL ??
  'https://raw.githubusercontent.com/awesome-os/holo-v11/main/index/cas-v11-global-manifest.json';

export const HOLO_V11_CAS_BASE_URL =
  process.env.B8G_HOLO_V11_CAS_URL ??
  'https://github.com/awesome-os/holo-v11/releases/download/v11';

export type HoloV11Target =
  | 'win64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'macos-arm64'
  | 'macos-x64'
  | 'wasm32-wasi'
  | 'any';

export interface HoloV11HistoryItem {
  readonly sha512: string;
  readonly size: number;
  readonly tag?: string;
  readonly retiredAt?: string;
}

export interface HoloV11Entry {
  readonly id: string;
  readonly repo: string;
  readonly tag: string;
  readonly filename: string;
  readonly target: string;
  readonly executable?: boolean;
  readonly sha512: string;
  readonly size: number;
  readonly blobPath: string;
  readonly downloadUrl: string;
  readonly history?: readonly HoloV11HistoryItem[];
}

export interface HoloV11GlobalManifest {
  readonly schema: string;
  readonly abiMagic: string;
  readonly version: string;
  readonly generatedAt: string;
  readonly totalRepos: number;
  readonly totalAssets: number;
  readonly uniqueBlobs?: number;
  readonly totalBytes?: number;
  readonly entries: readonly HoloV11Entry[];
}

let cachedManifest: HoloV11GlobalManifest | null = null;
let cachedManifestUrl: string | null = null;

export function getB8gCasDir(): string {
  const dir = process.env.B8G_CAS_DIR ?? join(homedir(), '.b8g', 'cas');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function normalizeHoloTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): HoloV11Target {
  if (platform === 'win32') return 'win64';
  if (platform === 'darwin') return arch === 'x64' ? 'macos-x64' : 'macos-arm64';
  return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

export function sha512Hex(data: Uint8Array | string): string {
  return createHash('sha512').update(data).digest('hex');
}

export async function fetchHoloV11Manifest(
  forceRefresh = false,
  indexUrl: string = HOLO_V11_INDEX_URL,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<HoloV11GlobalManifest> {
  if (cachedManifest && cachedManifestUrl === indexUrl && !forceRefresh) {
    return cachedManifest;
  }

  const cacheFile = join(getB8gCasDir(), 'holo-v11-global-manifest.json');
  try {
    const res = await fetchImpl(indexUrl, {
      headers: {
        accept: 'application/json',
        'user-agent': 'awesome-os-devtools/1.0.0',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching Holo v11 manifest from ${indexUrl}`);
    }
    const json = (await res.json()) as HoloV11GlobalManifest;
    if (!json || !Array.isArray(json.entries)) {
      throw new Error(`Invalid Holo v11 manifest returned from ${indexUrl}`);
    }
    try {
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf8');
      renameSync(tmp, cacheFile);
    } catch {
      // Non-fatal if cache write races
    }
    cachedManifest = json;
    cachedManifestUrl = indexUrl;
    return json;
  } catch (err) {
    if (existsSync(cacheFile)) {
      const disk = JSON.parse(readFileSync(cacheFile, 'utf8')) as HoloV11GlobalManifest;
      cachedManifest = disk;
      cachedManifestUrl = indexUrl;
      return disk;
    }
    throw err;
  }
}

export function findHoloV11Entry(
  manifest: HoloV11GlobalManifest,
  repo: string,
  predicate: (entry: HoloV11Entry) => boolean,
): HoloV11Entry | null {
  for (const entry of manifest.entries) {
    if (entry.repo === repo && predicate(entry)) {
      return entry;
    }
  }
  return null;
}

export function applyKeepLast5PinV11(entry: HoloV11Entry, pinnedSha512?: string): HoloV11Entry {
  const sha = pinnedSha512?.trim().toLowerCase();
  if (!sha || sha === entry.sha512.toLowerCase()) {
    return entry;
  }
  const hist = entry.history?.find((h) => h.sha512.toLowerCase() === sha);
  if (hist) {
    return {
      ...entry,
      sha512: hist.sha512,
      size: hist.size,
      tag: hist.tag ?? entry.tag,
      blobPath: `v11/files/${hist.sha512.slice(0, 2)}/${hist.sha512}`,
      downloadUrl: `${HOLO_V11_CAS_BASE_URL}/${hist.sha512}`,
    };
  }
  return entry;
}

export function storeVerifiedLocalBlobV11(
  casDir: string,
  expectedSha512: string,
  payload: Uint8Array,
): { blobFile: string; cacheHit: boolean; sha512: string } {
  const actual = sha512Hex(payload);
  if (actual !== expectedSha512.toLowerCase()) {
    throw new Error(`SHA-512 mismatch: expected ${expectedSha512}, got ${actual}`);
  }
  const rel = join('v11', 'files', actual.slice(0, 2), actual);
  const blobFile = join(casDir, rel);
  if (existsSync(blobFile)) {
    const onDisk = sha512Hex(readFileSync(blobFile));
    if (onDisk === actual) {
      return { blobFile, cacheHit: true, sha512: actual };
    }
  }
  mkdirSync(dirname(blobFile), { recursive: true });
  const tmp = `${blobFile}.${process.pid}.tmp`;
  writeFileSync(tmp, payload);
  renameSync(tmp, blobFile);
  return { blobFile, cacheHit: false, sha512: actual };
}
