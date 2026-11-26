// Copyright 2026 Awesome-OS Authors
// SPDX-License-Identifier: BSD-3-Clause
//
// @file sections/b8g-game-engine/b8g_game_engine_abi.h
// @description Zero-Header C11 `B8G-ABI v3` Prefix-Compatible Dispatch Table for the
// B8G Holonomic Game Engine SDK (World Streaming, `.b8p` Asset Closure, `S^3` Physics,
// and `B8G_ARENA_V1` `O(1)` Sector Slabs).
//
// Includes ONLY `<stddef.h>` and `<stdint.h>` — ZERO external headers, ZERO STL,
// `_Static_assert`-verified binary layout.

#ifndef AWESOME_OS_B8G_GAME_ENGINE_ABI_H_
#define AWESOME_OS_B8G_GAME_ENGINE_ABI_H_

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define B8G_GAME_ENGINE_ABI_MAGIC      0x45473842u /* "B8GE" */
#define B8G_GAME_ENGINE_ABI_VERSION_V2 0x00020000u
#define B8G_GAME_ENGINE_ABI_VERSION_V3 0x00030000u

#define B8G_GAME_SIM_TIER_1_FULL_PHYSICS     1u
#define B8G_GAME_SIM_TIER_2_SIMPLIFIED       2u
#define B8G_GAME_SIM_TIER_3_HORIZON_IMPOSTER 3u

#define B8G_GAME_CAP_VELOCITY_PREFETCH  (1u << 0)
#define B8G_GAME_CAP_ASSET_CLOSURE_GATE (1u << 1)
#define B8G_GAME_CAP_S3_QUAT_PHYSICS    (1u << 2)
#define B8G_GAME_CAP_FOOT_PLACEMENT_IK  (1u << 3)
#define B8G_GAME_CAP_ARENA_V1_O1_PURGE  (1u << 4)

typedef struct B8gVec3f64 {
  double x;
  double y;
  double z;
} B8gVec3f64;

typedef struct B8gQuatf64 {
  double w;
  double x;
  double y;
  double z;
} B8gQuatf64;

typedef struct B8gSectorCoordC {
  int32_t sx;
  int32_t sy;
  int32_t sz;
  uint32_t tier;
} B8gSectorCoordC;

typedef struct B8gEntityState64C {
  double entity_id;
  double px;
  double py;
  double pz;
  double vx;
  double vy;
  double vz;
  double flags;
} B8gEntityState64C;

typedef struct B8gFootContact32C {
  double x;
  double y;
  double z;
  double weight;
} B8gFootContact32C;

typedef struct B8gWorldStreamingDispatchTable {
  uint32_t (*update_streaming_bubble)(const B8gVec3f64* pos,
                                      const B8gVec3f64* velocity,
                                      double dt,
                                      uint32_t* out_loaded_sectors,
                                      uint32_t* out_purged_sectors);
  uint32_t (*purge_sector_o1)(int32_t sx, int32_t sy, int32_t sz);
  uint32_t (*active_sector_count)(void);
} B8gWorldStreamingDispatchTable;

typedef struct B8gAssetClosureDispatchTable {
  uint64_t (*fnv64_bytes)(const uint8_t* data, size_t len);
  int32_t (*verify_asset_closure)(const uint64_t* required_hashes,
                                  size_t required_count,
                                  size_t* out_missing_count);
  uint32_t (*unique_block_count)(void);
} B8gAssetClosureDispatchTable;

typedef struct B8gPhysicsDispatchTable {
  uint32_t (*step_fixed_s3)(double frame_dt, double* out_max_quat_norm_error);
  double (*sample_terrain_height)(double x, double z);
  int32_t (*solve_foot_placement)(double pelvis_x,
                                  double pelvis_z,
                                  double dt,
                                  B8gFootContact32C* out_left,
                                  B8gFootContact32C* out_right);
} B8gPhysicsDispatchTable;

typedef struct B8gArenaSlabDispatchTable {
  void* (*acquire_slab)(int32_t sx, int32_t sy, int32_t sz, size_t* out_bytes);
  uint32_t (*wipe_and_release_o1)(void* slab_ptr, size_t slab_bytes);
  uint64_t (*active_slab_count)(void);
} B8gArenaSlabDispatchTable;

/* ---- B8G-ABI v2 Base Prefix ---- */
typedef struct B8gGameEngineAbiTableV2 {
  uint32_t magic;
  uint32_t abi_version;
  const B8gWorldStreamingDispatchTable* streaming;
  const B8gAssetClosureDispatchTable* assets;
  const B8gPhysicsDispatchTable* physics;
} B8gGameEngineAbiTableV2;

/* ---- B8G-ABI v3 Prefix-Compatible Engine Table ----
 * Binary Invariant:
 *   `v2` sits at byte offset 0 so any v2 consumer safely reads a v3 pointer
 *   as `const B8gGameEngineAbiTableV2*`.
 */
typedef struct B8gGameEngineAbiTable {
  B8gGameEngineAbiTableV2 v2;
  uint32_t struct_size;
  uint32_t capability_flags;
  const B8gArenaSlabDispatchTable* arena_slab;
} B8gGameEngineAbiTable;

#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
_Static_assert(sizeof(B8gVec3f64) == 24, "B8gVec3f64 must be 24 bytes");
_Static_assert(sizeof(B8gQuatf64) == 32, "B8gQuatf64 must be 32 bytes");
_Static_assert(sizeof(B8gSectorCoordC) == 16, "B8gSectorCoordC must be 16 bytes");
_Static_assert(sizeof(B8gEntityState64C) == 64, "B8gEntityState64C must be 64-byte cache-line aligned");
_Static_assert(sizeof(B8gFootContact32C) == 32, "B8gFootContact32C must be 32 bytes");
_Static_assert(offsetof(B8gGameEngineAbiTable, v2) == 0,
               "B8gGameEngineAbiTable.v2 MUST stay at byte offset 0 for B8G-ABI v3 prefix compatibility");
#endif

static inline int b8g_game_engine_abi_is_v3(const B8gGameEngineAbiTableV2* tbl) {
  if (!tbl || tbl->magic != B8G_GAME_ENGINE_ABI_MAGIC) return 0;
  if (tbl->abi_version < B8G_GAME_ENGINE_ABI_VERSION_V3) return 0;
  const B8gGameEngineAbiTable* v3 = (const B8gGameEngineAbiTable*)tbl;
  return v3->struct_size >= (uint32_t)sizeof(B8gGameEngineAbiTable);
}

#ifdef __cplusplus
}
#endif

#endif /* AWESOME_OS_B8G_GAME_ENGINE_ABI_H_ */
