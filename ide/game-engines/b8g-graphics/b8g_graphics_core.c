// Copyright 2026 Awesome-OS Authors
// SPDX-License-Identifier: BSD-3-Clause
//
// @file sections/b8g-graphics/b8g_graphics_core.c
// @description C11 -O3 hot-path kernels for B8G Graphics ABI.

#include "b8g_graphics_abi.h"

#include <math.h>

static inline float b8g_clamp01(float x) {
  if (x < 0.0f) return 0.0f;
  if (x > 1.0f) return 1.0f;
  return x;
}

static inline float b8g_sigmoidf(float x) {
  if (x >= 16.0f) return 1.0f;
  if (x <= -16.0f) return 0.0f;
  return 1.0f / (1.0f + expf(-x));
}

static inline uint32_t b8g_hash_u32(uint32_t h, uint32_t v) {
  h ^= v;
  h *= 0x85ebca6bu;
  h ^= h >> 13;
  h *= 0xc2b2ae35u;
  h ^= h >> 16;
  return h;
}

uint64_t b8g_visbuf_pack64(uint32_t depth_u32, uint16_t instance_id, uint16_t tri_id) {
  return ((uint64_t)depth_u32 << 32) | ((uint64_t)instance_id << 16) | (uint64_t)tri_id;
}

void b8g_hzb_downsample_2x2(const float* src, uint32_t w, uint32_t h, float* dst) {
  if (!src || !dst || w == 0u || h == 0u) {
    return;
  }
  const uint32_t dst_w = (w > 1u) ? (w >> 1) : 1u;
  const uint32_t dst_h = (h > 1u) ? (h >> 1) : 1u;
  for (uint32_t dy = 0u; dy < dst_h; ++dy) {
    const uint32_t sy0 = dy * 2u;
    const uint32_t sy1 = (sy0 + 1u < h) ? (sy0 + 1u) : sy0;
    const float* row0 = src + (size_t)sy0 * w;
    const float* row1 = src + (size_t)sy1 * w;
    float* out_row = dst + (size_t)dy * dst_w;
    for (uint32_t dx = 0u; dx < dst_w; ++dx) {
      const uint32_t sx0 = dx * 2u;
      const uint32_t sx1 = (sx0 + 1u < w) ? (sx0 + 1u) : sx0;
      float m = row0[sx0];
      if (row0[sx1] > m) m = row0[sx1];
      if (row1[sx0] > m) m = row1[sx0];
      if (row1[sx1] > m) m = row1[sx1];
      out_row[dx] = m;
    }
  }
}

uint32_t b8g_orca_hash_cell(float px,
                            float py,
                            float pz,
                            float nx,
                            float ny,
                            float nz,
                            float cell_size,
                            uint32_t table_mask) {
  const float safe_cell = (cell_size > 1e-6f) ? cell_size : 1e-6f;
  const float inv_cell = 1.0f / safe_cell;

  const int32_t ix = (int32_t)floorf(px * inv_cell);
  const int32_t iy = (int32_t)floorf(py * inv_cell);
  const int32_t iz = (int32_t)floorf(pz * inv_cell);

  const int32_t qnx = (int32_t)floorf(nx * 2.0f + 2.5f);
  const int32_t qny = (int32_t)floorf(ny * 2.0f + 2.5f);
  const int32_t qnz = (int32_t)floorf(nz * 2.0f + 2.5f);

  uint32_t h = 0x811c9dc5u;
  h = b8g_hash_u32(h, (uint32_t)ix);
  h = b8g_hash_u32(h, (uint32_t)iy);
  h = b8g_hash_u32(h, (uint32_t)iz);
  h = b8g_hash_u32(h, (uint32_t)((qnx & 0x7) | ((qny & 0x7) << 3) | ((qnz & 0x7) << 6)));

  return (table_mask != 0u) ? (h & table_mask) : h;
}

