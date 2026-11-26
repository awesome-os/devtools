/**
 * @file src/extension.mts
 * @description MIT Unity 6 extension for Awesome-OS Code - OSS & Eclipse Theia.
 *   Resolves .NET + b8g-shim + libsectium_display from `awesome-os/holo-v11` (`casLayout: "v11"`, SHA-512).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  fetchHoloV11Manifest,
  findHoloV11Entry,
  getB8gCasDir,
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

export interface UnityProjectInfo {
  readonly projectPath: string;
  readonly isUnityProject: boolean;
  readonly editorVersion: string | null;
  readonly solutionFile: string | null;
}

export interface UnityStudioPlan {
  readonly platform: NodeJS.Platform;
  readonly cacheDir: string;
  readonly dotnetSdk: HoloV11Entry;
  readonly abiShim: HoloV11Entry;
  readonly sectiumDisplay: HoloV11Entry;
  readonly dotnetInstallDir: string;
  readonly unityEditorPath: string | null;
}

export interface CommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export function getCasCacheDir(): string {
  return getB8gCasDir();
}

export function getDotnetSdkAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') return 'dotnet.exe';
  if (platform === 'darwin') return 'dotnet-macos-arm64';
  return arch === 'arm64' ? 'dotnet-linux-arm64' : 'dotnet-linux-x64';
}

export function getAbiShimAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') return 'b8g-shim.exe';
  if (platform === 'darwin') return 'b8g-shim-macos-arm64';
  return arch === 'arm64' ? 'b8g-shim-linux-arm64' : 'b8g-shim-linux-x64';
}

export function getSectiumDisplayAssetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') return 'libsectium_display.dll';
  if (platform === 'darwin') return 'libsectium_display-macos-arm64.dylib';
  return arch === 'arm64' ? 'libsectium_display-linux-arm64.so' : 'libsectium_display-linux-x64.so';
}

export function detectUnityProject(workspaceDir: string): UnityProjectInfo {
  const projectPath = resolve(workspaceDir);
  const versionFile = join(projectPath, 'ProjectSettings', 'ProjectVersion.txt');
  if (!existsSync(versionFile)) {
    return { projectPath, isUnityProject: false, editorVersion: null, solutionFile: null };
  }
  const text = readFileSync(versionFile, 'utf8');
  const m = /m_EditorVersion:\s*([^\r\n]+)/.exec(text);
  const editorVersion = m ? m[1].trim() : null;
  const folderName = projectPath.split(/[/\\]/).pop() ?? 'Assembly-CSharp';
  const candidateSln = join(projectPath, `${folderName}.sln`);
  return {
    projectPath,
    isUnityProject: true,
    editorVersion,
    solutionFile: existsSync(candidateSln) ? candidateSln : null,
  };
}

export function findUnityEditorBinary(
  editorVersion?: string | null,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.UNITY_EDITOR_PATH && existsSync(env.UNITY_EDITOR_PATH)) {
    return env.UNITY_EDITOR_PATH;
  }
  if (!editorVersion) return null;
  const candidates =
    platform === 'win32'
      ? [
          join('C:\\Program Files\\Unity\\Hub\\Editor', editorVersion, 'Editor', 'Unity.exe'),
          join('D:\\Unity\\Hub\\Editor', editorVersion, 'Editor', 'Unity.exe'),
        ]
      : platform === 'darwin'
        ? [join('/Applications/Unity/Hub/Editor', editorVersion, 'Unity.app/Contents/MacOS/Unity')]
        : [join(homedir(), 'Unity/Hub/Editor', editorVersion, 'Editor/Unity')];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export async function resolveUnityStudioPlan(
  options: {
    platform?: NodeJS.Platform;
    arch?: string;
    editorVersion?: string | null;
    manifest?: HoloV11GlobalManifest;
  } = {},
): Promise<UnityStudioPlan> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const manifest = options.manifest ?? (await fetchHoloV11Manifest());

  const dotnetKey = getDotnetSdkAssetKey(platform, arch);
  const shimKey = getAbiShimAssetKey(platform, arch);
  const displayKey = getSectiumDisplayAssetKey(platform, arch);

  const dotnetSdk = findHoloV11Entry(manifest, 'dotnet', (e) => e.filename === dotnetKey);
  const abiShim = findHoloV11Entry(manifest, 'holo-compiler', (e) => e.filename === shimKey);
  const sectiumDisplay = findHoloV11Entry(manifest, 'sectium-browser', (e) => e.filename === displayKey);

  if (!dotnetSdk) throw new Error(`Missing "${dotnetKey}" in Holo v11 manifest`);
  if (!abiShim) throw new Error(`Missing "${shimKey}" in Holo v11 manifest`);
  if (!sectiumDisplay) throw new Error(`Missing "${displayKey}" in Holo v11 manifest`);

  const cacheDir = getCasCacheDir();
  return {
    platform,
    cacheDir,
    dotnetSdk,
    abiShim,
    sectiumDisplay,
    dotnetInstallDir: join(cacheDir, 'dotnet', dotnetSdk.sha512.slice(0, 16)),
    unityEditorPath: findUnityEditorBinary(options.editorVersion ?? null, platform),
  };
}

export function buildDotnetRoslynCommand(
  plan: UnityStudioPlan,
  projectPath: string,
  configuration = 'Debug',
): CommandSpec {
  const dotnetBin = join(
    plan.dotnetInstallDir,
    plan.platform === 'win32' ? 'dotnet.exe' : 'dotnet',
  );
  return {
    command: dotnetBin,
    args: ['build', '--configuration', configuration, '--nologo'],
    cwd: resolve(projectPath),
    env: {
      DOTNET_ROOT: plan.dotnetInstallDir,
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      B8G_CAS_DIR: plan.cacheDir,
    },
  };
}

export function buildUnityBatchCommand(
  editorPath: string,
  projectPath: string,
  mode: 'open' | 'test-editmode' | 'test-playmode' = 'open',
): CommandSpec {
  const baseArgs = ['-projectPath', resolve(projectPath)];
  if (mode === 'test-editmode') {
    baseArgs.push('-batchmode', '-runTests', '-testPlatform', 'EditMode', '-logFile', '-');
  } else if (mode === 'test-playmode') {
    baseArgs.push('-batchmode', '-runTests', '-testPlatform', 'PlayMode', '-logFile', '-');
  }
  return {
    command: editorPath,
    args: baseArgs,
    cwd: resolve(projectPath),
    env: {
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      B8G_CAS_DIR: getCasCacheDir(),
    },
  };
}

export async function activate(context?: { subscriptions?: Array<{ dispose(): void }> }): Promise<void> {
  try {
    const vscode = (await import('vscode' as string)) as {
      commands: { registerCommand: (id: string, cb: () => Promise<void>) => { dispose(): void } };
      window: { showInformationMessage: (msg: string) => void };
    };
    const sub = vscode.commands.registerCommand('unityGhost.hydrateToolchain', async () => {
      const plan = await resolveUnityStudioPlan();
      vscode.window.showInformationMessage(
        `[Unity Ghost] Resolved .NET ${plan.dotnetSdk.tag} + B8G ABI shim from Holo v11 CAS.`,
      );
    });
    context?.subscriptions?.push(sub);
  } catch {
    // Headless / Node test mode
  }
}

export function deactivate(): void {
  // No persistent handles to release
}
