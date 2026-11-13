import { PianoSynth } from './synth.js';

const MP_VERSION = '0.10.14';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const $ = (id) => document.getElementById(id);
const intro = $('intro');
const overlay = $('overlay');
const hint = $('hint');
const statusEl = $('status');
const canvas = $('view');
const video = $('video');
const ctx = canvas.getContext('2d');
const btnStart = $('btn-start');
const btnAdjust = $('btn-adjust');
const btnSens = $('btn-sens');
const btnCamera = $('btn-camera');
const btnExit = $('btn-exit');
const octaveLabel = $('octave-label');

const synth = new PianoSynth();

/* ---------------------------------------------------------------------
 *  Teclat: coordenades (u, v) dins el piano
 *  u: 0 (esquerra) → 1 (dreta)   v: 0 (darrere) → 1 (davant, cap a tu)
 * ------------------------------------------------------------------- */
const NUM_SEMITONES = 25;
const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
const WHITE_COUNT = 15;
const BLACK_U = 0.0135 / (WHITE_COUNT * 0.0235);
const BLACK_V = 0.095 / 0.15;

const keys = [];
{
  let wi = 0;
  for (let s = 0; s < NUM_SEMITONES; s++) {
    const isBlack = !WHITE_PCS.includes(s % 12);
    if (isBlack) {
      const c = wi / WHITE_COUNT;
      keys.push({ s, isBlack, u0: c - BLACK_U / 2, u1: c + BLACK_U / 2, v1: BLACK_V, count: 0 });
    } else {
      keys.push({ s, isBlack, u0: wi / WHITE_COUNT, u1: (wi + 1) / WHITE_COUNT, v1: 1, count: 0 });
      wi++;
    }
  }
}

function keyAtUV(u, v) {
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  for (const k of keys) if (k.isBlack && v <= k.v1 && u >= k.u0 && u <= k.u1) return k;
  for (const k of keys) if (!k.isBlack && u >= k.u0 && u <= k.u1) return k;
  return null;
}

let baseMidi = 60;
const noteName = (midi) => `Do${Math.floor(midi / 12) - 1}`;

function pressKey(k, vel) {
  if (k.count++ === 0) synth.noteOn(baseMidi + k.s, vel);
}
function releaseKey(k) {
  if (k.count > 0 && --k.count === 0) synth.noteOff(baseMidi + k.s);
}
const pointerKeys = new Map();
function setPointerKey(id, key, vel = 0.8) {
  const prev = pointerKeys.get(id) || null;
  if (prev === key) return;
  if (prev) releaseKey(prev);
  if (key) { pointerKeys.set(id, key); pressKey(key, vel); } else pointerKeys.delete(id);
}
function releaseAll() {
  pointerKeys.clear();
  for (const k of keys) if (k.count > 0) { k.count = 0; synth.noteOff(baseMidi + k.s); }
}

function shiftOctave(dir) {
  const next = baseMidi + dir * 12;
  if (next < 24 || next > 84) return;
  releaseAll();
  baseMidi = next;
  octaveLabel.textContent = `${noteName(baseMidi)}–${noteName(baseMidi + NUM_SEMITONES - 1)}`;
}
$('btn-octave-down').addEventListener('click', () => shiftOctave(-1));
$('btn-octave-up').addEventListener('click', () => shiftOctave(1));

/* ---------------------------------------------------------------------
 *  Homografia: quadrat unitari (u, v) ↔ quadrilàter a la pantalla
 * ------------------------------------------------------------------- */
function squareToQuad([p0, p1, p2, p3]) {
  // p0=(0,0) darrere-esquerra, p1=(1,0) darrere-dreta, p2=(1,1) davant-dreta, p3=(0,1) davant-esquerra
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  const det = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (dx3 * dy2 - dx2 * dy3) / det;
  const h = (dx1 * dy3 - dx3 * dy1) / det;
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ];
}
function invert3([a, b, c, d, e, f, g, h, i]) {
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-9;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((x) => x / det);
}
function project(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
}

/* ---------------------------------------------------------------------
 *  Estat de pantalla, càmera i calibratge
 * ------------------------------------------------------------------- */
let W = 0, H = 0, dpr = 1;
let facing = 'user';
let mirror = true;
let stream = null;
let corners = null; // normalitzades 0..1: [darrere-esq, darrere-dre, davant-dre, davant-esq]
let H_uv2s = null, H_s2uv = null;
let adjusting = false;

const DEFAULT_CORNERS = {
  // Càmera frontal davant teu: la part del darrere del piano queda a prop de la càmera (a baix i més ampla)
  user: [{ x: 0.05, y: 0.8 }, { x: 0.95, y: 0.8 }, { x: 0.83, y: 0.4 }, { x: 0.17, y: 0.4 }],
  // Càmera posterior des del teu costat: la part del davant queda a baix
  environment: [{ x: 0.17, y: 0.4 }, { x: 0.83, y: 0.4 }, { x: 0.95, y: 0.8 }, { x: 0.05, y: 0.8 }],
};

