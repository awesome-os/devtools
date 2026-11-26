/**
 * @file three-compat.mts
 * @description Thin, zero-copy Three.js-compatible Scene & Renderer API
 * driving the B8G Next-Gen Graphics Engine (`VisibilityBufferArena`,
 * Two-Pass HZB Culling, ORCA + Multi-Layer ReSTIR, Compact Neural BRDF MLP,
 * and Tile-Based 3DGS Hybrid Depth Compositing).
 *
 * Strictly `erasableSyntaxOnly: true`, zero external or `node:*` imports.
 */

import {
  CompactNeuralBrdfMlp,
  TileBased3dgsRenderer,
  createDefaultNeuralMaterial,
  evaluateNeuralBrdf,
  type Composite3dgsStats,
} from './neural-material-3dgs.mts';
import {
  MultiLayerReservoirBuffer,
  OrcaStatelessRadianceCache,
} from './orca-restir-gi.mts';
import {
  VISBUF_CLEAR_VALUE,
  VISBUF_VERTEX_STRIDE,
  VisibilityBufferArena,
  buildHzbPyramid,
  cullMeshletsTwoPassHzb,
  evaluateBindlessVisibilityPass,
  rasterizeMicropolygons64,
  type BindlessEvaluateStats,
  type BindlessMaterial,
  type HzbPyramid,
  type Meshlet,
  type RasterizeStats,
  type TwoPassHzbResult,
} from './visibility-rasterizer.mts';

export class Vector3 {
  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }

  sub(other: Vector3): this {
    this.x -= other.x;
    this.y -= other.y;
    this.z -= other.z;
    return this;
  }

  normalize(): this {
    const len = Math.hypot(this.x, this.y, this.z);
    if (len > 1e-8) {
      this.x /= len;
      this.y /= len;
      this.z /= len;
    }
    return this;
  }
}

export class Matrix4 {
  elements: Float32Array;

  constructor(elements?: ArrayLike<number>) {
    this.elements = new Float32Array(16);
    if (elements && elements.length >= 16) {
      for (let i = 0; i < 16; i++) this.elements[i] = Number(elements[i]);
    } else {
      this.identity();
    }
  }

  identity(): this {
    const e = this.elements;
    e.fill(0);
    e[0] = 1;
    e[5] = 1;
    e[10] = 1;
    e[15] = 1;
    return this;
  }

  multiplyMatrices(a: Matrix4, b: Matrix4): this {
    const ae = a.elements;
    const be = b.elements;
    const out = this.elements;
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        out[col * 4 + row] =
          ae[row] * be[col * 4] +
          ae[4 + row] * be[col * 4 + 1] +
          ae[8 + row] * be[col * 4 + 2] +
          ae[12 + row] * be[col * 4 + 3];
      }
    }
    return this;
  }

  makePerspective(fovDeg: number, aspect: number, near: number, far: number): this {
    const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
    const nf = 1 / (near - far);
    const e = this.elements;
    e.fill(0);
    e[0] = f / Math.max(1e-4, aspect);
    e[5] = f;
    e[10] = far * nf;
    e[11] = -1;
    e[14] = near * far * nf;
    return this;
  }

  lookAt(eye: Vector3, target: Vector3, up: Vector3): this {
    const zx = eye.x - target.x;
    const zy = eye.y - target.y;
    const zz = eye.z - target.z;
    const zLen = Math.hypot(zx, zy, zz) || 1;
    const fx = zx / zLen;
    const fy = zy / zLen;
    const fz = zz / zLen;

    let sx = up.y * fz - up.z * fy;
    let sy = up.z * fx - up.x * fz;
    let sz = up.x * fy - up.y * fx;
    const sLen = Math.hypot(sx, sy, sz) || 1;
    sx /= sLen;
    sy /= sLen;
    sz /= sLen;

    const ux = fy * sz - fz * sy;
    const uy = fz * sx - fx * sz;
    const uz = fx * sy - fy * sx;

    const e = this.elements;
    e[0] = sx;
    e[1] = ux;
    e[2] = fx;
    e[3] = 0;
    e[4] = sy;
    e[5] = uy;
    e[6] = fy;
    e[7] = 0;
    e[8] = sz;
    e[9] = uz;
    e[10] = fz;
    e[11] = 0;
    e[12] = -(sx * eye.x + sy * eye.y + sz * eye.z);
    e[13] = -(ux * eye.x + uy * eye.y + uz * eye.z);
    e[14] = -(fx * eye.x + fy * eye.y + fz * eye.z);
    e[15] = 1;
    return this;
  }
}

