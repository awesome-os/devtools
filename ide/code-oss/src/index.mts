/**
 * @file src/index.mts
 * @description Public API for @awesome-os/code-oss over Holo v11 CAS.
 */

export {
  AWESOME_OS_BUNDLED_EXTENSIONS,
  ensureSharedExtensionsDir,
  fetchCodeOssManifest,
  getAbiShimAssetKey,
  getCasCacheDir,
  getCodeOssBinaryKey,
  getElectronAssetKey,
  getElectronExecutableRelPath,
  getSharedExtensionsDir,
  getTypeScriptAssetKey,
  HOLO_V11_CAS_BASE_URL,
  HOLO_V11_INDEX_URL,
  hydrateCodeOssStack,
  hydrateLocalCasPayload,
  resolveAbiShimEntry,
  resolveCodeOssEntry,
  resolveElectronEntry,
  resolveTypeScriptEntry,
  tryResolveCodeOssEntry,
  type BundledExtensionSpec,
  type HoloV11Entry,
  type HoloV11GlobalManifest,
  type HydratedCodeOssStack,
} from './hydrate.mts';

export {
  buildLaunchPlan,
  getPackageVersion,
  parseCliArgs,
  runCli,
  type LaunchPlan,
  type ParsedCliArgs,
} from './cli.mts';
