import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = (id) => document.getElementById(id);
const intro = $('intro');
const overlay = $('overlay');
const hint = $('hint');
const supportMsg = $('support');
const btnAR = $('btn-ar');
const btn3D = $('btn-3d');
const btnPlace = $('btn-place');
const btnSize = $('btn-size');
const btnExit = $('btn-exit');
const btnOctDown = $('btn-octave-down');
const btnOctUp = $('btn-octave-up');
const octaveLabel = $('octave-label');

/* =====================================================================
 *  Àudio: síntesi de piano amb Web Audio (sense mostres externes)
 * ===================================================================== */
class PianoSynth {
  constructor() {
    this.ctx = null;
    this.voices = new Map();
  }

  init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      comp.connect(ctx.destination);

      this.master = ctx.createGain();
      this.master.gain.value = 0.7;
      this.master.connect(comp);

      // Reverb curta generada
      const reverb = ctx.createConvolver();
      reverb.buffer = this.makeImpulse(2.2, 3);
      const wet = ctx.createGain();
      wet.gain.value = 0.18;
      this.master.connect(reverb);
      reverb.connect(wet);
      wet.connect(comp);

      // Soroll per a l'impacte del martell
      const len = Math.floor(ctx.sampleRate * 0.05);
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state !== 'running') this.ctx.resume();
  }

  makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  noteOn(midi, velocity = 0.8) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.kill(midi, t);

    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const vel = Math.min(1, Math.max(0.15, velocity));

    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(this.master);

    // Filtre que s'enfosqueix amb el temps (com una corda real)
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.Q.value = 0.5;
    tone.frequency.setValueAtTime(Math.min(18000, f * (4 + vel * 10)), t);
    tone.frequency.exponentialRampToValueAtTime(Math.min(18000, Math.max(f * 1.5, 300)), t + 1.5);
    tone.connect(out);

    const sustain = Math.min(6, Math.max(0.8, 4.5 * Math.pow(261.6 / f, 0.55)));
    const partials = [1, 0.55, 0.32, 0.2, 0.12, 0.08, 0.05];
    const B = 0.0004; // inharmonicitat
    const amp0 = 0.2 * vel;
    const oscs = [];

    partials.forEach((a, i) => {
      const n = i + 1;
      const pf = f * n * Math.sqrt(1 + B * n * n);
      if (pf > ctx.sampleRate / 2 - 1000) return;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = pf;
      o.detune.value = (Math.random() - 0.5) * 3;
      const g = ctx.createGain();
      const peak = amp0 * a;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.004);
      g.gain.setTargetAtTime(peak * 0.4, t + 0.004, 0.07);
      g.gain.setTargetAtTime(0.0001, t + 0.15, sustain / (4 * (1 + 0.5 * (n - 1))));
      o.connect(g);
      g.connect(tone);
      o.start(t);
      oscs.push(o);
    });

    // Cop del martell
    const ns = ctx.createBufferSource();
    ns.buffer = this.noise;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = Math.min(8000, f * 3);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.05 * vel, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    ns.connect(nf);
    nf.connect(ng);
    ng.connect(out);
    ns.start(t);
    ns.stop(t + 0.05);

    const end = t + sustain * 1.6 + 0.5;
    oscs.forEach((o) => o.stop(end));
    const voice = { out, oscs };
    oscs[0].onended = () => {
      out.disconnect();
      if (this.voices.get(midi) === voice) this.voices.delete(midi);
    };
    this.voices.set(midi, voice);
  }

  noteOff(midi) {
    const v = this.voices.get(midi);
    if (!v || !this.ctx) return;
    this.release(v, this.ctx.currentTime, 0.12);
  }

  release(v, t, tc) {
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setValueAtTime(v.out.gain.value, t);
    v.out.gain.setTargetAtTime(0, t, tc);
    const stopAt = t + tc * 8;
    v.oscs.forEach((o) => { try { o.stop(stopAt); } catch { /* ja aturat */ } });
  }

  kill(midi, t) {
    const v = this.voices.get(midi);
    if (v) {
      this.release(v, t, 0.015);
      this.voices.delete(midi);
    }
  }
}
const synth = new PianoSynth();

