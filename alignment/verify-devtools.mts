#!/usr/bin/env node
/**
 * @file alignment/verify-devtools.mts
 * @description Programmatic verifier for `awesome-os/devtools`:
 *   1. All 3 IDEs (`code-oss`, `theia`, `b8g-ide`)
 *   2. All 6 VS Code extensions (`stealifylang-vscode`, `obs-vscode`, `godot-vscode`,
 *      `blender-vscode`, `unity-vscode`, `unreal-vscode` + `native/b8g_unreal_bridge.h`)
 *   3. All 4 game engines (`b8g-game-engine`, `asymmetric-hunt`, `godot`, `blender`)
 *   4. Native C11 dynamic launchers + all 7 24-bit BMP splash assets
 *   5. Research blueprints (`01-*`, `03-*`, `04-*`)
 *   6. Zero legacy `b8g-ghost` / `B8G_GHOST` / `cas-v1` references in the repository
 *
 * Strictly `erasableSyntaxOnly: true` & zero external dependencies.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DevToolsVerificationResult {
  readonly ok: boolean;
  readonly idesVerified: number;
  readonly extensionsVerified: number;
  readonly gameEnginesVerified: number;
  readonly launcherSourcesVerified: number;
  readonly splashesVerified: number;
  readonly researchDocsVerified: number;
  readonly legacyReferencesFound: readonly string[];
  readonly errors: readonly string[];
}

interface DevToolsLock {
  readonly schema: string;
  readonly abiMagic: string;
  readonly casLayout: string;
  readonly casRegistry: string;
  readonly ides: ReadonlyArray<{ readonly id: string; readonly path: string; readonly entry: string }>;
  readonly extensions: ReadonlyArray<{
    readonly id: string;
    readonly path: string;
    readonly entry: string;
    readonly nativeHeader?: string;
  }>;
  readonly gameEngines: ReadonlyArray<{ readonly id: string; readonly path: string; readonly entry: string }>;
  readonly launchers: {
    readonly path: string;
    readonly sources: readonly string[];
    readonly bmpWidth: number;
    readonly bmpHeight: number;
    readonly bmpBpp: number;
    readonly splashBrands: readonly string[];
  };
  readonly researchDocs: readonly string[];
}

const LEGACY_PATTERN = /b8g-ghost|B8G_GHOST|(?<![a-zA-Z0-9-])cas-v1(?![0-9])/g;

function walkRepoFiles(dir: string, out: string[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkRepoFiles(full, out);
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
}

export function verifyDevToolsAlignment(
  repoRoot: string = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
): DevToolsVerificationResult {
  const errors: string[] = [];
  const lockPath = join(repoRoot, 'alignment', 'devtools-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as DevToolsLock;

  if (lock.abiMagic !== '0x33564742') {
    errors.push(`Expected abiMagic 0x33564742, got ${lock.abiMagic}`);
  }
  if (lock.casLayout !== 'v11') {
    errors.push(`Expected casLayout v11, got ${lock.casLayout}`);
  }
  if (lock.casRegistry !== 'awesome-os/holo-v11') {
    errors.push(`Expected casRegistry awesome-os/holo-v11, got ${lock.casRegistry}`);
  }

  let idesVerified = 0;
  for (const ide of lock.ides) {
    const entryPath = join(repoRoot, ide.path, ide.entry);
    if (!existsSync(entryPath)) {
      errors.push(`Missing IDE entry: ${ide.path}/${ide.entry}`);
    } else {
      idesVerified += 1;
    }
  }
  if (idesVerified !== 3) {
    errors.push(`Expected 3 IDEs verified, got ${idesVerified}`);
  }

  let extensionsVerified = 0;
  for (const ext of lock.extensions) {
    const entryPath = join(repoRoot, ext.path, ext.entry);
    if (!existsSync(entryPath)) {
      errors.push(`Missing extension entry: ${ext.path}/${ext.entry}`);
      continue;
    }
    if (ext.nativeHeader && !existsSync(join(repoRoot, ext.path, ext.nativeHeader))) {
      errors.push(`Missing extension native header: ${ext.path}/${ext.nativeHeader}`);
      continue;
    }
    extensionsVerified += 1;
  }
  if (extensionsVerified !== 6) {
    errors.push(`Expected 6 VS Code extensions verified, got ${extensionsVerified}`);
  }

  let gameEnginesVerified = 0;
  for (const eng of lock.gameEngines) {
    const entryPath = join(repoRoot, eng.path, eng.entry);
    if (!existsSync(entryPath)) {
      errors.push(`Missing game engine entry: ${eng.path}/${eng.entry}`);
    } else {
      gameEnginesVerified += 1;
    }
  }
  if (gameEnginesVerified !== 4) {
    errors.push(`Expected 4 game engines verified, got ${gameEnginesVerified}`);
  }

  let launcherSourcesVerified = 0;
  for (const src of lock.launchers.sources) {
    const p = join(repoRoot, lock.launchers.path, src);
    if (!existsSync(p)) {
      errors.push(`Missing launcher source: ${lock.launchers.path}/${src}`);
    } else {
      launcherSourcesVerified += 1;
    }
  }

  let splashesVerified = 0;
  const expectedBmpSize = 54 + lock.launchers.bmpWidth * 3 * lock.launchers.bmpHeight;
  for (const brand of lock.launchers.splashBrands) {
    const bmpPath = join(repoRoot, lock.launchers.path, 'assets', `${brand}.bmp`);
    if (!existsSync(bmpPath)) {
      errors.push(`Missing 24-bit BMP splash asset: ${lock.launchers.path}/assets/${brand}.bmp`);
      continue;
    }
    const buf = readFileSync(bmpPath);
    if (
      buf.byteLength !== expectedBmpSize ||
      buf.subarray(0, 2).toString('ascii') !== 'BM' ||
      buf.readUInt32LE(18) !== lock.launchers.bmpWidth ||
      buf.readUInt32LE(22) !== lock.launchers.bmpHeight ||
      buf.readUInt16LE(28) !== lock.launchers.bmpBpp
    ) {
      errors.push(`Invalid 24-bit BMP header or size in assets/${brand}.bmp`);
      continue;
    }
    splashesVerified += 1;
  }

  let researchDocsVerified = 0;
  for (const doc of lock.researchDocs) {
    if (!existsSync(join(repoRoot, doc))) {
      errors.push(`Missing research document: ${doc}`);
    } else {
      researchDocsVerified += 1;
    }
  }

  const allFiles: string[] = [];
  walkRepoFiles(repoRoot, allFiles);
  const legacyReferencesFound: string[] = [];
  for (const file of allFiles) {
    const rel = relative(repoRoot, file).replace(/\\/g, '/');
    if (
      rel === 'alignment/verify-devtools.mts' ||
      rel === 'alignment/verify-devtools.test.mts' ||
      rel.endsWith('.bmp')
    ) {
      continue;
    }
    const content = readFileSync(file, 'utf8');
    const matches = content.match(LEGACY_PATTERN);
    if (matches && matches.length > 0) {
      legacyReferencesFound.push(`${rel} (${matches.join(', ')})`);
    }
  }
  if (legacyReferencesFound.length > 0) {
    errors.push(`Legacy b8g-ghost/cas-v1 references found: ${legacyReferencesFound.join('; ')}`);
  }

  return {
    ok: errors.length === 0,
    idesVerified,
    extensionsVerified,
    gameEnginesVerified,
    launcherSourcesVerified,
    splashesVerified,
    researchDocsVerified,
    legacyReferencesFound,
    errors,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = verifyDevToolsAlignment();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}
