// Atrapado: un pequeño humano vive dentro de la pantalla del móvil.
// La pantalla es el cristal de una habitación que se ve desde arriba. La inclinación del móvil
// mueve el humano y los muebles; la cámara frontal sigue tus ojos para ajustar la perspectiva
// (proyección "off-axis": la pantalla se comporta como una ventana real).

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const DEG = Math.PI / 180;
const HALF_PI = Math.PI / 2;

const isTouch = matchMedia('(pointer: coarse)').matches;
const PX_PER_CM = isTouch ? 60 : 38; // píxeles CSS por centímetro (aprox.)

// Física (unidades del mundo: el lado corto de la pantalla mide 1)
const G = 3.6;        // aceleración por inclinación
const GZ = 4.2;       // gravedad vertical (hacia el suelo)
const H_R = 0.034;    // radio del humano
const HUMAN_H = 0.3;  // altura del humano

/* =====================================================================
 *  Render
 * ===================================================================== */
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#e9e2d8');
const camera = new THREE.PerspectiveCamera();

let W = 1, H = 2, D = 0.9, CM_PER_UNIT = 6.5;

const hemi = new THREE.HemisphereLight('#ffffff', '#cbbca8', 1.25);
hemi.position.set(0, 0, 1);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff4e6', 1.7);
sun.position.set(0.35, 0.55, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 5;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.002;
sun.shadow.radius = 3;
scene.add(sun, sun.target);

const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...opts }));
  return matCache.get(key);
}
function shadowed(m) { m.castShadow = true; m.receiveShadow = true; return m; }
// Caja redondeada: w a lo largo de x, d a lo largo de y, h a lo largo de z (z = hacia el cristal)
function rbox(w, d, h, color, x, y, z, r = 0.01) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, d, h, 3, Math.min(r, w / 2, d / 2, h / 2)), typeof color === 'string' ? mat(color) : color);
  m.position.set(x, y, z);
  return shadowed(m);
}
function cyl(rt, rb, h, color, x, y, z, seg = 18) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), typeof color === 'string' ? mat(color) : color);
  m.rotation.x = HALF_PI;
  m.position.set(x, y, z);
  return shadowed(m);
}

/* ---------- Texturas pintadas ---------- */
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const floorTex = canvasTex(256, 512, (g, w, h) => {
  g.fillStyle = '#e8dccb'; g.fillRect(0, 0, w, h);
  const pw = 32;
  for (let i = 0; i < w / pw; i++) {
    const off = (i * 197) % h;
    for (let k = -1; k < 2; k++) {
      const shade = 225 + ((i * 37 + k * 11) % 9);
      g.fillStyle = `rgb(${shade + 6},${shade - 6},${shade - 22})`;
      g.fillRect(i * pw + 1, off + k * h * 0.5, pw - 2, h * 0.5 - 2);
    }
    g.fillStyle = 'rgba(120,95,70,.18)';
    g.fillRect(i * pw, 0, 1.5, h);
    g.fillRect(i * pw, off, pw, 1.5);
    g.fillRect(i * pw, (off + h / 2) % h, pw, 1.5);
  }
});
floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;

const rugTex = canvasTex(256, 192, (g, w, h) => {
  g.fillStyle = '#c9d5c4'; roundRect(g, 4, 4, w - 8, h - 8, 26); g.fill();
  g.strokeStyle = '#eef2ea'; g.lineWidth = 5; roundRect(g, 18, 18, w - 36, h - 36, 16); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 2; roundRect(g, 30, 30, w - 60, h - 60, 10); g.stroke();
});
const skyTex = canvasTex(64, 128, (g, w, h) => {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, '#9fc7e8'); gr.addColorStop(1, '#e9f2f7');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,.8)';
  g.beginPath(); g.ellipse(22, 40, 14, 6, 0, 0, 7); g.ellipse(34, 37, 10, 6, 0, 0, 7); g.fill();
});
const artTex = canvasTex(128, 160, (g, w, h) => {
  g.fillStyle = '#f7f3ec'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#d9826b'; g.beginPath(); g.arc(50, 64, 30, 0, 7); g.fill();
  g.fillStyle = '#7b9cc0'; g.fillRect(60, 80, 44, 54);
  g.fillStyle = '#e8c26a'; g.beginPath(); g.moveTo(20, 140); g.lineTo(60, 96); g.lineTo(96, 140); g.fill();
});
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/* =====================================================================
 *  Habitación (suelo en z = 0, cristal/pantalla en z = D)
 * ===================================================================== */
const room = new THREE.Group();
scene.add(room);
let doorX = 0.25;

const wallMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, emissive: '#8f8579', emissiveIntensity: 0.55 });
function wallMesh(geo, matrix) {
  // Gradiente por vértice: más oscuro junto al suelo, más claro junto al cristal
  geo.applyMatrix4(matrix);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const a = new THREE.Color('#d9cebf'), b = new THREE.Color('#f7f3ee'), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.copy(a).lerp(b, clamp(pos.getZ(i) / D, 0, 1) ** 0.8);
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.Mesh(geo, wallMat);
  m.receiveShadow = true;
  return m;
}

function buildRoom() {
  room.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  room.clear();
  const M = new THREE.Matrix4();

  floorTex.repeat.set(W / 0.56, H / 1.1);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85 }));
  floor.receiveShadow = true;
  room.add(floor);

  const seg = 1;
  room.add(wallMesh(new THREE.PlaneGeometry(D, H, seg, seg), M.makeRotationY(HALF_PI).setPosition(-W / 2, 0, D / 2)));
  room.add(wallMesh(new THREE.PlaneGeometry(D, H, seg, seg), M.makeRotationY(-HALF_PI).setPosition(W / 2, 0, D / 2)));
  room.add(wallMesh(new THREE.PlaneGeometry(W, D, seg, seg), M.makeRotationX(-HALF_PI).setPosition(0, -H / 2, D / 2)));
  room.add(wallMesh(new THREE.PlaneGeometry(W, D, seg, seg), M.makeRotationX(HALF_PI).setPosition(0, H / 2, D / 2)));

  // Zócalos
  const bb = '#f9f6f1', t = 0.008, bh = 0.022;
  room.add(rbox(t, H, bh, bb, -W / 2 + t / 2, 0, bh / 2, 0.002));
  room.add(rbox(t, H, bh, bb, W / 2 - t / 2, 0, bh / 2, 0.002));
  room.add(rbox(W, t, bh, bb, 0, -H / 2 + t / 2, bh / 2, 0.002));
  room.add(rbox(W, t, bh, bb, 0, H / 2 - t / 2, bh / 2, 0.002));

  // Puerta (cerrada, claro) en la pared de arriba
  doorX = clamp(W * 0.22, -W / 2 + 0.12, W / 2 - 0.12);
  room.add(rbox(0.16, 0.012, 0.31, '#efe8de', doorX, H / 2 - 0.004, 0.155, 0.004));
  room.add(rbox(0.14, 0.012, 0.29, '#d8c7b2', doorX, H / 2 - 0.007, 0.145, 0.004));
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.009, 12, 10), mat('#8c7a66', { metalness: 0.4, roughness: 0.4 }));
  knob.position.set(doorX - 0.05, H / 2 - 0.018, 0.14);
  room.add(shadowed(knob));

  // Ventana en la pared derecha
  const wy = H * 0.16;
  room.add(rbox(0.012, 0.3, 0.24, '#fbfaf7', W / 2 - 0.004, wy, D * 0.5, 0.004));
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.2), new THREE.MeshBasicMaterial({ map: skyTex }));
  sky.rotation.set(0, -HALF_PI, -HALF_PI);
  sky.position.set(W / 2 - 0.011, wy, D * 0.5);
  room.add(sky);
  room.add(rbox(0.014, 0.008, 0.2, '#fbfaf7', W / 2 - 0.012, wy, D * 0.5, 0.002));
  room.add(rbox(0.03, 0.32, 0.012, '#fbfaf7', W / 2 - 0.015, wy, D * 0.5 - 0.125, 0.003));

  // Cuadro en la pared izquierda
  const ay = -H * 0.12;
  room.add(rbox(0.01, 0.17, 0.21, '#3a332d', -W / 2 + 0.005, ay, D * 0.55, 0.003));
  const art = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.19), new THREE.MeshStandardMaterial({ map: artTex, roughness: 0.9 }));
  art.rotation.set(0, HALF_PI, HALF_PI);
  art.position.set(-W / 2 + 0.0105, ay, D * 0.55);
  room.add(art);

  // Alfombra
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.39), new THREE.MeshStandardMaterial({ map: rugTex, transparent: true, roughness: 1 }));
  rug.position.set(0, H * 0.02, 0.0015);
  rug.receiveShadow = true;
  room.add(rug);

  // Sombras: la cámara de sombras cubre la habitación
  const sc = sun.shadow.camera;
  const ext = Math.max(W, H) / 2 + 0.2;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
  sc.updateProjectionMatrix();
}

/* =====================================================================
 *  Muebles
 * ===================================================================== */
const COL = {
  sofa: '#d98a72', sofa2: '#e59c84', wood: '#c9a27e', woodDark: '#8d6e55', chair: '#7f9fc2',
  white: '#fbf8f3', pot: '#c97b5a', leaf: '#7fae7b', leaf2: '#6a9a69', lamp: '#f3e5c8', metal: '#5c544c',
};