/* =====================================================================
 *  Escena
 * ===================================================================== */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 0.6));

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 20);

// Taula (només en mode 3D)
const table = new THREE.Mesh(
  new THREE.BoxGeometry(1.6, 0.03, 1.0),
  new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.7 })
);
table.position.y = -0.015;
table.receiveShadow = true;
table.visible = false;
scene.add(table);

// Retícula per al hit-test
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.05, 0.065, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

/* =====================================================================
 *  Piano (mides reals, en metres)
 * ===================================================================== */
const WHITE_W = 0.0235;
const WHITE_L = 0.15;
const WHITE_H = 0.022;
const BLACK_W = 0.0135;
const BLACK_L = 0.095;
const BLACK_EXTRA = 0.012;
const BASE_H = 0.01;
const NUM_SEMITONES = 25; // dues octaves + Do final
const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
const SIZES = [1, 1.5, 2];

let baseMidi = 60; // Do4
let sizeIdx = 0;

const piano = new THREE.Group();
piano.visible = false;
scene.add(piano);

const keys = [];
const keyMeshes = [];
const PRESSED_WHITE = new THREE.Color(0x9cc0ff);
const PRESSED_BLACK = new THREE.Color(0x3a6df0);
let shadowPlane;

function makeLabel() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { canvas, tex };
}

function drawLabel(label, text) {
  const g = label.canvas.getContext('2d');
  g.clearRect(0, 0, 128, 64);
  g.fillStyle = '#8b8b92';
  g.font = 'bold 40px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 34);
  label.tex.needsUpdate = true;
}

function buildPiano() {
  const whiteCount = Array.from({ length: NUM_SEMITONES }, (_, i) => i).filter((i) => WHITE_PCS.includes(i % 12)).length;
  const totalW = whiteCount * WHITE_W;
  const left = -totalW / 2;
  const whiteTop = BASE_H + WHITE_H;
  const margin = 0.016;
  const backDepth = 0.05;

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.25, metalness: 0.2 });

  const base = new THREE.Mesh(new THREE.BoxGeometry(totalW + 2 * margin, BASE_H, WHITE_L + backDepth), bodyMat);
  base.position.set(0, BASE_H / 2, -backDepth / 2);
  const back = new THREE.Mesh(new THREE.BoxGeometry(totalW + 2 * margin, 0.05, backDepth), bodyMat);
  back.position.set(0, 0.025, -WHITE_L / 2 - backDepth / 2);
  const felt = new THREE.Mesh(
    new THREE.BoxGeometry(totalW, 0.004, 0.004),
    new THREE.MeshStandardMaterial({ color: 0x8b1a1a, roughness: 0.9 })
  );
  felt.position.set(0, whiteTop + 0.004, -WHITE_L / 2 + 0.002);
  piano.add(base, back, felt);

  for (const side of [-1, 1]) {
    const cheek = new THREE.Mesh(new THREE.BoxGeometry(margin, whiteTop + 0.012, WHITE_L + backDepth), bodyMat);
    cheek.position.set(side * (totalW / 2 + margin / 2), (whiteTop + 0.012) / 2, -backDepth / 2);
    piano.add(cheek);
  }
  for (const m of piano.children) { m.castShadow = true; m.receiveShadow = true; }

  const whiteGeo = new THREE.BoxGeometry(WHITE_W - 0.0012, WHITE_H, WHITE_L);
  const blackGeo = new THREE.BoxGeometry(BLACK_W, WHITE_H + BLACK_EXTRA, BLACK_L);
  let wi = 0;
  for (let s = 0; s < NUM_SEMITONES; s++) {
    const pc = s % 12;
    const isBlack = !WHITE_PCS.includes(pc);
    let mesh, mat, k;
    if (!isBlack) {
      mat = new THREE.MeshStandardMaterial({ color: 0xf7f5ef, roughness: 0.3 });
      mesh = new THREE.Mesh(whiteGeo, mat);
      mesh.position.set(left + (wi + 0.5) * WHITE_W, BASE_H + WHITE_H / 2, 0);
      k = { x0: left + wi * WHITE_W, x1: left + (wi + 1) * WHITE_W, z0: -WHITE_L / 2, z1: WHITE_L / 2, top: whiteTop };
      wi++;
    } else {
      mat = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.2 });
      mesh = new THREE.Mesh(blackGeo, mat);
      const cx = left + wi * WHITE_W;
      mesh.position.set(cx, BASE_H + (WHITE_H + BLACK_EXTRA) / 2, -WHITE_L / 2 + BLACK_L / 2);
      k = { x0: cx - BLACK_W / 2, x1: cx + BLACK_W / 2, z0: -WHITE_L / 2, z1: -WHITE_L / 2 + BLACK_L, top: whiteTop + BLACK_EXTRA };
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    Object.assign(k, { semitone: s, isBlack, mesh, mat, baseColor: mat.color.clone(), restY: mesh.position.y, count: 0 });
    mesh.userData.key = k;

    if (pc === 0) {
      k.label = makeLabel();
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(WHITE_W * 0.85, WHITE_W * 0.425),
        new THREE.MeshBasicMaterial({ map: k.label.tex, transparent: true, depthWrite: false })
      );
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(0, WHITE_H / 2 + 0.0004, WHITE_L / 2 - 0.014);
      mesh.add(plane);
    }

    keys.push(k);
    keyMeshes.push(mesh);
    piano.add(mesh);
  }

  // Ombra sobre la taula real
  shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(totalW + 0.3, WHITE_L + 0.3).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ opacity: 0.35 })
  );
  shadowPlane.position.set(0, 0.0005, -0.02);
  shadowPlane.receiveShadow = true;
  piano.add(shadowPlane);

  const light = new THREE.DirectionalLight(0xffffff, 1.6);
  light.position.set(0.15, 0.6, 0.3);
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  Object.assign(light.shadow.camera, { left: -0.6, right: 0.6, top: 0.6, bottom: -0.6, near: 0.05, far: 2 });
  light.shadow.bias = -0.0005;
  light.shadow.normalBias = 0.002;
  const target = new THREE.Object3D();
  piano.add(light, target);
  light.target = target;
}
buildPiano();

