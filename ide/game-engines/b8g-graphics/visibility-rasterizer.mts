/**
 * @file visibility-rasterizer.mts
 * @description Pure portable TypeScript (erasableSyntaxOnly, zero external/node imports)
 * software Visibility Buffer & CuRast/Nanite-style 64-bit atomicMin micropolygon
 * rasterizer, Two-Pass HZB occlusion culler, and analytical barycentric ddx/ddy
 * bindless material evaluator backed by B8G_ARENA_V1 SharedArrayBuffer zero-copy memory.
 */

/** Clear sentinel value for the 64-bit visibility buffer (max u32 depth + max id). */
export const VISBUF_CLEAR_VALUE = 0xffffffffffffffffn;

/** Stride in float32 elements per vertex in the flat arena vertex buffer: (x, y, z, w, u, v, nx, ny). */
export const VISBUF_VERTEX_STRIDE = 8;

/** Cache-line alignment in bytes for B8G_ARENA_V1 SharedArrayBuffer regions. */
const ARENA_ALIGN_BYTES = 64;

function alignUp(value: number, alignment: number): number {
  return (value + alignment - 1) & ~(alignment - 1);
}

/** Unpacked 64-bit visibility buffer sample. */
export interface UnpackedVisibilityId {
  depthU32: number;
  instanceId: number;
  triangleId: number;
  valid: boolean;
}

/** Stats returned by VisibilityBufferArena.getStats(). */
export interface VisibilityArenaStats {
  width: number;
  height: number;
  pixelCount: number;
  maxVertices: number;
  maxTriangles: number;
  byteLength: number;
  validPixels: number;
  minDepthU32: number;
  maxDepthU32: number;
}

/** Meshlet / cluster descriptor for rasterization and HZB culling. */
export interface Meshlet {
  instanceId: number;
  indexOffset: number;
  triangleCount: number;
  vertexOffset?: number;
  triangleOffset?: number;
  boundsCenter?: readonly [number, number, number];
  boundsRadius?: number;
  coneApex?: readonly [number, number, number];
  coneAxis?: readonly [number, number, number];
  coneCutoff?: number;
}

/** Statistics returned by rasterizeMicropolygons64(). */
export interface RasterizeStats {
  trianglesSubmitted: number;
  pixelsTested: number;
  atomicWrites: number;
  subpixelTriangles: number;
}

/** Conservative max-Z Hierarchical Z-Buffer (HZB) mip pyramid down to 1x1. */
export interface HzbPyramid {
  width: number;
  height: number;
  levelCount: number;
  levels: Float32Array[];
  widths: number[];
  heights: number[];
}

/** Optional callback for custom disocclusion evaluation during Pass 2 HZB culling. */
export type DisocclusionPredicate = (
  meshlet: Meshlet,
  pass2Hzb: HzbPyramid,
  mvpMat4: Float32Array | readonly number[],
) => boolean;

/** Result of Two-Pass Hierarchical Z-Buffer (HZB) occlusion culling. */
export interface TwoPassHzbResult {
  pass1Visible: Meshlet[];
  pass2Disoccluded: Meshlet[];
  culledMeshlets: Meshlet[];
  overdrawEliminatedPct: number;
}

/** Bindless material descriptor evaluated per visible pixel. */
export interface BindlessMaterial {
  baseColor: readonly [number, number, number, number?];
  roughness?: number;
  metallic?: number;
  mipBias?: number;
  texWidth?: number;
  texHeight?: number;
  textureData?: Uint8ClampedArray | Float32Array;
}

/** Analytical screen-space barycentrics and exact partial derivatives (no 2x2 quads). */
export interface AnalyticalBarycentrics {
  w0: number;
  w1: number;
  w2: number;
  u: number;
  v: number;
  duDx: number;
  dvDx: number;
  duDy: number;
  dvDy: number;
  nx: number;
  ny: number;
  nz: number;
}

/** Statistics returned by evaluateBindlessVisibilityPass(). */
export interface BindlessEvaluateStats {
  shadedPixels: number;
  backgroundPixels: number;
  uniqueInstances: number;
  meanGradMag: number;
}

/**
 * Packs a 32-bit unsigned depth and 16-bit instance/triangle IDs into a 64-bit
 * visibility key where lexicographical uint64 order equals front-to-back depth order.
 */
export function packVisibilityId(
  depthU32: number,
  instanceId: number,
  triangleId: number,
): bigint {
  const hi = BigInt(depthU32 >>> 0) << 32n;
  const lo = (((instanceId & 0xffff) << 16) | (triangleId & 0xffff)) >>> 0;
  return hi | BigInt(lo);
}

/**
 * Unpacks a 64-bit visibility ID produced by packVisibilityId().
 * Recognizes VISBUF_CLEAR_VALUE as an empty/background pixel (valid: false).
 */