export class PerspectiveCamera {
  fov: number;
  aspect: number;
  near: number;
  far: number;
  position: Vector3;
  target: Vector3;
  up: Vector3;

  constructor(fov = 55, aspect = 16 / 9, near = 0.1, far = 200) {
    this.fov = fov;
    this.aspect = aspect;
    this.near = near;
    this.far = far;
    this.position = new Vector3(0, 1.5, 4);
    this.target = new Vector3(0, 0, 0);
    this.up = new Vector3(0, 1, 0);
  }

  lookAt(x: number, y: number, z: number): this {
    this.target.set(x, y, z);
    return this;
  }

  getViewProjectionMatrix(): Matrix4 {
    const view = new Matrix4().lookAt(this.position, this.target, this.up);
    const proj = new Matrix4().makePerspective(this.fov, this.aspect, this.near, this.far);
    return new Matrix4().multiplyMatrices(proj, view);
  }
}

export class BufferGeometry {
  /** Interleaved stride-8: `(x, y, z, w, u, v, nx, ny)` mapped directly to VisibilityBufferArena. */
  readonly attributes: Float32Array;
  readonly indices: Uint32Array;
  readonly boundsCenter: readonly [number, number, number];
  readonly boundsRadius: number;

  constructor(attributes: Float32Array, indices: Uint32Array) {
    if (attributes.length % VISBUF_VERTEX_STRIDE !== 0) {
      throw new RangeError(`Expected vertex stride ${VISBUF_VERTEX_STRIDE}`);
    }
    if (indices.length % 3 !== 0) {
      throw new RangeError('Triangle indices length must be a multiple of 3');
    }
    this.attributes = attributes;
    this.indices = indices;

    const vCount = attributes.length / VISBUF_VERTEX_STRIDE;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < vCount; i++) {
      const b = i * VISBUF_VERTEX_STRIDE;
      cx += attributes[b];
      cy += attributes[b + 1];
      cz += attributes[b + 2];
    }
    const inv = vCount > 0 ? 1 / vCount : 1;
    cx *= inv;
    cy *= inv;
    cz *= inv;
    let maxDistSq = 0;
    for (let i = 0; i < vCount; i++) {
      const b = i * VISBUF_VERTEX_STRIDE;
      const dx = attributes[b] - cx;
      const dy = attributes[b + 1] - cy;
      const dz = attributes[b + 2] - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > maxDistSq) maxDistSq = d;
    }
    this.boundsCenter = [cx, cy, cz];
    this.boundsRadius = Math.max(0.01, Math.sqrt(maxDistSq));
  }
}

export class BoxGeometry extends BufferGeometry {
  constructor(width = 1, height = 1, depth = 1) {
    const hx = width * 0.5;
    const hy = height * 0.5;
    const hz = depth * 0.5;

    // 24 face vertices (pos xyz1, uv, nx, ny)
    const verts = new Float32Array([
      // Front (+Z)
      -hx, -hy, hz, 1, 0, 0, 0, 0,
      hx, -hy, hz, 1, 1, 0, 0, 0,
      hx, hy, hz, 1, 1, 1, 0, 0,
      -hx, hy, hz, 1, 0, 1, 0, 0,
      // Back (-Z)
      hx, -hy, -hz, 1, 0, 0, 0, 0,
      -hx, -hy, -hz, 1, 1, 0, 0, 0,
      -hx, hy, -hz, 1, 1, 1, 0, 0,
      hx, hy, -hz, 1, 0, 1, 0, 0,
      // Top (+Y)
      -hx, hy, hz, 1, 0, 0, 0, 1,
      hx, hy, hz, 1, 1, 0, 0, 1,
      hx, hy, -hz, 1, 1, 1, 0, 1,
      -hx, hy, -hz, 1, 0, 1, 0, 1,
      // Bottom (-Y)
      -hx, -hy, -hz, 1, 0, 0, 0, -1,
      hx, -hy, -hz, 1, 1, 0, 0, -1,
      hx, -hy, hz, 1, 1, 1, 0, -1,
      -hx, -hy, hz, 1, 0, 1, 0, -1,
      // Right (+X)
      hx, -hy, hz, 1, 0, 0, 1, 0,
      hx, -hy, -hz, 1, 1, 0, 1, 0,
      hx, hy, -hz, 1, 1, 1, 1, 0,
      hx, hy, hz, 1, 0, 1, 1, 0,
      // Left (-X)
      -hx, -hy, -hz, 1, 0, 0, -1, 0,
      -hx, -hy, hz, 1, 1, 0, -1, 0,
      -hx, hy, hz, 1, 1, 1, -1, 0,
      -hx, hy, -hz, 1, 0, 1, -1, 0,
    ]);
    const idx = new Uint32Array([
      0, 1, 2, 0, 2, 3,
      4, 5, 6, 4, 6, 7,
      8, 9, 10, 8, 10, 11,
      12, 13, 14, 12, 14, 15,
      16, 17, 18, 16, 18, 19,
      20, 21, 22, 20, 22, 23,
    ]);
    super(verts, idx);
  }
}