const noteName = (midi) => `Do${Math.floor(midi / 12) - 1}`;

function updateLabels() {
  for (const k of keys) if (k.label) drawLabel(k.label, noteName(baseMidi + k.semitone));
  octaveLabel.textContent = `${noteName(baseMidi)}–${noteName(baseMidi + NUM_SEMITONES - 1)}`;
}
updateLabels();

/* =====================================================================
 *  Estat de tecles i "punters" (dits, tocs, ratolí, teclat)
 * ===================================================================== */
function setKeyVisual(k, down) {
  k.mesh.position.y = k.restY - (down ? 0.004 : 0);
  k.mesh.rotation.x = down ? 0.03 : 0;
  k.mat.color.copy(down ? (k.isBlack ? PRESSED_BLACK : PRESSED_WHITE) : k.baseColor);
}

function pressKey(k, vel) {
  if (k.count++ === 0) {
    synth.noteOn(baseMidi + k.semitone, vel);
    setKeyVisual(k, true);
  }
}

function releaseKey(k) {
  if (k.count <= 0) return;
  if (--k.count === 0) {
    synth.noteOff(baseMidi + k.semitone);
    setKeyVisual(k, false);
  }
}

const pointerKeys = new Map(); // id -> tecla

function setPointerKey(id, key, vel = 0.8) {
  const prev = pointerKeys.get(id) || null;
  if (prev === key) return;
  if (prev) releaseKey(prev);
  if (key) {
    pointerKeys.set(id, key);
    pressKey(key, vel);
  } else {
    pointerKeys.delete(id);
  }
}

function releaseAll() {
  pointerKeys.clear();
  for (const k of keys) {
    if (k.count > 0) {
      k.count = 0;
      synth.noteOff(baseMidi + k.semitone);
      setKeyVisual(k, false);
    }
  }
}

