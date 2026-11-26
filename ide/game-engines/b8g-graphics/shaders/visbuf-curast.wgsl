// WebGPU WGSL Compute Pipeline: CuRast / Nanite-style Visibility Buffer,
// Two-Pass HZB Occlusion Culling, and Analytical Barycentric ddx/ddy Material Resolve.

struct Uniforms {
  mvp: mat4x4<f32>,
  viewportWidth: u32,
  viewportHeight: u32,
  meshletCount: u32,
  hzbMipCount: u32,
  passIndex: u32,
  vertexCount: u32,
  triangleCount: u32,
  materialCount: u32,
};

struct MeshletBounds {
  centerRadius: vec4<f32>, // xyz = center, w = radius
  instanceId: u32,
  indexOffset: u32,
  triangleCount: u32,
  vertexOffset: u32,
};

struct BindlessMaterial {
  baseColor: vec4<f32>,
  roughnessMetallicBiasPad: vec4<f32>,
};

struct HzbMipMeta {
  offset: u32,
  width: u32,
  height: u32,
  pad: u32,
};

struct BarycentricDerivs {
  bary: vec3<f32>,
  uv: vec2<f32>,
  dpdx_bary: vec3<f32>,
  dpdy_bary: vec3<f32>,
  dudx: f32,
  dvdx: f32,
  dudy: f32,
  dvdy: f32,
  normal: vec3<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> meshlets: array<MeshletBounds>;
// Flat vertex storage stride 8 floats: (x, y, z, w, u, v, nx, ny)
@group(0) @binding(2) var<storage, read> vertices: array<f32>;
@group(0) @binding(3) var<storage, read> indices: array<u32>;
@group(0) @binding(4) var<storage, read> hzbPyramid: array<f32>;
@group(0) @binding(5) var<storage, read> hzbMipMeta: array<HzbMipMeta>;
@group(0) @binding(6) var<storage, read_write> visBufferHi: array<atomic<u32>>;
@group(0) @binding(7) var<storage, read_write> visBufferLo: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> visibleMeshlets: array<u32>;
// [0] = pass1VisibleCount, [1] = pass2DisoccludedCount, [2] = culledCount
@group(0) @binding(9) var<storage, read_write> meshletCullCounters: array<atomic<u32>>;
@group(0) @binding(10) var<storage, read> materials: array<BindlessMaterial>;
@group(0) @binding(11) var<storage, read_write> outColor: array<vec4<f32>>;

const VISBUF_CLEAR_U32: u32 = 0xffffffffu;
const VERTEX_STRIDE: u32 = 8u;

fn pack_vis_payload(instance_id: u32, triangle_id: u32) -> u32 {
  return ((instance_id & 0xffffu) << 16u) | (triangle_id & 0xffffu);
}

fn load_vertex_pos(vertex_idx: u32) -> vec4<f32> {
  let base = vertex_idx * VERTEX_STRIDE;
  return vec4<f32>(
    vertices[base],
    vertices[base + 1u],
    vertices[base + 2u],
    vertices[base + 3u]
  );
}

fn load_vertex_uv(vertex_idx: u32) -> vec2<f32> {
  let base = vertex_idx * VERTEX_STRIDE;
  return vec2<f32>(vertices[base + 4u], vertices[base + 5u]);
}

fn load_vertex_normal(vertex_idx: u32) -> vec3<f32> {
  let base = vertex_idx * VERTEX_STRIDE;
  let nx = vertices[base + 6u];
  let ny = vertices[base + 7u];
  let nz_sq = max(0.0, 1.0 - (nx * nx + ny * ny));
  return normalize(vec3<f32>(nx, ny, sqrt(nz_sq)));
}

// Simulated 64-bit atomicMin over paired (visBufferHi, visBufferLo) atomic<u32> buffers
// using lock-free atomicCompareExchangeWeak without SIMT spinlock divergence.
fn atomic_min_visbuf_u64(pixel_idx: u32, depth_u32: u32, payload_u32: u32) -> bool {
  var prev_hi = atomicLoad(&visBufferHi[pixel_idx]);
  loop {
    if (depth_u32 > prev_hi) {
      return false;
    }
    if (depth_u32 == prev_hi) {
      let prev_lo = atomicMin(&visBufferLo[pixel_idx], payload_u32);
      if (atomicLoad(&visBufferHi[pixel_idx]) == prev_hi) {
        return payload_u32 < prev_lo;
      }
      prev_hi = atomicLoad(&visBufferHi[pixel_idx]);
      continue;
    }
    let res = atomicCompareExchangeWeak(&visBufferHi[pixel_idx], prev_hi, depth_u32);
    if (res.exchanged) {
      atomicStore(&visBufferLo[pixel_idx], payload_u32);
      return true;
    }
    prev_hi = res.old_value;
  }
}

fn test_bounds_hzb(center: vec3<f32>, radius: f32) -> bool {
  let w_f = f32(uniforms.viewportWidth);
  let h_f = f32(uniforms.viewportHeight);

  var min_ndc = vec3<f32>(1e30, 1e30, 1e30);
  var max_ndc = vec3<f32>(-1e30, -1e30, -1e30);

  for (var corner: u32 = 0u; corner < 8u; corner = corner + 1u) {
    let sx = select(-radius, radius, (corner & 1u) != 0u);
    let sy = select(-radius, radius, (corner & 2u) != 0u);
    let sz = select(-radius, radius, (corner & 4u) != 0u);
    let clip = uniforms.mvp * vec4<f32>(center + vec3<f32>(sx, sy, sz), 1.0);
    if (clip.w <= 1e-4) {
      return true;
    }
    let ndc = clip.xyz / clip.w;
    min_ndc = min(min_ndc, ndc);
    max_ndc = max(max_ndc, ndc);
  }

  let sx0 = i32(floor((min_ndc.x * 0.5 + 0.5) * w_f));
  let sx1 = i32(floor((max_ndc.x * 0.5 + 0.5) * w_f));
  let sy0 = i32(floor((0.5 - max_ndc.y * 0.5) * h_f));
  let sy1 = i32(floor((0.5 - min_ndc.y * 0.5) * h_f));

  let min_x = clamp(sx0, 0, i32(uniforms.viewportWidth) - 1);
  let max_x = clamp(sx1, 0, i32(uniforms.viewportWidth) - 1);
  let min_y = clamp(sy0, 0, i32(uniforms.viewportHeight) - 1);
  let max_y = clamp(sy1, 0, i32(uniforms.viewportHeight) - 1);

  if (min_x > max_x || min_y > max_y) {
    return false;
  }

  let rect_w = max(1, max_x - min_x + 1);
  let rect_h = max(1, max_y - min_y + 1);
  let max_dim = f32(max(rect_w, rect_h));
  let mip_raw = u32(max(0.0, ceil(log2(max_dim)) - 1.0));
  let mip = min(uniforms.hzbMipCount - 1u, mip_raw);

  let meta = hzbMipMeta[mip];
  let tx0 = clamp(u32(min_x) >> mip, 0u, meta.width - 1u);
  let tx1 = clamp(u32(max_x) >> mip, 0u, meta.width - 1u);
  let ty0 = clamp(u32(min_y) >> mip, 0u, meta.height - 1u);
  let ty1 = clamp(u32(max_y) >> mip, 0u, meta.height - 1u);

  var hzb_max_z = 0.0;
  for (var ty: u32 = ty0; ty <= ty1; ty = ty + 1u) {
    let row = meta.offset + ty * meta.width;
    for (var tx: u32 = tx0; tx <= tx1; tx = tx + 1u) {
      hzb_max_z = max(hzb_max_z, hzbPyramid[row + tx]);
    }
  }

  let cluster_min_z = clamp(min_ndc.z, 0.0, 1.0);
  return cluster_min_z <= hzb_max_z + 1e-6;
}

@compute @workgroup_size(64)
fn cull_meshlets_hzb(@builtin(global_invocation_id) gid: vec3<u32>) {
  let meshlet_idx = gid.x;
  if (meshlet_idx >= uniforms.meshletCount) {
    return;
  }

  let m = meshlets[meshlet_idx];
  let visible = test_bounds_hzb(m.centerRadius.xyz, m.centerRadius.w);

  if (visible) {
    let counter_idx = select(1u, 0u, uniforms.passIndex == 0u);
    let slot = atomicAdd(&meshletCullCounters[counter_idx], 1u);
    visibleMeshlets[slot] = meshlet_idx;
  } else if (uniforms.passIndex != 0u) {
    atomicAdd(&meshletCullCounters[2], 1u);
  }
}

@compute @workgroup_size(64)
fn rasterize_visbuf_micropoly(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tri_id = gid.x;
  if (tri_id >= uniforms.triangleCount) {
    return;
  }

  // Locate owning meshlet (or use linear meshlet scan for compact clusters)
  var instance_id: u32 = 0u;
  var vertex_offset: u32 = 0u;
  for (var m: u32 = 0u; m < uniforms.meshletCount; m = m + 1u) {
    let mb = meshlets[m];
    let start_tri = mb.indexOffset / 3u;
    if (tri_id >= start_tri && tri_id < start_tri + mb.triangleCount) {
      instance_id = mb.instanceId;
      vertex_offset = mb.vertexOffset;
      break;
    }
  }

  let idx_base = tri_id * 3u;
  let i0 = indices[idx_base] + vertex_offset;
  let i1 = indices[idx_base + 1u] + vertex_offset;
  let i2 = indices[idx_base + 2u] + vertex_offset;

  let c0 = uniforms.mvp * load_vertex_pos(i0);
  let c1 = uniforms.mvp * load_vertex_pos(i1);
  let c2 = uniforms.mvp * load_vertex_pos(i2);

  if (c0.w <= 1e-6 || c1.w <= 1e-6 || c2.w <= 1e-6) {
    return;
  }

  let ndc0 = c0.xyz / c0.w;
  let ndc1 = c1.xyz / c1.w;
  let ndc2 = c2.xyz / c2.w;

  let w_f = f32(uniforms.viewportWidth);
  let h_f = f32(uniforms.viewportHeight);

  let s0 = vec2<f32>((ndc0.x * 0.5 + 0.5) * w_f, (0.5 - ndc0.y * 0.5) * h_f);
  let s1 = vec2<f32>((ndc1.x * 0.5 + 0.5) * w_f, (0.5 - ndc1.y * 0.5) * h_f);
  let s2 = vec2<f32>((ndc2.x * 0.5 + 0.5) * w_f, (0.5 - ndc2.y * 0.5) * h_f);

  let area2 = (s1.x - s0.x) * (s2.y - s0.y) - (s1.y - s0.y) * (s2.x - s0.x);
  if (abs(area2) < 1e-6) {
    return;
  }
  let inv_area2 = 1.0 / area2;

  let min_x = max(0, i32(floor(min(s0.x, min(s1.x, s2.x)))));
  let max_x = min(i32(uniforms.viewportWidth) - 1, i32(floor(max(s0.x, max(s1.x, s2.x)))));
  let min_y = max(0, i32(floor(min(s0.y, min(s1.y, s2.y)))));
  let max_y = min(i32(uniforms.viewportHeight) - 1, i32(floor(max(s0.y, max(s1.y, s2.y)))));

  if (min_x > max_x || min_y > max_y) {
    return;
  }

  let payload = pack_vis_payload(instance_id, tri_id);

  for (var py: i32 = min_y; py <= max_y; py = py + 1) {
    let cy = f32(py) + 0.5;
    let row_offset = u32(py) * uniforms.viewportWidth;

    for (var px: i32 = min_x; px <= max_x; px = px + 1) {
      let cx = f32(px) + 0.5;

      let e0 = (s2.x - s1.x) * (cy - s1.y) - (s2.y - s1.y) * (cx - s1.x);
      let e1 = (s0.x - s2.x) * (cy - s2.y) - (s0.y - s2.y) * (cx - s2.x);
      let e2 = (s1.x - s0.x) * (cy - s0.y) - (s1.y - s0.y) * (cx - s0.x);

      let w0 = e0 * inv_area2;
      let w1 = e1 * inv_area2;
      let w2 = e2 * inv_area2;

      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) {
        continue;
      }

      let depth = w0 * ndc0.z + w1 * ndc1.z + w2 * ndc2.z;
      if (depth < 0.0 || depth > 1.0) {
        continue;
      }

      let depth_u32 = u32(round(clamp(depth, 0.0, 1.0) * 4294967295.0));
      let pixel_idx = row_offset + u32(px);
      _ = atomic_min_visbuf_u64(pixel_idx, depth_u32, payload);
    }
  }
}

