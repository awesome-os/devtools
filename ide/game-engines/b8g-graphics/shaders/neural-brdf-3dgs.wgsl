// SIGGRAPH 2026 Compact Neural BRDF MLP (var<workgroup> <= 8 KB) +
// Hybrid 16x16 Tiled 3D Gaussian Splatting Alpha Compositing against Visibility Buffer Depth.

struct FrameUniforms {
  width: u32,
  height: u32,
  tiles_x: u32,
  tiles_y: u32,
  light_dir: vec4<f32>,
  light_color: vec4<f32>,
};

struct VisSample {
  uv: vec2<f32>,
  depth: f32,
  valid: f32,
  normal: vec4<f32>,
  view_dir: vec4<f32>,
};

struct ProjectedGaussianGpu {
  screen_xy: vec2<f32>,
  depth: f32,
  opacity: f32,
  inv_cov: vec4<f32>, // (invCovXX, invCovXY, invCovYY, pad)
  color: vec4<f32>,   // (r, g, b, pad)
};

struct TileRange {
  start_idx: u32,
  count: u32,
};

const MLP_INPUT_DIM: u32 = 16u;
const MLP_H1_DIM: u32 = 32u;
const MLP_H2_DIM: u32 = 32u;
const MLP_OUT_DIM: u32 = 5u;
const MLP_WEIGHT_COUNT: u32 = 1765u; // 7060 bytes <= 8192 bytes
const PI: f32 = 3.14159265359;

@group(0) @binding(0) var<uniform> frame_u: FrameUniforms;
@group(0) @binding(1) var<storage, read> mlp_weights: array<f32>;
@group(0) @binding(2) var<storage, read> vis_buffer: array<VisSample>;
@group(0) @binding(3) var<storage, read> tile_ranges: array<TileRange>;
@group(0) @binding(4) var<storage, read> tile_splat_indices: array<u32>;
@group(0) @binding(5) var<storage, read> projected_splats: array<ProjectedGaussianGpu>;
@group(0) @binding(6) var<storage, read_write> out_rgba: array<vec4<f32>>;

// Shared L1/workgroup MLP weights (7,060 bytes < 8 KB)
var<workgroup> shared_mlp: array<f32, 1765>;

fn sigmoid(x: f32) -> f32 {
  if (x >= 16.0) { return 1.0; }
  if (x <= -16.0) { return 0.0; }
  return 1.0 / (1.0 + exp(-x));
}

fn eval_neural_brdf_workgroup(
  uv: vec2<f32>,
  norm_in: vec3<f32>,
  view_in: vec3<f32>,
) -> array<f32, 5> {
  let n = normalize(norm_in + vec3<f32>(0.0, 0.0, 1e-6));
  let v = normalize(view_in + vec3<f32>(0.0, 0.0, 1e-6));
  let pi_u = PI * uv.x;
  let pi_v = PI * uv.y;

  var inp: array<f32, 16>;
  inp[0] = uv.x;
  inp[1] = uv.y;
  inp[2] = sin(pi_u);
  inp[3] = cos(pi_u);
  inp[4] = sin(2.0 * pi_u);
  inp[5] = cos(2.0 * pi_u);
  inp[6] = sin(pi_v);
  inp[7] = cos(pi_v);
  inp[8] = sin(2.0 * pi_v);
  inp[9] = cos(2.0 * pi_v);
  inp[10] = n.x;
  inp[11] = n.y;
  inp[12] = n.z;
  inp[13] = v.x;
  inp[14] = v.y;
  inp[15] = v.z;

  var h1: array<f32, 32>;
  var h2: array<f32, 32>;
  var out_v: array<f32, 5>;

  let b0_off: u32 = MLP_INPUT_DIM * MLP_H1_DIM;
  let w1_off: u32 = b0_off + MLP_H1_DIM;
  let b1_off: u32 = w1_off + MLP_H1_DIM * MLP_H2_DIM;
  let w2_off: u32 = b1_off + MLP_H2_DIM;
  let b2_off: u32 = w2_off + MLP_H2_DIM * MLP_OUT_DIM;

  for (var j: u32 = 0u; j < MLP_H1_DIM; j++) {
    var acc = shared_mlp[b0_off + j];
    let row = j * MLP_INPUT_DIM;
    for (var i: u32 = 0u; i < MLP_INPUT_DIM; i++) {
      acc += shared_mlp[row + i] * inp[i];
    }
    h1[j] = max(0.0, acc);
  }

  for (var j: u32 = 0u; j < MLP_H2_DIM; j++) {
    var acc = shared_mlp[b1_off + j];
    let row = w1_off + j * MLP_H1_DIM;
    for (var i: u32 = 0u; i < MLP_H1_DIM; i++) {
      acc += shared_mlp[row + i] * h1[i];
    }
    h2[j] = max(0.0, acc);
  }

  for (var j: u32 = 0u; j < MLP_OUT_DIM; j++) {
    var acc = shared_mlp[b2_off + j];
    let row = w2_off + j * MLP_H2_DIM;
    for (var i: u32 = 0u; i < MLP_H2_DIM; i++) {
      acc += shared_mlp[row + i] * h2[i];
    }
    out_v[j] = sigmoid(acc);
  }

  return out_v;
}