export class PBRMaterial {
  color: readonly [number, number, number];
  roughness: number;
  metallic: number;
  emissive: readonly [number, number, number];

  constructor(opts: {
    color?: readonly [number, number, number];
    roughness?: number;
    metallic?: number;
    emissive?: readonly [number, number, number];
  } = {}) {
    this.color = opts.color ?? [0.78, 0.82, 0.88];
    this.roughness = opts.roughness ?? 0.45;
    this.metallic = opts.metallic ?? 0.1;
    this.emissive = opts.emissive ?? [0, 0, 0];
  }
}

export class NeuralMaterial extends PBRMaterial {
  readonly mlp: CompactNeuralBrdfMlp;

  constructor(seed = 2026, mlp?: CompactNeuralBrdfMlp) {
    const activeMlp = mlp ?? createDefaultNeuralMaterial(seed);
    const sample = evaluateNeuralBrdf(activeMlp, 0.5, 0.5, [0, 0, 1], [0, 0, 1]);
    super({
      color: [sample.albedoR, sample.albedoG, sample.albedoB],
      roughness: sample.roughness,
      metallic: sample.metallic,
    });
    this.mlp = activeMlp;
  }
}

export class Mesh {
  readonly geometry: BufferGeometry;
  readonly material: PBRMaterial;
  readonly position: Vector3;

  constructor(geometry: BufferGeometry, material: PBRMaterial) {
    this.geometry = geometry;
    this.material = material;
    this.position = new Vector3(0, 0, 0);
  }
}

export class GaussianSplatMesh {
  readonly splats: Float32Array;
  readonly count: number;

  constructor(rendererOrSplats: TileBased3dgsRenderer | Float32Array) {
    if (rendererOrSplats instanceof TileBased3dgsRenderer) {
      this.splats = rendererOrSplats.splats;
      this.count = rendererOrSplats.count;
    } else {
      this.splats = rendererOrSplats;
      this.count = Math.floor(rendererOrSplats.length / 14);
    }
  }
}

export class Scene {
  readonly meshes: Mesh[];
  readonly splatMeshes: GaussianSplatMesh[];
  background: readonly [number, number, number];

  constructor() {
    this.meshes = [];
    this.splatMeshes = [];
    this.background = [0.04, 0.06, 0.1];
  }

  add(node: Mesh | GaussianSplatMesh): this {
    if (node instanceof GaussianSplatMesh) {
      this.splatMeshes.push(node);
    } else {
      this.meshes.push(node);
    }
    return this;
  }
}

export interface HybridRenderStats {
  readonly width: number;
  readonly height: number;
  readonly meshCount: number;
  readonly hzbCull: TwoPassHzbResult;
  readonly rasterStats: RasterizeStats;
  readonly bindlessStats: BindlessEvaluateStats;
  readonly orcaSeededCells: number;
  readonly gsStats: Composite3dgsStats;
  readonly frameIndex: number;
}

export interface BmpHybridRenderResult {
  readonly bmpBytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly stats: HybridRenderStats;
}

export function encodeRgbaToBmp24(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const headerBytes = 54;
  const out = new Uint8Array(headerBytes + pixelBytes);
  const view = new DataView(out.buffer);

  // BITMAPFILEHEADER (14 bytes)
  out[0] = 0x42; // 'B'
  out[1] = 0x4d; // 'M'
  view.setUint32(2, headerBytes + pixelBytes, true);
  view.setUint32(10, headerBytes, true);

  // BITMAPINFOHEADER (40 bytes)
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);

  for (let y = 0; y < height; y++) {
    // BMP rows are bottom-up
    const srcRow = (height - 1 - y) * width * 4;
    const dstRow = headerBytes + y * rowStride;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 3;
      out[d] = rgba[s + 2];
      out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s];
    }
  }
  return out;
}

