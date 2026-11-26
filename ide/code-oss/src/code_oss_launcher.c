/**
 * @file src/code_oss_launcher.c
 * @description Tiny zero-dependency native C11 Win64/Linux self-hydrating launcher
 * with instant (< 15 ms) Lumi White Dragon Hydration Splash optical feedback.
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
  #define OS_ELECTRON_KEY "electron-win64.tar.zst"
  #define OS_CODE_OSS_KEY "code-oss-app-win64.tar.zst"
  #define OS_GHOST_ABI_KEY "b8g-abi-win64.node"
  #define OS_ELECTRON_BIN "electron.exe"
#else
  #include <unistd.h>
  #include <sys/stat.h>
  #include <limits.h>
  #define PATH_SEP '/'
  #if defined(__aarch64__)
    #define OS_ELECTRON_KEY "electron-linux-arm64.tar.zst"
    #define OS_CODE_OSS_KEY "code-oss-app-linux-arm64.tar.zst"
    #define OS_GHOST_ABI_KEY "b8g-abi-linux-arm64.node"
  #else
    #define OS_ELECTRON_KEY "electron-linux-x64.tar.zst"
    #define OS_CODE_OSS_KEY "code-oss-app-linux-x64.tar.zst"
    #define OS_GHOST_ABI_KEY "b8g-abi-linux-x64.node"
  #endif
  #define OS_ELECTRON_BIN "electron"
#endif

#define CODE_OSS_LAUNCHER_VERSION "0.2.0"
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
  const char *env_cli = getenv("CODE_OSS_CLI_PATH");
  if (env_cli && env_cli[0] != '\0' && file_exists(env_cli)) {
    snprintf(out, cap, "%s", env_cli);
    return 0;
  }
  char exe_dir[MAX_PATH_BUF];
  if (get_exe_dir(exe_dir, sizeof(exe_dir)) == 0) {
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

static void sanitize_electron_env(void) {
  /* Prevent parent IDE terminals from forcing Electron into headless Node-only mode */
  set_env_var("ELECTRON_RUN_AS_NODE", NULL);
  set_env_var("VSCODE_IPC_HOOK", NULL);
  set_env_var("VSCODE_PID", NULL);
}

