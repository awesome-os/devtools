/**
 * SIGGRAPH 2026 ORCA Stateless Radiance Cache + HPG 2026 Compatibility-Guided
 * Neighbor Selection + SIGGRAPH 2026 Multi-Layer ReSTIR Reservoir Splatting.
 *
 * Strictly erasable TypeScript (`erasableSyntaxOnly: true`), zero external or
 * `node:*` imports, backed by flat TypedArrays / SharedArrayBuffer.
 */

export type Vec3Like = readonly [number, number, number] | Float32Array;

export interface OrcaQueryResult {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly count: number;
  readonly found: boolean;
}

export interface CompatibilityThresholds {
  readonly maxPlaneDist?: number;
  readonly minNormalDot?: number;
  readonly maxEuclideanDist?: number;
}

export interface CompatibilityResult {
  readonly compatible: boolean;
  readonly score: number;
  readonly reason: string;
}

export interface DisocclusionOptions extends CompatibilityThresholds {
  readonly expectedDepth?: number;
  readonly maxDepthDiff?: number;
  readonly enforceSamplePlane?: boolean;
}

export interface DisocclusionResult {
  readonly promoted: boolean;
  readonly sourceLayer: number;
  readonly score: number;
  readonly reason: string;
}

export interface SpatialNeighborRef {
  readonly x: number;
  readonly y: number;
  readonly layer?: number;
  readonly pos?: Vec3Like;
  readonly normal?: Vec3Like;
}

export interface SpatialReuseResult {
  readonly mergedCount: number;
  readonly rejectedCount: number;
  readonly finalWSum: number;
  readonly finalMCount: number;
}