const DEFS = {
  sofa: {
    hx: 0.2, hy: 0.075, mass: 6, mus: 0.3,
    build() {
      const g = new THREE.Group();
      g.add(rbox(0.4, 0.14, 0.05, COL.sofa, 0, 0.005, 0.037, 0.014));
      g.add(rbox(0.17, 0.115, 0.03, COL.sofa2, -0.088, 0.012, 0.074, 0.013));
      g.add(rbox(0.17, 0.115, 0.03, COL.sofa2, 0.088, 0.012, 0.074, 0.013));
      g.add(rbox(0.4, 0.038, 0.13, COL.sofa, 0, -0.056, 0.077, 0.016));
      g.add(rbox(0.032, 0.15, 0.095, COL.sofa, -0.184, 0, 0.0555, 0.014));
      g.add(rbox(0.032, 0.15, 0.095, COL.sofa, 0.184, 0, 0.0555, 0.014));
      for (const [x, y] of [[-0.18, -0.06], [0.18, -0.06], [-0.18, 0.06], [0.18, 0.06]]) g.add(cyl(0.006, 0.005, 0.014, COL.woodDark, x, y, 0.007, 8));
      return g;
    },
    support(lx, ly) { if (Math.abs(lx) > 0.168) return 0.103; if (ly < -0.037) return 0.142; return 0.089; },
    seats: [{ lx: -0.09, ly: 0.012, h: 0.089 }, { lx: 0.09, ly: 0.012, h: 0.089 }],
  },
  chair: {
    hx: 0.043, hy: 0.043, mass: 1, mus: 0.2,
    build() {
      const g = new THREE.Group();
      g.add(rbox(0.086, 0.086, 0.012, COL.chair, 0, 0, 0.073, 0.005));
      for (const [x, y] of [[-0.035, -0.035], [0.035, -0.035], [-0.035, 0.035], [0.035, 0.035]]) g.add(cyl(0.0045, 0.0045, 0.068, COL.woodDark, x, y, 0.034, 8));
      g.add(rbox(0.086, 0.012, 0.085, COL.chair, 0, -0.037, 0.122, 0.005));
      return g;
    },
    support(lx, ly) { return ly < -0.03 ? 0.165 : 0.079; },
    seats: [{ lx: 0, ly: 0.008, h: 0.079 }],
  },
  table: {
    hx: 0.13, hy: 0.085, mass: 3, mus: 0.27,
    build() {
      const g = new THREE.Group();
      g.add(rbox(0.26, 0.17, 0.014, COL.wood, 0, 0, 0.126, 0.006));
      for (const [x, y] of [[-0.113, -0.068], [0.113, -0.068], [-0.113, 0.068], [0.113, 0.068]]) g.add(cyl(0.006, 0.005, 0.12, COL.woodDark, x, y, 0.06, 10));
      g.add(cyl(0.012, 0.01, 0.022, COL.white, 0.07, 0.035, 0.144, 16));
      g.add(cyl(0.022, 0.022, 0.004, COL.white, -0.05, -0.02, 0.135, 20));
      const fruit = new THREE.Mesh(new THREE.SphereGeometry(0.011, 14, 10), mat('#e8a13f'));
      fruit.position.set(-0.05, -0.02, 0.147);
      g.add(shadowed(fruit));
      return g;
    },
    support() { return 0.133; },
  },
  lamp: {
    hx: 0.03, hy: 0.03, mass: 2, mus: 0.35,
    build() {
      const g = new THREE.Group();
      g.add(cyl(0.028, 0.03, 0.008, COL.metal, 0, 0, 0.004, 20));
      g.add(cyl(0.0035, 0.0035, 0.25, COL.metal, 0, 0, 0.129, 8));
      const shadeMat = new THREE.MeshStandardMaterial({ color: COL.lamp, roughness: 0.9, emissive: '#ffb45c', emissiveIntensity: 0, side: THREE.DoubleSide });
      const shade = cyl(0.027, 0.045, 0.05, shadeMat, 0, 0, 0.25, 24);
      shade.castShadow = false;
      g.add(shade);
      g.userData.shadeMat = shadeMat;
      const light = new THREE.PointLight('#ffb35a', 0, 1.4, 1.2);
      light.position.set(0, 0, 0.22);
      g.add(light);
      g.userData.light = light;
      return g;
    },
    support() { return 0.3; },
  },
  plant: {
    hx: 0.034, hy: 0.034, mass: 1.5, mus: 0.3,
    build() {
      const g = new THREE.Group();
      g.add(cyl(0.032, 0.025, 0.055, COL.pot, 0, 0, 0.0275, 18));
      const leaves = [[0, 0, 0.09, 0.036, COL.leaf], [0.016, -0.012, 0.118, 0.028, COL.leaf2], [-0.014, 0.012, 0.128, 0.024, COL.leaf]];
      for (const [x, y, z, r, c] of leaves) {
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), mat(c, { flatShading: true }));
        m.position.set(x, y, z);
        m.rotation.set(x * 40, y * 30, z * 20);
        g.add(shadowed(m));
      }
      return g;
    },
    support() { return 0.15; },
  },
  shelf: {
    hx: 0.15, hy: 0.036, mass: 9, mus: 0.45,
    build() {
      const g = new THREE.Group();
      g.add(rbox(0.3, 0.072, 0.11, COL.white, 0, 0, 0.055, 0.006));
      const books = ['#d9826b', '#7f9fc2', '#e8c26a', '#7fae7b', '#3a332d', '#c9a27e', '#b98fb0'];
      let x = -0.13;
      for (let i = 0; i < 7; i++) {
        const w = 0.012 + (i % 3) * 0.004, hh = 0.04 + ((i * 7) % 4) * 0.008;
        g.add(rbox(w, 0.05, hh, books[i], x + w / 2, 0.002, 0.11 + hh / 2, 0.002));
        x += w + 0.002;
      }
      g.add(rbox(0.06, 0.045, 0.012, '#7f9fc2', 0.08, 0, 0.116, 0.003));
      g.add(rbox(0.055, 0.04, 0.012, '#e8c26a', 0.082, 0.002, 0.128, 0.003));
      return g;
    },
    support(lx) { return lx < -0.02 ? 0.16 : 0.13; },
  },
};

const furn = [];
function addFurn(type, x, y, rot = 0) {
  const def = DEFS[type];
  const g = def.build();
  const f = {
    type, g, x, y, vx: 0, vy: 0, rot, visRot: rot, lhx: def.hx, lhy: def.hy, hx: def.hx, hy: def.hy,
    mass: def.mass, mus: def.mus, support: def.support, seats: def.seats || [], drag: null, dx: 0, dy: 0,
    wob: 0, thudT: 0, on: false,
  };
  g.traverse((o) => { o.userData.furn = f; });
  g.position.set(x, y, 0);
  g.rotation.z = rot;
  updateExtents(f);
  scene.add(g);
  furn.push(f);
  return f;
}
function updateExtents(f) {
  const odd = Math.abs(Math.round(f.rot / HALF_PI)) % 2 === 1;
  f.hx = odd ? f.lhy : f.lhx;
  f.hy = odd ? f.lhx : f.lhy;
}
function toLocal(f, wx, wy) {
  const c = Math.cos(f.rot), s = Math.sin(f.rot), dx = wx - f.x, dy = wy - f.y;
  return [dx * c + dy * s, -dx * s + dy * c];
}
function toWorld(f, lx, ly) {
  const c = Math.cos(f.rot), s = Math.sin(f.rot);
  return [f.x + lx * c - ly * s, f.y + lx * s + ly * c];
}
function supportAt(f, wx, wy) {
  const [lx, ly] = toLocal(f, wx, wy);
  if (Math.abs(lx) > f.lhx || Math.abs(ly) > f.lhy) return -1;
  return f.support(lx, ly);
}
function groundAt(x, y) {
  let z = 0, f = null;
  for (const o of furn) { const s = supportAt(o, x, y); if (s > z) { z = s; f = o; } }
  return { z, f };
}
function isFree(x, y, r) {
  if (Math.abs(x) > W / 2 - r || Math.abs(y) > H / 2 - r) return false;
  for (const f of furn) if (Math.abs(x - f.x) < f.hx + r && Math.abs(y - f.y) < f.hy + r) return false;
  return true;
}

let lamp = null;
function layout() {
  addFurn('table', 0, H * 0.02);
  addFurn('chair', -0.215, H * 0.02, -HALF_PI);
  addFurn('chair', 0.215, H * 0.02, HALF_PI);
  addFurn('sofa', 0, -H / 2 + 0.09);
  lamp = addFurn('lamp', W / 2 - 0.055, -H / 2 + 0.055);
  addFurn('plant', -W / 2 + 0.055, -H / 2 + 0.06);
  addFurn('plant', -W / 2 + 0.05, H / 2 - 0.05);
  addFurn('shelf', -W / 2 + 0.037, H * 0.24, -HALF_PI);
}

function setLamp(on) {
  lamp.on = on;
  audio.click();
}

/* =====================================================================
 *  Humano minimalista
 * ===================================================================== */
const skin = new THREE.MeshStandardMaterial({ color: '#fdfbf7', roughness: 0.55 });
const eyeMat = new THREE.MeshBasicMaterial({ color: '#2d2621' });
function capsule(r, len) { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 5, 12), skin); m.castShadow = true; return m; }

const rig = {};
{
  rig.root = new THREE.Group();
  rig.lean = new THREE.Group();
  rig.heading = new THREE.Group();
  rig.body = new THREE.Group();
  rig.root.add(rig.lean); rig.lean.add(rig.heading); rig.heading.add(rig.body);
  rig.body.rotation.x = HALF_PI; // eje Y local -> Z del mundo (hacia el cristal)

  rig.pelvis = new THREE.Group(); rig.body.add(rig.pelvis);
  rig.chest = new THREE.Group(); rig.pelvis.add(rig.chest);
  const torso = capsule(0.031, 0.052); torso.position.y = 0.057; rig.chest.add(torso);

  rig.head = new THREE.Group(); rig.head.position.y = 0.122; rig.chest.add(rig.head);
  const headM = new THREE.Mesh(new THREE.SphereGeometry(0.043, 24, 18), skin);
  headM.position.y = 0.04; headM.castShadow = true; rig.head.add(headM);
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.0062, 10, 8), eyeMat);
    e.position.set(s * 0.016, 0.047, 0.038);
    rig.head.add(e);
  }
  rig.stars = new THREE.Group(); rig.stars.position.y = 0.105; rig.head.add(rig.stars);
  for (let i = 0; i < 3; i++) {
    const st = new THREE.Mesh(new THREE.OctahedronGeometry(0.011), new THREE.MeshBasicMaterial({ color: '#f0c03e' }));
    const a = (i / 3) * Math.PI * 2;
    st.position.set(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05);
    rig.stars.add(st);
  }
  rig.stars.visible = false;

  const limb = (x, y, r, len, parent) => {
    const j = new THREE.Group(); j.position.set(x, y, 0); parent.add(j);
    const m = capsule(r, len); m.position.y = -(len / 2 + r * 0.6); j.add(m);
    return j;
  };
  rig.shL = limb(0.043, 0.098, 0.0115, 0.056, rig.chest);
  rig.shR = limb(-0.043, 0.098, 0.0115, 0.056, rig.chest);
  rig.hipL = limb(0.017, 0.0, 0.0135, 0.034, rig.pelvis);
  rig.hipR = limb(-0.017, 0.0, 0.0135, 0.034, rig.pelvis);
  rig.kneeL = limb(0, -0.052, 0.0128, 0.034, rig.hipL);
  rig.kneeR = limb(0, -0.052, 0.0128, 0.034, rig.hipR);
  scene.add(rig.root);
}
const humanMeshes = [];
rig.root.traverse((o) => { if (o.isMesh) humanMeshes.push(o); });

