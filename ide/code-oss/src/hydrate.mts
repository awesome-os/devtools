/**
 * @file src/hydrate.mts
 * @description Resolves and hydrates Awesome-OS Code - OSS artifacts from
 * `awesome-os/holo-v11` (`casLayout: "v11"`, SHA-512 verified, `B8G_ABI_MAGIC_V3 = 0x33564742`):
 *   (a) Shared Electron (`awesome-os/electron`)
 *   (b) Code - OSS native launcher/app (`awesome-os/code-oss`)
 *   (c) Native ABI shim (`awesome-os/holo-compiler` `b8g-shim` + `libsectium_display`)
 *   (d) Programmable TypeScript AST/compiler (`awesome-os/ts-morph` / `awesome-os/sectium-es`)
 *   (e) Shared extension cache (`~/.b8g/cas/extensions/`) with 5 bundled extensions
 */

import { existsSync, mkdirSync } from 'node:fs';
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
} from '../../shared/holo-v11-cas.mts';

export {
  HOLO_V11_CAS_BASE_URL,
  HOLO_V11_INDEX_URL,
  type HoloV11Entry,
  type HoloV11GlobalManifest,
};

export interface BundledExtensionSpec {
  id: string;
  repo: string;
  description: string;
}

export const AWESOME_OS_BUNDLED_EXTENSIONS: readonly BundledExtensionSpec[] = Object.freeze([
  {
    id: 'stealifylang-vscode',
    repo: 'awesome-os/stealifylang-vscode',
    description:
      'StealifyLang LSP, stealify-lint (B8G001-B8G016), .stealify-rules, and governance project rules',
  },
  {
    id: 'unreal-ghost',
    repo: 'awesome-os/unreal-vscode',
    description: 'UE5 UBT + .NET 11 + Holo LLVM + WinSDK over B8G_ARENA_V1',
  },
  {
    id: 'godot-ghost',
    repo: 'awesome-os/godot-vscode',
    description: 'Godot 4 + .NET 11 + GDScript/C# over Holo v11 CAS',
  },
  {
    id: 'blender-ghost',
    repo: 'awesome-os/blender-vscode',
    description: 'Blender 5 + bpy hot-reload + libsectium_display',
  },
  {
    id: 'obs-ghost',
    repo: 'awesome-os/obs-vscode',
    description: 'OBS 33 + HTML5 overlay hot-reload + libsectium_display',
  },
]);

export interface HydratedCodeOssStack {
  electron: HoloV11Entry;
  codeOssApp: HoloV11Entry;
  abiShim: HoloV11Entry;
  typescript: HoloV11Entry;
  extensionsDir: string;
  casDir: string;
}

export function getCasCacheDir(): string {
  return getB8gCasDir();
}

export function getSharedExtensionsDir(): string {
  return process.env.B8G_SHARED_EXTENSIONS_DIR ?? join(getCasCacheDir(), 'extensions');
}

export function ensureSharedExtensionsDir(): string {
  const dir = getSharedExtensionsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getCodeOssBinaryKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') return 'code-oss.exe';
  if (platform === 'darwin') return 'code-oss-macos-arm64';
  return arch === 'arm64' ? 'code-oss-linux-arm64' : 'code-oss-linux-x64';
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
  return 'ts-morph-v0.1.0.tar.zst';
}

export async function fetchCodeOssManifest(forceRefresh = false): Promise<HoloV11GlobalManifest> {
  return fetchHoloV11Manifest(forceRefresh);
}

export async function resolveElectronEntry(
  assetKey = getElectronAssetKey(),
  manifest?: HoloV11GlobalManifest,
): Promise<HoloV11Entry> {
  const idx = manifest ?? (await fetchCodeOssManifest());
  const entry = findHoloV11Entry(idx, 'electron', (e) => e.filename === assetKey || e.filename.startsWith('electron-'));
  if (!entry) {
    throw new Error(`Electron asset "${assetKey}" not found in Holo v11 manifest (${idx.entries.length} entries)`);
  }
  return applyKeepLast5PinV11(entry, process.env.ELECTRON_HOLO_SHA512);
}

export async function tryResolveCodeOssEntry(
  assetKey = getCodeOssBinaryKey(),
  manifest?: HoloV11GlobalManifest,
): Promise<HoloV11Entry | null> {
  const idx = manifest ?? (await fetchCodeOssManifest());
  const target = normalizeHoloTarget();
  const entry =
    findHoloV11Entry(idx, 'code-oss', (e) => e.filename === assetKey) ??
    findHoloV11Entry(idx, 'code-oss', (e) => e.target === target && !e.filename.endsWith('.pdb'));
  return entry ? applyKeepLast5PinV11(entry, process.env.CODE_OSS_HOLO_SHA512) : null;
}

export async function resolveCodeOssEntry(
  assetKey = getCodeOssBinaryKey(),
  manifest?: HoloV11GlobalManifest,
): Promise<HoloV11Entry> {
  const idx = manifest ?? (await fetchCodeOssManifest());
  const entry = await tryResolveCodeOssEntry(assetKey, idx);
  if (!entry) {
    throw new Error(`Code - OSS asset "${assetKey}" not found in Holo v11 manifest (${idx.entries.length} entries)`);
  }
  return entry;
}

export async function resolveAbiShimEntry(
  assetKey = getAbiShimAssetKey(),
  manifest?: HoloV11GlobalManifest,
): Promise<HoloV11Entry> {
  const idx = manifest ?? (await fetchCodeOssManifest());
  const entry = findHoloV11Entry(idx, 'holo-compiler', (e) => e.filename === assetKey);
  if (!entry) {
    throw new Error(`B8G ABI shim "${assetKey}" not found in Holo v11 manifest (${idx.entries.length} entries)`);
  }
  return entry;
}

export async function resolveTypeScriptEntry(
  assetKey = getTypeScriptAssetKey(),
  manifest?: HoloV11GlobalManifest,
): Promise<HoloV11Entry> {
  const idx = manifest ?? (await fetchCodeOssManifest());
  const entry =
    findHoloV11Entry(idx, 'ts-morph', (e) => e.filename === assetKey) ??
    findHoloV11Entry(idx, 'sectium-es', (e) => e.filename.endsWith('.tar.zst'));
  if (!entry) {
    throw new Error(`TypeScript toolchain asset "${assetKey}" not found in Holo v11 manifest`);
  }
  return applyKeepLast5PinV11(entry, process.env.TYPESCRIPT_HOLO_SHA512);
}

export function hydrateLocalCasPayload(
  expectedSha512: string,
  payload: Uint8Array,
): { blobFile: string; cacheHit: boolean; sha512: string } {
  return storeVerifiedLocalBlobV11(getCasCacheDir(), expectedSha512, payload);
}

export async function hydrateCodeOssStack(
  manifest?: HoloV11GlobalManifest,
): Promise<HydratedCodeOssStack> {
  const idx = manifest ?? (await fetchCodeOssManifest());
  const [electron, codeOssApp, abiShim, typescript] = await Promise.all([
    resolveElectronEntry(getElectronAssetKey(), idx),
    resolveCodeOssEntry(getCodeOssBinaryKey(), idx),
    resolveAbiShimEntry(getAbiShimAssetKey(), idx),
    resolveTypeScriptEntry(getTypeScriptAssetKey(), idx),
  ]);
  const extensionsDir = ensureSharedExtensionsDir();
  const casDir = getCasCacheDir();
  return { electron, codeOssApp, abiShim, typescript, extensionsDir, casDir };
}

export function isCasPathPresent(pathStr: string): boolean {
  return existsSync(pathStr);
}