@compute @workgroup_size(16, 16, 1)
fn shade_neural_brdf_and_composite_3dgs(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_index) local_idx: u32,
  @builtin(workgroup_id) wg_id: vec3<u32>,
) {
  // Cooperatively stage the <= 8 KB Neural BRDF MLP into workgroup shared memory.
  for (var i: u32 = local_idx; i < MLP_WEIGHT_COUNT; i += 256u) {
    shared_mlp[i] = mlp_weights[i];
  }
  workgroupBarrier();

  let px = gid.x;
  let py = gid.y;
  if (px >= frame_u.width || py >= frame_u.height) {
    return;
  }

  let pix_idx = py * frame_u.width + px;
  let vis = vis_buffer[pix_idx];

  // Shade mesh pixel via Neural BRDF if Visibility Buffer hit is valid
  var mesh_rgb = out_rgba[pix_idx].rgb;
  var vis_depth = 1.0;
  if (vis.valid > 0.5) {
    vis_depth = vis.depth;
    let brdf = eval_neural_brdf_workgroup(vis.uv, vis.normal.xyz, vis.view_dir.xyz);
    let albedo = vec3<f32>(brdf[0], brdf[1], brdf[2]);
    let roughness = 0.04 + 0.96 * brdf[3];
    let metallic = brdf[4];

    let n = normalize(vis.normal.xyz + vec3<f32>(0.0, 0.0, 1e-6));
    let l = normalize(frame_u.light_dir.xyz + vec3<f32>(0.0, 0.0, 1e-6));
    let v = normalize(vis.view_dir.xyz + vec3<f32>(0.0, 0.0, 1e-6));
    let h = normalize(l + v);

    let ndotl = max(0.0, dot(n, l));
    let ndoth = max(0.0, dot(n, h));
    let spec_pow = mix(64.0, 4.0, roughness);
    let f0 = mix(vec3<f32>(0.04), albedo, metallic);
    let spec = f0 * pow(ndoth, spec_pow);
    let diff = albedo * (1.0 - metallic) / PI;
    mesh_rgb = (diff + spec) * frame_u.light_color.rgb * ndotl + albedo * 0.05;
  }

  // Traverse 16x16 tile's front-to-back sorted 3DGS list, early-terminating at vis_depth
  let tile_idx = wg_id.y * frame_u.tiles_x + wg_id.x;
  let range = tile_ranges[tile_idx];
  let pix_center = vec2<f32>(f32(px) + 0.5, f32(py) + 0.5);

  var accum_rgb = vec3<f32>(0.0);
  var transmittance: f32 = 1.0;

  for (var s: u32 = 0u; s < range.count; s++) {
    let splat_id = tile_splat_indices[range.start_idx + s];
    let splat = projected_splats[splat_id];

    // Early-exit when remaining splats lie behind the opaque mesh Visibility Buffer depth
    if (splat.depth > vis_depth) {
      break;
    }

    let d = pix_center - splat.screen_xy;
    let power = -0.5 * (
      splat.inv_cov.x * d.x * d.x +
      2.0 * splat.inv_cov.y * d.x * d.y +
      splat.inv_cov.z * d.y * d.y
    );

    if (power > 0.0 || power < -18.0) {
      continue;
    }

    let alpha = min(0.99, splat.opacity * exp(power));
    if (alpha < 0.0039215686) {
      continue;
    }

    accum_rgb += splat.color.rgb * alpha * transmittance;
    transmittance *= (1.0 - alpha);

    if (transmittance < 0.004) {
      break;
    }
  }

  let final_rgb = accum_rgb + transmittance * mesh_rgb;
  let final_alpha = max(out_rgba[pix_idx].a, 1.0 - transmittance);
  out_rgba[pix_idx] = vec4<f32>(final_rgb, final_alpha);
}
