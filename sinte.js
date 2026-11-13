// Sintetitzador AR: es toca amb les mans a l'aire davant la càmera (MediaPipe Hands + Web Audio)

const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const $ = (id) => document.getElementById(id);
const intro = $('intro');
const overlay = $('overlay');
const hint = $('hint');
const statusEl = $('status');
const canvas = $('view');
const video = $('video');
const ctx = canvas.getContext('2d');
const fxCanvas = document.createElement('canvas');
const fx = fxCanvas.getContext('2d');

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/* =====================================================================
 *  Teoria musical: tot queda dins l'escala → sempre harmònic
 * ===================================================================== */
const NOTE_NAMES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];
const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
};
const KEYS = [
  { name: 'La menor', root: 57, scale: 'minor', degrees: [0, 5, 2, 6, 3, 4], penta: [0, 3, 5, 7, 10] },
  { name: 'Do major', root: 60, scale: 'major', degrees: [0, 5, 3, 4, 1, 2], penta: [0, 2, 4, 7, 9] },
  { name: 'Re dòrica', root: 62, scale: 'dorian', degrees: [0, 3, 6, 4, 1, 2], penta: [0, 3, 5, 7, 10] },
  { name: 'Fa lidi', root: 53, scale: 'lydian', degrees: [0, 1, 5, 2, 4, 6], penta: [0, 2, 4, 7, 9] },
];
let keyIdx = 0;

