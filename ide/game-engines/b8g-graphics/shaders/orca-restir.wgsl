// SIGGRAPH 2026 ORCA Stateless Radiance Cache + HPG 2026 Compatibility-Guided
// Neighbor Selection + SIGGRAPH 2026 Multi-Layer ReSTIR Reservoir Splatting.
// Production WebGPU WGSL Compute Pipeline.

struct OrcaUniforms {
  table_size: u32,
  table_mask: u32,
  sample_count: u32,
  cell_size: f32,
};

struct OrcaCell {
  checksum: atomic<u32>,
  sum_r_fixed: atomic<u32>,
  sum_g_fixed: atomic<u32>,
  sum_b_fixed: atomic<u32>,
  sample_count: atomic<u32>,
};

struct OrcaSampleInput {
  pos_x: f32,
  pos_y: f32,
  pos_z: f32,
  _pad0: f32,
  norm_x: f32,
  norm_y: f32,
  norm_z: f32,
  _pad1: f32,
  rad_r: f32,
  rad_g: f32,
  rad_b: f32,
  _pad2: f32,
};

struct RestirUniforms {
  width: u32,
  height: u32,
  layers: u32,
  frame_seed: u32,
  max_plane_dist: f32,
  min_normal_dot: f32,
  max_depth_diff: f32,
  _pad0: f32,
};

// 13 floats packed cleanly in scalar array<f32> per reservoir:
// [0..2]=sampleXYZ, [3..5]=radianceRGB, [6]=wSum, [7]=mCount,
// [8]=targetPdf, [9]=depth, [10..12]=normalXYZ
const RESERVOIR_STRIDE: u32 = 13u;
const ORCA_MAX_PROBE: u32 = 16u;
const ORCA_FIXED_SCALE: f32 = 1024.0;

@group(0) @binding(0) var<uniform> orca_u: OrcaUniforms;
@group(0) @binding(1) var<storage, read_write> orca_cells: array<OrcaCell>;
@group(0) @binding(2) var<storage, read> orca_inputs: array<OrcaSampleInput>;
@group(0) @binding(3) var<storage, read_write> orca_queried_rgb: array<vec4<f32>>;

@group(1) @binding(0) var<uniform> restir_u: RestirUniforms;
@group(1) @binding(1) var<storage, read_write> reservoir_buf: array<f32>;
@group(1) @binding(2) var<storage, read> gbuf_pos_depth: array<vec4<f32>>;
@group(1) @binding(3) var<storage, read> gbuf_normal: array<vec4<f32>>;
@group(1) @binding(4) var<storage, read> candidate_samples: array<OrcaSampleInput>;

fn mix_hash32(h_in: u32) -> u32 {
  var x: u32 = h_in;
  x ^= (x >> 16u);
  x *= 0x7feb352du;
  x ^= (x >> 15u);
  x *= 0x846ca68bu;
  x ^= (x >> 16u);
  return x;
}

fn quantize_normal_code(n_in: vec3<f32>) -> u32 {
  let len_sq = dot(n_in, n_in);
  var n = vec3<f32>(0.0, 0.0, 1.0);
  if (len_sq > 1e-12) {
    n = n_in * inverseSqrt(len_sq);
  }
  let qx = clamp(u32(floor((n.x * 0.5 + 0.5) * 7.999)), 0u, 7u);
  let qy = clamp(u32(floor((n.y * 0.5 + 0.5) * 7.999)), 0u, 7u);
  let qz = clamp(u32(floor((n.z * 0.5 + 0.5) * 7.999)), 0u, 7u);
  return qx | (qy << 3u) | (qz << 6u);
}