int32_t b8g_restir_neighbor_compatible(const float c_pos[3],
                                       const float c_norm[3],
                                       const float n_pos[3],
                                       const float n_norm[3],
                                       float max_plane_dist,
                                       float min_normal_dot) {
  if (!c_pos || !c_norm || !n_pos || !n_norm) {
    return 0;
  }
  const float ndot = c_norm[0] * n_norm[0] + c_norm[1] * n_norm[1] + c_norm[2] * n_norm[2];
  if (ndot < min_normal_dot) {
    return 0;
  }
  const float dx = n_pos[0] - c_pos[0];
  const float dy = n_pos[1] - c_pos[1];
  const float dz = n_pos[2] - c_pos[2];
  const float plane_dist = fabsf(dx * c_norm[0] + dy * c_norm[1] + dz * c_norm[2]);
  return (plane_dist <= max_plane_dist) ? 1 : 0;
}

// Compact 5 -> 8 (ReLU) -> 5 (sigmoid) neural BRDF micro-MLP:
// weights layout (93 floats): W1[8*5], b1[8], W2[5*8], b2[5].
void b8g_neural_brdf_eval(const float* weights,
                          float u,
                          float v,
                          const float view_n[3],
                          float out_pbr[5]) {
  if (!out_pbr) {
    return;
  }
  const float nx = view_n ? view_n[0] : 0.0f;
  const float ny = view_n ? view_n[1] : 0.0f;
  const float nz = view_n ? view_n[2] : 1.0f;

  if (!weights) {
    const float fresnel = b8g_clamp01(1.0f - fabsf(nz));
    out_pbr[0] = b8g_clamp01(0.5f + 0.35f * sinf(u * 6.2831853f));
    out_pbr[1] = b8g_clamp01(0.5f + 0.35f * cosf(v * 6.2831853f));
    out_pbr[2] = b8g_clamp01(0.4f + 0.2f * (nx + ny) + 0.1f * fresnel);
    out_pbr[3] = b8g_clamp01(0.35f + 0.3f * fresnel);
    out_pbr[4] = 0.0f;
    return;
  }

  const float in_feat[5] = {u, v, nx, ny, nz};
  const float* w1 = weights;
  const float* b1 = weights + 40;
  const float* w2 = weights + 48;
  const float* b2 = weights + 88;

  float hidden[8];
  for (uint32_t j = 0u; j < 8u; ++j) {
    float acc = b1[j];
    const float* row = w1 + j * 5u;
    for (uint32_t i = 0u; i < 5u; ++i) {
      acc += row[i] * in_feat[i];
    }
    hidden[j] = (acc > 0.0f) ? acc : 0.0f;
  }

  for (uint32_t k = 0u; k < 5u; ++k) {
    float acc = b2[k];
    const float* row = w2 + k * 8u;
    for (uint32_t j = 0u; j < 8u; ++j) {
      acc += row[j] * hidden[j];
    }
    out_pbr[k] = b8g_sigmoidf(acc);
  }
}

float b8g_3dgs_eval_tile_gaussian(float dx,
                                  float dy,
                                  float icxx,
                                  float icxy,
                                  float icyy,
                                  float opacity,
                                  float splat_depth,
                                  float vis_depth) {
  if (opacity <= 0.0f || splat_depth > vis_depth) {
    return 0.0f;
  }
  const float power = -0.5f * (icxx * dx * dx + 2.0f * icxy * dx * dy + icyy * dy * dy);
  if (power > 0.0f || power < -20.0f) {
    return 0.0f;
  }
  float alpha = opacity * expf(power);
  if (alpha > 0.99f) {
    alpha = 0.99f;
  }
  if (alpha < (1.0f / 255.0f)) {
    return 0.0f;
  }
  return alpha;
}

void b8g_graphics_init_dispatch_table(B8gGraphicsDispatchTable* out, uint32_t caps) {
  if (!out) {
    return;
  }
  out->magic = B8G_GRAPHICS_ABI_MAGIC;
  out->abi_version = B8G_GRAPHICS_ABI_VERSION;
  out->struct_size = (uint32_t)sizeof(B8gGraphicsDispatchTable);
  out->caps = caps;
  out->pack64 = b8g_visbuf_pack64;
  out->hzb_downsample_2x2 = b8g_hzb_downsample_2x2;
  out->orca_hash_cell = b8g_orca_hash_cell;
  out->restir_neighbor_compatible = b8g_restir_neighbor_compatible;
  out->neural_brdf_eval = b8g_neural_brdf_eval;
  out->eval_tile_gaussian = b8g_3dgs_eval_tile_gaussian;
}
