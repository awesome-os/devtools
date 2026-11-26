/**
 * @file sections/b8g-graphics/abi-golden.test.mts
 * @description Compiled C11 ABI golden & kernel smoke verification for `b8g_graphics_abi.h`
 * and `b8g_graphics_core.c`. Measures actual `sizeof`, `alignof`, `offsetof`, and magic/version
 * constants via `zig cc` (with `cc`/`gcc`/`clang` fallback) and asserts exact match against
 * `abi-golden.json` plus runtime behavior of all 6 C11 hot-path kernels.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

interface StructGolden {
  sizeof: number;
  alignof: number;
  offsets: Record<string, number>;
}

interface AbiGoldenManifest {
  schema: string;
  module: string;
  header: string;
  source: string;
  constants: Record<string, string | number>;
  structs: Record<string, StructGolden>;
}

interface ProbeOutput {
  constants: Record<string, string | number>;
  structs: Record<string, StructGolden>;
  smoke: {
    packedHex: string;
    hzb: number[];
    orcaSameCell: number;
    orcaMaskOk: number;
    restirOk: number;
    restirReject: number;
    neuralBrdfOk: number;
    gaussianVisAlpha: number;
    gaussianOccludedAlpha: number;
  };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(HERE, '../..');

function resolveC11Compiler(): { bin: string; prefix: string[] } {
  const zigCandidates = [
    process.env.ZIG_BIN,
    path.join(WORKSPACE_ROOT, 'bin', process.platform === 'win32' ? 'zig.cmd' : 'zig'),
    process.platform === 'win32' ? 'E:\\awesome-os\\bin\\zig.cmd' : undefined,
    'zig',
  ].filter((v): v is string => Boolean(v));

  for (const candidate of zigCandidates) {
    if (candidate.includes('\\') || candidate.includes('/')) {
      if (fs.existsSync(candidate)) {
        return { bin: candidate, prefix: ['cc'] };
      }
      continue;
    }
    const probe = spawnSync(candidate, ['version'], {
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    if (probe.status === 0) {
      return { bin: candidate, prefix: ['cc'] };
    }
  }

  for (const ccName of ['cc', 'gcc', 'clang']) {
    const probe = spawnSync(ccName, ['--version'], { stdio: 'pipe' });
    if (probe.status === 0) {
      return { bin: ccName, prefix: [] };
    }
  }

  throw new Error('Expected zig cc or system C11 compiler (cc/gcc/clang) to be available');
}

describe('b8g-graphics ABI golden contract', () => {
  it('matches compiled C11 sizeof, alignof, offsetof, constants, and smoke kernels against abi-golden.json', () => {
    const goldenPath = path.join(HERE, 'abi-golden.json');
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as AbiGoldenManifest;
    assert.equal(golden.schema, 'holo-abi-golden.v1');
    assert.equal(golden.module, 'b8g-graphics');

    const localHeaderPath = path.join(HERE, path.basename(golden.header));
    const localSourcePath = path.join(HERE, path.basename(golden.source));
    const headerIncludePath = (
      fs.existsSync(localHeaderPath) ? localHeaderPath : path.join(WORKSPACE_ROOT, golden.header)
    ).replace(/\\/g, '/');
    const coreSourcePath = (
      fs.existsSync(localSourcePath) ? localSourcePath : path.join(WORKSPACE_ROOT, golden.source)
    ).replace(/\\/g, '/');
    assert.ok(fs.existsSync(headerIncludePath), `Missing header ${headerIncludePath}`);
    assert.ok(fs.existsSync(coreSourcePath), `Missing source ${coreSourcePath}`);

    const cSource = [
      '#include <stdalign.h>',
      '#include <stddef.h>',
      '#include <stdint.h>',
      '#include <stdio.h>',
      `#include "${headerIncludePath}"`,
      '',
      'int main(void) {',
      '  B8gGraphicsDispatchTable tbl;',
      '  b8g_graphics_init_dispatch_table(&tbl,',
      '    B8G_GRAPHICS_CAP_VISBUF | B8G_GRAPHICS_CAP_ORCA_GI | B8G_GRAPHICS_CAP_RESTIR |',
      '    B8G_GRAPHICS_CAP_NEURAL_BRDF | B8G_GRAPHICS_CAP_3DGS_HYBRID);',
      '  uint64_t packed = tbl.pack64(0x12345678u, 0x00ABu, 0xCDEFu);',
      '  float src[16] = {',
      '    0.1f, 0.2f, 0.3f, 0.4f,',
      '    0.5f, 0.9f, 0.2f, 0.8f,',
      '    0.4f, 0.3f, 0.7f, 0.1f,',
      '    0.6f, 0.2f, 0.5f, 0.6f',
      '  };',
      '  float dst[4] = {0.0f, 0.0f, 0.0f, 0.0f};',
      '  tbl.hzb_downsample_2x2(src, 4u, 4u, dst);',
      '  uint32_t h1 = tbl.orca_hash_cell(1.25f, 2.5f, -0.75f, 0.0f, 1.0f, 0.0f, 0.5f, 0xFFFu);',
      '  uint32_t h2 = tbl.orca_hash_cell(1.25f, 2.5f, -0.75f, 0.0f, 1.0f, 0.0f, 0.5f, 0xFFFu);',
      '  const float c_pos[3] = {0.0f, 0.0f, 0.0f};',
      '  const float c_norm[3] = {0.0f, 1.0f, 0.0f};',
      '  const float n_pos_ok[3] = {1.0f, 0.01f, 0.5f};',
      '  const float n_norm_ok[3] = {0.0f, 0.99f, 0.14f};',
      '  const float n_pos_far[3] = {0.0f, 2.0f, 0.0f};',
      '  int32_t compat_ok = tbl.restir_neighbor_compatible(c_pos, c_norm, n_pos_ok, n_norm_ok, 0.05f, 0.9f);',
      '  int32_t compat_no = tbl.restir_neighbor_compatible(c_pos, c_norm, n_pos_far, n_norm_ok, 0.05f, 0.9f);',
      '  float weights[93];',
      '  for (size_t i = 0; i < 93; ++i) weights[i] = 0.02f;',
      '  float pbr[5] = {0.0f, 0.0f, 0.0f, 0.0f, 0.0f};',
      '  tbl.neural_brdf_eval(weights, 0.25f, 0.75f, c_norm, pbr);',
      '  int neural_ok = 1;',
      '  for (size_t i = 0; i < 5; ++i) {',
      '    if (pbr[i] <= 0.0f || pbr[i] >= 1.0f) neural_ok = 0;',
      '  }',
      '  float alpha_vis = tbl.eval_tile_gaussian(0.0f, 0.0f, 1.0f, 0.0f, 1.0f, 0.8f, 0.4f, 0.6f);',
      '  float alpha_occ = tbl.eval_tile_gaussian(0.0f, 0.0f, 1.0f, 0.0f, 1.0f, 0.8f, 0.8f, 0.6f);',
      '',
      '  printf("{\\n");',
      '  printf("  \\"constants\\": {\\n");',
      '  printf("    \\"B8G_GRAPHICS_ABI_MAGIC\\": \\"0x%08X\\",\\n", (unsigned)B8G_GRAPHICS_ABI_MAGIC);',
      '  printf("    \\"B8G_GRAPHICS_ABI_VERSION\\": %u,\\n", (unsigned)B8G_GRAPHICS_ABI_VERSION);',
      '  printf("    \\"B8G_ABI_MAGIC_V3\\": \\"0x%08X\\",\\n", (unsigned)B8G_ABI_MAGIC_V3);',
      '  printf("    \\"B8G_GRAPHICS_CAP_VISBUF\\": %u,\\n", (unsigned)B8G_GRAPHICS_CAP_VISBUF);',
      '  printf("    \\"B8G_GRAPHICS_CAP_ORCA_GI\\": %u,\\n", (unsigned)B8G_GRAPHICS_CAP_ORCA_GI);',
      '  printf("    \\"B8G_GRAPHICS_CAP_RESTIR\\": %u,\\n", (unsigned)B8G_GRAPHICS_CAP_RESTIR);',
      '  printf("    \\"B8G_GRAPHICS_CAP_NEURAL_BRDF\\": %u,\\n", (unsigned)B8G_GRAPHICS_CAP_NEURAL_BRDF);',
      '  printf("    \\"B8G_GRAPHICS_CAP_3DGS_HYBRID\\": %u\\n", (unsigned)B8G_GRAPHICS_CAP_3DGS_HYBRID);',
      '  printf("  },\\n");',
      '  printf("  \\"structs\\": {\\n");',
      '  printf("    \\"B8gVisBufHeaderC\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"magic\\": %zu, \\"abi_version\\": %zu, \\"width\\": %zu, \\"height\\": %zu, \\"visbuf_bytes\\": %zu, \\"hzb_levels\\": %zu, \\"tile_size\\": %zu, \\"flags\\": %zu}},\\n",',
      '         sizeof(B8gVisBufHeaderC), alignof(B8gVisBufHeaderC),',
      '         offsetof(B8gVisBufHeaderC, magic), offsetof(B8gVisBufHeaderC, abi_version),',
      '         offsetof(B8gVisBufHeaderC, width), offsetof(B8gVisBufHeaderC, height),',
      '         offsetof(B8gVisBufHeaderC, visbuf_bytes), offsetof(B8gVisBufHeaderC, hzb_levels),',
      '         offsetof(B8gVisBufHeaderC, tile_size), offsetof(B8gVisBufHeaderC, flags));',
      '  printf("    \\"B8gMeshletBoundsC\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"center_radius\\": %zu, \\"aabb_min\\": %zu, \\"aabb_max\\": %zu, \\"tri_offset\\": %zu, \\"tri_count\\": %zu, \\"instance_id\\": %zu, \\"material_id\\": %zu}},\\n",',
      '         sizeof(B8gMeshletBoundsC), alignof(B8gMeshletBoundsC),',
      '         offsetof(B8gMeshletBoundsC, center_radius), offsetof(B8gMeshletBoundsC, aabb_min),',
      '         offsetof(B8gMeshletBoundsC, aabb_max), offsetof(B8gMeshletBoundsC, tri_offset),',
      '         offsetof(B8gMeshletBoundsC, tri_count), offsetof(B8gMeshletBoundsC, instance_id),',
      '         offsetof(B8gMeshletBoundsC, material_id));',
      '  printf("    \\"B8gOrcaCellC\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"radiance_sum\\": %zu, \\"sample_count\\": %zu, \\"frame_epoch\\": %zu, \\"cell_hash\\": %zu, \\"pad\\": %zu}},\\n",',
      '         sizeof(B8gOrcaCellC), alignof(B8gOrcaCellC),',
      '         offsetof(B8gOrcaCellC, radiance_sum), offsetof(B8gOrcaCellC, sample_count),',
      '         offsetof(B8gOrcaCellC, frame_epoch), offsetof(B8gOrcaCellC, cell_hash),',
      '         offsetof(B8gOrcaCellC, pad));',
      '  printf("    \\"B8gReservoirLayerC\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"sample_pos\\": %zu, \\"weight_sum\\": %zu, \\"radiance\\": %zu, \\"depth\\": %zu, \\"normal\\": %zu, \\"m_count\\": %zu}},\\n",',
      '         sizeof(B8gReservoirLayerC), alignof(B8gReservoirLayerC),',
      '         offsetof(B8gReservoirLayerC, sample_pos), offsetof(B8gReservoirLayerC, weight_sum),',
      '         offsetof(B8gReservoirLayerC, radiance), offsetof(B8gReservoirLayerC, depth),',
      '         offsetof(B8gReservoirLayerC, normal), offsetof(B8gReservoirLayerC, m_count));',
      '  printf("    \\"B8gGaussianSplatC\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"pos\\": %zu, \\"scale\\": %zu, \\"quat\\": %zu, \\"color_opacity\\": %zu}},\\n",',
      '         sizeof(B8gGaussianSplatC), alignof(B8gGaussianSplatC),',
      '         offsetof(B8gGaussianSplatC, pos), offsetof(B8gGaussianSplatC, scale),',
      '         offsetof(B8gGaussianSplatC, quat), offsetof(B8gGaussianSplatC, color_opacity));',
      '  printf("    \\"B8gGraphicsDispatchTable\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"magic\\": %zu, \\"abi_version\\": %zu, \\"struct_size\\": %zu, \\"caps\\": %zu, \\"pack64\\": %zu, \\"hzb_downsample_2x2\\": %zu, \\"orca_hash_cell\\": %zu, \\"restir_neighbor_compatible\\": %zu, \\"neural_brdf_eval\\": %zu, \\"eval_tile_gaussian\\": %zu}}\\n",',
      '         sizeof(B8gGraphicsDispatchTable), alignof(B8gGraphicsDispatchTable),',
      '         offsetof(B8gGraphicsDispatchTable, magic), offsetof(B8gGraphicsDispatchTable, abi_version),',
      '         offsetof(B8gGraphicsDispatchTable, struct_size), offsetof(B8gGraphicsDispatchTable, caps),',
      '         offsetof(B8gGraphicsDispatchTable, pack64), offsetof(B8gGraphicsDispatchTable, hzb_downsample_2x2),',
      '         offsetof(B8gGraphicsDispatchTable, orca_hash_cell), offsetof(B8gGraphicsDispatchTable, restir_neighbor_compatible),',
      '         offsetof(B8gGraphicsDispatchTable, neural_brdf_eval), offsetof(B8gGraphicsDispatchTable, eval_tile_gaussian));',
      '  printf("  },\\n");',
      '  printf("  \\"smoke\\": {\\n");',
      '  printf("    \\"packedHex\\": \\"0x%016llX\\",\\n", (unsigned long long)packed);',
      '  printf("    \\"hzb\\": [%.2f, %.2f, %.2f, %.2f],\\n", (double)dst[0], (double)dst[1], (double)dst[2], (double)dst[3]);',
      '  printf("    \\"orcaSameCell\\": %d,\\n", (h1 == h2) ? 1 : 0);',
      '  printf("    \\"orcaMaskOk\\": %d,\\n", (h1 <= 0xFFFu) ? 1 : 0);',
      '  printf("    \\"restirOk\\": %d,\\n", (int)compat_ok);',
      '  printf("    \\"restirReject\\": %d,\\n", (int)compat_no);',
      '  printf("    \\"neuralBrdfOk\\": %d,\\n", neural_ok);',
      '  printf("    \\"gaussianVisAlpha\\": %.4f,\\n", (double)alpha_vis);',
      '  printf("    \\"gaussianOccludedAlpha\\": %.4f\\n", (double)alpha_occ);',
      '  printf("  }\\n");',
      '  printf("}\\n");',
      '  return 0;',
      '}',
      '',
    ].join('\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-graphics-abi-golden-'));
    try {
      const probeC = path.join(tmpDir, 'probe.c');
      const probeExe = path.join(tmpDir, process.platform === 'win32' ? 'probe.exe' : 'probe');
      fs.writeFileSync(probeC, cSource, 'utf8');

      const compiler = resolveC11Compiler();
      const extraLibs = process.platform === 'win32' ? [] : ['-lm'];
      const ccRes = spawnSync(
        compiler.bin,
        [
          ...compiler.prefix,
          '-std=c11',
          '-O3',
          '-Wall',
          '-Wextra',
          '-Werror',
          probeC,
          coreSourcePath,
          ...extraLibs,
          '-o',
          probeExe,
        ],
        {
          cwd: HERE,
          encoding: 'utf8',
          shell: process.platform === 'win32' && compiler.bin.toLowerCase().endsWith('.cmd'),
        },
      );
      assert.equal(ccRes.status, 0, `${compiler.bin} failed: ${ccRes.stderr || ccRes.stdout}`);
      assert.equal((ccRes.stderr ?? '').trim(), '', `Expected 0 compiler warnings, got: ${ccRes.stderr}`);

      const runRes = spawnSync(probeExe, [], { encoding: 'utf8' });
      assert.equal(runRes.status, 0, `probe failed: ${runRes.stderr || runRes.stdout}`);

      const measured = JSON.parse(runRes.stdout) as ProbeOutput;
      assert.deepEqual(measured.constants, golden.constants);
      assert.deepEqual(measured.structs, golden.structs);
      assert.equal(Number(measured.constants.B8G_GRAPHICS_ABI_MAGIC), 0x58464742);
      assert.equal(Number(measured.constants.B8G_ABI_MAGIC_V3), 0x33564742);
      assert.equal(measured.structs.B8gVisBufHeaderC.sizeof, 32);
      assert.equal(measured.structs.B8gMeshletBoundsC.sizeof, 64);
      assert.equal(measured.structs.B8gOrcaCellC.sizeof, 32);
      assert.equal(measured.structs.B8gReservoirLayerC.sizeof, 48);
      assert.equal(measured.structs.B8gGaussianSplatC.sizeof, 64);
      assert.equal(measured.structs.B8gGraphicsDispatchTable.sizeof, 64);

      assert.equal(measured.smoke.packedHex, '0x1234567800ABCDEF');
      assert.deepEqual(measured.smoke.hzb, [0.9, 0.8, 0.6, 0.7]);
      assert.equal(measured.smoke.orcaSameCell, 1);
      assert.equal(measured.smoke.orcaMaskOk, 1);
      assert.equal(measured.smoke.restirOk, 1);
      assert.equal(measured.smoke.restirReject, 0);
      assert.equal(measured.smoke.neuralBrdfOk, 1);
      assert.equal(measured.smoke.gaussianVisAlpha, 0.8);
      assert.equal(measured.smoke.gaussianOccludedAlpha, 0.0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