const noteLabel = (m) => `${NOTE_NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

function chordMidis(key, slot) {
  const sc = SCALES[key.scale];
  const deg = key.degrees[slot];
  const n = (k) => key.root + sc[(deg + k) % 7] + 12 * Math.floor((deg + k) / 7);
  return [n(0), n(2), n(4), n(6)]; // fonamental, 3a, 5a, 7a
}
function chordName(m) {
  const third = m[1] - m[0], fifth = m[2] - m[0], sev = m[3] - m[0];
  const root = NOTE_NAMES[m[0] % 12];
  if (fifth === 6) return `${root}ø`;
  if (third === 3) return `${root}m${sev === 10 ? '7' : ''}`;
  return `${root}${sev === 11 ? 'maj7' : '7'}`;
}
function leadNotes(key) {
  const out = [];
  for (let o = 0; o < 2; o++) for (const p of key.penta) out.push(key.root + o * 12 + p);
  out.push(key.root + 24);
  return out;
}

/* =====================================================================
 *  Motor de so
 * ===================================================================== */
const PRESETS = [
  { name: 'Supersaw', lead: [['sawtooth', -14], ['sawtooth', 0], ['sawtooth', 14], ['square', -1200]], mix: [0.3, 0.3, 0.3, 0.22], pad: 'sawtooth', q: 3 },
  { name: 'Vidre', lead: [['sine', 0], ['triangle', 1200], ['sine', 1902], ['sine', -1200]], mix: [0.6, 0.22, 0.12, 0.3], pad: 'triangle', q: 1 },
  { name: 'Analògic', lead: [['square', -7], ['sawtooth', 7], ['square', 1200], ['triangle', -1200]], mix: [0.3, 0.3, 0.1, 0.35], pad: 'square', q: 5 },
];
let presetIdx = 0;

class SynthEngine {
  init() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };

    // Sortida
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    const out = g(0.85);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.82;
    comp.connect(out);
    out.connect(ctx.destination);
    out.connect(this.analyser);
    this.dry = g(1);
    this.dry.connect(comp);

    // Reverb llarga
    this.revSend = g(1);
    const reverb = ctx.createConvolver();
    reverb.buffer = this.impulse(3.8, 2.6);
    const revOut = g(0.9);
    this.revSend.connect(reverb);
    reverb.connect(revOut);
    revOut.connect(comp);

    // Delay "ping-pong"
    this.dlySend = g(1);
    const dl = ctx.createDelay(2), dr = ctx.createDelay(2);
    dl.delayTime.value = 0.375;
    dr.delayTime.value = 0.375;
    const fbL = g(0.38), fbR = g(0.38);
    const merger = ctx.createChannelMerger(2);
    const dlyOut = g(0.55);
    this.dlySend.connect(dl);
    dl.connect(fbL); fbL.connect(dr);
    dr.connect(fbR); fbR.connect(dl);
    dl.connect(merger, 0, 0);
    dr.connect(merger, 0, 1);
    merger.connect(dlyOut);
    dlyOut.connect(comp);
    dlyOut.connect(this.revSend);

    // Melodia
    this.leadFilter = ctx.createBiquadFilter();
    this.leadFilter.type = 'lowpass';
    this.leadFilter.frequency.value = 1500;
    this.leadGain = g(0);
    this.leadAnalyser = ctx.createAnalyser();
    this.leadAnalyser.fftSize = 2048;
    this.leadEcho = g(0);
    const leadRev = g(0.35);
    this.leadFilter.connect(this.leadGain);
    this.leadGain.connect(this.dry);
    this.leadGain.connect(this.leadEcho);
    this.leadEcho.connect(this.dlySend);
    this.leadGain.connect(leadRev);
    leadRev.connect(this.revSend);
    this.leadGain.connect(this.leadAnalyser);
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibDepth = g(7);
    vib.connect(vibDepth);
    this.leadOscs = [];
    for (let i = 0; i < 4; i++) {
      const o = ctx.createOscillator();
      const og = g(0.3);
      vibDepth.connect(o.detune);
      o.connect(og);
      og.connect(this.leadFilter);
      this.leadOscs.push({ o, g: og });
      o.start();
    }
    vib.start();

    // Acords (pad)
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 1.5;
    const padLfo = ctx.createOscillator();
    padLfo.frequency.value = 0.09;
    const padLfoAmt = g(350);
    padLfo.connect(padLfoAmt);
    padLfoAmt.connect(this.padFilter.frequency);
    padLfo.start();
    const padOut = g(1);
    const padRev = g(0.8);
    this.padFilter.connect(padOut);
    padOut.connect(this.dry);
    padOut.connect(padRev);
    padRev.connect(this.revSend);
    this.padTones = [];
    for (let i = 0; i < 4; i++) {
      const tg = g(0);
      tg.connect(this.padFilter);
      const oscs = [-8, 8].map((d) => {
        const o = ctx.createOscillator();
        o.detune.value = d;
        o.connect(tg);
        o.start();
        return o;
      });
      this.padTones.push({ oscs, g: tg });
    }

    // Baix sub
    this.bass = ctx.createOscillator();
    this.bass.type = 'sine';
    this.bassGain = g(0);
    this.bass.connect(this.bassGain);
    this.bassGain.connect(this.dry);
    this.bass.start();

    this.setPreset(PRESETS[presetIdx]);
  }

  impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  setPreset(p) {
    if (!this.ctx) return;
    this.leadOscs.forEach((v, i) => {
      v.o.type = p.lead[i][0];
      v.o.detune.value = p.lead[i][1];
      v.g.gain.value = p.mix[i];
    });
    this.baseQ = p.q;
    for (const t of this.padTones) for (const o of t.oscs) o.type = p.pad;
  }

  setLead(freq, vol, cutoff, echo) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of this.leadOscs) v.o.frequency.setTargetAtTime(freq, t, 0.025);
    this.leadGain.gain.setTargetAtTime(vol * 0.28, t, vol > 0 ? 0.04 : 0.12);
    this.leadFilter.frequency.setTargetAtTime(cutoff, t, 0.06);
    this.leadFilter.Q.setTargetAtTime(this.baseQ + echo * 6, t, 0.1);
    this.leadEcho.gain.setTargetAtTime(echo, t, 0.1);
  }

  setPad(freqs, gains, bright) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.padTones.forEach((tone, i) => {
      for (const o of tone.oscs) o.frequency.setTargetAtTime(freqs[i], t, 0.06);
      tone.g.gain.setTargetAtTime(gains[i] * 0.11, t, 0.09);
    });
    this.padFilter.frequency.setTargetAtTime(bright, t, 0.12);
    this.bass.frequency.setTargetAtTime(freqs[0] / 4, t, 0.06);
    this.bassGain.gain.setTargetAtTime(Math.max(...gains) * 0.32, t, 0.12);
  }
}
const engine = new SynthEngine();

/* =====================================================================
 *  Pantalla i càmera
 * ===================================================================== */
let W = 0, H = 0, dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  fxCanvas.width = Math.round(W * 0.5);
  fxCanvas.height = Math.round(H * 0.5);
}
window.addEventListener('resize', resize);
resize();

let facing = 'user';
let mirror = true;
let stream = null;
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
  const s = stream.getVideoTracks()[0].getSettings?.() || {};
  mirror = (s.facingMode || facing) !== 'environment';
}

/* =====================================================================
 *  Mans → música
 * ===================================================================== */
const hands = { chord: null, lead: null };
const music = {
  leadIdx: -1, leadVol: 0, leadMidi: 57, leadHue: 190,
  chordSlot: -1, chordGains: [0, 0, 0, 0], chordMidis: [57, 60, 64, 67],
  lastHandsAt: 0,
};

function smoothHand(prev, next) {
  if (!next) return null;
  if (!prev) return next;
  return next.map((p, i) => ({ x: prev[i].x + (p.x - prev[i].x) * 0.6, y: prev[i].y + (p.y - prev[i].y) * 0.6 }));
}

function onResult(res, now) {
  const list = (res.landmarks || []).map((lm) => lm.map(lmToScreen));
  let chordPts = null, leadPts = null;
  if (list.length === 1) {
    if (list[0][9].x < W / 2) chordPts = list[0]; else leadPts = list[0];
  } else if (list.length >= 2) {
    const [a, b] = list[0][9].x < list[1][9].x ? [list[0], list[1]] : [list[1], list[0]];
    chordPts = a;
    leadPts = b;
  }
  hands.chord = smoothHand(hands.chord, chordPts);
  hands.lead = smoothHand(hands.lead, leadPts);
  if (list.length) music.lastHandsAt = now;
}

const palm = (P) => ({ x: (P[0].x + P[5].x + P[17].x) / 3, y: (P[0].y + P[5].y + P[17].y) / 3 });
const handSize = (P) => dist(P[0], P[9]) || 1;
const yNorm = (y) => clamp((y - H * 0.1) / (H * 0.78), 0, 0.9999);

function zoneWithHysteresis(cur, pos, n) {
  const z = pos * n;
  if (cur < 0 || Math.abs(z - (cur + 0.5)) > 0.68) return clamp(Math.floor(z), 0, n - 1);
  return cur;
}

function updateMusic() {
  const key = KEYS[keyIdx];
  const notes = leadNotes(key);

  // Melodia
  const L = hands.lead;
  if (L) {
    const c = palm(L), size = handSize(L);
    const pos = 1 - yNorm(c.y); // amunt = agut
    const idx = zoneWithHysteresis(music.leadIdx, pos, notes.length);
    if (idx !== music.leadIdx && music.leadIdx >= 0 && music.leadVol > 0.08) {
      ripples.push({ x: c.x, y: c.y, r: size * 0.6, life: 1, hue: 170 + idx * 17 });
    }
    music.leadIdx = idx;
    music.leadMidi = notes[idx];
    music.leadHue = 170 + idx * 17;
    const pinch = dist(L[4], L[8]) / size;
    music.leadVol = clamp((pinch - 0.22) / 0.75, 0, 1);
    const xN = clamp((c.x - W * 0.5) / (W * 0.5), 0, 1);
    const cutoff = 300 * Math.pow(30, xN);
    const spread = dist(L[8], L[20]) / size;
    const echo = clamp((spread - 0.45) / 0.9, 0, 1) * 0.6;
    engine.setLead(mtof(music.leadMidi), music.leadVol, cutoff, echo);
  } else {
    music.leadVol = 0;
    engine.setLead(mtof(music.leadMidi), 0, 800, 0);
  }

  // Acords
  const C = hands.chord;
  if (C) {
    const c = palm(C), size = handSize(C);
    const slot = zoneWithHysteresis(music.chordSlot, yNorm(c.y), key.degrees.length);
    if (slot !== music.chordSlot && music.chordSlot >= 0) {
      ripples.push({ x: c.x, y: c.y, r: size * 0.8, life: 1, hue: 280, big: true });
    }
    music.chordSlot = slot;
    music.chordMidis = chordMidis(key, slot);
    music.chordGains = [8, 12, 16, 20].map((tip) => clamp((dist(C[4], C[tip]) / size - 0.38) / 0.8, 0, 1));
    const xN = clamp(c.x / (W * 0.5), 0, 1);
    engine.setPad(music.chordMidis.map(mtof), music.chordGains, 500 + 3500 * xN);
  } else {
    music.chordGains = [0, 0, 0, 0];
    engine.setPad(music.chordMidis.map(mtof), music.chordGains, 800);
  }
}

/* =====================================================================
 *  Visuals
 * ===================================================================== */
const CONN = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const CHORD_HUES = [190, 240, 285, 330];
const ripples = [];
const particles = [];
let showGuides = true;
let waveBuf = new Float32Array(2048);
let freqBuf = new Uint8Array(512);

function wavePath(g, A, B, amp, sampler, segs = 72) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  g.beginPath();
  for (let i = 0; i <= segs; i++) {
    const s = i / segs;
    const v = sampler(s) * amp * Math.sin(Math.PI * s);
    const x = A.x + dx * s + nx * v, y = A.y + dy * s + ny * v;
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
}

function spawnAlong(A, B, n, hue) {
  for (let i = 0; i < n && particles.length < 400; i++) {
    const s = Math.random();
    const ang = Math.random() * Math.PI * 2;
    const sp = 20 + Math.random() * 60;
    particles.push({
      x: A.x + (B.x - A.x) * s, y: A.y + (B.y - A.y) * s,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 30,
      life: 1, decay: 0.6 + Math.random() * 0.8, hue: hue + (Math.random() - 0.5) * 30, size: 1.5 + Math.random() * 2.5,
    });
  }
}

function leadSampler() {
  engine.leadAnalyser.getFloatTimeDomainData(waveBuf);
  // busca un pas per zero ascendent perquè l'ona quedi estable
  let start = 0;
  for (let i = 1; i < 1024; i++) if (waveBuf[i - 1] < 0 && waveBuf[i] >= 0) { start = i; break; }
  let peak = 0.0001;
  for (let i = start; i < start + 512; i++) peak = Math.max(peak, Math.abs(waveBuf[i]));
  return (offset) => (s) => waveBuf[start + ((Math.floor(s * 380) + offset) % 512)] / peak;
}

function drawHand(P, hue, alpha) {
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = `hsla(${hue},100%,75%,${alpha * 0.45})`;
  ctx.beginPath();
  for (const [a, b] of CONN) { ctx.moveTo(P[a].x, P[a].y); ctx.lineTo(P[b].x, P[b].y); }
  ctx.stroke();
  ctx.fillStyle = `hsla(${hue},100%,85%,${alpha * 0.8})`;
  for (const i of [4, 8, 12, 16, 20]) {
    ctx.beginPath();
    ctx.arc(P[i].x, P[i].y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function glowText(text, x, y, size, hue) {
  ctx.font = `800 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = `hsl(${hue},100%,60%)`;
  ctx.shadowBlur = 18;
  ctx.fillStyle = `hsl(${hue},100%,88%)`;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;
}

