// Gos de festa: detecta un gos amb la càmera, li posa barret i ulleres i fa música segons com es mou.

const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

const $ = (id) => document.getElementById(id);
const intro = $('intro');
const overlay = $('overlay');
const hint = $('hint');
const statusEl = $('status');
const canvas = $('view');
const video = $('video');
const ctx = canvas.getContext('2d');

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/* =====================================================================
 *  Música: banda electrònica alegre que segueix el gos
 * ===================================================================== */
const CHORDS = [
  { name: 'Do', bass: 36, pad: [60, 64, 67], tones: [0, 4, 7] },
  { name: 'Lam', bass: 33, pad: [57, 60, 64], tones: [9, 0, 4] },
  { name: 'Fa', bass: 41, pad: [57, 60, 65], tones: [5, 9, 0] },
  { name: 'Sol', bass: 43, pad: [55, 59, 62], tones: [7, 11, 2] },
];
const MELODY = [];
for (const o of [60, 72]) for (const p of [0, 2, 4, 7, 9]) MELODY.push(o + p);
MELODY.push(84);

class DogBand {
  constructor() {
    this.energy = 0;
    this.headY = 0.5;
    this.present = false;
    this.enabled = true;
    this.bpm = 96;
    this.step = 0;
    this.lastMel = 7;
    this.beats = [];
    this.onNote = null;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state !== 'running') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // Reverb curta
    this.rev = ctx.createGain();
    const conv = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 1.6);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    conv.buffer = ir;
    const revOut = ctx.createGain();
    revOut.gain.value = 0.35;
    this.rev.connect(conv);
    conv.connect(revOut);
    revOut.connect(this.master);

    // Eco per a la melodia
    this.echo = ctx.createGain();
    this.echoDelay = ctx.createDelay(1);
    const fb = ctx.createGain();
    fb.gain.value = 0.3;
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.35;
    this.echo.connect(this.echoDelay);
    this.echoDelay.connect(fb);
    fb.connect(this.echoDelay);
    this.echoDelay.connect(echoOut);
    echoOut.connect(this.master);

    const n = Math.floor(ctx.sampleRate * 0.5);
    this.noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < n; i++) nd[i] = Math.random() * 2 - 1;

    this.nextTime = ctx.currentTime + 0.1;
    setInterval(() => this.schedule(), 25);
  }

  out(node, dry = 1, rev = 0, echo = 0) {
    if (dry) { const g = this.ctx.createGain(); g.gain.value = dry; node.connect(g); g.connect(this.master); }
    if (rev) { const g = this.ctx.createGain(); g.gain.value = rev; node.connect(g); g.connect(this.rev); }
    if (echo) { const g = this.ctx.createGain(); g.gain.value = echo; node.connect(g); g.connect(this.echo); }
  }

  env(t, peak, attack, decay) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  schedule() {
    const ctx = this.ctx;
    if (ctx.currentTime > this.nextTime + 0.2) this.nextTime = ctx.currentTime + 0.05;
    this.bpm += ((92 + this.energy * 50) - this.bpm) * 0.05;
    this.echoDelay.delayTime.setTargetAtTime((60 / this.bpm) * 0.75, ctx.currentTime, 0.2);
    while (this.nextTime < ctx.currentTime + 0.12) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += 60 / this.bpm / 4;
      this.step = (this.step + 1) % 64;
    }
  }

  playStep(step, t) {
    if (!this.enabled) return;
    const s = step % 16;
    const chord = CHORDS[Math.floor(step / 16) % 4];
    const e = this.present ? this.energy : 0;
    if (s % 4 === 0) {
      this.beats.push(t);
      if (this.beats.length > 8) this.beats.shift();
    }
    if (s === 0) this.pad(chord, t, (60 / this.bpm) * 4, this.present ? 0.045 : 0.03);
    if (!this.present) return;

    if ([0, 6, 8, 14].includes(s) || (e > 0.5 && [3, 11].includes(s))) this.bass(chord.bass + (s === 8 ? 12 : 0), t, 0.32);
    if (s % 8 === 0 || (e > 0.5 && s % 4 === 0)) this.kick(t, 0.85);
    if (e > 0.22 && s % 8 === 4) this.clap(t, 0.35 + e * 0.25);
    if (e > 0.1 && s % 2 === 0) this.hat(t, s % 4 === 2 ? 0.16 : 0.07);
    if (e > 0.6 && s % 2 === 1) this.hat(t, 0.05);

    const grid = e > 0.65 ? 1 : 2;
    if (s % grid === 0) {
      const p = (s % 4 === 0 ? 0.3 : 0.12) + e * 0.75;
      if (Math.random() < p) {
        const midi = this.pickNote(chord, s);
        this.woof(midi, t, 0.55 + e * 0.45);
        this.onNote?.(midi, t);
      }
    }
  }

  pickNote(chord, s) {
    // L'alçada del cap tria la zona; petit passeig aleatori per fer melodia
    const target = Math.round((1 - this.headY) * (MELODY.length - 1));
    let idx = clamp(Math.round((this.lastMel + target) / 2) + Math.floor(Math.random() * 3) - 1, 0, MELODY.length - 1);
    if (s % 4 === 0) {
      // temps forts: nota de l'acord més propera
      let best = idx, bestD = 99;
      MELODY.forEach((m, i) => {
        if (chord.tones.includes(m % 12) && Math.abs(i - idx) < bestD) { best = i; bestD = Math.abs(i - idx); }
      });
      idx = best;
    }
    this.lastMel = idx;
    return MELODY[idx];
  }

  // "Bup!": so de gos melòdic (pujada de to + formant que es tanca)
  woof(midi, t, v) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const g = this.env(t, 0.22 * v, 0.008, 0.22);
    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.Q.value = 2.2;
    formant.frequency.setValueAtTime(2400, t);
    formant.frequency.exponentialRampToValueAtTime(850, t + 0.13);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4000;
    for (const [type, det] of [['square', 0], ['sawtooth', 8]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = det;
      o.frequency.setValueAtTime(f * 1.4, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.045);
      o.frequency.exponentialRampToValueAtTime(f * 0.97, t + 0.22);
      o.connect(formant);
      o.start(t);
      o.stop(t + 0.3);
    }
    // cos del so (sinus) perquè sigui més "rodó"
    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(f * 1.4, t);
    body.frequency.exponentialRampToValueAtTime(f, t + 0.045);
    const bg = this.env(t, 0.5, 0.005, 0.2);
    body.connect(bg);
    bg.connect(g);
    body.start(t);
    body.stop(t + 0.3);
    formant.connect(lp);
    lp.connect(g);
    this.out(g, 1, 0.3, 0.5);
  }

  kick(t, v) {
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = this.env(t, v, 0.003, 0.28);
    o.connect(g);
    o.start(t);
    o.stop(t + 0.35);
    this.out(g);
  }

  noiseHit(t, v, type, freq, q, decay, rev = 0) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.env(t, v, 0.002, decay);
    src.connect(f);
    f.connect(g);
    src.start(t, Math.random() * 0.3);
    src.stop(t + decay + 0.05);
    this.out(g, 1, rev);
  }
  clap(t, v) {
    this.noiseHit(t, v, 'bandpass', 1500, 0.8, 0.16, 0.4);
    this.noiseHit(t + 0.012, v * 0.7, 'bandpass', 1800, 0.8, 0.12);
  }
  hat(t, v) { this.noiseHit(t, v, 'highpass', 7500, 0.7, 0.045); }

  bass(midi, t, v) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(200, t + 0.2);
    const g = this.env(t, v, 0.006, 0.26);
    for (const type of ['triangle', 'square']) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = mtof(midi);
      const og = ctx.createGain();
      og.gain.value = type === 'square' ? 0.25 : 1;
      o.connect(og);
      og.connect(lp);
      o.start(t);
      o.stop(t + 0.32);
    }
    lp.connect(g);
    this.out(g);
  }

  pad(chord, t, dur, v) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.25);
    g.gain.setValueAtTime(v, t + dur - 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.3);
    for (const m of chord.pad) {
      for (const [type, det] of [['triangle', -6], ['sine', 6]]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.detune.value = det;
        o.frequency.value = mtof(m);
        o.connect(g);
        o.start(t);
        o.stop(t + dur + 0.4);
      }
    }
    this.out(g, 1, 0.6);
  }

  boing() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(900, t + 0.25);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 18;
    const la = this.ctx.createGain();
    la.gain.value = 40;
    lfo.connect(la);
    la.connect(o.frequency);
    const g = this.env(t, 0.3, 0.01, 0.4);
    o.connect(g);
    o.start(t); lfo.start(t);
    o.stop(t + 0.5); lfo.stop(t + 0.5);
    this.out(g, 1, 0.3);
    this.noiseHit(t, 0.25, 'highpass', 5000, 0.5, 0.8, 0.5);
  }

  fanfare() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime + 0.05;
    [60, 64, 67, 72].forEach((m, i) => this.woof(m + 12, t + i * 0.09, 0.9));
  }

  beatPulse() {
    if (!this.ctx) return 0;
    const now = this.ctx.currentTime;
    let last = -1;
    for (const b of this.beats) if (b <= now) last = b;
    return last < 0 ? 0 : Math.exp(-(now - last) * 7);
  }
}
const band = new DogBand();

