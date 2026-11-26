/**
 * @file ide/launchers/dynamic_loader.c
 * @brief Cross-platform C11 dynamic loader (LoadLibraryA / dlopen) + 24-bit BMP Holo v11 splash.
 */

#include "dynamic_loader.h"
#include "splash_blitter.h"

#include <stdio.h>
#include <string.h>

#if defined(_WIN32)
  #define WIN32_LEAN_AND_MEAN
  #include <windows.h>
#else
  #include <dlfcn.h>
#endif

int b8g_dynamic_launch_v3(
  const char* shared_lib_path,
  const char* brand_id,
  const char* cas_sha512,
  const char* splash_bmp_path,
  B8gEngineEntryResultV3* out_result
) {
  if (!shared_lib_path || !brand_id || !cas_sha512 || !splash_bmp_path || !out_result) {
    return -1;
  }

  memset(out_result, 0, sizeof(*out_result));

  if (b8g_splash_render_bmp24(splash_bmp_path, brand_id, 480u, 180u, 25u, cas_sha512) != 0) {
    return -2;
  }

#if defined(_WIN32)
  HMODULE mod = LoadLibraryA(shared_lib_path);
  if (!mod) {
    fprintf(stderr, "LoadLibraryA failed for %s (err=%lu)\n", shared_lib_path, (unsigned long)GetLastError());
    return -3;
  }
  FARPROC raw_sym = GetProcAddress(mod, "b8g_engine_entry_v3");
  if (!raw_sym) {
    FreeLibrary(mod);
    return -4;
  }
  B8gEngineEntryV3Fn entry_fn = (B8gEngineEntryV3Fn)(uintptr_t)raw_sym;
#else
  void* mod = dlopen(shared_lib_path, RTLD_NOW | RTLD_LOCAL);
  if (!mod) {
    fprintf(stderr, "dlopen failed for %s: %s\n", shared_lib_path, dlerror());
    return -3;
  }
  dlerror();
  void* raw_sym = dlsym(mod, "b8g_engine_entry_v3");
  const char* dl_err = dlerror();
  if (dl_err || !raw_sym) {
    dlclose(mod);
    return -4;
  }
  B8gEngineEntryV3Fn entry_fn = (B8gEngineEntryV3Fn)(uintptr_t)raw_sym;
#endif

  if (b8g_splash_render_bmp24(splash_bmp_path, brand_id, 480u, 180u, 70u, cas_sha512) != 0) {
#if defined(_WIN32)
    FreeLibrary(mod);
#else
    dlclose(mod);
#endif
    return -5;
  }

  B8gEngineHostCtxV3 ctx;
  memset(&ctx, 0, sizeof(ctx));
  ctx.magic = B8G_ABI_MAGIC_V3;
  ctx.abi_version = B8G_ABI_VERSION_V3;
  ctx.struct_size = (uint32_t)sizeof(B8gEngineHostCtxV3);
  ctx.reserved_flags = 0x1Fu;
  ctx.brand_id = brand_id;
  ctx.cas_sha512 = cas_sha512;
  ctx.splash_bmp_path = splash_bmp_path;
  ctx.arena_bytes = 64u * 1024u * 1024u;

  int rc = entry_fn(&ctx, out_result);

#if defined(_WIN32)
  FreeLibrary(mod);
#else
  dlclose(mod);
#endif

  if (rc != 0) return -6;
  if (out_result->magic != B8G_ABI_MAGIC_V3 || out_result->status_code != 0u || out_result->loaded_ok != 1u) {
    return -7;
  }

  if (b8g_splash_render_bmp24(splash_bmp_path, brand_id, 480u, 180u, 100u, cas_sha512) != 0) {
    return -8;
  }

  return 0;
}