function drawGuides() {
  const key = KEYS[keyIdx];
  const notes = leadNotes(key);
  const top = H * 0.1, span = H * 0.78;
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  // Melodia (dreta)
  ctx.textAlign = 'right';
  notes.forEach((m, i) => {
    const y = top + span * (1 - (i + 0.5) / notes.length);
    const active = i === music.leadIdx && hands.lead;
    ctx.fillStyle = active ? `hsla(${170 + i * 17},100%,80%,0.95)` : 'rgba(255,255,255,0.32)';
    ctx.fillText(noteLabel(m), W - 10, y);
    ctx.fillRect(W - 46, y, active ? 30 : 12, 1);
  });
  // Acords (esquerra)
  ctx.textAlign = 'left';
  key.degrees.forEach((_, i) => {
    const y = top + span * ((i + 0.5) / key.degrees.length);
    const active = i === music.chordSlot && hands.chord;
    ctx.fillStyle = active ? 'rgba(220,190,255,0.95)' : 'rgba(255,255,255,0.32)';
    ctx.font = `${active ? 800 : 600} ${active ? 14 : 12}px system-ui, sans-serif`;
    ctx.fillText(chordName(chordMidis(key, i)), 10, y);
  });
  // Divisòria
  const grad = ctx.createLinearGradient(0, top, 0, top + span);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(W / 2 - 0.5, top, 1, span);
}