const storeKey = () => `pianoTaula.corners.${facing}`;
function loadCorners() {
  try {
    const raw = localStorage.getItem(storeKey());
    if (raw) {
      const c = JSON.parse(raw);
      if (Array.isArray(c) && c.length === 4) return { corners: c, saved: true };
    }
  } catch { /* sense emmagatzematge */ }
  return { corners: DEFAULT_CORNERS[facing].map((p) => ({ ...p })), saved: false };
}
function saveCorners() {
  try { localStorage.setItem(storeKey(), JSON.stringify(corners)); } catch { /* ignora */ }
}
function updateHomography() {
  const px = corners.map((p) => ({ x: p.x * W, y: p.y * H }));
  H_uv2s = squareToQuad(px);
  H_s2uv = invert3(H_uv2s);
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  if (corners) updateHomography();
}
window.addEventListener('resize', resize);
resize();

// Video ajustat a la pantalla ("cover")
let vfit = { ox: 0, oy: 0, dw: 1, dh: 1 };
function computeFit() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const s = Math.max(W / vw, H / vh);
  vfit = { dw: vw * s, dh: vh * s, ox: (W - vw * s) / 2, oy: (H - vh * s) / 2 };
}
function lmToScreen(p) {
  let x = vfit.ox + p.x * vfit.dw;
  if (mirror) x = W - x;
  return { x, y: vfit.oy + p.y * vfit.dh };
}

async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  const settings = stream.getVideoTracks()[0].getSettings?.() || {};
  mirror = (settings.facingMode || facing) !== 'environment';
  const loaded = loadCorners();
  corners = loaded.corners;
  updateHomography();
  setAdjusting(!loaded.saved);
}

/* ---------------------------------------------------------------------
 *  Detecció de "cops" de dit a la taula
 * ------------------------------------------------------------------- */
const TIPS = [4, 8, 12, 16, 20];
const SENS = [
  { label: 'baixa', k: 0.75 },
  { label: 'mitjana', k: 1 },
  { label: 'alta', k: 1.4 },
];
let sensIdx = 1;
const V_DOWN = 1.1;    // velocitat de baixada (mides de mà / s) per "armar" el dit
const V_STOP = 0.35;   // per sota d'aquesta velocitat considerem que ha tocat la taula
const V_UP = 0.9;      // velocitat de pujada que allibera la nota
const LIFT = 0.07;     // distància (mides de mà) que cal aixecar el dit per alliberar
const LOW_MARGIN = 0.18; // només compten els dits que són (gairebé) els més baixos de la mà
const fingers = new Map();
let lastHandsAt = 0;

function processHands(result, now) {
  const seen = new Set();
  const lists = result.landmarks || [];
  const hands = result.handedness || result.handednesses || [];
  if (lists.length) lastHandsAt = now;
  const sens = SENS[sensIdx].k;

  lists.forEach((lm, hi) => {
    const label = hands[hi]?.[0]?.categoryName || String(hi);
    const pts = lm.map(lmToScreen);
    const size = Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y) || 1;
    const tips = TIPS.map((ti) => {
      const p = pts[ti];
      const uv = project(H_s2uv, p.x, p.y);
      return { ti, p, key: keyAtUV(uv.x, uv.y) };
    });
    const overKeys = tips.filter((t) => t.key);
    const lowest = overKeys.length ? Math.max(...overKeys.map((t) => t.p.y)) : Infinity;

    for (const t of tips) {
      const id = `${label}:${t.ti}`;
      seen.add(id);
      let st = fingers.get(id);
      if (!st) {
        st = { y: t.p.y, vy: 0, t: now, state: 'up', peak: 0, armT: 0, contactY: 0 };
        fingers.set(id, st);
      }
      const dt = Math.max(0.008, (now - st.t) / 1000);
      const rawVy = (t.p.y - st.y) / dt / size; // positiu = cap avall
      st.vy = st.vy * 0.35 + rawVy * 0.65;
      st.y = t.p.y;
      st.t = now;
      st.p = t.p;

      if (adjusting) {
        st.state = 'up';
        setPointerKey(id, null);
        continue;
      }

      if (st.state === 'up') {
        if (t.key && st.vy > V_DOWN / sens) {
          st.state = 'armed';
          st.peak = st.vy;
          st.armT = now;
        }
      } else if (st.state === 'armed') {
        st.peak = Math.max(st.peak, st.vy, rawVy);
        // L'aturada es detecta amb la velocitat instantània per reduir la latència
        if (rawVy < Math.max(V_STOP, st.peak * 0.35)) {
          if (t.key && t.p.y >= lowest - LOW_MARGIN * size) {
            st.state = 'down';
            st.contactY = t.p.y;
            const vel = Math.min(1, Math.max(0.3, 0.3 + (st.peak - 1) * 0.22));
            setPointerKey(id, t.key, vel);
          } else {
            st.state = 'up';
          }
        } else if (now - st.armT > 450) {
          st.state = 'up';
        }
      } else if (st.state === 'down') {
        st.contactY = Math.max(st.contactY, t.p.y);
        if (t.p.y < st.contactY - LIFT * size || st.vy < -V_UP / sens || !t.key) {
          st.state = 'up';
          setPointerKey(id, null);
        }
      }
    }
  });

  for (const [id] of fingers) {
    if (!seen.has(id)) {
      setPointerKey(id, null);
      fingers.delete(id);
    }
  }
}