const POSE_KEYS = ['bodyRot', 'pelvisY', 'torso', 'hipL', 'hipR', 'kneeL', 'kneeR', 'spread', 'armL', 'armR', 'raiseL', 'raiseR', 'yaw', 'pitch', 'lift'];
const standPose = () => ({ bodyRot: HALF_PI, pelvisY: 0.104, torso: 0, hipL: 0, hipR: 0, kneeL: 0, kneeR: 0, spread: 0, armL: 0, armR: 0, raiseL: 0.12, raiseR: 0.12, yaw: 0, pitch: 0, lift: 0 });
const pose = standPose();

const UPRIGHT = new Set(['idle', 'walk', 'wave', 'help', 'door', 'lamp', 'reach', 'dizzy', 'look']);

const human = {
  x: 0, y: 0.3, z: 0, vx: 0, vy: 0, vz: 0, facing: -HALF_PI, targetFacing: -HALF_PI, spin: 0,
  state: 'idle', st: 0, dur: 1.5, target: null, seat: null, on: null, walkPhase: 0, pokes: 0,
  look: null, lookT: 0, still: 0, fallT: 2, hard: false, thrown: false, flag: 0, stuckT: 0, avoid: 0, avoidSign: 1,
  lastPos: { x: 0, y: 0 }, vis: { x: 0, y: 0.3, z: 0 }, visFacing: -HALF_PI, nextZ: 0, lampDone: false,
};

function setState(s, dur = 0) {
  const h = human;
  h.state = s; h.st = 0; h.dur = dur; h.flag = 0;
  if (s !== 'walk') h.target = null;
  if (s !== 'sit' && s !== 'sleep') h.seat = null;
}

function fall(msg, hard = true) {
  const h = human;
  setState('fallen');
  h.fallT = rand(1.4, 2.4); h.still = 0; h.hard = hard;
  if (msg) { say(msg, 1.3); audio.voice('alarm'); }
}

function walkTo(x, y, done, opts = {}) {
  const h = human;
  x = clamp(x, -W / 2 + H_R + 0.01, W / 2 - H_R - 0.01);
  y = clamp(y, -H / 2 + H_R + 0.01, H / 2 - H_R - 0.01);
  setState('walk');
  h.target = { x, y, done, fast: !!opts.fast, timeout: opts.timeout || 9 };
  h.lastPos.x = h.x; h.lastPos.y = h.y; h.stuckT = 0; h.avoid = 0;
}

function sitOn(f, seat, sleep = false) {
  const h = human;
  setState(sleep ? 'sleep' : 'sit', sleep ? rand(9, 16) : rand(5, 11));
  h.seat = sleep ? { f, lx: 0.15, ly: 0.012, h: 0.089, face: 0 } : { f, lx: seat.lx, ly: seat.ly, h: seat.h, face: HALF_PI };
  h.vz = 0;
}

function standUpFromSeat() {
  const h = human;
  const s = h.seat;
  if (!s) return;
  const [fx, fy] = toWorld(s.f, s.face === 0 ? 0 : s.lx, s.f.lhy + 0.045);
  h.x = clamp(fx, -W / 2 + H_R, W / 2 - H_R);
  h.y = clamp(fy, -H / 2 + H_R, H / 2 - H_R);
  h.facing = h.targetFacing = s.f.rot + HALF_PI;
  setState('air');
  h.vz = 0.4;
}

function seatApproach(f, seat) {
  const [x, y] = toWorld(f, seat.lx, f.lhy + 0.048);
  return isFree(x, y, H_R + 0.004) ? { x, y } : null;
}

function think() {
  const h = human;
  const opts = [];
  opts.push(['wander', 3]);
  opts.push(['look', 1]);
  const chairs = furn.filter((f) => f.type === 'chair');
  const sofa = furn.find((f) => f.type === 'sofa');
  if (chairs.length) opts.push(['chair', 1.6]);
  if (sofa) opts.push(['sofa', 1.6], ['sleep', 0.7]);
  opts.push(['lamp', 0.7], ['door', 0.8]);
  if (face.present) opts.push(['wave', 1.4], ['help', 1.0]); else opts.push(['help', 0.35]);
  let total = opts.reduce((a, o) => a + o[1], 0), r = Math.random() * total, choice = 'wander';
  for (const [k, w] of opts) { if ((r -= w) <= 0) { choice = k; break; } }

  switch (choice) {
    case 'wander': {
      for (let i = 0; i < 25; i++) {
        const x = rand(-W / 2 + 0.06, W / 2 - 0.06), y = rand(-H / 2 + 0.06, H / 2 - 0.06);
        if (isFree(x, y, 0.05)) { walkTo(x, y, () => setState('idle', rand(1, 3))); return; }
      }
      break;
    }
    case 'chair': case 'sofa': case 'sleep': {
      const f = choice === 'chair' ? pick(chairs) : sofa;
      const seat = choice === 'sleep' ? { lx: 0, ly: 0.012 } : pick(f.seats);
      const p = seatApproach(f, seat);
      if (!p) break;
      walkTo(p.x, p.y, () => {
        const q = seatApproach(f, seat);
        if (q && Math.hypot(q.x - h.x, q.y - h.y) < 0.06) {
          sitOn(f, seat, choice === 'sleep');
          if (choice === 'sleep') say('Uaaah…', 1.4);
        } else setState('idle', 1);
      });
      return;
    }
    case 'lamp': {
      if (!lamp) break;
      const d = Math.hypot(lamp.x, lamp.y) || 1;
      const x = lamp.x - (lamp.x / d) * 0.075, y = lamp.y - (lamp.y / d) * 0.075;
      if (!isFree(x, y, H_R)) break;
      walkTo(x, y, () => { setState('lamp', 1.3); h.targetFacing = Math.atan2(lamp.y - h.y, lamp.x - h.x); h.lampDone = false; });
      return;
    }
    case 'door': {
      const x = doorX, y = H / 2 - 0.055;
      if (!isFree(x, y, H_R)) break;
      walkTo(x, y, () => { setState('door', 3.2); h.targetFacing = HALF_PI; });
      return;
    }
    case 'wave':
      setState('wave', 2.4); h.targetFacing = -HALF_PI;
      say(pick(['¡Hola!', '¡Eh, tú!', '¡Te veo!', '¡Hola, gigante!']), 1.6); audio.voice('happy');
      return;
    case 'help': {
      const go = () => { setState('help', 3.4); h.targetFacing = -HALF_PI; say(pick(['¡Sácame de aquí!', '¡Socorro!', '¡Déjame salir!']), 2.2); audio.voice('alarm'); };
      if (isFree(0, 0, 0.05)) walkTo(rand(-0.05, 0.05), rand(-0.05, 0.05), go); else go();
      return;
    }
    case 'look':
      setState('look', rand(2, 4));
      return;
  }
  setState('idle', rand(0.8, 2));
}

function poke() {
  const h = human;
  h.pokes += 1;
  audio.giggle();
  if (h.state === 'sit' || h.state === 'sleep') {
    const wasSleep = h.state === 'sleep';
    standUpFromSeat();
    say(wasSleep ? '¡¿Qué?! ¡Estaba durmiendo!' : '!', 1.6);
    return;
  }
  if (h.state === 'fallen') { h.still += 0.6; say('Ay…', 1); return; }
  const angry = h.pokes > 4.5;
  say(angry ? pick(['¡Para ya!', 'Grrr…', '¡Basta!', '¡Oye!']) : pick(['¡Ji ji!', '¡Cosquillas!', '!', '¡Je!', '¡Ay!']), 1.2);
  if (h.z <= groundAt(h.x, h.y).z + 0.003) {
    setState('air');
    h.vz = angry ? 0.5 : 0.85;
  }
  if (angry) {
    h.pokes = 2.5;
    audio.voice('angry');
    // se aleja corriendo del dedo
    for (let i = 0; i < 20; i++) {
      const a = rand(0, Math.PI * 2), x = h.x + Math.cos(a) * 0.35, y = h.y + Math.sin(a) * 0.35;
      if (isFree(x, y, 0.05)) { h.nextWalk = { x, y }; break; }
    }
  }
}

/* =====================================================================
 *  Sensores: inclinación y sacudidas
 * ===================================================================== */
const sensor = { raw: new THREE.Vector3(0, 0, -1), g0: null, has: false, key: new THREE.Vector2(), keyT: new THREE.Vector2(), shakeT: 0 };
const tilt = new THREE.Vector2();
const tiltRaw = new THREE.Vector2();
const DOWN = new THREE.Vector3(0, 0, -1);
const tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3();

function screenAngle() {
  const a = screen.orientation && typeof screen.orientation.angle === 'number' ? screen.orientation.angle : (window.orientation || 0);
  return a * DEG;
}
function toScreen(x, y) {
  const a = screenAngle(), c = Math.cos(a), s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  const b = e.beta * DEG, g = e.gamma * DEG;
  // Gravedad en coordenadas del dispositivo (x derecha, y arriba, z fuera de la pantalla)
  const gx = Math.sin(g) * Math.cos(b), gy = -Math.sin(b), gz = -Math.cos(g) * Math.cos(b);
  const [sx, sy] = toScreen(gx, gy);
  sensor.raw.set(sx, sy, gz).normalize();
  if (!sensor.has) { sensor.has = true; sensor.g0 = sensor.raw.clone(); }
}

