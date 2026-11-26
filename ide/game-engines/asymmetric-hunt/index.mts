/**
 * @file index.mts
 * @description Canonical 7-Tuple Algebraic Intersection for `b8g-asymmetric-hunt`:
 * a reusable 3D Asymmetric Survival-Hunt Game Engine (Humans vs. Monsters, 100% original IP).
 *
 * Algebra:
 *   B8gGameEngine ^ StealthNoiseSense ^ ObjectiveEscapeGraph ^ TraversalChasePhysics ^ AsymmetricRoleRoster
 *
 * Supports both:
 *   - `compound-3v4` (3 specialized Monsters vs. 4 Humans, multi-exit compound with gaps/crawls/locks/fuse/valve)
 *   - `trials-1v4`   (1 Apex Monster vs. 4 Humans, chase loops with vaults/pallets/generators/exit gates)
 */
import {
  defineSection,
  f,
  p,
  s,
  type ExecutionContext,
} from '../b8g-game-engine/stealify-schema-shim.mts';

export const ASYMMETRIC_HUNT_CONTEXT: ExecutionContext = {
  boundary: 'host',
  display: 'window',
  lifetime: 'session',
  transport: 'sab',
  capabilities: { fs: false, net: true, proc: false },
  locality: 'local-host',
  persona: 'consumer',
};

export const B8gAsymmetricHuntSection = defineSection({
  id: 'b8g.asymmetric.hunt',
  version: '1.0.0',
  kind: 'game-sim',
  shape: { tickHz: 60, deterministic: true, renderer: 'webgl2' },
  description:
    'Reusable 3D Asymmetric Survival-Hunt Game Engine (Humans vs. Monsters) supporting 3v4 Compound & 1v4 Trials modes, OBB traversal, acoustic stealth, AI bots, and LAN multiplayer.',
  context: ASYMMETRIC_HUNT_CONTEXT,
  storage: s.sabRing({ capacityBytes: 256 * 1024 }),
  fields: {
    mode: f.string({ default: 'compound-3v4' }),
    tickCount: f.int32({ default: 0 }),
    humansAlive: f.int32({ default: 4 }),
    humansEscaped: f.int32({ default: 0 }),
    matchPhase: f.string({ default: 'lobby' }),
  },
  protocols: {
    input: p.input('rpc', 'b8g.hunt.input'),
    snapshot: p.output('stream', 'b8g.hunt.snapshot'),
  },
});

export type GameModePreset = 'compound-3v4' | 'trials-1v4';
export type RoleKind = 'human' | 'monster';
export type MonsterClass = 'stalker' | 'goliath' | 'echo';
export type BodyClass = 'light' | 'medium' | 'heavy';
export type MatchPhase = 'lobby' | 'playing' | 'humans-win' | 'monsters-win';

export interface WallBox {
  id: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  kind: 'wall' | 'pillar' | 'house' | 'fence' | 'cover';
  color: [number, number, number];
}

export interface TraversalPortal {
  id: string;
  kind: 'gap' | 'crawl' | 'vault' | 'pallet' | 'door';
  x: number;
  z: number;
  exitX: number;
  exitZ: number;
  allowedBodies: BodyClass[];
  breakableByHeavy: boolean;
  broken: boolean;
  dropped: boolean;
  locked: boolean;
}

export interface ObjectiveNode {
  id: string;
  label: string;
  kind: 'lock-gate' | 'fuse-box' | 'valve' | 'generator' | 'exit-gate';
  x: number;
  z: number;
  progress: number;
  completed: boolean;
  opensExitId?: string;
  unlocked?: boolean;
}

export interface NoiseRipple {
  id: number;
  x: number;
  z: number;
  radius: number;
  intensity: number;
  ttl: number;
  sourceId: string;
  kind: 'sprint' | 'interact' | 'pallet' | 'sonar' | 'exit-alarm';
}

export interface ActorState {
  id: string;
  name: string;
  role: RoleKind;
  monsterClass?: MonsterClass;
  bodyClass: BodyClass;
  isBot: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  health: number;
  maxHealth: number;
  stamina: number;
  maxStamina: number;
  crouching: boolean;
  sprinting: boolean;
  stealthFactor: number;
  heartbeat: number;
  revealedTimer: number;
  status: 'alive' | 'downed' | 'captured' | 'escaped';
  attackCooldown: number;
  abilityCooldown: number;
  stunTimer: number;
  interactTargetId: string | null;
}