/* =====================================================================
 *  Càmera i detecció
 * ===================================================================== */
let W = 0, H = 0, dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
}
window.addEventListener('resize', resize);
resize();

let facing = 'environment';
let mirror = false;
let stream = null;
let vfit = { ox: 0, oy: 0, dw: 1, dh: 1, s: 1 };

function computeFit() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const s = Math.max(W / vw, H / vh);
  vfit = { dw: vw * s, dh: vh * s, ox: (W - vw * s) / 2, oy: (H - vh * s) / 2, s };
}

async function startCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  const st = stream.getVideoTracks()[0].getSettings?.() || {};
  mirror = (st.facingMode || facing) === 'user';
}

// Estat del gos
const dog = {
  box: null,       // caixa suavitzada (coordenades de pantalla)
  lastSeen: -1e9,
  present: false,
  facing: 1,       // +1 mira a la dreta, -1 a l'esquerra (vista lateral)
  energy: 0,
  head: null,
  prevHead: null,
  prevT: 0,
  jumpCooldown: 0,
};
let manualHead = null; // { u, v } relatiu a la caixa
const SIZES = [1, 1.25, 1.5, 0.8];
let sizeIdx = 0;

function boxFromDetection(bb) {
  let x = vfit.ox + bb.originX * vfit.s;
  const y = vfit.oy + bb.originY * vfit.s;
  const w = bb.width * vfit.s, h = bb.height * vfit.s;
  if (mirror) x = W - x - w;
  return { x, y, w, h };
}