function onMotion(e) {
  const a = e.acceleration;
  if (!a || a.x == null) return;
  const now = performance.now();
  const [ax, ay] = toScreen(a.x, a.y);
  const m = Math.hypot(ax, ay, a.z || 0);
  if (m < 9 || now - sensor.shakeT < 140) return;
  sensor.shakeT = now;
  // Por inercia, el contenido se queda atrás respecto al movimiento del móvil
  const k = 0.018;
  for (const f of furn) { if (!f.drag) { f.vx -= ax * k / Math.sqrt(f.mass); f.vy -= ay * k / Math.sqrt(f.mass); f.wob = 1; } }
  const h = human;
  if (h.state === 'held') return;
  if (h.state === 'sit' || h.state === 'sleep') standUpFromSeat();
  h.vx -= ax * k * 1.6; h.vy -= ay * k * 1.6;
  if (Math.abs(a.z || 0) > 6 && h.state !== 'air') { if (UPRIGHT.has(h.state)) setState('air'); h.vz = Math.min(1.2, Math.abs(a.z) * 0.06); }
  if (m > 15 && h.state !== 'fallen' && h.state !== 'air') fall(pick(['¡Terremoto!', '¡Aaah!', '¡Uaaa!']));
  else if (UPRIGHT.has(h.state) && h.state !== 'air') { setState('stumble'); }
}

function updateTilt(dt) {
  let tx = sensor.key.x, ty = sensor.key.y;
  if (sensor.has && sensor.g0) {
    tmpQ.setFromUnitVectors(sensor.g0, DOWN);
    tmpV.copy(sensor.raw).applyQuaternion(tmpQ);
    tx = tmpV.x; ty = tmpV.y;
    // Pequeñas inclinaciones mantenidas se absorben poco a poco (cómo sostienes el móvil)
    if (Math.hypot(tx, ty) < 0.09) sensor.g0.lerp(sensor.raw, Math.min(1, dt * 0.15)).normalize();
  } else {
    sensor.key.x = damp(sensor.key.x, sensor.keyT.x, 6, dt);
    sensor.key.y = damp(sensor.key.y, sensor.keyT.y, 6, dt);
  }
  tiltRaw.set(tx, ty);
  const m = Math.hypot(tx, ty), dz = 0.05, f = m > dz ? (m - dz) / m : 0;
  tilt.x = damp(tilt.x, tx * f, 12, dt);
  tilt.y = damp(tilt.y, ty * f, 12, dt);
}

function recalibrate() {
  if (sensor.has) sensor.g0 = sensor.raw.clone();
  sensor.keyT.set(0, 0);
}

/* =====================================================================
 *  Seguimiento de ojos (cámara frontal + MediaPipe Face Landmarker)
 * ===================================================================== */
const video = $('cam');
const face = { present: false, x: 0, y: 0, z: 0, cm: 32, lastSeen: 0, goneAt: 0, enabled: false, loading: false, landmarker: null, stream: null, lastT: -1, lastDetect: 0, closeT: 0 };
const eye = { x: 0, y: 0, z: 5 };
let depthK = 1.6;
const mouse = { x: 0, y: 0, active: false };

