/**
 * @file ide/launchers/splash_blitter.c
 * @brief C11 24-bit uncompressed BMP splash generator + Holo v11 progress bar renderer.
 */

#include "splash_blitter.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const B8gBrandPalette G_BRAND_PALETTES[] = {
  {
    "godot",
    "AWESOME-OS GODOT 4",
    "HOLO V11 CAS",
    14, 18, 28,
    71, 140, 191,
    30, 41, 59,
    56, 189, 248,
    71, 140, 191
  },
  {
    "blender",
    "AWESOME-OS BLENDER 5",
    "HOLO V11 CAS",
    20, 18, 16,
    234, 118, 0,
    44, 38, 34,
    249, 115, 22,
    234, 118, 0
  },
  {
    "unity",
    "AWESOME-OS UNITY 6",
    "HOLO V11 CAS",
    15, 17, 23,
    226, 232, 240,
    34, 39, 49,
    163, 230, 53,
    148, 163, 184
  },
  {
    "unreal",
    "AWESOME-OS UNREAL 5",
    "B8G ARENA V1",
    11, 14, 22,
    14, 165, 233,
    28, 36, 52,
    56, 189, 248,
    59, 130, 246
  },
  {
    "asymmetric-hunt",
    "ASYMMETRIC HUNT 3D",
    "B8G GAME ENGINE",
    18, 10, 14,
    225, 29, 72,
    42, 22, 30,
    244, 63, 94,
    190, 18, 60
  },
  {
    "code-oss",
    "AWESOME-OS CODE OSS",
    "HOLO V11 CAS",
    13, 17, 26,
    56, 189, 248,
    30, 41, 59,
    34, 211, 238,
    88, 101, 242
  },
  {
    "theia",
    "AWESOME-OS THEIA IDE",
    "SECTIUM DISPLAY",
    14, 15, 28,
    168, 85, 247,
    34, 32, 58,
    192, 132, 252,
    139, 92, 246
  }
};

size_t b8g_splash_palette_count(void) {
  return sizeof(G_BRAND_PALETTES) / sizeof(G_BRAND_PALETTES[0]);
}

const B8gBrandPalette* b8g_splash_palette_at(size_t index) {
  if (index >= b8g_splash_palette_count()) return NULL;
  return &G_BRAND_PALETTES[index];
}

const B8gBrandPalette* b8g_splash_find_palette(const char* brand_id) {
  if (!brand_id) return &G_BRAND_PALETTES[0];
  size_t count = b8g_splash_palette_count();
  for (size_t i = 0; i < count; i++) {
    if (strcmp(G_BRAND_PALETTES[i].id, brand_id) == 0) {
      return &G_BRAND_PALETTES[i];
    }
  }
  return NULL;
}

static void write_le16(uint8_t* dst, uint16_t val) {
  dst[0] = (uint8_t)(val & 0xFFu);
  dst[1] = (uint8_t)((val >> 8) & 0xFFu);
}

static void write_le32(uint8_t* dst, uint32_t val) {
  dst[0] = (uint8_t)(val & 0xFFu);
  dst[1] = (uint8_t)((val >> 8) & 0xFFu);
  dst[2] = (uint8_t)((val >> 16) & 0xFFu);
  dst[3] = (uint8_t)((val >> 24) & 0xFFu);
}

static void set_pixel(
  uint8_t* pixels,
  uint32_t width,
  uint32_t height,
  uint32_t stride,
  int32_t x,
  int32_t y,
  uint8_t r,
  uint8_t g,
  uint8_t b
) {
  if (x < 0 || y < 0 || (uint32_t)x >= width || (uint32_t)y >= height) return;
  uint32_t bmp_row = (height - 1u) - (uint32_t)y;
  size_t off = (size_t)bmp_row * (size_t)stride + (size_t)x * 3u;
  pixels[off + 0] = b;
  pixels[off + 1] = g;
  pixels[off + 2] = r;
}

static void fill_rect(
  uint8_t* pixels,
  uint32_t width,
  uint32_t height,
  uint32_t stride,
  int32_t x0,
  int32_t y0,
  int32_t rw,
  int32_t rh,
  uint8_t r,
  uint8_t g,
  uint8_t b
) {
  for (int32_t dy = 0; dy < rh; dy++) {
    for (int32_t dx = 0; dx < rw; dx++) {
      set_pixel(pixels, width, height, stride, x0 + dx, y0 + dy, r, g, b);
    }
  }
}

