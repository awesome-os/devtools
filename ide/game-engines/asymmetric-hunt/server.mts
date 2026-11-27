#!/usr/bin/env node
/**
 * @file server.mts
 * @description Room-based LAN Multiplayer & Solo-vs-Bots Game Server for
 * `b8g-asymmetric-hunt` (Humans vs. Monsters 3D).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AsymmetricHuntWorld,
  type GameModePreset,
  type ObjectiveNode,
  type PlayerInput,
  type TraversalPortal,
  type WallBox,
} from './index.mts';
import { stepAllBots } from './ai-bots.mts';
import { scanHuntGlbAssets } from './glb-loader.mts';
import { renderAsymmetricHuntHtml } from './renderer-3d.mts';

interface HuntRoom {
  id: string;
  world: AsymmetricHuntWorld;
  playerInputs: Map<string, PlayerInput>;
  lastActiveMs: number;
}

function getLocalLanIp(): string {
  const nets = networkInterfaces();
  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family === 'IPv4' && !info.internal) {
        return info.address;
      }
    }
  }
  return '127.0.0.1';
}

export async function startAsymmetricHuntServer(opts: {
  host?: string;
  port?: number;
} = {}): Promise<{ url: string; lanUrl: string; close: () => Promise<void> }> {
  const host = opts.host ?? '0.0.0.0';
  const port = opts.port ?? 7495;
  const rooms = new Map<string, HuntRoom>();

  function getOrCreateRoom(roomId: string, mode: GameModePreset = 'compound-3v4'): HuntRoom {
    const cleanId = roomId.trim() || 'default';
    let r = rooms.get(cleanId);
    if (!r) {
      r = {
        id: cleanId,
        world: new AsymmetricHuntWorld(mode),
        playerInputs: new Map(),
        lastActiveMs: Date.now(),
      };
      rooms.set(cleanId, r);
    }
    r.lastActiveMs = Date.now();
    return r;
  }

  // Deterministic 30 Hz server simulation loop for all active rooms
  const tickTimer = setInterval(() => {
    const dt = 1 / 30;
    for (const room of rooms.values()) {
      for (const [actorId, inp] of room.playerInputs.entries()) {
        room.world.applyActorInput(actorId, inp, dt);
      }
      stepAllBots(room.world, dt);
      room.world.step(dt);
    }
  }, 33);

  const lanIp = getLocalLanIp();
  let actualPort = port;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'https://asymmetric-hunt.b8g.invalid');

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderAsymmetricHuntHtml(`${lanIp}:${actualPort}`));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/assets') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(scanHuntGlbAssets()));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/rooms') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            lanUrl: `http://${lanIp}:${actualPort}`,
            rooms: [...rooms.values()].map((r) => ({
              id: r.id,
              mode: r.world.mode,
              phase: r.world.phase,
              tick: r.world.tick,
            })),
          }),
        );
        return;
      }

      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};

      if (req.method === 'POST' && url.pathname === '/api/room/join') {
        const roomId = String(body.roomId ?? 'default');
        const mode = (body.mode === 'trials-1v4' ? 'trials-1v4' : 'compound-3v4') as GameModePreset;
        const room = getOrCreateRoom(roomId, mode);
        if (room.world.mode !== mode && room.playerInputs.size === 0) {
          room.world.reset(mode);
        }

        const preferred = String(body.preferredActorId ?? 'h-1');
        const playerName = String(body.playerName ?? 'Player');
        let assigned = room.world.actors.get(preferred);
        if (!assigned || !assigned.isBot) {
          // Pick any available bot slot of the same role (or any bot)
          const wantRole = preferred.startsWith('m-') ? 'monster' : 'human';
          assigned =
            [...room.world.actors.values()].find((a) => a.isBot && a.role === wantRole) ??
            [...room.world.actors.values()].find((a) => a.isBot) ??
            [...room.world.actors.values()][0];
        }
        if (assigned) {
          room.world.assignPlayer(assigned.id, playerName);
          room.playerInputs.set(assigned.id, { forward: 0, strafe: 0, yaw: assigned.yaw });
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ roomId: room.id, actorId: assigned?.id ?? null, snapshot: room.world.getSnapshot() }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/room/input') {
        const roomId = String(body.roomId ?? 'default');
        const actorId = String(body.actorId ?? '');
        const room = getOrCreateRoom(roomId);
        if (actorId && body.input && typeof body.input === 'object') {
          room.playerInputs.set(actorId, body.input as PlayerInput);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(room.world.getSnapshot()));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/room/skillcheck') {
        const roomId = String(body.roomId ?? 'default');
        const actorId = String(body.actorId ?? '');
        const outcome = body.outcome === 'great' ? 'great' : body.outcome === 'good' ? 'good' : 'miss';
        const room = getOrCreateRoom(roomId);
        const result = room.world.applySkillCheckResult(actorId, outcome);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...result, snapshot: room.world.getSnapshot() }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/room/custom-map') {
        const roomId = String(body.roomId ?? 'default');
        const room = getOrCreateRoom(roomId);
        room.world.loadCustomMap({
          walls: Array.isArray(body.walls) ? (body.walls as WallBox[]) : undefined,
          portals: Array.isArray(body.portals) ? (body.portals as TraversalPortal[]) : undefined,
          objectives: Array.isArray(body.objectives) ? (body.objectives as ObjectiveNode[]) : undefined,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, snapshot: room.world.getSnapshot() }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/room/reset') {
        const roomId = String(body.roomId ?? 'default');
        const mode = (body.mode === 'trials-1v4' ? 'trials-1v4' : 'compound-3v4') as GameModePreset;
        const room = getOrCreateRoom(roomId, mode);
        const humanIds = [...room.playerInputs.keys()];
        room.world.reset(mode);
        for (const id of humanIds) {
          room.world.assignPlayer(id);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, snapshot: room.world.getSnapshot() }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(port, host, () => res());
  });

  const addr = server.address();
  actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    // b8g-allow-http-ipc: externalWeb=true — browser-facing LAN multiplayer 3D game web server preview URL
    url: `http://127.0.0.1:${actualPort}`,
    lanUrl: `http://${lanIp}:${actualPort}`,
    close: () =>
      new Promise<void>((res) => {
        clearInterval(tickTimer);
        server.close(() => res());
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const srv = await startAsymmetricHuntServer({ port: 7495 });
  console.log(`[b8g-asymmetric-hunt] 3D Engine & LAN Server listening at ${srv.url} (LAN: ${srv.lanUrl})`);
}
