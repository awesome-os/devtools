/**
 * @file src/extension.mts
 * @description MIT Blender extension for Awesome-OS Code - OSS & Eclipse Theia.
 *   Resolves live `blender`, `libsectium_display`, and `b8g-shim` from
 *   `awesome-os/holo-v11` (`casLayout: "v11"`, SHA-512), builds deterministic `bpy`
 *   script and addon live-reload commands, and registers VS Code / Theia commands.
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
  type HoloV11Entry,
  type HoloV11GlobalManifest,
} from '../../../shared/holo-v11-cas.mts';

export {
  HOLO_V11_CAS_BASE_URL,
  HOLO_V11_INDEX_URL,
  type HoloV11Entry,
  type HoloV11GlobalManifest,
};

export const EXTENSION_ID = 'awesome-os.blender-ghost';

export const EXTENSION_COMMANDS = [
  'blenderGhost.hydrate',
  'blenderGhost.launch',
  'blenderGhost.runScript',
  'blenderGhost.reloadAddon',
] as const;

export type ExtensionCommandId = (typeof EXTENSION_COMMANDS)[number];

export interface ResolveBlenderStudioPlanOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  manifest?: HoloV11GlobalManifest;
  indexUrl?: string;
  cacheDir?: string;
  pinnedSha512?: string;
  forceRefresh?: boolean;
}

export interface ViewportBridgeConfig {
  libraryAsset: HoloV11Entry;
  pipePath: string;
  channel: 'display';
}

export interface BlenderStudioPlan {
  extensionId: string;
  platform: NodeJS.Platform;
  arch: string;
  indexSchema: string;
  casBaseUrl: string;
  blender: HoloV11Entry;
  sectiumDisplay: HoloV11Entry;
  abiShim: HoloV11Entry;
  viewportBridge: ViewportBridgeConfig;
  cacheDir: string;
  installDir: string;
  executablePath: string;
}

export interface BuildBlenderScriptCommandOptions {
  plan: BlenderStudioPlan;
  scriptPath?: string;
  addonModule?: string;
  blendFile?: string;
  background?: boolean;
  factoryStartup?: boolean;
  pythonExitCode?: number;
  extraArgs?: string[];
  enableSectiumViewport?: boolean;
}

export interface BlenderCommandSpec {
  executable: string;
  args: string[];
  env: Record<string, string>;
  mode: 'launch' | 'runScript' | 'reloadAddon';
}

export interface ExtensionDisposable {
  dispose(): void;
}

export interface ExtensionHostApi {
  commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): ExtensionDisposable;
  };
  tasks?: {
    registerTaskProvider(type: string, provider: unknown): ExtensionDisposable;
  };
  window?: {
    showInformationMessage(message: string): unknown;
    showErrorMessage(message: string): unknown;
  };
}

export interface ExtensionContextLike {
  subscriptions: ExtensionDisposable[];
  hostApi?: ExtensionHostApi;
}

const activeDisposables: ExtensionDisposable[] = [];

export function getBlenderAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') return 'blender.exe';
  if (platform === 'darwin') return 'blender-macos-arm64';
  return arch === 'arm64' ? 'blender-linux-arm64' : 'blender-linux-x64';
}

export function getSectiumDisplayAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') return 'libsectium_display.dll';
  if (platform === 'darwin') return 'libsectium_display-macos-arm64.dylib';
  return arch === 'arm64' ? 'libsectium_display-linux-arm64.so' : 'libsectium_display-linux-x64.so';
}

export function getAbiShimAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') return 'b8g-shim.exe';
  if (platform === 'darwin') return 'b8g-shim-macos-arm64';
  return arch === 'arm64' ? 'b8g-shim-linux-arm64' : 'b8g-shim-linux-x64';
}

export function getBlenderExecutableRelPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'blender.exe';
  if (platform === 'darwin') return 'blender-macos-arm64';
  return process.arch === 'arm64' ? 'blender-linux-arm64' : 'blender-linux-x64';
}

export function getSectiumPipePath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? '\\\\.\\pipe\\sectium-dev' : '/tmp/sectium-dev.sock';
}

export async function resolveBlenderStudioPlan(
  options: ResolveBlenderStudioPlanOptions = {},
): Promise<BlenderStudioPlan> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const manifest =
    options.manifest ??
    (await fetchHoloV11Manifest(options.forceRefresh ?? false, options.indexUrl ?? HOLO_V11_INDEX_URL));

  const target = normalizeHoloTarget(platform, arch);
  const blenderKey = getBlenderAssetKey(platform, arch);
  const sectiumKey = getSectiumDisplayAssetKey(platform, arch);
  const shimKey = getAbiShimAssetKey(platform, arch);

  const rawBlender =
    findHoloV11Entry(manifest, 'blender', (e) => e.filename === blenderKey) ??
    findHoloV11Entry(manifest, 'blender', (e) => e.target === target && !e.filename.endsWith('.pdb'));
  const sectiumDisplay = findHoloV11Entry(manifest, 'sectium-browser', (e) => e.filename === sectiumKey);
  const abiShim = findHoloV11Entry(manifest, 'holo-compiler', (e) => e.filename === shimKey);

  if (!rawBlender) throw new Error(`Missing "${blenderKey}" in Holo v11 manifest`);
  if (!sectiumDisplay) throw new Error(`Missing "${sectiumKey}" in Holo v11 manifest`);
  if (!abiShim) throw new Error(`Missing "${shimKey}" in Holo v11 manifest`);

  const blender = applyKeepLast5PinV11(rawBlender, options.pinnedSha512);
  const cacheDir = options.cacheDir ?? getB8gCasDir();
  const installDir = join(cacheDir, 'blender', blender.sha512.slice(0, 16));
  const executablePath = join(installDir, blender.filename);

  return {
    extensionId: EXTENSION_ID,
    platform,
    arch,
    indexSchema: manifest.schema,
    casBaseUrl: HOLO_V11_CAS_BASE_URL,
    blender,
    sectiumDisplay,
    abiShim,
    viewportBridge: {
      libraryAsset: sectiumDisplay,
      pipePath: getSectiumPipePath(platform),
      channel: 'display',
    },
    cacheDir,
    installDir,
    executablePath,
  };
}

export function buildBlenderScriptCommand(
  options: BuildBlenderScriptCommandOptions,
): BlenderCommandSpec {
  const { plan } = options;
  const args: string[] = [];
  let mode: 'launch' | 'runScript' | 'reloadAddon' = 'launch';

  if (options.background) args.push('--background');
  if (options.factoryStartup) args.push('--factory-startup');
  if (options.blendFile) args.push(options.blendFile);

  if (options.addonModule) {
    mode = 'reloadAddon';
    args.push(
      '--python-exit-code',
      String(options.pythonExitCode ?? 1),
      '--python-expr',
      `import importlib, ${options.addonModule}; importlib.reload(${options.addonModule})`,
    );
  } else if (options.scriptPath) {
    mode = 'runScript';
    args.push('--python-exit-code', String(options.pythonExitCode ?? 1), '--python', options.scriptPath);
  }

  if (options.extraArgs && options.extraArgs.length > 0) {
    args.push('--', ...options.extraArgs);
  }

  return {
    executable: plan.executablePath,
    args,
    mode,
    env: {
      B8G_CAS_DIR: plan.cacheDir,
      B8G_BLENDER_SHA512: plan.blender.sha512,
      SECTIUM_DISPLAY_PIPE: plan.viewportBridge.pipePath,
      SECTIUM_DISPLAY_CHANNEL: 'display',
      SECTIUM_DISPLAY_SHA512: plan.sectiumDisplay.sha512,
    },
  };
}

export async function activate(context?: ExtensionContextLike): Promise<void> {
  const api = context?.hostApi;
  if (!api) return;
  for (const cmd of EXTENSION_COMMANDS) {
    const sub = api.commands.registerCommand(cmd, async () => resolveBlenderStudioPlan());
    activeDisposables.push(sub);
    context?.subscriptions?.push(sub);
  }
}

export function deactivate(): void {
  while (activeDisposables.length > 0) {
    activeDisposables.pop()?.dispose();
  }
}
