/**
 * @file sections/b8g-ide/devplane/protocol.mts
 * @description Dual-channel Sectium DevPlane protocol & capability providers (env, display, fs, pty)
 * consumed by the `b8g-devplane` VS Code extension and the Sectium WebRenderer host.
 *
 * Strictly zero external dependencies, `erasableSyntaxOnly: true`, zero local HTTP IPC.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';

export const B8G_DEVPLANE_PIPE_WIN32 = '\\\\.\\pipe\\sectium-dev';
export const B8G_DEVPLANE_PIPE_POSIX = '/tmp/sectium-dev.sock';
export const B8G_DISPLAY_ABI_MAGIC = 0x31444742; // 'BGD1' (B8G_DISPLAY_V1)

export type DevPlaneChannel = 'command' | 'display';

export interface DevPlaneFrame {
  readonly v: 1;
  readonly channel: DevPlaneChannel;
  readonly topic: string;
  readonly ts: number;
  readonly payload: Record<string, unknown>;
}

export interface DevPlaneEnvSnapshot {
  readonly baselineTag: string;
  readonly brand: 'Lumi White Dragon';
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly pipePath: string;
  readonly workspaceRoot: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface DisplaySurfaceDescriptor {
  readonly surfaceId: number;
  readonly title: string;
  readonly mode: '2d' | '3d';
  readonly width: number;
  readonly height: number;
  readonly abiMagic: number;
  readonly brandIcon: string;
}

const REDACTED_ENV_PATTERN = /(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL|COOKIE|AUTH)/i;

export function getDefaultDevPlanePipe(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? B8G_DEVPLANE_PIPE_WIN32 : B8G_DEVPLANE_PIPE_POSIX;
}

export function encodeDevPlaneFrame(frame: DevPlaneFrame): string {
  return JSON.stringify(frame) + '\n';
}

export function decodeDevPlaneFrame(line: string): DevPlaneFrame {
  const parsed = JSON.parse(line.trim()) as DevPlaneFrame;
  if (parsed.v !== 1 || (parsed.channel !== 'command' && parsed.channel !== 'display')) {
    throw new Error(`Invalid DevPlane frame: ${line.slice(0, 80)}`);
  }
  return parsed;
}

export class DevPlaneEnvProvider {
  readonly #workspaceRoot: string;
  readonly #baselineTag: string;
  readonly #rawEnv: Readonly<Record<string, string | undefined>>;

  constructor(opts: {
    workspaceRoot: string;
    baselineTag?: string;
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    this.#workspaceRoot = resolve(opts.workspaceRoot);
    this.#baselineTag = opts.baselineTag ?? 'v0.5.0-baseline';
    this.#rawEnv = opts.env ?? process.env;
  }

  snapshot(): DevPlaneEnvSnapshot {
    const safeEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.#rawEnv)) {
      if (v === undefined) continue;
      if (REDACTED_ENV_PATTERN.test(k)) continue;
      safeEnv[k] = v;
    }
    safeEnv['B8G_DEVPLANE_PIPE'] = getDefaultDevPlanePipe();
    safeEnv['SECTIUM_BASELINE_TAG'] = this.#baselineTag;
    safeEnv['SECTIUM_BRAND'] = 'Lumi White Dragon';
    safeEnv['B8G_WORKSPACE_ROOT'] = this.#workspaceRoot;

    return {
      baselineTag: this.#baselineTag,
      brand: 'Lumi White Dragon',
      platform: process.platform,
      arch: process.arch,
      pipePath: getDefaultDevPlanePipe(),
      workspaceRoot: this.#workspaceRoot,
      env: safeEnv,
    };
  }
}

export class DevPlaneDisplayProvider {
  #nextSurfaceId = 1;
  readonly #surfaces = new Map<number, DisplaySurfaceDescriptor>();
  readonly #emit: (frame: DevPlaneFrame) => void;

  constructor(emit: (frame: DevPlaneFrame) => void) {
    this.#emit = emit;
  }

  createSurface(title: string, width = 1440, height = 900, mode: '2d' | '3d' = '2d'): DisplaySurfaceDescriptor {
    const surface: DisplaySurfaceDescriptor = {
      surfaceId: this.#nextSurfaceId++,
      title,
      mode,
      width,
      height,
      abiMagic: B8G_DISPLAY_ABI_MAGIC,
      brandIcon: 'lumi-white-dragon.ico',
    };
    this.#surfaces.set(surface.surfaceId, surface);
    this.#emit({
      v: 1,
      channel: 'display',
      topic: 'b8g.display.surface.create',
      ts: Date.now(),
      payload: { ...surface },
    });
    return surface;
  }

  rebindMode(surfaceId: number, mode: '2d' | '3d'): DisplaySurfaceDescriptor {
    const cur = this.#surfaces.get(surfaceId);
    if (!cur) throw new Error(`Unknown display surfaceId=${surfaceId}`);
    const next: DisplaySurfaceDescriptor = { ...cur, mode };
    this.#surfaces.set(surfaceId, next);
    this.#emit({
      v: 1,
      channel: 'display',
      topic: 'b8g.display.surface.rebind',
      ts: Date.now(),
      payload: { surfaceId, mode, abiMagic: B8G_DISPLAY_ABI_MAGIC },
    });
    return next;
  }

  listSurfaces(): DisplaySurfaceDescriptor[] {
    return Array.from(this.#surfaces.values());
  }
}

export class DevPlaneFsProvider {
  readonly #root: string;

  constructor(workspaceRoot: string) {
    this.#root = resolve(workspaceRoot);
  }

  resolveSafe(uriPath: string): string {
    const cleaned = uriPath.replace(/^\/+/, '');
    const candidate = resolve(this.#root, normalize(cleaned));
    const rel = relative(this.#root, candidate);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path traversal blocked by DevPlaneFsProvider: ${uriPath}`);
    }
    return candidate;
  }

  stat(uriPath: string): { type: 'file' | 'directory'; size: number; mtime: number } {
    const p = this.resolveSafe(uriPath);
    const st = statSync(p);
    return {
      type: st.isDirectory() ? 'directory' : 'file',
      size: st.size,
      mtime: Math.trunc(st.mtimeMs),
    };
  }

  readDirectory(uriPath: string): Array<[string, 'file' | 'directory']> {
    const p = this.resolveSafe(uriPath);
    return readdirSync(p, { withFileTypes: true }).map((d) => [
      d.name,
      d.isDirectory() ? 'directory' : 'file',
    ]);
  }

  readFile(uriPath: string): Uint8Array {
    return new Uint8Array(readFileSync(this.resolveSafe(uriPath)));
  }

  writeFile(uriPath: string, content: Uint8Array): void {
    const p = this.resolveSafe(uriPath);
    const parent = dirname(p);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(p, content);
  }

  delete(uriPath: string): void {
    unlinkSync(this.resolveSafe(uriPath));
  }
}

export class DevPlanePtyProvider {
  readonly #emit: (frame: DevPlaneFrame) => void;
  readonly #sessions = new Map<string, { id: string; cwd: string; history: string[] }>();

  constructor(emit: (frame: DevPlaneFrame) => void) {
    this.#emit = emit;
  }

  openSession(id: string, cwd: string): { id: string; cwd: string } {
    this.#sessions.set(id, { id, cwd, history: [] });
    this.#emit({
      v: 1,
      channel: 'command',
      topic: 'b8g.pty.open',
      ts: Date.now(),
      payload: { id, cwd, transport: 'ttyS0' },
    });
    return { id, cwd };
  }

  sendInput(id: string, data: string): void {
    const s = this.#sessions.get(id);
    if (!s) throw new Error(`Unknown PTY session: ${id}`);
    s.history.push(data);
    this.#emit({
      v: 1,
      channel: 'command',
      topic: 'b8g.pty.input',
      ts: Date.now(),
      payload: { id, data },
    });
  }

  closeSession(id: string): void {
    if (!this.#sessions.delete(id)) return;
    this.#emit({
      v: 1,
      channel: 'command',
      topic: 'b8g.pty.close',
      ts: Date.now(),
      payload: { id },
    });
  }
}
