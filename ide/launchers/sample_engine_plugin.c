/**
 * @file ide/launchers/sample_engine_plugin.c
 * @brief Companion shared library (.dll / .so / .dylib) dynamically loaded by `dynamic_loader.c`.
 */

#include "dynamic_loader.h"

#include <stdio.h>
#include <string.h>

#if defined(_WIN32)
  #define B8G_EXPORT __declspec(dllexport)
#else
  #define B8G_EXPORT __attribute__((visibility("default")))
#endif

B8G_EXPORT int b8g_engine_entry_v3(
  const B8gEngineHostCtxV3* ctx,
  B8gEngineEntryResultV3* out_result
) {
  if (!ctx || !out_result) return -1;
  if (ctx->magic != B8G_ABI_MAGIC_V3) return -2;
  if (ctx->abi_version != B8G_ABI_VERSION_V3) return -3;
  if (ctx->struct_size < sizeof(B8gEngineHostCtxV3)) return -4;
  if (!ctx->brand_id || !ctx->cas_sha512) return -5;

  memset(out_result, 0, sizeof(*out_result));
  out_result->magic = B8G_ABI_MAGIC_V3;
  out_result->status_code = 0u;
  out_result->caps_flags = ctx->reserved_flags;
  out_result->loaded_ok = 1u;
  snprintf(out_result->engine_name, sizeof(out_result->engine_name), "b8g-dynamic-%s", ctx->brand_id);
  snprintf(out_result->echoed_sha512_prefix, sizeof(out_result->echoed_sha512_prefix), "%.16s", ctx->cas_sha512);
  return 0;
}