async function startFace() {
  if (face.loading) return;
  face.loading = true;
  setEyeDot();
  try {
    if (!face.stream) {
      face.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      video.srcObject = face.stream;
      await video.play();
    }
    if (!face.landmarker) {
      const { FilesetResolver, FaceLandmarker } = await import(`${MP_BASE}/vision_bundle.mjs`);
      const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      const opts = (delegate) => ({ baseOptions: { modelAssetPath: FACE_MODEL, delegate }, runningMode: 'VIDEO', numFaces: 1 });
      try { face.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU')); }
      catch { face.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU')); }
    }
    face.enabled = true;
    tip('Mira la pantalla y mueve la cabeza: la habitación tiene profundidad.', 4500);
  } catch (err) {
    console.warn(err);
    face.enabled = false;
    tip('No se pudo usar la cámara. La perspectiva seguirá la inclinación del móvil.', 4500);
  }
  face.loading = false;
  setEyeDot();
}

function stopFace() {
  face.enabled = false;
  face.present = false;
  if (face.stream) { face.stream.getTracks().forEach((t) => t.stop()); face.stream = null; video.srcObject = null; }
  setEyeDot();
}

function setEyeDot() {
  const dot = $('eye-dot');
  dot.className = 'dot' + (face.loading ? ' load' : face.present ? ' track' : '');
  $('btn-eyes').classList.toggle('on', face.enabled);
}

const FOV_MAX = 66 * DEG; // campo de visión aproximado (lado largo) de una cámara frontal
function detectFace(now) {
  if (!face.enabled || !face.landmarker || video.readyState < 2) return;
  if (now - face.lastDetect < 30 || video.currentTime === face.lastT) return;
  face.lastDetect = now; face.lastT = video.currentTime;
  let res;
  try { res = face.landmarker.detectForVideo(video, now); } catch { return; }
  const lm = res && res.faceLandmarks && res.faceLandmarks[0];
  const wasPresent = face.present;
  if (!lm) {
    if (face.present && now - face.lastSeen > 500) { face.present = false; face.goneAt = now; setEyeDot(); }
    return;
  }
  const vw = video.videoWidth, vh = video.videoHeight;
  let L, R;
  if (lm.length >= 478) { L = lm[468]; R = lm[473]; }
  else { L = mid(lm[33], lm[133]); R = mid(lm[362], lm[263]); }
  const mx = (L.x + R.x) / 2, my = (L.y + R.y) / 2;
  const ipdPx = Math.hypot((L.x - R.x) * vw, (L.y - R.y) * vh);
  const fpx = (Math.max(vw, vh) / 2) / Math.tan(FOV_MAX / 2);
  const dcm = clamp((6.3 * fpx) / Math.max(ipdPx, 1), 10, 90);
  let xcm = -(mx - 0.5) * vw * dcm / fpx;
  let ycm = -(my - 0.5) * vh * dcm / fpx;
  // La cámara está encima de la pantalla: pasamos a coordenadas centradas en la pantalla
  const sw = innerWidth / PX_PER_CM, sh = innerHeight / PX_PER_CM;
  const a = screenAngle();
  let cx = 0, cy = sh / 2 + 0.5;
  if (Math.abs(Math.sin(a)) > 0.5) { cx = Math.sin(a) > 0 ? -(sw / 2 + 0.5) : sw / 2 + 0.5; cy = 0; }
  [xcm, ycm] = toScreen(xcm, ycm);
  xcm += cx; ycm += cy;
  const k = face.present ? 0.55 : 1;
  face.x = lerp(face.x, xcm, k); face.y = lerp(face.y, ycm, k); face.cm = lerp(face.cm, dcm, k);
  face.present = true; face.lastSeen = now;
  if (!wasPresent) {
    setEyeDot();
    if (now - face.goneAt > 4000) humanNoticesFace();
  }
  if (dcm < 17 && now - face.closeT > 7000) { face.closeT = now; humanTooClose(); }
}
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

function humanNoticesFace() {
  const h = human;
  if (h.state === 'idle' || h.state === 'look' || h.state === 'walk') {
    setState('wave', 2.2); h.targetFacing = -HALF_PI;
    say(pick(['¡Hola!', '¡Ah, estás ahí!', '¡Hola, tú!']), 1.6); audio.voice('happy');
  }
}
function humanTooClose() {
  const h = human;
  if (h.state === 'sleep' || h.state === 'held') return;
  say(pick(['¡Uy, qué cerca!', '¡Qué ojos tan grandes!', '¡Hola, ojo!']), 1.8);
  audio.voice('alarm');
}

function updateEye(dt) {
  const base = 32 / CM_PER_UNIT;
  let tx, ty, tz;
  if (face.enabled && face.present) {
    tx = (face.x / CM_PER_UNIT) * depthK;
    ty = (face.y / CM_PER_UNIT) * depthK;
    tz = (face.cm / CM_PER_UNIT) / Math.sqrt(depthK);
  } else {
    // Sin cara: la perspectiva sigue la inclinación (como mirar por una ventana que giras)
    tx = clamp(-tiltRaw.x * base * 0.3 * depthK, -0.7 * W, 0.7 * W);
    ty = clamp(-tiltRaw.y * base * 0.3 * depthK, -0.7 * H, 0.7 * H);
    if (!sensor.has && mouse.active) { tx = mouse.x * W * 0.35 * depthK; ty = mouse.y * H * 0.2 * depthK; }
    tz = base / Math.sqrt(depthK);
  }
  tz = clamp(tz, 1.4, 20);
  const l = face.present ? 16 : 7;
  eye.x = damp(eye.x, tx, l, dt);
  eye.y = damp(eye.y, ty, l, dt);
  eye.z = damp(eye.z, tz, l, dt);
}

function updateCamera() {
  // Proyección off-axis: el rectángulo de la pantalla (z = D) es la ventana
  const ez = eye.z;
  camera.position.set(eye.x, eye.y, D + ez);
  camera.rotation.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  const n = 0.05, s = n / ez;
  camera.projectionMatrix.makePerspective((-W / 2 - eye.x) * s, (W / 2 - eye.x) * s, (H / 2 - eye.y) * s, (-H / 2 - eye.y) * s, n, 60);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/* =====================================================================
 *  Física de muebles
 * ===================================================================== */
function stepFurniture(dt) {
  for (const f of furn) { f.px = f.x; f.py = f.y; }
  for (const f of furn) {
    if (f.drag) {
      const tx = clamp(f.drag.x, -W / 2 + f.hx, W / 2 - f.hx), ty = clamp(f.drag.y, -H / 2 + f.hy, H / 2 - f.hy);
      f.vx = clamp((tx - f.x) * 16, -4, 4);
      f.vy = clamp((ty - f.y) * 16, -4, 4);
    } else {
      const fx = tilt.x * G, fy = tilt.y * G, sp = Math.hypot(f.vx, f.vy);
      if (sp < 0.008) {
        if (Math.hypot(fx, fy) > f.mus * G) { f.vx += fx * dt; f.vy += fy * dt; } else { f.vx = 0; f.vy = 0; }
      } else {
        const muk = f.mus * 0.72 * G;
        const nvx = f.vx + (fx - (muk * f.vx) / sp) * dt, nvy = f.vy + (fy - (muk * f.vy) / sp) * dt;
        if (nvx * f.vx + nvy * f.vy < 0) { f.vx = 0; f.vy = 0; } else { f.vx = nvx; f.vy = nvy; }
      }
    }
    f.x += f.vx * dt; f.y += f.vy * dt;
    f.pinX = 0; f.pinY = 0;
  }
  for (let it = 0; it < 3; it++) {
    for (const f of furn) wallsFurn(f, it === 0);
    for (let i = 0; i < furn.length; i++) for (let j = i + 1; j < furn.length; j++) collideFurn(furn[i], furn[j]);
  }
  for (const f of furn) wallsFurn(f, false);
  for (const f of furn) {
    f.dx = f.x - f.px; f.dy = f.y - f.py;
    f.thudT -= dt;
    f.visRot = damp(f.visRot, f.rot, 12, dt);
    f.wob = Math.max(0, f.wob - dt * 3);
    const sp = Math.hypot(f.vx, f.vy);
    const jig = (sp > 0.05 && !f.drag ? Math.sin(performance.now() * 0.04 + f.mass) * 0.012 * Math.min(1, sp) : 0) + Math.sin(performance.now() * 0.03) * 0.03 * f.wob;
    f.g.position.set(f.x, f.y, 0);
    f.g.rotation.z = f.visRot + jig;
  }
  if (lamp) {
    const L = lamp.g.userData;
    L.light.intensity = damp(L.light.intensity, lamp.on ? 0.22 : 0, 10, dt);
    L.shadeMat.emissiveIntensity = damp(L.shadeMat.emissiveIntensity, lamp.on ? 1.1 : 0, 10, dt);
  }
}

function wallsFurn(f, sound) {
  const lx = W / 2 - f.hx, ly = H / 2 - f.hy;
  let impact = 0;
  if (f.x < -lx) { f.x = -lx; if (f.vx < 0) { impact = -f.vx; f.vx = -f.vx * 0.15; } f.pinX = -1; }
  if (f.x > lx) { f.x = lx; if (f.vx > 0) { impact = f.vx; f.vx = -f.vx * 0.15; } f.pinX = 1; }
  if (f.y < -ly) { f.y = -ly; if (f.vy < 0) { impact = Math.max(impact, -f.vy); f.vy = -f.vy * 0.15; } f.pinY = -1; }
  if (f.y > ly) { f.y = ly; if (f.vy > 0) { impact = Math.max(impact, f.vy); f.vy = -f.vy * 0.15; } f.pinY = 1; }
  if (sound && impact > 0.25 && f.thudT <= 0) { audio.thud(Math.min(0.6, impact * 0.35) * Math.sqrt(f.mass / 3)); f.thudT = 0.25; f.wob = 1; }
}

function collideFurn(a, b) {
  const ox = a.hx + b.hx - Math.abs(a.x - b.x), oy = a.hy + b.hy - Math.abs(a.y - b.y);
  if (ox <= 0 || oy <= 0) return;
  let nx = 0, ny = 0, pen;
  if (ox < oy) { nx = Math.sign(b.x - a.x) || 1; pen = ox; } else { ny = Math.sign(b.y - a.y) || 1; pen = oy; }
  // Masa inversa; bloqueado contra una pared en la dirección del empuje => masa infinita
  let ia = a.drag ? 0 : 1 / a.mass, ib = b.drag ? 0 : 1 / b.mass;
  if ((nx && a.pinX === -nx) || (ny && a.pinY === -ny)) ia = 0;
  if ((nx && b.pinX === nx) || (ny && b.pinY === ny)) ib = 0;
  if (ia + ib === 0) { if (a.drag) ia = 1; else if (b.drag) ib = 1; else { ia = ib = 1; } }
  const sum = ia + ib;
  a.x -= nx * pen * ia / sum; a.y -= ny * pen * ia / sum;
  b.x += nx * pen * ib / sum; b.y += ny * pen * ib / sum;
  const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rv < 0) {
    const j = (-rv * 1.1) / sum;
    a.vx -= j * ia * nx; a.vy -= j * ia * ny;
    b.vx += j * ib * nx; b.vy += j * ib * ny;
    if (-rv > 0.3 && a.thudT <= 0) { audio.thud(Math.min(0.5, -rv * 0.25)); a.thudT = 0.25; a.wob = b.wob = 0.8; }
  }
}

/* =====================================================================
 *  Física y comportamiento del humano
 * ===================================================================== */
const grab = { active: false, x: 0, y: 0, vx: 0, vy: 0, id: null };
const finger = { follow: false, x: 0, y: 0 };
const liftZ = () => Math.min(D - HUMAN_H - 0.04, 0.45);

function friction(h, decel, dt) {
  const sp = Math.hypot(h.vx, h.vy);
  if (sp < 1e-4) return;
  const ns = Math.max(0, sp - decel * dt);
  h.vx *= ns / sp; h.vy *= ns / sp;
}

function collideHumanFurn(px, py) {
  const h = human;
  let impact = 0;
  for (const f of furn) {
    const cx = clamp(h.x, f.x - f.hx, f.x + f.hx), cy = clamp(h.y, f.y - f.hy, f.y + f.hy);
    let dx = h.x - cx, dy = h.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 > H_R * H_R) continue;
    // altura del mueble en el punto de contacto (ligeramente hacia dentro)
    const [lx, ly] = toLocal(f, cx, cy);
    const top = f.support(clamp(lx, -f.lhx + 0.004, f.lhx - 0.004), clamp(ly, -f.lhy + 0.004, f.lhy - 0.004));
    if (h.z >= top - 0.03) continue;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, push = H_R - d;
      h.x += nx * push; h.y += ny * push;
      const vn = (h.vx - f.vx) * nx + (h.vy - f.vy) * ny;
      if (vn < 0) { impact = Math.max(impact, -vn); h.vx -= 1.35 * vn * nx; h.vy -= 1.35 * vn * ny; }
    } else if (h.z > 0.02) {
      h.x = px; h.y = py; // encima de un mueble, chocando con una parte más alta (respaldo…)
    } else {
      // El mueble se ha deslizado encima: sacarlo por el lado más corto
      const ex = f.hx + H_R - Math.abs(h.x - f.x), ey = f.hy + H_R - Math.abs(h.y - f.y);
      if (ex < ey) h.x += (Math.sign(h.x - f.x) || 1) * ex; else h.y += (Math.sign(h.y - f.y) || 1) * ey;
    }
  }
  return impact;
}

function wallsHuman() {
  const h = human, lx = W / 2 - H_R, ly = H / 2 - H_R;
  let impact = 0;
  if (h.x < -lx) { h.x = -lx; if (h.vx < 0) { impact = -h.vx; h.vx = -h.vx * 0.35; } }
  if (h.x > lx) { h.x = lx; if (h.vx > 0) { impact = h.vx; h.vx = -h.vx * 0.35; } }
  if (h.y < -ly) { h.y = -ly; if (h.vy < 0) { impact = Math.max(impact, -h.vy); h.vy = -h.vy * 0.35; } }
  if (h.y > ly) { h.y = ly; if (h.vy > 0) { impact = Math.max(impact, h.vy); h.vy = -h.vy * 0.35; } }
  return impact;
}