export function unpackVisibilityId(visId: bigint): UnpackedVisibilityId {
  if (visId === VISBUF_CLEAR_VALUE) {
    return {
      depthU32: 0xffffffff,
      instanceId: 0xffff,
      triangleId: 0xffff,
      valid: false,
    };
  }
  const depthU32 = Number((visId >> 32n) & 0xffffffffn) >>> 0;
  const lo = Number(visId & 0xffffffffn) >>> 0;
  return {
    depthU32,
    instanceId: (lo >>> 16) & 0xffff,
    triangleId: lo & 0xffff,
    valid: true,
  };
}

/**
 * Single SharedArrayBuffer-backed visibility buffer arena (B8G_ARENA_V1 layout).
 * All sub-buffers are 64-byte aligned inside one contiguous SharedArrayBuffer.
 */
export class VisibilityBufferArena {
  readonly width: number;
  readonly height: number;
  readonly pixelCount: number;
  readonly maxVertices: number;
  readonly maxTriangles: number;
  readonly buffer: SharedArrayBuffer;
  readonly visBuf: BigUint64Array;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly depthBuf: Float32Array;
  lastMvpMat4: Float32Array | null;

  constructor(
    width: number,
    height: number,
    maxVertices = 65536,
    maxTriangles = 65536,
  ) {
    if (width <= 0 || height <= 0) {
      throw new RangeError(`Invalid viewport dimensions: ${width}x${height}`);
    }
    if (maxVertices <= 0 || maxTriangles <= 0) {
      throw new RangeError(
        `Invalid capacity: maxVertices=${maxVertices}, maxTriangles=${maxTriangles}`,
      );
    }

    this.width = width | 0;
    this.height = height | 0;
    this.pixelCount = this.width * this.height;
    this.maxVertices = maxVertices | 0;
    this.maxTriangles = maxTriangles | 0;
    this.lastMvpMat4 = null;

    const visBytes = alignUp(this.pixelCount * 8, ARENA_ALIGN_BYTES);
    const vertBytes = alignUp(
      this.maxVertices * VISBUF_VERTEX_STRIDE * 4,
      ARENA_ALIGN_BYTES,
    );
    const idxBytes = alignUp(this.maxTriangles * 3 * 4, ARENA_ALIGN_BYTES);
    const depthBytes = alignUp(this.pixelCount * 4, ARENA_ALIGN_BYTES);

    const visOffset = 0;
    const vertOffset = visOffset + visBytes;
    const idxOffset = vertOffset + vertBytes;
    const depthOffset = idxOffset + idxBytes;
    const totalBytes = depthOffset + depthBytes;

    this.buffer = new SharedArrayBuffer(totalBytes);
    this.visBuf = new BigUint64Array(this.buffer, visOffset, this.pixelCount);
    this.vertices = new Float32Array(
      this.buffer,
      vertOffset,
      this.maxVertices * VISBUF_VERTEX_STRIDE,
    );
    this.indices = new Uint32Array(
      this.buffer,
      idxOffset,
      this.maxTriangles * 3,
    );
    this.depthBuf = new Float32Array(this.buffer, depthOffset, this.pixelCount);

    this.clear();
  }

  /** Clears the 64-bit visibility buffer and depth resolve buffer. */
  clear(clearDepth = 1.0): void {
    this.visBuf.fill(VISBUF_CLEAR_VALUE);
    this.depthBuf.fill(clearDepth);
  }

  /** Writes a single vertex (x, y, z, w, u, v, nx, ny) at vertexIndex. */
  setVertex(
    vertexIndex: number,
    x: number,
    y: number,
    z: number,
    w: number,
    u: number,
    v: number,
    nx: number,
    ny: number,
  ): void {
    const base = vertexIndex * VISBUF_VERTEX_STRIDE;
    this.vertices[base] = x;
    this.vertices[base + 1] = y;
    this.vertices[base + 2] = z;
    this.vertices[base + 3] = w;
    this.vertices[base + 4] = u;
    this.vertices[base + 5] = v;
    this.vertices[base + 6] = nx;
    this.vertices[base + 7] = ny;
  }

  /** Writes a triangle's 3 vertex indices at triangleIndex. */
  setTriangle(triangleIndex: number, i0: number, i1: number, i2: number): void {
    const base = triangleIndex * 3;
    this.indices[base] = i0 >>> 0;
    this.indices[base + 1] = i1 >>> 0;
    this.indices[base + 2] = i2 >>> 0;
  }

  /** Total byte length of the backing SharedArrayBuffer. */
  getByteLength(): number {
    return this.buffer.byteLength;
  }