function onDetections(res, now) {
  const dets = (res.detections || []).filter((d) => d.categories?.some((c) => c.categoryName === 'dog'));
  if (!dets.length) return;
  // el gos més gran (o el més proper a l'anterior)
  let best = null, bestScore = -Infinity;
  for (const d of dets) {
    const b = boxFromDetection(d.boundingBox);
    let score = b.w * b.h;
    if (dog.box) {
      const dx = (b.x + b.w / 2) - (dog.box.x + dog.box.w / 2), dy = (b.y + b.h / 2) - (dog.box.y + dog.box.h / 2);
      score -= Math.hypot(dx, dy) * 200;
    }
    if (score > bestScore) { bestScore = score; best = b; }
  }
  if (!dog.box || now - dog.lastSeen > 800) {
    dog.box = best;
  } else {
    const k = 0.45;
    for (const key of ['x', 'y', 'w', 'h']) dog.box[key] += (best[key] - dog.box[key]) * k;
  }
  dog.lastSeen = now;
}

function estimateHead(b) {
  const scale = SIZES[sizeIdx];
  if (manualHead) {
    return { x: b.x + manualHead.u * b.w, y: b.y + manualHead.v * b.h, size: Math.min(b.w, b.h) * 0.55 * scale };
  }
  const aspect = b.w / b.h;
  if (aspect < 1.2) {
    // assegut o de cara: cap a dalt al centre
    return { x: b.x + b.w * 0.5, y: b.y + b.h * 0.24, size: b.w * 0.55 * scale };
  }
  // de costat: cap a dalt, cap a on mira
  return {
    x: b.x + b.w * (dog.facing > 0 ? 0.8 : 0.2),
    y: b.y + b.h * 0.3,
    size: b.h * 0.5 * scale,
  };
}