export interface ReservoirView {
  readonly sampleX: number;
  readonly sampleY: number;
  readonly sampleZ: number;
  readonly radianceR: number;
  readonly radianceG: number;
  readonly radianceB: number;
  readonly wSum: number;
  readonly mCount: number;
  readonly targetPdf: number;
  readonly depth: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/** Flat Float32 stride per pixel per layer in `MultiLayerReservoirBuffer`. */
export const RESERVOIR_STRIDE = 13;

export const RESERVOIR_OFF_SAMPLE_X = 0;
export const RESERVOIR_OFF_SAMPLE_Y = 1;
export const RESERVOIR_OFF_SAMPLE_Z = 2;
export const RESERVOIR_OFF_RAD_R = 3;
export const RESERVOIR_OFF_RAD_G = 4;
export const RESERVOIR_OFF_RAD_B = 5;
export const RESERVOIR_OFF_W_SUM = 6;
export const RESERVOIR_OFF_M_COUNT = 7;
export const RESERVOIR_OFF_TARGET_PDF = 8;
export const RESERVOIR_OFF_DEPTH = 9;
export const RESERVOIR_OFF_NX = 10;
export const RESERVOIR_OFF_NY = 11;
export const RESERVOIR_OFF_NZ = 12;

const ORCA_MAX_PROBE = 16;

function allocateSharedOrArrayBuffer(byteLength: number): ArrayBufferLike {
  if (typeof SharedArrayBuffer !== 'undefined') {
    return new SharedArrayBuffer(byteLength);
  }
  return new ArrayBuffer(byteLength);
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

function mixHash32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function quantizeNormalCode(nx: number, ny: number, nz: number): number {
  const lenSq = nx * nx + ny * ny + nz * nz;
  let ux = 0;
  let uy = 0;
  let uz = 1;
  if (lenSq > 1e-12) {
    const invLen = 1 / Math.sqrt(lenSq);
    ux = nx * invLen;
    uy = ny * invLen;
    uz = nz * invLen;
  }
  const qx = Math.max(0, Math.min(7, Math.floor((ux * 0.5 + 0.5) * 7.999)));
  const qy = Math.max(0, Math.min(7, Math.floor((uy * 0.5 + 0.5) * 7.999)));
  const qz = Math.max(0, Math.min(7, Math.floor((uz * 0.5 + 0.5) * 7.999)));
  return (qx | (qy << 3) | (qz << 6)) >>> 0;
}

function computeCellCoordinatesAndChecksum(
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  cellSize: number,
): { primary: number; checksum: number } {
  const invCell = 1 / Math.max(1e-6, cellSize);
  const ix = Math.floor(px * invCell) | 0;
  const iy = Math.floor(py * invCell) | 0;
  const iz = Math.floor(pz * invCell) | 0;
  const nCode = quantizeNormalCode(nx, ny, nz);

  let h = 0x811c9dc5;
  h = Math.imul(h ^ ix, 0x01000193) >>> 0;
  h = Math.imul(h ^ iy, 0x01000193) >>> 0;
  h = Math.imul(h ^ iz, 0x01000193) >>> 0;
  h = Math.imul(h ^ nCode, 0x01000193) >>> 0;
  const primary = mixHash32(h);

  let c = 0x9e3779b9;
  c = Math.imul(c ^ (ix + 0x13579bdf), 0x85ebca6b) >>> 0;
  c = Math.imul(c ^ (iy + 0x2468ace0), 0xc2b2ae35) >>> 0;
  c = Math.imul(c ^ (iz + 0x369cf258), 0x27d4eb2f) >>> 0;
  c = Math.imul(c ^ nCode, 0x165667b1) >>> 0;
  const checksum = mixHash32(c) || 1;

  return { primary, checksum };
}

/**
 * Computes a deterministic 32-bit spatial + directional cell hash for ORCA.
 * Quantizes world-space position by `cellSize` and surface normal into
 * directional bins so opposing sides of thin walls never share a cell.
 */
export function hashCellKey(
  px: number,
  py: number,
  pz: number,
  nx: number,
  ny: number,
  nz: number,
  cellSize: number,
): number {
  return computeCellCoordinatesAndChecksum(px, py, pz, nx, ny, nz, cellSize).primary;
}

/**
 * SIGGRAPH 2026 ORCA Stateless Radiance Cache.
 *
 * Allocates a fixed-capacity power-of-two spatial hash table once in a
 * `SharedArrayBuffer` (or `ArrayBuffer` fallback) and resets in O(1) per frame
 * via `resetFrame()` with zero temporal history and zero ghosting.
 */
export class OrcaStatelessRadianceCache {
  readonly tableSize: number;
  readonly mask: number;
  readonly cellSize: number;
  readonly buffer: ArrayBufferLike;
  readonly checksums: Uint32Array;
  readonly cellData: Float32Array;

  constructor(tableSize = 65536, cellSize = 0.25) {
    if (!isPowerOfTwo(tableSize)) {
      throw new RangeError(`OrcaStatelessRadianceCache tableSize must be a power of two, got ${tableSize}`);
    }
    if (!(cellSize > 0 && Number.isFinite(cellSize))) {
      throw new RangeError(`OrcaStatelessRadianceCache cellSize must be finite and > 0, got ${cellSize}`);
    }
    this.tableSize = tableSize;
    this.mask = tableSize - 1;
    this.cellSize = cellSize;

    // Layout: [checksums: Uint32Array(tableSize)] [cellData: Float32Array(tableSize * 4: sumR, sumG, sumB, count)]
    const checksumBytes = tableSize * Uint32Array.BYTES_PER_ELEMENT;
    const dataBytes = tableSize * 4 * Float32Array.BYTES_PER_ELEMENT;
    this.buffer = allocateSharedOrArrayBuffer(checksumBytes + dataBytes);
    this.checksums = new Uint32Array(this.buffer, 0, tableSize);
    this.cellData = new Float32Array(this.buffer, checksumBytes, tableSize * 4);
  }

  /** Clears all per-frame cell counts and radiance sums with zero temporal carry-over. */
  resetFrame(): void {
    this.checksums.fill(0);
    this.cellData.fill(0);
  }

  hashCellKey(
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    cellSize = this.cellSize,
  ): number {
    return hashCellKey(px, py, pz, nx, ny, nz, cellSize);
  }

  insertRadianceSample(pos: Vec3Like, normal: Vec3Like, rgb: Vec3Like): boolean {
    const r = rgb[0];
    const g = rgb[1];
    const b = rgb[2];
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
      return false;
    }

    const { primary, checksum } = computeCellCoordinatesAndChecksum(
      pos[0],
      pos[1],
      pos[2],
      normal[0],
      normal[1],
      normal[2],
      this.cellSize,
    );

    const startSlot = primary & this.mask;
    for (let probe = 0; probe < ORCA_MAX_PROBE; probe++) {
      const slot = (startSlot + probe) & this.mask;
      const existing = this.checksums[slot];
      if (existing === 0 || existing === checksum) {
        this.checksums[slot] = checksum;
        const base = slot * 4;
        this.cellData[base] += r;
        this.cellData[base + 1] += g;
        this.cellData[base + 2] += b;
        this.cellData[base + 3] += 1;
        return true;
      }
    }
    return false;
  }

  queryRadiance(pos: Vec3Like, normal: Vec3Like): OrcaQueryResult {
    const { primary, checksum } = computeCellCoordinatesAndChecksum(
      pos[0],
      pos[1],
      pos[2],
      normal[0],
      normal[1],
      normal[2],
      this.cellSize,
    );

    const startSlot = primary & this.mask;
    for (let probe = 0; probe < ORCA_MAX_PROBE; probe++) {
      const slot = (startSlot + probe) & this.mask;
      const existing = this.checksums[slot];
      if (existing === 0) {
        break;
      }
      if (existing === checksum) {
        const base = slot * 4;
        const count = this.cellData[base + 3];
        if (count <= 0) {
          return { r: 0, g: 0, b: 0, count: 0, found: false };
        }
        const invCount = 1 / count;
        return {
          r: this.cellData[base] * invCount,
          g: this.cellData[base + 1] * invCount,
          b: this.cellData[base + 2] * invCount,
          count,
          found: true,
        };
      }
    }

    return { r: 0, g: 0, b: 0, count: 0, found: false };
  }
}

/**
 * HPG 2026 Compatibility-Guided Neighbor Selection.
 *
 * Scores geometric plane distance `abs(dot(neighborPos - centerPos, centerNormal)) <= maxPlaneDist`
 * and normal similarity `dot(centerNormal, neighborNormal) >= minNormalDot` to prevent
 * light leaks across thin walls and sharp surface creases.
 */
export function computeNeighborCompatibility(
  centerPos: Vec3Like,
  centerNormal: Vec3Like,
  neighborPos: Vec3Like,
  neighborNormal: Vec3Like,
  thresholds?: CompatibilityThresholds,
): CompatibilityResult {
  const maxPlaneDist = thresholds?.maxPlaneDist ?? 0.1;
  const minNormalDot = thresholds?.minNormalDot ?? 0.85;
  const maxEuclideanDist = thresholds?.maxEuclideanDist;

  const cLenSq =
    centerNormal[0] * centerNormal[0] +
    centerNormal[1] * centerNormal[1] +
    centerNormal[2] * centerNormal[2];
  const nLenSq =
    neighborNormal[0] * neighborNormal[0] +
    neighborNormal[1] * neighborNormal[1] +
    neighborNormal[2] * neighborNormal[2];

  if (cLenSq <= 1e-12 || nLenSq <= 1e-12) {
    return { compatible: false, score: 0, reason: 'degenerate-normal' };
  }

  const invCLen = 1 / Math.sqrt(cLenSq);
  const invNLen = 1 / Math.sqrt(nLenSq);
  const cnx = centerNormal[0] * invCLen;
  const cny = centerNormal[1] * invCLen;
  const cnz = centerNormal[2] * invCLen;
  const nnx = neighborNormal[0] * invNLen;
  const nny = neighborNormal[1] * invNLen;
  const nnz = neighborNormal[2] * invNLen;

  const dx = neighborPos[0] - centerPos[0];
  const dy = neighborPos[1] - centerPos[1];
  const dz = neighborPos[2] - centerPos[2];

  const planeDist = Math.abs(dx * cnx + dy * cny + dz * cnz);
  const normalDot = cnx * nnx + cny * nny + cnz * nnz;

  if (!Number.isFinite(planeDist) || !Number.isFinite(normalDot)) {
    return { compatible: false, score: 0, reason: 'non-finite-geometry' };
  }

  if (normalDot < minNormalDot) {
    return {
      compatible: false,
      score: 0,
      reason: normalDot < 0 ? 'opposing-normal-thin-wall' : 'normal-mismatch',
    };
  }

  if (planeDist > maxPlaneDist) {
    return {
      compatible: false,
      score: 0,
      reason: 'plane-distance-exceeded',
    };
  }

  if (maxEuclideanDist !== undefined) {
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > maxEuclideanDist * maxEuclideanDist) {
      return {
        compatible: false,
        score: 0,
        reason: 'euclidean-distance-exceeded',
      };
    }
  }

