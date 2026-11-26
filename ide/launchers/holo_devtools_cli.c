/**
 * @file ide/launchers/holo_devtools_cli.c
 * @brief Standalone C11 CLI launcher (`holo-devtools-launcher`) over `dynamic_loader.c`
 *        and `splash_blitter.c`, verifying B8G_ABI_MAGIC_V3 (0x33564742).
 */

#include "dynamic_loader.h"
#include "splash_blitter.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char* default_temp_dir(void) {
#if defined(_WIN32)
  const char* tmp = getenv("TEMP");
  if (!tmp || tmp[0] == '\0') tmp = getenv("TMP");
  return (tmp && tmp[0] != '\0') ? tmp : ".";
#else
  const char* tmp = getenv("TMPDIR");
  return (tmp && tmp[0] != '\0') ? tmp : "/tmp";
#endif
}

int main(int argc, char** argv) {
  if (argc >= 2 && (strcmp(argv[1], "-h") == 0 || strcmp(argv[1], "--help") == 0)) {
    printf("Usage: holo-devtools-launcher <plugin_shared_lib> [brand_id] [out_bmp_path] [cas_sha512]\n");
    return 0;
  }
  if (argc < 2 || argv[1][0] == '\0') {
    fprintf(stderr, "Usage: holo-devtools-launcher <plugin_shared_lib> [brand_id] [out_bmp_path] [cas_sha512]\n");
    return 1;
  }

  const char* plugin_path = argv[1];
  const char* brand_id = (argc >= 3 && argv[2][0] != '\0') ? argv[2] : "godot";
  const char* explicit_bmp = (argc >= 4 && argv[3][0] != '\0') ? argv[3] : NULL;
  const char* cas_sha512 = (argc >= 5 && argv[4][0] != '\0')
    ? argv[4]
    : "33564742deadbeef00112233445566778899aabbccddeeff0011223344556677"
      "8899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677";

  char temp_bmp[1024];
  const char* splash_path = explicit_bmp;
  if (!splash_path) {
    const char* tmp_dir = default_temp_dir();
#if defined(_WIN32)
    int n = snprintf(temp_bmp, sizeof(temp_bmp), "%s\\holo-devtools-launcher.bmp", tmp_dir);
#else
    int n = snprintf(temp_bmp, sizeof(temp_bmp), "%s/holo-devtools-launcher.bmp", tmp_dir);
#endif
    if (n < 0 || (size_t)n >= sizeof(temp_bmp)) {
      fprintf(stderr, "holo-devtools-launcher: temp path too long\n");
      return 2;
    }
    splash_path = temp_bmp;
  }

  B8gEngineEntryResultV3 res;
  int rc = b8g_dynamic_launch_v3(plugin_path, brand_id, cas_sha512, splash_path, &res);

  if (!explicit_bmp) {
    remove(temp_bmp);
  }

  if (rc != 0) {
    fprintf(stderr, "holo-devtools-launcher: b8g_dynamic_launch_v3 failed (rc=%d)\n", rc);
    return 3;
  }

  printf(
    "PASS: holo-devtools-launcher verified B8G_ABI_MAGIC_V3 (0x%08x) engine=%s status=%u loaded=%u sha512=%.16s palettes=%u\n",
    res.magic,
    res.engine_name,
    res.status_code,
    res.loaded_ok,
    res.echoed_sha512_prefix,
    (unsigned)b8g_splash_palette_count()
  );
  return 0;
}
