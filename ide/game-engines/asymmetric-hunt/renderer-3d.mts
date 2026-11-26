/**
 * @file renderer-3d.mts
 * @description Self-contained WebGL2 3D PBR + Horror Fog + Dynamic Flashlight /
 * Monster Red-Stain Cone + Procedural Spatial WebAudio + LAN Multiplayer Lobby
 * for `b8g-asymmetric-hunt` (Humans vs. Monsters, 3v4 Compound & 1v4 Trials).
 */
const html = (strings: TemplateStringsArray, ...values: unknown[]): string =>
  strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), '');

export function renderAsymmetricHuntHtml(lanHint = '127.0.0.1:7495'): string {
  const escapedHint = JSON.stringify(lanHint);
  return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Asymmetric Hunt 3D — Humans vs. Monsters (B8G Engine)</title>
<style>
  :root {
    --bg: #07090e;
    --panel: rgba(13, 18, 29, 0.88);
    --border: rgba(56, 189, 248, 0.28);
    --accent: #38bdf8;
    --danger: #f43f5e;
    --ok: #34d399;
    --warn: #fbbf24;
    --text: #e6eef9;
    --muted: #93a4be;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; user-select: none; }
  #gl { width: 100vw; height: 100vh; display: block; cursor: crosshair; }
  .hud-top { position: fixed; top: 12px; left: 12px; right: 12px; display: flex; justify-content: space-between; align-items: flex-start; pointer-events: none; gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; backdrop-filter: blur(8px); pointer-events: auto; }
  .title { font-weight: 800; letter-spacing: 0.5px; color: var(--accent); font-size: 13px; }
  .sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .hud-bottom { position: fixed; bottom: 14px; left: 14px; right: 14px; display: flex; justify-content: space-between; align-items: flex-end; pointer-events: none; gap: 12px; }
  .bar-wrap { width: 230px; margin-top: 6px; }
  .bar-label { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-bottom: 3px; }
  .bar { height: 8px; background: rgba(255,255,255,0.08); border-radius: 999px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 999px; transition: width 0.08s linear; }
  .hp { background: linear-gradient(90deg, #ef4444, #f97316); }
  .st { background: linear-gradient(90deg, #38bdf8, #34d399); }
  .hb { background: linear-gradient(90deg, #fbbf24, #f43f5e); }
  .events { max-width: 380px; font-size: 11px; line-height: 1.45; color: #dbeafe; }
  .minimap { width: 168px; height: 168px; background: rgba(7, 10, 16, 0.85); border: 1px solid var(--border); border-radius: 10px; }
  .lobby { position: fixed; inset: 0; background: radial-gradient(circle at 50% 30%, rgba(24,34,56,0.92), rgba(7,9,14,0.97)); display: flex; align-items: center; justify-content: center; z-index: 20; }
  .lobby-box { width: min(640px, 94vw); background: #0f1625; border: 1px solid var(--border); border-radius: 14px; padding: 22px; box-shadow: 0 24px 60px rgba(0,0,0,0.65); }
  .lobby h1 { margin: 0 0 6px; font-size: 22px; color: #fff; }
  .lobby p { margin: 0 0 16px; color: var(--muted); font-size: 13px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
  .pick { background: #141e33; border: 1.5px solid #24334d; border-radius: 10px; padding: 12px; cursor: pointer; text-align: left; color: var(--text); }
  .pick:hover { border-color: var(--accent); }
  .pick.active { border-color: var(--accent); background: rgba(56,189,248,0.14); }
  .pick b { display: block; font-size: 13px; margin-bottom: 4px; }
  .pick span { font-size: 11px; color: var(--muted); }
  .row { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  input.txt { flex: 1; background: #090e18; border: 1px solid #24334d; border-radius: 8px; padding: 8px 10px; color: #fff; font-size: 13px; }
  button.primary { background: linear-gradient(135deg, #0ea5e9, #6366f1); color: #fff; border: none; border-radius: 8px; padding: 10px 18px; font-weight: 700; cursor: pointer; font-size: 13px; }
  button.primary:hover { filter: brightness(1.1); }
  button.sec { background: #162033; color: var(--text); border: 1px solid #2b3c5a; border-radius: 8px; padding: 7px 12px; cursor: pointer; font-size: 12px; }
  .crosshair { position: fixed; left: 50%; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px; border: 1.5px solid rgba(255,255,255,0.65); border-radius: 50%; pointer-events: none; }
  .vignette { position: fixed; inset: 0; pointer-events: none; transition: box-shadow 0.15s ease; }
  .skill-wrap { position: fixed; left: 50%; top: 58%; transform: translate(-50%, -50%); display: none; flex-direction: column; align-items: center; gap: 6px; pointer-events: none; z-index: 15; }
  .skill-tag { font-size: 11px; font-weight: 800; letter-spacing: 0.7px; color: #fbbf24; background: rgba(7,9,14,0.85); border: 1px solid rgba(251,191,36,0.45); padding: 3px 9px; border-radius: 999px; }
</style>
</head>
<body>
<canvas id="gl"></canvas>
<div class="vignette" id="vignette"></div>
<div class="crosshair"></div>
<div class="skill-wrap" id="skillWrap">
  <canvas id="skillRing" width="136" height="136"></canvas>
  <div class="skill-tag" id="skillTag">SKILL CHECK · PRESS SPACE</div>
</div>

<div class="hud-top">
  <div class="card">
    <div class="title" id="hudMode">ASYMMETRIC HUNT 3D · 3v4 COMPOUND</div>
    <div class="sub" id="hudSub">WASD Move · Mouse Turn (Click Canvas) · Shift Sprint · C Crouch · E Interact/Pallet/Gap · LMB Attack · Q Ability</div>
  </div>
  <div class="card" style="display:flex;gap:8px;align-items:center;">
    <span class="sub" id="lanTag">Room: default</span>
    <button class="sec" id="btnCopyLan">Copy LAN Invite</button>
    <button class="sec" id="btnLobby">Lobby / Mode</button>
    <button class="sec" id="btnReset">Restart</button>
  </div>
</div>

<div class="hud-bottom">
  <div class="card">
    <div class="title" id="actorLabel">Waiting for match...</div>
    <div class="bar-wrap">
      <div class="bar-label"><span>Health</span><span id="hpVal">100</span></div>
      <div class="bar"><div class="bar-fill hp" id="hpBar" style="width:100%"></div></div>
    </div>
    <div class="bar-wrap">
      <div class="bar-label"><span>Stamina</span><span id="stVal">100</span></div>
      <div class="bar"><div class="bar-fill st" id="stBar" style="width:100%"></div></div>
    </div>
    <div class="bar-wrap">
      <div class="bar-label"><span>Proximity Terror / Heartbeat</span><span id="hbVal">0%</span></div>
      <div class="bar"><div class="bar-fill hb" id="hbBar" style="width:0%"></div></div>
    </div>
  </div>

  <div class="card events" id="eventsBox">Ready.</div>
  <canvas class="minimap" id="minimap" width="168" height="168"></canvas>
</div>

<div class="lobby" id="lobby">
  <div class="lobby-box">
    <h1>Asymmetric Hunt 3D <span style="color:var(--accent);font-size:14px;">B8G Engine</span></h1>
    <p>Original Humans vs. Monsters survival-hunt engine. Play solo with Utility AI bots or invite a second player on LAN.</p>

    <div class="grid-2">
      <button class="pick active" id="mode3v4">
        <b>3v4 Compound Escape (Default)</b>
        <span>3 Specialized Monsters (Stalker, Goliath, Echo) vs. 4 Humans · 4 Exit Routes (Fuse, Valve, Battery, Gen) · Crawl Gaps</span>
      </button>
      <button class="pick" id="mode1v4">
        <b>1v4 Apex Trials</b>
        <span>1 Apex Monster vs. 4 Humans · Repair 3 of 5 Generators · Pallet Stuns &amp; Vault Loops</span>
      </button>
    </div>

    <div class="grid-2">
      <button class="pick active" id="pickHuman">
        <b>Play as Human (3rd-Person)</b>
        <span>Sneak in shadows, squeeze through wall gaps, slam pallets, unlock exits &amp; escape.</span>
      </button>
      <button class="pick" id="pickStalker">
        <b>Monster: The Stalker (Light)</b>
        <span>Fast chaser · fits through wall gaps · Q = Lunge Dash.</span>
      </button>
      <button class="pick" id="pickGoliath">
        <b>Monster: The Goliath (Heavy)</b>
        <span>Heavy hitter (-50 HP) · Q = Ground Slam smashes pallets &amp; doors.</span>
      </button>
      <button class="pick" id="pickEcho">
        <b>Monster: The Echo (Tracker)</b>
        <span>Acoustic hunter · Q = Sonar Pulse reveals all non-crouching humans.</span>
      </button>
    </div>

    <div class="row">
      <input class="txt" id="playerName" value="Player" placeholder="Your callsign" />
      <input class="txt" id="roomInput" value="default" placeholder="Room ID (LAN co-op)" />
      <button class="primary" id="btnStart">Enter Hunt</button>
    </div>
    <div class="sub">LAN Multiplayer: share <code id="lanUrlPreview"></code> so a second PC joins the exact same room.</div>
  </div>
</div>

<script type="module">
const LAN_HINT = ${escapedHint};
const qs = new URLSearchParams(location.search);
let selectedMode = qs.get('mode') || 'compound-3v4';
let selectedActor = 'h-1';
let roomId = qs.get('room') || 'default';
let myActorId = null;
let snapshot = null;
let yaw = 0;
let pitch = -0.18;

const $ = (id) => document.getElementById(id);
$('roomInput').value = roomId;

function updateLanPreview() {
  roomId = $('roomInput').value.trim() || 'default';
  const proto = location.protocol;
  const host = location.hostname === '127.0.0.1' ? LAN_HINT : location.host;
  const url = proto + '//' + host + '/?room=' + encodeURIComponent(roomId) + '&mode=' + encodeURIComponent(selectedMode);
  $('lanUrlPreview').textContent = url;
  $('lanTag').textContent = 'Room: ' + roomId;
  return url;
}

const modeBtns = { 'compound-3v4': $('mode3v4'), 'trials-1v4': $('mode1v4') };
const roleBtns = { 'h-1': $('pickHuman'), 'm-stalker': $('pickStalker'), 'm-goliath': $('pickGoliath'), 'm-echo': $('pickEcho') };

for (const [m, b] of Object.entries(modeBtns)) {
  b.onclick = () => {
    selectedMode = m;
    Object.values(modeBtns).forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    updateLanPreview();
  };
}
for (const [id, b] of Object.entries(roleBtns)) {
  b.onclick = () => {
    selectedActor = id;
    Object.values(roleBtns).forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
  };
}
$('roomInput').oninput = updateLanPreview;
updateLanPreview();

$('btnCopyLan').onclick = () => {
  const url = updateLanPreview();
  navigator.clipboard?.writeText(url);
  $('btnCopyLan').textContent = 'Copied!';
  setTimeout(() => ($('btnCopyLan').textContent = 'Copy LAN Invite'), 1400);
};
$('btnLobby').onclick = () => ($('lobby').style.display = 'flex');
$('btnReset').onclick = async () => {
  await fetch('/api/room/reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roomId, mode: selectedMode }),
  });
};

// Procedural WebAudio heartbeat
let audioCtx = null;
let lastBeat = 0;
function tickHeartbeat(hb) {
  if (!audioCtx || hb < 0.12) return;
  const now = performance.now();
  const interval = 1150 - hb * 750;
  if (now - lastBeat > interval) {
    lastBeat = now;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(58 + hb * 18, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(28, audioCtx.currentTime + 0.14);
    gain.gain.setValueAtTime(0.06 + hb * 0.22, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.16);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.17);
  }
}

$('btnStart').onclick = async () => {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  roomId = $('roomInput').value.trim() || 'default';
  const res = await fetch('/api/room/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      roomId,
      mode: selectedMode,
      preferredActorId: selectedActor,
      playerName: $('playerName').value.trim() || 'Player',
    }),
  });
  const data = await res.json();
  myActorId = data.actorId;
  snapshot = data.snapshot;
  $('lobby').style.display = 'none';
  $('hudMode').textContent = 'ASYMMETRIC HUNT 3D · ' + (selectedMode === 'compound-3v4' ? '3v4 COMPOUND' : '1v4 TRIALS');
  startLoops();
};

// Input tracking + Skill-Check Ring state
const keys = new Set();
let mouseDown = false;
const skill = { active: false, angle: 0, zoneStart: 2.2, greatSize: 0.24, goodSize: 0.72, cooldownMs: 0 };

async function resolveSkillCheck(outcome) {
  skill.active = false;
  skill.cooldownMs = performance.now() + 3400;
  $('skillWrap').style.display = 'none';
  if (!myActorId) return;
  try {
    const res = await fetch('/api/room/skillcheck', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, actorId: myActorId, outcome }),
    });
    const data = await res.json();
    if (data.snapshot) snapshot = data.snapshot;
  } catch {}
}

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'Space' && skill.active) {
    e.preventDefault();
    const a = skill.angle % (Math.PI * 2);
    if (a >= skill.zoneStart && a <= skill.zoneStart + skill.greatSize) {
      resolveSkillCheck('great');
    } else if (a >= skill.zoneStart && a <= skill.zoneStart + skill.goodSize) {
      resolveSkillCheck('good');
    } else {
      resolveSkillCheck('miss');
    }
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
const canvas = $('gl');
canvas.addEventListener('click', () => {
  if ($('lobby').style.display === 'none') {
    canvas.requestPointerLock?.();
  }
});
window.addEventListener('mousedown', (e) => { if (e.button === 0) mouseDown = true; });
window.addEventListener('mouseup', (e) => { if (e.button === 0) mouseDown = false; });
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas || e.buttons === 2) {
    yaw -= e.movementX * 0.0032;
    pitch = Math.max(-0.65, Math.min(0.45, pitch - e.movementY * 0.0024));
  }
});

// ================= WebGL2 3D PBR + Fog Renderer =================
const gl = canvas.getContext('webgl2', { antialias: true });
const vsSrc = \`#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNorm;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
out vec3 vWorldPos;
out vec3 vNormal;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(uModel) * aNorm);
  gl_Position = uProj * uView * wp;
}\`;

const fsSrc = \`#version 300 es
precision highp float;
in vec3 vWorldPos;
in vec3 vNormal;
uniform vec3 uColor;
uniform vec3 uEmissive;
uniform vec3 uCamPos;
uniform vec3 uFlashPos;
uniform vec3 uFlashDir;
uniform vec3 uFlashColor;
uniform float uTime;
out vec4 fragColor;
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorldPos);
  // Cold moonlight directional light
  vec3 L = normalize(vec3(0.42, 0.82, 0.38));
  float diff = max(dot(N, L), 0.0);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 32.0) * 0.25;
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.22;

  // Dynamic Flashlight / Monster Red-Stain Cone
  vec3 toFrag = vWorldPos - uFlashPos;
  float dist = length(toFrag);
  vec3 fd = toFrag / max(dist, 0.001);
  float cone = smoothstep(0.76, 0.94, dot(fd, normalize(uFlashDir)));
  float atten = cone / (1.0 + 0.045 * dist + 0.012 * dist * dist);

  // Subtle checkerboard / masonry variation
  float grid = 0.92 + 0.08 * sin(vWorldPos.x * 2.2) * sin(vWorldPos.z * 2.2);

  vec3 ambient = uColor * vec3(0.16, 0.20, 0.28);
  vec3 moon = uColor * vec3(0.55, 0.65, 0.82) * diff + vec3(spec);
  vec3 flash = uColor * uFlashColor * atten * 2.4;
  vec3 col = (ambient + moon + flash) * grid + vec3(0.18, 0.28, 0.45) * rim + uEmissive;

  // Exponential volumetric horror fog
  float camDist = length(uCamPos - vWorldPos);
  float fog = 1.0 - exp(-0.0014 * camDist * camDist);
  vec3 fogColor = vec3(0.035, 0.05, 0.085);
  col = mix(col, fogColor, clamp(fog, 0.0, 0.94));
  fragColor = vec4(col, 1.0);
}\`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
gl.linkProgram(prog);
gl.useProgram(prog);

// Unit cube geometry (pos + normal)
const cubeVerts = new Float32Array([
  // +Z
  -0.5,-0.5, 0.5, 0,0,1,  0.5,-0.5, 0.5, 0,0,1,  0.5, 0.5, 0.5, 0,0,1,
  -0.5,-0.5, 0.5, 0,0,1,  0.5, 0.5, 0.5, 0,0,1, -0.5, 0.5, 0.5, 0,0,1,
  // -Z
   0.5,-0.5,-0.5, 0,0,-1, -0.5,-0.5,-0.5, 0,0,-1, -0.5, 0.5,-0.5, 0,0,-1,
   0.5,-0.5,-0.5, 0,0,-1, -0.5, 0.5,-0.5, 0,0,-1,  0.5, 0.5,-0.5, 0,0,-1,
  // +X
   0.5,-0.5, 0.5, 1,0,0,  0.5,-0.5,-0.5, 1,0,0,  0.5, 0.5,-0.5, 1,0,0,
   0.5,-0.5, 0.5, 1,0,0,  0.5, 0.5,-0.5, 1,0,0,  0.5, 0.5, 0.5, 1,0,0,
  // -X
  -0.5,-0.5,-0.5,-1,0,0, -0.5,-0.5, 0.5,-1,0,0, -0.5, 0.5, 0.5,-1,0,0,
  -0.5,-0.5,-0.5,-1,0,0, -0.5, 0.5, 0.5,-1,0,0, -0.5, 0.5,-0.5,-1,0,0,
  // +Y
  -0.5, 0.5, 0.5, 0,1,0,  0.5, 0.5, 0.5, 0,1,0,  0.5, 0.5,-0.5, 0,1,0,
  -0.5, 0.5, 0.5, 0,1,0,  0.5, 0.5,-0.5, 0,1,0, -0.5, 0.5,-0.5, 0,1,0,
  // -Y
  -0.5,-0.5,-0.5, 0,-1,0,  0.5,-0.5,-0.5, 0,-1,0,  0.5,-0.5, 0.5, 0,-1,0,
  -0.5,-0.5,-0.5, 0,-1,0,  0.5,-0.5, 0.5, 0,-1,0, -0.5,-0.5, 0.5, 0,-1,0,
]);

const vao = gl.createVertexArray();
gl.bindVertexArray(vao);
const vbo = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(gl.ARRAY_BUFFER, cubeVerts, gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
gl.enableVertexAttribArray(1);
gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);

const uProj = gl.getUniformLocation(prog, 'uProj');
const uView = gl.getUniformLocation(prog, 'uView');
const uModel = gl.getUniformLocation(prog, 'uModel');
const uColor = gl.getUniformLocation(prog, 'uColor');
const uEmissive = gl.getUniformLocation(prog, 'uEmissive');
const uCamPos = gl.getUniformLocation(prog, 'uCamPos');
const uFlashPos = gl.getUniformLocation(prog, 'uFlashPos');
const uFlashDir = gl.getUniformLocation(prog, 'uFlashDir');
const uFlashColor = gl.getUniformLocation(prog, 'uFlashColor');
const uTime = gl.getUniformLocation(prog, 'uTime');

function mat4Persp(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}
function mat4LookAt(eye, target) {
  const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  const zl = Math.hypot(zx, zy, zz) || 1;
  const fz = [zx / zl, zy / zl, zz / zl];
  const rx = fz[2], rz = -fz[0];
  const rl = Math.hypot(rx, rz) || 1;
  const sx = [rx / rl, 0, rz / rl];
  const ux = [
    fz[1] * sx[2] - fz[2] * sx[1],
    fz[2] * sx[0] - fz[0] * sx[2],
    fz[0] * sx[1] - fz[1] * sx[0],
  ];
  return new Float32Array([
    sx[0], ux[0], fz[0], 0,
    sx[1], ux[1], fz[1], 0,
    sx[2], ux[2], fz[2], 0,
    -(sx[0]*eye[0] + sx[1]*eye[1] + sx[2]*eye[2]),
    -(ux[0]*eye[0] + ux[1]*eye[1] + ux[2]*eye[2]),
    -(fz[0]*eye[0] + fz[1]*eye[1] + fz[2]*eye[2]),
    1,
  ]);
}
function drawBox(x, y, z, w, h, d, color, emissive = [0, 0, 0]) {
  gl.uniformMatrix4fv(uModel, false, new Float32Array([
    w, 0, 0, 0,
    0, h, 0, 0,
    0, 0, d, 0,
    x, y, z, 1,
  ]));
  gl.uniform3fv(uColor, color);
  gl.uniform3fv(uEmissive, emissive);
  gl.drawArrays(gl.TRIANGLES, 0, 36);
}

let loopsStarted = false;
function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;

  // 20 Hz input + snapshot sync
  setInterval(async () => {
    if (!myActorId) return;
    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    try {
      const res = await fetch('/api/room/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          roomId,
          actorId: myActorId,
          input: {
            forward,
            strafe,
            yaw,
            sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'),
            crouch: keys.has('KeyC') || keys.has('ControlLeft'),
            interact: keys.has('KeyE'),
            attack: mouseDown || keys.has('Space'),
            ability: keys.has('KeyQ'),
          },
        }),
      });
      snapshot = await res.json();
    } catch {}
  }, 50);

  function frame(t) {
    requestAnimationFrame(frame);
    if (!snapshot) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.035, 0.05, 0.085, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const me = snapshot.actors.find((a) => a.id === myActorId) || snapshot.actors[0];
    if (!me) return;

    const isMonster = me.role === 'monster';
    const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
    const camDist = isMonster ? 0.2 : 5.4;
    const camH = isMonster ? 1.75 : (me.crouching ? 2.1 : 2.9);
    const eye = [me.x - fwdX * camDist, camH, me.z - fwdZ * camDist];
    const target = [me.x + fwdX * 6, 1.2 + pitch * 4, me.z + fwdZ * 6];

    gl.uniformMatrix4fv(uProj, false, mat4Persp(1.08, w / Math.max(1, h), 0.1, 140));
    gl.uniformMatrix4fv(uView, false, mat4LookAt(eye, target));
    gl.uniform3fv(uCamPos, eye);
    gl.uniform3fv(uFlashPos, [me.x, 1.4, me.z]);
    gl.uniform3fv(uFlashDir, [fwdX, pitch * 0.4, fwdZ]);
    gl.uniform3fv(uFlashColor, isMonster ? [1.0, 0.18, 0.22] : [0.95, 0.96, 1.0]);
    gl.uniform1f(uTime, t * 0.001);

    // Ground plane
    drawBox(0, -0.25, 0, snapshot.arenaSize + 4, 0.5, snapshot.arenaSize + 4, [0.14, 0.16, 0.14]);

    // Compound walls
    for (const wall of snapshot.walls) {
      drawBox(wall.x, wall.y, wall.z, wall.w, wall.h, wall.d, wall.color);
    }

    // Portals (gaps, pallets, doors)
    for (const p of snapshot.portals) {
      if (p.broken) continue;
      if (p.kind === 'pallet') {
        drawBox(p.x, p.dropped ? 0.55 : 1.1, p.z, p.dropped ? 2.2 : 0.35, p.dropped ? 1.1 : 2.2, 0.6, [0.58, 0.38, 0.18], p.dropped ? [0.1, 0.04, 0] : [0, 0, 0]);
      } else if (p.kind === 'gap' || p.kind === 'crawl') {
        drawBox((p.x + p.exitX) * 0.5, 0.9, (p.z + p.exitZ) * 0.5, 1.1, 1.8, 0.35, [0.12, 0.35, 0.52], [0.05, 0.18, 0.28]);
      } else if (p.kind === 'door' && p.locked) {
        drawBox(p.x, 1.4, p.z, 2.2, 2.8, 0.3, [0.45, 0.22, 0.16]);
      }
    }

    // Objectives & Exit Gates
    for (const o of snapshot.objectives) {
      if (o.kind === 'exit-gate') {
        const em = o.unlocked ? [0.1, 0.85, 0.45] : [0.5, 0.12, 0.12];
        drawBox(o.x, 2.0, o.z, 3.6, 4.0, 0.7, [0.22, 0.26, 0.3], em);
      } else {
        const em = o.completed ? [0.1, 0.75, 0.35] : [0.75, 0.45 + 0.2 * Math.sin(t * 0.008), 0.08];
        drawBox(o.x, 0.85, o.z, 1.3, 1.7, 1.3, [0.25, 0.28, 0.32], em);
      }
    }

    // 3D Acoustic Noise Ripples
    for (const r of snapshot.ripples) {
      const pulse = 1.0 + (3.0 - r.ttl) * 2.2;
      const em = r.kind === 'sonar' ? [0.15, 0.65, 1.0] : [0.95, 0.18, 0.22];
      drawBox(r.x, 0.12, r.z, pulse, 0.12, pulse, [0.1, 0.1, 0.1], em);
    }

    // Actors (Humans & Monsters)
    for (const a of snapshot.actors) {
      if (a.status !== 'alive') continue;
      if (a.id === me.id && isMonster) continue;
      const hgt = a.role === 'monster' ? (a.monsterClass === 'goliath' ? 2.45 : 2.1) : (a.crouching ? 1.05 : 1.75);
      const wid = a.monsterClass === 'goliath' ? 1.15 : 0.75;
      const col = a.role === 'monster'
        ? (a.monsterClass === 'goliath' ? [0.65, 0.14, 0.18] : a.monsterClass === 'echo' ? [0.35, 0.18, 0.68] : [0.78, 0.22, 0.14])
        : [0.22, 0.62, 0.92];
      const em = a.revealedTimer > 0 ? [0.95, 0.25, 0.25] : (a.role === 'monster' ? [0.28, 0.04, 0.06] : [0.02, 0.08, 0.14]);
      drawBox(a.x, hgt * 0.5, a.z, wid, hgt, wid, col, em);
      // Head
      drawBox(a.x, hgt + 0.25, a.z, wid * 0.55, 0.45, wid * 0.55, [0.85, 0.78, 0.72], a.role === 'monster' ? [0.5, 0.08, 0.08] : [0, 0, 0]);
    }

    // Update HUD & Heartbeat
    $('actorLabel').textContent = me.name + ' [' + me.status.toUpperCase() + ']' + (me.stunTimer > 0 ? ' (STUNNED)' : '');
    $('hpVal').textContent = Math.round(me.health) + '/' + me.maxHealth;
    $('hpBar').style.width = Math.max(0, (me.health / me.maxHealth) * 100) + '%';
    $('stVal').textContent = Math.round(me.stamina);
    $('stBar').style.width = Math.max(0, (me.stamina / me.maxStamina) * 100) + '%';
    $('hbVal').textContent = Math.round(me.heartbeat * 100) + '%';
    $('hbBar').style.width = Math.round(me.heartbeat * 100) + '%';
    $('vignette').style.boxShadow = me.heartbeat > 0.15
      ? 'inset 0 0 ' + Math.round(60 + me.heartbeat * 140) + 'px rgba(244,63,94,' + (me.heartbeat * 0.55).toFixed(2) + ')'
      : 'none';
    tickHeartbeat(me.heartbeat);
    $('eventsBox').innerHTML = snapshot.events.slice(-4).map((e) => '<div>• ' + e + '</div>').join('');

    // Skill-check ring while human repairs/unlocks an objective
    const repairing = me.role === 'human' && me.status === 'alive' && keys.has('KeyE') && me.interactTargetId && me.interactTargetId.startsWith('obj-') || (me.interactTargetId && me.interactTargetId.startsWith('gen-'));
    if (repairing && !skill.active && performance.now() > skill.cooldownMs) {
      skill.active = true;
      skill.angle = 0;
      skill.zoneStart = 1.6 + Math.random() * 2.8;
      $('skillWrap').style.display = 'flex';
    } else if (!repairing && skill.active) {
      skill.active = false;
      $('skillWrap').style.display = 'none';
    }
    if (skill.active) {
      skill.angle += 0.068;
      if (skill.angle >= Math.PI * 2) {
        resolveSkillCheck('miss');
      } else {
        const scCtx = $('skillRing').getContext('2d');
        scCtx.clearRect(0, 0, 136, 136);
        scCtx.lineWidth = 10;
        scCtx.strokeStyle = 'rgba(255,255,255,0.16)';
        scCtx.beginPath(); scCtx.arc(68, 68, 52, 0, Math.PI * 2); scCtx.stroke();
        scCtx.strokeStyle = '#38bdf8';
        scCtx.beginPath(); scCtx.arc(68, 68, 52, skill.zoneStart, skill.zoneStart + skill.goodSize); scCtx.stroke();
        scCtx.strokeStyle = '#fbbf24';
        scCtx.beginPath(); scCtx.arc(68, 68, 52, skill.zoneStart, skill.zoneStart + skill.greatSize); scCtx.stroke();
        const nx = 68 + Math.cos(skill.angle) * 56;
        const ny = 68 + Math.sin(skill.angle) * 56;
        scCtx.strokeStyle = '#f43f5e';
        scCtx.lineWidth = 4;
        scCtx.beginPath(); scCtx.moveTo(68, 68); scCtx.lineTo(nx, ny); scCtx.stroke();
      }
    }

    // Draw Tactical Minimap
    const mc = $('minimap').getContext('2d');
    mc.clearRect(0, 0, 168, 168);
    const sc = 168 / snapshot.arenaSize;
    const mx = (x) => 84 + x * sc;
    const mz = (z) => 84 + z * sc;
    mc.fillStyle = '#243047';
    for (const wall of snapshot.walls) {
      mc.fillRect(mx(wall.x - wall.w * 0.5), mz(wall.z - wall.d * 0.5), wall.w * sc, wall.d * sc);
    }
    for (const o of snapshot.objectives) {
      mc.fillStyle = o.kind === 'exit-gate' ? (o.unlocked ? '#34d399' : '#64748b') : (o.completed ? '#34d399' : '#fbbf24');
      mc.fillRect(mx(o.x) - 3, mz(o.z) - 3, 6, 6);
    }
    for (const a of snapshot.actors) {
      if (a.status !== 'alive') continue;
      if (me.role === 'monster' && a.role === 'human' && a.revealedTimer <= 0 && Math.hypot(a.x - me.x, a.z - me.z) > 16) continue;
      mc.fillStyle = a.id === me.id ? '#ffffff' : (a.role === 'monster' ? '#f43f5e' : '#38bdf8');
      mc.beginPath();
      mc.arc(mx(a.x), mz(a.z), a.id === me.id ? 4 : 3, 0, Math.PI * 2);
      mc.fill();
    }
  }
  requestAnimationFrame(frame);
}
</script>
</body>
</html>`;
}
