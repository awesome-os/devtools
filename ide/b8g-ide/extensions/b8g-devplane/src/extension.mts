/**
 * @file sections/b8g-ide/extensions/b8g-devplane/src/extension.mts
 * @description Standard VS Code Extension bridging unmodified VS Code OSS (WebRenderer or Desktop)
 * to the Sectium DevPlane: env, B8G_DISPLAY_V1 display surfaces, b8g-devplane:// FS, ttyS0 terminal,
 * and cross-tab DevTools ReadableStream.
 */
import {
  DevPlaneDisplayProvider,
  DevPlaneEnvProvider,
  DevPlaneFsProvider,
  DevPlanePtyProvider,
  type DevPlaneEnvSnapshot,
  type DevPlaneFrame,
  type DisplaySurfaceDescriptor,
} from '../../../devplane/protocol.mts';

export interface DisposableLike {
  dispose(): void;
}

export interface VsCodeUriLike {
  readonly scheme: string;
  readonly path: string;
}

export interface VsCodeFileSystemProviderLike {
  stat(uri: VsCodeUriLike): { type: number; ctime: number; mtime: number; size: number };
  readDirectory(uri: VsCodeUriLike): Array<[string, number]>;
  readFile(uri: VsCodeUriLike): Uint8Array;
  writeFile(uri: VsCodeUriLike, content: Uint8Array): void;
  delete(uri: VsCodeUriLike): void;
}

export interface VsCodePseudoterminalLike {
  open(): void;
  close(): void;
  handleInput(data: string): void;
}

export interface VsCodeApiSubset {
  workspace: {
    registerFileSystemProvider(scheme: string, provider: VsCodeFileSystemProviderLike): DisposableLike;
  };
  commands: {
    registerCommand(command: string, callback: (...args: unknown[]) => unknown): DisposableLike;
  };
  window: {
    registerTerminalProfileProvider(
      id: string,
      provider: { provideTerminalProfile(): { name: string; pty: VsCodePseudoterminalLike } }
    ): DisposableLike;
    showInformationMessage(message: string): void;
  };
}

export interface ExtensionContextLike {
  subscriptions: DisposableLike[];
  workspaceRoot?: string;
  baselineTag?: string;
}

export interface DevPlaneExtensionExports {
  readonly env: DevPlaneEnvProvider;
  readonly display: DevPlaneDisplayProvider;
  readonly fs: DevPlaneFsProvider;
  readonly pty: DevPlanePtyProvider;
  readonly primarySurface: DisplaySurfaceDescriptor;
  createEventStream(): ReadableStream<DevPlaneFrame>;
  getEnvSnapshot(): DevPlaneEnvSnapshot;
}

const VSCODE_FILE_TYPE_FILE = 1;
const VSCODE_FILE_TYPE_DIRECTORY = 2;

export function activate(
  context: ExtensionContextLike,
  vscodeApi: VsCodeApiSubset
): DevPlaneExtensionExports {
  const workspaceRoot = context.workspaceRoot ?? process.cwd();
  const listeners = new Set<(frame: DevPlaneFrame) => void>();
  const recentFrames: DevPlaneFrame[] = [];

  const emit = (frame: DevPlaneFrame): void => {
    recentFrames.push(frame);
    if (recentFrames.length > 256) recentFrames.shift();
    for (const fn of listeners) fn(frame);
  };

  const env = new DevPlaneEnvProvider({
    workspaceRoot,
    baselineTag: context.baselineTag ?? 'v0.5.0-baseline',
  });
  const display = new DevPlaneDisplayProvider(emit);
  const fs = new DevPlaneFsProvider(workspaceRoot);
  const pty = new DevPlanePtyProvider(emit);

  // Allocate primary pure-art WebRenderer workbench surface
  let primarySurface = display.createSurface('B8G IDE — Lumi White Dragon', 1440, 900, '2d');

  // 1. Register `b8g-devplane://` FileSystemProvider
  const fsDisposable = vscodeApi.workspace.registerFileSystemProvider('b8g-devplane', {
    stat(uri) {
      const st = fs.stat(uri.path);
      return {
        type: st.type === 'directory' ? VSCODE_FILE_TYPE_DIRECTORY : VSCODE_FILE_TYPE_FILE,
        ctime: st.mtime,
        mtime: st.mtime,
        size: st.size,
      };
    },
    readDirectory(uri) {
      return fs
        .readDirectory(uri.path)
        .map(([name, kind]) => [name, kind === 'directory' ? VSCODE_FILE_TYPE_DIRECTORY : VSCODE_FILE_TYPE_FILE]);
    },
    readFile(uri) {
      return fs.readFile(uri.path);
    },
    writeFile(uri, content) {
      fs.writeFile(uri.path, content);
    },
    delete(uri) {
      fs.delete(uri.path);
    },
  });

  // 2. Register `b8g-devplane.tty` Terminal Profile Provider (strictly channel='command')
  let ptyCounter = 1;
  const termDisposable = vscodeApi.window.registerTerminalProfileProvider('b8g-devplane.tty', {
    provideTerminalProfile() {
      const sessionId = `tty-${ptyCounter++}`;
      const ptyImpl: VsCodePseudoterminalLike = {
        open() {
          pty.openSession(sessionId, workspaceRoot);
        },
        close() {
          pty.closeSession(sessionId);
        },
        handleInput(data: string) {
          pty.sendInput(sessionId, data);
        },
      };
      return { name: 'B8G DevPlane (ttyS0)', pty: ptyImpl };
    },
  });

  // 3. Register DevPlane Commands
  const cmdEnv = vscodeApi.commands.registerCommand('b8g.devplane.showEnv', () => {
    const snap = env.snapshot();
    vscodeApi.window.showInformationMessage(
      `B8G DevPlane | Baseline=${snap.baselineTag} | Brand=${snap.brand} | Pipe=${snap.pipePath}`
    );
    return snap;
  });

  const cmdRebind = vscodeApi.commands.registerCommand('b8g.devplane.rebindDisplayMode', () => {
    const nextMode = primarySurface.mode === '2d' ? '3d' : '2d';
    primarySurface = display.rebindMode(primarySurface.surfaceId, nextMode);
    return primarySurface;
  });

  const cmdTerm = vscodeApi.commands.registerCommand('b8g.devplane.openTerminal', () => {
    const sessionId = `tty-${ptyCounter++}`;
    return pty.openSession(sessionId, workspaceRoot);
  });

  context.subscriptions.push(fsDisposable, termDisposable, cmdEnv, cmdRebind, cmdTerm);

  return {
    env,
    display,
    fs,
    pty,
    get primarySurface() {
      return primarySurface;
    },
    createEventStream(): ReadableStream<DevPlaneFrame> {
      let handler: ((frame: DevPlaneFrame) => void) | null = null;
      return new ReadableStream<DevPlaneFrame>({
        start(controller) {
          for (const frame of recentFrames) controller.enqueue(frame);
          handler = (frame) => controller.enqueue(frame);
          listeners.add(handler);
        },
        cancel() {
          if (handler) listeners.delete(handler);
        },
      });
    },
    getEnvSnapshot() {
      return env.snapshot();
    },
  };
}

export function deactivate(): void {
  // Subscriptions are disposed cleanly by VS Code host.
}