/* ---------------------------------------------------------------------
 *  Dibuix
 * ------------------------------------------------------------------- */
function poly(pts) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}
function keyQuad(u0, u1, v0, v1) {
  return [project(H_uv2s, u0, v0), project(H_uv2s, u1, v0), project(H_uv2s, u1, v1), project(H_uv2s, u0, v1)];
}

function drawPiano() {
  // Cos del piano (darrere de les tecles)
  ctx.fillStyle = 'rgba(18,18,20,0.75)';
  poly(keyQuad(-0.015, 1.015, -0.16, 1.02));
  ctx.fill();
  ctx.fillStyle = 'rgba(160,30,30,0.9)';
  poly(keyQuad(0, 1, -0.02, 0));
  ctx.fill();

  ctx.lineWidth = 1;
  for (const k of keys) {
    if (k.isBlack) continue;
    ctx.fillStyle = k.count > 0 ? 'rgba(130,175,255,0.85)' : 'rgba(250,248,240,0.62)';
    ctx.strokeStyle = 'rgba(40,40,40,0.7)';
    poly(keyQuad(k.u0, k.u1, 0, 1));
    ctx.fill();
    ctx.stroke();
  }
  for (const k of keys) {
    if (!k.isBlack) continue;
    ctx.fillStyle = k.count > 0 ? 'rgba(58,109,240,0.95)' : 'rgba(12,12,14,0.85)';
    poly(keyQuad(k.u0, k.u1, 0, k.v1));
    ctx.fill();
  }

  // Etiquetes dels Do
  ctx.fillStyle = 'rgba(70,70,80,0.9)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const k of keys) {
    if (k.s % 12 !== 0) continue;
    const a = project(H_uv2s, k.u0, 0.88), b = project(H_uv2s, k.u1, 0.88);
    const size = Math.max(9, Math.hypot(b.x - a.x, b.y - a.y) * 0.34);
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.fillText(noteName(baseMidi + k.s), (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
}

function drawFingers() {
  for (const st of fingers.values()) {
    if (!st.p) continue;
    ctx.beginPath();
    ctx.arc(st.p.x, st.p.y, st.state === 'down' ? 9 : 6, 0, Math.PI * 2);
    ctx.fillStyle = st.state === 'down' ? '#4f7cff' : st.state === 'armed' ? '#f0c040' : 'rgba(255,255,255,0.85)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();
  }
}

function drawHandles() {
  const names = ['darrere', 'darrere', 'davant', 'davant'];
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  poly(corners.map((c) => ({ x: c.x * W, y: c.y * H })));
  ctx.stroke();
  ctx.setLineDash([]);
  corners.forEach((c, i) => {
    const x = c.x * W, y = c.y * H;
    ctx.beginPath();
    ctx.arc(x, y, 16, 0, Math.PI * 2);
    ctx.fillStyle = i >= 2 ? 'rgba(79,124,255,0.9)' : 'rgba(240,180,90,0.9)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(names[i], x, y + (y > H / 2 ? -26 : 30));
  });
}

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (video.videoWidth) {
    computeFit();
    ctx.save();
    if (mirror) {
      ctx.translate(W, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, vfit.ox, vfit.oy, vfit.dw, vfit.dh);
    ctx.restore();
  }
  if (!corners) return;
  drawPiano();
  if (adjusting) drawHandles();
  drawFingers();
}

/* ---------------------------------------------------------------------
 *  Interacció amb la pantalla: ajustar cantonades o tocar amb el dit
 * ------------------------------------------------------------------- */
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (!corners) return;
  const x = e.clientX, y = e.clientY;
  if (adjusting) {
    let best = -1, bestD = 40;
    corners.forEach((c, i) => {
      const d = Math.hypot(c.x * W - x, c.y * H - y);
      if (d < bestD) { bestD = d; best = i; }
    });
    const uv = project(H_s2uv, x, y);
    if (best >= 0) drag = { id: e.pointerId, idx: best };
    else if (uv.x >= 0 && uv.x <= 1 && uv.y >= 0 && uv.y <= 1) drag = { id: e.pointerId, idx: -1, lx: x, ly: y };
    if (drag) canvas.setPointerCapture(e.pointerId);
    return;
  }
  const uv = project(H_s2uv, x, y);
  canvas.setPointerCapture(e.pointerId);
  setPointerKey('p' + e.pointerId, keyAtUV(uv.x, uv.y), 0.8);
});
canvas.addEventListener('pointermove', (e) => {
  if (drag && drag.id === e.pointerId) {
    const x = Math.min(W, Math.max(0, e.clientX)), y = Math.min(H, Math.max(0, e.clientY));
    if (drag.idx >= 0) {
      corners[drag.idx] = { x: x / W, y: y / H };
    } else {
      const dx = (x - drag.lx) / W, dy = (y - drag.ly) / H;
      corners = corners.map((c) => ({ x: c.x + dx, y: c.y + dy }));
      drag.lx = x;
      drag.ly = y;
    }
    updateHomography();
  } else if (!adjusting && pointerKeys.has('p' + e.pointerId)) {
    const uv = project(H_s2uv, e.clientX, e.clientY);
    setPointerKey('p' + e.pointerId, keyAtUV(uv.x, uv.y), 0.8);
  }
});
const endPointer = (e) => {
  if (drag && drag.id === e.pointerId) drag = null;
  setPointerKey('p' + e.pointerId, null);
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function setAdjusting(on) {
  adjusting = on;
  if (on) releaseAll();
  else saveCorners();
  btnAdjust.textContent = on ? 'Fet' : 'Ajustar';
  btnAdjust.classList.toggle('active', on);
}
btnAdjust.addEventListener('click', () => setAdjusting(!adjusting));

btnSens.addEventListener('click', () => {
  sensIdx = (sensIdx + 1) % SENS.length;
  btnSens.textContent = `Sensibilitat: ${SENS[sensIdx].label}`;
});

btnCamera.addEventListener('click', async () => {
  releaseAll();
  facing = facing === 'user' ? 'environment' : 'user';
  try {
    await startCamera();
  } catch (err) {
    facing = facing === 'user' ? 'environment' : 'user';
    alert("No s'ha pogut canviar de càmera: " + err.message);
    await startCamera().catch(() => {});
  }
});

btnExit.addEventListener('click', () => {
  releaseAll();
  stream?.getTracks().forEach((t) => t.stop());
  location.href = 'index.html';
});

/* ---------------------------------------------------------------------
 *  Arrencada
 * ------------------------------------------------------------------- */
let landmarker = null;
let lastVideoTime = -1;
let landmarkerFailed = false;

function updateHint(now) {
  let text;
  if (landmarkerFailed) text = "No s'ha pogut carregar el detector de mans. Pots tocar amb el dit a la pantalla.";
  else if (!landmarker) text = 'Carregant el detector de mans…';
  else if (adjusting) text = 'Arrossega les cantonades (o el piano) fins que quedi a la taula i prem «Fet»';
  else if (now - lastHandsAt > 1200) text = 'Posa les mans a la taula, davant la càmera';
  else text = 'Pica la taula amb la punta dels dits sobre les tecles';
  if (hint.textContent !== text) hint.textContent = text;
}

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime && corners) {
    lastVideoTime = video.currentTime;
    try {
      processHands(landmarker.detectForVideo(video, now), now);
    } catch (err) {
      console.error(err);
    }
  }
  draw();
  updateHint(now);
}

async function loadLandmarker() {
  const { FilesetResolver, HandLandmarker } = await import(`${MP_BASE}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    return await HandLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    return await HandLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

btnStart.addEventListener('click', async () => {
  synth.init();
  btnStart.disabled = true;
  statusEl.className = 'support';
  statusEl.textContent = 'Obrint la càmera…';
  if (!navigator.mediaDevices?.getUserMedia) {
    statusEl.className = 'support warn';
    statusEl.textContent = 'Aquest navegador no pot accedir a la càmera (cal HTTPS).';
    btnStart.disabled = false;
    return;
  }
  try {
    await startCamera();
  } catch (err) {
    statusEl.className = 'support warn';
    statusEl.textContent = "No s'ha pogut obrir la càmera: " + err.message;
    btnStart.disabled = false;
    return;
  }
  intro.hidden = true;
  overlay.hidden = false;
  loop();
  try {
    landmarker = await loadLandmarker();
  } catch (err) {
    console.error(err);
    landmarkerFailed = true;
  }
});