fn compute_analytical_barycentrics(
  i0: u32,
  i1: u32,
  i2: u32,
  pixel_center: vec2<f32>,
) -> BarycentricDerivs {
  let c0 = uniforms.mvp * load_vertex_pos(i0);
  let c1 = uniforms.mvp * load_vertex_pos(i1);
  let c2 = uniforms.mvp * load_vertex_pos(i2);

  let w_f = f32(uniforms.viewportWidth);
  let h_f = f32(uniforms.viewportHeight);

  let inv_w = vec3<f32>(
    select(1.0, 1.0 / c0.w, abs(c0.w) > 1e-8),
    select(1.0, 1.0 / c1.w, abs(c1.w) > 1e-8),
    select(1.0, 1.0 / c2.w, abs(c2.w) > 1e-8)
  );

  let ndc0 = c0.xy * inv_w.x;
  let ndc1 = c1.xy * inv_w.y;
  let ndc2 = c2.xy * inv_w.z;

  let s0 = vec2<f32>((ndc0.x * 0.5 + 0.5) * w_f, (0.5 - ndc0.y * 0.5) * h_f);
  let s1 = vec2<f32>((ndc1.x * 0.5 + 0.5) * w_f, (0.5 - ndc1.y * 0.5) * h_f);
  let s2 = vec2<f32>((ndc2.x * 0.5 + 0.5) * w_f, (0.5 - ndc2.y * 0.5) * h_f);

  let area2 = (s1.x - s0.x) * (s2.y - s0.y) - (s1.y - s0.y) * (s2.x - s0.x);
  let inv_d = select(0.0, 1.0 / area2, abs(area2) > 1e-8);

  let l0 = ((s2.x - s1.x) * (pixel_center.y - s1.y) - (s2.y - s1.y) * (pixel_center.x - s1.x)) * inv_d;
  let l1 = ((s0.x - s2.x) * (pixel_center.y - s2.y) - (s0.y - s2.y) * (pixel_center.x - s2.x)) * inv_d;
  let l2 = ((s1.x - s0.x) * (pixel_center.y - s0.y) - (s1.y - s0.y) * (pixel_center.x - s0.x)) * inv_d;

  let dl_dx = vec3<f32>(-(s2.y - s1.y), -(s0.y - s2.y), -(s1.y - s0.y)) * inv_d;
  let dl_dy = vec3<f32>(s2.x - s1.x, s0.x - s2.x, s1.x - s0.x) * inv_d;

  let l_vec = vec3<f32>(l0, l1, l2);
  let one_over_w = dot(l_vec, inv_w);
  let w_persp = select(1.0, 1.0 / one_over_w, abs(one_over_w) > 1e-8);

  let d_one_over_w_dx = dot(dl_dx, inv_w);
  let d_one_over_w_dy = dot(dl_dy, inv_w);

  // Perspective-correct barycentrics and exact analytical partial derivatives
  let bary = (l_vec * inv_w) * w_persp;
  let dpdx_bary = (dl_dx * inv_w - bary * d_one_over_w_dx) * w_persp;
  let dpdy_bary = (dl_dy * inv_w - bary * d_one_over_w_dy) * w_persp;

  let uv0 = load_vertex_uv(i0);
  let uv1 = load_vertex_uv(i1);
  let uv2 = load_vertex_uv(i2);

  let u_vec = vec3<f32>(uv0.x, uv1.x, uv2.x);
  let v_vec = vec3<f32>(uv0.y, uv1.y, uv2.y);

  let u = dot(bary, u_vec);
  let v = dot(bary, v_vec);
  let dudx = dot(dpdx_bary, u_vec);
  let dvdx = dot(dpdx_bary, v_vec);
  let dudy = dot(dpdy_bary, u_vec);
  let dvdy = dot(dpdy_bary, v_vec);

  let n0 = load_vertex_normal(i0);
  let n1 = load_vertex_normal(i1);
  let n2 = load_vertex_normal(i2);
  let normal = normalize(bary.x * n0 + bary.y * n1 + bary.z * n2);

  return BarycentricDerivs(
    bary,
    vec2<f32>(u, v),
    dpdx_bary,
    dpdy_bary,
    dudx,
    dvdx,
    dudy,
    dvdy,
    normal
  );
}