/**
 * Thin Three.js-compatible WebGPU-oriented hybrid renderer executing directly over
 * `VisibilityBufferArena` + ORCA/ReSTIR + Neural BRDF + Tiled 3DGS.
 */
export class B8gWebGPURenderer {
  readonly width: number;
  readonly height: number;
  readonly arena: VisibilityBufferArena;
  readonly orca: OrcaStatelessRadianceCache;
  readonly reservoirs: MultiLayerReservoirBuffer;
  readonly framebufferRgba: Uint8ClampedArray;
  private prevHzb: HzbPyramid;
  private frameIndex: number;

  constructor(width = 128, height = 96, maxVertices = 65536, maxTriangles = 65536) {
    this.width = width;
    this.height = height;
    this.arena = new VisibilityBufferArena(width, height, maxVertices, maxTriangles);
    this.orca = new OrcaStatelessRadianceCache(4096, 0.25);
    this.reservoirs = new MultiLayerReservoirBuffer(width, height, 2);
    this.framebufferRgba = new Uint8ClampedArray(width * height * 4);
    this.prevHzb = buildHzbPyramid(new Float32Array(width * height).fill(1.0), width, height);
    this.frameIndex = 0;
  }

  render(scene: Scene, camera: PerspectiveCamera): HybridRenderStats {
    this.frameIndex++;
    this.arena.clear();
    this.orca.resetFrame();

    // Fill background color first
    const bgR = Math.round(scene.background[0] * 255);
    const bgG = Math.round(scene.background[1] * 255);
    const bgB = Math.round(scene.background[2] * 255);

    const viewProj = camera.getViewProjectionMatrix().elements;
    const meshlets: Meshlet[] = [];
    const materials: BindlessMaterial[] = [];

    let vCursor = 0;
    let tCursor = 0;
    let orcaSeededCells = 0;

    for (let mIdx = 0; mIdx < scene.meshes.length; mIdx++) {
      const mesh = scene.meshes[mIdx];
      const geom = mesh.geometry;
      const vCount = geom.attributes.length / VISBUF_VERTEX_STRIDE;
      const tCount = geom.indices.length / 3;

      for (let v = 0; v < vCount; v++) {
        const srcBase = v * VISBUF_VERTEX_STRIDE;
        const dstBase = (vCursor + v) * VISBUF_VERTEX_STRIDE;
        this.arena.vertices[dstBase] = geom.attributes[srcBase] + mesh.position.x;
        this.arena.vertices[dstBase + 1] = geom.attributes[srcBase + 1] + mesh.position.y;
        this.arena.vertices[dstBase + 2] = geom.attributes[srcBase + 2] + mesh.position.z;
        this.arena.vertices[dstBase + 3] = geom.attributes[srcBase + 3];
        this.arena.vertices[dstBase + 4] = geom.attributes[srcBase + 4];
        this.arena.vertices[dstBase + 5] = geom.attributes[srcBase + 5];
        this.arena.vertices[dstBase + 6] = geom.attributes[srcBase + 6];
        this.arena.vertices[dstBase + 7] = geom.attributes[srcBase + 7];
      }

      for (let i = 0; i < geom.indices.length; i++) {
        this.arena.indices[tCursor * 3 + i] = vCursor + geom.indices[i];
      }

      meshlets.push({
        instanceId: mIdx,
        indexOffset: tCursor * 3,
        triangleCount: tCount,
        vertexOffset: vCursor,
        triangleOffset: tCursor,
        boundsCenter: [
          geom.boundsCenter[0] + mesh.position.x,
          geom.boundsCenter[1] + mesh.position.y,
          geom.boundsCenter[2] + mesh.position.z,
        ],
        boundsRadius: geom.boundsRadius,
      });

      materials[mIdx] = {
        baseColor: mesh.material.color,
        roughness: mesh.material.roughness,
        metallic: mesh.material.metallic,
      };

      const worldPos: [number, number, number] = [
        geom.boundsCenter[0] + mesh.position.x,
        geom.boundsCenter[1] + mesh.position.y,
        geom.boundsCenter[2] + mesh.position.z,
      ];
      if (this.orca.insertRadianceSample(worldPos, [0, 1, 0], mesh.material.color)) {
        orcaSeededCells++;
      }

      vCursor += vCount;
      tCursor += tCount;
    }

    const hzbCull = cullMeshletsTwoPassHzb(meshlets, this.prevHzb, viewProj);
    const activeMeshlets = [...hzbCull.pass1Visible, ...hzbCull.pass2Disoccluded];
    const rasterStats = rasterizeMicropolygons64(
      this.arena,
      activeMeshlets.length > 0 ? activeMeshlets : meshlets,
      viewProj,
    );

    const bindlessStats = evaluateBindlessVisibilityPass(
      this.arena,
      materials,
      this.framebufferRgba,
      viewProj,
    );

    // Paint clean background over empty visbuf pixels + resolve depthBuf for 3DGS test
    for (let i = 0; i < this.arena.pixelCount; i++) {
      const vis = this.arena.visBuf[i];
      if (vis === VISBUF_CLEAR_VALUE) {
        const b = i * 4;
        this.framebufferRgba[b] = bgR;
        this.framebufferRgba[b + 1] = bgG;
        this.framebufferRgba[b + 2] = bgB;
        this.framebufferRgba[b + 3] = 255;
        this.arena.depthBuf[i] = 1.0;
      } else {
        const depthU32 = Number((vis >> 32n) & 0xffffffffn) >>> 0;
        this.arena.depthBuf[i] = depthU32 / 0xffffffff;
      }
    }

    // Apply Neural BRDF tint modulation for NeuralMaterial instances
    for (let i = 0; i < this.arena.pixelCount; i++) {
      const vis = this.arena.visBuf[i];
      if (vis === VISBUF_CLEAR_VALUE) continue;
      const instId = (Number(vis & 0xffffffffn) >>> 16) & 0xffff;
      const mat = scene.meshes[instId]?.material;
      if (mat instanceof NeuralMaterial) {
        const u = ((i % this.width) + 0.5) / this.width;
        const v = (Math.floor(i / this.width) + 0.5) / this.height;
        const pbr = evaluateNeuralBrdf(mat.mlp, u, v, [0, 0, 1], [0, 0, 1]);
        const b = i * 4;
        this.framebufferRgba[b] = Math.round(
          Math.min(255, this.framebufferRgba[b] * 0.65 + pbr.albedoR * 255 * 0.35),
        );
        this.framebufferRgba[b + 1] = Math.round(
          Math.min(255, this.framebufferRgba[b + 1] * 0.65 + pbr.albedoG * 255 * 0.35),
        );
        this.framebufferRgba[b + 2] = Math.round(
          Math.min(255, this.framebufferRgba[b + 2] * 0.65 + pbr.albedoB * 255 * 0.35),
        );
      }
    }

    // Composite Tile-Based 3DGS splats against Visibility Buffer depth
    let gsStats: Composite3dgsStats = {
      pixelsShaded: 0,
      splatEvaluations: 0,
      earlyDepthTerminations: 0,
      transmittanceTerminations: 0,
    };
    if (scene.splatMeshes.length > 0) {
      let totalFloats = 0;
      for (const sm of scene.splatMeshes) totalFloats += sm.splats.length;
      const combined = new Float32Array(totalFloats);
      let off = 0;
      for (const sm of scene.splatMeshes) {
        combined.set(sm.splats, off);
        off += sm.splats.length;
      }
      const gs = new TileBased3dgsRenderer(combined);
      const binned = gs.projectAndBinGaussians(viewProj, this.width, this.height, 16);
      gsStats = gs.composite3dgsHybrid(
        binned,
        this.width,
        this.height,
        this.arena.depthBuf,
        this.framebufferRgba,
      );
    }

    this.prevHzb = buildHzbPyramid(this.arena.depthBuf, this.width, this.height);

    return {
      width: this.width,
      height: this.height,
      meshCount: scene.meshes.length,
      hzbCull,
      rasterStats,
      bindlessStats,
      orcaSeededCells,
      gsStats,
      frameIndex: this.frameIndex,
    };
  }

  renderToBmp(scene: Scene, camera: PerspectiveCamera): BmpHybridRenderResult {
    const stats = this.render(scene, camera);
    const bmpBytes = encodeRgbaToBmp24(this.framebufferRgba, this.width, this.height);
    return {
      bmpBytes,
      width: this.width,
      height: this.height,
      stats,
    };
  }
}
