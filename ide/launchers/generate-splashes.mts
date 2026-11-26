#!/usr/bin/env node
/**
 * @file ide/launchers/generate-splashes.mts
 * @description Compiles C11 `splash_blitter.c` and generates deterministic 24-bit BMP
 *   splashscreens for all 7 Awesome-OS DevTools brands into `ide/launchers/assets/*.bmp`.
 *
 * Strictly `erasableSyntaxOnly: true` & zero external dependencies.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPLASH_BRANDS = [
  'godot',
  'blender',
  'unity',
  'unreal',
  'asymmetric-hunt',
  'code-oss',
  'theia',
] as const;

export type SplashBrand = (typeof SPLASH_BRANDS)[number];

export const SPLASH_WIDTH = 480;
export const SPLASH_HEIGHT = 180;
export const SPLASH_BMP_BYTES = 54 + SPLASH_WIDTH * 3 * SPLASH_HEIGHT;

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ASSETS_DIR = join(HERE, 'assets');

export interface CCompilerSpec {
  readonly bin: string;
  readonly baseArgs: readonly string[];
  readonly isZig: boolean;
}

export function resolveC11Compiler(): CCompilerSpec {
  const zigCandidates = [
    process.env.ZIG_BIN,
    process.platform === 'win32' ? 'E:\\awesome-os\\bin\\zig.cmd' : undefined,
    'zig',
  ].filter((v): v is string => Boolean(v));

  for (const candidate of zigCandidates) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (existsSync(candidate)) {
        return { bin: candidate, baseArgs: ['cc'], isZig: true };
      }
      continue;
    }
    const probe = spawnSync(candidate, ['version'], { stdio: 'pipe' });
    if (probe.status === 0) {
      return { bin: candidate, baseArgs: ['cc'], isZig: true };
    }
  }

  for (const cc of ['cc', 'gcc', 'clang']) {
    if (spawnSync(cc, ['--version'], { stdio: 'pipe' }).status === 0) {
      return { bin: cc, baseArgs: [], isZig: false };
    }
  }

  throw new Error('No C11 compiler (zig cc, cc, gcc, or clang) found');
}

export function runC11Compiler(spec: CCompilerSpec, args: readonly string[]): void {
  const fullArgs = [...spec.baseArgs, ...args];
  if (process.platform === 'win32' && spec.bin.toLowerCase().endsWith('.cmd')) {
    execFileSync('cmd.exe', ['/d', '/s', '/c', spec.bin, ...fullArgs], { stdio: 'pipe' });
  } else {
    execFileSync(spec.bin, fullArgs, { stdio: 'pipe' });
  }
}

export function generateAllSplashes(outDir: string = DEFAULT_ASSETS_DIR): string[] {
  mkdirSync(outDir, { recursive: true });
  const comp = resolveC11Compiler();
  const workDir = mkdtempSync(join(tmpdir(), 'b8g-splash-gen-'));
  const exeName = process.platform === 'win32' ? 'splash_gen.exe' : 'splash_gen';
  const exePath = join(workDir, exeName);

  try {
    runC11Compiler(comp, [
      '-std=c11',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-DB8G_SPLASH_CLI_MAIN',
      `-I${HERE}`,
      join(HERE, 'splash_blitter.c'),
      '-o',
      exePath,
    ]);

    const outputs: string[] = [];
    for (const brand of SPLASH_BRANDS) {
      const outBmp = join(outDir, `${brand}.bmp`);
      execFileSync(exePath, [brand, outBmp, '100', '33564742v110'], { stdio: 'pipe' });
      outputs.push(outBmp);
    }
    return outputs;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const generated = generateAllSplashes();
  console.log(`Generated ${generated.length} 24-bit BMP splash assets in ${DEFAULT_ASSETS_DIR}`);
}
