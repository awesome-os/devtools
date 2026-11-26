#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AWESOME_OS_BUNDLED_EXTENSIONS,
  ensureSharedExtensionsDir,
  fetchTheiaManifest,
  getAbiShimAssetKey,
  getCasCacheDir,
  getElectronAssetKey,
  getElectronExecutableRelPath,
  getTypeScriptAssetKey,
  resolveAbiShimEntry,
  resolveElectronEntry,
  resolveTheiaBundleEntry,
  resolveTypeScriptEntry,
  type BundledAwesomeOsExtension,
} from './hydrate.mts';

export type TheiaLaunchMode = 'sectium' | 'electron';

export interface ParsedCliArgs {
  mode: TheiaLaunchMode;
  dryRun: boolean;
  showVersion: boolean;
  showHelp: boolean;
  workspaceDir: string;
  passthroughArgs: string[];
}

export interface TheiaLaunchPlan {
  adapter: '@awesome-os/theia';
  version: string;
  casLayout: 'v11';
  mode: TheiaLaunchMode;
  zeroElectron: boolean;
  workspaceDir: string;
  extensionsDir: string;
  bundledExtensions: readonly BundledAwesomeOsExtension[];
  ipcProtocol: 'B8G_ARENA_V1';
  env: Record<string, string>;
  command: string;
  args: string[];
  theiaBundle: {
    assetKey: string;
    sha512: string;
    size: number;
    downloadUrl: string;
  };
  typescript: {
    assetKey: string;
    tag: string;
    sha512: string;
    size: number;
    installDir: string;
    tsdkPath: string;
    downloadUrl: string;
  };
  electron?: {
    assetKey: string;
    sha512: string;
    size: number;
    installDir: string;
    executablePath: string;
    downloadUrl: string;
  };
  abiShim?: {
    assetKey: string;
    sha512: string;
    size: number;
    shimPath: string;
    downloadUrl: string;
  };
  sectium?: {
    target: 'sectium-browser';
    displayChannel: string;
  };
}

export function getPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.2.1';
  } catch {
    return '0.2.1';
  }
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let mode: TheiaLaunchMode = 'sectium';
  let dryRun = false;
  let showVersion = false;
  let showHelp = false;
  let workspaceDir = process.cwd();
  const passthroughArgs: string[] = [];

  for (const arg of argv) {
    if (arg === '--browser' || arg === '--sectium') {
      mode = 'sectium';
    } else if (arg === '--electron') {
      mode = 'electron';
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--version' || arg === '-v') {
      showVersion = true;
    } else if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else if (!arg.startsWith('-') && workspaceDir === process.cwd()) {
      workspaceDir = resolve(arg);
    } else {
      passthroughArgs.push(arg);
    }
  }

  return { mode, dryRun, showVersion, showHelp, workspaceDir, passthroughArgs };
}

export function formatHelpText(): string {
  return [
    `@awesome-os/theia v${getPackageVersion()}`,
    '',
    'Eclipse Theia IDE adapter over Sectium Display / shared Electron + Holo v11 CAS,',
    'B8G_ARENA_V1 zero-copy IPC, and shared extensions cache (~/.b8g/cas/extensions/).',
    '',
    'Usage:',
    '  theia [workspace-dir] [options]',
    '',
    'Options:',
    '  --sectium, --browser   Launch in Sectium Display / sectium-browser mode (default, zero Electron)',
    '  --electron             Launch with shared Holo v11 Electron + B8G ABI shim',
    '  --dry-run              Resolve Holo v11 entries and print JSON launch plan',
    '  -v, --version          Print adapter version',
    '  -h, --help             Print this help message',
  ].join('\n');
}

function getDefaultSectiumPipe(): string {
  return process.platform === 'win32' ? '\\\\.\\pipe\\sectium-dev' : '/tmp/sectium-dev.sock';
}

