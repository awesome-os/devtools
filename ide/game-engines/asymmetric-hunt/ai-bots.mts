/**
 * @file ai-bots.mts
 * @description Utility AI controller for Asymmetric Hunt bots (Monsters & Humans)
 * so solo / 2-player LAN matches always feel tense and alive.
 */
import type { ActorState, AsymmetricHuntWorld, PlayerInput } from './index.mts';

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

export function computeBotInput(world: AsymmetricHuntWorld, bot: ActorState): PlayerInput {
  if (bot.role === 'monster') {
    return computeMonsterBot(world, bot);
  }
  return computeHumanBot(world, bot);
}

function computeMonsterBot(world: AsymmetricHuntWorld, bot: ActorState): PlayerInput {
  const humans = [...world.actors.values()].filter((a) => a.role === 'human' && a.status === 'alive');

  // 1. Find nearest visible or sonar-revealed human
  let target: { x: number; z: number; dist: number; isHuman: boolean } | null = null;
  for (const h of humans) {
    const d = dist(bot.x, bot.z, h.x, h.z);
    const detectRange = h.revealedTimer > 0 ? 60 : 18 * h.stealthFactor;
    if (d <= detectRange && (!target || d < target.dist)) {
      target = { x: h.x, z: h.z, dist: d, isHuman: true };
    }
  }

  // 2. Otherwise investigate loudest recent noise ripple
  if (!target && world.ripples.length > 0) {
    const newest = world.ripples[world.ripples.length - 1]!;
    if (newest.sourceId !== bot.id) {
      target = { x: newest.x, z: newest.z, dist: dist(bot.x, bot.z, newest.x, newest.z), isHuman: false };
    }
  }

  // 3. Otherwise patrol uncompleted objectives
  if (!target) {
    const objs = world.objectives.filter((o) => o.kind !== 'exit-gate' && !o.completed);
    const pick = objs[(Math.floor(world.elapsedSec / 6) + bot.id.length) % Math.max(1, objs.length)];
    if (pick) {
      target = { x: pick.x, z: pick.z, dist: dist(bot.x, bot.z, pick.x, pick.z), isHuman: false };
    }
  }

  if (!target) {
    return { forward: 0, strafe: 0, yaw: bot.yaw };
  }

  const yaw = Math.atan2(target.x - bot.x, target.z - bot.z);
  const attack = target.isHuman && target.dist < 2.4;
  const ability =
    bot.abilityCooldown <= 0 &&
    ((bot.monsterClass === 'echo' && !target.isHuman) ||
      (bot.monsterClass === 'stalker' && target.isHuman && target.dist > 3.5 && target.dist < 9) ||
      (bot.monsterClass === 'goliath' && target.dist < 4.5));

  return {
    forward: target.dist > 1.2 ? 1 : 0,
    strafe: (world.tick % 90) < 15 ? 0.35 : 0,
    yaw,
    sprint: target.isHuman && target.dist > 3,
    attack,
    ability,
    interact: true,
  };
}

function computeHumanBot(world: AsymmetricHuntWorld, bot: ActorState): PlayerInput {
  const monsters = [...world.actors.values()].filter((a) => a.role === 'monster');
  let nearestMonster: ActorState | null = null;
  let nearestDist = Infinity;
  for (const m of monsters) {
    const d = dist(bot.x, bot.z, m.x, m.z);
    if (d < nearestDist) {
      nearestDist = d;
      nearestMonster = m;
    }
  }

  // 1. Evade if monster is close
  if (nearestMonster && nearestDist < 10) {
    const awayYaw = Math.atan2(bot.x - nearestMonster.x, bot.z - nearestMonster.z);
    return {
      forward: 1,
      strafe: (world.tick % 60) < 30 ? 0.3 : -0.3,
      yaw: awayYaw,
      sprint: nearestDist < 7.5,
      crouch: false,
      interact: true,
    };
  }

  // 2. Head to any unlocked exit gate!
  const openExit = world.objectives.find((o) => o.kind === 'exit-gate' && o.unlocked);
  if (openExit) {
    const yaw = Math.atan2(openExit.x - bot.x, openExit.z - bot.z);
    return {
      forward: 1,
      strafe: 0,
      yaw,
      sprint: bot.stamina > 35,
      crouch: false,
      interact: false,
    };
  }

  // 3. Work on nearest uncompleted objective
  const pending = world.objectives.filter((o) => o.kind !== 'exit-gate' && !o.completed);
  let goal = pending[0];
  let bestD = Infinity;
  for (const o of pending) {
    const d = dist(bot.x, bot.z, o.x, o.z);
    if (d < bestD) {
      bestD = d;
      goal = o;
    }
  }

  if (!goal) return { forward: 0, strafe: 0, yaw: bot.yaw };

  const yaw = Math.atan2(goal.x - bot.x, goal.z - bot.z);
  const crouch = nearestDist < 16;
  return {
    forward: bestD > 1.8 ? 1 : 0,
    strafe: 0,
    yaw,
    sprint: false,
    crouch,
    interact: bestD <= 2.6,
  };
}

export function stepAllBots(world: AsymmetricHuntWorld, dt: number): void {
  for (const actor of world.actors.values()) {
    if (!actor.isBot || actor.status !== 'alive') continue;
    const input = computeBotInput(world, actor);
    world.applyActorInput(actor.id, input, dt);
  }
}