export interface PlayerInput {
  forward: number; // -1..1
  strafe: number; // -1..1
  yaw: number;
  sprint?: boolean;
  crouch?: boolean;
  interact?: boolean;
  attack?: boolean;
  ability?: boolean;
}

export interface HuntSnapshot {
  mode: GameModePreset;
  tick: number;
  elapsedSec: number;
  phase: MatchPhase;
  arenaSize: number;
  walls: WallBox[];
  portals: TraversalPortal[];
  objectives: ObjectiveNode[];
  ripples: NoiseRipple[];
  actors: ActorState[];
  events: string[];
}

const ARENA_HALF = 36;
const ACTOR_RADIUS = 0.55;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist2D(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

export function buildMapLayout(mode: GameModePreset): {
  walls: WallBox[];
  portals: TraversalPortal[];
  objectives: ObjectiveNode[];
} {
  const walls: WallBox[] = [
    // Perimeter boundary walls
    { id: 'bound-n', x: 0, y: 2.5, z: -ARENA_HALF, w: ARENA_HALF * 2, h: 5, d: 1.2, kind: 'fence', color: [0.22, 0.24, 0.28] },
    { id: 'bound-s', x: 0, y: 2.5, z: ARENA_HALF, w: ARENA_HALF * 2, h: 5, d: 1.2, kind: 'fence', color: [0.22, 0.24, 0.28] },
    { id: 'bound-w', x: -ARENA_HALF, y: 2.5, z: 0, w: 1.2, h: 5, d: ARENA_HALF * 2, kind: 'fence', color: [0.22, 0.24, 0.28] },
    { id: 'bound-e', x: ARENA_HALF, y: 2.5, z: 0, w: 1.2, h: 5, d: ARENA_HALF * 2, kind: 'fence', color: [0.22, 0.24, 0.28] },

    // Central Compound House (4 segmented walls with doorways & gap slots)
    { id: 'house-n1', x: -7, y: 2.2, z: -10, w: 9, h: 4.4, d: 0.9, kind: 'house', color: [0.34, 0.27, 0.22] },
    { id: 'house-n2', x: 7, y: 2.2, z: -10, w: 9, h: 4.4, d: 0.9, kind: 'house', color: [0.34, 0.27, 0.22] },
    { id: 'house-s1', x: -7, y: 2.2, z: 10, w: 9, h: 4.4, d: 0.9, kind: 'house', color: [0.34, 0.27, 0.22] },
    { id: 'house-s2', x: 7, y: 2.2, z: 10, w: 9, h: 4.4, d: 0.9, kind: 'house', color: [0.34, 0.27, 0.22] },
    { id: 'house-w1', x: -11.5, y: 2.2, z: -5.5, w: 0.9, h: 4.4, d: 8.5, kind: 'house', color: [0.32, 0.25, 0.20] },
    { id: 'house-w2', x: -11.5, y: 2.2, z: 5.5, w: 0.9, h: 4.4, d: 8.5, kind: 'house', color: [0.32, 0.25, 0.20] },
    { id: 'house-e1', x: 11.5, y: 2.2, z: -5.5, w: 0.9, h: 4.4, d: 8.5, kind: 'house', color: [0.32, 0.25, 0.20] },
    { id: 'house-e2', x: 11.5, y: 2.2, z: 5.5, w: 0.9, h: 4.4, d: 8.5, kind: 'house', color: [0.32, 0.25, 0.20] },

    // Interior partition wall with squeeze gap
    { id: 'house-mid-w', x: -4.5, y: 2.0, z: 0, w: 7, h: 4.0, d: 0.7, kind: 'wall', color: [0.28, 0.24, 0.22] },
    { id: 'house-mid-e', x: 5.5, y: 2.0, z: 0, w: 6, h: 4.0, d: 0.7, kind: 'wall', color: [0.28, 0.24, 0.22] },

    // Yard outbuildings / jungle-gym chase loops
    { id: 'barn-nw-1', x: -24, y: 1.9, z: -22, w: 8, h: 3.8, d: 0.8, kind: 'wall', color: [0.26, 0.28, 0.30] },
    { id: 'barn-nw-2', x: -20, y: 1.9, z: -16, w: 0.8, h: 3.8, d: 8, kind: 'wall', color: [0.26, 0.28, 0.30] },
    { id: 'shed-ne-1', x: 23, y: 1.9, z: -21, w: 9, h: 3.8, d: 0.8, kind: 'wall', color: [0.28, 0.26, 0.24] },
    { id: 'shed-ne-2', x: 27, y: 1.9, z: -15, w: 0.8, h: 3.8, d: 9, kind: 'wall', color: [0.28, 0.26, 0.24] },
    { id: 'loop-sw-1', x: -23, y: 1.7, z: 22, w: 9, h: 3.4, d: 0.8, kind: 'wall', color: [0.24, 0.27, 0.25] },
    { id: 'loop-sw-2', x: -27, y: 1.7, z: 16, w: 0.8, h: 3.4, d: 8, kind: 'wall', color: [0.24, 0.27, 0.25] },
    { id: 'loop-se-1', x: 22, y: 1.7, z: 22, w: 9, h: 3.4, d: 0.8, kind: 'wall', color: [0.25, 0.24, 0.29] },
    { id: 'loop-se-2', x: 18, y: 1.7, z: 16, w: 0.8, h: 3.4, d: 8, kind: 'wall', color: [0.25, 0.24, 0.29] },

    // Shadow foliage / stealth cover rocks
    { id: 'cover-1', x: -16, y: 0.9, z: 0, w: 3.2, h: 1.8, d: 3.2, kind: 'cover', color: [0.16, 0.25, 0.17] },
    { id: 'cover-2', x: 16, y: 0.9, z: 0, w: 3.2, h: 1.8, d: 3.2, kind: 'cover', color: [0.16, 0.25, 0.17] },
    { id: 'cover-3', x: 0, y: 0.9, z: -22, w: 3.6, h: 1.8, d: 2.6, kind: 'cover', color: [0.16, 0.25, 0.17] },
    { id: 'cover-4', x: 0, y: 0.9, z: 22, w: 3.6, h: 1.8, d: 2.6, kind: 'cover', color: [0.16, 0.25, 0.17] },
  ];

  const portals: TraversalPortal[] = [
    { id: 'gap-house-mid', kind: 'gap', x: 0.5, z: -1.3, exitX: 0.5, exitZ: 1.3, allowedBodies: ['light'], breakableByHeavy: false, broken: false, dropped: false, locked: false },
    { id: 'crawl-house-w', kind: 'crawl', x: -12.6, z: 0, exitX: -10.2, exitZ: 0, allowedBodies: ['light'], breakableByHeavy: true, broken: false, dropped: false, locked: false },
    { id: 'vault-house-e', kind: 'vault', x: 10.2, z: 0, exitX: 12.6, exitZ: 0, allowedBodies: ['light', 'medium'], breakableByHeavy: false, broken: false, dropped: false, locked: false },
    { id: 'pallet-nw', kind: 'pallet', x: -19.5, z: -21.5, exitX: -19.5, exitZ: -19.5, allowedBodies: ['light', 'medium', 'heavy'], breakableByHeavy: true, broken: false, dropped: false, locked: false },
    { id: 'pallet-se', kind: 'pallet', x: 17.5, z: 21.5, exitX: 17.5, exitZ: 19.5, allowedBodies: ['light', 'medium', 'heavy'], breakableByHeavy: true, broken: false, dropped: false, locked: false },
    { id: 'door-house-n', kind: 'door', x: 0, z: -11.2, exitX: 0, exitZ: -8.8, allowedBodies: ['light', 'medium', 'heavy'], breakableByHeavy: true, broken: false, dropped: false, locked: true },
  ];

  const objectives: ObjectiveNode[] =
    mode === 'compound-3v4'
      ? [
          { id: 'obj-fuse', label: 'Basement Fuse Box', kind: 'fuse-box', x: -6, z: -5, progress: 0, completed: false, opensExitId: 'exit-north' },
          { id: 'obj-valve', label: 'Pressure Valve Tank', kind: 'valve', x: 24, z: -16, progress: 0, completed: false, opensExitId: 'exit-east' },
          { id: 'obj-battery', label: 'Yard Car Battery', kind: 'lock-gate', x: -24, z: 18, progress: 0, completed: false, opensExitId: 'exit-west' },
          { id: 'obj-gen', label: 'South Floodlight Gen', kind: 'generator', x: 20, z: 18, progress: 0, completed: false, opensExitId: 'exit-south' },
          { id: 'exit-north', label: 'North Road Gate', kind: 'exit-gate', x: 0, z: -34.2, progress: 0, completed: false, unlocked: false },
          { id: 'exit-south', label: 'South Forest Gate', kind: 'exit-gate', x: 0, z: 34.2, progress: 0, completed: false, unlocked: false },
          { id: 'exit-west', label: 'West Service Exit', kind: 'exit-gate', x: -34.2, z: 0, progress: 0, completed: false, unlocked: false },
          { id: 'exit-east', label: 'East Pressure Gate', kind: 'exit-gate', x: 34.2, z: 0, progress: 0, completed: false, unlocked: false },
        ]
      : [
          { id: 'gen-1', label: 'Generator Alpha (House)', kind: 'generator', x: 0, z: 5, progress: 0, completed: false },
          { id: 'gen-2', label: 'Generator Beta (NW Barn)', kind: 'generator', x: -24, z: -18, progress: 0, completed: false },
          { id: 'gen-3', label: 'Generator Gamma (NE Shed)', kind: 'generator', x: 23, z: -17, progress: 0, completed: false },
          { id: 'gen-4', label: 'Generator Delta (SW Yard)', kind: 'generator', x: -23, z: 18, progress: 0, completed: false },
          { id: 'gen-5', label: 'Generator Epsilon (SE Yard)', kind: 'generator', x: 22, z: 18, progress: 0, completed: false },
          { id: 'exit-north', label: 'North Trial Gate', kind: 'exit-gate', x: 0, z: -34.2, progress: 0, completed: false, unlocked: false },
          { id: 'exit-south', label: 'South Trial Gate', kind: 'exit-gate', x: 0, z: 34.2, progress: 0, completed: false, unlocked: false },
        ];

  return { walls, portals, objectives };
}

export class AsymmetricHuntWorld {
  mode: GameModePreset;
  tick = 0;
  elapsedSec = 0;
  phase: MatchPhase = 'playing';
  walls: WallBox[] = [];
  portals: TraversalPortal[] = [];
  objectives: ObjectiveNode[] = [];
  ripples: NoiseRipple[] = [];
  actors: Map<string, ActorState> = new Map();
  events: string[] = [];
  #nextRippleId = 1;

  constructor(mode: GameModePreset = 'compound-3v4') {
    this.mode = mode;
    this.reset(mode);
  }

  reset(mode: GameModePreset = this.mode): void {
    this.mode = mode;
    this.tick = 0;
    this.elapsedSec = 0;
    this.phase = 'playing';
    this.ripples = [];
    this.events = [`Match started (${mode === 'compound-3v4' ? '3v4 Compound' : '1v4 Trials'})`];
    const layout = buildMapLayout(mode);
    this.walls = layout.walls;
    this.portals = layout.portals;
    this.objectives = layout.objectives;
    this.actors.clear();

    // Spawn Monsters
    const monsterRoster: Array<{ id: string; name: string; cls: MonsterClass; body: BodyClass; x: number; z: number }> =
      mode === 'compound-3v4'
        ? [
            { id: 'm-stalker', name: 'The Stalker', cls: 'stalker', body: 'light', x: -4, z: -18 },
            { id: 'm-goliath', name: 'The Goliath', cls: 'goliath', body: 'heavy', x: 0, z: 0 },
            { id: 'm-echo', name: 'The Echo', cls: 'echo', body: 'medium', x: 18, z: -6 },
          ]
        : [{ id: 'm-goliath', name: 'The Apex Stalker', cls: 'stalker', body: 'medium', x: 0, z: -24 }];

    for (const m of monsterRoster) {
      this.actors.set(m.id, {
        id: m.id,
        name: m.name,
        role: 'monster',
        monsterClass: m.cls,
        bodyClass: m.body,
        isBot: true,
        x: m.x,
        y: 0,
        z: m.z,
        yaw: 0,
        vx: 0,
        vz: 0,
        health: 999,
        maxHealth: 999,
        stamina: 100,
        maxStamina: 100,
        crouching: false,
        sprinting: false,
        stealthFactor: 1,
        heartbeat: 0,
        revealedTimer: 0,
        status: 'alive',
        attackCooldown: 0,
        abilityCooldown: 0,
        stunTimer: 0,
        interactTargetId: null,
      });
    }

    // Spawn 4 Humans
    const humanSpawns = [
      { id: 'h-1', name: 'Alex (Scout)', x: -28, z: 28 },
      { id: 'h-2', name: 'Maya (Tech)', x: 28, z: 28 },
      { id: 'h-3', name: 'Liam (Runner)', x: -28, z: -28 },
      { id: 'h-4', name: 'Zoe (Medic)', x: 28, z: -28 },
    ];
    for (const h of humanSpawns) {
      this.actors.set(h.id, {
        id: h.id,
        name: h.name,
        role: 'human',
        bodyClass: 'light',
        isBot: true,
        x: h.x,
        y: 0,
        z: h.z,
        yaw: Math.atan2(-h.x, -h.z),
        vx: 0,
        vz: 0,
        health: 100,
        maxHealth: 100,
        stamina: 100,
        maxStamina: 100,
        crouching: false,
        sprinting: false,
        stealthFactor: 1,
        heartbeat: 0,
        revealedTimer: 0,
        status: 'alive',
        attackCooldown: 0,
        abilityCooldown: 0,
        stunTimer: 0,
        interactTargetId: null,
      });
    }
  }

  assignPlayer(actorId: string, playerName?: string): ActorState | null {
    const a = this.actors.get(actorId);
    if (!a) return null;
    a.isBot = false;
    if (playerName) a.name = playerName;
    return a;
  }

  applySkillCheckResult(actorId: string, outcome: 'great' | 'good' | 'miss'): { ok: boolean; progress?: number } {
    const actor = this.actors.get(actorId);
    if (!actor || actor.role !== 'human' || actor.status !== 'alive') return { ok: false };

    // Resolve active or nearest uncompleted objective
    const obj =
      (actor.interactTargetId
        ? this.objectives.find((o) => o.id === actor.interactTargetId && o.kind !== 'exit-gate' && !o.completed)
        : undefined) ??
      this.objectives.find(
        (o) => o.kind !== 'exit-gate' && !o.completed && dist2D(actor.x, actor.z, o.x, o.z) < 3.4,
      );
    if (!obj) return { ok: false };

    if (outcome === 'great') {
      obj.progress = clamp(obj.progress + 0.18, 0, 1);
      this.pushEvent(`${actor.name} nailed a GREAT skill check on ${obj.label} (+18%)!`);
    } else if (outcome === 'good') {
      obj.progress = clamp(obj.progress + 0.08, 0, 1);
      this.pushEvent(`${actor.name} hit a Good skill check on ${obj.label} (+8%).`);
    } else {
      obj.progress = clamp(obj.progress - 0.1, 0, 1);
      this.emitNoise(obj.x, obj.z, 28, 1.0, actor.id, 'interact');
      this.pushEvent(`${actor.name} MISSED skill check on ${obj.label} — LOUD EXPLOSION!`);
    }

    if (obj.progress >= 1 && !obj.completed) {
      obj.completed = true;
      this.emitNoise(obj.x, obj.z, 26, 1.0, actor.id, 'exit-alarm');
      this.onObjectiveCompleted(obj);
    }
    return { ok: true, progress: obj.progress };
  }

  loadCustomMap(custom: {
    walls?: WallBox[];
    portals?: TraversalPortal[];
    objectives?: ObjectiveNode[];
  }): void {
    const base = buildMapLayout(this.mode);
    // Always preserve outer perimeter walls so actors cannot fall out of arena
    const perimeter = base.walls.filter((w) => w.id.startsWith('bound-'));
    if (Array.isArray(custom.walls) && custom.walls.length > 0) {
      this.walls = [...perimeter, ...custom.walls.filter((w) => !w.id.startsWith('bound-'))];
    }
    if (Array.isArray(custom.portals) && custom.portals.length > 0) {
      this.portals = custom.portals;
    }
    if (Array.isArray(custom.objectives) && custom.objectives.length > 0) {
      this.objectives = custom.objectives;
    }
    this.pushEvent(
      `Custom Map hot-loaded (${this.walls.length} walls, ${this.portals.length} portals, ${this.objectives.length} objectives)!`,
    );
  }

  emitNoise(x: number, z: number, radius: number, intensity: number, sourceId: string, kind: NoiseRipple['kind']): void {
    this.ripples.push({
      id: this.#nextRippleId++,
      x,
      z,
      radius,
      intensity,
      ttl: 3.0,
      sourceId,
      kind,
    });
    if (this.ripples.length > 32) this.ripples.shift();
  }

  pushEvent(msg: string): void {
    this.events.push(msg);
    if (this.events.length > 10) this.events.shift();
  }

  private resolveCollisions(x: number, z: number): { x: number; z: number } {
    let rx = clamp(x, -ARENA_HALF + 1.2, ARENA_HALF - 1.2);
    let rz = clamp(z, -ARENA_HALF + 1.2, ARENA_HALF - 1.2);

    for (const w of this.walls) {
      const halfW = w.w * 0.5 + ACTOR_RADIUS;
      const halfD = w.d * 0.5 + ACTOR_RADIUS;
      const dx = rx - w.x;
      const dz = rz - w.z;
      if (Math.abs(dx) < halfW && Math.abs(dz) < halfD) {
        const penX = halfW - Math.abs(dx);
        const penZ = halfD - Math.abs(dz);
        if (penX < penZ) {
          rx += dx >= 0 ? penX : -penX;
        } else {
          rz += dz >= 0 ? penZ : -penZ;
        }
      }
    }

    // Dropped unbroken pallets block movement
    for (const p of this.portals) {
      if (p.kind === 'pallet' && p.dropped && !p.broken) {
        const d = dist2D(rx, rz, p.x, p.z);
        if (d < 1.35) {
          const nx = d > 0.001 ? (rx - p.x) / d : 1;
          const nz = d > 0.001 ? (rz - p.z) / d : 0;
          rx = p.x + nx * 1.35;
          rz = p.z + nz * 1.35;
        }
      }
    }

    return { x: rx, z: rz };
  }

  tryTraverseOrInteract(actor: ActorState, dt: number): boolean {
    // 1. Check Traversal Portals first
    for (const portal of this.portals) {
      const dEntry = dist2D(actor.x, actor.z, portal.x, portal.z);
      const dExit = dist2D(actor.x, actor.z, portal.exitX, portal.exitZ);
      const near = Math.min(dEntry, dExit) < 2.2;
      if (!near) continue;

      if (portal.kind === 'pallet' && !portal.dropped && !portal.broken && actor.role === 'human') {
        portal.dropped = true;
        this.emitNoise(portal.x, portal.z, 18, 1.0, actor.id, 'pallet');
        this.pushEvent(`${actor.name} slammed a pallet!`);
        // Stun any nearby monster
        for (const other of this.actors.values()) {
          if (other.role === 'monster' && dist2D(other.x, other.z, portal.x, portal.z) < 2.8) {
            other.stunTimer = 2.6;
            this.pushEvent(`${other.name} was stunned by the pallet!`);
          }
        }
        return true;
      }

      if (portal.dropped && !portal.broken && portal.breakableByHeavy && actor.role === 'monster') {
        portal.broken = true;
        this.emitNoise(portal.x, portal.z, 14, 0.8, actor.id, 'pallet');
        this.pushEvent(`${actor.name} smashed the barricade!`);
        return true;
      }

      if (portal.locked && actor.role === 'human') {
        portal.locked = false;
        this.pushEvent(`${actor.name} unlocked ${portal.id}`);
        return true;
      }

      if (!portal.broken && portal.allowedBodies.includes(actor.bodyClass)) {
        // Teleport smoothly across squeeze gap / crawl / vault
        if (dEntry <= dExit) {
          actor.x = portal.exitX;
          actor.z = portal.exitZ;
        } else {
          actor.x = portal.x;
          actor.z = portal.z;
        }
        actor.interactTargetId = portal.id;
        return true;
      }
    }

    // 2. Check Objectives (Humans repair/unlock)
    if (actor.role === 'human') {
      for (const obj of this.objectives) {
        if (obj.kind === 'exit-gate' || obj.completed) continue;
        if (dist2D(actor.x, actor.z, obj.x, obj.z) < 2.8) {
          actor.interactTargetId = obj.id;
          const rate = this.mode === 'compound-3v4' ? 0.22 : 0.16;
          obj.progress = clamp(obj.progress + rate * dt, 0, 1);
          if (this.tick % 45 === 0) {
            this.emitNoise(obj.x, obj.z, 10, 0.45, actor.id, 'interact');
          }
          if (obj.progress >= 1 && !obj.completed) {
            obj.completed = true;
            this.emitNoise(obj.x, obj.z, 26, 1.0, actor.id, 'exit-alarm');
            this.onObjectiveCompleted(obj);
          }
          return true;
        }
      }
    }

    actor.interactTargetId = null;
    return false;
  }

  private onObjectiveCompleted(obj: ObjectiveNode): void {
    if (this.mode === 'compound-3v4' && obj.opensExitId) {
      const exit = this.objectives.find((o) => o.id === obj.opensExitId);
      if (exit) {
        exit.unlocked = true;
        this.pushEvent(`${obj.label} done → ${exit.label} OPENED!`);
      }
      return;
    }

    // trials-1v4: completing 3 of 5 generators powers both trial gates
    const doneCount = this.objectives.filter((o) => o.kind === 'generator' && o.completed).length;
    this.pushEvent(`${obj.label} repaired (${doneCount}/3)`);
    if (doneCount >= 3) {
      for (const o of this.objectives) {
        if (o.kind === 'exit-gate') o.unlocked = true;
      }
      this.pushEvent('POWER RESTORED — All Exit Gates are OPEN!');
    }
  }

  applyActorInput(actorId: string, input: PlayerInput, dt: number): void {
    const actor = this.actors.get(actorId);
    if (!actor || actor.status !== 'alive') return;
    if (actor.stunTimer > 0) return;

    actor.yaw = input.yaw;
    actor.crouching = Boolean(input.crouch) && actor.role === 'human';
    const wantsSprint = Boolean(input.sprint) && !actor.crouching && actor.stamina > 8;
    actor.sprinting = wantsSprint && (Math.abs(input.forward) > 0.05 || Math.abs(input.strafe) > 0.05);

    const baseSpeed =
      actor.role === 'monster'
        ? actor.monsterClass === 'stalker'
          ? 7.2
          : actor.monsterClass === 'goliath'
            ? 6.1
            : 6.6
        : actor.crouching
          ? 3.1
          : actor.sprinting
            ? 6.8
            : 4.8;

    const fwdX = Math.sin(actor.yaw);
    const fwdZ = Math.cos(actor.yaw);
    const rightX = Math.cos(actor.yaw);
    const rightZ = -Math.sin(actor.yaw);

    let mx = fwdX * input.forward + rightX * input.strafe;
    let mz = fwdZ * input.forward + rightZ * input.strafe;
    const mag = Math.hypot(mx, mz);
    if (mag > 1) {
      mx /= mag;
      mz /= mag;
    }

    actor.vx = mx * baseSpeed;
    actor.vz = mz * baseSpeed;

    if (actor.sprinting) {
      actor.stamina = Math.max(0, actor.stamina - 22 * dt);
      if (actor.role === 'human' && this.tick % 24 === 0) {
        this.emitNoise(actor.x, actor.z, 13, 0.7, actor.id, 'sprint');
      }
    } else {
      actor.stamina = Math.min(actor.maxStamina, actor.stamina + 16 * dt);
    }

    const moved = this.resolveCollisions(actor.x + actor.vx * dt, actor.z + actor.vz * dt);
    actor.x = moved.x;
    actor.z = moved.z;

    // Stealth factor: crouching near cover drops visibility sharply
    let nearCover = false;
    for (const w of this.walls) {
      if (w.kind === 'cover' && dist2D(actor.x, actor.z, w.x, w.z) < 3.4) {
        nearCover = true;
        break;
      }
    }
    actor.stealthFactor = actor.crouching ? (nearCover ? 0.15 : 0.35) : actor.sprinting ? 1.0 : 0.7;

    if (input.interact) {
      this.tryTraverseOrInteract(actor, dt);
    } else {
      actor.interactTargetId = null;
    }

    // Monster Attack
    if (input.attack && actor.role === 'monster' && actor.attackCooldown <= 0) {
      actor.attackCooldown = 1.1;
      const dmg = actor.monsterClass === 'goliath' ? 50 : 34;
      const range = actor.monsterClass === 'goliath' ? 2.6 : 2.2;
      for (const target of this.actors.values()) {
        if (target.role === 'human' && target.status === 'alive') {
          if (dist2D(actor.x, actor.z, target.x, target.z) <= range) {
            target.health = Math.max(0, target.health - dmg);
            this.pushEvent(`${actor.name} struck ${target.name} (-${dmg} HP)`);
            if (target.health <= 0) {
              target.status = 'captured';
              this.pushEvent(`${target.name} was captured by ${actor.name}!`);
            }
            break;
          }
        }
      }
    }

    // Monster Special Ability
    if (input.ability && actor.role === 'monster' && actor.abilityCooldown <= 0) {
      actor.abilityCooldown = 8.0;
      if (actor.monsterClass === 'echo') {
        this.emitNoise(actor.x, actor.z, 34, 1.0, actor.id, 'sonar');
        let found = 0;
        for (const h of this.actors.values()) {
          if (h.role === 'human' && h.status === 'alive' && !h.crouching) {
            h.revealedTimer = 4.5;
            found++;
          }
        }
        this.pushEvent(`${actor.name} Sonar Pulse revealed ${found} moving human(s)!`);
      } else if (actor.monsterClass === 'stalker') {
        const dash = this.resolveCollisions(actor.x + fwdX * 4.5, actor.z + fwdZ * 4.5);
        actor.x = dash.x;
        actor.z = dash.z;
        this.pushEvent(`${actor.name} lunged forward!`);
      } else if (actor.monsterClass === 'goliath') {
        let smashed = 0;
        for (const p of this.portals) {
          if (p.breakableByHeavy && !p.broken && dist2D(actor.x, actor.z, p.x, p.z) < 4.0) {
            p.broken = true;
            smashed++;
          }
        }
        this.emitNoise(actor.x, actor.z, 22, 1.0, actor.id, 'pallet');
        this.pushEvent(`${actor.name} Ground Slam (${smashed} barrier smashed)!`);
      }
    }
  }

  step(dt = 1 / 60): void {
    if (this.phase !== 'playing') return;
    this.tick++;
    this.elapsedSec += dt;

    // Decay ripples
    for (const r of this.ripples) {
      r.ttl -= dt;
    }
    this.ripples = this.ripples.filter((r) => r.ttl > 0);

    const monsters = [...this.actors.values()].filter((a) => a.role === 'monster');

    // Update timers, heartbeat, and exit checks
    for (const a of this.actors.values()) {
      if (a.attackCooldown > 0) a.attackCooldown = Math.max(0, a.attackCooldown - dt);
      if (a.abilityCooldown > 0) a.abilityCooldown = Math.max(0, a.abilityCooldown - dt);
      if (a.stunTimer > 0) a.stunTimer = Math.max(0, a.stunTimer - dt);
      if (a.revealedTimer > 0) a.revealedTimer = Math.max(0, a.revealedTimer - dt);

      if (a.role === 'human' && a.status === 'alive') {
        let minDist = Infinity;
        for (const m of monsters) {
          const d = dist2D(a.x, a.z, m.x, m.z);
          if (d < minDist) minDist = d;
        }
        a.heartbeat = minDist < 18 ? clamp(1 - minDist / 18, 0, 1) : 0;

        // Check unlocked exits
        for (const o of this.objectives) {
          if (o.kind === 'exit-gate' && o.unlocked && dist2D(a.x, a.z, o.x, o.z) < 2.8) {
            a.status = 'escaped';
            this.pushEvent(`${a.name} ESCAPED through ${o.label}!`);
          }
        }
      }
    }

    // Match win condition check
    const humans = [...this.actors.values()].filter((a) => a.role === 'human');
    const stillAlive = humans.filter((h) => h.status === 'alive').length;
    const escaped = humans.filter((h) => h.status === 'escaped').length;
    if (stillAlive === 0) {
      this.phase = escaped > 0 ? 'humans-win' : 'monsters-win';
      this.pushEvent(
        this.phase === 'humans-win'
          ? `MATCH OVER — ${escaped}/${humans.length} Humans Escaped!`
          : 'MATCH OVER — Monsters Hunted Every Human!',
      );
    }
  }

  getSnapshot(): HuntSnapshot {
    return {
      mode: this.mode,
      tick: this.tick,
      elapsedSec: Number(this.elapsedSec.toFixed(2)),
      phase: this.phase,
      arenaSize: ARENA_HALF * 2,
      walls: this.walls,
      portals: this.portals,
      objectives: this.objectives,
      ripples: this.ripples,
      actors: [...this.actors.values()],
      events: this.events,
    };
  }
}

export function createHuntStateStream(
  world: AsymmetricHuntWorld,
  intervalMs = 50,
): ReadableStream<HuntSnapshot> {
  let timer: ReturnType<typeof setInterval> | null = null;
  return new ReadableStream<HuntSnapshot>({
    start(controller) {
      controller.enqueue(world.getSnapshot());
      timer = setInterval(() => {
        try {
          controller.enqueue(world.getSnapshot());
        } catch {
          if (timer) clearInterval(timer);
        }
      }, intervalMs);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
}