fn compute_orca_keys(pos: vec3<f32>, norm: vec3<f32>, cell_size: f32) -> vec2<u32> {
  let inv_cell = 1.0 / max(1e-6, cell_size);
  let ix = bitcast<u32>(i32(floor(pos.x * inv_cell)));
  let iy = bitcast<u32>(i32(floor(pos.y * inv_cell)));
  let iz = bitcast<u32>(i32(floor(pos.z * inv_cell)));
  let ncode = quantize_normal_code(norm);

  var h: u32 = 0x811c9dc5u;
  h = (h ^ ix) * 0x01000193u;
  h = (h ^ iy) * 0x01000193u;
  h = (h ^ iz) * 0x01000193u;
  h = (h ^ ncode) * 0x01000193u;
  let primary = mix_hash32(h);

  var c: u32 = 0x9e3779b9u;
  c = (c ^ (ix + 0x13579bdfu)) * 0x85ebca6bu;
  c = (c ^ (iy + 0x2468ace0u)) * 0xc2b2ae35u;
  c = (c ^ (iz + 0x369cf258u)) * 0x27d4eb2fu;
  c = (c ^ ncode) * 0x165667b1u;
  let checksum = max(1u, mix_hash32(c));
  return vec2<u32>(primary, checksum);
}

@compute @workgroup_size(64, 1, 1)
fn orca_reset_frame(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= orca_u.table_size) {
    return;
  }
  atomicStore(&orca_cells[idx].checksum, 0u);
  atomicStore(&orca_cells[idx].sum_r_fixed, 0u);
  atomicStore(&orca_cells[idx].sum_g_fixed, 0u);
  atomicStore(&orca_cells[idx].sum_b_fixed, 0u);
  atomicStore(&orca_cells[idx].sample_count, 0u);
}

@compute @workgroup_size(64, 1, 1)
fn orca_insert_samples(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= orca_u.sample_count) {
    return;
  }
  let s = orca_inputs[idx];
  let keys = compute_orca_keys(
    vec3<f32>(s.pos_x, s.pos_y, s.pos_z),
    vec3<f32>(s.norm_x, s.norm_y, s.norm_z),
    orca_u.cell_size,
  );
  let start_slot = keys.x & orca_u.table_mask;

  for (var probe: u32 = 0u; probe < ORCA_MAX_PROBE; probe++) {
    let slot = (start_slot + probe) & orca_u.table_mask;
    let res = atomicCompareExchangeWeak(&orca_cells[slot].checksum, 0u, keys.y);
    if (res.exchanged || res.old_value == keys.y) {
      let rf = u32(clamp(s.rad_r * ORCA_FIXED_SCALE, 0.0, 4194304.0));
      let gf = u32(clamp(s.rad_g * ORCA_FIXED_SCALE, 0.0, 4194304.0));
      let bf = u32(clamp(s.rad_b * ORCA_FIXED_SCALE, 0.0, 4194304.0));
      atomicAdd(&orca_cells[slot].sum_r_fixed, rf);
      atomicAdd(&orca_cells[slot].sum_g_fixed, gf);
      atomicAdd(&orca_cells[slot].sum_b_fixed, bf);
      atomicAdd(&orca_cells[slot].sample_count, 1u);
      return;
    }
  }
}

@compute @workgroup_size(64, 1, 1)
fn orca_query_samples(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= orca_u.sample_count) {
    return;
  }
  let s = orca_inputs[idx];
  let keys = compute_orca_keys(
    vec3<f32>(s.pos_x, s.pos_y, s.pos_z),
    vec3<f32>(s.norm_x, s.norm_y, s.norm_z),
    orca_u.cell_size,
  );
  let start_slot = keys.x & orca_u.table_mask;

  for (var probe: u32 = 0u; probe < ORCA_MAX_PROBE; probe++) {
    let slot = (start_slot + probe) & orca_u.table_mask;
    let existing = atomicLoad(&orca_cells[slot].checksum);
    if (existing == 0u) {
      break;
    }
    if (existing == keys.y) {
      let cnt = atomicLoad(&orca_cells[slot].sample_count);
      if (cnt > 0u) {
        let inv = 1.0 / (f32(cnt) * ORCA_FIXED_SCALE);
        let r = f32(atomicLoad(&orca_cells[slot].sum_r_fixed)) * inv;
        let g = f32(atomicLoad(&orca_cells[slot].sum_g_fixed)) * inv;
        let b = f32(atomicLoad(&orca_cells[slot].sum_b_fixed)) * inv;
        orca_queried_rgb[idx] = vec4<f32>(r, g, b, f32(cnt));
        return;
      }
    }
  }
  orca_queried_rgb[idx] = vec4<f32>(0.0, 0.0, 0.0, 0.0);
}

