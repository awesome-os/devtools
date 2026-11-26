/**
 * @file ide/launchers/splash_blitter.h
 * @brief Zero-dependency C11 24-bit BMP splashscreen & Holo v11 progress bar blitter
 *        supporting branded palettes for IDEs and game engines.
 */

#ifndef B8G_SPLASH_BLITTER_H
#define B8G_SPLASH_BLITTER_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct B8gBrandPalette {
  const char* id;
  const char* title;
  const char* subtitle;
  uint8_t bg_r, bg_g, bg_b;
  uint8_t accent_r, accent_g, accent_b;
  uint8_t bar_bg_r, bar_bg_g, bar_bg_b;
  uint8_t bar_fg_r, bar_fg_g, bar_fg_b;
  uint8_t border_r, border_g, border_b;
} B8gBrandPalette;

size_t b8g_splash_palette_count(void);
const B8gBrandPalette* b8g_splash_palette_at(size_t index);
const B8gBrandPalette* b8g_splash_find_palette(const char* brand_id);

/**
 * Renders a deterministic 24-bit uncompressed BMP splashscreen to `out_bmp_path`
 * with a branded palette, geometric emblem, label text, and 0..100% progress bar.
 * Returns 0 on success, non-zero on failure.
 */
int b8g_splash_render_bmp24(
  const char* out_bmp_path,
  const char* brand_id,
  uint32_t width,
  uint32_t height,
  uint32_t progress_pct,
  const char* sha512_prefix
);

#ifdef __cplusplus
}
#endif

#endif /* B8G_SPLASH_BLITTER_H */