export async function buildLaunchPlan(parsed: ParsedCliArgs): Promise<TheiaLaunchPlan> {
  const manifest = await fetchTheiaManifest();
  const cacheDir = getCasCacheDir();
  const extInfo = ensureSharedExtensionsDir();
  const theiaEntry = await resolveTheiaBundleEntry(manifest);
  const tsEntry = await resolveTypeScriptEntry(getTypeScriptAssetKey(), manifest);

  const tsInstallDir = join(cacheDir, 'typescript', tsEntry.sha512.slice(0, 16));
  const tsdkPath = join(tsInstallDir, 'lib');
  const bundledIds = AWESOME_OS_BUNDLED_EXTENSIONS.map((e) => e.id).join(',');

  const baseEnv: Record<string, string> = {
    THEIA_DEFAULT_PLUGINS: extInfo.theiaDefaultPlugins,
    AWESOME_OS_TYPESCRIPT_TSDK: tsdkPath,
    TYPESCRIPT_TSDK: tsdkPath,
    AWESOME_OS_BUNDLED_EXTENSIONS: bundledIds,
    B8G_APP_NAME: 'Awesome-OS Theia',
    B8G_CAS_DIR: cacheDir,
    B8G_LIBELECTRON_DIR: join(cacheDir, 'libelectron'),
  };

  if (parsed.mode === 'electron') {
    const electronEntry = await resolveElectronEntry(getElectronAssetKey(), manifest);
    const abiEntry = await resolveAbiShimEntry(getAbiShimAssetKey(), manifest);
    const electronDir = join(cacheDir, 'electron', electronEntry.sha512.slice(0, 16));
    const executablePath = join(electronDir, getElectronExecutableRelPath());
    const shimPath = join(cacheDir, 'abi-shim', abiEntry.sha512.slice(0, 16), abiEntry.filename);
    baseEnv.B8G_ABI_PATH = shimPath;

    return {
      adapter: '@awesome-os/theia',
      version: getPackageVersion(),
      casLayout: 'v11',
      mode: 'electron',
      zeroElectron: false,
      workspaceDir: parsed.workspaceDir,
      extensionsDir: extInfo.extensionsDir,
      bundledExtensions: AWESOME_OS_BUNDLED_EXTENSIONS,
      ipcProtocol: 'B8G_ARENA_V1',
      env: baseEnv,
      command: executablePath,
      args: [parsed.workspaceDir, ...parsed.passthroughArgs],
      theiaBundle: {
        assetKey: theiaEntry.filename,
        sha512: theiaEntry.sha512,
        size: theiaEntry.size,
        downloadUrl: theiaEntry.downloadUrl,
      },
      typescript: {
        assetKey: tsEntry.filename,
        tag: tsEntry.tag,
        sha512: tsEntry.sha512,
        size: tsEntry.size,
        installDir: tsInstallDir,
        tsdkPath,
        downloadUrl: tsEntry.downloadUrl,
      },
      electron: {
        assetKey: electronEntry.filename,
        sha512: electronEntry.sha512,
        size: electronEntry.size,
        installDir: electronDir,
        executablePath,
        downloadUrl: electronEntry.downloadUrl,
      },
      abiShim: {
        assetKey: abiEntry.filename,
        sha512: abiEntry.sha512,
        size: abiEntry.size,
        shimPath,
        downloadUrl: abiEntry.downloadUrl,
      },
    };
  }

  return {
    adapter: '@awesome-os/theia',
    version: getPackageVersion(),
    casLayout: 'v11',
    mode: 'sectium',
    zeroElectron: true,
    workspaceDir: parsed.workspaceDir,
    extensionsDir: extInfo.extensionsDir,
    bundledExtensions: AWESOME_OS_BUNDLED_EXTENSIONS,
    ipcProtocol: 'B8G_ARENA_V1',
    env: baseEnv,
    command: 'sectium-browser',
    args: ['--channel=display', `--pipe=${getDefaultSectiumPipe()}`, parsed.workspaceDir, ...parsed.passthroughArgs],
    theiaBundle: {
      assetKey: theiaEntry.filename,
      sha512: theiaEntry.sha512,
      size: theiaEntry.size,
      downloadUrl: theiaEntry.downloadUrl,
    },
    typescript: {
      assetKey: tsEntry.filename,
      tag: tsEntry.tag,
      sha512: tsEntry.sha512,
      size: tsEntry.size,
      installDir: tsInstallDir,
      tsdkPath,
      downloadUrl: tsEntry.downloadUrl,
    },
    sectium: {
      target: 'sectium-browser',
      displayChannel: getDefaultSectiumPipe(),
    },
  };
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv);
  if (parsed.showVersion) {
    console.log(`@awesome-os/theia ${getPackageVersion()}`);
    return;
  }
  if (parsed.showHelp) {
    console.log(formatHelpText());
    return;
  }
  const plan = await buildLaunchPlan(parsed);
  console.log(JSON.stringify(plan, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await runCli();
}