  /** Computes current occupancy and depth statistics across the visibility buffer. */
  getStats(): VisibilityArenaStats {
    let validPixels = 0;
    let minDepthU32 = 0xffffffff;
    let maxDepthU32 = 0;
    const buf = this.visBuf;
    const len = buf.length;

    for (let i = 0; i < len; i++) {
      const val = buf[i];
      if (val !== VISBUF_CLEAR_VALUE) {
        validPixels++;
        const d = Number((val >> 32n) & 0xffffffffn) >>> 0;
        if (d < minDepthU32) minDepthU32 = d;
        if (d > maxDepthU32) maxDepthU32 = d;
      }
    }

    if (validPixels === 0) {
      minDepthU32 = 0;
      maxDepthU32 = 0;
    }

    return {
      width: this.width,
      height: this.height,
      pixelCount: this.pixelCount,
      maxVertices: this.maxVertices,
      maxTriangles: this.maxTriangles,
      byteLength: this.buffer.byteLength,
      validPixels,
      minDepthU32,
      maxDepthU32,
    };
  }
}

interface ProjectedVertex {
  cx: number;
  cy: number;
  cz: number;
  cw: number;
  sx: number;
  sy: number;
  ndcZ: number;
}

function projectVertex(
  vertices: Float32Array,
  vertexIndex: number,
  mvp: Float32Array | readonly number[],
  width: number,
  height: number,
  out: ProjectedVertex,
): boolean {
  const base = vertexIndex * VISBUF_VERTEX_STRIDE;
  const x = vertices[base];
  const y = vertices[base + 1];
  const z = vertices[base + 2];
  const w = vertices[base + 3];

  // Column-major 4x4 matrix multiplication (matches WGSL mat4x4<f32>)
  const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12] * w;
  const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13] * w;
  const cz = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14] * w;
  const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15] * w;

  out.cx = cx;
  out.cy = cy;
  out.cz = cz;
  out.cw = cw;

  if (cw <= 1e-6) {
    return false;
  }

  const invW = 1.0 / cw;
  const ndcX = cx * invW;
  const ndcY = cy * invW;
  const ndcZ = cz * invW;

  out.sx = (ndcX * 0.5 + 0.5) * width;
  out.sy = (0.5 - ndcY * 0.5) * height;
  out.ndcZ = ndcZ;
  return true;
}

/**
 * CuRast / Nanite-style 64-bit atomicMin software compute rasterizer.
 * Evaluates edge functions & depth across clipped triangle bounding boxes and
 * commits packed visibility keys via an Atomics.load + Atomics.compareExchange loop.
 */