function updateDog(now) {
  const visible = dog.box && now - dog.lastSeen < 700;
  if (visible && !dog.present) {
    band.fanfare();
    burstConfetti(dog.box.x + dog.box.w / 2, dog.box.y + dog.box.h * 0.2, 80);
  }
  dog.present = visible;
  band.present = visible;
  if (!visible) {
    dog.energy *= 0.97;
    band.energy = dog.energy;
    dog.prevHead = null;
    return;
  }
  const b = dog.box;
  const head = estimateHead(b);
  const dt = Math.max(0.016, (now - dog.prevT) / 1000);
  if (dog.prevHead) {
    const diag = Math.hypot(b.w, b.h);
    const vx = (head.x - dog.prevHead.x) / dt / diag;
    const vy = (head.y - dog.prevHead.y) / dt / diag;
    const speed = Math.hypot(vx, vy);
    const raw = clamp((speed - 0.12) * 1.6, 0, 1);
    dog.energy += (raw - dog.energy) * (raw > dog.energy ? 0.3 : 0.025);
    if (Math.abs(vx) > 0.25) dog.facing = Math.sign(vx);
    dog.lean = clamp(vx * 0.25, -0.35, 0.35);
    dog.jumpCooldown -= dt;
    if (vy < -1.1 && dog.jumpCooldown <= 0) {
      dog.jumpCooldown = 1.2;
      band.boing();
      burstConfetti(head.x, head.y, 120);
    }
  }
  dog.prevHead = { x: head.x, y: head.y };
  dog.prevT = now;
  dog.head = head;
  band.energy = dog.energy;
  band.headY = clamp(head.y / H, 0, 1);
}

/* =====================================================================
 *  Dibuix: barret de festa, ulleres, notes i confeti
 * ===================================================================== */
const notes = [];
const confetti = [];
const CONFETTI_COLORS = ['#ff3c9e', '#ffd23c', '#3ce1ff', '#7bff5c', '#b06cff', '#ff8a3c'];

function burstConfetti(x, y, n) {
  for (let i = 0; i < n && confetti.length < 500; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
    const sp = 200 + Math.random() * 400;
    confetti.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12,
      w: 5 + Math.random() * 6, h: 3 + Math.random() * 4,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)], life: 1,
    });
  }
}

band.onNote = (midi, t) => {
  const delay = Math.max(0, (t - band.ctx.currentTime) * 1000);
  setTimeout(() => {
    if (!dog.head) return;
    const h = dog.head;
    notes.push({
      x: h.x + (Math.random() - 0.5) * h.size * 0.8,
      y: h.y - h.size * 0.9,
      vx: (Math.random() - 0.5) * 40, vy: -60 - Math.random() * 50,
      life: 1, ch: Math.random() < 0.5 ? '♪' : '♫',
      hue: ((midi % 24) / 24) * 360, size: h.size * 0.28,
    });
  }, delay);
};

