/**
 * @file src/index.mts
 * @description Public API for @awesome-os/blender over Holo v11 CAS.
 */

export {
  applyKeepLast5Pin,
  fetchBlenderManifest,
  getBlenderAssetKey,
  getBlenderExecutableRelPath,
  getBlenderInstallPath,
  getCasCacheDir,
  HOLO_V11_CAS_BASE_URL,
  HOLO_V11_INDEX_URL,
  hydrateLocalBlenderPayload,
  resolveBlenderEntry,
  tryResolveBlenderEntry,
  type HoloV11Entry,
  type HoloV11GlobalManifest,
} from './hydrate.mts';

export {
  buildLaunchPlan,
  getPackageVersion,
  parseCliArgs,
  runCli,
  type LaunchPlan,
  type ParsedCliArgs,
} from './cli.mts';