/* Minimal 3x5 bitmap glyph rows for uppercase ASCII, digits, and separators */
static uint16_t glyph_3x5(char ch) {
  switch (ch) {
    case 'A': return 0x7B6F; /* .#. / #.# / ### / #.# / #.# */
    case 'B': return 0xEBEB;
    case 'C': return 0x7249;
    case 'D': return 0xE66E;
    case 'E': return 0xF3CF;
    case 'F': return 0xF3C9;
    case 'G': return 0x72DF;
    case 'H': return 0xB6FB;
    case 'I': return 0xE497;
    case 'J': return 0x249E;
    case 'K': return 0xB74B;
    case 'L': return 0x924F;
    case 'M': return 0xBFEB;
    case 'N': return 0xBF6B;
    case 'O': return 0x7B6E;
    case 'P': return 0xFBC9;
    case 'Q': return 0x7B5E;
    case 'R': return 0xFBEB;
    case 'S': return 0x798E;
    case 'T': return 0xE492;
    case 'U': return 0xB66E;
    case 'V': return 0xB66A;
    case 'W': return 0xB6FE;
    case 'X': return 0xB54B;
    case 'Y': return 0xB524;
    case 'Z': return 0xE54F;
    case '0': return 0x7B6E;
    case '1': return 0x6497;
    case '2': return 0xE52F;
    case '3': return 0xE5CE;
    case '4': return 0xB792;
    case '5': return 0xF38E;
    case '6': return 0x73CE;
    case '7': return 0xE292;
    case '8': return 0x7BCE;
    case '9': return 0x79CE;
    case '-': return 0x01C0;
    case ':': return 0x0410;
    case '.': return 0x0002;
    case '%': return 0x9529;
    default:  return 0x0000;
  }
}

static void draw_text_scaled(
  uint8_t* pixels,
  uint32_t width,
  uint32_t height,
  uint32_t stride,
  int32_t start_x,
  int32_t start_y,
  int32_t scale,
  const char* text,
  uint8_t r,
  uint8_t g,
  uint8_t b
) {
  if (!text) return;
  int32_t cx = start_x;
  for (size_t idx = 0; text[idx] != '\0'; idx++) {
    char ch = text[idx];
    if (ch >= 'a' && ch <= 'z') ch = (char)(ch - 32);
    uint16_t bits = glyph_3x5(ch);
    for (int row = 0; row < 5; row++) {
      for (int col = 0; col < 3; col++) {
        int bit_idx = 14 - (row * 3 + col);
        if ((bits >> bit_idx) & 1u) {
          fill_rect(
            pixels, width, height, stride,
            cx + col * scale, start_y + row * scale, scale, scale,
            r, g, b
          );
        }
      }
    }
    cx += 4 * scale;
  }
}

