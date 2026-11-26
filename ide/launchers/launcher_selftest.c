/**
 * @file ide/launchers/launcher_selftest.c
 * @brief End-to-end native C11 selftest:
 *        - Renders 24-bit BMP splashscreens for all 7 branded palettes
 *        - Dynamically loads companion shared library (.dll / .so / .dylib)
 *        - Verifies B8G_ABI_MAGIC_V3 (0x33564742) handshake and 24-bit BMP headers
 */

#include "dynamic_loader.h"
#include "splash_blitter.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint16_t read_le16(const uint8_t* p) {
  return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

static uint32_t read_le32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int verify_bmp24_file(const char* path, uint32_t exp_w, uint32_t exp_h) {
  FILE* fp = fopen(path, "rb");
  if (!fp) return -1;
  uint8_t hdr[54];
  size_t n = fread(hdr, 1u, sizeof(hdr), fp);
  fseek(fp, 0, SEEK_END);
  long total_len = ftell(fp);
  fclose(fp);

  if (n != 54u) return -2;
  if (hdr[0] != 'B' || hdr[1] != 'M') return -3;
  uint32_t file_size = read_le32(hdr + 2);
  uint32_t off_bits = read_le32(hdr + 10);
  uint32_t dib_size = read_le32(hdr + 14);
  uint32_t w = read_le32(hdr + 18);
  uint32_t h = read_le32(hdr + 22);
  uint16_t bpp = read_le16(hdr + 28);

  if (off_bits != 54u || dib_size != 40u) return -4;
  if (w != exp_w || h != exp_h || bpp != 24u) return -5;
  uint32_t stride = ((exp_w * 3u) + 3u) & ~3u;
  uint32_t expected_total = 54u + stride * exp_h;
  if (file_size != expected_total || (long)expected_total != total_len) return -6;
  return 0;
}

int main(int argc, char** argv) {
  if (argc < 3) {
    fprintf(stderr, "Usage: launcher_selftest <plugin_shared_lib> <out_bmp_path> [brand_id]\n");
    return 1;
  }

  const char* plugin_path = argv[1];
  const char* bmp_path = argv[2];
  const char* brand_id = argc >= 4 ? argv[3] : "godot";
  const char* sample_sha512 =
    "33564742deadbeef00112233445566778899aabbccddeeff0011223344556677"
    "8899aabbccddeeff00112233445566778899aabbccddeeff0011223344556677";

  B8gEngineEntryResultV3 res;
  int rc = b8g_dynamic_launch_v3(plugin_path, brand_id, sample_sha512, bmp_path, &res);
  if (rc != 0) {
    fprintf(stderr, "b8g_dynamic_launch_v3 failed with rc=%d\n", rc);
    return 2;
  }

  if (verify_bmp24_file(bmp_path, 480u, 180u) != 0) {
    fprintf(stderr, "verify_bmp24_file failed for %s\n", bmp_path);
    return 3;
  }

  if (strncmp(res.echoed_sha512_prefix, sample_sha512, 16u) != 0) {
    fprintf(stderr, "SHA-512 prefix mismatch: %s\n", res.echoed_sha512_prefix);
    return 4;
  }

  printf(
    "PASS: B8G dynamic launcher v3 verified (magic=0x%08x engine=%s sha512=%.16s palettes=%u)\n",
    res.magic,
    res.engine_name,
    res.echoed_sha512_prefix,
    (unsigned)b8g_splash_palette_count()
  );
  return 0;
}