function stepHuman(dt) {
  const h = human;
  h.st += dt;
  h.pokes = Math.max(0, h.pokes - dt * 0.35);
  h.spin *= Math.exp(-dt * 2.5);
  const tm = tilt.length();

  if (h.state === 'held') {
    const nx = damp(h.x, grab.x, 22, dt), ny = damp(h.y, grab.y, 22, dt);
    grab.vx = damp(grab.vx, (nx - h.x) / dt, 14, dt);
    grab.vy = damp(grab.vy, (ny - h.y) / dt, 14, dt);
    h.x = clamp(nx, -W / 2 + H_R, W / 2 - H_R); h.y = clamp(ny, -H / 2 + H_R, H / 2 - H_R);
    h.z = damp(h.z, liftZ(), 9, dt);
    h.vx = h.vy = h.vz = 0;
    h.targetFacing = -HALF_PI;
    turn(dt, 5);
    return;
  }

  if (h.state === 'sit' || h.state === 'sleep') {
    const s = h.seat, f = s.f;
    const [wx, wy] = toWorld(f, s.lx, s.ly);
    h.x = wx; h.y = wy; h.z = s.h; h.vx = f.vx; h.vy = f.vy;
    h.facing = h.targetFacing = f.rot + s.face;
    if (Math.hypot(f.vx, f.vy) > 0.45 || tm > 0.5) {
      standUpFromSeat();
      h.vx = f.vx * 1.2 + tilt.x * 0.6; h.vy = f.vy * 1.2 + tilt.y * 0.6;
      h.thrown = true;
      say(pick(['¡Uoooh!', '¡Eh!', '¡Mi sofá!']), 1.2); audio.voice('alarm');
    } else if (h.st > h.dur) {
      standUpFromSeat();
    } else if (h.state === 'sleep' && h.st % 2.6 < dt) {
      say('z Z z', 1.6);
    }
    return;
  }

  if (h.on && furn.includes(h.on)) { h.x += h.on.dx; h.y += h.on.dy; }
  let sup = groundAt(h.x, h.y);
  const grounded = h.z <= sup.z + 0.004 && h.vz <= 0.01;

  if (grounded) {
    h.z = sup.z; h.vz = 0; h.on = sup.f;
    if (h.state === 'air') setState(h.thrown ? 'dizzy' : 'idle', h.thrown ? 1.6 : 0.6);
    if (UPRIGHT.has(h.state) && tm > 0.24) {
      setState('stumble');
      say(pick(['¡Uoh!', '¡Eh, eh!', '¡Cuidado!', '¡Que me caigo!']), 1.2); audio.voice('alarm');
    }
    if (h.state === 'stumble') {
      if (tm > 0.46 || Math.hypot(h.vx, h.vy) > 0.65) fall(pick(['¡Aaah!', '¡Uaaa!', '¡Socorro!']), false);
      else if (tm < 0.14 && h.st > 0.5) setState('idle', rand(0.5, 1));
    }
    const slide = h.state === 'stumble' || h.state === 'fallen' || h.state === 'getup';
    if (slide) {
      h.vx += tilt.x * G * dt; h.vy += tilt.y * G * dt;
      friction(h, (h.state === 'stumble' ? 0.08 : 0.13) * G, dt);
      if (h.state === 'stumble') {
        h.targetFacing = Math.atan2(-tilt.y, -tilt.x);
        h.walkPhase += dt * 16;
        h.vx -= tilt.x * 0.25 * dt; h.vy -= tilt.y * 0.25 * dt;
      }
    } else {
      let dx = 0, dy = 0;
      if (h.state === 'walk' && h.target) {
        const t = h.target, ex = t.x - h.x, ey = t.y - h.y, d = Math.hypot(ex, ey);
        if (d < 0.012) {
          const done = t.done;
          setState('idle', rand(0.8, 2));
          if (done) done();
        } else {
          let ang = Math.atan2(ey, ex);
          if (h.avoid > 0) { ang += h.avoidSign * 1.15; h.avoid -= dt; }
          const sp = (t.fast ? 0.34 : 0.2) * Math.min(1, d / 0.05 + 0.35);
          dx = Math.cos(ang) * sp; dy = Math.sin(ang) * sp;
          h.targetFacing = ang;
          h.walkPhase += dt * sp * 60;
          h.stuckT += dt;
          if (h.stuckT > 0.45) {
            const moved = Math.hypot(h.x - h.lastPos.x, h.y - h.lastPos.y);
            if (moved < sp * h.stuckT * 0.3) { h.avoid = 0.55; h.avoidSign = Math.random() < 0.5 ? -1 : 1; }
            h.lastPos.x = h.x; h.lastPos.y = h.y; h.stuckT = 0;
          }
          if (h.st > t.timeout) setState('idle', 1);
        }
      }
      h.vx = damp(h.vx, dx + tilt.x * 0.25, 12, dt);
      h.vy = damp(h.vy, dy + tilt.y * 0.25, 12, dt);
    }
  } else {
    h.vz -= GZ * dt; h.on = null;
    if (h.state !== 'air' && h.state !== 'fallen' && h.state !== 'help' && h.z - sup.z > 0.04) setState('air');
  }

  const px = h.x, py = h.y;
  h.x += h.vx * dt; h.y += h.vy * dt; h.z += h.vz * dt;
  let impact = collideHumanFurn(px, py);
  impact = Math.max(impact, wallsHuman());

  // ¡Choca con el cristal (tu pantalla)!
  if (h.z + HUMAN_H > D && h.vz > 0) {
    h.z = D - HUMAN_H; h.vz = -h.vz * 0.25;
    audio.bonk(); shakeScreen();
    say(pick(['¡Ay! ¡El cristal!', '¡Bonk!', '¡Mi cabeza!']), 1.4);
  }

  sup = groundAt(h.x, h.y);
  if (h.z < sup.z) {
    const fallSpeed = -h.vz;
    h.z = sup.z; h.vz = 0; h.on = sup.f;
    if (h.state === 'air' || h.state === 'help') {
      if (fallSpeed > 1.6 || (h.thrown && fallSpeed > 1.15)) { fall('¡Ay!'); audio.thud(0.35); }
      else if (h.state === 'air') { setState(h.thrown ? 'dizzy' : 'idle', h.thrown ? 1.6 : 0.7); audio.thud(0.1); }
      h.thrown = false;
    } else if (h.state === 'fallen' && fallSpeed > 0.5) audio.thud(0.15);
  }

  if (impact > 0.75 && (h.state === 'air' || h.state === 'stumble' || h.state === 'fallen')) {
    audio.thud(Math.min(0.5, impact * 0.3));
    if (h.state !== 'fallen') fall(pick(['¡Ay!', '¡Uf!', '¡Auch!']));
    else if (impact > 1) say(pick(['¡Ay!', '¡Auch!']), 0.9);
  }

  behave(dt, tm);
  turn(dt, h.state === 'walk' ? 9 : 6);
}

function turn(dt, rate) {
  const h = human;
  h.facing += clamp(wrap(h.targetFacing - h.facing), -rate * dt, rate * dt) + h.spin * dt;
  if (Math.abs(h.spin) > 0.5) h.targetFacing = h.facing;
}

function behave(dt, tm) {
  const h = human;
  switch (h.state) {
    case 'idle': case 'look':
      if (h.nextWalk) { const p = h.nextWalk; h.nextWalk = null; walkTo(p.x, p.y, () => setState('idle', 1.5), { fast: true }); break; }
      if (finger.follow) { followFinger(); break; }
      if (h.st > h.dur) think();
      break;
    case 'wave':
      if (h.st > h.dur) setState('idle', rand(1, 2));
      break;
    case 'help':
      if (h.z <= groundAt(h.x, h.y).z + 0.002 && h.vz <= 0 && h.st < h.dur - 0.5 && (h.st % 0.75) < dt * 1.5) h.vz = 0.75;
      if (h.st > h.dur && h.vz === 0) setState('idle', rand(1, 2));
      break;
    case 'door':
      if (h.flag === 0 && h.st > 1.2) { h.flag = 1; say(pick(['Cerrada…', 'No se abre…', 'Clic, clic… nada']), 1.6); audio.voice('sad'); }
      if (h.flag === 1 && h.st > 2.6) { h.flag = 2; h.targetFacing = -HALF_PI; if (face.present) say('¿Me ayudas?', 1.4); }
      if (h.st > h.dur) setState('idle', rand(0.5, 1.5));
      break;
    case 'lamp':
      if (!h.lampDone && h.st > 0.5) { h.lampDone = true; if (lamp && Math.hypot(lamp.x - h.x, lamp.y - h.y) < 0.13) setLamp(!lamp.on); }
      if (h.st > h.dur) setState('idle', rand(0.8, 1.6));
      break;
    case 'reach':
      if (!finger.follow) { setState('idle', 1); say('♥', 1); break; }
      h.targetFacing = Math.atan2(finger.y - h.y, finger.x - h.x);
      if (Math.hypot(finger.x - h.x, finger.y - h.y) > 0.09) followFinger();
      break;
    case 'dizzy':
      if (h.st > h.dur) setState('idle', 1);
      break;
    case 'fallen': {
      const sp = Math.hypot(h.vx, h.vy);
      if (sp < 0.08 && tm < 0.2) h.still += dt; else h.still = 0;
      if (h.st > 0.6 && h.still > h.fallT) setState('getup');
      break;
    }
    case 'getup':
      if (h.st > 0.75) {
        if (h.hard) { setState('dizzy', 1.6); say(pick(['@_@', 'Uff…', 'Todo da vueltas…']), 1.4); }
        else setState('idle', 0.8);
      }
      break;
  }
}

function followFinger() {
  const h = human;
  const ang = Math.atan2(h.y - finger.y, h.x - finger.x);
  const x = finger.x + Math.cos(ang) * 0.06, y = finger.y + Math.sin(ang) * 0.06;
  walkTo(x, y, () => { setState('reach'); say(pick(['♥', '¡Hola, dedo!', '¡Choca!']), 1.2); audio.voice('happy'); }, { fast: true });
}

