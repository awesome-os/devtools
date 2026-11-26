/**
 * SIGGRAPH 2026 Compact Neural BRDF MLP (<= 8 KB L1/Workgroup Shared Memory) +
 * Hybrid Tile-Based 3D Gaussian Splatting (3DGS) Renderer with Visibility Buffer
 * Depth Early-Termination.
 *
 * Strictly erasable TypeScript (`erasableSyntaxOnly: true`), zero external or
 * `node:*` imports.
 */

export type Vec3Like = readonly [number, number, number] | Float32Array;
export type Mat4Like = readonly number[] | Float32Array;

export interface NeuralBrdfOutput {
  readonly albedoR: number;
  readonly albedoG: number;
  readonly albedoB: number;
  readonly roughness: number;
  readonly metallic: number;
}

export interface ProjectedGaussian {
  readonly splatIndex: number;
  readonly screenX: number;
  readonly screenY: number;
  readonly depth: number;
  readonly invCovXX: number;
  readonly invCovXY: number;
  readonly invCovYY: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly opacity: number;
  readonly radiusPx: number;
}

export interface BinnedTile {
  readonly tileX: number;
  readonly tileY: number;
  readonly splats: readonly ProjectedGaussian[];
}

export interface BinnedTilesResult {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly totalProjected: number;
  readonly tiles: readonly BinnedTile[];
}

export interface Composite3dgsStats {
  readonly pixelsShaded: number;
  readonly splatEvaluations: number;
  readonly earlyDepthTerminations: number;
  readonly transmittanceTerminations: number;
}

/**
 * Compact MLP topology: 16 -> 32 -> 32 -> 5
 * Total float32 weights = (16*32 + 32) + (32*32 + 32) + (32*5 + 5) = 1765 floats = 7060 bytes <= 8192 bytes.
 */
export const NEURAL_MLP_INPUT_DIM = 16;
export const NEURAL_MLP_HIDDEN1_DIM = 32;
export const NEURAL_MLP_HIDDEN2_DIM = 32;
export const NEURAL_MLP_OUTPUT_DIM = 5;
export const NEURAL_MLP_WEIGHT_COUNT =
  NEURAL_MLP_INPUT_DIM * NEURAL_MLP_HIDDEN1_DIM +
  NEURAL_MLP_HIDDEN1_DIM +
  NEURAL_MLP_HIDDEN1_DIM * NEURAL_MLP_HIDDEN2_DIM +
  NEURAL_MLP_HIDDEN2_DIM +
  NEURAL_MLP_HIDDEN2_DIM * NEURAL_MLP_OUTPUT_DIM +
  NEURAL_MLP_OUTPUT_DIM;

export const NEURAL_MLP_MAX_BYTES = 8192;

/** Flat Float32 stride per 3D Gaussian: px, py, pz, sx, sy, sz, qx, qy, qz, qw, r, g, b, opacity. */
export const GAUSSIAN_STRIDE = 14;

export const GAUSSIAN_OFF_PX = 0;
export const GAUSSIAN_OFF_PY = 1;
export const GAUSSIAN_OFF_PZ = 2;
export const GAUSSIAN_OFF_SX = 3;
export const GAUSSIAN_OFF_SY = 4;
export const GAUSSIAN_OFF_SZ = 5;
export const GAUSSIAN_OFF_QX = 6;
export const GAUSSIAN_OFF_QY = 7;
export const GAUSSIAN_OFF_QZ = 8;
export const GAUSSIAN_OFF_QW = 9;
export const GAUSSIAN_OFF_R = 10;
export const GAUSSIAN_OFF_G = 11;
export const GAUSSIAN_OFF_B = 12;
export const GAUSSIAN_OFF_OPACITY = 13;

