// Copyright 2026 Awesome-OS Authors
// SPDX-License-Identifier: BSD-3-Clause
//
// @file sections/b8g-graphics/b8g_graphics_abi.h
// @description Zero-Header C11 `B8G-ABI` Layout & Dispatch Contract for B8G Graphics
// (Visibility Buffer, Meshlet Bounds, ORCA Hash Grid, ReSTIR Reservoirs,
// Neural BRDF, and 3D Gaussian Splatting).
//
// Includes ONLY `<stddef.h>` and `<stdint.h>` — ZERO external headers, ZERO STL,
// `_Static_assert`-verified binary layout.

#ifndef AWESOME_OS_B8G_GRAPHICS_ABI_H_
#define AWESOME_OS_B8G_GRAPHICS_ABI_H_

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define B8G_GRAPHICS_ABI_MAGIC   0x58464742u /* "BGFX" */
#define B8G_GRAPHICS_ABI_VERSION 1u
#define B8G_ABI_MAGIC_V3         0x33564742u /* "BGV3" */

#define B8G_GRAPHICS_CAP_VISBUF       (1u << 0)
#define B8G_GRAPHICS_CAP_ORCA_GI      (1u << 1)
#define B8G_GRAPHICS_CAP_RESTIR       (1u << 2)
#define B8G_GRAPHICS_CAP_NEURAL_BRDF  (1u << 3)
#define B8G_GRAPHICS_CAP_3DGS_HYBRID  (1u << 4)

typedef struct B8gVisBufHeaderC {
  uint32_t magic;
  uint32_t abi_version;
  uint32_t width;
  uint32_t height;
  uint32_t visbuf_bytes;
  uint32_t hzb_levels;
  uint32_t tile_size;
  uint32_t flags;
} B8gVisBufHeaderC;

typedef struct B8gMeshletBoundsC {
  float center_radius[4];
  float aabb_min[4];
  float aabb_max[4];
  uint32_t tri_offset;
  uint32_t tri_count;
  uint32_t instance_id;
  uint32_t material_id;
} B8gMeshletBoundsC;

typedef struct B8gOrcaCellC {
  float radiance_sum[3];
  uint32_t sample_count;
  uint32_t frame_epoch;
  uint32_t cell_hash;
  uint32_t pad[2];
} B8gOrcaCellC;

typedef struct B8gReservoirLayerC {
  float sample_pos[3];
  float weight_sum;
  float radiance[3];
  float depth;
  float normal[3];
  uint32_t m_count;
} B8gReservoirLayerC;

typedef struct B8gGaussianSplatC {
  float pos[4];
  float scale[4];
  float quat[4];
  float color_opacity[4];
} B8gGaussianSplatC;

typedef struct B8gGraphicsDispatchTable {
  uint32_t magic;
  uint32_t abi_version;
  uint32_t struct_size;
  uint32_t caps;
  uint64_t (*pack64)(uint32_t depth_u32, uint16_t instance_id, uint16_t tri_id);
  void (*hzb_downsample_2x2)(const float* src, uint32_t w, uint32_t h, float* dst);
  uint32_t (*orca_hash_cell)(float px,
                             float py,
                             float pz,
                             float nx,
                             float ny,
                             float nz,
                             float cell_size,
                             uint32_t table_mask);
  int32_t (*restir_neighbor_compatible)(const float c_pos[3],
                                        const float c_norm[3],
                                        const float n_pos[3],
                                        const float n_norm[3],
                                        float max_plane_dist,
                                        float min_normal_dot);
  void (*neural_brdf_eval)(const float* weights,
                           float u,
                           float v,
                           const float view_n[3],
                           float out_pbr[5]);
  float (*eval_tile_gaussian)(float dx,
                              float dy,
                              float icxx,
                              float icxy,
                              float icyy,
                              float opacity,
                              float splat_depth,
                              float vis_depth);
} B8gGraphicsDispatchTable;

#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
_Static_assert(sizeof(B8gVisBufHeaderC) == 32, "B8gVisBufHeaderC must be 32 bytes");
_Static_assert(sizeof(B8gMeshletBoundsC) == 64, "B8gMeshletBoundsC must be 64 bytes");
_Static_assert(sizeof(B8gOrcaCellC) == 32, "B8gOrcaCellC must be 32 bytes");
_Static_assert(sizeof(B8gReservoirLayerC) == 48, "B8gReservoirLayerC must be 48 bytes");
_Static_assert(sizeof(B8gGaussianSplatC) == 64, "B8gGaussianSplatC must be 64 bytes");
_Static_assert(offsetof(B8gGraphicsDispatchTable, magic) == 0,
               "B8gGraphicsDispatchTable.magic must stay at offset 0");
_Static_assert(offsetof(B8gGraphicsDispatchTable, pack64) == 16,
               "B8gGraphicsDispatchTable.pack64 must align at offset 16");
_Static_assert(sizeof(B8gGraphicsDispatchTable) == 16u + 6u * sizeof(void*),
               "B8gGraphicsDispatchTable must match exact pointer layout");
#endif

uint64_t b8g_visbuf_pack64(uint32_t depth_u32, uint16_t instance_id, uint16_t tri_id);
void b8g_hzb_downsample_2x2(const float* src, uint32_t w, uint32_t h, float* dst);
uint32_t b8g_orca_hash_cell(float px,
                            float py,
                            float pz,
                            float nx,
                            float ny,
                            float nz,
                            float cell_size,
                            uint32_t table_mask);
int32_t b8g_restir_neighbor_compatible(const float c_pos[3],
                                       const float c_norm[3],
                                       const float n_pos[3],
                                       const float n_norm[3],
                                       float max_plane_dist,
                                       float min_normal_dot);
void b8g_neural_brdf_eval(const float* weights,
                          float u,
                          float v,
                          const float view_n[3],
                          float out_pbr[5]);
float b8g_3dgs_eval_tile_gaussian(float dx,
                                  float dy,
                                  float icxx,
                                  float icxy,
                                  float icyy,
                                  float opacity,
                                  float splat_depth,
                                  float vis_depth);
void b8g_graphics_init_dispatch_table(B8gGraphicsDispatchTable* out, uint32_t caps);

#ifdef __cplusplus
}
#endif

#endif /* AWESOME_OS_B8G_GRAPHICS_ABI_H_ */
