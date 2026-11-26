import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsymmetricHuntWorld, B8gAsymmetricHuntSection } from './index.mts';
import { stepAllBots } from './ai-bots.mts';
import { scanHuntGlbAssets } from './glb-loader.mts';
import { buildMinimalGlb } from '../b8g-game-engine/glb-ingestor.mts';
import { startAsymmetricHuntServer } from './server.mts';

test('AsymmetricHuntWorld seeds 3v4 Compound and 1v4 Trials presets cleanly', () => {
  assert.equal(B8gAsymmetricHuntSection.id, 'b8g.asymmetric.hunt');

  const w34 = new AsymmetricHuntWorld('compound-3v4');
  const m34 = [...w34.actors.values()].filter((a) => a.role === 'monster');
  const h34 = [...w34.actors.values()].filter((a) => a.role === 'human');
  assert.equal(m34.length, 3);
  assert.equal(h34.length, 4);

  const w14 = new AsymmetricHuntWorld('trials-1v4');
  const m14 = [...w14.actors.values()].filter((a) => a.role === 'monster');
  assert.equal(m14.length, 1);
  assert.equal(w14.objectives.filter((o) => o.kind === 'generator').length, 5);
});

test('Traversal body-class gating: Stalker (light) squeezes wall gap, Goliath (heavy) blocked & smashes barricade', () => {
  const w = new AsymmetricHuntWorld('compound-3v4');
  const gap = w.portals.find((p) => p.id === 'gap-house-mid')!;
  const stalker = w.actors.get('m-stalker')!;
  const goliath = w.actors.get('m-goliath')!;

  stalker.x = gap.x;
  stalker.z = gap.z;
  assert.equal(w.tryTraverseOrInteract(stalker, 0.05), true);
  assert.equal(stalker.z, gap.exitZ, 'Stalker (light) must traverse wall gap');

  goliath.x = gap.x;
  goliath.z = gap.z;
  assert.equal(w.tryTraverseOrInteract(goliath, 0.05), false, 'Goliath (heavy) cannot squeeze wall gap');
  assert.equal(goliath.z, gap.z);

  // Drop pallet and let Goliath smash it
  const pallet = w.portals.find((p) => p.id === 'pallet-nw')!;
  const human = w.actors.get('h-1')!;
  human.x = pallet.x;
  human.z = pallet.z;
  goliath.x = pallet.x + 1.0;
  goliath.z = pallet.z;
  assert.equal(w.tryTraverseOrInteract(human, 0.05), true);
  assert.equal(pallet.dropped, true);
  assert.ok(goliath.stunTimer > 0, 'Dropping pallet on nearby Goliath must stun him');

  goliath.stunTimer = 0;
  assert.equal(w.tryTraverseOrInteract(goliath, 0.05), true);
  assert.equal(pallet.broken, true, 'Goliath must smash dropped pallet');
});

test('Echo Sonar reveals standing humans while crouching humans stay hidden; completing objective unlocks exit gate', () => {
  const w = new AsymmetricHuntWorld('compound-3v4');
  const echo = w.actors.get('m-echo')!;
  const h1 = w.actors.get('h-1')!;
  const h2 = w.actors.get('h-2')!;
  h1.crouching = false;
  h2.crouching = true;

  w.applyActorInput(echo.id, { forward: 0, strafe: 0, yaw: 0, ability: true }, 0.05);
  assert.ok(h1.revealedTimer > 0, 'Standing human must be revealed by Echo Sonar');
  assert.equal(h2.revealedTimer, 0, 'Crouching human must stay hidden from Echo Sonar');

  // Complete Basement Fuse Box -> unlocks North Road Gate
  const fuse = w.objectives.find((o) => o.id === 'obj-fuse')!;
  h1.x = fuse.x;
  h1.z = fuse.z;
  for (let i = 0; i < 60; i++) {
    w.tryTraverseOrInteract(h1, 0.1);
  }
  assert.equal(fuse.completed, true);
  const northExit = w.objectives.find((o) => o.id === 'exit-north')!;
  assert.equal(northExit.unlocked, true);

  // Escape through unlocked exit gate
  h1.x = northExit.x;
  h1.z = northExit.z;
  w.step(1 / 60);
  assert.equal(h1.status, 'escaped');
});

