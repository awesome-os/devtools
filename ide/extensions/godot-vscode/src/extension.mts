import { join } from 'node:path';
import {
  fetchHoloV11Manifest,
  findHoloV11Entry,
  HOLO_V11_CAS_BASE_URL,
  HOLO_V11_INDEX_URL,
  type HoloV11Entry,
  type HoloV11GlobalManifest,
} from '../../../shared/holo-v11-cas.mts';

export {
  HOLO_V11_CAS_BASE_URL,
  HOLO_V11_INDEX_URL,
  type HoloV11Entry,
  type HoloV11GlobalManifest,
};

export type HoloPlatformTarget =
  | 'win64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'macos-arm64'
  | 'macos-x64';

export type GodotAction = 'hydrate' | 'run' | 'editor' | 'export' | 'dotnet-build';

export interface ResolveGodotStudioPlanOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly target?: HoloPlatformTarget;
  readonly manifest?: HoloV11GlobalManifest;
  readonly indexUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface GodotStudioPlan {
  readonly target: HoloPlatformTarget;
  readonly casLayout: 'v11';
  readonly casBaseUrl: string;
  readonly indexUrl: string;
  readonly godot: HoloV11Entry | null;
  readonly godotStatus: 'available' | 'pending-cas-ingest';
  readonly dotnetSdk: HoloV11Entry | null;
  readonly abiShim: HoloV11Entry | null;
  readonly hydratedAssets: readonly HoloV11Entry[];
  readonly missingComponents: readonly ('godot' | 'dotnet' | 'b8g-shim')[];
  readonly ready: boolean;
  readonly env: Readonly<Record<string, string>>;
}

export interface GodotRunCommandOptions {
  readonly action: GodotAction;
  readonly godotExecutable?: string;
  readonly dotnetExecutable?: string;
  readonly projectPath?: string;
  readonly scene?: string;
  readonly preset?: string;
  readonly outputPath?: string;
  readonly debugExport?: boolean;
  readonly headless?: boolean;
  readonly extraArgs?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
}

export interface GodotRunCommand {
  readonly action: GodotAction;
  readonly executable: string;
  readonly args: readonly string[];
  readonly commandLine: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface DisposableLike {
  dispose(): void;
}

export interface ExtensionContextLike {
  readonly subscriptions: DisposableLike[];
}

export interface VscodeLikeApi {
  readonly commands?: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): DisposableLike;
  };
  readonly tasks?: {
    registerTaskProvider(type: string, provider: unknown): DisposableLike;
  };
  readonly window?: {
    showInformationMessage?(message: string): unknown;
  };
}

export const CONTRIBUTED_COMMANDS = [
  'godotGhost.hydrate',
  'godotGhost.runProject',
  'godotGhost.openEditor',
  'godotGhost.exportBuild',
] as const;

let activeDisposables: DisposableLike[] = [];

export function normalizePlatformTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): HoloPlatformTarget {
  if (platform === 'win32') return 'win64';
  if (platform === 'darwin') return arch === 'x64' ? 'macos-x64' : 'macos-arm64';
  return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

export async function resolveGodotStudioPlan(
  options: ResolveGodotStudioPlanOptions = {},
): Promise<GodotStudioPlan> {
  const target = options.target ?? normalizePlatformTarget(options.platform, options.arch);
  const indexUrl = options.indexUrl ?? HOLO_V11_INDEX_URL;
  const manifest = options.manifest ?? (await fetchHoloV11Manifest(false, indexUrl, options.fetchImpl));

  const godot = findHoloV11Entry(manifest, 'godot', (e) => e.target === target && !e.filename.endsWith('.pdb'));
  const dotnetSdk = findHoloV11Entry(manifest, 'dotnet', (e) => e.target === target);
  const abiShim = findHoloV11Entry(manifest, 'holo-compiler', (e) => e.target === target);

  const hydratedAssets: HoloV11Entry[] = [];
  const missingComponents: ('godot' | 'dotnet' | 'b8g-shim')[] = [];

  if (godot) hydratedAssets.push(godot);
  else missingComponents.push('godot');

  if (dotnetSdk) hydratedAssets.push(dotnetSdk);
  else missingComponents.push('dotnet');

  if (abiShim) hydratedAssets.push(abiShim);
  else missingComponents.push('b8g-shim');

  const env: Record<string, string> = {
    B8G_CAS_LAYOUT: 'v11',
    B8G_TARGET: target,
    ...(godot ? { B8G_GODOT_VERSION: godot.tag, B8G_GODOT_SHA512: godot.sha512 } : {}),
    ...(dotnetSdk ? { B8G_DOTNET_VERSION: dotnetSdk.tag, B8G_DOTNET_SHA512: dotnetSdk.sha512 } : {}),
  };

  return {
    target,
    casLayout: 'v11',
    casBaseUrl: HOLO_V11_CAS_BASE_URL,
    indexUrl,
    godot,
    godotStatus: godot ? 'available' : 'pending-cas-ingest',
    dotnetSdk,
    abiShim,
    hydratedAssets,
    missingComponents,
    ready: missingComponents.length === 0,
    env,
  };
}

export function buildGodotRunCommand(options: GodotRunCommandOptions): GodotRunCommand {
  const platform = options.platform ?? process.platform;
  const cwd = options.projectPath ?? process.cwd();
  const godotBin = options.godotExecutable ?? (platform === 'win32' ? 'godot.exe' : 'godot');
  const dotnetBin = options.dotnetExecutable ?? (platform === 'win32' ? 'dotnet.exe' : 'dotnet');

  let executable = godotBin;
  const args: string[] = [];

  if (options.action === 'dotnet-build') {
    executable = dotnetBin;
    args.push('build', '--nologo');
  } else {
    if (options.projectPath) args.push('--path', options.projectPath);
    if (options.action === 'editor') args.push('--editor');
    if (options.action === 'export') {
      args.push(options.debugExport ? '--export-debug' : '--export-release', options.preset ?? 'Default', options.outputPath ?? join(cwd, 'build'));
    }
    if (options.headless) args.push('--headless');
    if (options.scene) args.push(options.scene);
  }
  if (options.extraArgs) args.push(...options.extraArgs);

  return {
    action: options.action,
    executable,
    args,
    commandLine: [executable, ...args].join(' '),
    cwd,
    env: { ...(options.env ?? {}) },
  };
}

export function activate(context?: ExtensionContextLike, api?: VscodeLikeApi): void {
  if (!api?.commands) return;
  for (const cmd of CONTRIBUTED_COMMANDS) {
    const d = api.commands.registerCommand(cmd, async () => resolveGodotStudioPlan());
    activeDisposables.push(d);
    context?.subscriptions?.push(d);
  }
}

export function deactivate(): void {
  while (activeDisposables.length > 0) {
    activeDisposables.pop()?.dispose();
  }
}