#if defined(_WIN32)
static int run_hydration_cli_with_splash(const char *cli_path, int argc, char **argv) {
  char cmd[4096];
  int pos = snprintf(cmd, sizeof(cmd), "node \"%s\"", cli_path);
  for (int i = 1; i < argc && pos < (int)sizeof(cmd) - 64; i++) {
    pos += snprintf(cmd + pos, sizeof(cmd) - (size_t)pos, " \"%s\"", argv[i]);
  }
  set_env_var("CODE_OSS_PROGRESS", "1");

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
          int pct = 0;
          const char *msg = line + 15;
          char *endp = NULL;
          pct = (int)strtol(msg, &endp, 10);
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

typedef struct {
  unsigned int abi_magic;
  unsigned int abi_version;
  const char *app_name;
  const char *resources_dir;
  const char *ghost_abi_path;
} libelectron_host_config_t;

typedef int (*libelectron_main_fn)(void *, int, char **, const libelectron_host_config_t *);

static int try_run_via_libelectron(const char *cas_dir, const char *app_dir, const char *abi_path, int argc, char **argv) {
#if defined(_WIN32)
  char dll_path[MAX_PATH_BUF];
  snprintf(dll_path, sizeof(dll_path), "%s\\libelectron\\libelectron.dll", cas_dir);
  if (!file_exists(dll_path)) return -999;
  HMODULE mod = LoadLibraryA(dll_path);
  if (!mod) return -999;
  libelectron_main_fn fn = (libelectron_main_fn)GetProcAddress(mod, "libelectron_main");
  if (!fn) {
    FreeLibrary(mod);
    return -999;
  }
  libelectron_host_config_t cfg = { 0x33564742u, 1u, "Awesome-OS Code - OSS", app_dir, abi_path };
  return fn(GetModuleHandleA(NULL), argc, argv, &cfg);
#else
  (void)cas_dir; (void)app_dir; (void)abi_path; (void)argc; (void)argv;
  return -999;
#endif
}

static int ensure_isolated_code_oss_runtime(
    const char *cas_dir,
    const char *electron_dir,
    const char *electron_sha,
    const char *app_dir,
    char *out_electron_bin,
    size_t out_cap) {
#if defined(_WIN32)
  char rt_dir[MAX_PATH_BUF];
  snprintf(rt_dir, sizeof(rt_dir), "%s\\code-oss-runtime\\%.12s", cas_dir, electron_sha);
  snprintf(out_electron_bin, out_cap, "%s\\electron.exe", rt_dir);
  char res_dir[MAX_PATH_BUF];
  snprintf(res_dir, sizeof(res_dir), "%s\\resources", rt_dir);
  char link_path[MAX_PATH_BUF];
  snprintf(link_path, sizeof(link_path), "%s\\app", res_dir);
  char marker[MAX_PATH_BUF];
  snprintf(marker, sizeof(marker), "%s\\package.json", link_path);

  if (file_exists(out_electron_bin) && file_exists(marker)) {
    return 0;
  }

  /* Create zero-copy hardlinks for all top-level Electron files + locales junction + resources/app junction.
     Leaves ~/.b8g/cas/electron/<sha>/ 100% untouched for sectium-browser and other apps! */
  char cmd[4096];
  snprintf(
      cmd, sizeof(cmd),
      "cmd.exe /c mkdir \"%s\" 2>nul & mkdir \"%s\" 2>nul & "
      "for %%F in (\"%s\\*\") do if not exist \"%s\\%%~nxF\" mklink /H \"%s\\%%~nxF\" \"%%F\" >nul 2>&1 & "
      "if not exist \"%s\\locales\" mklink /J \"%s\\locales\" \"%s\\locales\" >nul 2>&1 & "
      "if exist \"%s\" rmdir \"%s\" >nul 2>&1 & "
      "mklink /J \"%s\" \"%s\" >nul 2>&1",
      rt_dir, res_dir,
      electron_dir, rt_dir, rt_dir,
      rt_dir, rt_dir, electron_dir,
      link_path, link_path,
      link_path, app_dir);

  STARTUPINFOA si = {0};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi = {0};
  if (CreateProcessA(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
    WaitForSingleObject(pi.hProcess, 8000);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
  }
  return (file_exists(out_electron_bin) && file_exists(marker)) ? 0 : -1;
#else
  (void)cas_dir;
  (void)electron_sha;
  char link_path[MAX_PATH_BUF];
  snprintf(link_path, sizeof(link_path), "%s/resources/app", electron_dir);
  snprintf(out_electron_bin, out_cap, "%s/electron", electron_dir);
  unlink(link_path);
  return symlink(app_dir, link_path);
#endif
}

static int spawn_detached_electron(
    const char *cas_dir,
    const char *electron_bin,
    const char *electron_dir,
    const char *electron_sha,
    const char *app_dir,
    int argc,
    char **argv) {
  char isolated_bin[MAX_PATH_BUF];
  int isolated = (ensure_isolated_code_oss_runtime(
                      cas_dir, electron_dir, electron_sha, app_dir, isolated_bin, sizeof(isolated_bin)) == 0);
  const char *launch_bin = isolated ? isolated_bin : electron_bin;
#if defined(_WIN32)
  char cmd[4096];
  int pos = isolated
      ? snprintf(cmd, sizeof(cmd), "\"%s\"", launch_bin)
      : snprintf(cmd, sizeof(cmd), "\"%s\" \"%s\"", launch_bin, app_dir);
  for (int i = 1; i < argc && pos < (int)sizeof(cmd) - 64; i++) {
    if (strcmp(argv[i], "--upstream") == 0 || strcmp(argv[i], "--no-splash") == 0) continue;
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
  const char **child_argv = (const char **)calloc((size_t)argc + 3, sizeof(char *));
  if (!child_argv) return 1;
  int out_i = 0;
  child_argv[out_i++] = launch_bin;
  if (!isolated) child_argv[out_i++] = app_dir;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--upstream") == 0 || strcmp(argv[i], "--no-splash") == 0) continue;
    child_argv[out_i++] = argv[i];
  }
  child_argv[out_i] = NULL;
  execvp(launch_bin, (char *const *)child_argv);
  perror("execvp");
  free(child_argv);
  return 127;
#endif
}

int main(int argc, char **argv) {
  int use_sectium = 0;
  int dry_run = 0;
  int no_splash = 0;

  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) break;
    if (strcmp(argv[i], "--version") == 0 || strcmp(argv[i], "-v") == 0) {
      printf("@awesome-os/code-oss-launcher %s (electron=%s | app=%s | abi=%s | splash=lumi)\n",
             CODE_OSS_LAUNCHER_VERSION, OS_ELECTRON_KEY, OS_CODE_OSS_KEY, OS_GHOST_ABI_KEY);
      return 0;
    }
    if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
      printf("code-oss native launcher %s (Lumi Hydration Splash + shared Electron + holo-v11 CAS)\n",
             CODE_OSS_LAUNCHER_VERSION);
      printf("Usage: code-oss [--sectium|--upstream] [--no-splash] [--dry-run] [--version] [files/folders...]\n");
      return 0;
    }
    if (strcmp(argv[i], "--sectium") == 0) use_sectium = 1;
    if (strcmp(argv[i], "--dry-run") == 0) dry_run = 1;
    if (strcmp(argv[i], "--no-splash") == 0) no_splash = 1;
  }

  sanitize_electron_env();

  if (!dry_run && !no_splash) {
    lumi_splash_open("Awesome-OS Code - OSS", "holo-v11 CAS  |  B8G_ARENA_V1 Zero-Copy", "Checking shared Ghost CAS...");
  }

  char cas_dir[MAX_PATH_BUF];
  if (get_cas_dir(cas_dir, sizeof(cas_dir)) == 0 && !use_sectium && !dry_run) {
    char index_path[MAX_PATH_BUF];
    snprintf(index_path, sizeof(index_path), "%s%cindex.json", cas_dir, PATH_SEP);
    char *json = read_file_text(index_path);
    if (json) {
      char electron_sha[65] = {0};
      char app_sha[65] = {0};
      char abi_sha[65] = {0};
      if (lookup_sha256_in_index(json, OS_ELECTRON_KEY, electron_sha) == 0 &&
          lookup_sha256_in_index(json, OS_CODE_OSS_KEY, app_sha) == 0 &&
          lookup_sha256_in_index(json, OS_GHOST_ABI_KEY, abi_sha) == 0) {
        char electron_bin[MAX_PATH_BUF];
        char app_dir[MAX_PATH_BUF];
        char app_pkg[MAX_PATH_BUF];
        char abi_path[MAX_PATH_BUF];

        snprintf(electron_bin, sizeof(electron_bin), "%s%celectron%c%s%c%s",
                 cas_dir, PATH_SEP, PATH_SEP, electron_sha, PATH_SEP, OS_ELECTRON_BIN);
        snprintf(app_dir, sizeof(app_dir), "%s%ccode-oss%c%s%cresources%capp",
                 cas_dir, PATH_SEP, PATH_SEP, app_sha, PATH_SEP, PATH_SEP);
        snprintf(app_pkg, sizeof(app_pkg), "%s%cpackage.json", app_dir, PATH_SEP);
        snprintf(abi_path, sizeof(abi_path), "%s%cghost-abi%c%s%c%s",
                 cas_dir, PATH_SEP, PATH_SEP, abi_sha, PATH_SEP, OS_GHOST_ABI_KEY);

        char electron_dir[MAX_PATH_BUF];
        snprintf(electron_dir, sizeof(electron_dir), "%s%celectron%c%s",
                 cas_dir, PATH_SEP, PATH_SEP, electron_sha);
        if (file_exists(electron_bin) && file_exists(app_pkg) && file_exists(abi_path)) {
          free(json);
          set_env_var("B8G_ABI_PATH", abi_path);
          set_env_var("B8G_CAS_DIR", cas_dir);

          if (!no_splash) {
            lumi_splash_set(55, "Warm CAS hit: Electron + Code - OSS + B8G_ARENA_V1");
          }
          int lib_rc = try_run_via_libelectron(cas_dir, app_dir, abi_path, argc, argv);
          if (lib_rc != -999) {
            if (!no_splash) lumi_splash_close();
            return lib_rc;
          }
          int rc = spawn_detached_electron(cas_dir, electron_bin, electron_dir, electron_sha, app_dir, argc, argv);
          if (!no_splash) {
            lumi_splash_set(100, rc == 0 ? "Code - OSS launched!" : "Failed to launch Electron");
#if defined(_WIN32)
            Sleep(1200);
#endif
            lumi_splash_close();
          }
          return rc;
        }
      }
      free(json);
    }
  }

  /* Cold CAS hydration path -> stream live progress from node src/cli.mts into Lumi Splash */
  char cli_path[MAX_PATH_BUF];
  if (find_cli_mts(cli_path, sizeof(cli_path)) != 0) {
    if (!dry_run && !no_splash) {
      lumi_splash_set(0, "Error: src/cli.mts not found (set CODE_OSS_CLI_PATH)");
#if defined(_WIN32)
      Sleep(2000);
#endif
      lumi_splash_close();
    }
    fprintf(stderr, "code-oss: could not locate src/cli.mts (set CODE_OSS_CLI_PATH).\n");
    return 1;
  }

  if (!dry_run && !no_splash) {
    lumi_splash_set(12, "Hydrating shared Electron + Code - OSS from holo-v11...");
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