function drawHat(x, y, s, angle, squash) {
  const w = s * 0.62, h = s * 0.95;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(1 + (1 - squash) * 0.5, squash);

  ctx.beginPath();
  ctx.moveTo(-w / 2, 0);
  ctx.lineTo(0, -h);
  ctx.lineTo(w / 2, 0);
  ctx.quadraticCurveTo(0, w * 0.2, -w / 2, 0);
  ctx.closePath();
  const grad = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  grad.addColorStop(0, '#d81b7a');
  grad.addColorStop(0.45, '#ff6cc0');
  grad.addColorStop(1, '#b0105f');
  ctx.fillStyle = grad;
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = s * 0.08;
  ctx.shadowOffsetY = s * 0.03;
  ctx.fill();
  ctx.shadowColor = 'transparent';

  // Ratlles i punts
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = '#ffd23c';
  ctx.lineWidth = w * 0.1;
  for (let k = -4; k <= 4; k++) {
    ctx.beginPath();
    ctx.moveTo(-w + k * w * 0.32, 0);
    ctx.lineTo(w * 0.1 + k * w * 0.32, -h);
    ctx.stroke();
  }
  ctx.fillStyle = '#3ce1ff';
  for (let i = 0; i < 9; i++) {
    const py = -h * (0.15 + (i % 3) * 0.25), px = (((i * 37) % 10) / 10 - 0.5) * w * (1 + py / h);
    ctx.beginPath();
    ctx.arc(px, py, w * 0.045, 0, Math.PI * 2);
    ctx.fill();
  }
  // brillantor
  const shine = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
  shine.addColorStop(0.15, 'rgba(255,255,255,0)');
  shine.addColorStop(0.3, 'rgba(255,255,255,0.35)');
  shine.addColorStop(0.45, 'rgba(255,255,255,0)');
  ctx.fillStyle = shine;
  ctx.fillRect(-w, -h, w * 2, h * 1.2);
  ctx.restore();

  // Serrell de la vora
  ctx.fillStyle = '#ffffff';
  const teeth = 9;
  for (let i = 0; i < teeth; i++) {
    const t0 = i / teeth, t1 = (i + 1) / teeth;
    const xa = -w / 2 + w * t0, xb = -w / 2 + w * t1;
    const ya = Math.sin(Math.PI * t0) * w * 0.1, yb = Math.sin(Math.PI * t1) * w * 0.1;
    ctx.beginPath();
    ctx.moveTo(xa, ya);
    ctx.lineTo((xa + xb) / 2, (ya + yb) / 2 + w * 0.09);
    ctx.lineTo(xb, yb);
    ctx.closePath();
    ctx.fillStyle = i % 2 ? '#ffd23c' : '#ffffff';
    ctx.fill();
  }

  // Borla
  const pr = s * 0.1;
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * pr * 0.6, -h + Math.sin(a) * pr * 0.6, pr * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 ? '#ffd23c' : '#fff3a8';
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(0, -h, pr * 0.6, 0, Math.PI * 2);
  ctx.fillStyle = '#ffe36a';
  ctx.fill();
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r * 1.6);
  ctx.arcTo(x, y + h, x, y, r * 1.6);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawGlasses(x, y, s, angle) {
  const lw = s * 0.4, lh = s * 0.26, gap = s * 0.09;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = s * 0.06;
  ctx.shadowOffsetY = s * 0.02;

  // Barra superior
  ctx.fillStyle = '#0d0d10';
  roundRect(-gap / 2 - lw - s * 0.04, -lh * 0.62, lw * 2 + gap + s * 0.08, lh * 0.28, lh * 0.12);
  ctx.fill();
  ctx.shadowColor = 'transparent';

  for (const side of [-1, 1]) {
    const lx = side < 0 ? -gap / 2 - lw : gap / 2;
    // muntura
    ctx.fillStyle = '#0d0d10';
    roundRect(lx - s * 0.025, -lh / 2 - s * 0.025, lw + s * 0.05, lh + s * 0.05, lh * 0.32);
    ctx.fill();
    // vidre
    const g = ctx.createLinearGradient(0, -lh / 2, 0, lh / 2);
    g.addColorStop(0, '#3a2a5c');
    g.addColorStop(0.55, '#141022');
    g.addColorStop(1, '#2b1d48');
    ctx.fillStyle = g;
    roundRect(lx, -lh / 2, lw, lh, lh * 0.28);
    ctx.fill();
    // reflex
    ctx.save();
    roundRect(lx, -lh / 2, lw, lh, lh * 0.28);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = lw * 0.09;
    ctx.beginPath();
    ctx.moveTo(lx + lw * 0.15, lh * 0.5);
    ctx.lineTo(lx + lw * 0.55, -lh * 0.6);
    ctx.stroke();
    ctx.lineWidth = lw * 0.04;
    ctx.beginPath();
    ctx.moveTo(lx + lw * 0.42, lh * 0.5);
    ctx.lineTo(lx + lw * 0.75, -lh * 0.6);
    ctx.stroke();
    ctx.restore();
    // patilla
    ctx.strokeStyle = '#0d0d10';
    ctx.lineWidth = s * 0.035;
    ctx.beginPath();
    ctx.moveTo(side * (gap / 2 + lw), -lh * 0.35);
    ctx.lineTo(side * (gap / 2 + lw + s * 0.12), -lh * 0.25);
    ctx.stroke();
  }
  // pont
  ctx.strokeStyle = '#0d0d10';
  ctx.lineWidth = s * 0.04;
  ctx.beginPath();
  ctx.moveTo(-gap / 2, -lh * 0.15);
  ctx.quadraticCurveTo(0, -lh * 0.4, gap / 2, -lh * 0.15);
  ctx.stroke();
  ctx.restore();
}