  const planeScore = maxPlaneDist > 0 ? Math.max(0, 1 - planeDist / maxPlaneDist) : 1;
  const normalDenom = Math.max(1e-6, 1 - minNormalDot);
  const normalScore = Math.max(0, Math.min(1, (normalDot - minNormalDot) / normalDenom));
  const score = 0.5 * planeScore + 0.5 * normalScore;

  return {
    compatible: true,
    score,
    reason: 'compatible',
  };
}

/**
 * SIGGRAPH 2026 Multi-Layer ReSTIR Reservoir Buffer.
 *
 * Stores `width * height * layers` reservoirs in a single flat `Float32Array`
 * backed by `SharedArrayBuffer` (13 floats/reservoir):
 * `(sampleX, sampleY, sampleZ, radianceR, radianceG, radianceB, wSum, mCount, targetPdf, depth, nx, ny, nz)`.
 */
export class MultiLayerReservoirBuffer {
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly buffer: ArrayBufferLike;
  readonly data: Float32Array;

  constructor(width: number, height: number, layers = 3) {
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      throw new RangeError(`Invalid reservoir dimensions ${width}x${height}`);
    }
    if (!Number.isInteger(layers) || layers <= 0) {
      throw new RangeError(`Invalid layer count ${layers}`);
    }
    this.width = width;
    this.height = height;
    this.layers = layers;