test('Utility AI bots step cleanly and LAN multiplayer server supports 2-player room join & sync', async () => {
  const w = new AsymmetricHuntWorld('compound-3v4');
  for (let i = 0; i < 30; i++) {
    stepAllBots(w, 1 / 30);
    w.step(1 / 30);
  }
  assert.equal(w.tick, 30);

  const srv = await startAsymmetricHuntServer({ host: '127.0.0.1', port: 0 });
  try {
    const html = await (await fetch(`${srv.url}/`)).text();
    assert.ok(html.includes('Asymmetric Hunt 3D'));

    const j1 = (await (
      await fetch(`${srv.url}/api/room/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'father-son', mode: 'compound-3v4', preferredActorId: 'h-1', playerName: 'Son' }),
      })
    ).json()) as { actorId: string };
    assert.equal(j1.actorId, 'h-1');

    const j2 = (await (
      await fetch(`${srv.url}/api/room/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'father-son', mode: 'compound-3v4', preferredActorId: 'm-stalker', playerName: 'Frank' }),
      })
    ).json()) as { actorId: string };
    assert.equal(j2.actorId, 'm-stalker');

    const rooms = (await (await fetch(`${srv.url}/api/rooms`)).json()) as { rooms: Array<{ id: string }> };
    assert.ok(rooms.rooms.some((r) => r.id === 'father-son'));

    // Hot-load custom map from Sectium Commander Map Editor
    const cm = await fetch(`${srv.url}/api/room/custom-map`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: 'father-son',
        walls: [{ id: 'cw-1', x: 0, y: 2, z: 0, w: 4, h: 4, d: 4, kind: 'wall', color: [0.3, 0.3, 0.3] }],
      }),
    });
    assert.equal(cm.status, 200);
    const cmData = (await cm.json()) as { ok: boolean; snapshot: { walls: Array<{ id: string }> } };
    assert.equal(cmData.ok, true);
    assert.ok(cmData.snapshot.walls.some((x) => x.id === 'cw-1'));
  } finally {
    await srv.close();
  }
});

test('Skill-check ring awards +18% on great and emits loud noise explosion on miss; GLB drop-in ingests custom .glb models', () => {
  const w = new AsymmetricHuntWorld('compound-3v4');
  const h1 = w.actors.get('h-1')!;
  const fuse = w.objectives.find((o) => o.id === 'obj-fuse')!;
  h1.x = fuse.x;
  h1.z = fuse.z;
  h1.interactTargetId = fuse.id;

  const r1 = w.applySkillCheckResult(h1.id, 'great');
  assert.equal(r1.ok, true);
  assert.ok((r1.progress ?? 0) >= 0.17);

  const ripplesBefore = w.ripples.length;
  const r2 = w.applySkillCheckResult(h1.id, 'miss');
  assert.equal(r2.ok, true);
  assert.ok(w.ripples.length > ripplesBefore, 'Missed skill check must emit loud acoustic noise ripple');

  // Verify custom .glb drop-in ingestion via sections/b8g-game-engine/glb-ingestor.mts
  const tmpDir = mkdtempSync(join(tmpdir(), 'hunt-glb-'));
  try {
    const glbBytes = buildMinimalGlb(
      {
        asset: { version: '2.0', generator: 'b8g-hunt-test' },
        meshes: [{ name: 'StalkerMesh', primitives: [{}] }],
        materials: [{ name: 'StalkerMat' }],
      },
      new Uint8Array([1, 2, 3, 4]),
    );
    writeFileSync(join(tmpDir, 'stalker.glb'), glbBytes);
    const manifest = scanHuntGlbAssets(tmpDir);
    assert.equal(manifest.assets.length, 1);
    assert.equal(manifest.assets[0]?.slot, 'stalker');
    assert.equal(manifest.assets[0]?.valid, true);
    assert.equal(manifest.assets[0]?.meshCount, 1);
    assert.ok(manifest.b8pPackBytes > 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