function drawBrackets(b, pulse) {
  const L = Math.min(b.w, b.h) * 0.16;
  ctx.save();
  ctx.strokeStyle = `rgba(255,120,210,${0.55 + pulse * 0.4})`;
  ctx.shadowColor = '#ff3c9e';
  ctx.shadowBlur = 10;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  const pad = 6 + pulse * 6;
  const x0 = b.x - pad, y0 = b.y - pad, x1 = b.x + b.w + pad, y1 = b.y + b.h + pad;
  ctx.beginPath();
  ctx.moveTo(x0, y0 + L); ctx.lineTo(x0, y0); ctx.lineTo(x0 + L, y0);
  ctx.moveTo(x1 - L, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + L);
  ctx.moveTo(x1, y1 - L); ctx.lineTo(x1, y1); ctx.lineTo(x1 - L, y1);
  ctx.moveTo(x0 + L, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - L);
  ctx.stroke();
  ctx.restore();
}

function drawHUD(pulse) {
  const x = 14, y = 14;
  ctx.save();
  ctx.fillStyle = 'rgba(15,10,25,0.6)';
  roundRect(x, y + 48, 170, 52, 12);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '700 14px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`🐶 ${Math.round(band.bpm)} BPM`, x + 12, y + 70);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(x + 12, y + 80, 146, 8);
  const g = ctx.createLinearGradient(x + 12, 0, x + 158, 0);
  g.addColorStop(0, '#3ce1ff');
  g.addColorStop(0.5, '#ffd23c');
  g.addColorStop(1, '#ff3c9e');
  ctx.fillStyle = g;
  ctx.fillRect(x + 12, y + 80, 146 * dog.energy, 8);
  ctx.beginPath();
  ctx.arc(x + 150, y + 64, 4 + pulse * 3, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255,60,158,${0.4 + pulse * 0.6})`;
  ctx.fill();
  ctx.restore();
}

let lastFrame = performance.now();
function render(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (video.videoWidth) {
    computeFit();
    ctx.save();
    if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, vfit.ox, vfit.oy, vfit.dw, vfit.dh);
    ctx.restore();
  }

  const pulse = band.beatPulse();
  if (dog.present && dog.box && dog.head) {
    drawBrackets(dog.box, pulse);
    const h = dog.head;
    const lean = dog.lean || 0;
    const wobble = Math.sin(now / 1000 * 3) * 0.04;
    drawGlasses(h.x, h.y, h.size, lean * 0.5 + wobble * 0.5);
    const hatX = h.x - h.size * 0.08, hatY = h.y - h.size * 0.42 - pulse * h.size * 0.06;
    drawHat(hatX, hatY, h.size, -0.22 + lean + wobble, 1 - pulse * 0.08);
  }

  // Notes musicals
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i];
    n.life -= dt * 0.7;
    if (n.life <= 0) { notes.splice(i, 1); continue; }
    n.x += n.vx * dt + Math.sin(n.life * 8) * 0.6;
    n.y += n.vy * dt;
    ctx.font = `700 ${Math.max(16, n.size)}px system-ui, sans-serif`;
    ctx.fillStyle = `hsla(${n.hue},100%,65%,${n.life})`;
    ctx.shadowColor = `hsla(${n.hue},100%,60%,${n.life})`;
    ctx.shadowBlur = 12;
    ctx.fillText(n.ch, n.x, n.y);
  }
  ctx.shadowBlur = 0;

  // Confeti
  for (let i = confetti.length - 1; i >= 0; i--) {
    const c = confetti[i];
    c.vy += 600 * dt;
    c.vx *= 0.99;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.rot += c.vr * dt;
    c.life -= dt * 0.35;
    if (c.life <= 0 || c.y > H + 20) { confetti.splice(i, 1); continue; }
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.rot);
    ctx.scale(1, Math.cos(c.rot * 1.7));
    ctx.globalAlpha = Math.min(1, c.life * 2);
    ctx.fillStyle = c.color;
    ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    ctx.restore();
  }

  // Confeti extra quan la festa està a tope
  if (dog.present && dog.energy > 0.7 && pulse > 0.95 && dog.head) {
    burstConfetti(dog.head.x, dog.head.y - dog.head.size, 6);
  }

  if (landmarker) drawHUD(pulse);
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
  if (landmarkerFailed) text = "No s'ha pogut carregar el detector. Comprova la connexió i torna-ho a provar.";
  else if (!landmarker) text = 'Carregant el detector de gossos…';
  else if (!dog.present) text = 'Apunta la càmera a un gos 🐶';
  else if (now - dog.lastSeen < 700 && dog.energy < 0.05 && !manualHead) text = 'Si el barret no queda bé, toca el cap del gos';
  hint.classList.toggle('gone', !text);
  if (text && hint.textContent !== text) hint.textContent = text;
}

function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  const now = performance.now();
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    computeFit();
    try {
      onDetections(landmarker.detectForVideo(video, now), now);
    } catch (err) {
      console.error(err);
    }
  }
  updateDog(now);
  render(now);
  updateHint(now);
}

canvas.addEventListener('pointerdown', (e) => {
  const b = dog.box;
  if (!b || !dog.present) return;
  manualHead = { u: clamp((e.clientX - b.x) / b.w, -0.2, 1.2), v: clamp((e.clientY - b.y) / b.h, -0.2, 1.2) };
  $('btn-auto').textContent = 'Cap: manual';
  burstConfetti(e.clientX, e.clientY, 25);
});

$('btn-auto').addEventListener('click', (e) => {
  manualHead = null;
  e.currentTarget.textContent = 'Cap: auto';
});
$('btn-size').addEventListener('click', (e) => {
  sizeIdx = (sizeIdx + 1) % SIZES.length;
  e.currentTarget.textContent = `Mida ×${SIZES[sizeIdx]}`;
});
$('btn-music').addEventListener('click', (e) => {
  band.enabled = !band.enabled;
  e.currentTarget.classList.toggle('active', band.enabled);
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
$('btn-photo').addEventListener('click', () => {
  canvas.toBlob(async (blob) => {
    if (!blob) return;
    const file = new File([blob], 'gos-de-festa.png', { type: 'image/png' });
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Gos de festa' });
        return;
      }
    } catch { /* l'usuari ha cancel·lat: el descarreguem */ }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gos-de-festa.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
});
$('btn-exit').addEventListener('click', () => {
  running = false;
  band.present = false;
  band.enabled = false;
  stream?.getTracks().forEach((t) => t.stop());
  location.href = 'index.html?v=5';
});

async function loadDetector() {
  const { FilesetResolver, ObjectDetector } = await import(`${MP_BASE}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: 'VIDEO',
    scoreThreshold: 0.35,
    maxResults: 3,
    categoryAllowlist: ['dog'],
  });
  try {
    return await ObjectDetector.createFromOptions(fileset, opts('GPU'));
  } catch {
    return await ObjectDetector.createFromOptions(fileset, opts('CPU'));
  }
}

const btnStart = $('btn-start');
btnStart.addEventListener('click', async () => {
  band.init();
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
  try {
    landmarker = await loadDetector();
  } catch (err) {
    console.error(err);
    landmarkerFailed = true;
  }
});