export function rasterizeMicropolygons64(
  arena: VisibilityBufferArena,
  meshlets: readonly Meshlet[],
  mvpMat4: Float32Array | readonly number[],
  cullBackface = false,
): RasterizeStats {
  const width = arena.width;
  const height = arena.height;
  const vertices = arena.vertices;
  const indices = arena.indices;
  const visBuf = arena.visBuf;
  const depthBuf = arena.depthBuf;

  arena.lastMvpMat4 = Float32Array.from(mvpMat4);

  let trianglesSubmitted = 0;
  let pixelsTested = 0;
  let atomicWrites = 0;
  let subpixelTriangles = 0;

  const p0: ProjectedVertex = { cx: 0, cy: 0, cz: 0, cw: 1, sx: 0, sy: 0, ndcZ: 0 };
  const p1: ProjectedVertex = { cx: 0, cy: 0, cz: 0, cw: 1, sx: 0, sy: 0, ndcZ: 0 };
  const p2: ProjectedVertex = { cx: 0, cy: 0, cz: 0, cw: 1, sx: 0, sy: 0, ndcZ: 0 };

  for (let m = 0; m < meshlets.length; m++) {
    const meshlet = meshlets[m];
    const baseTri =
      meshlet.triangleOffset !== undefined
        ? meshlet.triangleOffset
        : Math.floor(meshlet.indexOffset / 3);
    const vertexOffset = meshlet.vertexOffset ?? 0;

    for (let t = 0; t < meshlet.triangleCount; t++) {
      const triId = baseTri + t;
      const idxBase = triId * 3;
      if (idxBase + 2 >= indices.length) break;

      trianglesSubmitted++;

      const i0 = indices[idxBase] + vertexOffset;
      const i1 = indices[idxBase + 1] + vertexOffset;
      const i2 = indices[idxBase + 2] + vertexOffset;

      if (
        !projectVertex(vertices, i0, mvpMat4, width, height, p0) ||
        !projectVertex(vertices, i1, mvpMat4, width, height, p1) ||
        !projectVertex(vertices, i2, mvpMat4, width, height, p2)
      ) {
        continue;
      }

      const area2 =
        (p1.sx - p0.sx) * (p2.sy - p0.sy) - (p1.sy - p0.sy) * (p2.sx - p0.sx);
      if (Math.abs(area2) < 1e-6) {
        subpixelTriangles++;
        continue;
      }
      if (cullBackface && area2 > 0) {
        continue;
      }

      const invArea2 = 1.0 / area2;

      const minXf = Math.min(p0.sx, p1.sx, p2.sx);
      const maxXf = Math.max(p0.sx, p1.sx, p2.sx);
      const minYf = Math.min(p0.sy, p1.sy, p2.sy);
      const maxYf = Math.max(p0.sy, p1.sy, p2.sy);

      const minX = Math.max(0, Math.floor(minXf));
      const maxX = Math.min(width - 1, Math.floor(maxXf));
      const minY = Math.max(0, Math.floor(minYf));
      const maxY = Math.min(height - 1, Math.floor(maxYf));

      if (minX > maxX || minY > maxY) {
        subpixelTriangles++;
        continue;
      }

      let coveredAny = false;

      for (let py = minY; py <= maxY; py++) {
        const cy = py + 0.5;
        const rowOffset = py * width;

        for (let px = minX; px <= maxX; px++) {
          pixelsTested++;
          const cx = px + 0.5;

          const e0 = (p2.sx - p1.sx) * (cy - p1.sy) - (p2.sy - p1.sy) * (cx - p1.sx);
          const e1 = (p0.sx - p2.sx) * (cy - p2.sy) - (p0.sy - p2.sy) * (cx - p2.sx);
          const e2 = (p1.sx - p0.sx) * (cy - p0.sy) - (p1.sy - p0.sy) * (cx - p0.sx);

          // Normalize by signed area2 so both CW and CCW windings evaluate uniformly
          const w0 = e0 * invArea2;
          const w1 = e1 * invArea2;
          const w2 = e2 * invArea2;

          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) {
            continue;
          }

          const depth = w0 * p0.ndcZ + w1 * p1.ndcZ + w2 * p2.ndcZ;
          if (depth < 0.0 || depth > 1.0) {
            continue;
          }

          coveredAny = true;
          const depthU32 =
            Math.min(0xffffffff, Math.max(0, Math.round(depth * 0xffffffff))) >>> 0;
          const visId = packVisibilityId(depthU32, meshlet.instanceId, triId);
          const pixelIdx = rowOffset + px;

          let current = Atomics.load(visBuf, pixelIdx);
          while (visId < current) {
            const prev = Atomics.compareExchange(visBuf, pixelIdx, current, visId);
            if (prev === current) {
              atomicWrites++;
              depthBuf[pixelIdx] = depth;
              break;
            }
            current = prev;
          }
        }
      }

      if (!coveredAny) {
        subpixelTriangles++;
      }
    }
  }

  return {
    trianglesSubmitted,
    pixelsTested,
    atomicWrites,
    subpixelTriangles,
  };
}

/**
 * Builds a conservative max-Z Hierarchical Z-Buffer (HZB) mip chain from level 0 down to 1x1.
 * For [0..1] depth (0 = near, 1 = far), each parent texel stores the maximum depth of its 2x2 children.
 */
export function buildHzbPyramid(
  depthBuffer: Float32Array,
  width: number,
  height: number,
): HzbPyramid {
  if (width <= 0 || height <= 0) {
    throw new RangeError(`Invalid HZB dimensions: ${width}x${height}`);
  }
  if (depthBuffer.length < width * height) {
    throw new RangeError(
      `Depth buffer too small (${depthBuffer.length}) for ${width}x${height}`,
    );
  }

  const levels: Float32Array[] = [];
  const widths: number[] = [];
  const heights: number[] = [];

  const level0 = new Float32Array(width * height);
  level0.set(depthBuffer.subarray(0, width * height));
  levels.push(level0);
  widths.push(width);
  heights.push(height);

  let curW = width;
  let curH = height;
  let prev = level0;

  while (curW > 1 || curH > 1) {
    const nextW = Math.max(1, Math.ceil(curW / 2));
    const nextH = Math.max(1, Math.ceil(curH / 2));
    const next = new Float32Array(nextW * nextH);

    for (let y = 0; y < nextH; y++) {
      const sy0 = Math.min(curH - 1, y * 2);
      const sy1 = Math.min(curH - 1, sy0 + 1);
      const row0 = sy0 * curW;
      const row1 = sy1 * curW;
      const dstRow = y * nextW;

      for (let x = 0; x < nextW; x++) {
        const sx0 = Math.min(curW - 1, x * 2);
        const sx1 = Math.min(curW - 1, sx0 + 1);

        const d00 = prev[row0 + sx0];
        const d10 = prev[row0 + sx1];
        const d01 = prev[row1 + sx0];
        const d11 = prev[row1 + sx1];

        next[dstRow + x] = Math.max(d00, d10, d01, d11);
      }
    }

    levels.push(next);
    widths.push(nextW);
    heights.push(nextH);
    curW = nextW;
    curH = nextH;
    prev = next;
  }

  return {
    width,
    height,
    levelCount: levels.length,
    levels,
    widths,
    heights,
  };
}