/* ---------- Pose y animación ---------- */
const lookV = new THREE.Vector3();
function updateHumanVisual(dt, t) {
  const h = human;
  const lv = h.state === 'held' ? 30 : 18;
  h.vis.x = damp(h.vis.x, h.x, lv, dt);
  h.vis.y = damp(h.vis.y, h.y, lv, dt);
  h.vis.z = damp(h.vis.z, h.z, lv, dt);
  h.visFacing += wrap(h.facing - h.visFacing) * Math.min(1, dt * 14);

  const p = standPose();
  const s = h.state;
  const breath = Math.sin(t * 2.2) * 0.02;
  p.torso = breath;
  const callsYou = s === 'wave' || s === 'help' || s === 'held' || (s === 'door' && h.flag === 2);
  const lookUser = callsYou || (face.present && (s === 'idle' || s === 'look' || s === 'sit' || s === 'dizzy'));

  if (s === 'walk' || s === 'stumble') {
    const ph = h.walkPhase, a = s === 'stumble' ? 0.75 : 0.55;
    p.hipL = Math.sin(ph) * a; p.hipR = -Math.sin(ph) * a;
    p.kneeL = 0.12 + Math.max(0, -Math.sin(ph + 0.6)) * 0.7;
    p.kneeR = 0.12 + Math.max(0, Math.sin(ph + 0.6)) * 0.7;
    p.armL = -p.hipL * 0.8; p.armR = -p.hipR * 0.8;
    p.pelvisY = 0.104 - Math.abs(Math.cos(ph)) * 0.005;
    p.torso = -0.08;
    if (s === 'stumble') { p.raiseL = 1.3 + Math.sin(t * 13) * 0.4; p.raiseR = 1.3 + Math.cos(t * 11) * 0.4; p.torso = Math.sin(t * 9) * 0.15; }
  } else if (s === 'sit') {
    p.hipL = p.hipR = -1.5; p.kneeL = 1.45 + Math.sin(t * 3) * 0.12; p.kneeR = 1.45 - Math.sin(t * 3) * 0.12;
    p.pelvisY = 0.012; p.armL = p.armR = -0.35; p.raiseL = p.raiseR = 0.15;
  } else if (s === 'sleep') {
    p.bodyRot = 0; p.lift = 0.03; p.raiseL = p.raiseR = 0.25; p.torso = Math.sin(t * 1.2) * 0.03; p.pitch = 0.2;
  } else if (s === 'fallen') {
    p.bodyRot = 0; p.lift = 0.03; p.spread = 0.35; p.raiseL = 1.25 + Math.sin(t * 2) * 0.1; p.raiseR = 1.25; p.hipL = -0.1; p.kneeR = 0.4;
  } else if (s === 'getup') {
    p.bodyRot = HALF_PI; p.pelvisY = 0.07; p.hipL = p.hipR = -0.9; p.kneeL = p.kneeR = 1.5; p.torso = 0.5; p.armL = p.armR = -0.6;
  } else if (s === 'held') {
    p.spread = 0.15; p.hipL = Math.sin(t * 13) * 0.55; p.hipR = -Math.sin(t * 13) * 0.55; p.kneeL = p.kneeR = 0.35;
    p.raiseL = 2.5 + Math.sin(t * 15) * 0.35; p.raiseR = 2.5 + Math.cos(t * 14) * 0.35; p.pitch = -0.7;
  } else if (s === 'air') {
    p.raiseL = 2.2 + Math.sin(t * 18) * 0.3; p.raiseR = 2.2 + Math.cos(t * 17) * 0.3; p.spread = 0.3; p.hipL = -0.4; p.hipR = 0.2; p.kneeL = p.kneeR = 0.6;
  } else if (s === 'wave') {
    p.raiseR = 2.7 + Math.sin(t * 11) * 0.35; p.pitch = -1;
  } else if (s === 'help') {
    p.raiseL = 2.6 + Math.sin(t * 12) * 0.35; p.raiseR = 2.6 + Math.sin(t * 12 + 2) * 0.35; p.pitch = -1.1;
    if (h.vz !== 0) { p.kneeL = p.kneeR = 0.5; p.hipL = p.hipR = -0.3; }
  } else if (s === 'door') {
    p.armR = h.flag === 0 ? -1.35 + Math.sin(t * 20) * 0.08 : -0.2; p.raiseR = 0.05;
    if (h.flag === 1) { p.torso = 0.2; p.pitch = 0.4; }
  } else if (s === 'lamp') {
    p.armL = h.st < 0.8 ? -1.3 : -0.2; p.raiseL = 0.1;
  } else if (s === 'reach') {
    p.raiseL = p.raiseR = 2.75; p.armL = p.armR = -0.3; p.pitch = -1.2; p.pelvisY = 0.104 + Math.abs(Math.sin(t * 4)) * 0.006;
  } else if (s === 'dizzy') {
    p.torso = Math.sin(t * 6) * 0.18; p.raiseL = 0.5; p.raiseR = 0.5; p.yaw = Math.sin(t * 5) * 0.4;
  }

  // Mirar: a ti (si te detecta), al dedo o a puntos al azar
  let target = null;
  if (s === 'reach' || (finger.follow && UPRIGHT.has(s))) target = lookV.set(finger.x, finger.y, D);
  else if (h.look && t < h.lookT) target = lookV.set(h.look.x, h.look.y, h.look.z);
  else if (lookUser) target = lookV.set(eye.x, eye.y, D + eye.z);
  else if ((s === 'idle' || s === 'look') && Math.random() < dt * (s === 'look' ? 0.9 : 0.3)) {
    h.look = { x: rand(-W / 2, W / 2), y: rand(-H / 2, H / 2), z: rand(0, D * 0.8) };
    h.lookT = t + rand(0.8, 2);
  }
  if (target && s !== 'fallen' && s !== 'sleep' && s !== 'getup') {
    const hx = h.vis.x, hy = h.vis.y, hz = h.vis.z + 0.25;
    const dx = target.x - hx, dy = target.y - hy, dz = target.z - hz, hor = Math.hypot(dx, dy);
    let yaw = hor > 0.02 ? wrap(Math.atan2(dy, dx) - h.visFacing) : 0;
    if ((s === 'idle' || s === 'look') && Math.abs(yaw) > 1.3) h.targetFacing = Math.atan2(dy, dx);
    p.yaw = clamp(yaw, -1.3, 1.3) * clamp(hor / (Math.abs(dz) * 0.6 + 0.01), 0.15, 1);
    p.pitch = clamp(-Math.atan2(dz, hor), -1.25, 0.6);
  }

  const rate = s === 'fallen' || s === 'getup' || s === 'sleep' ? 9 : 16;
  for (const k of POSE_KEYS) pose[k] = damp(pose[k], p[k], rate, dt);

  // Inclinación del cuerpo: compensa la inclinación del suelo, o se balancea al colgar del dedo
  let lx = 0, ly = 0;
  if (s === 'held') { lx = clamp(grab.vx * 0.35, -0.7, 0.7); ly = clamp(-grab.vy * 0.35, -0.7, 0.7); }
  else if (UPRIGHT.has(s) || s === 'stumble') { lx = clamp(-tilt.x, -0.5, 0.5) * 0.9; ly = clamp(tilt.y, -0.5, 0.5) * 0.9; }
  rig.lean.rotation.y = damp(rig.lean.rotation.y, lx, 10, dt);
  rig.lean.rotation.x = damp(rig.lean.rotation.x, ly, 10, dt);

  rig.root.position.set(h.vis.x, h.vis.y, h.vis.z + pose.lift);
  rig.heading.rotation.z = h.visFacing + HALF_PI;
  rig.body.rotation.x = pose.bodyRot;
  rig.pelvis.position.y = pose.pelvisY;
  rig.chest.rotation.x = pose.torso;
  rig.hipL.rotation.set(pose.hipL, 0, pose.spread);
  rig.hipR.rotation.set(pose.hipR, 0, -pose.spread);
  rig.kneeL.rotation.x = pose.kneeL;
  rig.kneeR.rotation.x = pose.kneeR;
  rig.shL.rotation.set(pose.armL, 0, pose.raiseL);
  rig.shR.rotation.set(pose.armR, 0, -pose.raiseR);
  rig.head.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');

  const dizzy = s === 'dizzy' || (s === 'getup' && h.hard) || (s === 'fallen' && h.hard && h.st > 0.5);
  rig.stars.visible = dizzy;
  if (dizzy) rig.stars.rotation.y = t * 5;
}

/* =====================================================================
 *  Bocadillo, avisos
 * ===================================================================== */
const bubbleEl = $('bubble');
const bubble = { t: 0 };
function say(text, dur = 1.5) {
  bubbleEl.textContent = text;
  bubble.t = dur;
  bubbleEl.classList.add('show');
}
const projV = new THREE.Vector3();
function updateBubble(dt) {
  if (bubble.t <= 0) return;
  bubble.t -= dt;
  if (bubble.t <= 0) { bubbleEl.classList.remove('show'); return; }
  const h = human;
  const lying = h.state === 'fallen' || h.state === 'sleep';
  projV.set(h.vis.x, h.vis.y, h.vis.z + (lying ? 0.08 : HUMAN_H + 0.03)).project(camera);
  const x = (projV.x * 0.5 + 0.5) * innerWidth, y = (-projV.y * 0.5 + 0.5) * innerHeight;
  const bw = bubbleEl.offsetWidth;
  const cx = clamp(x, bw / 2 + 8, innerWidth - bw / 2 - 8);
  bubbleEl.style.transform = `translate(${cx - bw / 2}px, ${Math.max(8, y - bubbleEl.offsetHeight - 10)}px)`;
}

const tipEl = $('tip');
let tipTimer = 0;
function tip(text, ms = 4000) {
  tipEl.textContent = text;
  tipEl.classList.remove('hide');
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => tipEl.classList.add('hide'), ms);
}

function ripple(x, y) {
  const d = document.createElement('div');
  d.className = 'ripple';
  d.style.left = x + 'px'; d.style.top = y + 'px';
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 600);
}
function shakeScreen() {
  canvas.classList.remove('shake');
  void canvas.offsetWidth;
  canvas.classList.add('shake');
  if (navigator.vibrate) navigator.vibrate(30);
}

/* =====================================================================
 *  Sonido (Web Audio, todo sintetizado)
 * ===================================================================== */
const audio = {
  ctx: null, on: true, master: null, noise: null,
  init() {
    if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 0.4;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  },
  ok() { return this.ctx && this.on && this.ctx.state === 'running'; },
  blip(f0, f1, dur, type = 'triangle', vol = 0.12, delay = 0, formant = 0) {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (formant) {
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = formant; bp.Q.value = 2.5;
      o.connect(bp); node = bp;
    }
    node.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },
  voice(mood = 'happy') {
    const base = { happy: 420, alarm: 520, angry: 230, sad: 300 }[mood] || 400;
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const f = base * rand(0.85, 1.3);
      const end = mood === 'sad' ? f * 0.7 : mood === 'alarm' ? f * 1.4 : f * rand(0.85, 1.2);
      this.blip(f, end, 0.075, 'sawtooth', 0.22, i * 0.09, rand(900, 1800));
    }
  },
  giggle() { for (let i = 0; i < 4; i++) this.blip(700 + i * 40, 900 + i * 30, 0.05, 'sawtooth', 0.18, i * 0.06, 1500); },
  thud(vol = 0.3) {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime;
    const s = c.createBufferSource(); s.buffer = this.noise;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    s.connect(lp); lp.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + 0.2);
    this.blip(110, 50, 0.15, 'sine', vol * 0.8);
  },
  bonk() { this.blip(1400, 700, 0.18, 'sine', 0.25); this.blip(2100, 1500, 0.08, 'triangle', 0.08); },
  click() { this.blip(2400, 1600, 0.025, 'square', 0.05); this.blip(1800, 1200, 0.02, 'square', 0.04, 0.05); },
};

/* =====================================================================
 *  Interacción con el dedo
 * ===================================================================== */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const hitV = new THREE.Vector3(), segA = new THREE.Vector3(), segB = new THREE.Vector3();
const pointers = new Map();
let lastFurnTap = { f: null, t: 0 };

