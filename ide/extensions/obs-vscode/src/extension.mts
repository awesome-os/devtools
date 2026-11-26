/**
 * @file src/extension.mts
 * @description MIT OBS Studio 33 extension for Awesome-OS Code - OSS & Eclipse Theia.
 *   Resolves live `obs`, `libsectium_display`, and `b8g-shim` from
 *   `awesome-os/holo-v11` (`casLayout: "v11"`, SHA-512), constructs portable OBS launch
 *   commands, and registers VS Code / Theia commands and the `obs-ghost` task provider.
 */

import { join, posix, win32 } from 'node:path';
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

export interface ResolveObsPlanOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  indexUrl?: string;
  cacheDir?: string;
  pinnedSha512?: string;
  forceRefresh?: boolean;
  manifest?: HoloV11GlobalManifest;
}

export interface ObsStudioPlan {
  platform: NodeJS.Platform;
  arch: string;
  indexSchema: string;
  casBaseUrl: string;
  cacheDir: string;
  installDir: string;
  obs: HoloV11Entry;
  sectiumDisplay: HoloV11Entry;
  abiShim: HoloV11Entry;
}

export interface ObsLaunchOptions {
  portable?: boolean;
  scene?: string;
  collection?: string;
  profile?: string;
  startRecording?: boolean;
  minimizeToTray?: boolean;
  overlayUrl?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
}

export interface ObsLaunchCommand {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ExtensionDisposable {
  dispose(): void;
}

export interface ExtensionContextLike {
  subscriptions: ExtensionDisposable[];
}

export interface VscodeApiLike {
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

const activeDisposables: ExtensionDisposable[] = [];

export function getObsAssetKey(platform: NodeJS.Platform = 'win32', arch = 'x64'): string {
  if (platform === 'win32') return 'obs.exe';
  if (platform === 'darwin') return 'obs-macos-arm64';
  return arch === 'arm64' ? 'obs-linux-arm64' : 'obs-linux-x64';
}

export function getSectiumDisplayKey(platform: NodeJS.Platform = 'win32', arch = 'x64'): string {
  if (platform === 'win32') return 'libsectium_display.dll';
  if (platform === 'darwin') return 'libsectium_display-macos-arm64.dylib';
  return arch === 'arm64' ? 'libsectium_display-linux-arm64.so' : 'libsectium_display-linux-x64.so';
}

export function getAbiShimKey(platform: NodeJS.Platform = 'win32', arch = 'x64'): string {
  if (platform === 'win32') return 'b8g-shim.exe';
  if (platform === 'darwin') return 'b8g-shim-macos-arm64';
  return arch === 'arm64' ? 'b8g-shim-linux-arm64' : 'b8g-shim-linux-x64';
}

export function getObsExecutableRelPath(platform: NodeJS.Platform = 'win32'): string {
  const p = platform === 'win32' ? win32 : posix;
  if (platform === 'win32') return p.join('bin', '64bit', 'obs64.exe');
  if (platform === 'darwin') return p.join('OBS.app', 'Contents', 'MacOS', 'OBS');
  return p.join('bin', 'obs');
}

export async function resolveObsStudioPlan(
  options: ResolveObsPlanOptions = {},
): Promise<ObsStudioPlan> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const manifest =
    options.manifest ??
    (await fetchHoloV11Manifest(options.forceRefresh ?? false, options.indexUrl ?? HOLO_V11_INDEX_URL));

  const target = normalizeHoloTarget(platform, arch);
  const obsKey = getObsAssetKey(platform, arch);
  const displayKey = getSectiumDisplayKey(platform, arch);
  const shimKey = getAbiShimKey(platform, arch);

  const rawObs =
    findHoloV11Entry(manifest, 'obs', (e) => e.filename === obsKey) ??
    findHoloV11Entry(manifest, 'obs', (e) => e.target === target && !e.filename.endsWith('.pdb'));
  const sectiumDisplay = findHoloV11Entry(manifest, 'sectium-browser', (e) => e.filename === displayKey);
  const abiShim = findHoloV11Entry(manifest, 'holo-compiler', (e) => e.filename === shimKey);

  if (!rawObs) throw new Error(`Missing "${obsKey}" in Holo v11 manifest`);
  if (!sectiumDisplay) throw new Error(`Missing "${displayKey}" in Holo v11 manifest`);
  if (!abiShim) throw new Error(`Missing "${shimKey}" in Holo v11 manifest`);

  const obs = applyKeepLast5PinV11(rawObs, options.pinnedSha512);
  const cacheDir = options.cacheDir ?? getB8gCasDir();
  const installDir = join(cacheDir, 'obs', obs.sha512.slice(0, 16));

  return {
    platform,
    arch,
    indexSchema: manifest.schema,
    casBaseUrl: HOLO_V11_CAS_BASE_URL,
    cacheDir,
    installDir,
    obs,
    sectiumDisplay,
    abiShim,
  };
}

export function buildObsLaunchCommand(
  plan: ObsStudioPlan,
  options: ObsLaunchOptions = {},
): ObsLaunchCommand {
  const p = plan.platform === 'win32' ? win32 : posix;
  const exeRel = getObsExecutableRelPath(plan.platform);
  const command = p.join(plan.installDir, exeRel);
  const cwd = p.dirname(command);

  const args: string[] = [];
  if (options.portable !== false) args.push('--portable');
  if (options.scene) args.push('--scene', options.scene);
  if (options.collection) args.push('--collection', options.collection);
  if (options.profile) args.push('--profile', options.profile);
  if (options.startRecording) args.push('--startrecording');
  if (options.minimizeToTray) args.push('--minimize-to-tray');
  if (options.extraArgs) args.push(...options.extraArgs);

  const env: Record<string, string> = {
    B8G_CAS_DIR: plan.cacheDir,
    B8G_OBS_VERSION: plan.obs.tag,
    B8G_OBS_SHA512: plan.obs.sha512,
    B8G_SECTIUM_DISPLAY_SHA512: plan.sectiumDisplay.sha512,
    B8G_ABI_SHIM_SHA512: plan.abiShim.sha512,
    ...(options.overlayUrl ? { OBS_OVERLAY_URL: options.overlayUrl } : {}),
    ...(options.env ?? {}),
  };

  return { command, args, cwd, env };
}

export async function activate(
  context?: ExtensionContextLike,
  vscodeApi?: VscodeApiLike,
): Promise<void> {
  let api = vscodeApi;
  if (!api) {
    try {
      api = (await import('vscode' as string)) as VscodeApiLike;
    } catch {
      return;
    }
  }
  const sub = api.commands.registerCommand('obsGhost.hydrate', async () => {
    const plan = await resolveObsStudioPlan();
    api?.window?.showInformationMessage(`OBS Studio ${plan.obs.tag} resolved from Holo v11 CAS`);
  });
  activeDisposables.push(sub);
  context?.subscriptions?.push(sub);
}

export function deactivate(): void {
  while (activeDisposables.length > 0) {
    activeDisposables.pop()?.dispose();
  }
}