let lastFrame = performance.now();

function render(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const t = now / 1000;

  // --- Fons: vídeo enfosquit ---
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#05040c';
  ctx.fillRect(0, 0, W, H);
  if (video.videoWidth) {
    computeFit();
    ctx.save();
    if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, vfit.ox, vfit.oy, vfit.dw, vfit.dh);
    ctx.restore();
    ctx.fillStyle = 'rgba(6,3,22,0.62)';
    ctx.fillRect(0, 0, W, H);
  }
  if (showGuides) drawGuides();

  // --- Capa de lluentor amb rastre (mitja resolució) ---
  fx.setTransform(fxCanvas.width / W, 0, 0, fxCanvas.height / H, 0, 0);
  fx.globalCompositeOperation = 'destination-out';
  fx.fillStyle = 'rgba(0,0,0,0.3)';
  fx.fillRect(0, 0, W, H);
  fx.globalCompositeOperation = 'lighter';
  fx.lineCap = 'round';
  fx.lineJoin = 'round';

  const cores = []; // línies fines nítides que es dibuixen després

  // Cordes d'acords
  const C = hands.chord;
  if (C) {
    const size = handSize(C);
    [8, 12, 16, 20].forEach((tip, i) => {
      const gain = music.chordGains[i];
      if (gain < 0.02) return;
      const f = mtof(music.chordMidis[i]);
      const cycles = clamp(f / 70, 2, 9);
      const ph = t * (4 + i * 1.7);
      const sampler = (s) => 0.75 * Math.sin(2 * Math.PI * cycles * s + ph) + 0.25 * Math.sin(2 * Math.PI * cycles * 2.01 * s - ph * 1.6);
      const amp = gain * size * 0.22 * (0.85 + 0.15 * Math.sin(t * 9 + i));
      const hue = CHORD_HUES[i];
      fx.strokeStyle = `hsla(${hue},100%,55%,${0.12 + gain * 0.22})`;
      fx.lineWidth = 4 + gain * 6;
      wavePath(fx, C[4], C[tip], amp, sampler);
      fx.stroke();
      cores.push({ A: C[4], B: C[tip], amp, sampler, hue, a: 0.5 + gain * 0.5 });
      if (Math.random() < gain * 0.5) spawnAlong(C[4], C[tip], 1, hue);
    });
  }

  // Cordes de melodia (ona real del so)
  const L = hands.lead;
  if (L && engine.ctx) {
    const size = handSize(L);
    const samp = leadSampler();
    const vol = music.leadVol;
    const hue = music.leadHue;
    const pairs = [[4, 8, 1, 0], [8, 12, 0.45, 60], [12, 16, 0.35, 120], [16, 20, 0.3, 180]];
    for (const [a, b, k, off] of pairs) {
      const amp = vol * size * 0.28 * k;
      const sampler = samp(off);
      const hh = hue + off * 0.25;
      fx.strokeStyle = `hsla(${hh},100%,55%,${0.1 + vol * 0.28})`;
      fx.lineWidth = (a === 4 ? 6 : 4) + vol * 6;
      wavePath(fx, L[a], L[b], amp, sampler, 96);
      fx.stroke();
      cores.push({ A: L[a], B: L[b], amp, sampler, hue: hh, a: 0.4 + vol * 0.6, segs: 96 });
    }
    if (Math.random() < vol * 0.8) spawnAlong(L[4], L[8], 1 + Math.floor(vol * 1.5), hue);

    // Oscil·loscopi circular al voltant del palmell
    if (vol > 0.03) {
      const c = palm(L);
      const r0 = size * (0.55 + vol * 0.35);
      const sampler = samp(0);
      fx.beginPath();
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        const r = r0 + sampler(i / 128) * size * 0.12 * vol;
        const x = c.x + Math.cos(a + t * 0.6) * r, y = c.y + Math.sin(a + t * 0.6) * r;
        if (i) fx.lineTo(x, y); else fx.moveTo(x, y);
      }
      fx.strokeStyle = `hsla(${hue + 40},100%,55%,${vol * 0.35})`;
      fx.lineWidth = 3;
      fx.stroke();
    }
  }

  // Ones expansives
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    r.r += (r.big ? 320 : 240) * dt;
    r.life -= dt * (r.big ? 0.9 : 1.3);
    if (r.life <= 0) { ripples.splice(i, 1); continue; }
    fx.beginPath();
    fx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    fx.strokeStyle = `hsla(${r.hue},100%,60%,${r.life * 0.35})`;
    fx.lineWidth = 2 + r.life * 4;
    fx.stroke();
  }

  // Partícules
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt * p.decay;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.vx *= 0.98;
    p.vy = p.vy * 0.98 - 12 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    fx.beginPath();
    fx.arc(p.x, p.y, p.size * (0.5 + p.life), 0, Math.PI * 2);
    fx.fillStyle = `hsla(${p.hue},100%,62%,${p.life * 0.5})`;
    fx.fill();
  }

  // Espectre a la part de baix
  if (engine.ctx) {
    engine.analyser.getByteFrequencyData(freqBuf);
    const n = 96;
    const base = H;
    const grad = fx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, 'hsla(190,100%,55%,0.22)');
    grad.addColorStop(0.5, 'hsla(290,100%,58%,0.3)');
    grad.addColorStop(1, 'hsla(190,100%,55%,0.22)');
    fx.beginPath();
    fx.moveTo(0, base);
    for (let side = -1; side <= 1; side += 2) {
      for (let k = 0; k <= n; k++) {
        const i = side < 0 ? n - k : k;
        const v = freqBuf[Math.floor(2 + i * 1.6)] / 255;
        const x = W / 2 + side * (i / n) * (W / 2);
        fx.lineTo(x, base - Math.pow(v, 1.6) * H * 0.2);
      }
    }
    fx.lineTo(W, base);
    fx.closePath();
    fx.fillStyle = grad;
    fx.fill();
  }

  // --- Composició ---
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(fxCanvas, 0, 0, W, H);
  ctx.lineCap = 'round';
  for (const c of cores) {
    ctx.strokeStyle = `hsla(${c.hue},100%,80%,${c.a})`;
    ctx.lineWidth = 2;
    wavePath(ctx, c.A, c.B, c.amp, c.sampler, c.segs || 72);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';

  if (C) {
    drawHand(C, 270, 1);
    const c = palm(C);
    if (music.chordGains.some((g) => g > 0.05)) glowText(chordName(music.chordMidis), c.x, c.y + handSize(C) * 0.9, 26, 280);
  }
  if (L) {
    drawHand(L, music.leadHue, 1);
    const c = palm(L);
    if (music.leadVol > 0.05) glowText(noteLabel(music.leadMidi), c.x, c.y + handSize(L) * 0.9, 30, music.leadHue);
  }
}