interface ProjectedSphereBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  alwaysVisible: boolean;
}

function projectMeshletBounds(
  meshlet: Meshlet,
  mvp: Float32Array | readonly number[],
  width: number,
  height: number,
): ProjectedSphereBounds {
  const center = meshlet.boundsCenter;
  const radius = meshlet.boundsRadius ?? 0;

  if (!center || radius <= 0) {
    return {
      minX: 0,
      maxX: width - 1,
      minY: 0,
      maxY: height - 1,
      minZ: 0,
      maxZ: 1,
      alwaysVisible: true,
    };
  }

  const [bx, by, bz] = center;

  // Project 8 corners of the bounding box enclosing the bounding sphere for conservative bounds
  let minNdcX = Infinity;
  let maxNdcX = -Infinity;
  let minNdcY = Infinity;
  let maxNdcY = -Infinity;
  let minNdcZ = Infinity;
  let maxNdcZ = -Infinity;

  for (let mask = 0; mask < 8; mask++) {
    const x = bx + (mask & 1 ? radius : -radius);
    const y = by + (mask & 2 ? radius : -radius);
    const z = bz + (mask & 4 ? radius : -radius);

    const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
    const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
    const cz = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
    const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];

    if (cw <= 1e-4) {
      return {
        minX: 0,
        maxX: width - 1,
        minY: 0,
        maxY: height - 1,
        minZ: 0,
        maxZ: 1,
        alwaysVisible: true,
      };
    }

    const invW = 1.0 / cw;
    const nx = cx * invW;
    const ny = cy * invW;
    const nz = cz * invW;

    if (nx < minNdcX) minNdcX = nx;
    if (nx > maxNdcX) maxNdcX = nx;
    if (ny < minNdcY) minNdcY = ny;
    if (ny > maxNdcY) maxNdcY = ny;
    if (nz < minNdcZ) minNdcZ = nz;
    if (nz > maxNdcZ) maxNdcZ = nz;
  }

  const sx0 = (minNdcX * 0.5 + 0.5) * width;
  const sx1 = (maxNdcX * 0.5 + 0.5) * width;
  const sy0 = (0.5 - maxNdcY * 0.5) * height;
  const sy1 = (0.5 - minNdcY * 0.5) * height;

  return {
    minX: Math.max(0, Math.floor(sx0)),
    maxX: Math.min(width - 1, Math.floor(sx1)),
    minY: Math.max(0, Math.floor(sy0)),
    maxY: Math.min(height - 1, Math.floor(sy1)),
    minZ: Math.max(0, Math.min(1, minNdcZ)),
    maxZ: Math.max(0, Math.min(1, maxNdcZ)),
    alwaysVisible: false,
  };
}

function isVisibleAgainstHzb(
  bounds: ProjectedSphereBounds,
  hzb: HzbPyramid,
): boolean {
  if (bounds.alwaysVisible) return true;
  if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY) return false;

  const rectW = Math.max(1, bounds.maxX - bounds.minX + 1);
  const rectH = Math.max(1, bounds.maxY - bounds.minY + 1);
  const maxDim = Math.max(rectW, rectH);
  const mip = Math.min(
    hzb.levelCount - 1,
    Math.max(0, Math.ceil(Math.log2(maxDim)) - 1),
  );

  const mipW = hzb.widths[mip];
  const mipH = hzb.heights[mip];
  const mipBuf = hzb.levels[mip];

  const tx0 = Math.max(0, Math.min(mipW - 1, bounds.minX >> mip));
  const tx1 = Math.max(0, Math.min(mipW - 1, bounds.maxX >> mip));
  const ty0 = Math.max(0, Math.min(mipH - 1, bounds.minY >> mip));
  const ty1 = Math.max(0, Math.min(mipH - 1, bounds.maxY >> mip));

  let hzbMaxZ = 0.0;
  for (let ty = ty0; ty <= ty1; ty++) {
    const row = ty * mipW;
    for (let tx = tx0; tx <= tx1; tx++) {
      const z = mipBuf[row + tx];
      if (z > hzbMaxZ) hzbMaxZ = z;
    }
  }

  return bounds.minZ <= hzbMaxZ + 1e-6;
}

/**
 * Two-Pass Hierarchical Z-Buffer (HZB) occlusion culling:
 * - Pass 1 culls clusters against the previous frame's HZB (`prevHzb`).
 * - Pass 2 builds an updated HZB from Pass 1 survivors and re-tests newly disoccluded clusters.
 */