// HPG 2026 Compatibility-Guided Neighbor Selection
fn compute_neighbor_compatibility(
  center_pos: vec3<f32>,
  center_norm: vec3<f32>,
  neighbor_pos: vec3<f32>,
  neighbor_norm: vec3<f32>,
  max_plane_dist: f32,
  min_normal_dot: f32,
) -> bool {
  let cl2 = dot(center_norm, center_norm);
  let nl2 = dot(neighbor_norm, neighbor_norm);
  if (cl2 <= 1e-12 || nl2 <= 1e-12) {
    return false;
  }
  let cn = center_norm * inverseSqrt(cl2);
  let nn = neighbor_norm * inverseSqrt(nl2);
  let plane_dist = abs(dot(neighbor_pos - center_pos, cn));
  let norm_dot = dot(cn, nn);
  return (plane_dist <= max_plane_dist) && (norm_dot >= min_normal_dot);
}

fn rand01(state_in: u32) -> f32 {
  let h = mix_hash32(state_in);
  return f32(h & 0x00ffffffu) / 16777216.0;
}

fn reservoir_base(x: u32, y: u32, layer: u32) -> u32 {
  return ((y * restir_u.width + x) * restir_u.layers + layer) * RESERVOIR_STRIDE;
}

@compute @workgroup_size(8, 8, 1)
fn restir_splat_multilayer(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  let layer = gid.z;
  if (x >= restir_u.width || y >= restir_u.height || layer >= restir_u.layers) {
    return;
  }

  let pix = y * restir_u.width + x;
  let layer_pix = pix * restir_u.layers + layer;
  let cand = candidate_samples[layer_pix];
  let pd = gbuf_pos_depth[layer_pix];
  let gn = gbuf_normal[layer_pix];

  let base = reservoir_base(x, y, layer);
  let target_pdf = max(0.0, cand.rad_r * 0.2126 + cand.rad_g * 0.7152 + cand.rad_b * 0.0722);
  let source_pdf = max(1e-6, cand._pad2);
  let ris_w = target_pdf / source_pdf;

  let prev_wsum = reservoir_buf[base + 6u];
  let prev_m = reservoir_buf[base + 7u];
  let next_wsum = prev_wsum + ris_w;
  let next_m = prev_m + 1.0;

  reservoir_buf[base + 6u] = next_wsum;
  reservoir_buf[base + 7u] = next_m;
  reservoir_buf[base + 9u] = pd.w;
  reservoir_buf[base + 10u] = gn.x;
  reservoir_buf[base + 11u] = gn.y;
  reservoir_buf[base + 12u] = gn.z;

  let u = rand01(pix ^ (layer * 0x9e3779b9u) ^ restir_u.frame_seed);
  if (ris_w > 0.0 && next_wsum > 0.0 && u * next_wsum <= ris_w) {
    reservoir_buf[base + 0u] = cand.pos_x;
    reservoir_buf[base + 1u] = cand.pos_y;
    reservoir_buf[base + 2u] = cand.pos_z;
    reservoir_buf[base + 3u] = cand.rad_r;
    reservoir_buf[base + 4u] = cand.rad_g;
    reservoir_buf[base + 5u] = cand.rad_b;
    reservoir_buf[base + 8u] = target_pdf;
  }
}