/* =====================================================================
 *  Bucle, controls i arrencada
 * ===================================================================== */
let landmarker = null;
let landmarkerFailed = false;
let lastVideoTime = -1;
let running = false;

function updateHint(now) {
  let text = '';
  if (landmarkerFailed) text = "No s'ha pogut carregar el detector de mans. Comprova la connexió i torna-ho a provar.";
  else if (!landmarker) text = 'Carregant el detector de mans…';
  else if (now - music.lastHandsAt > 1500) text = 'Aixeca les mans davant la càmera · esquerra: acords · dreta: melodia';
  hint.classList.toggle('gone', !text);
  if (text && hint.textContent !== text) hint.textContent = text;
}

function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  const now = performance.now();
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    try {
      onResult(landmarker.detectForVideo(video, now), now);
    } catch (err) {
      console.error(err);
    }
  }
  if (now - music.lastHandsAt > 300) { hands.chord = null; hands.lead = null; }
  updateMusic();
  render(now);
  updateHint(now);
}

$('btn-key').addEventListener('click', (e) => {
  keyIdx = (keyIdx + 1) % KEYS.length;
  music.leadIdx = -1;
  music.chordSlot = -1;
  e.currentTarget.textContent = `Escala: ${KEYS[keyIdx].name}`;
});
$('btn-preset').addEventListener('click', (e) => {
  presetIdx = (presetIdx + 1) % PRESETS.length;
  engine.setPreset(PRESETS[presetIdx]);
  e.currentTarget.textContent = `So: ${PRESETS[presetIdx].name}`;
});
$('btn-guides').addEventListener('click', (e) => {
  showGuides = !showGuides;
  e.currentTarget.classList.toggle('active', showGuides);
});
$('btn-camera').addEventListener('click', async () => {
  facing = facing === 'user' ? 'environment' : 'user';
  try {
    await startCamera();
  } catch (err) {
    facing = facing === 'user' ? 'environment' : 'user';
    alert("No s'ha pogut canviar de càmera: " + err.message);
    await startCamera().catch(() => {});
  }
});
$('btn-exit').addEventListener('click', () => {
  running = false;
  engine.setLead(440, 0, 800, 0);
  engine.setPad([220, 220, 220, 220], [0, 0, 0, 0], 800);
  stream?.getTracks().forEach((t) => t.stop());
  overlay.hidden = true;
  intro.hidden = false;
  btnStart.disabled = false;
  statusEl.textContent = '';
});

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

const btnStart = $('btn-start');
btnStart.addEventListener('click', async () => {
  engine.init();
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
  running = true;
  loop();
  if (!landmarker && !landmarkerFailed) {
    try {
      landmarker = await loadLandmarker();
    } catch (err) {
      console.error(err);
      landmarkerFailed = true;
    }
  }
});