int b8g_splash_render_bmp24(
  const char* out_bmp_path,
  const char* brand_id,
  uint32_t width,
  uint32_t height,
  uint32_t progress_pct,
  const char* sha512_prefix
) {
  if (!out_bmp_path || width < 64u || height < 48u) return -1;
  const B8gBrandPalette* pal = b8g_splash_find_palette(brand_id);
  if (!pal) pal = &G_BRAND_PALETTES[0];

  if (progress_pct > 100u) progress_pct = 100u;

  uint32_t row_stride = ((width * 3u) + 3u) & ~3u;
  uint32_t pixel_bytes = row_stride * height;
  uint32_t file_size = 54u + pixel_bytes;

  uint8_t* buf = (uint8_t*)calloc(1u, file_size);
  if (!buf) return -2;

  /* BITMAPFILEHEADER (14 bytes) */
  buf[0] = 'B';
  buf[1] = 'M';
  write_le32(buf + 2, file_size);
  write_le32(buf + 10, 54u);

  /* BITMAPINFOHEADER (40 bytes) */
  write_le32(buf + 14, 40u);
  write_le32(buf + 18, width);
  write_le32(buf + 22, height);
  write_le16(buf + 26, 1u);
  write_le16(buf + 28, 24u);
  write_le32(buf + 34, pixel_bytes);
  write_le32(buf + 38, 2835u);
  write_le32(buf + 42, 2835u);

  uint8_t* pixels = buf + 54;

  /* Background gradient */
  for (uint32_t y = 0; y < height; y++) {
    uint8_t shade = (uint8_t)((y * 10u) / height);
    uint8_t r = (uint8_t)(pal->bg_r + shade);
    uint8_t g = (uint8_t)(pal->bg_g + shade);
    uint8_t b = (uint8_t)(pal->bg_b + shade);
    for (uint32_t x = 0; x < width; x++) {
      set_pixel(pixels, width, height, row_stride, (int32_t)x, (int32_t)y, r, g, b);
    }
  }

  /* 2px outer border + 6px top accent strip */
  fill_rect(pixels, width, height, row_stride, 0, 0, (int32_t)width, 2, pal->border_r, pal->border_g, pal->border_b);
  fill_rect(pixels, width, height, row_stride, 0, (int32_t)height - 2, (int32_t)width, 2, pal->border_r, pal->border_g, pal->border_b);
  fill_rect(pixels, width, height, row_stride, 0, 0, 2, (int32_t)height, pal->border_r, pal->border_g, pal->border_b);
  fill_rect(pixels, width, height, row_stride, (int32_t)width - 2, 0, 2, (int32_t)height, pal->border_r, pal->border_g, pal->border_b);
  fill_rect(pixels, width, height, row_stride, 2, 2, (int32_t)width - 4, 6, pal->accent_r, pal->accent_g, pal->accent_b);

  /* Brand emblem square + inner diamond */
  int32_t emb_x = 24;
  int32_t emb_y = 28;
  int32_t emb_sz = 52;
  fill_rect(pixels, width, height, row_stride, emb_x, emb_y, emb_sz, emb_sz, pal->bar_bg_r, pal->bar_bg_g, pal->bar_bg_b);
  for (int32_t dy = -16; dy <= 16; dy++) {
    int32_t span = 16 - (dy < 0 ? -dy : dy);
    fill_rect(
      pixels, width, height, row_stride,
      emb_x + emb_sz / 2 - span, emb_y + emb_sz / 2 + dy,
      span * 2 + 1, 1,
      pal->accent_r, pal->accent_g, pal->accent_b
    );
  }

  /* Title + subtitle + SHA-512 hydration label */
  draw_text_scaled(pixels, width, height, row_stride, 92, 32, 3, pal->title, 241, 245, 249);
  draw_text_scaled(pixels, width, height, row_stride, 92, 58, 2, pal->subtitle, 148, 163, 184);

  char status_line[96];
  if (sha512_prefix && sha512_prefix[0] != '\0') {
    char short_sha[17];
    snprintf(short_sha, sizeof(short_sha), "%.12s", sha512_prefix);
    snprintf(status_line, sizeof(status_line), "SHA512:%s %u%%", short_sha, (unsigned)progress_pct);
  } else {
    snprintf(status_line, sizeof(status_line), "HYDRATING V11 %u%%", (unsigned)progress_pct);
  }
  draw_text_scaled(pixels, width, height, row_stride, 24, (int32_t)height - 54, 2, status_line, 226, 232, 240);

  /* Progress bar track + filled bar */
  int32_t bar_x = 24;
  int32_t bar_y = (int32_t)height - 32;
  int32_t bar_w = (int32_t)width - 48;
  int32_t bar_h = 14;
  fill_rect(pixels, width, height, row_stride, bar_x, bar_y, bar_w, bar_h, pal->bar_bg_r, pal->bar_bg_g, pal->bar_bg_b);
  int32_t fill_w = (int32_t)(((uint64_t)bar_w * (uint64_t)progress_pct) / 100u);
  if (fill_w > 0) {
    fill_rect(pixels, width, height, row_stride, bar_x, bar_y, fill_w, bar_h, pal->bar_fg_r, pal->bar_fg_g, pal->bar_fg_b);
  }

  FILE* fp = fopen(out_bmp_path, "wb");
  if (!fp) {
    free(buf);
    return -3;
  }
  size_t written = fwrite(buf, 1u, file_size, fp);
  fclose(fp);
  free(buf);
  return (written == file_size) ? 0 : -4;
}

#ifdef B8G_SPLASH_CLI_MAIN
int main(int argc, char** argv) {
  if (argc < 3) {
    fprintf(stderr, "Usage: splash_blitter <brand_id> <out_bmp_path> [progress_pct] [sha512]\n");
    return 1;
  }
  const char* brand = argv[1];
  const char* out_path = argv[2];
  uint32_t pct = argc >= 4 ? (uint32_t)atoi(argv[3]) : 100u;
  const char* sha = argc >= 5 ? argv[4] : "33564742v110";
  return b8g_splash_render_bmp24(out_path, brand, 480u, 180u, pct, sha);
}
#endif