export function cullMeshletsTwoPassHzb(
  meshlets: readonly Meshlet[],
  prevHzb: HzbPyramid,
  mvpMat4: Float32Array | readonly number[],
  isDisoccludedFn?: DisocclusionPredicate,
): TwoPassHzbResult {
  const pass1Visible: Meshlet[] = [];
  const pass1Occluded: Array<{ meshlet: Meshlet; bounds: ProjectedSphereBounds }> = [];
  const pass1Bounds: ProjectedSphereBounds[] = [];

  for (let i = 0; i < meshlets.length; i++) {
    const meshlet = meshlets[i];
    const bounds = projectMeshletBounds(meshlet, mvpMat4, prevHzb.width, prevHzb.height);
    if (isVisibleAgainstHzb(bounds, prevHzb)) {
      pass1Visible.push(meshlet);
      pass1Bounds.push(bounds);
    } else {
      pass1Occluded.push({ meshlet, bounds });
    }
  }

  // Rebuild Pass 2 HZB from Pass 1 survivors' conservative occluder footprint
  const pass2Depth = new Float32Array(prevHzb.width * prevHzb.height);
  pass2Depth.fill(1.0);

  for (let i = 0; i < pass1Bounds.length; i++) {
    const b = pass1Bounds[i];
    if (b.alwaysVisible || b.minX > b.maxX || b.minY > b.maxY) continue;
    const occDepth = b.maxZ;
    for (let y = b.minY; y <= b.maxY; y++) {
      const row = y * prevHzb.width;
      for (let x = b.minX; x <= b.maxX; x++) {
        if (occDepth < pass2Depth[row + x]) {
          pass2Depth[row + x] = occDepth;
        }
      }
    }
  }

  const pass2Hzb = buildHzbPyramid(pass2Depth, prevHzb.width, prevHzb.height);
  const pass2Disoccluded: Meshlet[] = [];
  const culledMeshlets: Meshlet[] = [];

  for (let i = 0; i < pass1Occluded.length; i++) {
    const entry = pass1Occluded[i];
    const disoccluded = isDisoccludedFn
      ? isDisoccludedFn(entry.meshlet, pass2Hzb, mvpMat4)
      : isVisibleAgainstHzb(entry.bounds, pass2Hzb);

    if (disoccluded) {
      pass2Disoccluded.push(entry.meshlet);
    } else {
      culledMeshlets.push(entry.meshlet);
    }
  }

  const total = meshlets.length;
  const overdrawEliminatedPct =
    total > 0 ? (culledMeshlets.length / total) * 100.0 : 0.0;

  return {
    pass1Visible,
    pass2Disoccluded,
    culledMeshlets,
    overdrawEliminatedPct,
  };
}

/**
 * Computes analytical screen-space barycentrics and exact perspective-correct
 * attribute partial derivatives (du/dx, dv/dx, du/dy, dv/dy) without 2x2 pixel quads.
 */
