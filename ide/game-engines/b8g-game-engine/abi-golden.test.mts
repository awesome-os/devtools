/**
 * @file sections/b8g-game-engine/abi-golden.test.mts
 * @description Compiled C11 ABI golden verification for `b8g_game_engine_abi.h`.
 * Measures actual `sizeof`, `alignof`, `offsetof`, and magic/version constants via `zig cc`
 * (with `cc`/`gcc`/`clang` fallback) and asserts exact match against `abi-golden.json`.
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
  constants: Record<string, string | number>;
  structs: Record<string, StructGolden>;
}

interface ProbeOutput {
  constants: Record<string, string | number>;
  structs: Record<string, StructGolden>;
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

describe('b8g-game-engine ABI golden contract', () => {
  it('matches compiled C11 sizeof, alignof, offsetof, and magic constants against abi-golden.json', () => {
    const goldenPath = path.join(HERE, 'abi-golden.json');
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as AbiGoldenManifest;
    assert.equal(golden.schema, 'holo-abi-golden.v1');
    assert.equal(golden.module, 'b8g-game-engine');

    const localHeaderPath = path.join(HERE, path.basename(golden.header));
    const headerIncludePath = (
      fs.existsSync(localHeaderPath) ? localHeaderPath : path.join(WORKSPACE_ROOT, golden.header)
    ).replace(/\\/g, '/');
    assert.ok(fs.existsSync(headerIncludePath), `Missing header ${headerIncludePath}`);

    const cSource = [
      '#include <stdalign.h>',
      '#include <stddef.h>',
      '#include <stdint.h>',
      '#include <stdio.h>',
      `#include "${headerIncludePath}"`,
      '',
      'int main(void) {',
      '  printf("{\\n");',
      '  printf("  \\"constants\\": {\\n");',
      '  printf("    \\"B8G_GAME_ENGINE_ABI_MAGIC\\": \\"0x%08X\\",\\n", (unsigned)B8G_GAME_ENGINE_ABI_MAGIC);',
      '  printf("    \\"B8G_GAME_ENGINE_ABI_VERSION_V2\\": \\"0x%08X\\",\\n", (unsigned)B8G_GAME_ENGINE_ABI_VERSION_V2);',
      '  printf("    \\"B8G_GAME_ENGINE_ABI_VERSION_V3\\": \\"0x%08X\\",\\n", (unsigned)B8G_GAME_ENGINE_ABI_VERSION_V3);',
      '  printf("    \\"B8G_GAME_SIM_TIER_1_FULL_PHYSICS\\": %u,\\n", (unsigned)B8G_GAME_SIM_TIER_1_FULL_PHYSICS);',
      '  printf("    \\"B8G_GAME_SIM_TIER_2_SIMPLIFIED\\": %u,\\n", (unsigned)B8G_GAME_SIM_TIER_2_SIMPLIFIED);',
      '  printf("    \\"B8G_GAME_SIM_TIER_3_HORIZON_IMPOSTER\\": %u,\\n", (unsigned)B8G_GAME_SIM_TIER_3_HORIZON_IMPOSTER);',
      '  printf("    \\"B8G_GAME_CAP_VELOCITY_PREFETCH\\": %u,\\n", (unsigned)B8G_GAME_CAP_VELOCITY_PREFETCH);',
      '  printf("    \\"B8G_GAME_CAP_ASSET_CLOSURE_GATE\\": %u,\\n", (unsigned)B8G_GAME_CAP_ASSET_CLOSURE_GATE);',
      '  printf("    \\"B8G_GAME_CAP_S3_QUAT_PHYSICS\\": %u,\\n", (unsigned)B8G_GAME_CAP_S3_QUAT_PHYSICS);',
      '  printf("    \\"B8G_GAME_CAP_FOOT_PLACEMENT_IK\\": %u,\\n", (unsigned)B8G_GAME_CAP_FOOT_PLACEMENT_IK);',
      '  printf("    \\"B8G_GAME_CAP_ARENA_V1_O1_PURGE\\": %u\\n", (unsigned)B8G_GAME_CAP_ARENA_V1_O1_PURGE);',
      '  printf("  },\\n");',
      '  printf("  \\"structs\\": {\\n");',
      '  printf("    \\"B8gVec3f64\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"x\\": %zu, \\"y\\": %zu, \\"z\\": %zu}},\\n", sizeof(B8gVec3f64), alignof(B8gVec3f64), offsetof(B8gVec3f64, x), offsetof(B8gVec3f64, y), offsetof(B8gVec3f64, z));',
      '  printf("    \\"B8gQuatf64\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"w\\": %zu, \\"x\\": %zu, \\"y\\": %zu, \\"z\\": %zu}},\\n", sizeof(B8gQuatf64), alignof(B8gQuatf64), offsetof(B8gQuatf64, w), offsetof(B8gQuatf64, x), offsetof(B8gQuatf64, y), offsetof(B8gQuatf64, z));',
      '  printf("    \\"B8gSectorCoordC\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"sx\\": %zu, \\"sy\\": %zu, \\"sz\\": %zu, \\"tier\\": %zu}},\\n", sizeof(B8gSectorCoordC), alignof(B8gSectorCoordC), offsetof(B8gSectorCoordC, sx), offsetof(B8gSectorCoordC, sy), offsetof(B8gSectorCoordC, sz), offsetof(B8gSectorCoordC, tier));',
      '  printf("    \\"B8gEntityState64C\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"entity_id\\": %zu, \\"px\\": %zu, \\"py\\": %zu, \\"pz\\": %zu, \\"vx\\": %zu, \\"vy\\": %zu, \\"vz\\": %zu, \\"flags\\": %zu}},\\n", sizeof(B8gEntityState64C), alignof(B8gEntityState64C), offsetof(B8gEntityState64C, entity_id), offsetof(B8gEntityState64C, px), offsetof(B8gEntityState64C, py), offsetof(B8gEntityState64C, pz), offsetof(B8gEntityState64C, vx), offsetof(B8gEntityState64C, vy), offsetof(B8gEntityState64C, vz), offsetof(B8gEntityState64C, flags));',
      '  printf("    \\"B8gFootContact32C\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"x\\": %zu, \\"y\\": %zu, \\"z\\": %zu, \\"weight\\": %zu}},\\n", sizeof(B8gFootContact32C), alignof(B8gFootContact32C), offsetof(B8gFootContact32C, x), offsetof(B8gFootContact32C, y), offsetof(B8gFootContact32C, z), offsetof(B8gFootContact32C, weight));',
      '  printf("    \\"B8gWorldStreamingDispatchTable\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"update_streaming_bubble\\": %zu, \\"purge_sector_o1\\": %zu, \\"active_sector_count\\": %zu}},\\n", sizeof(B8gWorldStreamingDispatchTable), alignof(B8gWorldStreamingDispatchTable), offsetof(B8gWorldStreamingDispatchTable, update_streaming_bubble), offsetof(B8gWorldStreamingDispatchTable, purge_sector_o1), offsetof(B8gWorldStreamingDispatchTable, active_sector_count));',
      '  printf("    \\"B8gAssetClosureDispatchTable\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"fnv64_bytes\\": %zu, \\"verify_asset_closure\\": %zu, \\"unique_block_count\\": %zu}},\\n", sizeof(B8gAssetClosureDispatchTable), alignof(B8gAssetClosureDispatchTable), offsetof(B8gAssetClosureDispatchTable, fnv64_bytes), offsetof(B8gAssetClosureDispatchTable, verify_asset_closure), offsetof(B8gAssetClosureDispatchTable, unique_block_count));',
      '  printf("    \\"B8gPhysicsDispatchTable\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"step_fixed_s3\\": %zu, \\"sample_terrain_height\\": %zu, \\"solve_foot_placement\\": %zu}},\\n", sizeof(B8gPhysicsDispatchTable), alignof(B8gPhysicsDispatchTable), offsetof(B8gPhysicsDispatchTable, step_fixed_s3), offsetof(B8gPhysicsDispatchTable, sample_terrain_height), offsetof(B8gPhysicsDispatchTable, solve_foot_placement));',
      '  printf("    \\"B8gArenaSlabDispatchTable\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"acquire_slab\\": %zu, \\"wipe_and_release_o1\\": %zu, \\"active_slab_count\\": %zu}},\\n", sizeof(B8gArenaSlabDispatchTable), alignof(B8gArenaSlabDispatchTable), offsetof(B8gArenaSlabDispatchTable, acquire_slab), offsetof(B8gArenaSlabDispatchTable, wipe_and_release_o1), offsetof(B8gArenaSlabDispatchTable, active_slab_count));',
      '  printf("    \\"B8gGameEngineAbiTableV2\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"magic\\": %zu, \\"abi_version\\": %zu, \\"streaming\\": %zu, \\"assets\\": %zu, \\"physics\\": %zu}},\\n", sizeof(B8gGameEngineAbiTableV2), alignof(B8gGameEngineAbiTableV2), offsetof(B8gGameEngineAbiTableV2, magic), offsetof(B8gGameEngineAbiTableV2, abi_version), offsetof(B8gGameEngineAbiTableV2, streaming), offsetof(B8gGameEngineAbiTableV2, assets), offsetof(B8gGameEngineAbiTableV2, physics));',
      '  printf("    \\"B8gGameEngineAbiTable\\": {\\"sizeof\\": %zu, \\"alignof\\": %zu, \\"offsets\\": {\\"v2\\": %zu, \\"struct_size\\": %zu, \\"capability_flags\\": %zu, \\"arena_slab\\": %zu}}\\n", sizeof(B8gGameEngineAbiTable), alignof(B8gGameEngineAbiTable), offsetof(B8gGameEngineAbiTable, v2), offsetof(B8gGameEngineAbiTable, struct_size), offsetof(B8gGameEngineAbiTable, capability_flags), offsetof(B8gGameEngineAbiTable, arena_slab));',
      '  printf("  }\\n");',
      '  printf("}\\n");',
      '  return 0;',
      '}',
      '',
    ].join('\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b8g-game-abi-golden-'));
    try {
      const probeC = path.join(tmpDir, 'probe.c');
      const probeExe = path.join(tmpDir, process.platform === 'win32' ? 'probe.exe' : 'probe');
      fs.writeFileSync(probeC, cSource, 'utf8');

      const compiler = resolveC11Compiler();
      const ccRes = spawnSync(
        compiler.bin,
        [...compiler.prefix, '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', probeC, '-o', probeExe],
        {
          cwd: HERE,
          encoding: 'utf8',
          shell: process.platform === 'win32' && compiler.bin.toLowerCase().endsWith('.cmd'),
        },
      );
      assert.equal(ccRes.status, 0, `${compiler.bin} failed: ${ccRes.stderr || ccRes.stdout}`);

      const runRes = spawnSync(probeExe, [], { encoding: 'utf8' });
      assert.equal(runRes.status, 0, `probe failed: ${runRes.stderr || runRes.stdout}`);

      const measured = JSON.parse(runRes.stdout) as ProbeOutput;
      assert.deepEqual(measured.constants, golden.constants);
      assert.deepEqual(measured.structs, golden.structs);
      assert.equal(Number(measured.constants.B8G_GAME_ENGINE_ABI_MAGIC), 0x45473842);
      assert.equal(measured.structs.B8gGameEngineAbiTable.sizeof, 48);
      assert.equal(measured.structs.B8gGameEngineAbiTable.offsets.v2, 0);
      assert.equal(measured.structs.B8gEntityState64C.sizeof, 64);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
