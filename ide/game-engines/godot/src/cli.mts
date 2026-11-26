#!/usr/bin/env node
/**
 * @file src/cli.mts
 * @description Zero-installer `godot` CLI backed by `awesome-os/holo-v11` (`casLayout: "v11"`).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchGodotManifest,
  getCasCacheDir,
  getGodotAssetKey,
  getGodotExecutableRelPath,
  tryResolveGodotEntry,
} from './hydrate.mts';

export interface ParsedCliArgs {
  dryRun: boolean;
  showVersion: boolean;
  showHelp: boolean;
  forwardArgs: string[];
}

export interface LaunchPlan {
  version: string;
  casLayout: 'v11';
  cacheDir: string;
  godot: {
    assetKey: string;
    status: 'resolved' | 'pending-ingest';
    sha512: string | null;
    size: number | null;
    godotVersion: string | null;
    executablePath: string | null;
    workingDir: string | null;
  };
  forwardArgs: string[];
}

export function getPackageVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.2.0';
  } catch {
    return '0.2.0';
  }
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const forwardArgs: string[] = [];
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
    if (!passthrough && arg === '--no-splash') {
      continue;
    }
    forwardArgs.push(arg);
  }

  return { dryRun, showVersion, showHelp, forwardArgs };
}

export async function buildLaunchPlan(parsed: ParsedCliArgs): Promise<LaunchPlan> {
  const manifest = await fetchGodotManifest();
  const cacheDir = getCasCacheDir();
  const godotKey = getGodotAssetKey();
  const entry = await tryResolveGodotEntry(godotKey, manifest);
  const executablePath = entry
    ? join(cacheDir, 'godot', entry.sha512.slice(0, 16), getGodotExecutableRelPath())
    : null;
  const workingDir = executablePath ? dirname(executablePath) : null;

  return {
    version: getPackageVersion(),
    casLayout: 'v11',
    cacheDir,
    godot: {
      assetKey: godotKey,
      status: entry ? 'resolved' : 'pending-ingest',
      sha512: entry?.sha512 ?? null,
      size: entry?.size ?? null,
      godotVersion: entry?.tag ?? null,
      executablePath,
      workingDir,
    },
    forwardArgs: parsed.forwardArgs,
  };
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv);

  if (parsed.showVersion) {
    console.log(
      `@awesome-os/godot ${getPackageVersion()} (${process.platform}/${process.arch} | godot=${getGodotAssetKey()})`,
    );
    return;
  }

  if (parsed.showHelp) {
    console.log(
      [
        `godot ${getPackageVersion()} - Rolling-latest MIT Godot 4 on Holo v11 CAS`,
        '',
        'Usage: godot [options] [godot flags...]',
        '  --dry-run     Resolve Holo v11 CAS entry and print launch plan JSON',
        '  --no-splash   Skip Lumi Hydration Splash',
        '  -v, --version Print version and platform Holo v11 asset key',
      ].join('\n'),
    );
    return;
  }

  const plan = await buildLaunchPlan(parsed);
  console.log(JSON.stringify(plan, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await runCli();
}