export function computeAnalyticalBarycentrics(
  vertices: Float32Array,
  i0: number,
  i1: number,
  i2: number,
  mvp: Float32Array | readonly number[],
  width: number,
  height: number,
  pixelCenterX: number,
  pixelCenterY: number,
): AnalyticalBarycentrics {
  const p0: ProjectedVertex = { cx: 0, cy: 0, cz: 0, cw: 1, sx: 0, sy: 0, ndcZ: 0 };
  const p1: ProjectedVertex = { cx: 0, cy: 0, cz: 0, cw: 1, sx: 0, sy: 0, ndcZ: 0 };
  const p2: ProjectedVertex = { cx: 0, cy: 0, cz: 0, cw: 1, sx: 0, sy: 0, ndcZ: 0 };

  projectVertex(vertices, i0, mvp, width, height, p0);
  projectVertex(vertices, i1, mvp, width, height, p1);
  projectVertex(vertices, i2, mvp, width, height, p2);

  const area2 =
    (p1.sx - p0.sx) * (p2.sy - p0.sy) - (p1.sy - p0.sy) * (p2.sx - p0.sx);
  const invD = Math.abs(area2) > 1e-8 ? 1.0 / area2 : 0.0;

  // Screen-space barycentric coordinates
  const l0 =
    ((p2.sx - p1.sx) * (pixelCenterY - p1.sy) -
      (p2.sy - p1.sy) * (pixelCenterX - p1.sx)) *
    invD;
  const l1 =
    ((p0.sx - p2.sx) * (pixelCenterY - p2.sy) -
      (p0.sy - p2.sy) * (pixelCenterX - p2.sx)) *
    invD;
  const l2 =
    ((p1.sx - p0.sx) * (pixelCenterY - p0.sy) -
      (p1.sy - p0.sy) * (pixelCenterX - p0.sx)) *
    invD;

  // Constant screen-space partial derivatives of barycentrics
  const dl0dx = -(p2.sy - p1.sy) * invD;
  const dl0dy = (p2.sx - p1.sx) * invD;
  const dl1dx = -(p0.sy - p2.sy) * invD;
  const dl1dy = (p0.sx - p2.sx) * invD;
  const dl2dx = -(p1.sy - p0.sy) * invD;
  const dl2dy = (p1.sx - p0.sx) * invD;

  const invW0 = Math.abs(p0.cw) > 1e-8 ? 1.0 / p0.cw : 1.0;
  const invW1 = Math.abs(p1.cw) > 1e-8 ? 1.0 / p1.cw : 1.0;
  const invW2 = Math.abs(p2.cw) > 1e-8 ? 1.0 / p2.cw : 1.0;

  const oneOverW = l0 * invW0 + l1 * invW1 + l2 * invW2;
  const W = Math.abs(oneOverW) > 1e-8 ? 1.0 / oneOverW : 1.0;

  const dOneOverWdx = dl0dx * invW0 + dl1dx * invW1 + dl2dx * invW2;
  const dOneOverWdy = dl0dy * invW0 + dl1dy * invW1 + dl2dy * invW2;

  const b0 = i0 * VISBUF_VERTEX_STRIDE;
  const b1 = i1 * VISBUF_VERTEX_STRIDE;
  const b2 = i2 * VISBUF_VERTEX_STRIDE;

  const u0 = vertices[b0 + 4];
  const v0 = vertices[b0 + 5];
  const u1 = vertices[b1 + 4];
  const v1 = vertices[b1 + 5];
  const u2 = vertices[b2 + 4];
  const v2 = vertices[b2 + 5];

  const uOverW0 = u0 * invW0;
  const uOverW1 = u1 * invW1;
  const uOverW2 = u2 * invW2;
  const vOverW0 = v0 * invW0;
  const vOverW1 = v1 * invW1;
  const vOverW2 = v2 * invW2;

  const u = (l0 * uOverW0 + l1 * uOverW1 + l2 * uOverW2) * W;
  const v = (l0 * vOverW0 + l1 * vOverW1 + l2 * vOverW2) * W;

  const dUOverWdx = dl0dx * uOverW0 + dl1dx * uOverW1 + dl2dx * uOverW2;
  const dUOverWdy = dl0dy * uOverW0 + dl1dy * uOverW1 + dl2dy * uOverW2;
  const dVOverWdx = dl0dx * vOverW0 + dl1dx * vOverW1 + dl2dx * vOverW2;
  const dVOverWdy = dl0dy * vOverW0 + dl1dy * vOverW1 + dl2dy * vOverW2;

  // Quotient rule: d(A/B) = (dA - (A/B)*dB) / B = (dA - attr*dB) * W
  const duDx = (dUOverWdx - u * dOneOverWdx) * W;
  const duDy = (dUOverWdy - u * dOneOverWdy) * W;
  const dvDx = (dVOverWdx - v * dOneOverWdx) * W;
  const dvDy = (dVOverWdy - v * dOneOverWdy) * W;

  // Perspective-correct barycentric weights
  const pw0 = l0 * invW0 * W;
  const pw1 = l1 * invW1 * W;
  const pw2 = l2 * invW2 * W;

  const nxRaw =
    pw0 * vertices[b0 + 6] + pw1 * vertices[b1 + 6] + pw2 * vertices[b2 + 6];
  const nyRaw =
    pw0 * vertices[b0 + 7] + pw1 * vertices[b1 + 7] + pw2 * vertices[b2 + 7];
  const nLenSq2D = nxRaw * nxRaw + nyRaw * nyRaw;
  const nzRaw = nLenSq2D < 1.0 ? Math.sqrt(1.0 - nLenSq2D) : 0.0;
  const invNLen = 1.0 / Math.max(1e-6, Math.sqrt(nLenSq2D + nzRaw * nzRaw));

  return {
    w0: pw0,
    w1: pw1,
    w2: pw2,
    u,
    v,
    duDx,
    dvDx,
    duDy,
    dvDy,
    nx: nxRaw * invNLen,
    ny: nyRaw * invNLen,
    nz: nzRaw * invNLen,
  };
}

const IDENTITY_MAT4 = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

/**
 * Bindless Material Evaluation pass with analytical barycentric ddx/ddy derivatives.
 * Reads packed 64-bit visibility keys, resolves triangle vertices from the arena,
 * computes exact screen-space UV gradients, and shades pixels into outRgba.
 */