    const totalFloats = width * height * layers * RESERVOIR_STRIDE;
    this.buffer = allocateSharedOrArrayBuffer(totalFloats * Float32Array.BYTES_PER_ELEMENT);
    this.data = new Float32Array(this.buffer);
  }

  clearAll(): void {
    this.data.fill(0);
  }

  indexOf(x: number, y: number, layer = 0): number {
    if (
      x < 0 ||
      x >= this.width ||
      y < 0 ||
      y >= this.height ||
      layer < 0 ||
      layer >= this.layers
    ) {
      throw new RangeError(
        `Reservoir coordinates (${x}, ${y}, layer=${layer}) out of bounds (${this.width}x${this.height}x${this.layers})`,
      );
    }
    return ((y * this.width + x) * this.layers + layer) * RESERVOIR_STRIDE;
  }

  clearReservoir(x: number, y: number, layer = 0): void {
    const base = this.indexOf(x, y, layer);
    this.data.fill(0, base, base + RESERVOIR_STRIDE);
  }

  getReservoir(x: number, y: number, layer = 0): ReservoirView {
    const base = this.indexOf(x, y, layer);
    const d = this.data;
    return {
      sampleX: d[base + RESERVOIR_OFF_SAMPLE_X],
      sampleY: d[base + RESERVOIR_OFF_SAMPLE_Y],
      sampleZ: d[base + RESERVOIR_OFF_SAMPLE_Z],
      radianceR: d[base + RESERVOIR_OFF_RAD_R],
      radianceG: d[base + RESERVOIR_OFF_RAD_G],
      radianceB: d[base + RESERVOIR_OFF_RAD_B],
      wSum: d[base + RESERVOIR_OFF_W_SUM],
      mCount: d[base + RESERVOIR_OFF_M_COUNT],
      targetPdf: d[base + RESERVOIR_OFF_TARGET_PDF],
      depth: d[base + RESERVOIR_OFF_DEPTH],
      nx: d[base + RESERVOIR_OFF_NX],
      ny: d[base + RESERVOIR_OFF_NY],
      nz: d[base + RESERVOIR_OFF_NZ],
    };
  }

  /** Computes the unbiased ReSTIR estimator weight `W = wSum / (mCount * targetPdf)`. */
  getFinalWeight(x: number, y: number, layer = 0): number {
    const base = this.indexOf(x, y, layer);
    const wSum = this.data[base + RESERVOIR_OFF_W_SUM];
    const mCount = this.data[base + RESERVOIR_OFF_M_COUNT];
    const targetPdf = this.data[base + RESERVOIR_OFF_TARGET_PDF];
    if (mCount <= 0 || targetPdf <= 0 || wSum <= 0) {
      return 0;
    }
    return wSum / (mCount * targetPdf);
  }

  /**
   * Streams a candidate GI sample into `(x, y, layer)` via Weighted Reservoir Sampling.
   */
  updateReservoir(
    x: number,
    y: number,
    layer: number,
    samplePos: Vec3Like,
    radianceRgb: Vec3Like,
    targetPdf: number,
    sourcePdf: number,
    randomU: number,
    depth?: number,
    normal?: Vec3Like,
  ): boolean {
    const base = this.indexOf(x, y, layer);
    const d = this.data;
    const risWeight = sourcePdf > 0 && targetPdf > 0 ? targetPdf / sourcePdf : 0;

    const newWSum = d[base + RESERVOIR_OFF_W_SUM] + risWeight;
    const newMCount = d[base + RESERVOIR_OFF_M_COUNT] + 1;
    d[base + RESERVOIR_OFF_W_SUM] = newWSum;
    d[base + RESERVOIR_OFF_M_COUNT] = newMCount;

    if (depth !== undefined && d[base + RESERVOIR_OFF_DEPTH] === 0) {
      d[base + RESERVOIR_OFF_DEPTH] = depth;
    }
    if (
      normal !== undefined &&
      d[base + RESERVOIR_OFF_NX] === 0 &&
      d[base + RESERVOIR_OFF_NY] === 0 &&
      d[base + RESERVOIR_OFF_NZ] === 0
    ) {
      d[base + RESERVOIR_OFF_NX] = normal[0];
      d[base + RESERVOIR_OFF_NY] = normal[1];
      d[base + RESERVOIR_OFF_NZ] = normal[2];
    }

    if (risWeight > 0 && newWSum > 0 && randomU * newWSum <= risWeight) {
      d[base + RESERVOIR_OFF_SAMPLE_X] = samplePos[0];
      d[base + RESERVOIR_OFF_SAMPLE_Y] = samplePos[1];
      d[base + RESERVOIR_OFF_SAMPLE_Z] = samplePos[2];
      d[base + RESERVOIR_OFF_RAD_R] = radianceRgb[0];
      d[base + RESERVOIR_OFF_RAD_G] = radianceRgb[1];
      d[base + RESERVOIR_OFF_RAD_B] = radianceRgb[2];
      d[base + RESERVOIR_OFF_TARGET_PDF] = targetPdf;
      if (depth !== undefined) {
        d[base + RESERVOIR_OFF_DEPTH] = depth;
      }
      if (normal !== undefined) {
        d[base + RESERVOIR_OFF_NX] = normal[0];
        d[base + RESERVOIR_OFF_NY] = normal[1];
        d[base + RESERVOIR_OFF_NZ] = normal[2];
      }
      return true;
    }
    return false;
  }

  /**
   * Splats a depth-peeled surface reservoir sample into `layer` (`0` = foreground,
   * `1..K-1` = occluded depth-peeled layers). Updates surface depth & normal metadata.
   */
  splatMultiLayer(
    x: number,
    y: number,
    layer: number,
    samplePos: Vec3Like,
    radianceRgb: Vec3Like,
    targetPdf: number,
    sourcePdf: number,
    depth: number,
    normal: Vec3Like,
    randomU: number,
  ): boolean {
    const base = this.indexOf(x, y, layer);
    this.data[base + RESERVOIR_OFF_DEPTH] = depth;
    this.data[base + RESERVOIR_OFF_NX] = normal[0];
    this.data[base + RESERVOIR_OFF_NY] = normal[1];
    this.data[base + RESERVOIR_OFF_NZ] = normal[2];
    return this.updateReservoir(
      x,
      y,
      layer,
      samplePos,
      radianceRgb,
      targetPdf,
      sourcePdf,
      randomU,
      depth,
      normal,
    );
  }

  /**
   * Immediately promotes a matching valid background layer (`1..layers-1`) into
   * foreground layer `0` when a foreground occluder moves out of the way.
   */
  resolveDisoccludedPixel(
    x: number,
    y: number,
    expectedPos: Vec3Like,
    expectedNormal: Vec3Like,
    options?: DisocclusionOptions,
  ): DisocclusionResult {
    const minNormalDot = options?.minNormalDot ?? 0.85;
    const maxPlaneDist = options?.maxPlaneDist ?? 0.1;
    const maxDepthDiff = options?.maxDepthDiff ?? 0.5;
    const expectedDepth = options?.expectedDepth;
    const enforceSamplePlane = options?.enforceSamplePlane ?? false;
    const d = this.data;

    const eLenSq =
      expectedNormal[0] * expectedNormal[0] +
      expectedNormal[1] * expectedNormal[1] +
      expectedNormal[2] * expectedNormal[2];
    if (eLenSq <= 1e-12) {
      return { promoted: false, sourceLayer: -1, score: 0, reason: 'degenerate-expected-normal' };
    }
    const invELen = 1 / Math.sqrt(eLenSq);
    const enx = expectedNormal[0] * invELen;
    const eny = expectedNormal[1] * invELen;
    const enz = expectedNormal[2] * invELen;

    // Check if foreground layer 0 already matches the visible surface.
    const fgBase = this.indexOf(x, y, 0);
    if (
      d[fgBase + RESERVOIR_OFF_M_COUNT] > 0 &&
      d[fgBase + RESERVOIR_OFF_W_SUM] > 0 &&
      d[fgBase + RESERVOIR_OFF_TARGET_PDF] > 0
    ) {
      const fgNx = d[fgBase + RESERVOIR_OFF_NX];
      const fgNy = d[fgBase + RESERVOIR_OFF_NY];
      const fgNz = d[fgBase + RESERVOIR_OFF_NZ];
      const fgLenSq = fgNx * fgNx + fgNy * fgNy + fgNz * fgNz;
      if (fgLenSq > 1e-12) {
        const fgDot = (fgNx * enx + fgNy * eny + fgNz * enz) / Math.sqrt(fgLenSq);
        const depthOk =
          expectedDepth === undefined ||
          Math.abs(d[fgBase + RESERVOIR_OFF_DEPTH] - expectedDepth) <= maxDepthDiff;
        if (fgDot >= minNormalDot && depthOk) {
          return { promoted: false, sourceLayer: 0, score: fgDot, reason: 'foreground-already-valid' };
        }
      }
    }

    let bestLayer = -1;
    let bestScore = -1;

    for (let layer = 1; layer < this.layers; layer++) {
      const base = this.indexOf(x, y, layer);
      if (
        d[base + RESERVOIR_OFF_M_COUNT] <= 0 ||
        d[base + RESERVOIR_OFF_W_SUM] <= 0 ||
        d[base + RESERVOIR_OFF_TARGET_PDF] <= 0
      ) {
        continue;
      }

      const lnx = d[base + RESERVOIR_OFF_NX];
      const lny = d[base + RESERVOIR_OFF_NY];
      const lnz = d[base + RESERVOIR_OFF_NZ];
      const lLenSq = lnx * lnx + lny * lny + lnz * lnz;
      if (lLenSq <= 1e-12) {
        continue;
      }
      const invLLen = 1 / Math.sqrt(lLenSq);
      const normalDot = (lnx * enx + lny * eny + lnz * enz) * invLLen;
      if (normalDot < minNormalDot) {
        continue;
      }

      if (expectedDepth !== undefined) {
        const depthDiff = Math.abs(d[base + RESERVOIR_OFF_DEPTH] - expectedDepth);
        if (depthDiff > maxDepthDiff) {
          continue;
        }
      }

      const compat = computeNeighborCompatibility(
        expectedPos,
        expectedNormal,
        [
          d[base + RESERVOIR_OFF_SAMPLE_X],
          d[base + RESERVOIR_OFF_SAMPLE_Y],
          d[base + RESERVOIR_OFF_SAMPLE_Z],
        ],
        [lnx, lny, lnz],
        { maxPlaneDist, minNormalDot },
      );

      if (enforceSamplePlane && !compat.compatible) {
        continue;
      }

      const candidateScore = compat.compatible ? 1 + compat.score : normalDot;
      if (candidateScore > bestScore) {
        bestScore = candidateScore;
        bestLayer = layer;
      }
    }

    if (bestLayer < 0) {
      return { promoted: false, sourceLayer: -1, score: 0, reason: 'no-compatible-background-layer' };
    }

    const srcBase = this.indexOf(x, y, bestLayer);
    for (let i = 0; i < RESERVOIR_STRIDE; i++) {
      d[fgBase + i] = d[srcBase + i];
    }
    this.clearReservoir(x, y, bestLayer);

    return {
      promoted: true,
      sourceLayer: bestLayer,
      score: bestScore,
      reason: 'promoted-background-layer',
    };
  }

  /**
   * Merges neighboring reservoirs into `(x, y, layer)` ONLY when they pass
   * HPG 2026 `computeNeighborCompatibility`, preventing thin-wall light leaks.
   */
  spatialReuseCompatible(
    x: number,
    y: number,
    layer: number,
    neighbors: readonly SpatialNeighborRef[],
    centerPos: Vec3Like,
    centerNormal: Vec3Like,
    thresholds?: CompatibilityThresholds,
    randomFn: () => number = Math.random,
  ): SpatialReuseResult {
    const cBase = this.indexOf(x, y, layer);
    const d = this.data;

    let mergedCount = 0;
    let rejectedCount = 0;

    for (let i = 0; i < neighbors.length; i++) {
      const n = neighbors[i];
      const nLayer = n.layer ?? layer;
      if (
        n.x < 0 ||
        n.x >= this.width ||
        n.y < 0 ||
        n.y >= this.height ||
        nLayer < 0 ||
        nLayer >= this.layers
      ) {
        rejectedCount++;
        continue;
      }

      const nBase = this.indexOf(n.x, n.y, nLayer);
      const nM = d[nBase + RESERVOIR_OFF_M_COUNT];
      const nWSum = d[nBase + RESERVOIR_OFF_W_SUM];
      const nPdf = d[nBase + RESERVOIR_OFF_TARGET_PDF];
      if (nM <= 0 || nWSum <= 0 || nPdf <= 0) {
        rejectedCount++;
        continue;
      }

      const nPos: Vec3Like = n.pos ?? [
        d[nBase + RESERVOIR_OFF_SAMPLE_X],
        d[nBase + RESERVOIR_OFF_SAMPLE_Y],
        d[nBase + RESERVOIR_OFF_SAMPLE_Z],
      ];
      const nNormal: Vec3Like = n.normal ?? [
        d[nBase + RESERVOIR_OFF_NX],
        d[nBase + RESERVOIR_OFF_NY],
        d[nBase + RESERVOIR_OFF_NZ],
      ];

      const compat = computeNeighborCompatibility(
        centerPos,
        centerNormal,
        nPos,
        nNormal,
        thresholds,
      );

      if (!compat.compatible) {
        rejectedCount++;
        continue;
      }

      // ReSTIR spatial combination weight: targetPdf_center * W_neighbor * M_neighbor
      const neighborW = nWSum / (nM * nPdf);
      const combineWeight = nPdf * neighborW * nM;
      const nextWSum = d[cBase + RESERVOIR_OFF_W_SUM] + combineWeight;
      const nextM = d[cBase + RESERVOIR_OFF_M_COUNT] + nM;

      d[cBase + RESERVOIR_OFF_W_SUM] = nextWSum;
      d[cBase + RESERVOIR_OFF_M_COUNT] = nextM;

      if (combineWeight > 0 && nextWSum > 0 && randomFn() * nextWSum <= combineWeight) {
        d[cBase + RESERVOIR_OFF_SAMPLE_X] = d[nBase + RESERVOIR_OFF_SAMPLE_X];
        d[cBase + RESERVOIR_OFF_SAMPLE_Y] = d[nBase + RESERVOIR_OFF_SAMPLE_Y];
        d[cBase + RESERVOIR_OFF_SAMPLE_Z] = d[nBase + RESERVOIR_OFF_SAMPLE_Z];
        d[cBase + RESERVOIR_OFF_RAD_R] = d[nBase + RESERVOIR_OFF_RAD_R];
        d[cBase + RESERVOIR_OFF_RAD_G] = d[nBase + RESERVOIR_OFF_RAD_G];
        d[cBase + RESERVOIR_OFF_RAD_B] = d[nBase + RESERVOIR_OFF_RAD_B];
        d[cBase + RESERVOIR_OFF_TARGET_PDF] = nPdf;
      }

      mergedCount++;
    }

    return {
      mergedCount,
      rejectedCount,
      finalWSum: d[cBase + RESERVOIR_OFF_W_SUM],
      finalMCount: d[cBase + RESERVOIR_OFF_M_COUNT],
    };
  }
}