function keyAtLocal(p) {
  const inside = (k) => p.x >= k.x0 && p.x <= k.x1 && p.z >= k.z0 && p.z <= k.z1;
  for (const k of keys) if (k.isBlack && inside(k)) return k;
  for (const k of keys) if (!k.isBlack && inside(k)) return k;
  return null;
}

const raycaster = new THREE.Raycaster();
function keyFromRay() {
  const hit = raycaster.intersectObjects(keyMeshes, false)[0];
  return hit ? hit.object.userData.key : null;
}

/* =====================================================================
 *  Controls de la interfície
 * ===================================================================== */
function shiftOctave(dir) {
  const next = baseMidi + dir * 12;
  if (next < 24 || next > 84) return;
  releaseAll();
  baseMidi = next;
  updateLabels();
}
btnOctDown.addEventListener('click', () => shiftOctave(-1));
btnOctUp.addEventListener('click', () => shiftOctave(1));

btnSize.addEventListener('click', () => {
  sizeIdx = (sizeIdx + 1) % SIZES.length;
  piano.scale.setScalar(SIZES[sizeIdx]);
  btnSize.textContent = `Mida ×${SIZES[sizeIdx]}`;
  if (mode === '3d') fitCamera();
});

btnPlace.addEventListener('click', () => {
  releaseAll();
  placed = false;
  piano.visible = false;
  setHint(hitTestSource ? 'Busca una superfície plana…' : 'Toca la pantalla per col·locar el piano davant teu');
});

btnExit.addEventListener('click', () => {
  if (mode === 'ar') renderer.xr.getSession()?.end();
  else if (mode === '3d') exit3D();
});

// Evita que els tocs als botons es converteixin en "select" de WebXR
overlay.addEventListener('beforexrselect', (e) => {
  if (e.target.closest('#controls')) e.preventDefault();
});

function setHint(text) {
  if (hint.textContent !== text) hint.textContent = text;
}

/* =====================================================================
 *  Mode AR (WebXR)
 * ===================================================================== */
let mode = null; // 'ar' | '3d' | null
let placed = false;
let hitTestSource = null;
const activeRays = new Set();
const sourceIds = new WeakMap();
let nextSourceId = 1;
const srcId = (src) => {
  if (!sourceIds.has(src)) sourceIds.set(src, nextSourceId++);
  return sourceIds.get(src);
};
const tipState = new Map();
const TIP_JOINTS = ['thumb-tip', 'index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'];

async function startAR() {
  synth.init();
  overlay.hidden = false;
  overlay.classList.remove('mode-3d');
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      optionalFeatures: ['hit-test', 'dom-overlay', 'hand-tracking', 'local-floor'],
      domOverlay: { root: overlay },
    });
  } catch (err) {
    overlay.hidden = true;
    alert("No s'ha pogut iniciar la sessió AR: " + err.message);
    return;
  }

  mode = 'ar';
  placed = false;
  piano.visible = false;
  piano.position.set(0, 0, 0);
  table.visible = false;
  shadowPlane.visible = true;
  scene.background = null;
  intro.hidden = true;

  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(session);

  hitTestSource = null;
  try {
    const viewerSpace = await session.requestReferenceSpace('viewer');
    hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
  } catch {
    hitTestSource = null;
  }
  setHint(hitTestSource ? 'Busca una superfície plana…' : 'Toca la pantalla per col·locar el piano davant teu');

  session.addEventListener('selectstart', (e) => {
    if (placed && !e.inputSource.hand) activeRays.add(e.inputSource);
  });
  session.addEventListener('selectend', (e) => {
    activeRays.delete(e.inputSource);
    setPointerKey('ray:' + srcId(e.inputSource), null);
  });
  session.addEventListener('select', () => {
    if (!placed) placePiano();
  });
  session.addEventListener('end', onSessionEnd);
}

function onSessionEnd() {
  hitTestSource?.cancel?.();
  hitTestSource = null;
  activeRays.clear();
  tipState.clear();
  releaseAll();
  mode = null;
  placed = false;
  piano.visible = false;
  reticle.visible = false;
  overlay.hidden = true;
  intro.hidden = false;
}

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const camPos = new THREE.Vector3();