function sigmoid(x: number): number {
  if (x >= 16) return 1;
  if (x <= -16) return 0;
  return 1 / (1 + Math.exp(-x));
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalize3(v: Vec3Like): [number, number, number] {
  const lenSq = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  if (lenSq <= 1e-12) return [0, 0, 1];
  const inv = 1 / Math.sqrt(lenSq);
  return [v[0] * inv, v[1] * inv, v[2] * inv];
}

/**
 * Shared-memory / L1-sized Neural BRDF MLP (`<= 8 KB`, `16 -> 32 -> 32 -> 5`).
 * Encodes sinusoidal `(u, v)` + normal `(nx, ny, nz)` + viewDir `(vx, vy, vz)`
 * through 2 hidden ReLU layers into `[albedoR, albedoG, albedoB, roughness, metallic]`.
 */
export class CompactNeuralBrdfMlp {
  readonly weights: Float32Array;
  readonly inputDim = NEURAL_MLP_INPUT_DIM;
  readonly hidden1Dim = NEURAL_MLP_HIDDEN1_DIM;
  readonly hidden2Dim = NEURAL_MLP_HIDDEN2_DIM;
  readonly outputDim = NEURAL_MLP_OUTPUT_DIM;

  constructor(weights?: Float32Array) {
    if (weights !== undefined) {
      if (weights.length !== NEURAL_MLP_WEIGHT_COUNT) {
        throw new RangeError(
          `Expected ${NEURAL_MLP_WEIGHT_COUNT} MLP weights, got ${weights.length}`,
        );
      }
      if (weights.byteLength > NEURAL_MLP_MAX_BYTES) {
        throw new RangeError(
          `MLP byteLength ${weights.byteLength} exceeds ${NEURAL_MLP_MAX_BYTES} byte L1/shared limit`,
        );
      }
      this.weights = weights;
    } else {
      this.weights = new Float32Array(NEURAL_MLP_WEIGHT_COUNT);
    }
  }

  get byteLength(): number {
    return this.weights.byteLength;
  }

  evaluate(u: number, v: number, normal: Vec3Like, viewDir: Vec3Like): NeuralBrdfOutput {
    return evaluateNeuralBrdf(this, u, v, normal, viewDir);
  }
}

/**
 * Builds a deterministic `CompactNeuralBrdfMlp` (`7,060 B <= 8,192 B`) with
 * Kaiming-scaled ReLU weights and calibrated PBR output biases.
 */
export function createDefaultNeuralMaterial(seed = 2026): CompactNeuralBrdfMlp {
  const rng = createMulberry32(seed);
  const w = new Float32Array(NEURAL_MLP_WEIGHT_COUNT);

  const randSymmetric = (scale: number): number => (rng() * 2 - 1) * scale;

  let offset = 0;

  // Layer 0: 16 -> 32
  const w0Scale = Math.sqrt(2 / NEURAL_MLP_INPUT_DIM) * 0.65;
  for (let i = 0; i < NEURAL_MLP_INPUT_DIM * NEURAL_MLP_HIDDEN1_DIM; i++) {
    w[offset++] = randSymmetric(w0Scale);
  }
  for (let i = 0; i < NEURAL_MLP_HIDDEN1_DIM; i++) {
    w[offset++] = 0.05 * randSymmetric(1);
  }

  // Layer 1: 32 -> 32
  const w1Scale = Math.sqrt(2 / NEURAL_MLP_HIDDEN1_DIM) * 0.65;
  for (let i = 0; i < NEURAL_MLP_HIDDEN1_DIM * NEURAL_MLP_HIDDEN2_DIM; i++) {
    w[offset++] = randSymmetric(w1Scale);
  }
  for (let i = 0; i < NEURAL_MLP_HIDDEN2_DIM; i++) {
    w[offset++] = 0.05 * randSymmetric(1);
  }

  // Layer 2: 32 -> 5
  const w2Scale = Math.sqrt(2 / NEURAL_MLP_HIDDEN2_DIM) * 0.5;
  for (let i = 0; i < NEURAL_MLP_HIDDEN2_DIM * NEURAL_MLP_OUTPUT_DIM; i++) {
    w[offset++] = randSymmetric(w2Scale);
  }
  // Calibrated PBR output biases: mid-albedo, ~0.45 roughness, ~0.15 metallic
  w[offset++] = 0.1;
  w[offset++] = 0.0;
  w[offset++] = -0.1;
  w[offset++] = -0.2;
  w[offset++] = -1.5;

  return new CompactNeuralBrdfMlp(w);
}

/**
 * Evaluates a `CompactNeuralBrdfMlp` at `(u, v, normal, viewDir)` using
 * sinusoidal positional encoding + 2 ReLU hidden layers.
 */
export function evaluateNeuralBrdf(
  mlp: CompactNeuralBrdfMlp,
  u: number,
  v: number,
  normal: Vec3Like,
  viewDir: Vec3Like,
): NeuralBrdfOutput {
  const [nx, ny, nz] = normalize3(normal);
  const [vx, vy, vz] = normalize3(viewDir);

  const piU = Math.PI * u;
  const piV = Math.PI * v;

  const input = new Float32Array(NEURAL_MLP_INPUT_DIM);
  input[0] = u;
  input[1] = v;
  input[2] = Math.sin(piU);
  input[3] = Math.cos(piU);
  input[4] = Math.sin(2 * piU);
  input[5] = Math.cos(2 * piU);
  input[6] = Math.sin(piV);
  input[7] = Math.cos(piV);
  input[8] = Math.sin(2 * piV);
  input[9] = Math.cos(2 * piV);
  input[10] = nx;
  input[11] = ny;
  input[12] = nz;
  input[13] = vx;
  input[14] = vy;
  input[15] = vz;

  const w = mlp.weights;
  const h1 = new Float32Array(NEURAL_MLP_HIDDEN1_DIM);
  const h2 = new Float32Array(NEURAL_MLP_HIDDEN2_DIM);
  const out = new Float32Array(NEURAL_MLP_OUTPUT_DIM);

  const b0Off = NEURAL_MLP_INPUT_DIM * NEURAL_MLP_HIDDEN1_DIM;
  const w1Off = b0Off + NEURAL_MLP_HIDDEN1_DIM;
  const b1Off = w1Off + NEURAL_MLP_HIDDEN1_DIM * NEURAL_MLP_HIDDEN2_DIM;
  const w2Off = b1Off + NEURAL_MLP_HIDDEN2_DIM;
  const b2Off = w2Off + NEURAL_MLP_HIDDEN2_DIM * NEURAL_MLP_OUTPUT_DIM;

  for (let j = 0; j < NEURAL_MLP_HIDDEN1_DIM; j++) {
    let acc = w[b0Off + j];
    const row = j * NEURAL_MLP_INPUT_DIM;
    for (let i = 0; i < NEURAL_MLP_INPUT_DIM; i++) {
      acc += w[row + i] * input[i];
    }
    h1[j] = acc > 0 ? acc : 0;
  }

  for (let j = 0; j < NEURAL_MLP_HIDDEN2_DIM; j++) {
    let acc = w[b1Off + j];
    const row = w1Off + j * NEURAL_MLP_HIDDEN1_DIM;
    for (let i = 0; i < NEURAL_MLP_HIDDEN1_DIM; i++) {
      acc += w[row + i] * h1[i];
    }
    h2[j] = acc > 0 ? acc : 0;
  }

  for (let j = 0; j < NEURAL_MLP_OUTPUT_DIM; j++) {
    let acc = w[b2Off + j];
    const row = w2Off + j * NEURAL_MLP_HIDDEN2_DIM;
    for (let i = 0; i < NEURAL_MLP_HIDDEN2_DIM; i++) {
      acc += w[row + i] * h2[i];
    }
    out[j] = sigmoid(acc);
  }

  return {
    albedoR: out[0],
    albedoG: out[1],
    albedoB: out[2],
    roughness: 0.04 + 0.96 * out[3],
    metallic: out[4],
  };
}

/**
 * Hybrid Tile-Based 3D Gaussian Splatting (3DGS) Renderer.
 *
 * Stores Gaussians in a flat `Float32Array` (`14` floats/splat), projects 3D
 * quaternion+scale covariances into 2D screen-space ellipse conics binned into
 * `16x16` tiles, depth-sorts front-to-back per tile, and composites with
 * Visibility Buffer depth early-termination (`splat.depth > visDepth`).
 */
export class TileBased3dgsRenderer {
  readonly splats: Float32Array;
  readonly count: number;

  constructor(splatsOrCount: Float32Array | number) {
    if (typeof splatsOrCount === 'number') {
      if (!Number.isInteger(splatsOrCount) || splatsOrCount < 0) {
        throw new RangeError(`Invalid Gaussian splat count: ${splatsOrCount}`);
      }
      this.count = splatsOrCount;
      this.splats = new Float32Array(splatsOrCount * GAUSSIAN_STRIDE);
    } else {
      if (splatsOrCount.length % GAUSSIAN_STRIDE !== 0) {
        throw new RangeError(
          `Gaussian Float32Array length (${splatsOrCount.length}) must be a multiple of ${GAUSSIAN_STRIDE}`,
        );
      }
      this.splats = splatsOrCount;
      this.count = splatsOrCount.length / GAUSSIAN_STRIDE;
    }
  }

  setGaussian(
    index: number,
    px: number,
    py: number,
    pz: number,
    sx: number,
    sy: number,
    sz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    r: number,
    g: number,
    b: number,
    opacity: number,
  ): void {
    const base = index * GAUSSIAN_STRIDE;
    const s = this.splats;
    s[base + GAUSSIAN_OFF_PX] = px;
    s[base + GAUSSIAN_OFF_PY] = py;
    s[base + GAUSSIAN_OFF_PZ] = pz;
    s[base + GAUSSIAN_OFF_SX] = sx;
    s[base + GAUSSIAN_OFF_SY] = sy;
    s[base + GAUSSIAN_OFF_SZ] = sz;
    s[base + GAUSSIAN_OFF_QX] = qx;
    s[base + GAUSSIAN_OFF_QY] = qy;
    s[base + GAUSSIAN_OFF_QZ] = qz;
    s[base + GAUSSIAN_OFF_QW] = qw;
    s[base + GAUSSIAN_OFF_R] = r;
    s[base + GAUSSIAN_OFF_G] = g;
    s[base + GAUSSIAN_OFF_B] = b;
    s[base + GAUSSIAN_OFF_OPACITY] = opacity;
  }

  projectAndBinGaussians(
    viewProj: Mat4Like,
    width: number,
    height: number,
    tileSize = 16,
  ): BinnedTilesResult {
    return projectAndBinGaussians(this.splats, viewProj, width, height, tileSize);
  }

  composite3dgsHybrid(
    binnedTiles: BinnedTilesResult,
    width: number,
    height: number,
    visDepthBuffer: Float32Array,
    outRgba: Float32Array | Uint8ClampedArray,
  ): Composite3dgsStats {
    return composite3dgsHybrid(binnedTiles, width, height, visDepthBuffer, outRgba);
  }
}

/**
 * Projects 3D Gaussians (`14` floats/splat) using column-major 4x4 `viewProj`,
 * computes exact projective Jacobian 2D covariance conics `(invCovXX, invCovXY, invCovYY)`,
 * bins into `tileSize x tileSize` screen tiles, and depth-sorts front-to-back per tile.
 */
export function projectAndBinGaussians(
  splats: Float32Array,
  viewProj: Mat4Like,
  width: number,
  height: number,
  tileSize = 16,
): BinnedTilesResult {
  if (splats.length % GAUSSIAN_STRIDE !== 0) {
    throw new RangeError(`splats length must be a multiple of ${GAUSSIAN_STRIDE}`);
  }
  if (viewProj.length < 16) {
    throw new RangeError('viewProj must have 16 elements (column-major 4x4)');
  }

  const tilesX = Math.ceil(width / tileSize);
  const tilesY = Math.ceil(height / tileSize);
  const tileBuckets: ProjectedGaussian[][] = new Array(tilesX * tilesY);
  for (let i = 0; i < tileBuckets.length; i++) {
    tileBuckets[i] = [];
  }

  // Extract rows 0, 1, 2, 3 from column-major 4x4 matrix
  const m00 = viewProj[0], m01 = viewProj[4], m02 = viewProj[8], m03 = viewProj[12];
  const m10 = viewProj[1], m11 = viewProj[5], m12 = viewProj[9], m13 = viewProj[13];
  const m20 = viewProj[2], m21 = viewProj[6], m22 = viewProj[10], m23 = viewProj[14];
  const m30 = viewProj[3], m31 = viewProj[7], m32 = viewProj[11], m33 = viewProj[15];

  const halfW = 0.5 * width;
  const halfH = 0.5 * height;
  const splatCount = splats.length / GAUSSIAN_STRIDE;
  let totalProjected = 0;

  for (let idx = 0; idx < splatCount; idx++) {
    const base = idx * GAUSSIAN_STRIDE;
    const opacity = splats[base + GAUSSIAN_OFF_OPACITY];
    if (opacity <= 1 / 255) continue;

    const px = splats[base + GAUSSIAN_OFF_PX];
    const py = splats[base + GAUSSIAN_OFF_PY];
    const pz = splats[base + GAUSSIAN_OFF_PZ];

    const cx = m00 * px + m01 * py + m02 * pz + m03;
    const cy = m10 * px + m11 * py + m12 * pz + m13;
    const cz = m20 * px + m21 * py + m22 * pz + m23;
    const cw = m30 * px + m31 * py + m32 * pz + m33;

    if (cw <= 1e-4) continue;
    const invW = 1 / cw;
    const ndcX = cx * invW;
    const ndcY = cy * invW;
    const ndcZ = cz * invW;

    if (ndcZ < 0 || ndcZ > 1) continue;

    const screenX = (ndcX * 0.5 + 0.5) * width;
    const screenY = (0.5 - ndcY * 0.5) * height;

    // Normalize quaternion and build R * S * S^T * R^T symmetric 3D covariance
    const qx = splats[base + GAUSSIAN_OFF_QX];
    const qy = splats[base + GAUSSIAN_OFF_QY];
    const qz = splats[base + GAUSSIAN_OFF_QZ];
    const qw = splats[base + GAUSSIAN_OFF_QW];
    const qLenSq = qx * qx + qy * qy + qz * qz + qw * qw;
    const qInv = qLenSq > 1e-12 ? 1 / Math.sqrt(qLenSq) : 1;
    const x = qx * qInv;
    const y = qy * qInv;
    const z = qz * qInv;
    const w = qLenSq > 1e-12 ? qw * qInv : 1;

    const r00 = 1 - 2 * (y * y + z * z);
    const r01 = 2 * (x * y - w * z);
    const r02 = 2 * (x * z + w * y);
    const r10 = 2 * (x * y + w * z);
    const r11 = 1 - 2 * (x * x + z * z);
    const r12 = 2 * (y * z - w * x);
    const r20 = 2 * (x * z - w * y);
    const r21 = 2 * (y * z + w * x);
    const r22 = 1 - 2 * (x * x + y * y);

    const sx = splats[base + GAUSSIAN_OFF_SX];
    const sy = splats[base + GAUSSIAN_OFF_SY];
    const sz = splats[base + GAUSSIAN_OFF_SZ];
    const sx2 = sx * sx;
    const sy2 = sy * sy;
    const sz2 = sz * sz;

    const s00 = r00 * r00 * sx2 + r01 * r01 * sy2 + r02 * r02 * sz2;
    const s01 = r00 * r10 * sx2 + r01 * r11 * sy2 + r02 * r12 * sz2;
    const s02 = r00 * r20 * sx2 + r01 * r21 * sy2 + r02 * r22 * sz2;
    const s11 = r10 * r10 * sx2 + r11 * r11 * sy2 + r12 * r12 * sz2;
    const s12 = r10 * r20 * sx2 + r11 * r21 * sy2 + r12 * r22 * sz2;
    const s22 = r20 * r20 * sx2 + r21 * r21 * sy2 + r22 * r22 * sz2;

    // Exact 2x3 projective screen-space Jacobian of viewProj at (px, py, pz)
    const invW2 = invW * invW;
    const j00 = halfW * (cw * m00 - cx * m30) * invW2;
    const j01 = halfW * (cw * m01 - cx * m31) * invW2;
    const j02 = halfW * (cw * m02 - cx * m32) * invW2;
    const j10 = -halfH * (cw * m10 - cy * m30) * invW2;
    const j11 = -halfH * (cw * m11 - cy * m31) * invW2;
    const j12 = -halfH * (cw * m12 - cy * m32) * invW2;

    // Cov2D = J * Sigma3D * J^T + 0.3 * I (EWA anti-aliasing filter)
    const js00 = j00 * s00 + j01 * s01 + j02 * s02;
    const js01 = j00 * s01 + j01 * s11 + j02 * s12;
    const js02 = j00 * s02 + j01 * s12 + j02 * s22;
    const js10 = j10 * s00 + j11 * s01 + j12 * s02;
    const js11 = j10 * s01 + j11 * s11 + j12 * s12;
    const js12 = j10 * s02 + j11 * s12 + j12 * s22;

    const covXX = js00 * j00 + js01 * j01 + js02 * j02 + 0.3;
    const covXY = js00 * j10 + js01 * j11 + js02 * j12;
    const covYY = js10 * j10 + js11 * j11 + js12 * j12 + 0.3;

    const det = covXX * covYY - covXY * covXY;
    if (det <= 1e-6) continue;

    const invDet = 1 / det;
    const invCovXX = covYY * invDet;
    const invCovXY = -covXY * invDet;
    const invCovYY = covXX * invDet;

    const mid = 0.5 * (covXX + covYY);
    const lambdaMax = mid + Math.sqrt(Math.max(0.1, mid * mid - det));
    const radiusPx = Math.ceil(3.0 * Math.sqrt(lambdaMax));
    if (radiusPx <= 0) continue;

    const minTileX = Math.max(0, Math.floor((screenX - radiusPx) / tileSize));
    const maxTileX = Math.min(tilesX - 1, Math.floor((screenX + radiusPx) / tileSize));
    const minTileY = Math.max(0, Math.floor((screenY - radiusPx) / tileSize));
    const maxTileY = Math.min(tilesY - 1, Math.floor((screenY + radiusPx) / tileSize));

    if (minTileX > maxTileX || minTileY > maxTileY) continue;

    const projected: ProjectedGaussian = {
      splatIndex: idx,
      screenX,
      screenY,
      depth: ndcZ,
      invCovXX,
      invCovXY,
      invCovYY,
      r: splats[base + GAUSSIAN_OFF_R],
      g: splats[base + GAUSSIAN_OFF_G],
      b: splats[base + GAUSSIAN_OFF_B],
      opacity: Math.min(0.99, Math.max(0, opacity)),
      radiusPx,
    };

    totalProjected++;
    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        tileBuckets[ty * tilesX + tx].push(projected);
      }
    }
  }

  const tiles: BinnedTile[] = new Array(tilesX * tilesY);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const idx = ty * tilesX + tx;
      const list = tileBuckets[idx];
      if (list.length > 1) {
        list.sort((a, b) => a.depth - b.depth);
      }
      tiles[idx] = { tileX: tx, tileY: ty, splats: list };
    }
  }

  return {
    width,
    height,
    tileSize,
    tilesX,
    tilesY,
    totalProjected,
    tiles,
  };
}

