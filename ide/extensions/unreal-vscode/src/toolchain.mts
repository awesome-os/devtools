/**
 * Zero-Visual-Studio Unreal Engine 5 toolchain resolver backed by
 * awesome-os/holo-v11 (`casLayout: "v11"`, SHA-512).
 */

import {
  fetchHoloV11Manifest,
  findHoloV11Entry,
  HOLO_V11_INDEX_URL,
  normalizeHoloTarget,
  type HoloV11Entry,
  type HoloV11GlobalManifest,
} from '../../../shared/holo-v11-cas.mts';

export { HOLO_V11_INDEX_URL, type HoloV11Entry, type HoloV11GlobalManifest };

export const HOLO_V11_CAS_TAG = 'v11';

export type UnrealGhostPlatform = 'win32' | 'linux' | 'darwin';

export type UbtBuildConfiguration = 'Debug' | 'DebugGame' | 'Development' | 'Shipping' | 'Test';

export interface ResolvedCasArtifact {
  readonly key: string;
  readonly filename: string;
  readonly sha512: string;
  readonly bytes: number;
  readonly downloadUrl: string;
  readonly version?: string;
}

export interface UnrealGhostToolchain {
  readonly platform: UnrealGhostPlatform;
  readonly ubtPlatform: 'Win64' | 'Linux' | 'Mac';
  readonly casTag: string;
  readonly dotnetSdk: ResolvedCasArtifact;
  readonly holoCompiler: ResolvedCasArtifact;
  readonly sectiumDisplay: ResolvedCasArtifact;
  readonly abiShim: ResolvedCasArtifact;
  readonly totalBytes: number;
}

export interface UbtCommandOptions {
  readonly engineRoot?: string;
  readonly cacheDir?: string;
  readonly generateCompileCommands?: boolean;
  readonly extraArgs?: readonly string[];
}

export interface UbtCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly projectPath: string;
  readonly target: string;
  readonly configuration: UbtBuildConfiguration;
  readonly ubtPlatform: 'Win64' | 'Linux' | 'Mac';
  readonly engineRoot: string;
  readonly toolchain: UnrealGhostToolchain;
}

function normalizePlatform(platform?: string): UnrealGhostPlatform {
  if (platform === 'win32' || platform === 'linux' || platform === 'darwin') return platform;
  if (platform === 'Win64' || platform === 'windows') return 'win32';
  if (platform === 'Linux') return 'linux';
  if (platform === 'Mac' || platform === 'macos') return 'darwin';
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
}

function toUbtPlatform(platform: UnrealGhostPlatform): 'Win64' | 'Linux' | 'Mac' {
  if (platform === 'win32') return 'Win64';
  if (platform === 'darwin') return 'Mac';
  return 'Linux';
}

function toArtifact(entry: HoloV11Entry): ResolvedCasArtifact {
  return {
    key: entry.filename,
    filename: entry.filename,
    sha512: entry.sha512,
    bytes: entry.size,
    downloadUrl: entry.downloadUrl,
    version: entry.tag,
  };
}

export async function fetchCasIndex(
  indexUrl: string = HOLO_V11_INDEX_URL,
): Promise<HoloV11GlobalManifest> {
  return fetchHoloV11Manifest(false, indexUrl);
}

export function resolveUnrealGhostToolchain(
  manifest: HoloV11GlobalManifest,
  platform?: UnrealGhostPlatform | string,
): UnrealGhostToolchain {
  const hostPlatform = normalizePlatform(platform);
  const target = normalizeHoloTarget(hostPlatform, hostPlatform === 'darwin' ? 'arm64' : 'x64');

  const dotnetEntry = findHoloV11Entry(manifest, 'dotnet', (e) => e.target === target);
  const holoEntry = findHoloV11Entry(manifest, 'holo-compiler', (e) => e.target === target);
  const sectiumEntry = findHoloV11Entry(
    manifest,
    'sectium-browser',
    (e) => e.filename.startsWith('libsectium_display') && e.target === target,
  );
  const abiEntry = findHoloV11Entry(manifest, 'holo-pm', (e) =>
    hostPlatform === 'win32'
      ? e.filename === 'libholo-pm-windows-x86_64.dll'
      : hostPlatform === 'darwin'
        ? e.filename === 'libholo-pm-macos-aarch64.dylib'
        : e.filename === 'libholo-pm-linux-x86_64.so',
  );

  if (!dotnetEntry) throw new Error(`Missing dotnet (${target}) in Holo v11 manifest`);
  if (!holoEntry) throw new Error(`Missing holo-compiler (${target}) in Holo v11 manifest`);
  if (!sectiumEntry) throw new Error(`Missing libsectium_display (${target}) in Holo v11 manifest`);
  if (!abiEntry) throw new Error(`Missing libholo-pm (${target}) in Holo v11 manifest`);

  const dotnetSdk = toArtifact(dotnetEntry);
  const holoCompiler = toArtifact(holoEntry);
  const sectiumDisplay = toArtifact(sectiumEntry);
  const abiShim = toArtifact(abiEntry);

  return {
    platform: hostPlatform,
    ubtPlatform: toUbtPlatform(hostPlatform),
    casTag: HOLO_V11_CAS_TAG,
    dotnetSdk,
    holoCompiler,
    sectiumDisplay,
    abiShim,
    totalBytes: dotnetSdk.bytes + holoCompiler.bytes + sectiumDisplay.bytes + abiShim.bytes,
  };
}

