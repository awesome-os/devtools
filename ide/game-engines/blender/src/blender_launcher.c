/**
 * @file src/blender_launcher.c
 * @description Tiny zero-dependency native C11 Win64/Linux self-hydrating Blender
 * launcher (~118 KB) with instant (< 15 ms) Lumi White Dragon Hydration Splash.
 */

#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
  #define _POSIX_C_SOURCE 200809L
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "lumi_hydration_splash.h"

#if defined(_WIN32)
  #include <process.h>
  #include <io.h>
  #define PATH_SEP '\\'
  #define OS_BLENDER_KEY "blender-win64.tar.zst"
  #define OS_BLENDER_BIN "blender.exe"
#else
  #include <unistd.h>
  #include <sys/stat.h>
  #include <dirent.h>
  #include <limits.h>
  #define PATH_SEP '/'
  #if defined(__aarch64__)
    #define OS_BLENDER_KEY "blender-linux-arm64.tar.zst"
  #else
    #define OS_BLENDER_KEY "blender-linux-x64.tar.zst"
  #endif
  #define OS_BLENDER_BIN "blender"
#endif

#define BLENDER_LAUNCHER_VERSION "0.1.0"
#define MAX_PATH_BUF 1024

static int file_exists(const char *path) {
#if defined(_WIN32)
  DWORD attr = GetFileAttributesA(path);
  return (attr != INVALID_FILE_ATTRIBUTES);
#else
  struct stat st;
  return (stat(path, &st) == 0);
#endif
}

static int get_cas_dir(char *out, size_t cap) {
  const char *env_dir = getenv("B8G_CAS_DIR");
  if (env_dir && env_dir[0] != '\0') {
    snprintf(out, cap, "%s", env_dir);
    return 0;
  }
#if defined(_WIN32)
  const char *home = getenv("USERPROFILE");
  if (!home || home[0] == '\0') home = getenv("HOME");
  if (!home || home[0] == '\0') return -1;
  snprintf(out, cap, "%s\\.b8g\\cas", home);
#else
  const char *home = getenv("HOME");
  if (!home || home[0] == '\0') return -1;
  snprintf(out, cap, "%s/.b8g/cas", home);
#endif
  return 0;
}

static char *read_file_text(const char *path) {
  FILE *fp = fopen(path, "rb");
  if (!fp) return NULL;
  if (fseek(fp, 0, SEEK_END) != 0) {
    fclose(fp);
    return NULL;
  }
  long sz = ftell(fp);
  if (sz <= 0 || sz > 16 * 1024 * 1024) {
    fclose(fp);
    return NULL;
  }
  fseek(fp, 0, SEEK_SET);
  char *buf = (char *)malloc((size_t)sz + 1);
  if (!buf) {
    fclose(fp);
    return NULL;
  }
  size_t n = fread(buf, 1, (size_t)sz, fp);
  buf[n] = '\0';
  fclose(fp);
  return buf;
}

static int is_valid_sha256(const char *s, char out_sha[65]) {
  if (!s) return 0;
  for (int i = 0; i < 64; i++) {
    char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
      return 0;
    }
    out_sha[i] = (c >= 'A' && c <= 'F') ? (char)(c + 32) : c;
  }
  if (s[64] != '\0') return 0;
  out_sha[64] = '\0';
  return 1;
}

static int lookup_sha256_in_index(const char *json, const char *filename, char out_sha[65]) {
  char key[300];
  snprintf(key, sizeof(key), "\"%s\"", filename);
  const char *pos = strstr(json, key);
  if (!pos) return -1;
  const char *sha_key = strstr(pos, "\"sha256\"");
  if (!sha_key) return -1;
  const char *colon = strchr(sha_key + 8, ':');
  if (!colon) return -1;
  const char *q1 = strchr(colon, '"');
  if (!q1) return -1;
  q1++;
  for (int i = 0; i < 64; i++) {
    char c = q1[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) {
      return -1;
    }
    out_sha[i] = (c >= 'A' && c <= 'F') ? (char)(c + 32) : c;
  }
  out_sha[64] = '\0';
  return 0;
}

