/**
 * @file ide/launchers/dynamic_loader.h
 * @brief Native C11 dynamic loader verifying B8G_ABI_MAGIC_V3 (0x33564742),
 *        updating 24-bit BMP Holo v11 splashscreen, and invoking `b8g_engine_entry_v3`.
 */

#ifndef B8G_DYNAMIC_LOADER_H
#define B8G_DYNAMIC_LOADER_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define B8G_ABI_MAGIC_V3 0x33564742u
#define B8G_ABI_VERSION_V3 3u

typedef struct B8gEngineHostCtxV3 {
  uint32_t magic;
  uint32_t abi_version;
  uint32_t struct_size;
  uint32_t reserved_flags;
  const char* brand_id;
  const char* cas_sha512;
  const char* splash_bmp_path;
  uint64_t arena_bytes;
} B8gEngineHostCtxV3;

typedef struct B8gEngineEntryResultV3 {
  uint32_t magic;
  uint32_t status_code;
  uint32_t caps_flags;
  uint32_t loaded_ok;
  char engine_name[64];
  char echoed_sha512_prefix[17];
} B8gEngineEntryResultV3;

typedef int (*B8gEngineEntryV3Fn)(
  const B8gEngineHostCtxV3* ctx,
  B8gEngineEntryResultV3* out_result
);

/**
 * Renders 24-bit BMP splashscreen progress bars (25% -> 70% -> 100%),
 * dynamically loads `shared_lib_path` (.dll on Windows, .so/.dylib on POSIX),
 * resolves `b8g_engine_entry_v3`, verifies B8G_ABI_MAGIC_V3 handshake, and closes.
 * Returns 0 on success, negative error code on failure.
 */
int b8g_dynamic_launch_v3(
  const char* shared_lib_path,
  const char* brand_id,
  const char* cas_sha512,
  const char* splash_bmp_path,
  B8gEngineEntryResultV3* out_result
);

#ifdef __cplusplus
}
#endif

#endif /* B8G_DYNAMIC_LOADER_H */