@compute @workgroup_size(8, 8)
fn resolve_bindless_visbuf(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= uniforms.viewportWidth || gid.y >= uniforms.viewportHeight) {
    return;
  }

  let pixel_idx = gid.y * uniforms.viewportWidth + gid.x;
  let hi = atomicLoad(&visBufferHi[pixel_idx]);
  let lo = atomicLoad(&visBufferLo[pixel_idx]);

  if (hi == VISBUF_CLEAR_U32 && lo == VISBUF_CLEAR_U32) {
    outColor[pixel_idx] = vec4<f32>(0.0, 0.0, 0.0, 1.0);
    return;
  }

  let instance_id = (lo >> 16u) & 0xffffu;
  let tri_id = lo & 0xffffu;
  let idx_base = tri_id * 3u;

  let i0 = indices[idx_base];
  let i1 = indices[idx_base + 1u];
  let i2 = indices[idx_base + 2u];

  let pixel_center = vec2<f32>(f32(gid.x) + 0.5, f32(gid.y) + 0.5);
  let deriv = compute_analytical_barycentrics(i0, i1, i2, pixel_center);

  let mat_idx = min(instance_id, max(1u, uniforms.materialCount) - 1u);
  let mat = materials[mat_idx];

  let light_dir = normalize(vec3<f32>(0.35, 0.65, 0.67453688));
  let ndotl = max(0.15, dot(deriv.normal, light_dir));

  let grad_x = length(vec2<f32>(deriv.dudx, deriv.dvdx));
  let grad_y = length(vec2<f32>(deriv.dudy, deriv.dvdy));
  let mip_atten = 1.0 / (1.0 + 0.05 * max(0.0, log2(max(1e-6, max(grad_x, grad_y))) + mat.roughnessMetallicBiasPad.z));

  let roughness = mat.roughnessMetallicBiasPad.x;
  let metallic = mat.roughnessMetallicBiasPad.y;
  let spec = (1.0 - roughness) * (0.2 + 0.4 * metallic) * pow(ndotl, 8.0);

  let rgb = clamp(mat.baseColor.rgb * ndotl * mip_atten + vec3<f32>(spec), vec3<f32>(0.0), vec3<f32>(1.0));
  outColor[pixel_idx] = vec4<f32>(rgb, mat.baseColor.a);
}