static int get_exe_dir(char *out, size_t cap) {
#if defined(_WIN32)
  DWORD len = GetModuleFileNameA(NULL, out, (DWORD)cap);
  if (len == 0 || len >= cap) return -1;
#else
  ssize_t len = readlink("/proc/self/exe", out, cap - 1);
  if (len <= 0) return -1;
  out[len] = '\0';
#endif
  char *last = strrchr(out, PATH_SEP);
#if defined(_WIN32)
  char *alt = strrchr(out, '/');
  if (alt && (!last || alt > last)) last = alt;
#endif
  if (!last) return -1;
  *last = '\0';
  return 0;
}

static int find_cli_mts(char *out, size_t cap) {
  const char *env_cli = getenv("BLENDER_CLI_PATH");
  if (env_cli && env_cli[0] != '\0' && file_exists(env_cli)) {
    snprintf(out, cap, "%s", env_cli);
    return 0;
  }
  char exe_dir[MAX_PATH_BUF];
  if (get_exe_dir(exe_dir, sizeof(exe_dir)) == 0) {
    snprintf(out, cap, "%s%cblender-src%ccli.mts", exe_dir, PATH_SEP, PATH_SEP);
    if (file_exists(out)) return 0;
    snprintf(out, cap, "%s%csrc%ccli.mts", exe_dir, PATH_SEP, PATH_SEP);
    if (file_exists(out)) return 0;
    snprintf(out, cap, "%s%c..%csrc%ccli.mts", exe_dir, PATH_SEP, PATH_SEP, PATH_SEP);
    if (file_exists(out)) return 0;
  }
  snprintf(out, cap, "src%ccli.mts", PATH_SEP);
  if (file_exists(out)) return 0;
  return -1;
}

static void set_env_var(const char *name, const char *value) {
#if defined(_WIN32)
  SetEnvironmentVariableA(name, value);
#else
  if (value) setenv(name, value, 1);
  else unsetenv(name);
#endif
}

