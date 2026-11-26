/**
 * @file sections/b8g-game-engine/index.mts
 * @description Barrel export for the zero-dependency B8G Holonomic Game Engine SDK.
 *
 * Strictly 100% portable: ZERO `node:*` imports, ZERO ambient host globals, `erasableSyntaxOnly: true`.
 */

export {
  B8G_ARENA_V1_MAGIC,
  B8G_ARENA_HEADER_BYTES,
  B8G_ENTITY_STRIDE_BYTES,
  B8G_ENTITY_STRIDE_F64,
  SimTier,
  DEFAULT_STREAMING_CONFIG,
  sectorCoordKey,
  worldToSectorCoord,
  simTierName,
  B8gArenaV1SlabPool,
  WorldStreamingEngine,
  type SimTierCode,
  type SimTierName,
  type Vec3,
  type SectorCoord,
  type WorldStreamingConfig,
  type SectorArenaSlab,
  type WorldSector,
  type StreamingTickReport,
} from './world-streaming.mts'

export {
  B8P_ASSET_PACK_MAGIC,
  B8P_ASSET_PACK_VERSION,
  encodeUtf8Portable,
  fnv64Bytes,
  fnv64String,
  AssetManifestSection,
  B8gGameEngineSection,
  B8gGameEngineIntersection,
  AssetClosureError,
  B8pAssetPipeline,
  verifyAssetClosure,
  type AssetKind,
  type B8pAssetBlock,
  type AssetManifestEntry,
  type AssetReference,
  type AssetClosureFailureDetail,
  type AssetClosureProof,
  type AssetPackStats,
} from './asset-pipeline.mts'

export {
  UnitQuaternion,
  ProceduralTerrain,
  RigidBody,
  RigidBodyWorld,
  FootPhase,
  FootPlacementSolver,
  type TerrainSample,
  type RigidBodyConfig,
  type FootPhaseCode,
  type FootSolverConfig,
} from './physics-locomotion.mts'

export * from './glb-ingestor.mts'
export * from './collision-physics.mts'
export * from './b8g-world.mts'
export * from './spatial-audio.mts'
export * from './telemetry-ring.mts'
export * from './obb-sat-section.mts'