function placePiano() {
  camera.getWorldPosition(camPos);
  if (reticle.visible) {
    piano.position.setFromMatrixPosition(reticle.matrix);
  } else if (!hitTestSource) {
    // Sense hit-test: davant de l'usuari, una mica per sota del cap
    camera.getWorldDirection(tmpV);
    tmpV.y = 0;
    tmpV.normalize();
    piano.position.copy(camPos).addScaledVector(tmpV, 0.45);
    piano.position.y -= 0.35;
  } else {
    return; // encara no s'ha detectat cap superfície
  }
  piano.rotation.set(0, Math.atan2(camPos.x - piano.position.x, camPos.z - piano.position.z), 0);
  piano.visible = true;
  reticle.visible = false;
  placed = true;
  setHint('Toca les tecles! (o fes servir les mans)');
}

function updateXR(frame, time) {
  const refSpace = renderer.xr.getReferenceSpace();
  const session = frame.session;

  // 1) Detecció de superfícies
  if (!placed) {
    if (hitTestSource) {
      const results = frame.getHitTestResults(hitTestSource);
      if (results.length) {
        const pose = results[0].getPose(refSpace);
        reticle.matrix.fromArray(pose.transform.matrix);
        reticle.visible = true;
        setHint('Toca la pantalla per col·locar el piano');
      } else {
        reticle.visible = false;
        setHint('Busca una superfície plana…');
      }
    }
    return;
  }

  // 2) Tocs a la pantalla / raigs de controladors
  for (const src of activeRays) {
    const pose = frame.getPose(src.targetRaySpace, refSpace);
    const id = 'ray:' + srcId(src);
    if (!pose) { setPointerKey(id, null); continue; }
    const { position: p, orientation: o } = pose.transform;
    raycaster.ray.origin.set(p.x, p.y, p.z);
    raycaster.ray.direction.set(0, 0, -1).applyQuaternion(tmpQ.set(o.x, o.y, o.z, o.w));
    setPointerKey(id, keyFromRay(), 0.8);
  }

  // 3) Seguiment de mans: les puntes dels dits premen les tecles
  const seen = new Set();
  const scale = piano.scale.x;
  for (const src of session.inputSources) {
    if (!src.hand || !frame.getJointPose) continue;
    for (const jn of TIP_JOINTS) {
      const space = src.hand.get(jn);
      const id = `hand:${src.handedness}:${jn}`;
      seen.add(id);
      const jp = space && frame.getJointPose(space, refSpace);
      if (!jp) { setPointerKey(id, null); continue; }
      const jpos = jp.transform.position;
      tmpV.set(jpos.x, jpos.y, jpos.z);
      piano.worldToLocal(tmpV);
      const r = (jp.radius || 0.008) / scale;
      const bottom = tmpV.y - r;

      // velocitat de baixada -> intensitat
      const st = tipState.get(id) || { y: tmpV.y, t: time };
      const dt = Math.max(1, time - st.t) / 1000;
      const downSpeed = ((st.y - tmpV.y) * scale) / dt;
      tipState.set(id, { y: tmpV.y, t: time });

      const cur = pointerKeys.get(id);
      const k = keyAtLocal(tmpV);
      let target = null;
      if (k) {
        const threshold = cur === k ? k.top + 0.004 : k.top - 0.002; // histèresi
        if (bottom < threshold && bottom > -0.04) target = k;
      }
      const vel = THREE.MathUtils.clamp(0.35 + downSpeed * 1.5, 0.3, 1);
      setPointerKey(id, target, vel);
    }
  }
  for (const id of [...pointerKeys.keys()]) {
    if (id.startsWith('hand:') && !seen.has(id)) setPointerKey(id, null);
  }
}

/* =====================================================================
 *  Mode 3D (sense AR) — per provar a l'ordinador o en mòbils sense AR
 * ===================================================================== */