static int locate_blender_bin(const char *cas_dir, const char *sha, char *out_bin, size_t cap) {
  snprintf(out_bin, cap, "%s%cblender%c%s%c%s", cas_dir, PATH_SEP, PATH_SEP, sha, PATH_SEP, OS_BLENDER_BIN);
  if (file_exists(out_bin)) return 0;

  char base_dir[MAX_PATH_BUF];
  snprintf(base_dir, sizeof(base_dir), "%s%cblender%c%s", cas_dir, PATH_SEP, PATH_SEP, sha);

#if defined(_WIN32)
  char pattern[MAX_PATH_BUF];
  snprintf(pattern, sizeof(pattern), "%s\\*", base_dir);
  WIN32_FIND_DATAA ffd;
  HANDLE hFind = FindFirstFileA(pattern, &ffd);
  if (hFind != INVALID_HANDLE_VALUE) {
    do {
      if ((ffd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 &&
          strcmp(ffd.cFileName, ".") != 0 &&
          strcmp(ffd.cFileName, "..") != 0) {
        snprintf(out_bin, cap, "%s\\%s\\%s", base_dir, ffd.cFileName, OS_BLENDER_BIN);
        if (file_exists(out_bin)) {
          FindClose(hFind);
          return 0;
        }
      }
    } while (FindNextFileA(hFind, &ffd));
    FindClose(hFind);
  }
#else
  DIR *dp = opendir(base_dir);
  if (dp) {
    struct dirent *de;
    while ((de = readdir(dp)) != NULL) {
      if (strcmp(de->d_name, ".") == 0 || strcmp(de->d_name, "..") == 0) continue;
      snprintf(out_bin, cap, "%s/%s/%s", base_dir, de->d_name, OS_BLENDER_BIN);
      if (file_exists(out_bin)) {
        closedir(dp);
        return 0;
      }
    }
    closedir(dp);
  }
#endif
  return -1;
}

#if defined(_WIN32)
static int run_hydration_cli_with_splash(const char *cli_path, int argc, char **argv) {
  char cmd[4096];
  int pos = snprintf(cmd, sizeof(cmd), "node \"%s\"", cli_path);
  for (int i = 1; i < argc && pos < (int)sizeof(cmd) - 64; i++) {
    pos += snprintf(cmd + pos, sizeof(cmd) - (size_t)pos, " \"%s\"", argv[i]);
  }
  set_env_var("BLENDER_PROGRESS", "1");

  SECURITY_ATTRIBUTES sa = { sizeof(SECURITY_ATTRIBUTES), NULL, TRUE };
  HANDLE hRead = NULL, hWrite = NULL;
  if (!CreatePipe(&hRead, &hWrite, &sa, 0)) {
    return 1;
  }
  SetHandleInformation(hRead, HANDLE_FLAG_INHERIT, 0);

  STARTUPINFOA si = {0};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  si.hStdOutput = hWrite;
  si.hStdError = hWrite;
  si.wShowWindow = SW_HIDE;

  PROCESS_INFORMATION pi = {0};
  BOOL ok = CreateProcessA(NULL, cmd, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi);
  CloseHandle(hWrite);
  if (!ok) {
    CloseHandle(hRead);
    return 127;
  }

  char buf[512];
  char line[512];
  size_t line_len = 0;
  DWORD nread = 0;
  while (ReadFile(hRead, buf, sizeof(buf) - 1, &nread, NULL) && nread > 0) {
    for (DWORD i = 0; i < nread; i++) {
      char c = buf[i];
      if (c == '\n' || line_len >= sizeof(line) - 1) {
        line[line_len] = '\0';
        if (strncmp(line, "GHOST_PROGRESS ", 15) == 0) {
          const char *msg = line + 15;
          char *endp = NULL;
          int pct = (int)strtol(msg, &endp, 10);
          if (endp && *endp == ' ') msg = endp + 1;
          lumi_splash_set(pct, msg);
        }
        line_len = 0;
      } else if (c != '\r') {
        line[line_len++] = c;
      }
    }
  }
  CloseHandle(hRead);
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 0;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hProcess);
  CloseHandle(pi.hThread);
  return (int)code;
}
#endif

static int spawn_detached_blender(const char *blender_bin, int argc, char **argv) {
#if defined(_WIN32)
  char cmd[4096];
  int pos = snprintf(cmd, sizeof(cmd), "\"%s\"", blender_bin);
  for (int i = 1; i < argc && pos < (int)sizeof(cmd) - 64; i++) {
    if (strcmp(argv[i], "--no-splash") == 0) continue;
    pos += snprintf(cmd + pos, sizeof(cmd) - (size_t)pos, " \"%s\"", argv[i]);
  }
  STARTUPINFOA si = {0};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi = {0};
  DWORD flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
  BOOL ok = CreateProcessA(NULL, cmd, NULL, NULL, FALSE, flags, NULL, NULL, &si, &pi);
  if (!ok) return 127;
  CloseHandle(pi.hProcess);
  CloseHandle(pi.hThread);
  return 0;
#else
  const char **child_argv = (const char **)calloc((size_t)argc + 2, sizeof(char *));
  if (!child_argv) return 1;
  int out_i = 0;
  child_argv[out_i++] = blender_bin;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--no-splash") == 0) continue;
    child_argv[out_i++] = argv[i];
  }
  child_argv[out_i] = NULL;
  execvp(blender_bin, (char *const *)child_argv);
  perror("execvp");
  free(child_argv);
  return 127;
#endif
}

