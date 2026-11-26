/**
 * @file src/index.mts
 * @description Public API for @awesome-os/godot over Holo v11 CAS.
 */

export {
  applyKeepLast5Pin,
  fetchGodotManifest,
  getCasCacheDir,
  getGodotAssetKey,
  getGodotExecutableRelPath,
  getGodotInstallPath,
  HOLO_V11_CAS_BASE_URL,
  HOLO_V11_INDEX_URL,
  hydrateLocalGodotPayload,
  resolveGodotEntry,
  tryResolveGodotEntry,
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