/**
 * Traverses front-to-back sorted tile splat lists (`T_i`), early-terminating
 * against `visDepthBuffer` (`if (splat.depth > visDepth) break`) so meshes
 * cleanly occlude behind-mesh Gaussians while foreground semi-transparent
 * Gaussians cleanly alpha-blend in front of shaded mesh surfaces.
 */
export function composite3dgsHybrid(
  binnedTiles: BinnedTilesResult,
  width: number,
  height: number,
  visDepthBuffer: Float32Array,
  outRgba: Float32Array | Uint8ClampedArray,
): Composite3dgsStats {
  const expectedPixels = width * height;
  if (visDepthBuffer.length < expectedPixels) {
    throw new RangeError(
      `visDepthBuffer length (${visDepthBuffer.length}) is smaller than ${expectedPixels}`,
    );
  }
  if (outRgba.length < expectedPixels * 4) {
    throw new RangeError(
      `outRgba length (${outRgba.length}) is smaller than ${expectedPixels * 4}`,
    );
  }

  const isUint8 = outRgba instanceof Uint8ClampedArray;
  const tileSize = binnedTiles.tileSize;
  let pixelsShaded = 0;
  let splatEvaluations = 0;
  let earlyDepthTerminations = 0;
  let transmittanceTerminations = 0;

  for (let t = 0; t < binnedTiles.tiles.length; t++) {
    const tile = binnedTiles.tiles[t];
    const splats = tile.splats;
    if (splats.length === 0) continue;

    const startX = tile.tileX * tileSize;
    const endX = Math.min(width, startX + tileSize);
    const startY = tile.tileY * tileSize;
    const endY = Math.min(height, startY + tileSize);

    for (let py = startY; py < endY; py++) {
      for (let px = startX; px < endX; px++) {
        const pixIdx = py * width + px;
        const visDepth = visDepthBuffer[pixIdx];
        const pxCenter = px + 0.5;
        const pyCenter = py + 0.5;

        let accumR = 0;
        let accumG = 0;
        let accumB = 0;
        let transmittance = 1.0;

        for (let sIdx = 0; sIdx < splats.length; sIdx++) {
          const splat = splats[sIdx];
          if (splat.depth > visDepth) {
            earlyDepthTerminations++;
            break;
          }

          splatEvaluations++;
          const dx = pxCenter - splat.screenX;
          const dy = pyCenter - splat.screenY;
          const power =
            -0.5 *
            (splat.invCovXX * dx * dx +
              2.0 * splat.invCovXY * dx * dy +
              splat.invCovYY * dy * dy);

          if (power > 0 || power < -18) continue;

          const alpha = Math.min(0.99, splat.opacity * Math.exp(power));
          if (alpha < 1 / 255) continue;

          accumR += splat.r * alpha * transmittance;
          accumG += splat.g * alpha * transmittance;
          accumB += splat.b * alpha * transmittance;
          transmittance *= 1.0 - alpha;

          if (transmittance < 0.004) {
            transmittanceTerminations++;
            break;
          }
        }

        const outBase = pixIdx * 4;
        if (transmittance < 1.0) {
          if (isUint8) {
            const bgR = outRgba[outBase] / 255;
            const bgG = outRgba[outBase + 1] / 255;
            const bgB = outRgba[outBase + 2] / 255;
            outRgba[outBase] = Math.round(Math.min(1, accumR + transmittance * bgR) * 255);
            outRgba[outBase + 1] = Math.round(Math.min(1, accumG + transmittance * bgG) * 255);
            outRgba[outBase + 2] = Math.round(Math.min(1, accumB + transmittance * bgB) * 255);
            outRgba[outBase + 3] = Math.max(
              outRgba[outBase + 3],
              Math.round((1 - transmittance) * 255),
            );
          } else {
            outRgba[outBase] = accumR + transmittance * outRgba[outBase];
            outRgba[outBase + 1] = accumG + transmittance * outRgba[outBase + 1];
            outRgba[outBase + 2] = accumB + transmittance * outRgba[outBase + 2];
            outRgba[outBase + 3] = Math.max(outRgba[outBase + 3], 1.0 - transmittance);
          }
        }
        pixelsShaded++;
      }
    }
  }

  return {
    pixelsShaded,
    splatEvaluations,
    earlyDepthTerminations,
    transmittanceTerminations,
  };
}
