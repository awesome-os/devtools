#!/usr/bin/env node
/**
 * @file src/cli.mts
 * @description Zero-duplication `code-oss` CLI backed by `awesome-os/holo-v11` (`casLayout: "v11"`).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AWESOME_OS_BUNDLED_EXTENSIONS,
  ensureSharedExtensionsDir,
  fetchCodeOssManifest,
  getAbiShimAssetKey,
  getCasCacheDir,
  getCodeOssBinaryKey,
  getElectronAssetKey,
  getElectronExecutableRelPath,
  getTypeScriptAssetKey,
  resolveAbiShimEntry,
  resolveElectronEntry,
  resolveTypeScriptEntry,
  tryResolveCodeOssEntry,
  type BundledExtensionSpec,
} from './hydrate.mts';

export interface ParsedCliArgs {
  backend: 'sectium' | 'upstream';
  dryRun: boolean;
  showVersion: boolean;
  showHelp: boolean;
  forwardArgs: string[];
}

export interface LaunchPlan {
  version: string;
  casLayout: 'v11';
  backend: 'sectium' | 'upstream';
  cacheDir: string;
  extensionsDir: string;
  bundledExtensions: readonly BundledExtensionSpec[];
  electron: {
    assetKey: string;
    sha512: string;
    size: number;
    executablePath: string;
  };
  codeOssApp: {
    assetKey: string;
    status: 'resolved' | 'pending-ingest';
    sha512: string | null;
    size: number | null;
    tag: string | null;
    binaryPath: string | null;
  };
  abiShim: {
    assetKey: string;
    sha512: string;
    size: number;
    shimPath: string;
  };
  typescript: {
    assetKey: string;
    sha512: string;
    size: number;
    tag: string;
    installDir: string;
    tsdkDir: string;
  };
  forwardArgs: string[];
}

export function getPackageVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.3.0';
  } catch {
    return '0.3.0';
  }
}

export function parseCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ParsedCliArgs {
  const forwardArgs: string[] = [];
  let backendOverride: 'sectium' | 'upstream' | undefined;
  let dryRun = false;
  let showVersion = false;
  let showHelp = false;
  let passthrough = false;

  for (const arg of argv) {
    if (!passthrough && arg === '--') {
      passthrough = true;
      forwardArgs.push(arg);
      continue;
    }
    if (!passthrough && arg === '--sectium') {
      backendOverride = 'sectium';
      continue;
    }
    if (!passthrough && arg === '--upstream') {
      backendOverride = 'upstream';
      continue;
    }
    if (!passthrough && arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!passthrough && (arg === '--version' || arg === '-v')) {
      showVersion = true;
      continue;
    }
    if (!passthrough && (arg === '--help' || arg === '-h')) {
      showHelp = true;
      continue;
    }
    forwardArgs.push(arg);
  }

  const envBackend = env.CODE_OSS_BACKEND === 'sectium' ? 'sectium' : 'upstream';
  return {
    backend: backendOverride ?? envBackend,
    dryRun,
    showVersion,
    showHelp,
    forwardArgs,
  };
}

export async function buildLaunchPlan(parsed: ParsedCliArgs): Promise<LaunchPlan> {
  const manifest = await fetchCodeOssManifest();
  const cacheDir = getCasCacheDir();
  const extensionsDir = ensureSharedExtensionsDir();

  const electron = await resolveElectronEntry(getElectronAssetKey(), manifest);
  const codeOss = await tryResolveCodeOssEntry(getCodeOssBinaryKey(), manifest);
  const abiShim = await resolveAbiShimEntry(getAbiShimAssetKey(), manifest);
  const typescript = await resolveTypeScriptEntry(getTypeScriptAssetKey(), manifest);

  return {
    version: getPackageVersion(),
    casLayout: 'v11',
    backend: parsed.backend,
    cacheDir,
    extensionsDir,
    bundledExtensions: AWESOME_OS_BUNDLED_EXTENSIONS,
    electron: {
      assetKey: electron.filename,
      sha512: electron.sha512,
      size: electron.size,
      executablePath: join(cacheDir, 'electron', electron.sha512.slice(0, 16), getElectronExecutableRelPath()),
    },
    codeOssApp: {
      assetKey: getCodeOssBinaryKey(),
      status: codeOss ? 'resolved' : 'pending-ingest',
      sha512: codeOss?.sha512 ?? null,
      size: codeOss?.size ?? null,
      tag: codeOss?.tag ?? null,
      binaryPath: codeOss ? join(cacheDir, 'code-oss', codeOss.sha512.slice(0, 16), codeOss.filename) : null,
    },
    abiShim: {
      assetKey: abiShim.filename,
      sha512: abiShim.sha512,
      size: abiShim.size,
      shimPath: join(cacheDir, 'abi-shim', abiShim.sha512.slice(0, 16), abiShim.filename),
    },
    typescript: {
      assetKey: typescript.filename,
      sha512: typescript.sha512,
      size: typescript.size,
      tag: typescript.tag,
      installDir: join(cacheDir, 'typescript', typescript.sha512.slice(0, 16)),
      tsdkDir: join(cacheDir, 'typescript', typescript.sha512.slice(0, 16), 'lib'),
    },
    forwardArgs: parsed.forwardArgs,
  };
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv);

  if (parsed.showVersion) {
    console.log(
      `@awesome-os/code-oss ${getPackageVersion()} (${process.platform}/${process.arch} | electron=${getElectronAssetKey()} | code-oss=${getCodeOssBinaryKey()} | abi=${getAbiShimAssetKey()} | ts=${getTypeScriptAssetKey()})`,
    );
    return;
  }

  if (parsed.showHelp) {
    console.log(
      [
        `code-oss ${getPackageVersion()} — Telemetry-free Code - OSS on shared Electron + Holo v11 CAS`,
        '',
        'Usage: code-oss [options] [paths/flags...]',
        '  --sectium     Route via Sectium Display / WebRenderer',
        '  --upstream    Use shared upstream Electron from Holo v11 CAS (default)',
        '  --dry-run     Resolve Holo v11 CAS entries and print launch plan JSON',
        '  -v, --version Print version and Holo v11 CAS keys',
      ].join('\n'),
    );
    return;
  }

  const plan = await buildLaunchPlan(parsed);
  if (parsed.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  console.log(JSON.stringify(plan, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await runCli();
}
