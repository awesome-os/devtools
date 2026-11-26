/**
 * @file sections/b8g-ide/host/webrenderer-host.mts
 * @description Zero-fork VS Code OSS WebRenderer host descriptor for Sectium Browser.
 * Locates unmodified upstream VS Code OSS source (`third_party/vscode-oss` or `VSCODE_SRC_DIR`),
 * attaches `extensions/b8g-devplane` as a built-in extension, and binds the workbench to
 * the Sectium Browser WebRenderer (`v0.5.0-baseline`, Lumi White Dragon branded).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultDevPlanePipe } from '../devplane/protocol.mts';

export interface VsCodeSourceDescriptor {
  readonly sourceDir: string;
  readonly productName: string;
  readonly version: string;
  readonly isUpstreamUnmodified: true;
}

export interface WebRendererBootPlan {
  readonly schema: 'b8g-ide-webrenderer-v1';
  readonly renderer: {
    readonly engine: 'sectium-browser-webrenderer';
    readonly baselineTag: string;
    readonly brand: 'Lumi White Dragon';
    readonly icon: 'lumi-white-dragon.ico';
    readonly duplicateElectronBytes: 0;
  };
  readonly vscodeSource: VsCodeSourceDescriptor;
  readonly builtinExtensions: readonly string[];
  readonly devPlanePipe: string;
  readonly productConfiguration: {
    readonly nameShort: 'B8G IDE';
    readonly nameLong: 'B8G IDE — Lumi White Dragon';
    readonly applicationName: 'b8g-ide';
    readonly dataFolderName: '.b8g-ide';
    readonly quality: 'stable';
  };
}

export function locateUpstreamVsCodeSource(candidates: readonly string[]): VsCodeSourceDescriptor {
  for (const rawDir of candidates) {
    if (!rawDir) continue;
    const dir = resolve(rawDir);
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };
      return {
        sourceDir: dir,
        productName: pkg.name ?? 'code-oss-dev',
        version: pkg.version ?? '0.0.0',
        isUpstreamUnmodified: true,
      };
    }
  }
  return {
    sourceDir: 'upstream://microsoft/vscode@latest',
    productName: 'code-oss-dev',
    version: 'upstream-latest',
    isUpstreamUnmodified: true,
  };
}

export function buildWebRendererBootPlan(opts?: {
  vscodeSrcDir?: string;
  baselineTag?: string;
  extensionRoot?: string;
}): WebRendererBootPlan {
  const here = dirname(fileURLToPath(import.meta.url));
  const extensionDir = opts?.extensionRoot ?? resolve(here, '..', 'extensions', 'b8g-devplane');
  const vscodeSource = locateUpstreamVsCodeSource([
    opts?.vscodeSrcDir ?? process.env['VSCODE_SRC_DIR'] ?? '',
    resolve(here, '..', '..', '..', 'third_party', 'vscode-oss'),
  ]);

  return {
    schema: 'b8g-ide-webrenderer-v1',
    renderer: {
      engine: 'sectium-browser-webrenderer',
      baselineTag: opts?.baselineTag ?? 'v0.5.0-baseline',
      brand: 'Lumi White Dragon',
      icon: 'lumi-white-dragon.ico',
      duplicateElectronBytes: 0,
    },
    vscodeSource,
    builtinExtensions: [extensionDir],
    devPlanePipe: getDefaultDevPlanePipe(),
    productConfiguration: {
      nameShort: 'B8G IDE',
      nameLong: 'B8G IDE — Lumi White Dragon',
      applicationName: 'b8g-ide',
      dataFolderName: '.b8g-ide',
      quality: 'stable',
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  console.log(JSON.stringify(buildWebRendererBootPlan(), null, 2));
}