int main(int argc, char **argv) {
  int dry_run = 0;
  int no_splash = 0;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) break;
    if (strcmp(argv[i], "--version") == 0 || strcmp(argv[i], "-v") == 0) {
      printf("@awesome-os/blender-launcher %s (blender=%s | splash=lumi)\n",
             BLENDER_LAUNCHER_VERSION, OS_BLENDER_KEY);
      return 0;
    }
    if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
      printf("blender native launcher %s (Lumi Hydration Splash + Rolling-Latest Blender + holo-v11 CAS)\n",
             BLENDER_LAUNCHER_VERSION);
      printf("Usage: blender [--no-splash] [--dry-run] [--version] [scene.blend / flags...]\n");
      return 0;
    }
    if (strcmp(argv[i], "--dry-run") == 0) dry_run = 1;
    if (strcmp(argv[i], "--no-splash") == 0) no_splash = 1;
  }

  if (!dry_run && !no_splash) {
    lumi_splash_open("Awesome-OS Blender", "holo-v11 CAS  |  Keep-Last-5 Zero-Installer 3D Suite", "Checking shared Ghost CAS...");
  }

  char cas_dir[MAX_PATH_BUF];
  if (get_cas_dir(cas_dir, sizeof(cas_dir)) == 0 && !dry_run) {
    char blender_sha[65] = {0};
    int have_sha = 0;

    const char *pinned = getenv("BLENDER_GHOST_SHA256");
    if (pinned && is_valid_sha256(pinned, blender_sha)) {
      have_sha = 1;
    } else {
      char index_path[MAX_PATH_BUF];
      snprintf(index_path, sizeof(index_path), "%s%cindex.json", cas_dir, PATH_SEP);
      char *json = read_file_text(index_path);
      if (json) {
        if (lookup_sha256_in_index(json, OS_BLENDER_KEY, blender_sha) == 0) {
          have_sha = 1;
        }
        free(json);
      }
    }

    if (have_sha) {
      char blender_bin[MAX_PATH_BUF];
      if (locate_blender_bin(cas_dir, blender_sha, blender_bin, sizeof(blender_bin)) == 0) {
        set_env_var("B8G_CAS_DIR", cas_dir);
        if (!no_splash) {
          lumi_splash_set(65, "Warm CAS hit: Awesome-OS Blender");
        }
        int rc = spawn_detached_blender(blender_bin, argc, argv);
        if (!no_splash) {
          lumi_splash_set(100, rc == 0 ? "Blender launched!" : "Failed to launch Blender");
#if defined(_WIN32)
          Sleep(1000);
#endif
          lumi_splash_close();
        }
        return rc;
      }
    }
  }

  /* Cold CAS hydration path -> stream live GHOST_PROGRESS from node src/cli.mts into Lumi Splash */
  char cli_path[MAX_PATH_BUF];
  if (find_cli_mts(cli_path, sizeof(cli_path)) != 0) {
    if (!dry_run && !no_splash) {
      lumi_splash_set(0, "Error: cli.mts not found (set BLENDER_CLI_PATH)");
#if defined(_WIN32)
      Sleep(2000);
#endif
      lumi_splash_close();
    }
    fprintf(stderr, "blender: could not locate src/cli.mts (set BLENDER_CLI_PATH).\n");
    return 1;
  }

  if (!dry_run && !no_splash) {
    lumi_splash_set(12, "Hydrating Blender from holo-v11 holo-v11...");
  }

#if defined(_WIN32)
  int rc = (!dry_run && !no_splash)
      ? run_hydration_cli_with_splash(cli_path, argc, argv)
      : (int)_spawnlp(_P_WAIT, "node", "node", cli_path, (argc > 1 ? argv[1] : NULL), NULL);
  if (!dry_run && !no_splash) {
    lumi_splash_set(100, rc == 0 ? "Hydration complete!" : "Hydration exited with error");
    Sleep(800);
    lumi_splash_close();
  }
  return rc;
#else
  const char **node_argv = (const char **)calloc((size_t)argc + 3, sizeof(char *));
  if (!node_argv) return 1;
  node_argv[0] = "node";
  node_argv[1] = cli_path;
  for (int i = 1; i < argc; i++) node_argv[i + 1] = argv[i];
  node_argv[argc + 1] = NULL;
  execvp("node", (char *const *)node_argv);
  perror("execvp");
  free(node_argv);
  return 127;
#endif
}