function rayAt(cx, cy) {
  ndc.set((cx / innerWidth) * 2 - 1, -(cy / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}
function planeHit(ray, z) {
  floorPlane.constant = -z;
  return ray.intersectPlane(floorPlane, hitV) ? { x: hitV.x, y: hitV.y } : null;
}
function hitsHuman(ray) {
  rig.root.getWorldPosition(segA);
  rig.head.getWorldPosition(segB);
  segB.lerp(segA, -0.25); // un poco por encima de la cabeza
  return ray.distanceSqToSegment(segA, segB) < 0.07 * 0.07;
}
function hitsFurn() {
  const hits = raycaster.intersectObjects(furn.map((f) => f.g), true);
  return hits.length ? hits[0].object.userData.furn : null;
}

function onDown(e) {
  audio.init();
  canvas.setPointerCapture(e.pointerId);
  const ray = rayAt(e.clientX, e.clientY);
  const p = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), moved: false, kind: 'floor' };
  if (!grab.active && hitsHuman(ray)) {
    p.kind = 'human';
  } else {
    const f = hitsFurn();
    if (f) {
      p.kind = 'furn'; p.f = f;
      const pt = planeHit(ray, 0) || { x: f.x, y: f.y };
      p.ox = f.x - pt.x; p.oy = f.y - pt.y;
    } else {
      const pt = planeHit(ray, 0);
      if (pt) { p.pt = pt; human.look = { x: pt.x, y: pt.y, z: D }; human.lookT = clock + 1.2; }
      ripple(e.clientX, e.clientY);
    }
  }
  pointers.set(e.pointerId, p);
}

function onMove(e) {
  if (e.pointerType === 'mouse' && !pointers.size) {
    mouse.active = true;
    mouse.x = (e.clientX / innerWidth) * 2 - 1;
    mouse.y = -((e.clientY / innerHeight) * 2 - 1);
  }
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX; p.y = e.clientY;
  if (!p.moved && Math.hypot(p.x - p.x0, p.y - p.y0) > 9) p.moved = true;
  const ray = rayAt(p.x, p.y);
  if (p.kind === 'human') {
    if (p.moved && !grab.active) startGrab(p);
    if (grab.active && grab.id === p.id) { const pt = planeHit(ray, liftZ()); if (pt) { grab.x = pt.x; grab.y = pt.y; } }
  } else if (p.kind === 'furn' && p.moved) {
    const pt = planeHit(ray, 0);
    if (pt) {
      if (!p.f.drag && human.on !== p.f && (human.state === 'idle' || human.state === 'look')) { human.look = { x: p.f.x, y: p.f.y, z: 0.1 }; human.lookT = clock + 1.5; }
      p.f.drag = { x: pt.x + p.ox, y: pt.y + p.oy };
    }
  } else if (p.kind === 'floor') {
    const pt = planeHit(ray, 0);
    if (pt) { p.pt = pt; if (finger.follow && finger.id === p.id) { finger.x = pt.x; finger.y = pt.y; } }
  }
}

function startGrab(p) {
  const h = human;
  if (h.state === 'sit' || h.state === 'sleep') h.seat = null;
  setState('held');
  grab.active = true; grab.id = p.id; grab.vx = grab.vy = 0;
  grab.x = h.x; grab.y = h.y;
  const pt = planeHit(rayAt(p.x, p.y), liftZ());
  if (pt) { grab.x = pt.x; grab.y = pt.y; }
  say(pick(['¡Eh!', '¡Bájame!', '¡Uaaa!', '¡Qué alto!']), 1.3);
  audio.voice('alarm');
}

function onUp(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  pointers.delete(e.pointerId);
  const dur = performance.now() - p.t0;
  const h = human;
  if (p.kind === 'human') {
    if (grab.active && grab.id === p.id) {
      grab.active = false;
      setState('air');
      h.vx = clamp(grab.vx, -3, 3); h.vy = clamp(grab.vy, -3, 3); h.vz = 0.25;
      const sp = Math.hypot(h.vx, h.vy);
      h.thrown = sp > 0.6;
      h.spin = clamp(sp * 5, 0, 18) * (Math.random() < 0.5 ? -1 : 1);
      if (sp > 1.2) say(pick(['¡Wiiiii!', '¡Aaaaah!', '¡Vuelooo!']), 1.2);
    } else if (!p.moved) poke();
  } else if (p.kind === 'furn') {
    const f = p.f;
    if (f.drag) { f.drag = null; f.vx *= 0.5; f.vy *= 0.5; }
    else if (!p.moved && dur < 350) {
      const now = performance.now();
      if (f === lamp) { setLamp(!lamp.on); if (UPRIGHT.has(h.state)) say(lamp.on ? '¡Luz!' : '¿Quién ha apagado?', 1.2); }
      else if (lastFurnTap.f === f && now - lastFurnTap.t < 380) { rotateFurn(f); lastFurnTap.f = null; }
      else { f.wob = 1; lastFurnTap = { f, t: now }; audio.blip(320, 260, 0.06, 'sine', 0.12); }
    }
  } else if (p.kind === 'floor') {
    if (finger.follow && finger.id === p.id) { finger.follow = false; }
    else if (!p.moved && dur < 350 && p.pt && UPRIGHT.has(h.state) && h.state !== 'held') {
      walkTo(p.pt.x, p.pt.y, () => setState('idle', rand(1.5, 3)));
      if (Math.random() < 0.5) say(pick(['¿Allí?', '¡Voy!', 'Vale, vale']), 1);
    }
  }
}

function rotateFurn(f) {
  const old = f.rot;
  f.rot += HALF_PI;
  updateExtents(f);
  f.x = clamp(f.x, -W / 2 + f.hx, W / 2 - f.hx);
  f.y = clamp(f.y, -H / 2 + f.hy, H / 2 - f.hy);
  f.visRot = old;
  f.wob = 1;
  audio.blip(260, 380, 0.1, 'triangle', 0.12);
}

function checkHolds() {
  const now = performance.now();
  for (const p of pointers.values()) {
    if (p.kind === 'human' && !grab.active && !p.moved && now - p.t0 > 260) startGrab(p);
    if (p.kind === 'floor' && !p.moved && !finger.follow && p.pt && now - p.t0 > 550) {
      finger.follow = true; finger.id = p.id; finger.x = p.pt.x; finger.y = p.pt.y;
      const h = human;
      if (UPRIGHT.has(h.state) || h.state === 'sit') {
        if (h.state === 'sit') standUpFromSeat(); else followFinger();
        say(pick(['¿Qué es eso?', '¡Un dedo!', '¡Ooh!']), 1.2);
      }
    }
  }
}

canvas.addEventListener('pointerdown', onDown);
canvas.addEventListener('pointermove', onMove);
canvas.addEventListener('pointerup', onUp);
canvas.addEventListener('pointercancel', onUp);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  const k = 0.5;
  if (e.key === 'ArrowLeft') sensor.keyT.x = -k;
  if (e.key === 'ArrowRight') sensor.keyT.x = k;
  if (e.key === 'ArrowUp') sensor.keyT.y = k;
  if (e.key === 'ArrowDown') sensor.keyT.y = -k;
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') sensor.keyT.x = 0;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') sensor.keyT.y = 0;
});

/* =====================================================================
 *  Tamaño, bucle principal, arranque
 * ===================================================================== */
let laidOut = false;
function resize() {
  const w = innerWidth, h = innerHeight, s = Math.min(w, h);
  W = w / s; H = h / s; D = 0.9;
  CM_PER_UNIT = s / PX_PER_CM;
  renderer.setSize(w, h, false);
  buildRoom();
  if (!laidOut) { layout(); laidOut = true; }
  for (const f of furn) { f.x = clamp(f.x, -W / 2 + f.hx, W / 2 - f.hx); f.y = clamp(f.y, -H / 2 + f.hy, H / 2 - f.hy); }
  human.x = clamp(human.x, -W / 2 + H_R, W / 2 - H_R);
  human.y = clamp(human.y, -H / 2 + H_R, H / 2 - H_R);
}
window.addEventListener('resize', resize);
resize();
human.y = H * 0.27; human.vis.y = human.y;
eye.z = 32 / CM_PER_UNIT;

let clock = 0, last = performance.now(), running = false;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;
  updateTilt(dt);
  if (running) {
    detectFace(now);
    checkHolds();
    // dos subpasos de física para más estabilidad
    for (let i = 0; i < 2; i++) { stepFurniture(dt / 2); stepHuman(dt / 2); }
  }
  updateEye(dt);
  updateHumanVisual(dt, clock);
  updateCamera();
  renderer.render(scene, camera);
  updateBubble(dt);
}
requestAnimationFrame(frame);

async function requestSensors() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') await DeviceOrientationEvent.requestPermission();
  } catch (err) { console.warn(err); }
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') await DeviceMotionEvent.requestPermission();
  } catch (err) { console.warn(err); }
  window.addEventListener('deviceorientation', onOrientation);
  window.addEventListener('devicemotion', onMotion);
}

async function start(withCam) {
  audio.init();
  await requestSensors();
  $('intro').hidden = true;
  $('hud').hidden = false;
  running = true;
  try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('portrait').catch(() => {}); } catch { /* no disponible */ }
  tip(isTouch ? 'Inclina el móvil · toca al humano · mantén para cogerlo · arrastra los muebles' : 'Flechas: inclinar · clic: tocar · mantén y arrastra para coger · arrastra los muebles', 6000);
  setTimeout(() => { say('¿Hola? ¿Hay alguien ahí?', 2.2); audio.voice('happy'); }, 900);
  if (withCam) startFace();
  setEyeDot();
}

$('btn-start').addEventListener('click', () => start(true));
$('btn-start-nocam').addEventListener('click', () => start(false));
$('btn-eyes').addEventListener('click', () => { if (face.enabled) stopFace(); else startFace(); });
$('btn-level').addEventListener('click', () => { recalibrate(); tip('Nivelado: esta posición es ahora "plana".', 2000); });
const DEPTHS = [1, 1.6, 2.4];
$('btn-depth').addEventListener('click', (e) => {
  depthK = DEPTHS[(DEPTHS.indexOf(depthK) + 1) % DEPTHS.length];
  e.currentTarget.textContent = `3D ×${depthK}`;
});
$('btn-sound').addEventListener('click', (e) => {
  audio.on = !audio.on;
  e.currentTarget.classList.toggle('on', audio.on);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) last = performance.now(); });

// Para depurar desde la consola
window.__room = { human, furn, tilt, sensor, eye, face, setState, setLamp };