function start3D() {
  synth.init();
  mode = '3d';
  placed = true;
  intro.hidden = true;
  overlay.hidden = false;
  overlay.classList.add('mode-3d');
  scene.background = new THREE.Color(0x1b1d24);
  table.visible = true;
  shadowPlane.visible = false;
  piano.position.set(0, 0, 0);
  piano.rotation.set(0, 0, 0);
  piano.visible = true;
  fitCamera();
  setHint(matchMedia('(pointer: coarse)').matches
    ? 'Toca les tecles (pots fer acords amb diversos dits)'
    : 'Clica les tecles o usa el teclat: A W S E D F T G Y H U J K · Z/X canvien d\'octava');
}

function exit3D() {
  releaseAll();
  mode = null;
  piano.visible = false;
  table.visible = false;
  overlay.hidden = true;
  intro.hidden = false;
}

function fitCamera() {
  camera.aspect = window.innerWidth / window.innerHeight;
  const s = piano.scale.x;
  const vf = THREE.MathUtils.degToRad(camera.fov) / 2;
  const hf = Math.atan(Math.tan(vf) * camera.aspect);
  const d = Math.max((0.25 * s) / Math.tan(hf), (0.16 * s) / Math.tan(vf));
  const elev = THREE.MathUtils.degToRad(55);
  camera.position.set(0, d * Math.sin(elev), d * Math.cos(elev) + 0.01 * s);
  camera.lookAt(0, 0.02 * s, 0.005 * s);
  camera.updateProjectionMatrix();
}

const canvas = renderer.domElement;
const ndc = new THREE.Vector2();
const downPointers = new Set();

function updateMousePointer(e) {
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  setPointerKey('p' + e.pointerId, keyFromRay(), 0.8);
}
canvas.addEventListener('pointerdown', (e) => {
  if (mode !== '3d') return;
  canvas.setPointerCapture(e.pointerId);
  downPointers.add(e.pointerId);
  updateMousePointer(e);
});
canvas.addEventListener('pointermove', (e) => {
  if (mode === '3d' && downPointers.has(e.pointerId)) updateMousePointer(e);
});
const endPointer = (e) => {
  downPointers.delete(e.pointerId);
  setPointerKey('p' + e.pointerId, null);
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

const KEYMAP = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8,
  KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
};
window.addEventListener('keydown', (e) => {
  if (!mode || !placed || e.repeat || e.metaKey || e.ctrlKey) return;
  if (e.code === 'KeyZ') return shiftOctave(-1);
  if (e.code === 'KeyX') return shiftOctave(1);
  const s = KEYMAP[e.code];
  if (s !== undefined && keys[s]) setPointerKey('kb:' + e.code, keys[s], 0.8);
});
window.addEventListener('keyup', (e) => setPointerKey('kb:' + e.code, null));
window.addEventListener('blur', releaseAll);

/* =====================================================================
 *  Bucle i arrencada
 * ===================================================================== */
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (mode === '3d') fitCamera();
  else {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
});

renderer.setAnimationLoop((time, frame) => {
  if (frame && mode === 'ar') updateXR(frame, time);
  if (mode) renderer.render(scene, camera);
});

btnAR.addEventListener('click', startAR);
btn3D.addEventListener('click', start3D);

async function checkSupport() {
  const noAR = (why) => {
    btnAR.disabled = true;
    supportMsg.className = 'support warn';
    supportMsg.textContent = why;
  };
  if (!window.isSecureContext) return noAR("Cal obrir la pàgina amb HTTPS per fer servir l'AR.");
  if (!navigator.xr) return noAR('Aquest navegador no suporta WebXR. Prova Chrome a Android o el navegador de Meta Quest. Pots fer servir el mode 3D.');
  try {
    if (await navigator.xr.isSessionSupported('immersive-ar')) {
      supportMsg.className = 'support ok';
      supportMsg.textContent = 'AR disponible ✓';
    } else {
      noAR("Aquest dispositiu no suporta AR immersiva. Prova Chrome a Android (amb ARCore) o Meta Quest. Pots fer servir el mode 3D.");
    }
  } catch {
    noAR("No s'ha pogut comprovar el suport d'AR. Pots fer servir el mode 3D.");
  }
}
checkSupport();