@compute @workgroup_size(8, 8, 1)
fn restir_resolve_disoccluded(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  if (x >= restir_u.width || y >= restir_u.height) {
    return;
  }

  let fg_pix = (y * restir_u.width + x) * restir_u.layers;
  let expected_pd = gbuf_pos_depth[fg_pix];
  let expected_n = normalize(gbuf_normal[fg_pix].xyz + vec3<f32>(0.0, 0.0, 1e-6));

  let fg_base = reservoir_base(x, y, 0u);
  let fg_m = reservoir_buf[fg_base + 7u];
  let fg_norm = vec3<f32>(
    reservoir_buf[fg_base + 10u],
    reservoir_buf[fg_base + 11u],
    reservoir_buf[fg_base + 12u],
  );
  let fg_depth_diff = abs(reservoir_buf[fg_base + 9u] - expected_pd.w);

  if (fg_m > 0.0 && dot(normalize(fg_norm + vec3<f32>(0.0, 0.0, 1e-6)), expected_n) >= restir_u.min_normal_dot && fg_depth_diff <= restir_u.max_depth_diff) {
    return;
  }

  var best_layer: i32 = -1;
  var best_dot: f32 = -1.0;

  for (var l: u32 = 1u; l < restir_u.layers; l++) {
    let b = reservoir_base(x, y, l);
    let m = reservoir_buf[b + 7u];
    let wsum = reservoir_buf[b + 6u];
    let pdf = reservoir_buf[b + 8u];
    if (m <= 0.0 || wsum <= 0.0 || pdf <= 0.0) {
      continue;
    }
    let ln = vec3<f32>(reservoir_buf[b + 10u], reservoir_buf[b + 11u], reservoir_buf[b + 12u]);
    let l_len_sq = dot(ln, ln);
    if (l_len_sq <= 1e-12) {
      continue;
    }
    let nd = dot(ln * inverseSqrt(l_len_sq), expected_n);
    let ddiff = abs(reservoir_buf[b + 9u] - expected_pd.w);
    if (nd >= restir_u.min_normal_dot && ddiff <= restir_u.max_depth_diff && nd > best_dot) {
      best_dot = nd;
      best_layer = i32(l);
    }
  }

  if (best_layer > 0) {
    let src = reservoir_base(x, y, u32(best_layer));
    for (var i: u32 = 0u; i < RESERVOIR_STRIDE; i++) {
      reservoir_buf[fg_base + i] = reservoir_buf[src + i];
      reservoir_buf[src + i] = 0.0;
    }
  }
}

@compute @workgroup_size(8, 8, 1)
fn restir_spatial_reuse(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  if (x >= restir_u.width || y >= restir_u.height) {
    return;
  }

  let fg_pix = (y * restir_u.width + x) * restir_u.layers;
  let c_pos = gbuf_pos_depth[fg_pix].xyz;
  let c_norm = gbuf_normal[fg_pix].xyz;
  let c_base = reservoir_base(x, y, 0u);

  let offsets = array<vec2<i32>, 4>(
    vec2<i32>(-1, 0),
    vec2<i32>(1, 0),
    vec2<i32>(0, -1),
    vec2<i32>(0, 1),
  );

  for (var k: u32 = 0u; k < 4u; k++) {
    let nx = i32(x) + offsets[k].x;
    let ny = i32(y) + offsets[k].y;
    if (nx < 0 || nx >= i32(restir_u.width) || ny < 0 || ny >= i32(restir_u.height)) {
      continue;
    }

    let ux = u32(nx);
    let uy = u32(ny);
    let n_pix = (uy * restir_u.width + ux) * restir_u.layers;
    let n_pos = gbuf_pos_depth[n_pix].xyz;
    let n_norm = gbuf_normal[n_pix].xyz;

    if (!compute_neighbor_compatibility(
      c_pos,
      c_norm,
      n_pos,
      n_norm,
      restir_u.max_plane_dist,
      restir_u.min_normal_dot,
    )) {
      continue;
    }

    let n_base = reservoir_base(ux, uy, 0u);
    let n_wsum = reservoir_buf[n_base + 6u];
    let n_m = reservoir_buf[n_base + 7u];
    let n_pdf = reservoir_buf[n_base + 8u];
    if (n_m <= 0.0 || n_wsum <= 0.0 || n_pdf <= 0.0) {
      continue;
    }

    let neighbor_w = n_wsum / (n_m * n_pdf);
    let combine_w = n_pdf * neighbor_w * n_m;
    let next_wsum = reservoir_buf[c_base + 6u] + combine_w;
    reservoir_buf[c_base + 6u] = next_wsum;
    reservoir_buf[c_base + 7u] = reservoir_buf[c_base + 7u] + n_m;

    let u = rand01(fg_pix ^ (k * 0x45d9f3bu) ^ restir_u.frame_seed);
    if (combine_w > 0.0 && next_wsum > 0.0 && u * next_wsum <= combine_w) {
      for (var f: u32 = 0u; f < 6u; f++) {
        reservoir_buf[c_base + f] = reservoir_buf[n_base + f];
      }
      reservoir_buf[c_base + 8u] = n_pdf;
    }
  }
}