export function evaluateBindlessVisibilityPass(
  arena: VisibilityBufferArena,
  materials: readonly BindlessMaterial[] | Record<number, BindlessMaterial>,
  outRgba: Uint8ClampedArray | Float32Array,
  mvpMat4?: Float32Array | readonly number[],
): BindlessEvaluateStats {
  const width = arena.width;
  const height = arena.height;
  const visBuf = arena.visBuf;
  const vertices = arena.vertices;
  const indices = arena.indices;
  const mvp = mvpMat4 ?? arena.lastMvpMat4 ?? IDENTITY_MAT4;
  const isFloatOut = outRgba instanceof Float32Array;

  let shadedPixels = 0;
  let backgroundPixels = 0;
  let gradMagSum = 0;
  const seenInstances = new Set<number>();

  // Fixed directional light vector (normalized)
  const lx = 0.35;
  const ly = 0.65;
  const lz = 0.67453688;

  for (let py = 0; py < height; py++) {
    const rowOffset = py * width;
    const cy = py + 0.5;

    for (let px = 0; px < width; px++) {
      const pixelIdx = rowOffset + px;
      const outBase = pixelIdx * 4;
      const visId = visBuf[pixelIdx];
      const unpacked = unpackVisibilityId(visId);

      if (!unpacked.valid) {
        backgroundPixels++;
        outRgba[outBase] = 0;
        outRgba[outBase + 1] = 0;
        outRgba[outBase + 2] = 0;
        outRgba[outBase + 3] = isFloatOut ? 1.0 : 255;
        continue;
      }

      shadedPixels++;
      seenInstances.add(unpacked.instanceId);

      const triBase = unpacked.triangleId * 3;
      const i0 = indices[triBase];
      const i1 = indices[triBase + 1];
      const i2 = indices[triBase + 2];

      const bary = computeAnalyticalBarycentrics(
        vertices,
        i0,
        i1,
        i2,
        mvp,
        width,
        height,
        px + 0.5,
        cy,
      );

      const gradX = Math.hypot(bary.duDx, bary.dvDx);
      const gradY = Math.hypot(bary.duDy, bary.dvDy);
      const maxGrad = Math.max(gradX, gradY);
      gradMagSum += maxGrad;

      const matLookup = materials as Record<number, BindlessMaterial>;
      const mat = matLookup[unpacked.instanceId];
      let r = mat ? mat.baseColor[0] : 0.8;
      let g = mat ? mat.baseColor[1] : 0.8;
      let b = mat ? mat.baseColor[2] : 0.8;
      const a = mat && mat.baseColor[3] !== undefined ? mat.baseColor[3] : 1.0;

      if (mat?.textureData && mat.texWidth && mat.texHeight) {
        const texW = mat.texWidth;
        const texH = mat.texHeight;
        // Analytical isotropic mip level derived from exact partial derivatives
        const rho = Math.max(
          Math.hypot(bary.duDx * texW, bary.dvDx * texH),
          Math.hypot(bary.duDy * texW, bary.dvDy * texH),
        );
        const mipLevel = Math.max(0, Math.log2(Math.max(1e-6, rho)) + (mat.mipBias ?? 0));
        const uWrapped = ((bary.u % 1) + 1) % 1;
        const vWrapped = ((bary.v % 1) + 1) % 1;
        const tx = Math.min(texW - 1, Math.floor(uWrapped * texW));
        const ty = Math.min(texH - 1, Math.floor(vWrapped * texH));
        const tIdx = (ty * texW + tx) * 4;
        const texScale = mat.textureData instanceof Float32Array ? 1.0 : 1.0 / 255.0;
        const mipAtten = 1.0 / (1.0 + 0.05 * mipLevel);
        r *= mat.textureData[tIdx] * texScale * mipAtten;
        g *= mat.textureData[tIdx + 1] * texScale * mipAtten;
        b *= mat.textureData[tIdx + 2] * texScale * mipAtten;
      }

      const ndotl = Math.max(0.15, bary.nx * lx + bary.ny * ly + bary.nz * lz);
      const roughness = mat?.roughness ?? 0.5;
      const metallic = mat?.metallic ?? 0.0;
      const specTerm = (1.0 - roughness) * (0.2 + 0.4 * metallic) * Math.pow(ndotl, 8.0);

      const finalR = Math.min(1.0, Math.max(0.0, r * ndotl + specTerm));
      const finalG = Math.min(1.0, Math.max(0.0, g * ndotl + specTerm));
      const finalB = Math.min(1.0, Math.max(0.0, b * ndotl + specTerm));

      if (isFloatOut) {
        outRgba[outBase] = finalR;
        outRgba[outBase + 1] = finalG;
        outRgba[outBase + 2] = finalB;
        outRgba[outBase + 3] = a;
      } else {
        outRgba[outBase] = Math.round(finalR * 255);
        outRgba[outBase + 1] = Math.round(finalG * 255);
        outRgba[outBase + 2] = Math.round(finalB * 255);
        outRgba[outBase + 3] = Math.round(Math.min(1.0, Math.max(0.0, a)) * 255);
      }
    }
  }

  return {
    shadedPixels,
    backgroundPixels,
    uniqueInstances: seenInstances.size,
    meanGradMag: shadedPixels > 0 ? gradMagSum / shadedPixels : 0,
  };
}