function joinPath(isWin: boolean, ...segments: string[]): string {
  const sep = isWin ? '\\' : '/';
  return segments
    .map((s, i) => (i === 0 ? s.replace(/[\\/]+$/, '') : s.replace(/^[\\/]+|[\\/]+$/g, '')))
    .filter((s) => s.length > 0)
    .join(sep);
}

export function buildUbtCommand(
  projectPath: string,
  target: string,
  config: UbtBuildConfiguration,
  toolchain: UnrealGhostToolchain,
  options: UbtCommandOptions = {},
): UbtCommandSpec {
  const isWin = toolchain.platform === 'win32';
  const engineRoot =
    options.engineRoot || (isWin ? 'C:\\Program Files\\Epic Games\\UE_5.5' : '/opt/UnrealEngine');
  const cacheDir = options.cacheDir || (isWin ? '.b8g\\unreal-ghost' : '.b8g/unreal-ghost');

  const dotnetRoot = joinPath(isWin, cacheDir, 'dotnet-sdk');
  const llvmRoot = joinPath(isWin, cacheDir, 'holo-llvm');
  const winsdkRoot = joinPath(isWin, cacheDir, 'holo-winsdk');
  const ninjaRoot = joinPath(isWin, cacheDir, 'holo-ninja');
  const sectiumDir = joinPath(isWin, cacheDir, 'sectium');

  const dotnetExe = joinPath(isWin, dotnetRoot, isWin ? 'dotnet.exe' : 'dotnet');
  const ninjaExe = joinPath(isWin, ninjaRoot, isWin ? 'ninja.exe' : 'ninja');
  const ubtDll = joinPath(
    isWin,
    engineRoot,
    'Engine',
    'Binaries',
    'DotNET',
    'UnrealBuildTool',
    'UnrealBuildTool.dll',
  );

  const args: string[] = [
    ubtDll,
    target,
    toolchain.ubtPlatform,
    config,
    `-Project=${projectPath}`,
    '-Compiler=Clang',
    '-Progress',
    '-NoHotReloadFromIDE',
  ];

  if (options.generateCompileCommands) args.push('-Mode=GenerateClangDatabase');
  if (options.extraArgs && options.extraArgs.length > 0) args.push(...options.extraArgs);

  const env: Record<string, string> = {
    DOTNET_ROOT: dotnetRoot,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    LLVM_HOME: llvmRoot,
    B8G_CAS_TAG: toolchain.casTag,
    B8G_DOTNET_SHA512: toolchain.dotnetSdk.sha512,
    B8G_HOLO_COMPILER_SHA512: toolchain.holoCompiler.sha512,
    B8G_WINSDK_ROOT: winsdkRoot,
    B8G_NINJA_EXE: ninjaExe,
    B8G_SECTIUM_DISPLAY_LIB: joinPath(isWin, sectiumDir, toolchain.sectiumDisplay.filename),
    B8G_ABI_SHIM_LIB: joinPath(isWin, sectiumDir, toolchain.abiShim.filename),
    UE_USE_GHOST_CLANG: '1',
    UE_ZERO_VISUAL_STUDIO: '1',
  };

  if (isWin) {
    env.WindowsSdkDir = joinPath(true, winsdkRoot, 'Windows Kits', '10');
    env.VCToolsInstallDir = joinPath(true, winsdkRoot, 'VC', 'Tools', 'MSVC');
    env.CC = joinPath(true, llvmRoot, 'bin', 'clang-cl.exe');
    env.CXX = joinPath(true, llvmRoot, 'bin', 'clang-cl.exe');
  } else {
    env.CC = joinPath(false, llvmRoot, 'bin', 'clang');
    env.CXX = joinPath(false, llvmRoot, 'bin', 'clang++');
  }

  return {
    command: dotnetExe,
    args,
    env,
    projectPath,
    target,
    configuration: config,
    ubtPlatform: toolchain.ubtPlatform,
    engineRoot,
    toolchain,
  };
}
