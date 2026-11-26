/**
 * @file src/hydrate.mts
 * @description Resolves and hydrates Eclipse Theia IDE stack from
 * `awesome-os/holo-v11` (`casLayout: "v11"`, SHA-512 verified, `B8G_ABI_MAGIC_V3 = 0x33564742`).
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyKeepLast5PinV11,
  fetchHoloV11Manifest,
  findHoloV11Entry,
  getB8gCasDir,
  HOLO_V11_CAS_BASE_URL,
  HOLO_V11_INDEX_URL,
  storeVerifiedLocalBlobV11,
  type HoloV11Entry,
  type HoloV11GlobalManifest,
} from '../../shared/holo-v11-cas.mts';

export {
  HOLO_V11_CAS_BASE_URL,
  HOLO_V11_INDEX_URL,
  type HoloV11Entry,
  type HoloV11GlobalManifest,
};

export const OPEN_VSX_REGISTRY_URL = 'https://open-vsx.org';
export const TYPESCRIPT_ASSET_KEY = 'ts-morph-v0.1.0.tar.zst';

export interface BundledAwesomeOsExtension {
  id: string;
  repo: string;
  repoUrl: string;
  description: string;
}

export const AWESOME_OS_BUNDLED_EXTENSIONS: readonly BundledAwesomeOsExtension[] = [
  {
    id: 'stealifylang-vscode',
    repo: 'awesome-os/stealifylang-vscode',
    repoUrl: 'https://github.com/awesome-os/stealifylang-vscode',
    description:
      'StealifyLang LSP, stealify-lint (B8G001-B8G016), .stealify-rules, and Awesome-OS governance project rules',
  },
  {
    id: 'unreal-ghost',
    repo: 'awesome-os/unreal-vscode',
    repoUrl: 'https://github.com/awesome-os/unreal-vscode',
    description: 'Unreal Engine zero-VS UBT & B8G_ARENA_V1 integration for Awesome-OS',
  },
  {
    id: 'godot-ghost',
    repo: 'awesome-os/godot-vscode',
    repoUrl: 'https://github.com/awesome-os/godot-vscode',
    description: 'Godot Engine Holo v11 integration for Awesome-OS',
  },
  {
    id: 'blender-ghost',
    repo: 'awesome-os/blender-vscode',
    repoUrl: 'https://github.com/awesome-os/blender-vscode',
    description: 'Blender Holo v11 integration for Awesome-OS',
  },
  {
    id: 'obs-ghost',
    repo: 'awesome-os/obs-vscode',
    repoUrl: 'https://github.com/awesome-os/obs-vscode',
    description: 'OBS Studio Holo v11 integration for Awesome-OS',
  },
] as const;

export interface SharedExtensionsResult {
  extensionsDir: string;
  theiaDefaultPlugins: string;
  bundledExtensions: readonly BundledAwesomeOsExtension[];
  entries: string[];
}

export function getCasCacheDir(): string {
  return getB8gCasDir();
}

export function getSharedExtensionsDir(): string {
  return process.env.B8G_SHARED_EXTENSIONS_DIR ?? join(getCasCacheDir(), 'extensions');
}

export function getTheiaDefaultPluginsEnv(): string {
  return `local-dir:${getSharedExtensionsDir()}`;
}

export function listSharedVsixExtensions(dir: string = getSharedExtensionsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.vsix'));
}

export function ensureSharedExtensionsDir(): SharedExtensionsResult {
  const extensionsDir = getSharedExtensionsDir();
  mkdirSync(extensionsDir, { recursive: true });
  return {
    extensionsDir,
    theiaDefaultPlugins: `local-dir:${extensionsDir}`,
    bundledExtensions: AWESOME_OS_BUNDLED_EXTENSIONS,
    entries: listSharedVsixExtensions(extensionsDir),
  };
}

export function getElectronAssetKey(): string {
  return 'electron-v0.2.0.tar.zst';
}

export function getElectronExecutableRelPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'electron.exe';
  if (platform === 'darwin') return join('Electron.app', 'Contents', 'MacOS', 'Electron');
  return 'electron';
}

export function getAbiShimAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') return 'b8g-shim.exe';
  if (platform === 'darwin') return 'b8g-shim-macos-arm64';
  return arch === 'arm64' ? 'b8g-shim-linux-arm64' : 'b8g-shim-linux-x64';
}

export function getTypeScriptAssetKey(): string {
  return TYPESCRIPT_ASSET_KEY;
}

export async function fetchTheiaManifest(forceRefresh = false): Promise<HoloV11GlobalManifest> {
  return fetchHoloV11Manifest(forceRefresh);
}

export async function resolveTheiaBundleEntry(
  manifest?: HoloV11GlobalManifest,
): Promise<HoloV11Entry> {
  const idx = manifest ?? (await fetchTheiaManifest());
  const entry = findHoloV11Entry(idx, 'theia', (e) => e.filename.endsWith('.tar.zst'));
  if (!entry) {
    throw new Error(`Theia bundle not found in Holo v11 manifest (${idx.entries.length} entries)`);
  }
  return applyKeepLast5PinV11(entry, process.env.THEIA_HOLO_SHA512);
}

export async function resolveElectronEntry(
  assetKey = getElectronAssetKey(),
  manifest?: HoloV11GlobalManifest,
): Promise<HoloV11Entry> {
  const idx = manifest ?? (await fetchTheiaManifest());
  const entry = findHoloV11Entry(idx, 'electron', (e) => e.filename === assetKey || e.filename.startsWith('electron-'));
  if (!entry) {
    throw new Error(`Electron asset "${assetKey}" not found in Holo v11 manifest`);
  }
  return entry;
}

export async function resolveAbiShimEntry(
  assetKey = getAbiShimAssetKey(),
  manifest?: HoloV11GlobalManifest,
): Promise<HoloV11Entry> {
  const idx = manifest ?? (await fetchTheiaManifest());
  const entry = findHoloV11Entry(idx, 'holo-compiler', (e) => e.filename === assetKey);
  if (!entry) {
    throw new Error(`B8G ABI shim "${assetKey}" not found in Holo v11 manifest`);
  }
  return entry;
}

export async function resolveTypeScriptEntry(
  assetKey = getTypeScriptAssetKey(),
  manifest?: HoloV11GlobalManifest,
): Promise<HoloV11Entry> {
  const idx = manifest ?? (await fetchTheiaManifest());
  const entry =
    findHoloV11Entry(idx, 'ts-morph', (e) => e.filename === assetKey) ??
    findHoloV11Entry(idx, 'sectium-es', (e) => e.filename.endsWith('.tar.zst'));
  if (!entry) {
    throw new Error(`TypeScript asset "${assetKey}" not found in Holo v11 manifest`);
  }
  return entry;
}

export function hydrateLocalCasPayload(
  expectedSha512: string,
  payload: Uint8Array,
): { blobFile: string; cacheHit: boolean; sha512: string } {
  return storeVerifiedLocalBlobV11(getCasCacheDir(), expectedSha512, payload);
}
