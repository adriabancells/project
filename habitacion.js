// Atrapado: un pequeño humano vive dentro de la pantalla del móvil.
// Simulador de vida retro en una sola habitación: la pantalla es el cristal de la habitación vista
// desde arriba. Necesidades (hambre, energía, diversión, higiene, vejiga, social), dinero, tienda,
// visitas, inclinación del móvil y seguimiento de los ojos con la cámara frontal (proyección off-axis).

import * as THREE from 'three';

const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const SAVE_KEY = 'atrapado.v2';

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

// Física (unidades del mundo: el lado corto de la habitación mide 1)
const G = 3.6;        // aceleración por inclinación
const GZ = 4.2;       // gravedad vertical (hacia el suelo)
const H_R = 0.034;    // radio de un humano
const HUMAN_H = 0.3;  // altura de un humano

/* =====================================================================
 *  Render retro: escena a baja resolución + paleta reducida con tramado
 * ===================================================================== */
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#2b2433');
const camera = new THREE.PerspectiveCamera();

let rt = null;
const post = (() => {
  const mat = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, levels: { value: 22 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float levels; varying vec2 vUv;
      float b2(vec2 v){ return mod(v.x * 2.0 + v.y * 3.0, 4.0); }
      float bayer4(vec2 p){ p = floor(mod(p, 4.0)); return (4.0 * b2(mod(p, 2.0)) + b2(floor(p / 2.0))) / 16.0; }
      vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      void main(){
        vec3 c = toSRGB(clamp(texture2D(tDiffuse, vUv).rgb, 0.0, 1.0));
        float d = bayer4(gl_FragCoord.xy) - 0.47;
        c = floor(c * levels + 0.5 + d) / levels;
        gl_FragColor = vec4(c, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  const s = new THREE.Scene(); s.add(quad);
  return { mat, scene: s, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1) };
})();

const sun = new THREE.DirectionalLight('#fff1d8', 2.0);
sun.position.set(0.4, 0.7, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(512, 512);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 5;
sun.shadow.bias = -0.002;
scene.add(sun, sun.target);
const amb = new THREE.HemisphereLight('#fff6e8', '#7a6a5a', 1.35);
amb.position.set(0, 0, 1);
scene.add(amb);

const matCache = new Map();
function mat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts }));
  return matCache.get(key);
}
function shadowed(m) { m.castShadow = true; m.receiveShadow = true; return m; }
// Caja: w a lo largo de x, d a lo largo de y, h a lo largo de z (z = hacia el cristal)
function box(w, d, h, color, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), typeof color === 'string' ? mat(color) : color);
  m.position.set(x, y, z);
  return shadowed(m);
}
function cyl(rt0, rb, h, color, x, y, z, seg = 8) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt0, rb, h, seg), typeof color === 'string' ? mat(color) : color);
  m.rotation.x = HALF_PI;
  m.position.set(x, y, z);
  return shadowed(m);
}
function ball(r, color, x, y, z, detail = 1) {
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, detail), typeof color === 'string' ? mat(color) : color);
  m.position.set(x, y, z);
  return shadowed(m);
}

/* ---------- Texturas de píxel ---------- */
function pixTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
const px = (g, c, x, y, w = 1, h = 1) => { g.fillStyle = c; g.fillRect(x, y, w, h); };

const TEX = {
  wood: pixTex(32, 64, (g) => {
    const cols = ['#b9824f', '#c48d58', '#ad7745', '#bf8a55'];
    for (let i = 0; i < 4; i++) {
      px(g, cols[i], i * 8, 0, 8, 64);
      px(g, '#8a5a32', i * 8, 0, 1, 64);
      const off = (i * 23) % 64;
      px(g, '#8a5a32', i * 8, off, 8, 1);
      px(g, '#d29a62', i * 8 + 3, (off + 20) % 64, 1, 6);
    }
  }),
  wallpaper: pixTex(16, 16, (g) => {
    px(g, '#e3cf9f', 0, 0, 16, 16);
    px(g, '#d4bb85', 0, 0, 3, 16);
    px(g, '#c9ad74', 1, 0, 1, 16);
    px(g, '#b9575a', 9, 6, 1, 1); px(g, '#b9575a', 8, 7, 3, 1); px(g, '#b9575a', 9, 8, 1, 1);
    px(g, '#6f8f5f', 9, 9, 1, 2);
  }),
  wainscot: pixTex(16, 16, (g) => {
    px(g, '#7a4a3a', 0, 0, 16, 16);
    px(g, '#8c5845', 1, 2, 6, 12); px(g, '#8c5845', 9, 2, 6, 12);
    px(g, '#5f382b', 0, 0, 16, 1); px(g, '#a26a52', 0, 15, 16, 1);
  }),
  tiles: pixTex(16, 16, (g) => {
    px(g, '#eef1f2', 0, 0, 16, 16);
    px(g, '#7fb3cf', 0, 0, 8, 8); px(g, '#7fb3cf', 8, 8, 8, 8);
    px(g, '#c9d6db', 0, 7, 16, 1); px(g, '#c9d6db', 7, 0, 1, 16);
  }),
  kitchen: pixTex(16, 16, (g) => {
    px(g, '#e9dfc9', 0, 0, 16, 16);
    px(g, '#c76b4c', 0, 0, 8, 8); px(g, '#c76b4c', 8, 8, 8, 8);
    px(g, '#b4a68c', 0, 7, 16, 1); px(g, '#b4a68c', 7, 0, 1, 16);
  }),
  carpet: pixTex(32, 32, (g) => {
    px(g, '#7d3f5b', 0, 0, 32, 32);
    px(g, '#e3c26a', 1, 1, 30, 1); px(g, '#e3c26a', 1, 30, 30, 1); px(g, '#e3c26a', 1, 1, 1, 30); px(g, '#e3c26a', 30, 1, 1, 30);
    for (let y = 6; y < 28; y += 8) for (let x = 6; x < 28; x += 8) { px(g, '#a8587a', x, y, 4, 4); px(g, '#e3c26a', x + 1, y + 1, 2, 2); }
  }, false),
  sky: pixTex(16, 16, (g) => {
    for (let y = 0; y < 16; y++) px(g, `rgb(${120 + y * 6},${170 + y * 4},${220 + y * 2})`, 0, y, 16, 1);
    px(g, '#ffffff', 3, 4, 5, 2); px(g, '#ffffff', 5, 3, 3, 1);
  }, false),
  art: pixTex(16, 20, (g) => {
    px(g, '#f2ead8', 0, 0, 16, 20);
    px(g, '#e88f3c', 3, 3, 6, 6); px(g, '#4f7fb5', 8, 9, 6, 8); px(g, '#6e9d55', 2, 12, 6, 6);
  }, false),
  blanket: pixTex(16, 16, (g) => {
    px(g, '#4f78b0', 0, 0, 16, 16);
    for (let i = 0; i < 16; i += 4) { px(g, '#6b93c8', i, 0, 2, 16); px(g, '#e6d27a', 0, i, 16, 1); }
  }),
  sofa: pixTex(8, 8, (g) => {
    px(g, '#8f6a3e', 0, 0, 8, 8);
    px(g, '#a17a4a', 0, 0, 4, 4); px(g, '#a17a4a', 4, 4, 4, 4);
  }),
};

function texMat(tex, repeatX = 1, repeatY = 1) {
  const t = tex.clone();
  t.needsUpdate = true;
  t.repeat.set(repeatX, repeatY);
  return new THREE.MeshLambertMaterial({ map: t });
}

/* =====================================================================
 *  Habitación (suelo en z = 0, cristal/pantalla en z = D)
 * ===================================================================== */
let W = 1, H = 2, D = 0.9, CM_PER_UNIT = 6.5;
const room = new THREE.Group();
scene.add(room);
const door = { x: -0.05, hinge: null, open: 0, target: 0 };

function wallPlane(len, matl, basisX, normal, pos) {
  const geo = new THREE.PlaneGeometry(len, D);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len / 0.11, uv.getY(i) * D / 0.11);
  const m = new THREE.Mesh(geo, matl);
  const Y = new THREE.Vector3(0, 0, 1);
  m.matrixAutoUpdate = false;
  m.matrix.makeBasis(basisX, Y, normal).setPosition(pos);
  m.receiveShadow = true;
  return m;
}

function buildRoom() {
  room.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  room.clear();
  const wp = new THREE.MeshLambertMaterial({ map: TEX.wallpaper });
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  room.add(wallPlane(H, wp, V(0, 1, 0), V(1, 0, 0), V(-W / 2, 0, D / 2)));
  room.add(wallPlane(H, wp, V(0, -1, 0), V(-1, 0, 0), V(W / 2, 0, D / 2)));
  room.add(wallPlane(W, wp, V(-1, 0, 0), V(0, 1, 0), V(0, -H / 2, D / 2)));
  room.add(wallPlane(W, wp, V(1, 0, 0), V(0, -1, 0), V(0, H / 2, D / 2)));

  // Zócalo alto de madera (friso) y moldura
  const wz = 0.1, t = 0.006;
  const ws = (len) => texMat(TEX.wainscot, len / 0.08, 1);
  room.add(box(t, H, wz, ws(H), -W / 2 + t / 2, 0, wz / 2));
  room.add(box(t, H, wz, ws(H), W / 2 - t / 2, 0, wz / 2));
  room.add(box(W, t, wz, ws(W), 0, -H / 2 + t / 2, wz / 2));
  room.add(box(W, t, wz, ws(W), 0, H / 2 - t / 2, wz / 2));
  const rail = '#5f382b';
  room.add(box(0.012, H, 0.008, rail, -W / 2 + 0.006, 0, wz));
  room.add(box(0.012, H, 0.008, rail, W / 2 - 0.006, 0, wz));
  room.add(box(W, 0.012, 0.008, rail, 0, -H / 2 + 0.006, wz));
  room.add(box(W, 0.012, 0.008, rail, 0, H / 2 - 0.006, wz));

  // Suelo de madera + zonas: cocina (baldosas), baño (azulejos), alfombra
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, H), texMat(TEX.wood, W / 0.13, H / 0.26));
  floor.receiveShadow = true;
  room.add(floor);
  const zone = (tex, w, h, x, y, tile) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), tile ? texMat(tex, w / tile, h / tile) : new THREE.MeshLambertMaterial({ map: tex }));
    m.position.set(x, y, 0.0012);
    m.receiveShadow = true;
    room.add(m);
  };
  zone(TEX.kitchen, 0.36, 0.3, -W / 2 + 0.18, H / 2 - 0.15, 0.06);
  zone(TEX.tiles, 0.34, 0.5, W / 2 - 0.17, H / 2 - 0.25, 0.05);
  zone(TEX.carpet, 0.42, 0.34, W * 0.12, -H * 0.2, 0);

  // Puerta con bisagra en la pared de arriba (se abre para las visitas)
  door.x = clamp(-0.03, -W / 2 + 0.3, W / 2 - 0.3);
  const dw = 0.15, dh = 0.3;
  room.add(box(dw + 0.03, 0.012, dh + 0.02, '#f1e6d0', door.x, H / 2 - 0.004, (dh + 0.02) / 2));
  room.add(box(dw, 0.004, dh, '#14100e', door.x, H / 2 - 0.01, dh / 2));
  door.hinge = new THREE.Group();
  door.hinge.position.set(door.x + dw / 2, H / 2 - 0.016, 0);
  const panel = box(dw, 0.012, dh, '#9a6a44', -dw / 2, 0, dh / 2);
  door.hinge.add(panel);
  door.hinge.add(box(dw * 0.7, 0.004, dh * 0.3, '#86593a', -dw / 2, -0.007, dh * 0.7));
  door.hinge.add(box(dw * 0.7, 0.004, dh * 0.3, '#86593a', -dw / 2, -0.007, dh * 0.3));
  door.hinge.add(ball(0.009, '#e2c14a', -dw + 0.02, -0.012, 0.14, 0));
  door.hinge.rotation.z = door.open;
  room.add(door.hinge);

  // Ventana en la pared izquierda
  const wy = H * 0.05;
  room.add(box(0.01, 0.32, 0.25, '#f1e6d0', -W / 2 + 0.004, wy, D * 0.55));
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.21), new THREE.MeshBasicMaterial({ map: TEX.sky }));
  sky.matrixAutoUpdate = false;
  sky.matrix.makeBasis(V(0, 1, 0), V(0, 0, 1), V(1, 0, 0)).setPosition(-W / 2 + 0.0095, wy, D * 0.55);
  room.add(sky);
  room.add(box(0.014, 0.01, 0.21, '#f1e6d0', -W / 2 + 0.01, wy, D * 0.55));
  room.add(box(0.014, 0.28, 0.01, '#f1e6d0', -W / 2 + 0.01, wy, D * 0.55));
  room.add(box(0.03, 0.34, 0.012, '#f1e6d0', -W / 2 + 0.015, wy, D * 0.55 - 0.13));

  // Cuadro en la pared derecha
  const ay = -H * 0.3;
  room.add(box(0.01, 0.15, 0.19, '#5f382b', W / 2 - 0.005, ay, D * 0.55));
  const art = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.15), new THREE.MeshLambertMaterial({ map: TEX.art }));
  art.matrixAutoUpdate = false;
  art.matrix.makeBasis(V(0, -1, 0), V(0, 0, 1), V(-1, 0, 0)).setPosition(W / 2 - 0.0105, ay, D * 0.55);
  room.add(art);

  const sc = sun.shadow.camera, ext = Math.max(W, H) / 2 + 0.25;
  sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext;
  sc.updateProjectionMatrix();
}

/* =====================================================================
 *  Objetos: aspecto, colisión, asientos y acciones
 * ===================================================================== */
// Cada acción: label, anim ('stand' | 'sit' | 'lie' | 'dance' | 'kick'), pose (detalle de los brazos),
// dur (s), rates (necesidades/s y dinero/s mientras dura), adv (lo que "promete" a la IA),
// seat(f) (para sentarse/tumbarse), spot(f) (dónde ponerse de pie), cost, visitor (si las visitas la usan).
const C = {
  wood: '#9b6a42', woodDark: '#6a4529', white: '#ece6da', cream: '#e8dcc0', metal: '#6b6a72',
  red: '#c0504a', blue: '#4f78b0', green: '#5f9a55', yellow: '#e3c26a', black: '#2a2630',
};
const screenMat = () => new THREE.MeshBasicMaterial({ color: '#1d2a2a' });

const DEFS = {
  fridge: {
    name: 'Nevera', icon: '🧊', price: 280, hx: 0.055, hy: 0.045, mass: 8, mus: 0.45,
    build() {
      const g = new THREE.Group();
      g.add(box(0.11, 0.09, 0.27, C.white, 0, 0, 0.135));
      g.add(box(0.112, 0.004, 0.003, '#b9b2a4', 0, 0.044, 0.18));
      g.add(box(0.008, 0.008, 0.06, C.metal, -0.04, 0.048, 0.21));
      g.add(box(0.008, 0.008, 0.05, C.metal, -0.04, 0.048, 0.11));
      g.add(box(0.03, 0.002, 0.03, C.red, 0.025, 0.046, 0.22));
      g.add(box(0.02, 0.002, 0.02, C.yellow, 0.02, 0.046, 0.12));
      return g;
    },
    support: () => 0.28,
    actions: [
      { id: 'eat', label: 'Comer', cost: 6, anim: 'stand', pose: 'reach', dur: 1.5, adv: { hunger: 65 }, visitor: true, exclusive: true,
        onEnd(a, interrupted) { if (!interrupted) a.startMeal(); } },
      { id: 'snack', label: 'Picar algo', cost: 2, anim: 'stand', pose: 'eat', dur: 4, rates: { hunger: 5, fun: 0.5 }, adv: { hunger: 20 }, exclusive: true },
    ],
  },
  bed: {
    name: 'Cama', icon: '🛏️', price: 220, hx: 0.1, hy: 0.17, mass: 9, mus: 0.5,
    build() {
      const g = new THREE.Group();
      g.add(box(0.2, 0.34, 0.05, C.wood, 0, 0, 0.035));
      g.add(box(0.18, 0.31, 0.028, C.white, 0, 0.005, 0.072));
      g.add(box(0.19, 0.2, 0.034, texMat(TEX.blanket, 2, 2), 0, 0.06, 0.077));
      g.add(box(0.12, 0.055, 0.024, '#f4f0e6', 0, -0.12, 0.094));
      g.add(box(0.2, 0.02, 0.13, C.woodDark, 0, -0.16, 0.065));
      for (const [x, y] of [[-0.09, -0.16], [0.09, -0.16], [-0.09, 0.16], [0.09, 0.16]]) g.add(box(0.016, 0.016, 0.012, C.woodDark, x, y, 0.006));
      return g;
    },
    support: (lx, ly) => (ly < -0.148 ? 0.13 : 0.094),
    actions: [
      { id: 'sleep', label: 'Dormir', anim: 'lie', dur: 60, rates: { energy: 4.5 }, adv: { energy: 90 },
        seat: () => ({ lx: 0, ly: 0.125, h: 0.09, face: HALF_PI }), until: (a) => a.needs && a.needs.energy >= 99.5 && a.act.t > 6 },
      { id: 'nap', label: 'Siesta', anim: 'lie', dur: 10, rates: { energy: 3.5 }, adv: { energy: 30 },
        seat: () => ({ lx: 0, ly: 0.125, h: 0.09, face: HALF_PI }) },
    ],
  },
  toilet: {
    name: 'Váter', icon: '🚽', price: 120, hx: 0.036, hy: 0.048, mass: 4, mus: 0.5,
    build() {
      const g = new THREE.Group();
      g.add(cyl(0.022, 0.018, 0.04, C.white, 0, 0.008, 0.02, 10));
      g.add(box(0.06, 0.07, 0.016, C.white, 0, 0.01, 0.048));
      g.add(box(0.046, 0.05, 0.004, '#d9d4c8', 0, 0.012, 0.057));
      g.add(box(0.07, 0.024, 0.075, C.white, 0, -0.036, 0.075));
      g.add(box(0.012, 0.004, 0.006, C.metal, 0.02, -0.022, 0.1));
      return g;
    },
    support: (lx, ly) => (ly < -0.022 ? 0.112 : 0.058),
    actions: [
      { id: 'pee', label: 'Usar', anim: 'sit', dur: 4.5, adv: { bladder: 100 }, visitor: true,
        seat: () => ({ lx: 0, ly: 0.008, h: 0.058, face: HALF_PI }),
        onEnd(a, interrupted) { if (!interrupted && a.needs) { a.needs.bladder = 100; a.needs.hygiene = Math.max(0, a.needs.hygiene - 3); } audio.flush(); } },
    ],
  },
  shower: {
    name: 'Ducha', icon: '🚿', price: 260, hx: 0.066, hy: 0.066, mass: 6, mus: 0.6,
    build() {
      const g = new THREE.Group();
      g.add(box(0.132, 0.132, 0.012, '#e8eef0', 0, 0, 0.006));
      g.add(box(0.1, 0.1, 0.002, '#a9c7d6', 0, 0, 0.013));
      const glass = new THREE.MeshLambertMaterial({ color: '#bfe3f0', transparent: true, opacity: 0.35 });
      const gx = box(0.004, 0.13, 0.28, glass, -0.064, 0, 0.14); gx.castShadow = false; g.add(gx);
      const gy = box(0.13, 0.004, 0.28, glass, 0, 0.064, 0.14); gy.castShadow = false; g.add(gy);
      g.add(box(0.006, 0.006, 0.3, C.metal, 0.058, -0.058, 0.15));
      g.add(cyl(0.016, 0.01, 0.01, C.metal, 0.045, -0.045, 0.29, 8));
      return g;
    },
    support: () => 0.012,
    actions: [
      { id: 'shower', label: 'Ducharse', anim: 'stand', pose: 'shower', dur: 7, rates: { hygiene: 16, fun: 0.6 }, adv: { hygiene: 85 }, exclusive: true,
        spot: () => ({ lx: 0, ly: 0, face: -HALF_PI, inside: true }) },
    ],
  },
  desk: {
    name: 'Ordenador', icon: '🖥️', price: 400, hx: 0.08, hy: 0.075, mass: 4, mus: 0.4,
    build() {
      const g = new THREE.Group();
      g.add(box(0.16, 0.07, 0.012, C.wood, 0, -0.04, 0.112));
      for (const x of [-0.072, 0.072]) g.add(box(0.012, 0.064, 0.106, C.woodDark, x, -0.04, 0.053));
      g.add(box(0.068, 0.05, 0.055, '#d8cfb8', 0, -0.052, 0.147));
      g.add(box(0.05, 0.03, 0.02, '#cfc5ad', 0, -0.07, 0.13));
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.04), screenMat());
      scr.rotation.x = -HALF_PI; scr.position.set(0, -0.0265, 0.15);
      g.add(scr);
      g.userData.screen = scr.material;
      g.add(box(0.06, 0.02, 0.005, '#cfc5ad', 0, -0.016, 0.121));
      g.add(cyl(0.024, 0.024, 0.01, C.red, 0, 0.038, 0.066, 10));
      g.add(cyl(0.005, 0.005, 0.062, C.metal, 0, 0.038, 0.031, 6));
      return g;
    },
    support: (lx, ly) => (ly < -0.004 ? 0.118 : 0.071),
    actions: [
      { id: 'work', label: 'Trabajar', anim: 'sit', pose: 'type', dur: 14, rates: { fun: -1.3, energy: -0.7, money: 2.5 }, adv: { money: 1 },
        seat: () => ({ lx: 0, ly: 0.038, h: 0.071, face: -HALF_PI }), screen: 'work',
        refuse: (a) => a.needs && (a.mood() < 22 || a.needs.fun < 8 || a.needs.energy < 10) ? pick(['No tengo ganas…', '¡Hoy no!', 'Estoy muy cansado…']) : null },
      { id: 'game', label: 'Jugar a videojuegos', anim: 'sit', pose: 'type', dur: 12, rates: { fun: 5.5, energy: -0.3, social: 0.3 }, adv: { fun: 60 }, visitor: true,
        seat: () => ({ lx: 0, ly: 0.038, h: 0.071, face: -HALF_PI }), screen: 'game' },
    ],
  },
  table: {
    name: 'Mesa', icon: '🍽️', price: 80, hx: 0.1, hy: 0.07, mass: 3, mus: 0.3,
    build() {
      const g = new THREE.Group();
      g.add(box(0.2, 0.14, 0.012, C.wood, 0, 0, 0.12));
      for (const [x, y] of [[-0.088, -0.058], [0.088, -0.058], [-0.088, 0.058], [0.088, 0.058]]) g.add(box(0.012, 0.012, 0.114, C.woodDark, x, y, 0.057));
      g.add(box(0.12, 0.05, 0.002, '#e9e3d6', 0, 0, 0.127));
      g.add(cyl(0.01, 0.008, 0.024, '#d9e6ea', 0.05, 0.02, 0.138, 8));
      g.add(ball(0.01, C.red, 0.05, 0.02, 0.156, 0));
      return g;
    },
    support: () => 0.126,
    actions: [],
  },
  chair: {
    name: 'Silla', icon: '🪑', price: 40, hx: 0.042, hy: 0.042, mass: 1, mus: 0.22,
    build() {
      const g = new THREE.Group();
      g.add(box(0.084, 0.084, 0.012, C.green, 0, 0, 0.073));
      for (const [x, y] of [[-0.034, -0.034], [0.034, -0.034], [-0.034, 0.034], [0.034, 0.034]]) g.add(box(0.01, 0.01, 0.068, C.woodDark, x, y, 0.034));
      g.add(box(0.084, 0.012, 0.085, C.green, 0, -0.036, 0.122));
      return g;
    },
    support: (lx, ly) => (ly < -0.03 ? 0.165 : 0.079),
    actions: [
      { id: 'sitc', label: 'Sentarse', anim: 'sit', dur: 8, rates: { energy: 0.6 }, adv: { energy: 6 }, visitor: true,
        seat: () => ({ lx: 0, ly: 0.008, h: 0.079, face: HALF_PI }) },
    ],
  },
  sofa: {
    name: 'Sofá', icon: '🛋️', price: 180, hx: 0.19, hy: 0.07, mass: 6, mus: 0.32,
    build() {
      const g = new THREE.Group();
      const f = texMat(TEX.sofa, 6, 2);
      g.add(box(0.38, 0.13, 0.05, f, 0, 0.005, 0.035));
      g.add(box(0.16, 0.11, 0.028, '#a57d4d', -0.083, 0.012, 0.072));
      g.add(box(0.16, 0.11, 0.028, '#a57d4d', 0.083, 0.012, 0.072));
      g.add(box(0.38, 0.036, 0.13, f, 0, -0.052, 0.075));
      g.add(box(0.03, 0.14, 0.095, f, -0.175, 0, 0.0525));
      g.add(box(0.03, 0.14, 0.095, f, 0.175, 0, 0.0525));
      return g;
    },
    support: (lx, ly) => (Math.abs(lx) > 0.16 ? 0.1 : ly < -0.034 ? 0.14 : 0.086),
    seats: [{ lx: -0.08, ly: 0.012, h: 0.086 }, { lx: 0.08, ly: 0.012, h: 0.086 }],
    actions: [
      { id: 'sits', label: 'Sentarse', anim: 'sit', dur: 10, rates: { energy: 0.8, fun: 0.4 }, adv: { energy: 8, fun: 5 }, visitor: true, seat: 'free' },
      { id: 'naps', label: 'Echarse la siesta', anim: 'lie', dur: 14, rates: { energy: 2.6 }, adv: { energy: 38 },
        seat: () => ({ lx: 0.14, ly: 0.012, h: 0.086, face: 0, all: true }) },
    ],
  },
  tv: {
    name: 'Tele', icon: '📺', price: 160, hx: 0.075, hy: 0.035, mass: 3, mus: 0.35,
    build() {
      const g = new THREE.Group();
      g.add(box(0.15, 0.07, 0.055, C.woodDark, 0, 0, 0.0275));
      g.add(box(0.11, 0.07, 0.085, '#3a3540', 0, -0.006, 0.098));
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.085, 0.064), screenMat());
      scr.rotation.x = -HALF_PI; scr.position.set(0, 0.0295, 0.1);
      g.add(scr);
      g.userData.screen = scr.material;
      g.add(box(0.004, 0.004, 0.05, C.metal, -0.02, -0.01, 0.16));
      g.add(box(0.004, 0.004, 0.05, C.metal, 0.02, -0.01, 0.16));
      return g;
    },
    support: () => 0.14,
    actions: [
      { id: 'watch', label: 'Ver la tele', anim: 'auto', pose: 'watch', dur: 14, rates: { fun: 4.5, energy: 0.2 }, adv: { fun: 55 }, visitor: true, screen: 'tv' },
    ],
  },
  stereo: {
    name: 'Equipo de música', icon: '📻', price: 120, hx: 0.05, hy: 0.03, mass: 2, mus: 0.35,
    build() {
      const g = new THREE.Group();
      g.add(box(0.1, 0.055, 0.05, '#3a3540', 0, 0, 0.025));
      for (const x of [-0.032, 0.032]) {
        g.add(box(0.03, 0.05, 0.1, '#2b2731', x, -0.002, 0.1));
        const cone = cyl(0.011, 0.011, 0.004, C.metal, x, 0.024, 0.11, 8);
        cone.rotation.x = 0;
        g.add(cone);
      }
      g.add(box(0.03, 0.004, 0.012, '#7fd1a8', 0, 0.028, 0.035));
      return g;
    },
    support: () => 0.15,
    actions: [
      { id: 'dance', label: 'Bailar', anim: 'dance', dur: 11, rates: { fun: 5.5, energy: -1.0, hygiene: -0.4 }, adv: { fun: 60 }, visitor: true, music: true,
        spot: (f, a) => ({ lx: rand(-0.06, 0.06), ly: f.lhy + rand(0.08, 0.15), face: -HALF_PI }) },
    ],
  },
  ball: {
    name: 'Pelota', icon: '⚽', price: 25, hx: 0.022, hy: 0.022, mass: 0.15, mus: 0.04, bounce: 0.6, round: true,
    build() {
      const g = new THREE.Group();
      const b = ball(0.022, '#f4f1ea', 0, 0, 0.022, 1);
      b.add(ball(0.0075, C.red, 0.016, 0, 0.012, 0));
      b.add(ball(0.0075, C.red, -0.012, 0.012, -0.012, 0));
      b.add(ball(0.0075, C.blue, 0, -0.016, 0.0, 0));
      g.add(b);
      g.userData.spin = b;
      return g;
    },
    support: () => 0.044,
    actions: [
      { id: 'kick', label: 'Jugar a la pelota', anim: 'kick', dur: 12, rates: { fun: 4.8, energy: -1.1, hygiene: -0.5 }, adv: { fun: 50 }, visitor: true,
        spot: (f) => ({ x: f.x, y: f.y, near: true }) },
    ],
  },
  plant: {
    name: 'Planta', icon: '🪴', price: 35, hx: 0.034, hy: 0.034, mass: 1.5, mus: 0.3,
    build() {
      const g = new THREE.Group();
      g.add(cyl(0.032, 0.025, 0.055, '#b8643f', 0, 0, 0.0275, 8));
      g.add(ball(0.036, C.green, 0, 0, 0.09, 0));
      g.add(ball(0.028, '#4d8445', 0.016, -0.012, 0.118, 0));
      g.add(ball(0.024, '#6fae5f', -0.014, 0.012, 0.128, 0));
      return g;
    },
    support: () => 0.15,
    actions: [
      { id: 'water', label: 'Regar', anim: 'stand', pose: 'reach', dur: 3, rates: { fun: 1.5 }, adv: { fun: 6 } },
    ],
  },
  lamp: {
    name: 'Lámpara', icon: '💡', price: 50, hx: 0.03, hy: 0.03, mass: 2, mus: 0.35,
    build() {
      const g = new THREE.Group();
      g.add(cyl(0.028, 0.03, 0.008, C.metal, 0, 0, 0.004, 10));
      g.add(cyl(0.0035, 0.0035, 0.25, C.metal, 0, 0, 0.129, 6));
      const shadeMat = new THREE.MeshLambertMaterial({ color: '#efd9a0', emissive: '#ffb45c', emissiveIntensity: 0, side: THREE.DoubleSide, flatShading: true });
      const shade = cyl(0.027, 0.045, 0.05, shadeMat, 0, 0, 0.25, 8);
      shade.castShadow = false;
      g.add(shade);
      g.userData.shadeMat = shadeMat;
      const light = new THREE.PointLight('#ffb35a', 0, 1.4, 1.2);
      light.position.set(0, 0, 0.22);
      g.add(light);
      g.userData.light = light;
      return g;
    },
    support: () => 0.3,
    actions: [
      { id: 'toggle', label: 'Encender / apagar', anim: 'stand', pose: 'reach', dur: 0.8, instant: true,
        onEnd(a, interrupted, f) { if (!interrupted) setLamp(f, !f.on); } },
    ],
  },
  books: {
    name: 'Estantería', icon: '📚', price: 90, hx: 0.12, hy: 0.035, mass: 7, mus: 0.45,
    build() {
      const g = new THREE.Group();
      g.add(box(0.24, 0.07, 0.11, C.woodDark, 0, 0, 0.055));
      const cols = [C.red, C.blue, C.yellow, C.green, '#7d3f5b', C.cream, '#4f6f8f'];
      let x = -0.11;
      for (let i = 0; i < 9; i++) {
        const w = 0.012 + (i % 3) * 0.004, hh = 0.04 + ((i * 7) % 4) * 0.008;
        g.add(box(w, 0.05, hh, cols[i % cols.length], x + w / 2, 0.002, 0.11 + hh / 2));
        x += w + 0.002;
      }
      g.add(box(0.05, 0.04, 0.012, C.blue, 0.08, 0, 0.116));
      return g;
    },
    support: (lx) => (lx < 0.04 ? 0.16 : 0.13),
    actions: [
      { id: 'read', label: 'Leer un libro', anim: 'auto', pose: 'read', dur: 12, rates: { fun: 3.2, social: 0.2 }, adv: { fun: 35 }, visitor: true, hold: 'book' },
    ],
  },
  fishtank: {
    name: 'Pecera', icon: '🐟', price: 140, hx: 0.06, hy: 0.032, mass: 4, mus: 0.45,
    build() {
      const g = new THREE.Group();
      g.add(box(0.12, 0.064, 0.07, C.woodDark, 0, 0, 0.035));
      const water = new THREE.MeshLambertMaterial({ color: '#6fc3d8', transparent: true, opacity: 0.55 });
      const tank = box(0.11, 0.056, 0.07, water, 0, 0, 0.106); tank.castShadow = false; g.add(tank);
      g.add(box(0.1, 0.05, 0.006, '#d9c27a', 0, 0, 0.074));
      const fish = [];
      for (let i = 0; i < 3; i++) { const fsh = box(0.014, 0.006, 0.008, i === 1 ? '#f1d04a' : '#f08a3c', 0, 0, 0.1); g.add(fsh); fish.push(fsh); }
      g.userData.fish = fish;
      return g;
    },
    support: () => 0.142,
    actions: [
      { id: 'fish', label: 'Mirar los peces', anim: 'stand', pose: 'watch', dur: 9, rates: { fun: 2.8 }, adv: { fun: 25 }, visitor: true },
      { id: 'feedfish', label: 'Dar de comer a los peces', anim: 'stand', pose: 'reach', dur: 3, rates: { fun: 3 }, adv: { fun: 9 } },
    ],
  },
};

/* ---------- Más objetos ---------- */
const BELT = pixTex(8, 8, (g) => { px(g, '#2a2630', 0, 0, 8, 8); px(g, '#4a4650', 0, 0, 8, 1); px(g, '#4a4650', 0, 4, 8, 1); });
const FABRIC = pixTex(8, 8, (g) => { px(g, '#5f7f9f', 0, 0, 8, 8); px(g, '#6f8faf', 0, 0, 4, 4); px(g, '#6f8faf', 4, 4, 4, 4); });
// Plano vertical mirando hacia +y local (para pantallas y lienzos)
function frontPlane(w, h, material, x, y, z) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)));
  m.position.set(x, y, z);
  return m;
}
function paintCanvas(g, w, h) {
  const pal = ['#d0574e', '#e3c26a', '#4f78b0', '#5f9a55', '#7d3f9b', '#e98fb0', '#f08a3c', '#2a2630', '#9fd3ea'];
  g.fillStyle = pick(['#f2ead8', '#e9f2f7', '#f7e6d0', '#2a2630']); g.fillRect(0, 0, w, h);
  for (let i = 0; i < 6; i++) {
    g.fillStyle = pick(pal);
    const x = Math.floor(rand(0, w - 3)), y = Math.floor(rand(0, h - 3));
    if (Math.random() < 0.5) g.fillRect(x, y, Math.floor(rand(2, w / 2)), Math.floor(rand(2, h / 2)));
    else { g.beginPath(); g.arc(x, y, rand(2, 5), 0, 7); g.fill(); }
  }
}

Object.assign(DEFS, {
  armchair: {
    name: 'Butaca', icon: '💺', price: 110, cat: 'muebles', seatable: true, hx: 0.055, hy: 0.055, mass: 3, mus: 0.3,
    build() {
      const g = new THREE.Group(), f = texMat(FABRIC, 2, 2);
      g.add(box(0.11, 0.11, 0.045, f, 0, 0, 0.03));
      g.add(box(0.08, 0.08, 0.02, '#7f9fc2', 0, 0.01, 0.062));
      g.add(box(0.11, 0.026, 0.12, f, 0, -0.042, 0.08));
      g.add(box(0.02, 0.1, 0.075, f, -0.045, 0.005, 0.06));
      g.add(box(0.02, 0.1, 0.075, f, 0.045, 0.005, 0.06));
      return g;
    },
    support: (lx, ly) => (Math.abs(lx) > 0.035 ? 0.098 : ly < -0.029 ? 0.14 : 0.072),
    seats: [{ lx: 0, ly: 0.01, h: 0.072 }],
    actions: [
      { id: 'sita', label: 'Sentarse', anim: 'sit', dur: 10, rates: { energy: 1, fun: 0.5 }, adv: { energy: 10, fun: 6 }, visitor: true, seat: 'free' },
    ],
  },
  bathtub: {
    name: 'Bañera', icon: '🛁', price: 380, cat: 'bano', hx: 0.085, hy: 0.15, mass: 10, mus: 0.6,
    build() {
      const g = new THREE.Group(), w = '#f4f1ea';
      g.add(box(0.17, 0.3, 0.02, w, 0, 0, 0.01));
      g.add(box(0.02, 0.3, 0.09, w, -0.075, 0, 0.045));
      g.add(box(0.02, 0.3, 0.09, w, 0.075, 0, 0.045));
      g.add(box(0.13, 0.02, 0.09, w, 0, -0.14, 0.045));
      g.add(box(0.13, 0.02, 0.09, w, 0, 0.14, 0.045));
      const water = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.26), new THREE.MeshLambertMaterial({ color: '#8fcfe8', transparent: true, opacity: 0.5 }));
      water.position.z = 0.068; g.add(water);
      g.add(cyl(0.006, 0.006, 0.03, C.metal, 0, -0.14, 0.1, 6));
      g.add(box(0.006, 0.02, 0.006, C.metal, 0, -0.13, 0.112));
      return g;
    },
    support: (lx, ly) => (Math.abs(lx) < 0.064 && Math.abs(ly) < 0.129 ? 0.02 : 0.092),
    actions: [
      { id: 'bath', label: 'Darse un baño', anim: 'lie', dur: 12, rates: { hygiene: 9, fun: 2.2, energy: 0.8 }, adv: { hygiene: 95, fun: 15 },
        seat: () => ({ lx: 0, ly: 0.11, h: 0.022, face: HALF_PI }), onEnd() { audio.flush(); } },
    ],
  },
  stove: {
    name: 'Cocina', icon: '🍳', price: 250, cat: 'bano', hx: 0.06, hy: 0.045, mass: 6, mus: 0.5,
    build() {
      const g = new THREE.Group();
      g.add(box(0.12, 0.09, 0.12, C.white, 0, 0, 0.06));
      g.add(box(0.12, 0.09, 0.006, '#3a3540', 0, 0, 0.123));
      const burn = new THREE.MeshLambertMaterial({ color: '#2a2226', emissive: '#ff5a1a', emissiveIntensity: 0 });
      for (const [x, y] of [[-0.028, -0.02], [0.028, -0.02], [-0.028, 0.02], [0.028, 0.02]]) g.add(cyl(0.015, 0.015, 0.003, burn, x, y, 0.127, 8));
      g.add(box(0.09, 0.004, 0.07, '#3a3540', 0, 0.046, 0.055));
      g.add(box(0.06, 0.004, 0.006, C.metal, 0, 0.049, 0.094));
      const pot = new THREE.Group();
      pot.add(cyl(0.02, 0.018, 0.025, C.metal, 0.028, 0.02, 0.142, 8));
      pot.add(box(0.03, 0.004, 0.004, '#2a2226', 0.06, 0.02, 0.152));
      pot.visible = false; g.add(pot);
      g.userData.burn = burn; g.userData.pot = pot;
      return g;
    },
    support: () => 0.13,
    actions: [
      { id: 'cook', label: 'Cocinar', cost: 10, anim: 'stand', pose: 'cook', dur: 6, adv: { hunger: 85, fun: 8 }, exclusive: true, screen: 'cook',
        onEnd(a, interrupted) {
          if (interrupted) return;
          if (Math.random() < 0.08) { a.say('¡Se ha quemado!', 1.8); a.voice('alarm'); a.addNeed('fun', -6); }
          else { a.say(pick(['¡Qué bien huele!', '¡Listo!', '¡Soy un chef!']), 1.3); a.startMeal('gourmet'); }
        } },
    ],
  },
  coffee: {
    name: 'Cafetera', icon: '☕', price: 60, cat: 'bano', hx: 0.03, hy: 0.03, mass: 1.5, mus: 0.4,
    build() {
      const g = new THREE.Group();
      g.add(box(0.06, 0.06, 0.1, C.woodDark, 0, 0, 0.05));
      g.add(box(0.036, 0.03, 0.05, '#3a3540', 0, -0.008, 0.125));
      g.add(cyl(0.011, 0.012, 0.022, '#9fd3ea', 0, 0.012, 0.111, 8));
      g.add(box(0.004, 0.004, 0.004, '#ff4d3a', 0.01, 0.008, 0.14));
      return g;
    },
    support: () => 0.15,
    actions: [
      { id: 'coffee', label: 'Tomar un café', cost: 2, anim: 'stand', pose: 'eat', dur: 4, rates: { energy: 5, bladder: -2.5, fun: 0.5 }, adv: { energy: 25 }, hold: 'mug', visitor: true, exclusive: true },
    ],
  },
  treadmill: {
    name: 'Cinta de correr', icon: '🏃', price: 300, cat: 'ocio', hx: 0.05, hy: 0.1, mass: 6, mus: 0.5,
    build() {
      const g = new THREE.Group();
      g.add(box(0.1, 0.2, 0.02, '#4a4650', 0, 0, 0.01));
      const belt = texMat(BELT, 1, 3);
      g.add(box(0.08, 0.16, 0.004, belt, 0, -0.01, 0.022));
      for (const x of [-0.045, 0.045]) g.add(box(0.006, 0.006, 0.14, C.metal, x, 0.085, 0.09));
      g.add(box(0.1, 0.025, 0.03, '#3a3540', 0, 0.09, 0.16));
      g.add(box(0.03, 0.004, 0.012, '#7fd1a8', 0, 0.077, 0.165));
      g.userData.belt = belt.map;
      return g;
    },
    support: (lx, ly) => (ly > 0.07 ? 0.18 : 0.025),
    actions: [
      { id: 'run', label: 'Correr', anim: 'stand', pose: 'run', dur: 10, rates: { fun: 2.4, energy: -1.6, hygiene: -1.4 }, adv: { fun: 28 }, exclusive: true, screen: 'run',
        spot: () => ({ lx: 0, ly: -0.02, face: HALF_PI, inside: true }) },
    ],
  },
  guitar: {
    name: 'Guitarra', icon: '🎸', price: 90, cat: 'ocio', hx: 0.026, hy: 0.026, mass: 0.8, mus: 0.3,
    build() {
      const g = new THREE.Group();
      g.add(cyl(0.02, 0.024, 0.006, C.metal, 0, 0, 0.003, 6));
      g.add(box(0.004, 0.004, 0.09, C.metal, 0, -0.01, 0.045));
      const gt = new THREE.Group();
      gt.add(box(0.045, 0.014, 0.05, '#c0703a', 0, 0, 0.035));
      gt.add(box(0.034, 0.014, 0.032, '#c0703a', 0, 0, 0.074));
      gt.add(cyl(0.008, 0.008, 0.002, '#2a2226', 0, 0.008, 0.055, 8));
      gt.add(box(0.009, 0.007, 0.08, '#5a3a22', 0, 0, 0.125));
      gt.add(box(0.014, 0.007, 0.016, '#2a2226', 0, 0, 0.172));
      gt.rotation.x = -0.2;
      g.add(gt);
      g.userData.guitar = gt;
      return g;
    },
    support: () => 0.2,
    actions: [
      { id: 'guitar', label: 'Tocar la guitarra', anim: 'stand', pose: 'guitar', dur: 11, rates: { fun: 4.2, social: 0.4 }, adv: { fun: 45 }, hold: 'guitar', exclusive: true, visitor: true, screen: 'play',
        spot: (f) => ({ lx: 0, ly: f.lhy + 0.07 }),
        tick(a, dt, act) { act.nt = (act.nt || 0) - dt; if (act.nt <= 0) { act.nt = pick([0.3, 0.3, 0.6]); audio.strum(); } } },
    ],
  },
  piano: {
    name: 'Piano', icon: '🎹', price: 450, cat: 'ocio', hx: 0.1, hy: 0.068, mass: 9, mus: 0.55,
    build() {
      const g = new THREE.Group();
      g.add(box(0.2, 0.06, 0.15, '#2a2226', 0, -0.038, 0.075));
      g.add(box(0.19, 0.03, 0.01, '#2a2226', 0, 0.002, 0.085));
      g.add(box(0.18, 0.026, 0.004, '#f4f1ea', 0, 0.004, 0.092));
      for (let i = 0; i < 7; i++) g.add(box(0.008, 0.014, 0.004, '#141010', -0.075 + i * 0.025, -0.002, 0.096));
      g.add(box(0.1, 0.034, 0.055, '#2a2226', 0, 0.05, 0.0275));
      g.add(box(0.06, 0.004, 0.04, '#f4ecd2', 0, -0.007, 0.13));
      return g;
    },
    support: (lx, ly) => (ly < -0.008 ? 0.15 : ly < 0.033 ? 0.1 : 0.056),
    actions: [
      { id: 'piano', label: 'Tocar el piano', anim: 'sit', pose: 'type', dur: 12, rates: { fun: 5, social: 0.3 }, adv: { fun: 55 }, visitor: true,
        seat: () => ({ lx: 0, ly: 0.05, h: 0.056, face: -HALF_PI }),
        tick(a, dt, act) { act.nt = (act.nt || 0) - dt; if (act.nt <= 0) { act.nt = pick([0.2, 0.2, 0.4]); audio.pianoNote(); } } },
    ],
  },
  easel: {
    name: 'Caballete', icon: '🎨', price: 120, cat: 'ocio', hx: 0.04, hy: 0.03, mass: 1, mus: 0.3,
    build() {
      const g = new THREE.Group();
      for (const x of [-0.03, 0.03]) g.add(box(0.006, 0.006, 0.2, C.wood, x, 0, 0.1));
      g.add(box(0.006, 0.006, 0.18, C.wood, 0, -0.025, 0.09));
      g.add(box(0.075, 0.012, 0.006, C.wood, 0, 0.004, 0.09));
      const c = document.createElement('canvas'); c.width = 16; c.height = 20;
      const ctx = c.getContext('2d'); paintCanvas(ctx, 16, 20);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
      g.add(box(0.07, 0.006, 0.09, '#f2ead8', 0, 0.003, 0.142));
      g.add(frontPlane(0.064, 0.084, new THREE.MeshLambertMaterial({ map: tex }), 0, 0.0065, 0.142));
      g.userData.repaint = () => { paintCanvas(ctx, 16, 20); tex.needsUpdate = true; };
      return g;
    },
    support: () => 0.2,
    actions: [
      { id: 'paint', label: 'Pintar un cuadro', anim: 'stand', pose: 'paint', dur: 14, rates: { fun: 2.6, energy: -0.3 }, adv: { fun: 30, money: 1 }, exclusive: true, hold: 'brush',
        spot: (f) => ({ lx: 0, ly: f.lhy + 0.06 }),
        onEnd(a, interrupted, f) {
          if (interrupted) return;
          f.g.userData.repaint();
          a.say('¡Obra maestra!', 1.5);
          if (a.isHost) { const v = Math.round(rand(12, 55) * (0.6 + a.mood() / 150)); earn(v); audio.cash(true); toast(`🎨 ${a.name} ha vendido un cuadro por ${v}◎`); }
        } },
    ],
  },
  arcade: {
    name: 'Recreativa', icon: '🕹️', price: 350, cat: 'ocio', hx: 0.045, hy: 0.04, mass: 6, mus: 0.5,
    build() {
      const g = new THREE.Group();
      g.add(box(0.09, 0.08, 0.2, '#5a2a7a', 0, 0, 0.1));
      g.add(box(0.092, 0.03, 0.02, '#3a3540', 0, 0.045, 0.11));
      g.add(ball(0.006, '#ff4d3a', -0.015, 0.05, 0.125, 0));
      g.add(box(0.008, 0.008, 0.004, '#e3c26a', 0.015, 0.05, 0.121));
      g.add(box(0.093, 0.082, 0.025, '#e3c26a', 0, 0, 0.21));
      g.add(box(0.004, 0.084, 0.15, '#e3c26a', -0.046, 0, 0.1));
      g.add(box(0.004, 0.084, 0.15, '#e3c26a', 0.046, 0, 0.1));
      const scr = frontPlane(0.07, 0.055, screenMat(), 0, 0.041, 0.16);
      g.add(scr);
      g.userData.screen = scr.material;
      return g;
    },
    support: () => 0.22,
    actions: [
      { id: 'arcade', label: 'Jugar a la recreativa', anim: 'stand', pose: 'type', dur: 10, rates: { fun: 6.5, social: 0.2, energy: -0.2 }, adv: { fun: 70 }, visitor: true, exclusive: true, screen: 'game',
        spot: (f) => ({ lx: 0, ly: f.lhy + 0.05 }),
        tick(a, dt, act) { act.nt = (act.nt || 0) - dt; if (act.nt <= 0) { act.nt = rand(0.12, 0.35); audio.blip(rand(300, 1400), rand(200, 1400), 0.06, 'square', 0.03); } } },
    ],
  },
  telescope: {
    name: 'Telescopio', icon: '🔭', price: 200, cat: 'ocio', hx: 0.03, hy: 0.03, mass: 1.5, mus: 0.35,
    build() {
      const g = new THREE.Group();
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2, leg = box(0.005, 0.005, 0.15, C.woodDark, Math.cos(a) * 0.02, Math.sin(a) * 0.02, 0.07);
        leg.rotation.set(-Math.sin(a) * 0.25, Math.cos(a) * 0.25, 0); g.add(leg);
      }
      const tube = new THREE.Group(); tube.position.set(0, 0, 0.15); tube.rotation.x = -0.9;
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.017, 0.12, 8), mat('#e8e2d2')); t.castShadow = true; tube.add(t);
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.012, 8), mat(C.metal)); r.position.y = 0.06; tube.add(r);
      g.add(tube);
      return g;
    },
    support: () => 0.2,
    actions: [
      { id: 'stars', label: 'Mirar las estrellas', anim: 'stand', pose: 'scope', dur: 9, rates: { fun: 3.5 }, adv: { fun: 35 }, visitor: true, exclusive: true,
        spot: (f) => ({ lx: 0, ly: -f.lhy - 0.05 }),
        onEnd(a, interrupted) { if (!interrupted && Math.random() < 0.12) { a.say('¡¡UN OVNI!!', 2); a.voice('alarm'); a.addNeed('fun', 20); } } },
    ],
  },
  wardrobe: {
    name: 'Armario', icon: '👔', price: 150, cat: 'muebles', hx: 0.08, hy: 0.04, mass: 8, mus: 0.5,
    build() {
      const g = new THREE.Group();
      g.add(box(0.16, 0.08, 0.3, '#b88452', 0, 0, 0.15));
      g.add(box(0.17, 0.085, 0.015, '#8a5a32', 0, 0, 0.305));
      g.add(box(0.003, 0.004, 0.27, '#6a4529', 0, 0.041, 0.15));
      for (const x of [-0.012, 0.012]) g.add(box(0.005, 0.006, 0.03, '#e2c14a', x, 0.043, 0.17));
      return g;
    },
    support: () => 0.31,
    actions: [
      { id: 'dress', label: 'Cambiarse de ropa', anim: 'stand', pose: 'dress', dur: 2, ui: 'wardrobe', rates: { fun: 2 }, spot: (f) => ({ lx: 0, ly: f.lhy + 0.05 }) },
    ],
  },
  sink: {
    name: 'Lavabo', icon: '🚰', price: 90, cat: 'bano', hx: 0.04, hy: 0.03, mass: 3, mus: 0.5,
    build() {
      const g = new THREE.Group(), w = '#f4f1ea';
      g.add(cyl(0.012, 0.016, 0.08, w, 0, -0.008, 0.04, 8));
      g.add(box(0.08, 0.055, 0.02, w, 0, 0, 0.09));
      g.add(box(0.06, 0.035, 0.002, '#bfe3f0', 0, 0.003, 0.101));
      g.add(box(0.006, 0.012, 0.02, C.metal, 0, -0.02, 0.108));
      g.add(box(0.07, 0.006, 0.09, '#8a5a32', 0, -0.028, 0.17));
      g.add(frontPlane(0.06, 0.08, new THREE.MeshLambertMaterial({ color: '#cfe6ef' }), 0, -0.0245, 0.17));
      return g;
    },
    support: () => 0.11,
    actions: [
      { id: 'wash', label: 'Lavarse', anim: 'stand', pose: 'wash', dur: 4, rates: { hygiene: 6 }, adv: { hygiene: 22 }, visitor: true, exclusive: true },
      { id: 'mirror', label: 'Mirarse al espejo', anim: 'stand', pose: 'watch', dur: 5, rates: { fun: 1.5, social: 1 }, adv: { social: 10 }, exclusive: true },
    ],
  },
  phone: {
    name: 'Teléfono', icon: '☎️', price: 60, cat: 'muebles', hx: 0.03, hy: 0.03, mass: 1.5, mus: 0.4,
    build() {
      const g = new THREE.Group();
      g.add(box(0.06, 0.06, 0.1, C.wood, 0, 0, 0.05));
      g.add(box(0.034, 0.028, 0.014, '#c0504a', 0, 0, 0.107));
      g.add(box(0.04, 0.009, 0.009, '#c0504a', 0, -0.006, 0.119));
      g.add(cyl(0.008, 0.008, 0.002, '#f4ecd2', 0, 0.006, 0.115, 8));
      return g;
    },
    support: () => 0.12,
    actions: [
      { id: 'pizza', label: 'Pedir una pizza', cost: 20, anim: 'stand', pose: 'phone', dur: 3, adv: { hunger: 55, fun: 10 }, exclusive: true,
        onEnd(a, interrupted) { if (!interrupted) { a.say('¡Una pizza, por favor!', 1.6); orderPizza(); } } },
      { id: 'call', label: 'Llamar a un amigo', anim: 'stand', pose: 'phone', dur: 7, rates: { social: 4, fun: 1 }, adv: { social: 45 }, exclusive: true,
        tick(a, dt, act) { act.nt = (act.nt || 0.5) - dt; if (act.nt <= 0) { act.nt = 1.6; a.say(pick(TOPICS) + ' ' + pick(['¿Sí?', '¡Ja, ja!', 'Ajá…', '¡No me digas!']), 1.2); a.voice('happy'); } },
        onEnd(a, interrupted) { if (!interrupted && Math.random() < 0.6 && !visitors().length && !visit.pending) { visit.t = rand(8, 15); a.say('¡Viene a verme!', 1.6); } } },
    ],
  },
  clock: {
    name: 'Reloj de pie', icon: '🕰️', price: 140, cat: 'deco', decor: true, hx: 0.035, hy: 0.026, mass: 5, mus: 0.5,
    build() {
      const g = new THREE.Group();
      g.add(box(0.07, 0.052, 0.3, '#7a4a2a', 0, 0, 0.15));
      g.add(box(0.05, 0.004, 0.11, '#3a2a1a', 0, 0.027, 0.13));
      const face = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.004, 12), mat('#f4ecd2'));
      face.position.set(0, 0.028, 0.25); g.add(face);
      g.add(box(0.002, 0.002, 0.016, '#141010', 0, 0.031, 0.256));
      const pend = new THREE.Group(); pend.position.set(0, 0.03, 0.18);
      pend.add(box(0.003, 0.003, 0.07, '#e2c14a', 0, 0, -0.035));
      pend.add(cyl(0.01, 0.01, 0.003, '#e2c14a', 0, 0, -0.072, 8)).children.at(-1).rotation.x = 0;
      g.add(pend);
      g.userData.pend = pend;
      return g;
    },
    support: () => 0.31,
    actions: [],
  },
  statue: {
    name: 'Estatua', icon: '🗿', price: 220, cat: 'deco', decor: true, hx: 0.035, hy: 0.035, mass: 7, mus: 0.6,
    build() {
      const g = new THREE.Group(), m = '#d8d4cc';
      g.add(box(0.07, 0.07, 0.07, '#a8a29a', 0, 0, 0.035));
      g.add(box(0.03, 0.025, 0.07, m, 0, 0, 0.105));
      g.add(ball(0.02, m, 0, 0, 0.16, 0));
      g.add(box(0.06, 0.012, 0.012, m, 0, 0, 0.13));
      return g;
    },
    support: () => 0.18,
    actions: [],
  },
  flamingo: {
    name: 'Flamenco', icon: '🦩', price: 30, cat: 'deco', decor: true, hx: 0.025, hy: 0.025, mass: 0.6, mus: 0.3,
    build() {
      const g = new THREE.Group(), p = '#f08ab0';
      g.add(box(0.003, 0.003, 0.08, '#2a2226', 0, 0, 0.04));
      g.add(ball(0.022, p, 0, 0, 0.09, 0));
      g.add(box(0.005, 0.005, 0.05, p, 0.016, 0, 0.12));
      g.add(ball(0.009, p, 0.02, 0, 0.148, 0));
      g.add(box(0.012, 0.004, 0.004, '#2a2226', 0.03, 0, 0.145));
      return g;
    },
    support: () => 0.16,
    actions: [],
  },
  lavalamp: {
    name: 'Lámpara de lava', icon: '🫧', price: 45, cat: 'deco', decor: true, hx: 0.02, hy: 0.02, mass: 0.6, mus: 0.3,
    build() {
      const g = new THREE.Group();
      g.add(cyl(0.012, 0.018, 0.02, C.metal, 0, 0, 0.01, 8));
      const lava = new THREE.MeshLambertMaterial({ color: '#ff6a9a', emissive: '#ff4a7a', emissiveIntensity: 0.8 });
      g.add(cyl(0.008, 0.013, 0.05, lava, 0, 0, 0.045, 8));
      g.add(cyl(0.004, 0.008, 0.012, C.metal, 0, 0, 0.076, 8));
      g.userData.lava = lava;
      return g;
    },
    support: () => 0.08,
    actions: [],
  },
  petbed: {
    name: 'Cama de mascota', icon: '🧺', price: 40, cat: 'mascotas', hx: 0.045, hy: 0.045, mass: 0.8, mus: 0.3,
    build() {
      const g = new THREE.Group();
      g.add(cyl(0.045, 0.048, 0.02, '#c0504a', 0, 0, 0.01, 10));
      g.add(cyl(0.035, 0.035, 0.006, '#f4e6d6', 0, 0, 0.021, 10));
      return g;
    },
    support: () => 0.024,
    actions: [],
  },
  bowl: {
    name: 'Comedero', icon: '🥣', price: 25, cat: 'mascotas', hx: 0.02, hy: 0.02, mass: 0.4, mus: 0.3,
    build() {
      const g = new THREE.Group();
      g.add(cyl(0.02, 0.016, 0.012, '#4f78b0', 0, 0, 0.006, 8));
      const food = cyl(0.015, 0.015, 0.004, '#9a6a3a', 0, 0, 0.012, 8);
      g.add(food);
      g.userData.food = food;
      return g;
    },
    support: () => 0.012,
    actions: [
      { id: 'fill', label: 'Llenar el comedero', cost: 3, anim: 'stand', pose: 'reach', dur: 1.5,
        onEnd(a, interrupted, f) { if (!interrupted) { f.food = 4; a.say('¡A comer!', 1.2); for (const p of pets) if (p.hunger < 70) p.callToEat(f); } } },
    ],
  },
  scratcher: {
    name: 'Rascador', icon: '🐾', price: 60, cat: 'mascotas', hx: 0.035, hy: 0.035, mass: 1.5, mus: 0.4,
    build() {
      const g = new THREE.Group();
      g.add(box(0.07, 0.07, 0.012, '#e8dcc0', 0, 0, 0.006));
      g.add(cyl(0.012, 0.012, 0.12, '#c9a27e', 0, 0, 0.07, 8));
      g.add(box(0.06, 0.06, 0.012, '#e8dcc0', 0, 0, 0.135));
      g.add(ball(0.008, '#e3c26a', 0.02, 0.02, 0.12, 0));
      return g;
    },
    support: (lx, ly) => (Math.abs(lx) < 0.03 && Math.abs(ly) < 0.03 ? 0.141 : 0.012),
    actions: [],
  },
});

// Categorías de la tienda
for (const k of ['sofa', 'chair', 'table', 'bed', 'books', 'desk', 'lamp']) DEFS[k].cat = 'muebles';
for (const k of ['tv', 'stereo', 'ball', 'fishtank']) DEFS[k].cat = 'ocio';
for (const k of ['fridge', 'toilet', 'shower']) DEFS[k].cat = 'bano';
DEFS.plant.cat = 'deco'; DEFS.plant.decor = true;
DEFS.sofa.seatable = true; DEFS.chair.seatable = true;
DEFS.fishtank.decor = true;
const SHOP_CATS = [
  { id: 'muebles', label: 'Casa' },
  { id: 'ocio', label: 'Ocio' },
  { id: 'bano', label: 'Cocina/baño' },
  { id: 'deco', label: 'Deco' },
  { id: 'mascotas', label: 'Mascotas' },
  { id: 'ropa', label: 'Ropa' },
];
/* ---------- Objetos de la fábrica de clips y de lujo ---------- */
function clipPile(g, x, y, z, n = 10) {
  const pile = new THREE.Group();
  pile.position.set(x, y, z);
  for (let i = 0; i < n; i++) {
    const c = box(0.012, 0.004, 0.0025, '#c9ced6', rand(-0.012, 0.012), rand(-0.01, 0.01), i * 0.0018);
    c.rotation.z = rand(0, 3);
    c.castShadow = false;
    pile.add(c);
  }
  g.add(pile);
  return pile;
}
const steel = '#8a95a3', hazard = '#e3c26a';

Object.assign(DEFS, {
  clipbench: {
    name: 'Mesa de clips', icon: '📎', price: 60, cat: 'clips', hx: 0.07, hy: 0.045, mass: 4, mus: 0.45,
    build() {
      const g = new THREE.Group();
      g.add(box(0.14, 0.09, 0.012, C.wood, 0, 0, 0.1));
      for (const [x, y] of [[-0.062, -0.037], [0.062, -0.037], [-0.062, 0.037], [0.062, 0.037]]) g.add(box(0.01, 0.01, 0.095, C.woodDark, x, y, 0.047));
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.006, 5, 10), mat(steel)); coil.position.set(-0.04, -0.012, 0.112); g.add(coil);
      g.add(box(0.03, 0.006, 0.004, '#c0504a', 0.01, -0.02, 0.108));
      g.add(box(0.012, 0.004, 0.004, C.metal, 0.03, -0.018, 0.108));
      g.userData.pile = clipPile(g, 0.035, 0.012, 0.108, 12);
      return g;
    },
    support: () => 0.11,
    actions: [
      { id: 'clips', label: 'Hacer clips', anim: 'stand', pose: 'type', dur: 15, rates: { fun: -0.8, energy: -0.5 }, adv: { money: 1 }, exclusive: true,
        refuse: (a) => (a.needs && (a.mood() < 18 || a.needs.energy < 8) ? pick(['Ahora no puedo ni doblar un clip…', 'Estoy muy cansado…', '¡Hoy no!']) : null),
        tick(a, dt) { if (a.isHost) manualClips(dt); } },
    ],
  },
  clipper: {
    name: 'Máquina de clips', icon: '⚙️', price: 120, cat: 'clips', unlockAt: 100, clipRate: 3, noise: 1, hx: 0.045, hy: 0.045, mass: 4, mus: 0.45,
    build() {
      const g = new THREE.Group();
      g.add(box(0.09, 0.09, 0.06, '#6b7a8a', 0, 0, 0.03));
      g.add(box(0.06, 0.06, 0.05, '#7d8c9c', 0, -0.01, 0.085));
      g.add(box(0.092, 0.01, 0.012, hazard, 0, 0.041, 0.05));
      const pist = new THREE.Group(); pist.position.set(0, -0.01, 0.11); g.add(pist);
      pist.add(cyl(0.008, 0.008, 0.04, steel, 0, 0, 0.02, 8));
      g.add(box(0.04, 0.03, 0.006, '#4a4650', 0, 0.035, 0.064));
      g.userData.piston = pist;
      g.userData.pile = clipPile(g, 0, 0.035, 0.068, 8);
      g.userData.lamp = new THREE.MeshBasicMaterial({ color: '#5fd35f' });
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), g.userData.lamp); l.position.set(0.022, -0.03, 0.115); g.add(l);
      return g;
    },
    support: () => 0.13,
    actions: [{ id: 'fix', label: 'Revisar la máquina', anim: 'stand', pose: 'wash', dur: 3, rates: { energy: -0.5 }, onEnd(a, int, f) { if (!int) { f.jam = false; a.say('¡Arreglada!', 1.2); } } }],
  },
  industrial: {
    name: 'Máquina industrial', icon: '🏭', price: 1500, cat: 'clips', unlockAt: 25000, clipRate: 25, noise: 3, hx: 0.085, hy: 0.06, mass: 12, mus: 0.6,
    build() {
      const g = new THREE.Group();
      g.add(box(0.17, 0.12, 0.08, '#5a6a7a', 0, 0, 0.04));
      g.add(box(0.06, 0.08, 0.08, '#6b7a8a', -0.05, -0.01, 0.12));
      const belt = texMat(BELT, 3, 1);
      g.add(box(0.11, 0.035, 0.006, belt, 0.025, 0.035, 0.083));
      g.userData.belt = belt.map;
      const pist = new THREE.Group(); pist.position.set(0.03, 0.035, 0.13); g.add(pist);
      pist.add(box(0.03, 0.025, 0.04, steel, 0, 0, 0));
      g.userData.piston = pist;
      g.add(cyl(0.012, 0.014, 0.08, '#4a4650', -0.06, -0.035, 0.2, 8));
      g.add(box(0.172, 0.012, 0.012, hazard, 0, 0.057, 0.06));
      g.userData.pile = clipPile(g, 0.07, 0.035, 0.085, 14);
      g.userData.lamp = new THREE.MeshBasicMaterial({ color: '#5fd35f' });
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.012), g.userData.lamp); l.position.set(-0.03, 0.03, 0.165); g.add(l);
      return g;
    },
    support: () => 0.16,
    actions: [{ id: 'fix', label: 'Revisar la máquina', anim: 'stand', pose: 'wash', dur: 4, rates: { energy: -0.6 }, onEnd(a, int, f) { if (!int) { f.jam = false; a.say('¡Arreglada!', 1.2); } } }],
  },
  robot: {
    name: 'Robot clipero', icon: '🤖', price: 20000, cat: 'clips', unlockAt: 500000, clipRate: 160, noise: 4, hx: 0.06, hy: 0.06, mass: 10, mus: 0.6,
    build() {
      const g = new THREE.Group();
      g.add(cyl(0.05, 0.055, 0.03, '#3a3540', 0, 0, 0.015, 10));
      const arm = new THREE.Group(); arm.position.set(0, 0, 0.03); g.add(arm);
      arm.add(cyl(0.022, 0.026, 0.03, hazard, 0, 0, 0.015, 8));
      const up = new THREE.Group(); up.position.set(0, 0, 0.03); arm.add(up);
      up.add(box(0.016, 0.016, 0.1, '#e8e2d2', 0, 0, 0.05));
      const fore = new THREE.Group(); fore.position.set(0, 0, 0.1); up.add(fore);
      fore.add(box(0.07, 0.014, 0.014, '#e8e2d2', 0.035, 0, 0));
      fore.add(box(0.012, 0.02, 0.02, '#c0504a', 0.072, 0, -0.008));
      g.userData.arm = arm; g.userData.up = up; g.userData.fore = fore;
      g.userData.pile = clipPile(g, 0.0, 0.045, 0.03, 14);
      g.userData.lamp = new THREE.MeshBasicMaterial({ color: '#5fd35f' });
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.012), g.userData.lamp); l.position.set(0, -0.04, 0.034); g.add(l);
      return g;
    },
    support: () => 0.06,
    actions: [{ id: 'fix', label: 'Revisar el robot', anim: 'stand', pose: 'wash', dur: 4, rates: { energy: -0.6 }, onEnd(a, int, f) { if (!int) { f.jam = false; a.say('¡Arreglado!', 1.2); } } }],
  },
  luxbed: {
    name: 'Cama de lujo', icon: '👑', price: 3000, cat: 'lujo', hx: 0.12, hy: 0.18, mass: 12, mus: 0.6,
    build() {
      const g = new THREE.Group();
      g.add(box(0.24, 0.36, 0.05, '#e2c14a', 0, 0, 0.035));
      g.add(box(0.22, 0.33, 0.035, '#fbf8f2', 0, 0.005, 0.075));
      g.add(box(0.23, 0.2, 0.04, '#7d3f9b', 0, 0.07, 0.082));
      for (const x of [-0.05, 0.05]) g.add(box(0.08, 0.05, 0.03, '#fbf8f2', x, -0.13, 0.1));
      g.add(box(0.24, 0.025, 0.17, '#e2c14a', 0, -0.17, 0.085));
      for (const x of [-0.11, 0.11]) g.add(ball(0.014, '#e2c14a', x, -0.17, 0.18, 0));
      return g;
    },
    support: (lx, ly) => (ly < -0.155 ? 0.17 : 0.1),
    actions: [
      { id: 'sleep', label: 'Dormir a lo grande', anim: 'lie', dur: 60, rates: { energy: 8, fun: 0.8 }, adv: { energy: 110 },
        seat: () => ({ lx: 0, ly: 0.13, h: 0.096, face: HALF_PI }), until: (a) => a.needs && a.needs.energy >= 99.5 && a.act.t > 4 },
    ],
  },
  jacuzzi: {
    name: 'Jacuzzi', icon: '🫧', price: 4500, cat: 'lujo', hx: 0.1, hy: 0.1, mass: 14, mus: 0.7,
    build() {
      const g = new THREE.Group();
      g.add(cyl(0.1, 0.1, 0.02, '#e8e2d2', 0, 0, 0.01, 12));
      for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; const b = box(0.05, 0.016, 0.08, '#e8e2d2', Math.cos(a) * 0.092, Math.sin(a) * 0.092, 0.04); b.rotation.z = a + HALF_PI; g.add(b); }
      const water = new THREE.Mesh(new THREE.CircleGeometry(0.086, 12), new THREE.MeshLambertMaterial({ color: '#6fd0e8', transparent: true, opacity: 0.55, emissive: '#2a8ab0', emissiveIntensity: 0.3 }));
      water.position.z = 0.062; g.add(water);
      const bub = new THREE.Group(); g.add(bub);
      for (let i = 0; i < 10; i++) bub.add(ball(0.006, '#ffffff', rand(-0.06, 0.06), rand(-0.06, 0.06), 0.064, 0));
      g.userData.bubbles = bub;
      return g;
    },
    support: (lx, ly) => (Math.hypot(lx, ly) < 0.078 ? 0.02 : 0.085),
    actions: [
      { id: 'jacuzzi', label: 'Darse un jacuzzi', anim: 'lie', dur: 14, rates: { hygiene: 8, fun: 5, energy: 2.5 }, adv: { hygiene: 70, fun: 70, energy: 20 }, visitor: true,
        seat: () => ({ lx: 0, ly: 0.07, h: 0.024, face: HALF_PI }) },
    ],
  },
  massage: {
    name: 'Sillón de masaje', icon: '💆', price: 2500, cat: 'lujo', seatable: true, hx: 0.06, hy: 0.06, mass: 6, mus: 0.5,
    build() {
      const g = new THREE.Group(), c = '#3a2a2a';
      g.add(box(0.12, 0.12, 0.05, c, 0, 0, 0.035));
      g.add(box(0.09, 0.09, 0.02, '#5a3a3a', 0, 0.01, 0.07));
      g.add(box(0.12, 0.03, 0.15, c, 0, -0.045, 0.1));
      for (const x of [-0.05, 0.05]) g.add(box(0.02, 0.11, 0.08, c, x, 0.005, 0.065));
      g.add(box(0.03, 0.02, 0.012, '#7fd1a8', 0.05, 0.03, 0.108));
      return g;
    },
    support: (lx, ly) => (Math.abs(lx) > 0.04 ? 0.105 : ly < -0.03 ? 0.175 : 0.08),
    seats: [{ lx: 0, ly: 0.01, h: 0.08 }],
    actions: [
      { id: 'massage', label: 'Darse un masaje', anim: 'sit', dur: 12, rates: { energy: 3.2, fun: 3.2 }, adv: { energy: 40, fun: 40 }, visitor: true, seat: 'free', screen: 'massage' },
    ],
  },
});
DEFS.armchair.cat = 'muebles';
SHOP_CATS.splice(4, 0, { id: 'lujo', label: 'Lujo' }, { id: 'clips', label: 'Clips' });


const ESSENTIAL = new Set(['fridge', 'bed', 'toilet']);

const furn = [];
function addFurn(type, x, y, rot = 0) {
  const def = DEFS[type];
  const g = def.build();
  const f = {
    type, def, g, x, y, vx: 0, vy: 0, rot, visRot: rot, lhx: def.hx, lhy: def.hy, hx: def.hx, hy: def.hy,
    mass: def.mass, mus: def.mus, support: def.support, drag: null, dx: 0, dy: 0, wob: 0, thudT: 0, on: false,
    seats: (def.seats || []).map((s) => ({ ...s, by: null })), busy: null, use: null, useT: 0, spawn: 0,
  };
  g.traverse((o) => { o.userData.furn = f; });
  g.position.set(x, y, 0);
  g.rotation.z = rot;
  updateExtents(f);
  scene.add(g);
  furn.push(f);
  return f;
}
function removeFurn(f) {
  const i = furn.indexOf(f);
  if (i >= 0) furn.splice(i, 1);
  scene.remove(f.g);
  for (const a of agents) {
    if (a.on === f) a.on = null;
    if (a.act && a.act.f === f) a.endAct(true);
  }
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
function isFree(x, y, r, ignore = null) {
  if (Math.abs(x) > W / 2 - r || Math.abs(y) > H / 2 - r) return false;
  for (const f of furn) {
    if (f === ignore || f.type === 'shower' || f.type === 'ball') continue;
    if (Math.abs(x - f.x) < f.hx + r && Math.abs(y - f.y) < f.hy + r) return false;
  }
  return true;
}
function findSpotFor(type) {
  // Busca un hueco libre (mejor junto a una pared), con el frontal mirando al centro de la habitación
  const def = DEFS[type];
  let best = null, bestScore = -1e9;
  for (let i = 0; i < 500; i++) {
    const wallSide = Math.floor(rand(0, 5));
    let rot = 0, hx = def.hx, hy = def.hy, x, y;
    const side = (r) => { rot = r; const odd = Math.abs(Math.round(r / HALF_PI)) % 2 === 1; hx = odd ? def.hy : def.hx; hy = odd ? def.hx : def.hy; };
    if (wallSide === 0) { side(0); x = rand(-W / 2 + hx, W / 2 - hx); y = -H / 2 + hy + 0.005; }
    else if (wallSide === 1) { side(Math.PI); x = rand(-W / 2 + hx, W / 2 - hx); y = H / 2 - hy - 0.005; }
    else if (wallSide === 2) { side(-HALF_PI); x = -W / 2 + hx + 0.005; y = rand(-H / 2 + hy, H / 2 - hy); }
    else if (wallSide === 3) { side(HALF_PI); x = W / 2 - hx - 0.005; y = rand(-H / 2 + hy, H / 2 - hy); }
    else { x = rand(-W / 2 + 0.1, W / 2 - 0.1); y = rand(-H / 2 + 0.1, H / 2 - 0.1); side(Math.round(wrap(Math.atan2(-y, -x) - HALF_PI) / HALF_PI) * HALF_PI); x = clamp(x, -W / 2 + hx, W / 2 - hx); y = clamp(y, -H / 2 + hy, H / 2 - hy); }
    let ok = true;
    for (const f of furn) if (Math.abs(x - f.x) < f.hx + hx + 0.03 && Math.abs(y - f.y) < f.hy + hy + 0.03) { ok = false; break; }
    if (ok && Math.abs(x - door.x) < hx + 0.1 && y + hy > H / 2 - 0.26) ok = false;
    // Delante tiene que quedar sitio para usarlo
    const fx = x - Math.sin(rot) * (hy + 0.06), fy = y + Math.cos(rot) * (hy + 0.06);
    if (ok && !isFree(fx, fy, H_R)) ok = false;
    if (!ok) continue;
    const score = (wallSide < 4 ? 1 : 0) + rand(0, 0.5);
    if (score > bestScore) { bestScore = score; best = { x, y, rot }; }
    if (i > 120 && best) break;
  }
  return best;
}
const facingOf = (f) => f.rot + HALF_PI; // dirección hacia la que "mira" el frontal del objeto

function defaultLayout() {
  addFurn('fridge', -W / 2 + 0.058, H / 2 - 0.05, Math.PI);
  addFurn('shower', W / 2 - 0.068, H / 2 - 0.068);
  addFurn('toilet', W / 2 - 0.05, H / 2 - 0.24, HALF_PI);
  addFurn('table', -W * 0.18, H * 0.16);
  addFurn('chair', -W * 0.18, H * 0.16 - 0.12, 0);
  addFurn('desk', W / 2 - 0.078, H * 0.02, HALF_PI);
  addFurn('bed', -W / 2 + 0.102, -H / 2 + 0.172);
  addFurn('lamp', -W / 2 + 0.24, -H / 2 + 0.04);
  addFurn('plant', W / 2 - 0.045, -H / 2 + 0.045);
  addFurn('wardrobe', W * 0.08, -H / 2 + 0.042);
  addFurn('clipbench', -W / 2 + 0.047, -H * 0.1, -HALF_PI);
}

function setLamp(f, on) {
  f.on = on;
  audio.click();
}


/* ---------- Apariencia: cara, peinados y altura ---------- */
const HEIGHTS = { small: 0.88, normal: 1, tall: 1.1 };
const LOOKS = {
  hairStyle: [['short', 'Corto'], ['long', 'Largo'], ['bun', 'Moño'], ['ponytail', 'Coleta'], ['pigtails', 'Coletas'], ['curly', 'Rizado'], ['afro', 'Afro'], ['spiky', 'De punta'], ['mohawk', 'Cresta'], ['flat', 'Cepillo'], ['bald', 'Rapado']],
  eyes: [['dot', 'Puntitos'], ['big', 'Grandes'], ['round', 'Redondos'], ['sleepy', 'Dormilones'], ['lashes', 'Pestañas'], ['happy', 'Felices'], ['wink', 'Guiño']],
  brows: [['none', 'Sin cejas'], ['thin', 'Finas'], ['thick', 'Pobladas'], ['angry', 'Enfadadas'], ['raised', 'Sorprendidas']],
  nose: [['none', 'Sin nariz'], ['button', 'Botón'], ['round', 'Redonda'], ['big', 'Grande'], ['long', 'Larga']],
  mouth: [['smile', 'Sonrisa'], ['grin', 'Sonrisa amplia'], ['line', 'Seria'], ['open', 'Abierta'], ['pout', 'Morritos'], ['none', 'Sin boca']],
  facial: [['none', 'Nada'], ['mustache', 'Bigote'], ['goatee', 'Perilla'], ['beard', 'Barba'], ['stubble', 'Barba de 3 días']],
  cheeks: [['none', 'Nada'], ['blush', 'Colorete'], ['freckles', 'Pecas'], ['both', 'Las dos']],
  height: [['small', 'Bajito'], ['normal', 'Normal'], ['tall', 'Alto']],
};
const EYE_COLORS = ['#1e1a1a', '#5a3a22', '#2f6fb0', '#3f8f5f', '#7a7a8a', '#8a4fb0', '#b08a2a'];

function buildFace(head, p, skin, hair) {
  const R = 0.043, CY = 0.04;
  const fz = (x, y) => Math.sqrt(Math.max(0, R * R - x * x - (y - CY) * (y - CY)));
  const add = (w, h, d, m, x, y, dz = 0.002, rotZ = 0) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof m === 'string' ? mat(m) : m);
    o.position.set(x, y, fz(x, y) + dz); o.rotation.z = rotZ; head.add(o); return o;
  };
  const eyeC = p.eyeColor || '#1e1a1a', white = '#fbf8f2', dark = '#1e1a1a';
  const eyes = p.eyes || 'dot';
  for (const s of [-1, 1]) {
    const x = s * 0.016, y = 0.047;
    if (eyes === 'dot' || (eyes === 'wink' && s === -1)) add(0.009, 0.012, 0.006, eyeC, x, y);
    else if (eyes === 'wink') add(0.012, 0.003, 0.004, dark, x, y);
    else if (eyes === 'big') { add(0.017, 0.018, 0.004, white, x, y); add(0.009, 0.012, 0.004, eyeC, x + s * 0.001, y - 0.001, 0.004); }
    else if (eyes === 'round') {
      const w = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6), mat(white)); w.position.set(x, y, fz(x, y) - 0.002); head.add(w);
      add(0.007, 0.008, 0.004, eyeC, x, y, 0.006);
    } else if (eyes === 'sleepy') { add(0.015, 0.008, 0.004, white, x, y - 0.002); add(0.007, 0.005, 0.004, eyeC, x, y - 0.003, 0.004); add(0.018, 0.006, 0.005, skin, x, y + 0.003, 0.004); }
    else if (eyes === 'lashes') { add(0.009, 0.012, 0.006, eyeC, x, y); add(0.007, 0.002, 0.004, dark, x + s * 0.007, y + 0.007, 0.002, s * 0.6); add(0.006, 0.002, 0.004, dark, x + s * 0.009, y + 0.004, 0.002, s * 0.2); }
    else if (eyes === 'happy') { add(0.008, 0.003, 0.004, dark, x - 0.003, y, 0.002, 0.7); add(0.008, 0.003, 0.004, dark, x + 0.003, y, 0.002, -0.7); }
  }
  const brows = p.brows || 'thin';
  if (brows !== 'none') for (const s of [-1, 1]) {
    const x = s * 0.016;
    if (brows === 'thin') add(0.015, 0.003, 0.004, hair, x, 0.062);
    if (brows === 'thick') add(0.018, 0.006, 0.005, hair, x, 0.063);
    if (brows === 'angry') add(0.017, 0.005, 0.005, hair, x, 0.061, 0.002, s * -0.4);
    if (brows === 'raised') add(0.015, 0.004, 0.004, hair, x, 0.068, 0.002, s * 0.25);
  }
  const nose = p.nose || 'button';
  const noseMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(p.skin || '#f2d2b6').multiplyScalar(0.85), flatShading: true });
  if (nose === 'button') add(0.008, 0.008, 0.008, noseMat, 0, 0.035, 0.002);
  if (nose === 'big') add(0.015, 0.017, 0.014, noseMat, 0, 0.035, 0.004);
  if (nose === 'long') add(0.008, 0.009, 0.026, noseMat, 0, 0.037, 0.01);
  if (nose === 'round') { const n = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6), mat('#e8907a')); n.position.set(0, 0.035, fz(0, 0.035) + 0.003); head.add(n); }
  const mouth = p.mouth || 'smile', lip = '#8a2f2f';
  if (mouth === 'smile') { add(0.01, 0.003, 0.004, lip, 0, 0.021); add(0.005, 0.003, 0.004, lip, -0.007, 0.023, 0.001, -0.5); add(0.005, 0.003, 0.004, lip, 0.007, 0.023, 0.001, 0.5); }
  if (mouth === 'grin') { add(0.024, 0.009, 0.004, lip, 0, 0.022); add(0.02, 0.004, 0.004, white, 0, 0.024, 0.002); }
  if (mouth === 'line') add(0.014, 0.003, 0.004, lip, 0, 0.022);
  if (mouth === 'open') add(0.011, 0.011, 0.004, '#4a1a1a', 0, 0.021);
  if (mouth === 'pout') { const m = new THREE.Mesh(new THREE.SphereGeometry(0.006, 6, 5), mat('#d0607a')); m.position.set(0, 0.022, fz(0, 0.022) + 0.001); head.add(m); }
  const facial = p.facial || 'none';
  if (facial === 'mustache') { add(0.012, 0.005, 0.006, hair, -0.007, 0.028, 0.003, 0.25); add(0.012, 0.005, 0.006, hair, 0.007, 0.028, 0.003, -0.25); }
  if (facial === 'goatee') add(0.014, 0.016, 0.008, hair, 0, 0.008, 0.001);
  if (facial === 'beard') {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.03, 0.04), mat(p.hair || '#5a3a22')); b.position.set(0, 0.012, 0.016); head.add(b);
    add(0.024, 0.005, 0.006, hair, 0, 0.028, 0.003);
  }
  if (facial === 'stubble') {
    const st = new THREE.MeshLambertMaterial({ color: p.hair || '#5a3a22', transparent: true, opacity: 0.35 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.066, 0.026, 0.036), st); b.position.set(0, 0.014, 0.018); head.add(b);
  }
  const cheeks = p.cheeks || 'none';
  for (const s of [-1, 1]) {
    if (cheeks === 'blush' || cheeks === 'both') add(0.011, 0.006, 0.003, '#ec8f98', s * 0.026, 0.032);
    if (cheeks === 'freckles' || cheeks === 'both') for (const [dx, dy] of [[0, 0], [0.006, 0.004], [0.009, -0.003]]) add(0.003, 0.003, 0.003, '#a8643a', s * (0.019 + dx), 0.038 + dy, 0.0025);
  }
}

function buildHairExtras(head, p, hair, hat) {
  const h = p.hairStyle;
  const sph = (r, x, y, z) => { const o = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), hair); o.position.set(x, y, z); o.castShadow = true; head.add(o); return o; };
  if (h === 'afro') sph(0.064, 0, 0.058, -0.012).scale.set(1, 0.85, 1);
  if (h === 'curly') for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; sph(0.016, Math.cos(a) * 0.036, 0.075 + Math.sin(i * 1.7) * 0.006, Math.sin(a) * 0.032 - 0.008); }
  if (h === 'pigtails') for (const s of [-1, 1]) { sph(0.018, s * 0.052, 0.04, -0.015); sph(0.012, s * 0.058, 0.018, -0.018); }
  if (h === 'ponytail') { const t = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.055, 0.02), hair); t.position.set(0, 0.035, -0.055); t.rotation.x = 0.35; head.add(t); sph(0.014, 0, 0.07, -0.044); }
  if (h === 'spiky' && !hat) for (let i = 0; i < 6; i++) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.011, 0.03, 4), hair);
    const a = (i / 6) * Math.PI * 2; c.position.set(Math.cos(a) * 0.022, 0.092, Math.sin(a) * 0.02 - 0.006); c.rotation.set(Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4); head.add(c);
  }
  if (h === 'mohawk' && !hat) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.035, 0.085), hair); m.position.set(0, 0.088, -0.006); head.add(m); }
}

/* ---------- Vista previa en primer plano ---------- */
const preview = { renderer: null, scene: null, cam: null, rig: null, t: 0 };
function refreshPreview() {
  const cv = $('preview');
  if (!cv) return;
  if (!preview.renderer) {
    preview.renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: false });
    preview.renderer.setPixelRatio(1);
    preview.renderer.setSize(96, 96, false);
    preview.renderer.outputColorSpace = THREE.SRGBColorSpace;
    preview.scene = new THREE.Scene();
    preview.scene.background = new THREE.Color('#2a3d66');
    const hemi = new THREE.HemisphereLight('#fff6e8', '#5a4a6a', 1.6); hemi.position.set(0, 0, 1); preview.scene.add(hemi);
    const dl = new THREE.DirectionalLight('#ffffff', 1.6); dl.position.set(0.4, -1, 0.8); preview.scene.add(dl);
    preview.cam = new THREE.PerspectiveCamera(30, 1, 0.01, 5);
    preview.cam.up.set(0, 0, 1);
  }
  if (preview.rig) preview.scene.remove(preview.rig.root);
  const tmp = { p: { ...host.p } };
  Agent.prototype.buildRig.call(tmp);
  scene.remove(tmp.rig.root);
  preview.rig = tmp.rig;
  const r = tmp.rig;
  r.body.rotation.x = HALF_PI;
  r.pelvis.position.y = 0.104;
  r.shL.rotation.z = 0.12; r.shR.rotation.z = -0.12;
  preview.scene.add(r.root);
}
function renderPreview(dt) {
  if (!preview.rig) return;
  preview.t += dt;
  const sc = preview.rig.body.scale.x;
  const zf = 0.27 * sc;
  preview.rig.heading.rotation.z = Math.sin(preview.t * 0.8) * 0.5;
  preview.cam.position.set(0, -0.32, zf + 0.03);
  preview.cam.lookAt(0, 0, zf - 0.015);
  preview.renderer.render(preview.scene, preview.cam);
}

/* =====================================================================
 *  Humanos (el tuyo y las visitas)
 * ===================================================================== */
const NEED_KEYS = ['hunger', 'energy', 'fun', 'hygiene', 'bladder', 'social'];
const NEED_INFO = {
  hunger: { label: 'Hambre', icon: '🍗', decay: 0.06, low: ['Tengo hambre…', '¿Hay algo de comer?', 'Mi barriga ruge'] },
  energy: { label: 'Energía', icon: '⚡', decay: 0.045, low: ['Qué sueño…', 'Uaaah…', 'Necesito dormir'] },
  fun: { label: 'Diversión', icon: '🎈', decay: 0.065, low: ['Me aburro…', 'Qué aburrimiento', 'Quiero jugar'] },
  hygiene: { label: 'Higiene', icon: '🧼', decay: 0.035, low: ['Huelo un poco…', 'Necesito una ducha', 'Puaj'] },
  bladder: { label: 'Vejiga', icon: '🚽', decay: 0.075, low: ['¡Tengo que ir al baño!', '¡Me hago pis!', 'Baño, baño…'] },
  social: { label: 'Social', icon: '💬', decay: 0.05, low: ['Me siento solo…', '¿Hablamos?', 'Echo de menos a alguien'] },
};
const MOOD_W = { hunger: 1.3, energy: 1.1, fun: 1, hygiene: 0.8, bladder: 0.9, social: 0.8 };
const TOPICS = ['☀️', '🍕', '⚽', '🎵', '❤️', '😂', '🐱', '💰', '📺', '🌧️', '🚗', '🎂', '👽', '🌮', '💼', '🏖️'];

const UPRIGHT = new Set(['idle', 'walk', 'wave', 'help', 'reach', 'dizzy', 'look', 'shame', 'door']);
const POSE_KEYS = ['bodyRot', 'pelvisY', 'torso', 'hipL', 'hipR', 'kneeL', 'kneeR', 'spread', 'armL', 'armR', 'raiseL', 'raiseR', 'yaw', 'pitch', 'lift'];
const standPose = () => ({ bodyRot: HALF_PI, pelvisY: 0.104, torso: 0, hipL: 0, hipR: 0, kneeL: 0, kneeR: 0, spread: 0, armL: 0, armR: 0, raiseL: 0.12, raiseR: 0.12, yaw: 0, pitch: 0, lift: 0 });

const agents = [];
let host = null;
let money = 150;
const grab = { agent: null, x: 0, y: 0, vx: 0, vy: 0, id: null };
const finger = { follow: false, x: 0, y: 0, id: null };
const liftZ = () => Math.min(D - HUMAN_H - 0.04, 0.45);
const urgency = (v) => ((100 - v) / 100) ** 2 * 1.7 + (v < 25 ? 0.5 : 0);

const MEAL = { id: 'meal', label: 'Comer', anim: 'sit', pose: 'eat', dur: 8, rates: { hunger: 8.5, fun: 0.4 }, hold: 'plate' };
const MEAL_STAND = { id: 'meal', label: 'Comer', anim: 'stand', pose: 'eat', dur: 8, rates: { hunger: 8, fun: 0.2 }, hold: 'plate' };
const MEALS = {
  plate: { sit: MEAL, stand: MEAL_STAND },
  gourmet: { sit: { ...MEAL, rates: { hunger: 11, fun: 1.5 } }, stand: { ...MEAL_STAND, rates: { hunger: 10.5, fun: 1.2 } } },
  pizza: { sit: { ...MEAL, dur: 9, rates: { hunger: 10, fun: 2 }, hold: 'pizza' }, stand: { ...MEAL_STAND, dur: 9, rates: { hunger: 9.5, fun: 1.8 }, hold: 'pizza' } },
};
const TALK = { id: 'talk', label: 'Charlar', anim: 'stand', pose: 'talk', dur: 10, rates: { social: 6.5, fun: 1.5 } };
const FAINT = { id: 'faint', label: 'Dormir', anim: 'lie', dur: 40, rates: { energy: 3 }, until: (a) => a.needs && a.needs.energy >= 70 };
const SOCIAL_OK = new Set(['sitc', 'sits', 'watch', 'read', 'fish']);

function capsule(r, len, m) { const c = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 2, 6), m); c.castShadow = true; return c; }

class Agent {
  constructor(profile, isHost) {
    this.p = profile; this.isHost = isHost; this.name = profile.name;
    this.x = 0; this.y = 0; this.z = 0; this.vx = 0; this.vy = 0; this.vz = 0;
    this.facing = -HALF_PI; this.targetFacing = -HALF_PI; this.spin = 0;
    this.state = 'idle'; this.st = 0; this.dur = 1; this.target = null; this.on = null; this.walkPhase = 0; this.pokes = 0;
    this.look = null; this.lookT = 0; this.still = 0; this.fallT = 2; this.hard = false; this.thrown = false; this.flag = 0;
    this.stuckT = 0; this.avoid = 0; this.avoidSign = 1; this.lastPos = { x: 0, y: 0 }; this.vis = { x: 0, y: 0, z: 0 }; this.visFacing = -HALF_PI;
    this.act = null; this.holding = null; this.nextWalk = null; this.userCmd = false; this.move = null; this.complainT = rand(6, 12);
    this.needs = isHost ? { hunger: 70, energy: 80, fun: 60, hygiene: 75, bladder: 65, social: 50 } : null;
    this.pose = standPose();
    this.buildRig();
    this.bubbleEl = document.createElement('div');
    this.bubbleEl.className = 'bubble';
    document.body.appendChild(this.bubbleEl);
    this.bubbleT = 0;
    agents.push(this);
  }

  buildRig() {
    const p = this.p, r = (this.rig = {});
    const skin = mat(p.skin), shirt = mat(p.shirt), pants = mat(p.pants), hair = mat(p.hair), shoe = mat('#2a2420');
    const top = p.top || 'tee', acc = p.acc || 'none', accM = mat(p.accColor || '#c0504a');
    const armMat = top === 'tank' ? skin : shirt;
    r.root = new THREE.Group(); r.lean = new THREE.Group(); r.heading = new THREE.Group(); r.body = new THREE.Group();
    r.root.add(r.lean); r.lean.add(r.heading); r.heading.add(r.body);
    r.body.rotation.x = HALF_PI;
    r.body.scale.setScalar(p.scale || HEIGHTS[p.height] || 1);
    r.pelvis = new THREE.Group(); r.body.add(r.pelvis);
    r.chest = new THREE.Group(); r.pelvis.add(r.chest);
    const torso = capsule(0.032, 0.05, shirt); torso.position.y = 0.057; r.chest.add(torso);
    r.head = new THREE.Group(); r.head.position.y = 0.122; r.chest.add(r.head);
    const headM = new THREE.Mesh(new THREE.SphereGeometry(0.043, 8, 6), skin);
    headM.position.y = 0.04; headM.castShadow = true; r.head.add(headM);
    buildFace(r.head, p, skin, hair);
    const cap = () => { const c = new THREE.Mesh(new THREE.SphereGeometry(0.047, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.55), hair); c.position.set(0, 0.043, -0.004); c.castShadow = true; return c; };
    const hat = acc === 'cap' || acc === 'tophat';
    if (!['bald', 'afro', 'mohawk'].includes(p.hairStyle) && !(hat && p.hairStyle === 'flat')) r.head.add(cap());
    if (p.hairStyle === 'long') { const l = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.07, 0.025), hair); l.position.set(0, 0.025, -0.032); r.head.add(l); }
    if (p.hairStyle === 'bun') { const b = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 5), hair); b.position.set(0, 0.09, -0.02); r.head.add(b); }
    if (p.hairStyle === 'flat' && !hat) { const f = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.035, 0.075), hair); f.position.set(0, 0.085, -0.003); r.head.add(f); }
    buildHairExtras(r.head, p, hair, hat);
    const part = (geo, m, x, y, z, parent = r.head) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; parent.add(o); return o; };
    if (acc === 'cap') { part(new THREE.CylinderGeometry(0.046, 0.047, 0.026, 8), accM, 0, 0.075, -0.003); part(new THREE.BoxGeometry(0.055, 0.006, 0.045), accM, 0, 0.066, 0.042); }
    if (acc === 'tophat') { part(new THREE.CylinderGeometry(0.032, 0.032, 0.075, 8), mat('#1e1a1a'), 0, 0.12, 0); part(new THREE.CylinderGeometry(0.056, 0.056, 0.005, 10), mat('#1e1a1a'), 0, 0.083, 0); part(new THREE.CylinderGeometry(0.033, 0.033, 0.012, 8), accM, 0, 0.092, 0); }
    if (acc === 'glasses') { for (const sx of [-1, 1]) part(new THREE.BoxGeometry(0.022, 0.014, 0.004), mat('#141010'), sx * 0.016, 0.047, 0.044); part(new THREE.BoxGeometry(0.012, 0.003, 0.003), mat('#141010'), 0, 0.05, 0.044); }
    if (acc === 'crown') { part(new THREE.CylinderGeometry(0.03, 0.032, 0.02, 8), mat('#e2c14a'), 0, 0.088, 0); for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; part(new THREE.ConeGeometry(0.007, 0.018, 4), mat('#e2c14a'), Math.cos(a) * 0.026, 0.105, Math.sin(a) * 0.026); } }
    if (acc === 'bow') { for (const sx of [-1, 1]) { const b = part(new THREE.BoxGeometry(0.024, 0.018, 0.01), accM, 0.03 + sx * 0.012, 0.08, -0.004); b.rotation.z = sx * 0.4; } }
    if (acc === 'headphones') { part(new THREE.BoxGeometry(0.098, 0.01, 0.012), accM, 0, 0.087, 0); for (const sx of [-1, 1]) { const c = part(new THREE.CylinderGeometry(0.015, 0.015, 0.012, 8), accM, sx * 0.047, 0.045, 0); c.rotation.z = HALF_PI; } }

    const limb = (x, y, rad, len, parent, m, end) => {
      const j = new THREE.Group(); j.position.set(x, y, 0); parent.add(j);
      const c = capsule(rad, len, m); c.position.y = -(len / 2 + rad * 0.6); j.add(c);
      if (end) { end.position.y = -(len + rad * 1.4); j.add(end); }
      return j;
    };
    const hand = () => { const h = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.018), skin); h.castShadow = true; return h; };
    const foot = () => { const f = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.014, 0.034), shoe); f.position.z = 0.008; f.castShadow = true; return f; };
    r.shL = limb(0.045, 0.098, 0.012, 0.05, r.chest, armMat, hand());
    r.shR = limb(-0.045, 0.098, 0.012, 0.05, r.chest, armMat, hand());
    const body = (geo, m, x, y, z, parent = r.chest) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; parent.add(o); return o; };
    if (top === 'dress') body(new THREE.CylinderGeometry(0.034, 0.062, 0.075, 8), shirt, 0, -0.012, 0, r.pelvis);
    if (top === 'suit') { body(new THREE.BoxGeometry(0.012, 0.05, 0.006), mat('#c0504a'), 0, 0.07, 0.031); body(new THREE.BoxGeometry(0.03, 0.012, 0.006), mat('#f4f1ea'), 0, 0.1, 0.027); }
    if (top === 'hoodie') { body(new THREE.BoxGeometry(0.06, 0.03, 0.025), shirt, 0, 0.112, -0.03); body(new THREE.BoxGeometry(0.04, 0.02, 0.005), mat('#00000033'.slice(0, 7)), 0, 0.035, 0.031); }
    r.hipL = limb(0.017, 0.0, 0.014, 0.034, r.pelvis, pants);
    r.hipR = limb(-0.017, 0.0, 0.014, 0.034, r.pelvis, pants);
    r.kneeL = limb(0, -0.052, 0.013, 0.03, r.hipL, pants, foot());
    r.kneeR = limb(0, -0.052, 0.013, 0.03, r.hipR, pants, foot());

    // Objeto en la mano
    r.item = new THREE.Group(); r.item.position.set(0, 0.06, 0.055); r.chest.add(r.item);
    r.plate = new THREE.Group();
    r.plate.add(cyl(0.022, 0.022, 0.004, '#f4f1ea', 0, 0, 0, 10));
    r.plate.add(ball(0.012, '#d6873a', 0, 0, 0.008, 0));
    r.plate.rotation.x = -HALF_PI;
    r.book = new THREE.Group();
    r.book.add(box(0.04, 0.008, 0.05, C.red, 0, 0, 0));
    r.item.add(r.plate, r.book);
    r.items = { plate: r.plate, book: r.book };
    const it = (k, build) => { const g = new THREE.Group(); build(g); g.visible = false; r.item.add(g); r.items[k] = g; };
    it('pizza', (g) => { g.add(box(0.05, 0.05, 0.006, '#d9a441', 0, 0, 0)); g.add(box(0.042, 0.042, 0.003, '#c0504a', 0, 0, 0.004)); g.rotation.x = -HALF_PI; });
    it('mug', (g) => { g.add(cyl(0.009, 0.008, 0.016, '#f4f1ea', 0, 0, 0, 8)); g.rotation.x = -HALF_PI; });
    it('guitar', (g) => { g.add(box(0.045, 0.014, 0.05, '#c0703a', -0.02, 0, 0)); g.add(box(0.1, 0.007, 0.009, '#5a3a22', 0.05, 0, 0.004)); g.rotation.z = 0.3; g.position.z = 0.01; });
    it('brush', (g) => { g.add(box(0.004, 0.004, 0.04, '#c9a27e', 0, 0, 0)); g.add(box(0.006, 0.006, 0.01, pick(['#d0574e', '#4f78b0', '#e3c26a']), 0, 0, 0.024)); g.position.x = -0.03; });

    // Estrellas de mareo, olor y agua de la ducha
    r.stars = new THREE.Group(); r.stars.position.y = 0.105; r.head.add(r.stars);
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.011, 0), new THREE.MeshBasicMaterial({ color: '#f0c03e' }));
      const a = (i / 3) * Math.PI * 2; s.position.set(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05); r.stars.add(s);
    }
    r.stars.visible = false;
    r.fx = new THREE.Group(); r.root.add(r.fx);
    r.stink = []; r.drops = [];
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.008, 0.03), new THREE.MeshBasicMaterial({ color: '#8fbf3f' }));
      s.visible = false; r.fx.add(s); r.stink.push(s);
    }
    for (let i = 0; i < 8; i++) {
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.004, 0.02), new THREE.MeshBasicMaterial({ color: '#9fd6ee' }));
      d.visible = false; r.fx.add(d); r.drops.push(d);
    }
    r.meshes = [];
    r.root.traverse((o) => { if (o.isMesh) r.meshes.push(o); });
    scene.add(r.root);
  }

  rebuildRig() {
    const old = this.rig.root;
    scene.remove(old);
    this.buildRig();
    this.rig.root.position.copy(old.position);
  }

  destroy() {
    if (this.act) this.endAct(true);
    scene.remove(this.rig.root);
    this.bubbleEl.remove();
    const i = agents.indexOf(this);
    if (i >= 0) agents.splice(i, 1);
    if (grab.agent === this) grab.agent = null;
  }

  place(x, y) { this.x = this.vis.x = x; this.y = this.vis.y = y; this.z = this.vis.z = groundAt(x, y).z; }

  mood() {
    if (!this.needs) return 70;
    let s = 0, w = 0;
    for (const k of NEED_KEYS) { s += this.needs[k] * MOOD_W[k]; w += MOOD_W[k]; }
    let m = s / w;
    for (const k of NEED_KEYS) if (this.needs[k] < 12) m -= 8;
    m += ambience() * 25 - Math.min(3, puddles.length) * 4;
    return clamp(m, 0, 100);
  }

  addNeed(k, v) { if (this.needs) this.needs[k] = clamp(this.needs[k] + v, 0, 100); }

  setState(s, dur = 0) {
    this.state = s; this.st = 0; this.dur = dur; this.flag = 0;
    if (s !== 'walk') this.target = null;
    if (s !== 'act') this.move = null;
  }

  say(text, dur = 1.5, thought = false) {
    this.bubbleEl.textContent = text;
    this.bubbleEl.classList.toggle('thought', thought);
    this.bubbleT = dur;
    this.bubbleEl.classList.add('show');
  }
  voice(mood) { audio.voice(mood, this.p.pitch || 1); }

  fall(msg, hard = true) {
    if (this.act) this.endAct(true);
    this.setState('fallen');
    this.fallT = rand(1.4, 2.4); this.still = 0; this.hard = hard;
    if (this.holding) this.holding = null;
    if (msg) { this.say(msg, 1.3); this.voice('alarm'); }
    if (hard) this.addNeed('fun', -4);
  }

  walkTo(x, y, done, opts = {}) {
    x = clamp(x, -W / 2 + H_R + 0.01, W / 2 - H_R - 0.01);
    y = clamp(y, -H / 2 + H_R + 0.01, H / 2 - H_R - 0.01);
    this.setState('walk');
    this.target = { x, y, done, fast: !!opts.fast, timeout: opts.timeout || 10 };
    this.lastPos.x = this.x; this.lastPos.y = this.y; this.stuckT = 0; this.avoid = 0;
  }

  canTalk() {
    if (this.leaving || this.courier || this.state === 'held') return false;
    if (this.state === 'idle' || this.state === 'look' || this.state === 'wave') return true;
    if (this.state === 'walk' && !this.userCmd) return true;
    return false;
  }

  /* ---------- Acciones sobre objetos ---------- */
  seatsOf(f) {
    if (f.seats.length) return f.seats;
    const a = f.def.actions.find((d) => typeof d.seat === 'function' && d.anim === 'sit');
    if (!a) return [];
    if (!f.mainSeat) f.mainSeat = { ...a.seat(f), by: null, single: true };
    return [f.mainSeat];
  }
  seatFree(f, seat) {
    const by = seat.single || !f.seats.length ? f.busy : seat.by;
    return !by || by === this;
  }
  findSeatNear(target, mustFace) {
    let best = null, bestD = 1e9;
    for (const f of furn) {
      if (!f.def.seatable) continue;
      if (f.busy && f.busy !== this && f.type === 'sofa') continue;
      for (const seat of this.seatsOf(f)) {
        if (!this.seatFree(f, seat)) continue;
        const [sx, sy] = toWorld(f, seat.lx, seat.ly);
        const dx = target.x - sx, dy = target.y - sy, d = Math.hypot(dx, dy);
        if (d > 0.75) continue;
        if (mustFace) {
          const fa = facingOf(f);
          if ((Math.cos(fa) * dx + Math.sin(fa) * dy) / d < 0.6) continue;
          const ta = facingOf(target);
          if (-(Math.cos(ta) * dx + Math.sin(ta) * dy) / d < 0.2) continue;
        }
        if (d < bestD) { bestD = d; best = { f, seat }; }
      }
    }
    return best;
  }

  seatApproach(f, seat) {
    const cands = [[seat.all ? 0 : seat.lx, f.lhy + 0.05], [f.lhx + 0.05, seat.ly], [-f.lhx - 0.05, seat.ly], [seat.all ? 0 : seat.lx, -f.lhy - 0.05]];
    for (const [lx, ly] of cands) {
      const [x, y] = toWorld(f, lx, ly);
      if (isFree(x, y, H_R + 0.003)) return [x, y];
    }
    return null;
  }

  planFor(f, def) {
    let anim = def.anim;
    if (anim === 'auto') {
      const s = this.findSeatNear(f, def.pose === 'watch');
      const ap = s && this.seatApproach(s.f, s.seat);
      if (ap) return { anim: 'sit', seatF: s.f, seat: s.seat, ax: ap[0], ay: ap[1] };
      anim = 'stand';
    }
    if (anim === 'sit' || anim === 'lie') {
      let seat;
      if (def.seat === 'free') seat = this.seatsOf(f).find((s) => this.seatFree(f, s));
      else if (def.seat) {
        const sd = def.seat(f);
        if (sd.all) { if (f.busy && f.busy !== this) return null; if (f.seats.some((s) => s.by && s.by !== this)) return null; seat = { ...sd, single: true }; }
        else seat = this.seatsOf(f)[0] || { ...sd, single: true };
        if (!this.seatFree(f, seat)) return null;
      } else seat = this.seatsOf(f).find((s) => this.seatFree(f, s));
      if (!seat) return null;
      const ap = this.seatApproach(f, seat);
      if (!ap) return null;
      return { anim, seatF: f, seat, ax: ap[0], ay: ap[1] };
    }
    if (anim === 'kick') return { anim, ax: f.x + rand(-0.05, 0.05), ay: f.y + rand(-0.05, 0.05) };
    const sp = def.spot ? def.spot(f, this) : { lx: 0, ly: f.lhy + 0.055 };
    let [x, y] = toWorld(f, sp.lx, sp.ly);
    if (!sp.inside && !isFree(x, y, H_R)) {
      const alts = [[f.lhx + 0.05, 0], [-f.lhx - 0.05, 0], [0, -f.lhy - 0.055], [f.lhx * 0.7, f.lhy + 0.06], [-f.lhx * 0.7, f.lhy + 0.06]];
      const ok = alts.map(([lx, ly]) => toWorld(f, lx, ly)).find(([ax, ay]) => isFree(ax, ay, H_R));
      if (!ok) return null;
      [x, y] = ok;
    }
    return { anim, ax: x, ay: y, face: sp.face !== undefined ? f.rot + sp.face : null };
  }

  perform(f, def, opts = {}) {
    if (!furn.includes(f) || this.state === 'held') return false;
    const user = !!opts.user;
    if (this.isHost && def.refuse) { const r = def.refuse(this); if (r) { this.say(r, 1.8); this.voice('angry'); return false; } }
    if (def.cost && money < def.cost) { if (this.isHost) { this.say('No hay dinero…', 1.6); this.voice('sad'); } return false; }
    if (def.exclusive && f.busy && f.busy !== this) { if (user) this.say('Está ocupado', 1.2); return false; }
    const plan = opts.plan || this.planFor(f, def);
    if (!plan) { if (user) this.say('No puedo llegar…', 1.4); return false; }
    if (this.act) this.endAct(true);
    if (this.state === 'fallen' || this.state === 'getup' || this.state === 'air' || this.state === 'stumble') {
      if (user) this.say('¡Espera!', 1);
      return false;
    }
    this.userCmd = user;
    this.holding = def.hold || null;
    if (opts.here) { this.beginAct(f, def, plan); return true; }
    this.walkTo(plan.ax, plan.ay, () => this.beginAct(f, def, plan), { fast: opts.fast });
    return true;
  }

  beginAct(f, def, plan) {
    if (f && !furn.includes(f)) { this.setState('idle', 0.5); return; }
    if (plan.seat && !this.seatFree(plan.seatF, plan.seat)) { this.say('Ocupado…', 1.2); this.setState('idle', 1); return; }
    if (def.exclusive && f.busy && f.busy !== this) { this.setState('idle', 1); return; }
    if (Math.hypot(this.x - plan.ax, this.y - plan.ay) > 0.1) { this.setState('idle', 0.5); return; }
    if (def.cost) {
      if (money < def.cost) { if (this.isHost) this.say('No hay dinero…', 1.5); this.setState('idle', 1); return; }
      spend(def.cost, !this.isHost ? `${this.name} se come tu comida (−${def.cost}◎)` : null);
    }
    this.setState('act');
    this.act = { f, def, plan, t: 0, dur: def.dur * (this.isHost ? 1 : rand(0.8, 1.3)), seatF: plan.seatF, seat: plan.seat, anim: plan.anim, partner: null };
    if (plan.seat) {
      if (plan.seat.single || !plan.seatF.seats.length) plan.seatF.busy = this; else plan.seat.by = this;
      this.vz = 0;
    }
    if (def.exclusive && f) f.busy = this;
    if (def.hold) this.holding = def.hold;
    if (def.screen && f) f.use = def.screen;
    if (!plan.seat) this.targetFacing = plan.face != null ? plan.face : f ? Math.atan2(f.y - this.y, f.x - this.x) : this.facing;
    if (def.id === 'sleep' || def.id === 'nap' || def.id === 'naps') this.say('Zzz…', 1.4);
  }

  endAct(interrupted) {
    const a = this.act;
    if (!a) return;
    this.act = null;
    if (a.seat) {
      if (a.seatF.busy === this) a.seatF.busy = null;
      if (a.seat.by === this) a.seat.by = null;
    }
    if (a.f && a.f.busy === this) a.f.busy = null;
    if (a.f && a.def.screen && !agents.some((o) => o !== this && o.act && o.act.f === a.f && o.act.def.screen)) a.f.use = null;
    if (a.def.hold && this.holding === a.def.hold) this.holding = null;
    if (a.partner && a.partner.act && a.partner.act.partner === this) a.partner.endAct(false);
    if (a.pet && a.pet.with === this) a.pet.setState('idle', 1);
    if (a.seat && furn.includes(a.seatF)) this.standFromSeat(a);
    else if (this.state === 'act') this.setState('idle', rand(0.4, 1.2));
    this.userCmd = false;
    if (a.def.onEnd) a.def.onEnd(this, interrupted, a.f);
  }

  standFromSeat(a) {
    const f = a.seatF, s = a.seat;
    const [fx, fy] = this.seatApproach(f, s) || toWorld(f, s.all ? 0 : s.lx, f.lhy + 0.045);
    this.x = clamp(fx, -W / 2 + H_R, W / 2 - H_R);
    this.y = clamp(fy, -H / 2 + H_R, H / 2 - H_R);
    this.facing = this.targetFacing = facingOf(f);
    this.setState('air');
    this.vz = 0.4;
  }

  startMeal(kind = 'plate') {
    const M = MEALS[kind] || MEALS.plate;
    // Busca una silla junto a una mesa; si no, otra silla o el sofá; si no, come de pie
    let best = null, bestD = 1e9;
    for (const f of furn) {
      if (!f.def.seatable) continue;
      for (const seat of this.seatsOf(f)) {
        if (!this.seatFree(f, seat)) continue;
        const [sx, sy] = toWorld(f, seat.lx, seat.ly);
        const fa = facingOf(f), fx = sx + Math.cos(fa) * 0.09, fy = sy + Math.sin(fa) * 0.09;
        const atTable = furn.some((t) => t.type === 'table' && supportAt(t, fx, fy) > 0);
        if (!this.seatApproach(f, seat)) continue;
        const d = Math.hypot(sx - this.x, sy - this.y) + (atTable ? 0 : 0.8) + (f.type === 'sofa' ? 0.3 : 0);
        if (d < bestD) { bestD = d; best = { f, seat }; }
      }
    }
    this.holding = M.sit.hold;
    if (best) {
      const ap = this.seatApproach(best.f, best.seat);
      const [ax, ay] = ap || [0, 0];
      if (ap && this.perform(best.f, M.sit, { plan: { anim: 'sit', seatF: best.f, seat: best.seat, ax, ay }, user: this.userCmd })) { this.holding = M.sit.hold; return; }
    }
    this.perform(furn.find((f) => f.type === 'fridge') || furn[0], M.stand, { plan: { anim: 'stand', ax: this.x, ay: this.y, face: this.facing }, here: true });
    this.holding = M.sit.hold;
  }

  startPet(pet, mode = 'pet') {
    if (!pet || !pets.includes(pet) || pet.state === 'held' || pet.z > 0.05 || this.state === 'held') return false;
    if (this.act) this.endAct(true);
    pet.wait(this, 7);
    const ang = Math.atan2(this.y - pet.y, this.x - pet.x);
    this.walkTo(pet.x + Math.cos(ang) * 0.075, pet.y + Math.sin(ang) * 0.075, () => {
      if (!pets.includes(pet) || pet.state === 'held' || Math.hypot(pet.x - this.x, pet.y - this.y) > 0.16) { this.setState('idle', 1); return; }
      const def = mode === 'play' ? PLAYPET : PETTING;
      this.setState('act');
      this.act = { f: null, def, plan: { anim: 'stand' }, t: 0, dur: def.dur, anim: 'stand', partner: null, pet };
      this.targetFacing = Math.atan2(pet.y - this.y, pet.x - this.x);
      pet.beginInteraction(this, mode, def.dur);
      if (mode === 'play') this.say(pick([`¡Vamos, ${pet.name}!`, '¡Corre!', '¡A jugar!']), 1.3);
      else this.say(pick([`¿Quién es bueno? ¡${pet.name}!`, '♥', 'Qué suave…']), 1.3);
    });
    return true;
  }

  startTalk(o) {
    if (!o || !o.canTalk() || o === this) return false;
    const ang = Math.atan2(this.y - o.y, this.x - o.x);
    const tx = o.x + Math.cos(ang) * 0.1, ty = o.y + Math.sin(ang) * 0.1;
    if (this.act) this.endAct(true);
    o.setState('idle', 8);
    o.targetFacing = Math.atan2(this.y - o.y, this.x - o.x);
    o.waitFor = this;
    this.walkTo(tx, ty, () => {
      o.waitFor = null;
      if (!agents.includes(o) || o.state !== 'idle' || Math.hypot(o.x - this.x, o.y - this.y) > 0.2) { this.setState('idle', 1); return; }
      beginTalk(this, o);
    }, { fast: false });
    return true;
  }

  poke() {
    this.pokes += 1;
    audio.giggle(this.p.pitch || 1);
    if (this.act && this.act.seat) {
      const sleeping = this.act.anim === 'lie';
      this.endAct(true);
      this.say(sleeping ? '¡¿Qué?! ¡Estaba durmiendo!' : '!', 1.6);
      if (sleeping) this.addNeed('fun', -5);
      return;
    }
    if (this.state === 'fallen') { this.still += 0.6; this.say('Ay…', 1); return; }
    if (this.act) this.endAct(true);
    const angry = this.pokes > 4.5;
    this.say(angry ? pick(['¡Para ya!', 'Grrr…', '¡Basta!', '¡Oye!']) : pick(['¡Ji ji!', '¡Cosquillas!', '!', '¡Je!', '¡Ay!']), 1.2);
    if (angry) this.addNeed('fun', -3); else { this.addNeed('fun', 5); this.addNeed('social', 4); }
    if (this.z <= groundAt(this.x, this.y).z + 0.003) { this.setState('air'); this.vz = angry ? 0.5 : 0.85; }
    if (angry) {
      this.pokes = 2.5;
      this.voice('angry');
      if (!this.isHost) { this.angry = true; return; }
      for (let i = 0; i < 20; i++) {
        const a = rand(0, Math.PI * 2), x = this.x + Math.cos(a) * 0.35, y = this.y + Math.sin(a) * 0.35;
        if (isFree(x, y, 0.05)) { this.nextWalk = { x, y }; break; }
      }
    }
  }

  /* ---------- Física ---------- */
  friction(decel, dt) {
    const sp = Math.hypot(this.vx, this.vy);
    if (sp < 1e-4) return;
    const ns = Math.max(0, sp - decel * dt);
    this.vx *= ns / sp; this.vy *= ns / sp;
  }

  collideFurn(px, py) {
    let impact = 0;
    for (const f of furn) {
      const cx = clamp(this.x, f.x - f.hx, f.x + f.hx), cy = clamp(this.y, f.y - f.hy, f.y + f.hy);
      const dx = this.x - cx, dy = this.y - cy, d2 = dx * dx + dy * dy;
      if (d2 > H_R * H_R) continue;
      const [lx, ly] = toLocal(f, cx, cy);
      const top = f.support(clamp(lx, -f.lhx + 0.004, f.lhx - 0.004), clamp(ly, -f.lhy + 0.004, f.lhy - 0.004));
      if (this.z >= top - 0.03) continue;
      if (f.def.round && !f.drag) {
        // La pelota sale disparada al chocar con ella
        const d = Math.sqrt(d2) || 1e-3, nx = d2 > 1e-10 ? dx / d : 1, ny = d2 > 1e-10 ? dy / d : 0;
        f.x -= nx * (H_R - d + 0.002); f.y -= ny * (H_R - d + 0.002);
        const sp = Math.max(0.35, Math.hypot(this.vx, this.vy) * 1.8);
        f.vx = -nx * sp; f.vy = -ny * sp;
        audio.kick();
        continue;
      }
      if (d2 > 1e-10) {
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, push = H_R - d;
        this.x += nx * push; this.y += ny * push;
        const vn = (this.vx - f.vx) * nx + (this.vy - f.vy) * ny;
        if (vn < 0) { impact = Math.max(impact, -vn); this.vx -= 1.35 * vn * nx; this.vy -= 1.35 * vn * ny; }
      } else if (this.z > 0.02) {
        this.x = px; this.y = py;
      } else {
        const ex = f.hx + H_R - Math.abs(this.x - f.x), ey = f.hy + H_R - Math.abs(this.y - f.y);
        if (ex < ey) this.x += (Math.sign(this.x - f.x) || 1) * ex; else this.y += (Math.sign(this.y - f.y) || 1) * ey;
      }
    }
    return impact;
  }

  walls() {
    const lx = W / 2 - H_R, ly = H / 2 - H_R;
    let impact = 0;
    if (this.x < -lx) { this.x = -lx; if (this.vx < 0) { impact = -this.vx; this.vx = -this.vx * 0.35; } }
    if (this.x > lx) { this.x = lx; if (this.vx > 0) { impact = this.vx; this.vx = -this.vx * 0.35; } }
    if (this.y < -ly) { this.y = -ly; if (this.vy < 0) { impact = Math.max(impact, -this.vy); this.vy = -this.vy * 0.35; } }
    if (this.y > ly) { this.y = ly; if (this.vy > 0) { impact = Math.max(impact, this.vy); this.vy = -this.vy * 0.35; } }
    return impact;
  }

  turn(dt, rate) {
    this.facing += clamp(wrap(this.targetFacing - this.facing), -rate * dt, rate * dt) + this.spin * dt;
    if (Math.abs(this.spin) > 0.5) this.targetFacing = this.facing;
  }

  step(dt) {
    this.st += dt;
    this.pokes = Math.max(0, this.pokes - dt * 0.35);
    this.spin *= Math.exp(-dt * 2.5);
    const tm = tilt.length();
    const a = this.act;

    if (this.state === 'held') {
      const nx = damp(this.x, grab.x, 22, dt), ny = damp(this.y, grab.y, 22, dt);
      grab.vx = damp(grab.vx, (nx - this.x) / dt, 14, dt);
      grab.vy = damp(grab.vy, (ny - this.y) / dt, 14, dt);
      this.x = clamp(nx, -W / 2 + H_R, W / 2 - H_R); this.y = clamp(ny, -H / 2 + H_R, H / 2 - H_R);
      this.z = damp(this.z, liftZ(), 9, dt);
      this.vx = this.vy = this.vz = 0;
      this.targetFacing = -HALF_PI;
      this.turn(dt, 5);
      return;
    }

    if (this.state === 'act' && (a.seat || a.anim === 'lie')) {
      if (a.seat) {
        const f = a.seatF;
        const [wx, wy] = toWorld(f, a.seat.lx, a.seat.ly);
        this.x = wx; this.y = wy; this.z = a.seat.h; this.vx = f.vx; this.vy = f.vy;
        this.facing = this.targetFacing = f.rot + a.seat.face;
        if (Math.hypot(f.vx, f.vy) > 0.45 || tm > 0.5) {
          this.endAct(true);
          this.vx = f.vx * 1.2 + tilt.x * 0.6; this.vy = f.vy * 1.2 + tilt.y * 0.6;
          this.thrown = true;
          this.say(pick(['¡Uoooh!', '¡Eh!', '¡Que me caigo!']), 1.2); this.voice('alarm');
          return;
        }
      } else {
        this.z = groundAt(this.x, this.y).z; this.vx = this.vy = 0;
        if (tm > 0.3) { this.endAct(true); this.fall('¡Eh!', false); return; }
      }
      this.tickAct(dt);
      return;
    }

    if (this.on && furn.includes(this.on)) { this.x += this.on.dx; this.y += this.on.dy; }
    const noclip = !this.isHost && (!this.arrived || this.leaving);
    const ground = (x, y) => (noclip ? { z: 0, f: null } : groundAt(x, y));
    let sup = ground(this.x, this.y);
    const grounded = this.z <= sup.z + 0.004 && this.vz <= 0.01;
    const standingAct = this.state === 'act';

    if (grounded) {
      this.z = sup.z; this.vz = 0; this.on = sup.f;
      if (this.state === 'air') this.setState(this.thrown ? 'dizzy' : 'idle', this.thrown ? 1.6 : 0.6);
      if ((UPRIGHT.has(this.state) || standingAct) && tm > 0.24) {
        if (this.act) this.endAct(true);
        this.setState('stumble');
        this.say(pick(['¡Uoh!', '¡Eh, eh!', '¡Cuidado!', '¡Que me caigo!']), 1.2); this.voice('alarm');
      }
      if (this.state === 'stumble') {
        if (tm > 0.46 || Math.hypot(this.vx, this.vy) > 0.65) this.fall(pick(['¡Aaah!', '¡Uaaa!', '¡Socorro!']), false);
        else if (tm < 0.14 && this.st > 0.5) this.setState('idle', rand(0.5, 1));
      }
      const slide = this.state === 'stumble' || this.state === 'fallen' || this.state === 'getup';
      if (slide) {
        this.vx += tilt.x * G * dt; this.vy += tilt.y * G * dt;
        this.friction((this.state === 'stumble' ? 0.08 : 0.13) * G, dt);
        if (this.state === 'stumble') {
          this.targetFacing = Math.atan2(-tilt.y, -tilt.x);
          this.walkPhase += dt * 16;
        }
      } else {
        let dx = 0, dy = 0;
        if (this.state === 'walk' && this.target) [dx, dy] = this.walkDesire(dt);
        else if (this.state === 'act' && this.move) { dx = this.move.x; dy = this.move.y; }
        this.vx = damp(this.vx, dx + tilt.x * 0.25, 12, dt);
        this.vy = damp(this.vy, dy + tilt.y * 0.25, 12, dt);
      }
    } else {
      this.vz -= GZ * dt; this.on = null;
      if (this.state !== 'air' && this.state !== 'fallen' && this.state !== 'help' && this.z - sup.z > 0.04) {
        if (this.act) this.endAct(true);
        this.setState('air');
      }
    }

    const px = this.x, py = this.y;
    this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
    let impact = this.isHost || (this.arrived && !this.leaving) ? this.collideFurn(px, py) : 0;
    impact = Math.max(impact, this.walls());

    if (this.z + HUMAN_H > D && this.vz > 0) {
      this.z = D - HUMAN_H; this.vz = -this.vz * 0.25;
      audio.bonk(); shakeScreen();
      this.say(pick(['¡Ay! ¡El cristal!', '¡Bonk!', '¡Mi cabeza!']), 1.4);
      this.addNeed('fun', -6);
      if (!this.isHost) this.angry = true;
    }

    sup = ground(this.x, this.y);
    if (this.z < sup.z) {
      const fallSpeed = -this.vz;
      this.z = sup.z; this.vz = 0; this.on = sup.f;
      if (this.state === 'air' || this.state === 'help') {
        if (fallSpeed > 1.6 || (this.thrown && fallSpeed > 1.15)) { this.fall('¡Ay!'); audio.thud(0.35); if (!this.isHost) this.angry = true; }
        else if (this.state === 'air') {
          this.setState(this.thrown ? 'dizzy' : 'idle', this.thrown ? 1.6 : 0.7); audio.thud(0.1);
          if (this.thrown) this.addNeed('fun', 3);
        }
        this.thrown = false;
      } else if (this.state === 'fallen' && fallSpeed > 0.5) audio.thud(0.15);
    }

    if (impact > 0.75 && (this.state === 'air' || this.state === 'stumble' || this.state === 'fallen')) {
      audio.thud(Math.min(0.5, impact * 0.3));
      if (this.state !== 'fallen') this.fall(pick(['¡Ay!', '¡Uf!', '¡Auch!']));
      else if (impact > 1) this.say(pick(['¡Ay!', '¡Auch!']), 0.9);
    }

    if (this.state === 'act') this.tickAct(dt);
    else this.behave(dt, tm);
    this.turn(dt, this.state === 'walk' ? 9 : 6);
  }

  walkDesire(dt) {
    const t = this.target, ex = t.x - this.x, ey = t.y - this.y, d = Math.hypot(ex, ey);
    if (d < 0.014) {
      const done = t.done;
      this.setState('idle', rand(0.8, 2));
      if (done) done();
      return [0, 0];
    }
    let ang = Math.atan2(ey, ex);
    if (this.avoid > 0) { ang += this.avoidSign * 1.15; this.avoid -= dt; }
    const sad = this.isHost && this.mood() < 25;
    const sp = (t.fast ? 0.34 : sad ? 0.14 : 0.2) * Math.min(1, d / 0.05 + 0.35);
    this.targetFacing = ang;
    this.walkPhase += dt * sp * 60;
    this.stuckT += dt;
    if (this.stuckT > 0.45) {
      const moved = Math.hypot(this.x - this.lastPos.x, this.y - this.lastPos.y);
      if (moved < sp * this.stuckT * 0.3) { this.avoid = 0.55; this.avoidSign = Math.random() < 0.5 ? -1 : 1; }
      this.lastPos.x = this.x; this.lastPos.y = this.y; this.stuckT = 0;
    }
    if (this.st > t.timeout) { this.setState('idle', 1); this.userCmd = false; }
    return [Math.cos(ang) * sp, Math.sin(ang) * sp];
  }

  tickAct(dt) {
    const a = this.act;
    if (!a) return;
    a.t += dt;
    const def = a.def;
    if (def.rates) {
      for (const k in def.rates) {
        if (k === 'money') { if (this.isHost) earn(def.rates.money * dt); }
        else this.addNeed(k, def.rates[k] * dt);
      }
    }
    if (a.anim === 'kick') this.kickTick(dt);
    if (def.tick) def.tick(this, dt, a);
    if (def.pose === 'run') this.walkPhase += dt * 15;
    if (def.pose === 'dress') this.targetFacing += dt * 9;
    if (a.pet) {
      if (!pets.includes(a.pet) || a.pet.state === 'held') { this.endAct(true); return; }
      this.targetFacing = Math.atan2(a.pet.y - this.y, a.pet.x - this.x);
    }
    if (a.anim === 'dance') { this.walkPhase += dt * 8; this.targetFacing += dt * (Math.sin(a.t * 1.3) > 0 ? 2.5 : -2.5); }
    if (def.id === 'talk') this.talkTick(dt);
    if (a.t >= a.dur || (def.until && def.until(this))) this.endAct(false);
  }

  kickTick() {
    const a = this.act, b = a.f;
    if (!furn.includes(b)) { this.endAct(true); return; }
    if (!a.goal || Math.random() < 0.004) a.goal = { x: rand(-W / 2 + 0.1, W / 2 - 0.1), y: rand(-H / 2 + 0.1, H / 2 - 0.1) };
    let gx = a.goal.x - b.x, gy = a.goal.y - b.y;
    const gd = Math.hypot(gx, gy) || 1; gx /= gd; gy /= gd;
    const bx = b.x - gx * 0.06, by = b.y - gy * 0.06;
    let dx = bx - this.x, dy = by - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 0.025) {
      // Chuta hacia la meta
      dx = gx; dy = gy;
      if (Math.random() < 0.15) this.say(pick(['¡Gol!', '¡Toma!', '¡Ja!']), 0.9);
    } else { dx /= d; dy /= d; }
    const sp = 0.3;
    this.move = { x: dx * sp, y: dy * sp };
    this.targetFacing = Math.atan2(dy, dx);
    this.walkPhase += 0.32;
    if (Math.hypot(b.vx, b.vy) < 0.02 && d < 0.04) a.goal = null;
  }

  talkTick(dt) {
    const a = this.act, o = a.partner;
    if (!o || !agents.includes(o) || !o.act || o.act.partner !== this) { this.endAct(false); return; }
    this.targetFacing = Math.atan2(o.y - this.y, o.x - this.x);
    if (a.leader) {
      a.talkT -= dt;
      if (a.talkT <= 0) {
        a.talkT = rand(1.1, 1.7);
        a.turn = !a.turn;
        const sp = a.turn ? this : o;
        const t = pick(TOPICS);
        sp.say(Math.random() < 0.5 ? t : `${t} ${pick(['¡Ja, ja!', '¿Sí?', '¡No me digas!', 'Bla, bla…', '¡Qué fuerte!', 'Ajá…'])}`, 1.3);
        sp.voice(Math.random() < 0.7 ? 'happy' : 'alarm');
        sp.gest = 0.8;
      }
    }
  }

  behave(dt, tm) {
    switch (this.state) {
      case 'idle': case 'look':
        if (this.nextWalk) { const p = this.nextWalk; this.nextWalk = null; this.walkTo(p.x, p.y, () => this.setState('idle', 1.5), { fast: true }); break; }
        if (this.waitFor) { if (!agents.includes(this.waitFor) || this.st > 8) this.waitFor = null; else break; }
        if (this.isHost && finger.follow) { this.followFinger(); break; }
        if (this.st > this.dur) this.isHost ? this.think() : this.visitorThink();
        break;
      case 'wave': case 'shame':
        if (this.st > this.dur) this.setState('idle', rand(1, 2));
        break;
      case 'help':
        if (this.z <= groundAt(this.x, this.y).z + 0.002 && this.vz <= 0 && this.st < this.dur - 0.5 && (this.st % 0.75) < dt * 1.5) this.vz = 0.75;
        if (this.st > this.dur && this.vz === 0) this.setState('idle', rand(1, 2));
        break;
      case 'door':
        if (this.flag === 0 && this.st > 1.2) { this.flag = 1; this.say(pick(['Cerrada…', 'No se abre…', 'Clic, clic… nada']), 1.6); this.voice('sad'); }
        if (this.flag === 1 && this.st > 2.6) { this.flag = 2; this.targetFacing = -HALF_PI; if (face.present) this.say('¿Me ayudas?', 1.4); }
        if (this.st > this.dur) this.setState('idle', rand(0.5, 1.5));
        break;
      case 'reach':
        if (!finger.follow) { this.setState('idle', 1); this.say('♥', 1); break; }
        this.targetFacing = Math.atan2(finger.y - this.y, finger.x - this.x);
        if (Math.hypot(finger.x - this.x, finger.y - this.y) > 0.09) this.followFinger();
        else this.addNeed('social', dt * 1.5);
        break;
      case 'dizzy':
        if (this.st > this.dur) this.setState('idle', 1);
        break;
      case 'fallen': {
        const sp = Math.hypot(this.vx, this.vy);
        if (sp < 0.08 && tm < 0.2) this.still += dt; else this.still = 0;
        if (this.st > 0.6 && this.still > this.fallT) this.setState('getup');
        break;
      }
      case 'getup':
        if (this.st > 0.75) {
          if (this.hard) { this.setState('dizzy', 1.6); this.say(pick(['@_@', 'Uff…', 'Todo da vueltas…']), 1.4); }
          else this.setState('idle', 0.8);
        }
        break;
    }
  }

  followFinger() {
    const ang = Math.atan2(this.y - finger.y, this.x - finger.x);
    const x = finger.x + Math.cos(ang) * 0.06, y = finger.y + Math.sin(ang) * 0.06;
    this.walkTo(x, y, () => { this.setState('reach'); this.say(pick(['♥', '¡Hola, dedo!', '¡Choca!']), 1.2); this.voice('happy'); }, { fast: true });
  }

  /* ---------- Necesidades y decisiones (tu humano) ---------- */
  updateNeeds(dt) {
    const n = this.needs;
    const sleeping = this.act && this.act.anim === 'lie';
    for (const k of NEED_KEYS) {
      let r = NEED_INFO[k].decay * settings.speed;
      if (k === 'energy' && sleeping) r = 0;
      if (k === 'fun' && sleeping) r *= 0.3;
      if (k === 'social' && sleeping) r *= 0.3;
      if (k === 'fun' || k === 'social') r *= 1 - ambience();
      if (k === 'fun' || k === 'energy') r *= 1 + noiseLevel();
      n[k] = clamp(n[k] - r * dt, 0, 100);
    }
    if (face.present && !sleeping) this.addNeed('social', 0.45 * dt);

    if (n.bladder <= 0 && this.state !== 'held') this.accident();
    if (n.energy <= 0 && !sleeping && this.state !== 'held' && this.state !== 'air') this.faint();

    this.complainT -= dt;
    if (this.complainT <= 0) {
      this.complainT = rand(9, 16);
      let low = null;
      for (const k of NEED_KEYS) if (n[k] < 28 && (!low || n[k] < n[low])) low = k;
      if (low && !sleeping && this.bubbleT <= 0) {
        if (Math.random() < 0.5) this.say(`${NEED_INFO[low].icon}…`, 2, true);
        else this.say(pick(NEED_INFO[low].low), 1.8);
        this.voice('sad');
      }
    }
  }

  accident() {
    if (this.act) this.endAct(true);
    addPuddle(this.x, this.y);
    this.needs.bladder = 100;
    this.addNeed('hygiene', -30);
    this.addNeed('fun', -12);
    this.setState('shame', 2.6);
    this.say(pick(['¡Ups…!', 'Qué vergüenza…', 'No llegué…']), 2);
    this.voice('sad');
    toast(`¡${this.name} no llegó al baño! Toca el charco para limpiarlo.`);
  }

  faint() {
    if (this.act) this.endAct(true);
    this.say('Zzz… (se ha dormido en el suelo)', 2);
    this.setState('act');
    this.act = { f: null, def: FAINT, plan: { anim: 'lie' }, t: 0, dur: FAINT.dur, anim: 'lie', partner: null };
  }

  think() {
    const n = this.needs;
    this.holding = null;
    const options = [];
    for (const f of furn) {
      for (const def of f.def.actions) {
        if (def.instant || !def.adv) continue;
        if (def.cost && money < def.cost) continue;
        if (def.refuse && def.refuse(this)) continue;
        let s = 0;
        for (const k in def.adv) {
          if (k === 'money') s += money < 30 ? 0.9 : money < 120 ? 0.32 : 0.06;
          else s += (def.adv[k] / 100) * urgency(n[k]);
        }
        if (s <= 0) continue;
        s /= 1 + Math.hypot(f.x - this.x, f.y - this.y) * 0.6;
        if (f.busy && f.busy !== this) s *= 0.15;
        if (f.type === 'toilet' && n.bladder < 20) s += 2;
        if (def.id === 'clips') s = clips.wire > 0 ? s + 0.25 * clamp((this.mood() - 40) / 40, 0, 1) : 0;
        options.push({ s: s * rand(0.8, 1.2), f, def });
      }
    }
    for (const pet of pets) {
      if (!pet.canInteract()) continue;
      const d = Math.hypot(pet.x - this.x, pet.y - this.y);
      const sc = (urgency(n.fun) * 0.35 + urgency(n.social) * 0.35 + (pet.love < 45 ? 0.45 : 0.12)) / (1 + d * 0.6);
      options.push({ s: sc * rand(0.8, 1.2), pet, mode: Math.random() < 0.4 ? 'play' : 'pet' });
    }
    for (const f of furn) {
      if (f.type === 'bowl' && !(f.food > 0) && pets.some((pp) => pp.hunger < 60) && money >= 3) options.push({ s: 1.1 / (1 + Math.hypot(f.x - this.x, f.y - this.y) * 0.6), f, def: f.def.actions[0] });
    }
    for (const f of furn) if (f.jam) options.push({ s: 1.0 / (1 + Math.hypot(f.x - this.x, f.y - this.y) * 0.6), f, def: f.def.actions[0] });
    for (const pd of puddles) options.push({ s: 0.35 + (pd.kind === 'poop' ? 0.15 : 0), puddle: pd });
    const guest = agents.find((o) => o !== this && o.canTalk() && !o.leaving && o.arrived);
    if (guest) options.push({ s: urgency(n.social) * 0.9 + 0.3, talk: guest });
    options.sort((a, b) => b.s - a.s);
    for (const o of options.slice(0, 4)) {
      if (o.s < 0.16) break;
      if (o.talk) { if (this.startTalk(o.talk)) return; continue; }
      if (o.pet) { if (this.startPet(o.pet, o.mode)) return; continue; }
      if (o.puddle) { if (this.cleanUp(o.puddle)) return; continue; }
      if (this.perform(o.f, o.def)) return;
    }
    this.idleBehaviour();
  }

  cleanUp(pd) {
    if (!puddles.includes(pd)) return false;
    this.walkTo(pd.x + 0.05, pd.y, () => {
      if (!puddles.includes(pd)) { this.setState('idle', 0.5); return; }
      this.setState('act');
      this.act = { f: null, def: { id: 'clean', label: 'Limpiar', anim: 'stand', pose: 'wash', dur: 2.5, rates: { fun: -0.5 }, onEnd: (a, int) => { if (!int && puddles.includes(pd)) cleanPuddle(pd, true); } }, plan: { anim: 'stand' }, t: 0, dur: 2.5, anim: 'stand', partner: null };
      this.targetFacing = Math.atan2(pd.y - this.y, pd.x - this.x);
      this.say(pd.kind === 'poop' ? '¡Puaj!' : 'Ay, ay…', 1.2);
    });
    return true;
  }

  idleBehaviour() {
    const opts = [['wander', 3], ['look', 1.2], ['door', 0.35], ['lamp', 0.3]];
    if (face.present) opts.push(['wave', 1.2], ['help', 0.6]); else opts.push(['help', 0.25]);
    let total = opts.reduce((s, o) => s + o[1], 0), r = Math.random() * total, choice = 'wander';
    for (const [k, w] of opts) { if ((r -= w) <= 0) { choice = k; break; } }
    switch (choice) {
      case 'wander': {
        for (let i = 0; i < 25; i++) {
          const x = rand(-W / 2 + 0.06, W / 2 - 0.06), y = rand(-H / 2 + 0.06, H / 2 - 0.06);
          if (isFree(x, y, 0.05)) { this.walkTo(x, y, () => this.setState('idle', rand(1, 3))); return; }
        }
        break;
      }
      case 'door': {
        const x = door.x, y = H / 2 - 0.055;
        if (!isFree(x, y, H_R) || visitors().length) break;
        this.walkTo(x, y, () => { this.setState('door', 3.2); this.targetFacing = HALF_PI; });
        return;
      }
      case 'lamp': {
        const l = furn.find((f) => f.type === 'lamp');
        if (!l) break;
        this.perform(l, l.def.actions[0]);
        return;
      }
      case 'wave':
        this.setState('wave', 2.4); this.targetFacing = -HALF_PI;
        this.say(pick(['¡Hola!', '¡Eh, tú!', '¡Te veo!', '¡Hola, gigante!']), 1.6); this.voice('happy');
        return;
      case 'help': {
        const go = () => { this.setState('help', 3.4); this.targetFacing = -HALF_PI; this.say(pick(['¡Sácame de aquí!', '¡Socorro!', '¡Déjame salir!']), 2.2); this.voice('alarm'); };
        if (isFree(0, 0, 0.05)) this.walkTo(rand(-0.05, 0.05), rand(-0.05, 0.05), go); else go();
        return;
      }
      case 'look':
        this.setState('look', rand(2, 4));
        return;
    }
    this.setState('idle', rand(0.8, 2));
  }

  /* ---------- Visitas ---------- */
  visitorThink() {
    if (this.leaving) {
      if (Math.hypot(this.x - door.x, this.y - H / 2) < 0.12) this.gone = true;
      else this.walkTo(door.x, H / 2 - 0.035, () => { this.gone = true; }, { timeout: 15 });
      return;
    }
    if (this.angry || clock > this.leaveAt || (host && host.needs.hygiene < 15 && Math.random() < 0.3)) {
      if (host && host.needs.hygiene < 15 && !this.angry && clock <= this.leaveAt) this.say('¡Qué olor! Me voy…', 2);
      this.leave();
      return;
    }
    const opts = [];
    if (host && host.canTalk() && !host.userCmd) opts.push({ w: 3, talk: true });
    for (const f of furn) for (const def of f.def.actions) {
      if (!def.visitor) continue;
      if (def.cost && money < def.cost) continue;
      if (f.busy && f.busy !== this) continue;
      opts.push({ w: def.id === 'eat' ? 0.4 : 0.8, f, def });
    }
    opts.push({ w: 0.8, wander: true });
    for (const pet of pets) if (pet.canInteract()) opts.push({ w: 0.7, pet });
    let total = opts.reduce((s, o) => s + o.w, 0), r = Math.random() * total, c = opts[opts.length - 1];
    for (const o of opts) { if ((r -= o.w) <= 0) { c = o; break; } }
    if (c.talk && this.startTalk(host)) return;
    if (c.pet && this.startPet(c.pet, Math.random() < 0.5 ? 'play' : 'pet')) return;
    if (c.f && this.perform(c.f, c.def)) return;
    for (let i = 0; i < 20; i++) {
      const x = rand(-W / 2 + 0.06, W / 2 - 0.06), y = rand(-H / 2 + 0.06, H / 2 - 0.06);
      if (isFree(x, y, 0.05)) { this.walkTo(x, y, () => this.setState('idle', rand(1, 3))); return; }
    }
    this.setState('idle', 1);
  }

  leave() {
    if (this.leaving) return;
    this.leaving = true;
    if (this.act) this.endAct(true);
    this.say(this.angry ? pick(['¡Me voy!', '¡Qué maleducado!', '¡Adiós, bruto!']) : pick(['¡Adiós!', '¡Hasta pronto!', '¡Chao!']), 1.6);
    this.voice(this.angry ? 'angry' : 'happy');
    this.walkTo(door.x, H / 2 - 0.035, () => { this.gone = true; }, { timeout: 15 });
  }

  /* ---------- Pose y animación ---------- */
  updateVisual(dt, t) {
    const r = this.rig, s = this.state, a = this.act;
    const lv = s === 'held' ? 30 : 18;
    this.vis.x = damp(this.vis.x, this.x, lv, dt);
    this.vis.y = damp(this.vis.y, this.y, lv, dt);
    this.vis.z = damp(this.vis.z, this.z, lv, dt);
    this.visFacing += wrap(this.facing - this.visFacing) * Math.min(1, dt * 14);
    this.gest = Math.max(0, (this.gest || 0) - dt);

    const p = standPose();
    const sad = this.isHost && this.mood() < 25;
    p.torso = Math.sin(t * 2.2 + this.x * 9) * 0.02 + (sad ? 0.22 : 0);
    if (sad) { p.pitch = 0.35; p.raiseL = p.raiseR = 0.05; }
    const callsYou = s === 'wave' || s === 'help' || (s === 'held' && this.isHost) || (s === 'door' && this.flag === 2);
    const lookUser = callsYou || (this.isHost && face.present && (s === 'idle' || s === 'look' || s === 'dizzy'));
    const pose = a ? a.def.pose : null;
    const anim = a ? a.anim : null;
    let lookTarget = null;

    if (s === 'walk' || s === 'stumble' || anim === 'kick' || pose === 'run') {
      const ph = this.walkPhase, amp = s === 'stumble' ? 0.75 : 0.55;
      p.hipL = Math.sin(ph) * amp; p.hipR = -Math.sin(ph) * amp;
      p.kneeL = 0.12 + Math.max(0, -Math.sin(ph + 0.6)) * 0.7;
      p.kneeR = 0.12 + Math.max(0, Math.sin(ph + 0.6)) * 0.7;
      p.armL = -p.hipL * 0.8; p.armR = -p.hipR * 0.8;
      p.pelvisY = 0.104 - Math.abs(Math.cos(ph)) * 0.005;
      p.torso += -0.08;
      if (s === 'stumble') { p.raiseL = 1.3 + Math.sin(t * 13) * 0.4; p.raiseR = 1.3 + Math.cos(t * 11) * 0.4; p.torso = Math.sin(t * 9) * 0.15; }
    }
    if (anim === 'sit') {
      p.hipL = p.hipR = -1.5; p.kneeL = 1.45 + Math.sin(t * 3) * 0.1; p.kneeR = 1.45 - Math.sin(t * 3) * 0.1;
      p.pelvisY = 0.012; p.armL = p.armR = -0.35; p.raiseL = p.raiseR = 0.15; p.torso = 0;
    } else if (anim === 'lie') {
      p.bodyRot = 0; p.lift = 0.03; p.raiseL = p.raiseR = 0.25; p.torso = Math.sin(t * 1.2) * 0.03; p.pitch = 0.2; p.yaw = 0;
    } else if (anim === 'dance') {
      p.raiseL = 1.6 + Math.sin(t * 9) * 1.0; p.raiseR = 1.6 - Math.sin(t * 9) * 1.0;
      p.hipL = Math.sin(t * 9) * 0.35; p.hipR = -Math.sin(t * 9) * 0.35; p.kneeL = p.kneeR = 0.3;
      p.pelvisY = 0.1 + Math.abs(Math.sin(t * 9)) * 0.01; p.torso = Math.sin(t * 4.5) * 0.15;
    }
    if (pose === 'cook') { p.armL = p.armR = -1.15 + Math.sin(t * 7) * 0.15; p.raiseL = p.raiseR = 0.1; p.pitch = 0.45; }
    if (pose === 'guitar') { p.armL = -1.0; p.raiseL = 0.35; p.armR = -0.75 + Math.sin(t * 14) * 0.25; p.raiseR = 0.1; p.pitch = 0.3; }
    if (pose === 'paint') { p.armR = -1.7 + Math.sin(t * 5) * 0.3; p.raiseR = 0.25 + Math.cos(t * 4) * 0.15; p.armL = -0.4; }
    if (pose === 'scope') { p.armL = p.armR = -1.5; p.raiseL = p.raiseR = 0.15; p.pitch = -0.55; p.torso = 0.15; }
    if (pose === 'wash') { p.armL = p.armR = -1.2 + Math.sin(t * 10) * 0.15; p.raiseL = p.raiseR = 0.1; p.pitch = 0.5; p.torso = 0.2; }
    if (pose === 'phone') { p.armR = -2.1; p.raiseR = 0.7; p.yaw = 0.3; }
    if (pose === 'pet') { p.torso = 0.75; p.pelvisY = 0.085; p.hipL = p.hipR = -0.55; p.kneeL = p.kneeR = 1.0; p.armR = -1.3 + Math.sin(t * 6) * 0.2; p.armL = -0.9; p.pitch = 0.55; }
    if (pose === 'play') { p.raiseL = 2.2 + Math.sin(t * 9) * 0.5; p.raiseR = 2.2 - Math.sin(t * 9) * 0.5; p.pelvisY = 0.104 + Math.abs(Math.sin(t * 6)) * 0.008; }
    if (pose === 'dress') { p.raiseL = p.raiseR = 1.2; }
    if (a && a.pet) lookTarget = { x: a.pet.vis.x, y: a.pet.vis.y, z: 0.03 };
    if (pose === 'type') { p.armL = p.armR = -1.25 + Math.sin(t * 22) * 0.06; p.raiseL = p.raiseR = 0.05; p.pitch = 0.1; }
    if (pose === 'eat') {
      p.armL = -1.0; p.raiseL = 0.1; p.armR = -1.6 - Math.max(0, Math.sin(t * 3.5)) * 0.9; p.raiseR = 0.2; p.pitch = 0.25;
    }
    if (pose === 'reach') { p.armR = a.t < a.dur * 0.7 ? -1.35 : -0.3; p.raiseR = 0.05; }
    if (pose === 'read') { p.armL = p.armR = -1.1; p.raiseL = p.raiseR = 0.05; p.pitch = 0.45; }
    if (pose === 'shower') { p.raiseL = 2.5 + Math.sin(t * 14) * 0.3; p.raiseR = 2.5 + Math.cos(t * 13) * 0.3; p.armL = p.armR = -0.3; p.pitch = -0.4; }
    if (pose === 'talk') {
      p.armR = this.gest > 0 ? -0.9 + Math.sin(t * 12) * 0.4 : -0.1; p.raiseR = this.gest > 0 ? 0.4 : 0.12;
      if (a.partner) lookTarget = { x: a.partner.vis.x, y: a.partner.vis.y, z: a.partner.vis.z + 0.25 };
    }
    if (pose === 'watch' && a.f) lookTarget = { x: a.f.x, y: a.f.y, z: 0.12 };
    if (s === 'fallen') {
      p.bodyRot = 0; p.lift = 0.03; p.spread = 0.35; p.raiseL = 1.25 + Math.sin(t * 2) * 0.1; p.raiseR = 1.25; p.hipL = -0.1; p.kneeR = 0.4;
    } else if (s === 'getup') {
      p.pelvisY = 0.07; p.hipL = p.hipR = -0.9; p.kneeL = p.kneeR = 1.5; p.torso = 0.5; p.armL = p.armR = -0.6;
    } else if (s === 'held') {
      p.spread = 0.15; p.hipL = Math.sin(t * 13) * 0.55; p.hipR = -Math.sin(t * 13) * 0.55; p.kneeL = p.kneeR = 0.35;
      p.raiseL = 2.5 + Math.sin(t * 15) * 0.35; p.raiseR = 2.5 + Math.cos(t * 14) * 0.35; p.pitch = -0.7;
    } else if (s === 'air') {
      p.raiseL = 2.2 + Math.sin(t * 18) * 0.3; p.raiseR = 2.2 + Math.cos(t * 17) * 0.3; p.spread = 0.3; p.hipL = -0.4; p.hipR = 0.2; p.kneeL = p.kneeR = 0.6;
    } else if (s === 'wave') {
      p.raiseR = 2.7 + Math.sin(t * 11) * 0.35; p.pitch = -1;
    } else if (s === 'help') {
      p.raiseL = 2.6 + Math.sin(t * 12) * 0.35; p.raiseR = 2.6 + Math.sin(t * 12 + 2) * 0.35; p.pitch = -1.1;
      if (this.vz !== 0) { p.kneeL = p.kneeR = 0.5; p.hipL = p.hipR = -0.3; }
    } else if (s === 'door') {
      p.armR = this.flag === 0 ? -1.35 + Math.sin(t * 20) * 0.08 : -0.2; p.raiseR = 0.05;
      if (this.flag === 1) { p.torso = 0.2; p.pitch = 0.4; }
    } else if (s === 'reach') {
      p.raiseL = p.raiseR = 2.75; p.armL = p.armR = -0.3; p.pitch = -1.2; p.pelvisY = 0.104 + Math.abs(Math.sin(t * 4)) * 0.006;
    } else if (s === 'dizzy') {
      p.torso = Math.sin(t * 6) * 0.18; p.raiseL = 0.5; p.raiseR = 0.5; p.yaw = Math.sin(t * 5) * 0.4;
    } else if (s === 'shame') {
      p.armL = p.armR = -2.3; p.raiseL = p.raiseR = 0.35; p.pitch = 0.5; p.torso = 0.25;
    }

    // Mirar: al dedo, a ti, a la otra persona o a puntos al azar
    let target = null;
    if (lookTarget) target = lookTarget;
    else if (this.isHost && (s === 'reach' || (finger.follow && UPRIGHT.has(s)))) target = { x: finger.x, y: finger.y, z: D };
    else if (this.look && t < this.lookT) target = this.look;
    else if (lookUser) target = { x: eye.x, y: eye.y, z: D + eye.z };
    else if (this.waitFor) target = { x: this.waitFor.vis.x, y: this.waitFor.vis.y, z: 0.25 };
    else if ((s === 'idle' || s === 'look') && Math.random() < dt * (s === 'look' ? 0.9 : 0.3)) {
      this.look = { x: rand(-W / 2, W / 2), y: rand(-H / 2, H / 2), z: rand(0, D * 0.8) };
      this.lookT = t + rand(0.8, 2);
    }
    if (target && s !== 'fallen' && anim !== 'lie' && s !== 'getup' && s !== 'shame') {
      const hx = this.vis.x, hy = this.vis.y, hz = this.vis.z + 0.25;
      const dx = target.x - hx, dy = target.y - hy, dz = target.z - hz, hor = Math.hypot(dx, dy);
      const yaw = hor > 0.02 ? wrap(Math.atan2(dy, dx) - this.visFacing) : 0;
      if ((s === 'idle' || s === 'look') && Math.abs(yaw) > 1.3) this.targetFacing = Math.atan2(dy, dx);
      p.yaw = clamp(yaw, -1.3, 1.3) * clamp(hor / (Math.abs(dz) * 0.6 + 0.01), 0.15, 1);
      p.pitch = clamp(-Math.atan2(dz, hor), -1.25, 0.6);
    }

    const rate = s === 'fallen' || s === 'getup' || anim === 'lie' ? 9 : 16;
    for (const k of POSE_KEYS) this.pose[k] = damp(this.pose[k], p[k], rate, dt);
    const P = this.pose;

    let lx = 0, ly = 0;
    if (s === 'held') { lx = clamp(grab.vx * 0.35, -0.7, 0.7); ly = clamp(-grab.vy * 0.35, -0.7, 0.7); }
    else if (UPRIGHT.has(s) || s === 'stumble' || (s === 'act' && !a.seat && anim !== 'lie')) { lx = clamp(-tilt.x, -0.5, 0.5) * 0.9; ly = clamp(tilt.y, -0.5, 0.5) * 0.9; }
    r.lean.rotation.y = damp(r.lean.rotation.y, lx, 10, dt);
    r.lean.rotation.x = damp(r.lean.rotation.x, ly, 10, dt);

    r.root.position.set(this.vis.x, this.vis.y, this.vis.z + P.lift);
    r.heading.rotation.z = this.visFacing + HALF_PI;
    r.body.rotation.x = P.bodyRot;
    r.pelvis.position.y = P.pelvisY;
    r.chest.rotation.x = P.torso;
    r.hipL.rotation.set(P.hipL, 0, P.spread);
    r.hipR.rotation.set(P.hipR, 0, -P.spread);
    r.kneeL.rotation.x = P.kneeL;
    r.kneeR.rotation.x = P.kneeR;
    r.shL.rotation.set(P.armL, 0, P.raiseL);
    r.shR.rotation.set(P.armR, 0, -P.raiseR);
    r.head.rotation.set(P.pitch, P.yaw, 0, 'YXZ');

    for (const k in r.items) r.items[k].visible = this.holding === k;
    const dizzy = s === 'dizzy' || (s === 'getup' && this.hard) || (s === 'fallen' && this.hard && this.st > 0.5);
    r.stars.visible = dizzy;
    if (dizzy) r.stars.rotation.y = t * 5;

    const stinky = this.isHost && this.needs.hygiene < 25;
    r.stink.forEach((m, i) => {
      m.visible = stinky;
      if (!stinky) return;
      const ph = (t * 0.5 + i / 4) % 1;
      m.position.set(Math.sin(t * 3 + i * 2) * 0.03 + (i - 1.5) * 0.02, Math.cos(i * 1.7) * 0.03, 0.12 + ph * 0.25);
      m.scale.setScalar(1 - ph * 0.6);
    });
    const showering = pose === 'shower';
    r.drops.forEach((m, i) => {
      m.visible = showering;
      if (!showering) return;
      const ph = (t * 1.8 + i / 8) % 1;
      m.position.set(Math.cos(i * 2.4) * 0.035, Math.sin(i * 2.4) * 0.035, 0.32 - ph * 0.32);
    });
  }

  updateBubble(dt) {
    if (this.bubbleT <= 0) return;
    this.bubbleT -= dt;
    if (this.bubbleT <= 0) { this.bubbleEl.classList.remove('show'); return; }
    const lying = this.state === 'fallen' || (this.act && this.act.anim === 'lie');
    projV.set(this.vis.x, this.vis.y, this.vis.z + (lying ? 0.08 : HUMAN_H + 0.03)).project(camera);
    const R = viewRect;
    const x = R.left + (projV.x * 0.5 + 0.5) * R.width, y = R.top + (-projV.y * 0.5 + 0.5) * R.height;
    const bw = this.bubbleEl.offsetWidth;
    const cx = clamp(x, bw / 2 + 6, innerWidth - bw / 2 - 6);
    this.bubbleEl.style.transform = `translate(${Math.round(cx - bw / 2)}px, ${Math.round(Math.max(R.top + 4, y - this.bubbleEl.offsetHeight - 10))}px)`;
  }
}
const projV = new THREE.Vector3();

/* =====================================================================
 *  Mascotas
 * ===================================================================== */
const PET_KINDS = {
  dog: { label: 'Perro', icon: '🐶', price: 150, names: ['Toby', 'Luna', 'Rocky', 'Kira', 'Coco', 'Bruc'], coats: [['#b7793f', '#f1e2c6'], ['#2a2420', '#e8e0d0'], ['#e8d6b0', '#fff6e6'], ['#8a8a90', '#e0e0e0']], speed: 0.3 },
  cat: { label: 'Gato', icon: '🐱', price: 120, names: ['Misi', 'Nube', 'Garfio', 'Mia', 'Tom', 'Pelusa'], coats: [['#e08a3c', '#fff0dc'], ['#2a2630', '#e8e0d0'], ['#9a9aa2', '#e6e6ea'], ['#f4efe6', '#e8c8a0']], speed: 0.26 },
  bunny: { label: 'Conejo', icon: '🐰', price: 90, names: ['Copito', 'Tambor', 'Nieve', 'Bolita', 'Saltarín'], coats: [['#f4f1ea', '#f2b8c0'], ['#a07a5a', '#f4e6d6'], ['#5a5a60', '#e6e6ea']], speed: 0.22 },
};
const pets = [];
const PETTING = { id: 'petting', label: 'Acariciar', anim: 'stand', pose: 'pet', dur: 5, rates: { fun: 3, social: 2.5 } };
const PLAYPET = { id: 'playpet', label: 'Jugar', anim: 'stand', pose: 'play', dur: 8, rates: { fun: 5, energy: -0.8, social: 1.5 } };

class Pet {
  constructor(kind, data = {}) {
    this.kind = kind; this.K = PET_KINDS[kind];
    this.name = data.name || pick(this.K.names);
    this.coat = data.coat || pick(this.K.coats);
    this.hunger = data.hunger ?? 80; this.love = data.love ?? 60; this.energy = data.energy ?? 90;
    this.x = 0; this.y = 0; this.z = 0; this.vx = 0; this.vy = 0; this.vz = 0;
    this.facing = rand(-3, 3); this.targetFacing = this.facing; this.spin = 0;
    this.state = 'idle'; this.st = 0; this.dur = 1; this.target = null; this.walkPhase = 0;
    this.vis = { x: 0, y: 0, z: 0 }; this.visFacing = this.facing;
    this.on = null; this.thrown = false; this.with = null; this.isPet = true; this.isHost = false; this.act = null; this.holding = null;
    this.poopT = rand(160, 380); this.wag = 0; this.p = { pitch: 1 }; this.lookAt = null; this.heartT = 0;
    this.buildRig();
    this.bubbleEl = document.createElement('div');
    this.bubbleEl.className = 'bubble';
    document.body.appendChild(this.bubbleEl);
    this.bubbleT = 0;
    pets.push(this);
  }

  buildRig() {
    const r = (this.rig = {}), k = this.kind;
    const fur = mat(this.coat[0]), light = mat(this.coat[1]), dark = mat('#1e1a1a');
    r.root = new THREE.Group(); r.heading = new THREE.Group(); r.body = new THREE.Group();
    r.root.add(r.heading); r.heading.add(r.body);
    const bx = (w, d, h, m, x, y, z, parent = r.body) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), m); b.position.set(x, y, z); b.castShadow = true; parent.add(b); return b; };
    const sph = (rad, m, x, y, z, parent = r.body) => { const b = new THREE.Mesh(new THREE.IcosahedronGeometry(rad, 0), m); b.position.set(x, y, z); b.castShadow = true; parent.add(b); return b; };
    r.legs = [];
    const leg = (x, y, h, w) => { const g = new THREE.Group(); g.position.set(x, y, h); r.body.add(g); bx(w, w, h, fur, 0, 0, -h / 2, g); r.legs.push(g); };
    r.head = new THREE.Group(); r.body.add(r.head);
    r.tail = new THREE.Group(); r.body.add(r.tail);
    if (k === 'dog') {
      bx(0.085, 0.04, 0.04, fur, 0, 0, 0.055);
      bx(0.03, 0.036, 0.036, light, 0.03, 0, 0.052);
      r.head.position.set(0.05, 0, 0.082);
      bx(0.04, 0.036, 0.036, fur, 0, 0, 0, r.head);
      bx(0.022, 0.022, 0.018, light, 0.026, 0, -0.007, r.head);
      bx(0.007, 0.009, 0.007, dark, 0.038, 0, -0.002, r.head);
      for (const s of [-1, 1]) { bx(0.006, 0.006, 0.006, dark, 0.016, s * 0.011, 0.008, r.head); bx(0.014, 0.006, 0.026, mat(this.coat[0] === '#2a2420' ? '#4a3a30' : '#8a5a2a'), -0.004, s * 0.021, -0.006, r.head); }
      for (const [x, y] of [[0.03, 0.013], [0.03, -0.013], [-0.03, 0.013], [-0.03, -0.013]]) leg(x, y, 0.036, 0.012);
      r.tail.position.set(-0.044, 0, 0.068); bx(0.006, 0.006, 0.032, fur, 0, 0, 0.016, r.tail); r.tail.rotation.y = -0.6;
    } else if (k === 'cat') {
      bx(0.075, 0.03, 0.03, fur, 0, 0, 0.05);
      r.head.position.set(0.045, 0, 0.072);
      bx(0.032, 0.034, 0.03, fur, 0, 0, 0, r.head);
      bx(0.012, 0.016, 0.01, light, 0.017, 0, -0.007, r.head);
      for (const s of [-1, 1]) {
        bx(0.006, 0.006, 0.006, mat('#5fae4a'), 0.016, s * 0.009, 0.004, r.head);
        const ear = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.016, 4), fur); ear.rotation.x = HALF_PI; ear.position.set(-0.002, s * 0.011, 0.021); r.head.add(ear);
      }
      for (const [x, y] of [[0.026, 0.01], [0.026, -0.01], [-0.026, 0.01], [-0.026, -0.01]]) leg(x, y, 0.035, 0.009);
      r.tail.position.set(-0.038, 0, 0.058);
      bx(0.005, 0.005, 0.06, fur, 0, 0, 0.03, r.tail); r.tail.rotation.y = -0.35;
    } else {
      const b = sph(0.03, fur, -0.005, 0, 0.04); b.scale.set(1.25, 1, 0.95);
      r.head.position.set(0.033, 0, 0.062);
      sph(0.021, fur, 0, 0, 0, r.head);
      for (const s of [-1, 1]) {
        bx(0.005, 0.005, 0.005, dark, 0.018, s * 0.009, 0.004, r.head);
        const ear = new THREE.Group(); ear.position.set(-0.004, s * 0.008, 0.012); ear.rotation.x = s * 0.15; r.head.add(ear);
        bx(0.008, 0.012, 0.04, fur, 0, 0, 0.02, ear); bx(0.003, 0.007, 0.03, light, 0.003, 0, 0.02, ear);
      }
      bx(0.004, 0.006, 0.004, mat('#f08aa0'), 0.021, 0, -0.002, r.head);
      for (const [x, y] of [[0.02, 0.012], [0.02, -0.012], [-0.02, 0.017], [-0.02, -0.017]]) leg(x, y, 0.02, 0.012);
      r.tail.position.set(-0.04, 0, 0.045);
      sph(0.011, light, 0, 0, 0, r.tail);
    }
    r.stars = new THREE.Group(); r.stars.position.set(0, 0, 0.04); r.head.add(r.stars);
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.008, 0), new THREE.MeshBasicMaterial({ color: '#f0c03e' }));
      const a = (i / 3) * Math.PI * 2; s.position.set(Math.cos(a) * 0.03, Math.sin(a) * 0.03, 0); r.stars.add(s);
    }
    r.stars.visible = false;
    scene.add(r.root);
  }

  destroy() {
    scene.remove(this.rig.root);
    this.bubbleEl.remove();
    const i = pets.indexOf(this);
    if (i >= 0) pets.splice(i, 1);
    if (grab.agent === this) grab.agent = null;
    for (const a of agents) if (a.act && a.act.pet === this) a.endAct(true);
  }

  place(x, y) { this.x = this.vis.x = x; this.y = this.vis.y = y; this.z = this.vis.z = groundAt(x, y).z; }
  setState(s, dur = 0) { this.state = s; this.st = 0; this.dur = dur; if (s !== 'walk') this.target = null; if (s !== 'petted' && s !== 'play') this.with = null; }
  endAct() {}
  addNeed() {}
  say(text, dur = 1.4) { this.bubbleEl.textContent = text; this.bubbleEl.classList.remove('thought'); this.bubbleT = dur; this.bubbleEl.classList.add('show'); }
  voice() { if (this.kind === 'dog') audio.woof(); else if (this.kind === 'cat') audio.meow(); else audio.squeak(); }
  sound() { return this.kind === 'dog' ? pick(['¡Guau!', '¡Guau, guau!', 'Grrr… ¡guau!']) : this.kind === 'cat' ? pick(['Miau', '¡Miaaau!', 'Prrr…']) : pick(['¡Iiik!', '*olfatea*', '¡Ñic!']); }
  canInteract() { return ['idle', 'walk', 'wait', 'beg', 'look'].includes(this.state) && this.z < 0.05; }

  walkTo(x, y, done, fast = false) {
    this.setState('walk');
    this.target = { x: clamp(x, -W / 2 + 0.04, W / 2 - 0.04), y: clamp(y, -H / 2 + 0.04, H / 2 - 0.04), done, fast };
  }

  wait(agent, dur) { if (this.state === 'sleep') return; this.setState('wait', dur); this.lookAt = agent; }
  beginInteraction(agent, mode, dur) { this.setState(mode === 'play' ? 'play' : 'petted', dur + 0.5); this.with = agent; this.lookAt = agent; }

  pet(byUser) {
    if (this.state === 'sleep') { this.setState('idle', 1); this.say(this.kind === 'cat' ? '¡Fffff!' : '*bosteza*', 1.2); this.voice(); return; }
    this.love = Math.min(100, this.love + 14);
    this.wag = 2.5;
    this.say('♥', 1.2);
    if (byUser && host) host.addNeed('fun', 2);
    this.voice();
    if (this.state !== 'held') { this.setState('wait', 1.5); this.lookAt = null; }
  }

  callToEat(f) {
    if (this.state === 'sleep' || this.state === 'held' || this.state === 'air') return;
    const spots = [[0, 0.05], [0, -0.05], [0.05, 0], [-0.05, 0]].map(([dx, dy]) => [f.x + dx, f.y + dy]).filter(([x, y]) => isFree(x, y, 0.025));
    if (!spots.length) return;
    spots.sort((a, b) => Math.hypot(a[0] - this.x, a[1] - this.y) - Math.hypot(b[0] - this.x, b[1] - this.y));
    this.walkTo(spots[0][0], spots[0][1], () => { this.setState('eat', 4); this.bowl = f; }, true);
  }

  step(dt) {
    this.st += dt;
    this.spin *= Math.exp(-dt * 2.5);
    this.wag = Math.max(0, this.wag - dt);
    const sp = settings.speed;
    const sleeping = this.state === 'sleep';
    this.hunger = clamp(this.hunger - 0.05 * sp * dt, 0, 100);
    this.love = clamp(this.love - 0.035 * sp * dt, 0, 100);
    this.energy = clamp(this.energy + (sleeping ? 3 : -0.035 * sp) * dt, 0, 100);
    const tm = tilt.length();

    if (this.state === 'held') {
      const nx = damp(this.x, grab.x, 22, dt), ny = damp(this.y, grab.y, 22, dt);
      grab.vx = damp(grab.vx, (nx - this.x) / dt, 14, dt);
      grab.vy = damp(grab.vy, (ny - this.y) / dt, 14, dt);
      this.x = clamp(nx, -W / 2 + 0.03, W / 2 - 0.03); this.y = clamp(ny, -H / 2 + 0.03, H / 2 - 0.03);
      this.z = damp(this.z, liftZ() + 0.1, 9, dt);
      this.vx = this.vy = this.vz = 0;
      return;
    }

    if (this.on && furn.includes(this.on)) { this.x += this.on.dx; this.y += this.on.dy; }
    let sup = groundAt(this.x, this.y);
    const grounded = this.z <= sup.z + 0.004 && this.vz <= 0.01;
    if (grounded) {
      this.z = sup.z; this.vz = 0; this.on = sup.f;
      if (this.state === 'air' || this.state === 'jump') {
        const next = this.afterJump; this.afterJump = null;
        this.setState(this.thrown ? 'dizzy' : 'idle', this.thrown ? 1.5 : 0.4);
        this.thrown = false;
        if (next) next();
      }
      if (tm > 0.3 && !['slide', 'dizzy', 'sleep'].includes(this.state)) { this.setState('slide'); this.say('!', 0.8); this.voice(); }
      if (this.state === 'slide' && tm < 0.15 && this.st > 0.5) this.setState('idle', 0.5);
      if (this.state === 'slide' || (this.state === 'sleep' && tm > 0.3)) {
        this.vx += tilt.x * G * dt; this.vy += tilt.y * G * dt;
        const s = Math.hypot(this.vx, this.vy); if (s > 1e-4) { const ns = Math.max(0, s - 0.1 * G * dt); this.vx *= ns / s; this.vy *= ns / s; }
      } else {
        let dx = 0, dy = 0;
        if (this.state === 'walk' && this.target) {
          const t = this.target, ex = t.x - this.x, ey = t.y - this.y, d = Math.hypot(ex, ey);
          if (d < 0.015 || this.st > 9) { const done = d < 0.05 ? t.done : null; this.setState('idle', rand(0.5, 1.5)); if (done) done(); }
          else {
            const s = this.K.speed * (t.fast ? 1.3 : 0.75) * Math.min(1, d / 0.05 + 0.4);
            let ang = Math.atan2(ey, ex);
            // Si no avanza, rodea el obstáculo
            t.chk = (t.chk || 0) + dt;
            if (t.chk > 0.4) { if (Math.hypot(this.x - (t.lx ?? 9), this.y - (t.ly ?? 9)) < s * t.chk * 0.3) { t.avoid = 0.5; t.side = Math.random() < 0.5 ? -1 : 1; } t.lx = this.x; t.ly = this.y; t.chk = 0; }
            if (t.avoid > 0) { ang += t.side * 1.2; t.avoid -= dt; }
            dx = Math.cos(ang) * s; dy = Math.sin(ang) * s;
            this.targetFacing = ang;
            this.walkPhase += dt * s * 90;
          }
        } else if (this.state === 'play' && this.with) {
          const a = Math.atan2(this.y - this.with.y, this.x - this.with.x) + 0.9;
          const tx = this.with.x + Math.cos(a) * 0.09, ty = this.with.y + Math.sin(a) * 0.09;
          dx = (tx - this.x) * 3; dy = (ty - this.y) * 3;
          this.targetFacing = Math.atan2(dy, dx);
          this.walkPhase += dt * 16;
          if ((this.st % 0.7) < dt) this.vz = 0.55;
        } else if (this.state === 'chase' && this.ball) {
          const b = this.ball, ex = b.x - this.x, ey = b.y - this.y, d = Math.hypot(ex, ey) || 1;
          dx = (ex / d) * this.K.speed * 1.4; dy = (ey / d) * this.K.speed * 1.4;
          this.targetFacing = Math.atan2(ey, ex);
          this.walkPhase += dt * 20;
        }
        this.vx = damp(this.vx, dx + tilt.x * 0.25, 12, dt);
        this.vy = damp(this.vy, dy + tilt.y * 0.25, 12, dt);
      }
    } else {
      this.vz -= GZ * dt; this.on = null;
      if (!['air', 'jump', 'play'].includes(this.state) && this.z - sup.z > 0.04) this.setState('air');
    }

    const px = this.x, py = this.y;
    this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
    let impact = this.state === 'jump' ? 0 : Agent.prototype.collideFurn.call(this, px, py);
    impact = Math.max(impact, Agent.prototype.walls.call(this));
    if (this.z + 0.12 > D && this.vz > 0) { this.z = D - 0.12; this.vz = -this.vz * 0.25; audio.bonk(); shakeScreen(); this.love = Math.max(0, this.love - 5); }
    sup = groundAt(this.x, this.y);
    if (this.z < sup.z) {
      const fs = -this.vz;
      this.z = sup.z; this.vz = 0; this.on = sup.f;
      if (this.state === 'air' || this.state === 'jump' || this.state === 'play') {
        if (this.state !== 'play') {
          const next = this.afterJump; this.afterJump = null;
          this.setState(this.thrown || fs > 1.6 ? 'dizzy' : 'idle', 1.4);
          if (this.thrown) { this.say(this.kind === 'cat' ? '¡Fffff!' : '¡Ay!', 1); audio.thud(0.1); }
          this.thrown = false;
          if (next) next();
        }
      }
    }
    if (impact > 0.8 && this.state === 'air') { audio.thud(0.2); this.setState('dizzy', 1.6); }
    this.behave(dt);
    this.facing += clamp(wrap(this.targetFacing - this.facing), -8 * dt, 8 * dt) + this.spin * dt;
  }

  behave(dt) {
    switch (this.state) {
      case 'idle': case 'look':
        if (this.st > this.dur) this.think();
        break;
      case 'wait': case 'beg':
        if (this.lookAt) this.targetFacing = Math.atan2(this.lookAt.y - this.y, this.lookAt.x - this.x);
        if (this.state === 'beg' && (this.st % 2.5) < dt) { this.say(this.hunger < 40 ? '🍖?' : '♥?', 1.4); this.voice(); }
        if (this.st > this.dur) this.setState('idle', 0.5);
        break;
      case 'eat': {
        const b = this.bowl;
        if (!b || !furn.includes(b) || b.food <= 0) { this.setState('idle', 0.5); break; }
        this.targetFacing = Math.atan2(b.y - this.y, b.x - this.x);
        this.hunger = Math.min(100, this.hunger + 14 * dt);
        if (this.st > this.dur) { b.food = Math.max(0, b.food - 1); this.setState('idle', 1); this.say('*ñam*', 1); }
        break;
      }
      case 'sleep':
        if ((this.st % 3) < dt) this.say('z Z', 1.4);
        if (this.energy >= 99 || this.st > this.dur) { this.setState('idle', 1); }
        break;
      case 'petted': case 'play':
        this.love = Math.min(100, this.love + (this.state === 'petted' ? 9 : 6) * dt);
        this.wag = 1;
        if (this.state === 'play') this.energy -= 0.6 * dt;
        if ((this.st % 1.3) < dt) this.say(this.state === 'petted' ? '♥' : this.sound(), 1);
        if (!this.with || !this.with.act || this.with.act.pet !== this || this.st > this.dur) this.setState('idle', 1);
        break;
      case 'chase': {
        const b = this.ball;
        if (!b || !furn.includes(b) || this.st > this.dur) { this.setState('idle', 1); break; }
        this.love = Math.min(100, this.love + 1.5 * dt);
        if ((this.st % 2) < dt && Math.random() < 0.5) this.say(this.sound(), 0.8);
        break;
      }
      case 'scratch':
        if ((this.st % 0.4) < dt) audio.noiseHit(0.05, 0.08, 3000, 'highpass');
        this.love = Math.min(100, this.love + 1 * dt);
        if (this.st > this.dur) this.setState('idle', 1);
        break;
      case 'dizzy':
        if (this.st > this.dur) this.setState('idle', 0.5);
        break;
    }
    // Hacer sus necesidades… en el suelo
    this.poopT -= dt * settings.speed * (this.hunger > 80 ? 1.3 : 1);
    if (this.poopT <= 0 && (this.state === 'idle' || this.state === 'walk') && this.z < 0.01) {
      this.poopT = rand(220, 460);
      addPuddle(this.x - Math.cos(this.facing) * 0.04, this.y - Math.sin(this.facing) * 0.04, 'poop');
      this.say('…', 1);
      toast(`¡${this.name} ha hecho caca! Toca para limpiarla.`);
    }
  }

  think() {
    const opts = [];
    const bowl = furn.filter((f) => f.type === 'bowl').sort((a, b) => (b.food || 0) - (a.food || 0))[0];
    if (this.hunger < 50 && bowl && bowl.food > 0) opts.push(['eat', 6]);
    else if (this.hunger < 35 && host) opts.push(['beg', 3]);
    if (this.energy < 35) opts.push(['sleep', 6]);
    if (this.love < 50 && host) opts.push(['beg', 2]);
    const ball = furn.find((f) => f.type === 'ball');
    if (ball && this.kind !== 'bunny' && this.energy > 40) opts.push(['chase', this.kind === 'dog' ? 2 : 0.8]);
    const scr = furn.find((f) => f.type === 'scratcher');
    if (scr && this.kind === 'cat') opts.push(['scratch', 1.2]);
    if (host) opts.push(['follow', 1.5]);
    opts.push(['wander', 2.5], ['look', 1]);
    let total = opts.reduce((s, o) => s + o[1], 0), r = Math.random() * total, c = 'wander';
    for (const [k, w] of opts) { if ((r -= w) <= 0) { c = k; break; } }
    switch (c) {
      case 'eat': this.callToEat(bowl); return;
      case 'beg': {
        const a = Math.atan2(this.y - host.y, this.x - host.x);
        this.walkTo(host.x + Math.cos(a) * 0.08, host.y + Math.sin(a) * 0.08, () => { this.setState('beg', 5); this.lookAt = host; });
        return;
      }
      case 'sleep': {
        const bed = furn.find((f) => f.type === 'petbed');
        const soft = furn.filter((f) => ['bed', 'sofa', 'armchair', 'scratcher'].includes(f.type));
        if (this.kind === 'cat' && soft.length && Math.random() < 0.7) {
          const f = pick(soft);
          const [ax, ay] = toWorld(f, 0, f.lhy + 0.04);
          this.walkTo(ax, ay, () => this.jumpTo(f.x + rand(-0.03, 0.03), f.y + rand(-0.02, 0.02), () => this.setState('sleep', rand(25, 45))));
          return;
        }
        if (bed) { this.walkTo(bed.x, bed.y, () => this.setState('sleep', rand(25, 45))); return; }
        this.setState('sleep', rand(20, 35));
        return;
      }
      case 'chase': this.setState('chase', rand(6, 11)); this.ball = ball; return;
      case 'scratch': {
        const [ax, ay] = toWorld(scr, 0, scr.lhy + 0.03);
        this.walkTo(ax, ay, () => { this.setState('scratch', 4); this.targetFacing = Math.atan2(scr.y - this.y, scr.x - this.x); });
        return;
      }
      case 'follow': {
        const a = rand(0, Math.PI * 2);
        this.walkTo(host.x + Math.cos(a) * 0.1, host.y + Math.sin(a) * 0.1, () => { this.setState('wait', rand(1.5, 3)); this.lookAt = host; });
        return;
      }
      case 'look': this.setState('look', rand(1.5, 3)); return;
    }
    for (let i = 0; i < 15; i++) {
      const x = rand(-W / 2 + 0.05, W / 2 - 0.05), y = rand(-H / 2 + 0.05, H / 2 - 0.05);
      if (isFree(x, y, 0.04)) { this.walkTo(x, y, () => this.setState('idle', rand(1, 3))); return; }
    }
    this.setState('idle', 1);
  }

  jumpTo(x, y, then) {
    const T = 0.42, z = groundAt(x, y).z;
    this.vx = (x - this.x) / T; this.vy = (y - this.y) / T;
    this.vz = (z - this.z) / T + 0.5 * GZ * T;
    this.targetFacing = Math.atan2(y - this.y, x - this.x);
    this.setState('jump');
    this.afterJump = then;
  }

  updateVisual(dt, t) {
    const r = this.rig, s = this.state;
    const lv = s === 'held' ? 30 : 18;
    this.vis.x = damp(this.vis.x, this.x, lv, dt);
    this.vis.y = damp(this.vis.y, this.y, lv, dt);
    this.vis.z = damp(this.vis.z, this.z, lv, dt);
    this.visFacing += wrap(this.facing - this.visFacing) * Math.min(1, dt * 12);
    const moving = s === 'walk' || s === 'chase' || s === 'play' || s === 'slide';
    let hop = 0, bodyPitch = 0, bodyZ = 0, legA = 0, legSpread = 0, headPitch = 0, headYaw = 0;
    if (moving) legA = 0.6;
    if (this.kind === 'bunny' && (s === 'walk' || s === 'chase')) { hop = Math.abs(Math.sin(this.walkPhase * 0.5)) * 0.025; legA = 0.3; }
    if (s === 'sleep') { bodyZ = -0.018; legSpread = 1.35; headPitch = 0.35; }
    if (s === 'eat') headPitch = 0.7 + Math.sin(t * 10) * 0.1;
    if (s === 'wait' || s === 'beg' || s === 'petted') { bodyPitch = -0.45; headPitch = -0.5; }
    if (s === 'held') { legA = 0; legSpread = 0.4 + Math.sin(t * 14) * 0.3; bodyPitch = 0.3; headPitch = -0.6; }
    if (s === 'slide') { legSpread = 0.9; headPitch = -0.3; }
    if (s === 'scratch') { bodyPitch = -0.9; legA = 0.4; }
    if (s === 'air' || s === 'jump') { legSpread = 0.7; }
    if (this.lookAt && (s === 'wait' || s === 'beg' || s === 'petted' || s === 'play')) {
      headYaw = clamp(wrap(Math.atan2(this.lookAt.y - this.y, this.lookAt.x - this.x) - this.visFacing), -0.9, 0.9);
    }
    r.root.position.set(this.vis.x, this.vis.y, this.vis.z + hop);
    r.heading.rotation.z = this.visFacing;
    r.body.position.z = damp(r.body.position.z, bodyZ, 8, dt);
    r.body.rotation.y = damp(r.body.rotation.y, bodyPitch, 8, dt);
    r.body.rotation.x = s === 'air' && this.thrown ? r.body.rotation.x + dt * 12 : damp(r.body.rotation.x, 0, 8, dt);
    r.legs.forEach((g, i) => {
      const side = i % 2 === 0 ? 1 : -1, front = i < 2 ? 1 : -1;
      const swing = Math.sin(this.walkPhase + (i === 0 || i === 3 ? 0 : Math.PI)) * legA;
      g.rotation.y = swing - front * legSpread;
      g.rotation.x = 0;
      void side;
    });
    r.head.rotation.y = damp(r.head.rotation.y, headPitch, 10, dt);
    r.head.rotation.z = damp(r.head.rotation.z, headYaw, 10, dt);
    const wagging = this.wag > 0 || (this.love > 75 && s !== 'sleep');
    r.tail.rotation.z = wagging ? Math.sin(t * (this.kind === 'dog' ? 22 : 8)) * 0.7 : damp(r.tail.rotation.z, 0, 4, dt);
    r.stars.visible = s === 'dizzy';
    if (s === 'dizzy') r.stars.rotation.z = t * 5;
  }

  updateBubble(dt) { followBubble(this, dt, this.state === 'held' ? 0.16 : 0.12); }
}

function followBubble(o, dt, h) {
  if (o.bubbleT <= 0) return;
  o.bubbleT -= dt;
  if (o.bubbleT <= 0) { o.bubbleEl.classList.remove('show'); return; }
  projV.set(o.vis.x, o.vis.y, o.vis.z + h).project(camera);
  const R = viewRect;
  const x = R.left + (projV.x * 0.5 + 0.5) * R.width, y = R.top + (-projV.y * 0.5 + 0.5) * R.height;
  const bw = o.bubbleEl.offsetWidth;
  const cx = clamp(x, bw / 2 + 6, innerWidth - bw / 2 - 6);
  o.bubbleEl.style.transform = `translate(${Math.round(cx - bw / 2)}px, ${Math.round(Math.max(R.top + 4, y - o.bubbleEl.offsetHeight - 10))}px)`;
}

function adoptPet(kind) {
  const K = PET_KINDS[kind];
  if (pets.length >= 3) { toast('Ya tienes 3 mascotas: ¡no caben más!'); return; }
  if (money < K.price) return;
  money -= K.price;
  const p = new Pet(kind);
  p.place(door.x, H / 2 - 0.04);
  p.entering = true;
  p.walkTo(door.x + rand(-0.05, 0.05), H / 2 - 0.22, () => { p.entering = false; p.say(p.sound(), 1.4); p.voice(); }, true);
  audio.cash(true);
  $('shop').hidden = true;
  toast(`${K.icon} ¡${p.name} vive ahora contigo!`);
  if (host && UPRIGHT.has(host.state)) { host.say(pick([`¡${p.name}!`, '¡Una mascota!', '¡Qué cosita!']), 1.6); host.voice('happy'); host.addNeed('fun', 15); host.addNeed('social', 10); }
  buildPetHUD();
  resize();
  save();
}

/* =====================================================================
 *  Ropa
 * ===================================================================== */
const CLOTHES = {
  top: [{ id: 'tee', name: 'Camiseta', price: 0 }, { id: 'tank', name: 'Tirantes', price: 0 }, { id: 'hoodie', name: 'Sudadera', price: 40 }, { id: 'dress', name: 'Vestido', price: 60 }, { id: 'suit', name: 'Traje', price: 120 }],
  acc: [{ id: 'none', name: 'Nada', price: 0 }, { id: 'bow', name: 'Lazo', price: 20 }, { id: 'cap', name: 'Gorra', price: 25 }, { id: 'glasses', name: 'Gafas de sol', price: 30 }, { id: 'headphones', name: 'Auriculares', price: 50 }, { id: 'tophat', name: 'Chistera', price: 80 }, { id: 'crown', name: 'Corona', price: 300 }],
  hairStyle: [{ id: 'short', name: 'Corto', price: 0 }, { id: 'long', name: 'Largo', price: 0 }, { id: 'bun', name: 'Moño', price: 0 }, { id: 'flat', name: 'Cepillo', price: 0 }, { id: 'bald', name: 'Rapado', price: 0 }],
};
const PALETTE = {
  shirt: ['#3f8f7f', '#d0574e', '#4f78b0', '#e3c26a', '#7d3f9b', '#e98fb0', '#f4f1ea', '#2a2630', '#f08a3c', '#5f9a55'],
  pants: ['#2f3d63', '#3a3a3a', '#6a4529', '#5a6a8a', '#e8dcc0', '#7d3f5b', '#4d6f3f', '#c0504a'],
  hair: ['#5a3a22', '#1a1410', '#b4532a', '#e2c26a', '#e6e2da', '#8a2a3a', '#4f78b0', '#e98fb0'],
  skin: ['#f2d2b6', '#e8b996', '#c68a62', '#a86f4c', '#8a5a3c', '#5f3b26'],
  accColor: ['#c0504a', '#4f78b0', '#2a2630', '#e98fb0', '#5f9a55', '#e3c26a'],
};
let unlocked = new Set(['tee', 'tank', 'none', 'short', 'long', 'bun', 'flat', 'bald']);
let wardrobeFurn = null, dressChanged = false, wTab = 'ropa';

function openWardrobe(f, tab = 'ropa') {
  wardrobeFurn = f;
  dressChanged = false;
  wTab = tab;
  renderWardrobe();
  $('wardrobe').hidden = false;
  audio.menu();
}
function renderWardrobe() {
  const body = $('wardrobe-body');
  body.innerHTML = '';
  const p = host.p;
  const tabs = document.createElement('div');
  tabs.className = 'wtabs';
  for (const [id, label] of [['ropa', 'Ropa'], ['cara', 'Cara y cuerpo']]) {
    const b = document.createElement('button');
    b.className = 'tab' + (wTab === id ? ' sel' : '');
    b.textContent = label;
    b.addEventListener('click', () => { wTab = id; renderWardrobe(); audio.menu(); });
    tabs.appendChild(b);
  }
  body.appendChild(tabs);
  const look = (title, key) => {
    const row = section(title);
    const cur = p[key] || LOOKS[key][key === 'height' ? 1 : 0][0];
    for (const [id, name] of LOOKS[key]) {
      const b = document.createElement('button');
      b.className = 'wopt' + (cur === id ? ' sel' : '');
      b.textContent = name;
      b.addEventListener('click', () => { p[key] = id; dressChanged = true; host.rebuildRig(); renderWardrobe(); });
      row.appendChild(b);
    }
  };
  const section = (title) => { const h = document.createElement('div'); h.className = 'wsec'; h.textContent = title; body.appendChild(h); const row = document.createElement('div'); row.className = 'wrow'; body.appendChild(row); return row; };
  const opts = (title, key, list) => {
    const row = section(title);
    for (const o of list) {
      const b = document.createElement('button');
      const owned = unlocked.has(o.id);
      b.className = 'wopt' + ((p[key] || list[0].id) === o.id ? ' sel' : '');
      b.textContent = owned ? o.name : `${o.name} ${o.price}◎`;
      b.disabled = !owned && money < o.price;
      b.addEventListener('click', () => {
        if (!unlocked.has(o.id)) { money -= o.price; unlocked.add(o.id); audio.cash(true); toast(`Has comprado: ${o.name}`); }
        p[key] = o.id; dressChanged = true; host.rebuildRig(); renderWardrobe(); save();
      });
      row.appendChild(b);
    }
  };
  const colors = (title, key, list = PALETTE[key]) => {
    const row = section(title);
    for (const c of list) {
      const b = document.createElement('button');
      b.className = 'sw' + ((p[key] || list[0]) === c ? ' sel' : '');
      b.style.background = c;
      b.addEventListener('click', () => { p[key] = c; dressChanged = true; host.rebuildRig(); renderWardrobe(); });
      row.appendChild(b);
    }
  };
  if (wTab === 'ropa') {
    opts('Parte de arriba', 'top', CLOTHES.top);
    colors('Color de arriba', 'shirt');
    colors('Pantalón', 'pants');
    opts('Accesorio', 'acc', CLOTHES.acc);
    colors('Color del accesorio', 'accColor');
  } else {
    look('Peinado', 'hairStyle');
    colors('Color de pelo', 'hair');
    look('Ojos', 'eyes');
    colors('Color de ojos', 'eyeColor', EYE_COLORS);
    look('Cejas', 'brows');
    look('Nariz', 'nose');
    look('Boca', 'mouth');
    look('Vello facial', 'facial');
    look('Mejillas', 'cheeks');
    colors('Piel', 'skin');
    look('Altura', 'height');
  }
  $('wardrobe-title').textContent = wTab === 'ropa' ? 'Armario' : 'Apariencia';
  $('wardrobe-money').textContent = `◎ ${Math.floor(money)}`;
  refreshPreview();
}
function closeWardrobe() {
  $('wardrobe').hidden = true;
  if (dressChanged && host && running) {
    const f = wardrobeFurn && furn.includes(wardrobeFurn) ? wardrobeFurn : null;
    if (f) host.perform(f, f.def.actions[0], { user: true });
    host.addNeed('fun', 6);
    setTimeout(() => { host.say(pick(['¡Me queda genial!', '¡Qué estilo!', '¡Nuevo look!']), 1.6); host.voice('happy'); }, f ? 2500 : 200);
    save();
  }
}

/* ---------- Interfaz de mascotas ---------- */
const petEls = new Map();
function buildPetHUD() {
  const el = $('pets');
  el.innerHTML = '';
  petEls.clear();
  for (const p of pets) {
    const d = document.createElement('div');
    d.className = 'petrow';
    d.innerHTML = `<span class="pn">${p.K.icon} ${p.name}</span><span class="pl">🍖</span><span class="bar"><b></b></span><span class="pl">♥</span><span class="bar"><b></b></span>`;
    const [a, b] = d.querySelectorAll('b');
    el.appendChild(d);
    petEls.set(p, { root: d, hunger: a, love: b });
  }
  el.hidden = !pets.length;
}
function updatePetHUD() {
  for (const [p, e] of petEls) {
    for (const [k, fill] of [['hunger', e.hunger], ['love', e.love]]) {
      const v = p[k];
      fill.style.width = `${Math.max(2, v)}%`;
      fill.style.background = v > 60 ? '#5fd35f' : v > 30 ? '#e6c84a' : '#e0503e';
    }
  }
}
function openPetMenu(p, cx, cy) {
  openCustomMenu(`${p.K.icon} ${p.name}`, [
    ['♥ Acariciar', () => p.pet(true)],
    [`Que ${host.name} lo acaricie`, () => { if (!host.startPet(p, 'pet')) host.say('Ahora no puedo', 1.2); else host.userCmd = true; }],
    [`Que ${host.name} juegue con él`, () => { if (!host.startPet(p, 'play')) host.say('Ahora no puedo', 1.2); else host.userCmd = true; }],
    ['Dar en adopción', () => {
      if (!confirm(`¿Dar a ${p.name} en adopción? Se irá a vivir con otra familia.`)) return;
      p.destroy(); buildPetHUD(); resize(); save();
      toast(`${p.name} se ha ido a una casa nueva. ¡Adiós, ${p.name}!`);
      if (host) { host.addNeed('fun', -10); host.say('Te echaré de menos…', 2); host.voice('sad'); }
    }, 'minor'],
  ], cx, cy, `Hambre ${Math.round(p.hunger)}% · Cariño ${Math.round(p.love)}%`);
}

function beginTalk(a, b) {
  for (const [x, y] of [[a, b], [b, a]]) {
    if (x.act) x.endAct(true);
    x.setState('act');
    x.act = { f: null, def: TALK, plan: { anim: 'stand' }, t: 0, dur: rand(9, 14), anim: 'stand', partner: y, talkT: 0.2, leader: x === a, turn: false };
    x.targetFacing = Math.atan2(y.y - x.y, y.x - x.x);
  }
  b.act.dur = a.act.dur + 1;
}

function separateAgents() {
  const all = [...agents, ...pets];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j];
    if (a.state === 'held' || b.state === 'held' || (a.act && a.act.seat) || (b.act && b.act.seat)) continue;
    if (Math.abs(a.z - b.z) > 0.1) continue;
    if (a.isPet && b.isPet && (a.state === 'sleep' || b.state === 'sleep')) continue;
    const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy), min = a.isPet || b.isPet ? 0.055 : H_R * 1.9;
    if (d >= min || d < 1e-6) continue;
    const push = (min - d) / 2, nx = dx / d, ny = dy / d;
    a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
  }
}

const visitors = () => agents.filter((a) => !a.isHost);

/* ---------- Dinero y charcos ---------- */
function earn(v) { money += v; }
function spend(v, msg) {
  money = Math.max(0, money - v);
  audio.cash(false);
  if (msg) toast(msg);
}

const puddles = [];
const puddleMat = new THREE.MeshLambertMaterial({ color: '#e8d75a', transparent: true, opacity: 0.8 });
function addPuddle(x, y, kind = 'pee') {
  x = clamp(x, -W / 2 + 0.03, W / 2 - 0.03); y = clamp(y, -H / 2 + 0.03, H / 2 - 0.03);
  let m;
  if (kind === 'poop') {
    m = new THREE.Group();
    m.add(ball(0.014, '#6a4528', 0, 0, 0.008, 0), ball(0.011, '#6a4528', 0.008, 0.004, 0.018, 0), ball(0.007, '#7a5535', 0.003, 0.002, 0.027, 0));
    m.position.set(x, y, groundAt(x, y).z);
  } else {
    m = new THREE.Mesh(new THREE.CircleGeometry(0.05, 8), puddleMat);
    m.position.set(x, y, groundAt(x, y).z + 0.002);
    m.rotation.z = rand(0, 3);
    m.scale.set(1.3, 0.9, 1);
    m.receiveShadow = true;
  }
  scene.add(m);
  puddles.push({ x, y, m, kind });
}
function cleanPuddle(p, quiet = false) {
  scene.remove(p.m);
  puddles.splice(puddles.indexOf(p), 1);
  audio.blip(900, 1400, 0.12, 'triangle', 0.12);
  if (!quiet) toast('¡Limpio!');
}
function ambience() {
  let n = 0;
  for (const f of furn) if (f.def.decor) n++;
  return Math.min(0.35, n * 0.07);
}

/* =====================================================================
 *  Física de muebles y efectos de los objetos
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
  for (const f of furn) { f.dx = f.x - f.px; f.dy = f.y - f.py; f.thudT -= dt; }
}

function wallsFurn(f, sound) {
  const lx = W / 2 - f.hx, ly = H / 2 - f.hy, e = f.def.bounce || 0.15;
  let impact = 0;
  if (f.x < -lx) { f.x = -lx; if (f.vx < 0) { impact = -f.vx; f.vx = -f.vx * e; } f.pinX = -1; }
  if (f.x > lx) { f.x = lx; if (f.vx > 0) { impact = f.vx; f.vx = -f.vx * e; } f.pinX = 1; }
  if (f.y < -ly) { f.y = -ly; if (f.vy < 0) { impact = Math.max(impact, -f.vy); f.vy = -f.vy * e; } f.pinY = -1; }
  if (f.y > ly) { f.y = ly; if (f.vy > 0) { impact = Math.max(impact, f.vy); f.vy = -f.vy * e; } f.pinY = 1; }
  if (sound && impact > 0.25 && f.thudT <= 0) {
    if (f.def.round) audio.kick(); else audio.thud(Math.min(0.6, impact * 0.35) * Math.sqrt(f.mass / 3));
    f.thudT = 0.2; f.wob = 1;
  }
}

function collideFurn(a, b) {
  const ox = a.hx + b.hx - Math.abs(a.x - b.x), oy = a.hy + b.hy - Math.abs(a.y - b.y);
  if (ox <= 0 || oy <= 0) return;
  // La ducha es un plato en el suelo: solo la pelota rebota en ella
  if ((a.type === 'shower' || b.type === 'shower') && !a.def.round && !b.def.round && !a.drag && !b.drag) {
    if (Math.hypot(a.vx, a.vy) < 0.01 && Math.hypot(b.vx, b.vy) < 0.01) return;
  }
  let nx = 0, ny = 0, pen;
  if (ox < oy) { nx = Math.sign(b.x - a.x) || 1; pen = ox; } else { ny = Math.sign(b.y - a.y) || 1; pen = oy; }
  let ia = a.drag ? 0 : 1 / a.mass, ib = b.drag ? 0 : 1 / b.mass;
  if ((nx && a.pinX === -nx) || (ny && a.pinY === -ny)) ia = 0;
  if ((nx && b.pinX === nx) || (ny && b.pinY === ny)) ib = 0;
  if (ia + ib === 0) { if (a.drag) ia = 1; else if (b.drag) ib = 1; else { ia = ib = 1; } }
  const sum = ia + ib;
  a.x -= nx * pen * ia / sum; a.y -= ny * pen * ia / sum;
  b.x += nx * pen * ib / sum; b.y += ny * pen * ib / sum;
  const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rv < 0) {
    const e = Math.max(a.def.bounce || 0.1, b.def.bounce || 0.1);
    const j = (-rv * (1 + e)) / sum;
    a.vx -= j * ia * nx; a.vy -= j * ia * ny;
    b.vx += j * ib * nx; b.vy += j * ib * ny;
    if (-rv > 0.3 && a.thudT <= 0) { audio.thud(Math.min(0.5, -rv * 0.25)); a.thudT = 0.25; a.wob = b.wob = 0.8; }
  }
}

const TV_COLORS = ['#6fb7ff', '#ffd36f', '#ff7f9f', '#8fff9f', '#ffffff', '#b58fff'];
const tmpAxis = new THREE.Vector3();
function updateFurnVisuals(dt, t) {
  const music = agents.some((a) => a.act && a.act.def.music);
  for (const f of furn) {
    f.visRot = damp(f.visRot, f.rot, 12, dt);
    f.wob = Math.max(0, f.wob - dt * 3);
    f.spawn = Math.max(0, f.spawn - dt * 2.5);
    const sp = Math.hypot(f.vx, f.vy);
    const jig = (sp > 0.05 && !f.drag && !f.def.round ? Math.sin(t * 40 + f.mass) * 0.012 * Math.min(1, sp) : 0) + Math.sin(t * 30) * 0.03 * f.wob;
    f.g.position.set(f.x, f.y, f.spawn * 0.15);
    f.g.rotation.z = f.visRot + jig;
    let sc = 1 - f.spawn * 0.6;
    f.g.scale.set(sc, sc, sc);
    const u = f.g.userData;
    if (u.spin && sp > 0.001) {
      tmpAxis.set(-f.vy, f.vx, 0).normalize();
      u.spin.rotateOnWorldAxis(tmpAxis, (sp * dt) / 0.022);
    }
    if (u.light) {
      u.light.intensity = damp(u.light.intensity, f.on ? 0.25 : 0, 10, dt);
      u.shadeMat.emissiveIntensity = damp(u.shadeMat.emissiveIntensity, f.on ? 1.1 : 0, 10, dt);
    }
    if (u.screen) {
      const c = u.screen.color;
      if (f.use === 'tv') { if (Math.random() < dt * 5) c.set(pick(TV_COLORS)); }
      else if (f.use === 'game') c.setHSL((t * 0.7) % 1, 0.8, 0.55);
      else if (f.use === 'work') c.set(Math.sin(t * 6) > 0 ? '#3d78c7' : '#4a86d6');
      else c.set('#1d2a2a');
    }
    if (u.fish) u.fish.forEach((m, i) => { m.position.x = Math.sin(t * (0.6 + i * 0.3) + i * 2) * 0.04; m.position.y = Math.cos(t * 0.5 + i) * 0.012; m.rotation.z = Math.cos(t * (0.6 + i * 0.3) + i * 2) > 0 ? 0 : Math.PI; });
    if (u.burn) { u.burn.emissiveIntensity = f.use === 'cook' ? 0.8 + Math.sin(t * 20) * 0.2 : 0; u.pot.visible = f.use === 'cook'; }
    if (u.belt && f.use === 'run') u.belt.offset.y = (u.belt.offset.y - dt * 3) % 1;
    if (u.guitar) u.guitar.visible = f.use !== 'play';
    if (u.pend) u.pend.rotation.y = Math.sin(t * 3) * 0.35;
    if (u.lava) u.lava.emissive.setHSL((t * 0.05) % 1, 0.9, 0.5);
    if (u.food) u.food.visible = f.food > 0;
    if (f.def.clipRate) {
      const running = clips.on && !f.jam && clips.wire > 0 && clipEff() > 0;
      u.lamp.color.set(f.jam ? (Math.sin(t * 12) > 0 ? '#ff3a2a' : '#5a1a1a') : running ? '#5fd35f' : '#6a6a7a');
      const sp2 = running ? clipEff() : 0;
      if (u.piston) u.piston.position.z = (f.type === 'clipper' ? 0.11 : 0.13) + Math.abs(Math.sin(t * 9 * sp2)) * 0.012 * (sp2 > 0 ? 1 : 0);
      if (u.belt && running) u.belt.offset.x = (u.belt.offset.x - dt * 2 * sp2) % 1;
      if (u.arm && running) { u.arm.rotation.z = Math.sin(t * 2.2) * 1.2; u.up.rotation.y = Math.sin(t * 3.1) * 0.4; u.fore.rotation.y = Math.cos(t * 3.1) * 0.5; }
      if (f.jam && Math.random() < dt * 3) f.wob = 0.4;
    }
    if (u.pile) u.pile.scale.z = clamp(0.4 + Math.log10(1 + clips.stock) / 2, 0.4, 4);
    if (u.bubbles) u.bubbles.children.forEach((b, i) => { b.position.z = 0.064 + Math.abs(Math.sin(t * 3 + i * 1.7)) * 0.01; });
    if (f.use === 'massage') f.wob = 0.25;
    if (f.type === 'stereo') { const b = music ? 1 + Math.abs(Math.sin(t * 11)) * 0.08 : 1; f.g.scale.set(sc * b, sc * b, sc * b); }
  }
  return music;
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
  const gx = Math.sin(g) * Math.cos(b), gy = -Math.sin(b), gz = -Math.cos(g) * Math.cos(b);
  const [sx, sy] = toScreen(gx, gy);
  sensor.raw.set(sx, sy, gz).normalize();
  if (!sensor.has) { sensor.has = true; sensor.g0 = sensor.raw.clone(); }
}
function onMotion(e) {
  const a = e.acceleration;
  if (!a || a.x == null || !running) return;
  const now = performance.now();
  const [ax, ay] = toScreen(a.x, a.y);
  const m = Math.hypot(ax, ay, a.z || 0);
  if (m < 9 || now - sensor.shakeT < 140) return;
  sensor.shakeT = now;
  const k = 0.018;
  for (const f of furn) { if (!f.drag) { f.vx -= ax * k / Math.sqrt(f.mass); f.vy -= ay * k / Math.sqrt(f.mass); f.wob = 1; } }
  for (const p of pets) { if (p.state !== 'held') { p.vx -= ax * k * 1.8; p.vy -= ay * k * 1.8; if (m > 12) p.setState('slide'); } }
  for (const h of agents) {
    if (h.state === 'held') continue;
    if (h.act) h.endAct(true);
    h.vx -= ax * k * 1.6; h.vy -= ay * k * 1.6;
    if (Math.abs(a.z || 0) > 6 && h.state !== 'air') { if (UPRIGHT.has(h.state)) h.setState('air'); h.vz = Math.min(1.2, Math.abs(a.z) * 0.06); }
    if (m > 15 && h.state !== 'fallen' && h.state !== 'air') h.fall(pick(['¡Terremoto!', '¡Aaah!', '¡Uaaa!']));
    else if (UPRIGHT.has(h.state)) h.setState('stumble');
  }
}
function updateTilt(dt) {
  let tx = sensor.key.x, ty = sensor.key.y;
  if (sensor.has && sensor.g0) {
    tmpQ.setFromUnitVectors(sensor.g0, DOWN);
    tmpV.copy(sensor.raw).applyQuaternion(tmpQ);
    tx = tmpV.x; ty = tmpV.y;
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
const face = { present: false, x: 0, y: 0, cm: 32, lastSeen: 0, goneAt: 0, enabled: false, loading: false, landmarker: null, stream: null, lastT: -1, lastDetect: 0, closeT: 0 };
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
    tip('Mueve la cabeza: la habitación tiene profundidad. Y tu humano te verá.', 4500);
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
  const cls = 'dot' + (face.loading ? ' load' : face.present ? ' track' : face.enabled ? ' on' : '');
  for (const id of ['eye-dot', 'eye-dot2']) { const d = $(id); if (d) d.className = cls; }
  $('btn-eyes').textContent = face.enabled ? 'Seguir ojos: SÍ' : 'Seguir ojos: NO';
}

const FOV_MAX = 66 * DEG;
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
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const L = lm.length >= 478 ? lm[468] : mid(lm[33], lm[133]);
  const R = lm.length >= 478 ? lm[473] : mid(lm[362], lm[263]);
  const mx = (L.x + R.x) / 2, my = (L.y + R.y) / 2;
  const ipdPx = Math.hypot((L.x - R.x) * vw, (L.y - R.y) * vh);
  const fpx = (Math.max(vw, vh) / 2) / Math.tan(FOV_MAX / 2);
  const dcm = clamp((6.3 * fpx) / Math.max(ipdPx, 1), 10, 90);
  let xcm = -(mx - 0.5) * vw * dcm / fpx;
  let ycm = -(my - 0.5) * vh * dcm / fpx;
  const sw = innerWidth / PX_PER_CM, sh = innerHeight / PX_PER_CM;
  const a = screenAngle();
  let cx = 0, cy = sh / 2 + 0.5;
  if (Math.abs(Math.sin(a)) > 0.5) { cx = Math.sin(a) > 0 ? -(sw / 2 + 0.5) : sw / 2 + 0.5; cy = 0; }
  [xcm, ycm] = toScreen(xcm, ycm);
  xcm += cx; ycm += cy;
  // Coordenadas relativas al centro de la vista 3D (no al de la pantalla)
  ycm -= (innerHeight / 2 - (viewRect.top + viewRect.height / 2)) / PX_PER_CM;
  xcm -= ((viewRect.left + viewRect.width / 2) - innerWidth / 2) / PX_PER_CM;
  const k = face.present ? 0.55 : 1;
  face.x = lerp(face.x, xcm, k); face.y = lerp(face.y, ycm, k); face.cm = lerp(face.cm, dcm, k);
  face.present = true; face.lastSeen = now;
  if (!wasPresent) {
    setEyeDot();
    if (now - face.goneAt > 4000 && host && (host.state === 'idle' || host.state === 'look')) {
      host.setState('wave', 2.2); host.targetFacing = -HALF_PI;
      host.say(pick(['¡Hola!', '¡Ah, estás ahí!', '¡Hola, tú!', '¡Te echaba de menos!']), 1.6); host.voice('happy');
    }
  }
  if (dcm < 17 && now - face.closeT > 7000 && host && host.state !== 'held' && !(host.act && host.act.anim === 'lie')) {
    face.closeT = now;
    host.say(pick(['¡Uy, qué cerca!', '¡Qué ojos tan grandes!', '¡Hola, ojo!']), 1.8); host.voice('alarm');
  }
}

function updateEye(dt) {
  const base = 32 / CM_PER_UNIT;
  let tx, ty, tz;
  if (face.enabled && face.present) {
    tx = (face.x / CM_PER_UNIT) * depthK;
    ty = (face.y / CM_PER_UNIT) * depthK;
    tz = (face.cm / CM_PER_UNIT) / Math.sqrt(depthK);
  } else {
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
  // Proyección off-axis: el rectángulo de la vista (z = D) es la ventana
  const ez = eye.z;
  camera.position.set(eye.x, eye.y, D + ez);
  camera.rotation.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  const n = 0.05, s = n / ez;
  camera.projectionMatrix.makePerspective((-W / 2 - eye.x) * s, (W / 2 - eye.x) * s, (H / 2 - eye.y) * s, (-H / 2 - eye.y) * s, n, 60);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/* =====================================================================
 *  Sonido (Web Audio, todo sintetizado)
 * ===================================================================== */
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const audio = {
  ctx: null, on: true, master: null, noise: null, mNext: 0, mStep: 0,
  init() {
    if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
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
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
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
  noiseHit(vol, dur, freq, type = 'lowpass', delay = 0) {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime + delay;
    const s = c.createBufferSource(); s.buffer = this.noise;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + dur + 0.02);
  },
  voice(mood = 'happy', pitch = 1) {
    const base = ({ happy: 420, alarm: 520, angry: 230, sad: 300 }[mood] || 400) * pitch;
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const f = base * rand(0.85, 1.3);
      const end = mood === 'sad' ? f * 0.7 : mood === 'alarm' ? f * 1.4 : f * rand(0.85, 1.2);
      this.blip(f, end, 0.075, 'sawtooth', 0.2, i * 0.09, rand(900, 1800));
    }
  },
  giggle(pitch = 1) { for (let i = 0; i < 4; i++) this.blip((700 + i * 40) * pitch, (900 + i * 30) * pitch, 0.05, 'sawtooth', 0.16, i * 0.06, 1500); },
  thud(vol = 0.3) { this.noiseHit(vol, 0.18, 260); this.blip(110, 50, 0.15, 'sine', vol * 0.8); },
  bonk() { this.blip(1400, 700, 0.18, 'sine', 0.25); this.blip(2100, 1500, 0.08, 'triangle', 0.08); },
  click() { this.blip(2400, 1600, 0.025, 'square', 0.05); this.blip(1800, 1200, 0.02, 'square', 0.04, 0.05); },
  kick() { this.blip(300, 120, 0.08, 'square', 0.08); },
  flush() { this.noiseHit(0.25, 0.9, 900, 'bandpass'); },
  cash(gain) {
    if (gain) { this.blip(1318, 1318, 0.08, 'square', 0.06); this.blip(1760, 1760, 0.18, 'square', 0.06, 0.08); }
    else { this.blip(880, 660, 0.1, 'square', 0.05); }
  },
  dingdong() { this.blip(988, 988, 0.5, 'sine', 0.25); this.blip(784, 784, 0.7, 'sine', 0.25, 0.45); },
  menu() { this.blip(660, 880, 0.04, 'square', 0.04); },
  woof() { this.blip(420, 180, 0.09, 'sawtooth', 0.18, 0, 700); this.blip(400, 170, 0.1, 'sawtooth', 0.15, 0.14, 700); },
  meow() { this.blip(600, 900, 0.12, 'sawtooth', 0.12, 0, 1400); this.blip(900, 500, 0.22, 'sawtooth', 0.1, 0.12, 1200); },
  squeak() { this.blip(1800, 2400, 0.05, 'sine', 0.08); this.blip(2200, 1600, 0.05, 'sine', 0.06, 0.07); },
  strum() {
    const roots = [52, 57, 55, 50], r = roots[Math.floor(Date.now() / 2400) % 4];
    [0, 7, 12, 16].forEach((n, i) => this.blip(mtof(r + n), mtof(r + n) * 0.998, 0.5, 'triangle', 0.05, i * 0.018));
  },
  pianoNote() {
    const scale = [60, 62, 64, 67, 69, 72, 74, 76];
    this.mel = clamp((this.mel ?? 3) + Math.floor(rand(-2, 3)), 0, scale.length - 1);
    const f = mtof(scale[this.mel]);
    this.blip(f, f, 0.45, 'triangle', 0.09); this.blip(f * 2, f * 2, 0.2, 'sine', 0.03);
    if (Math.random() < 0.3) this.blip(f / 2, f / 2, 0.6, 'triangle', 0.05);
  },
  music(on) {
    if (!this.ok() || !on) { this.mNext = 0; return; }
    const c = this.ctx;
    if (!this.mNext || this.mNext < c.currentTime) this.mNext = c.currentTime + 0.05;
    while (this.mNext < c.currentTime + 0.25) {
      const step = this.mStep++, t = this.mNext - c.currentTime;
      const root = [48, 45, 41, 43][Math.floor(step / 16) % 4];
      if (step % 4 === 0) this.blip(mtof(root), mtof(root), 0.2, 'square', 0.07, t);
      if (step % 4 === 2) this.blip(mtof(root + 12), mtof(root + 12), 0.1, 'square', 0.04, t);
      const arp = [0, 4, 7, 12, 16, 12, 7, 4];
      if (step % 2 === 0) this.blip(mtof(root + 24 + arp[(step / 2) % 8]), mtof(root + 24 + arp[(step / 2) % 8]), 0.09, 'square', 0.03, t);
      if (step % 8 === 4) this.noiseHit(0.08, 0.06, 4000, 'highpass', t);
      this.mNext += 0.13;
    }
  },
};

/* =====================================================================
 *  Interfaz: barra superior, necesidades, menús, tienda, avisos
 * ===================================================================== */
let viewRect = { left: 0, top: 0, width: 1, height: 1 };
const settings = { speed: 1 };
let born = Date.now(), lastDay = 0;

const needsEl = $('needs');
const needEls = {};
for (const k of NEED_KEYS) {
  const d = document.createElement('div');
  d.className = 'need';
  d.innerHTML = `<span class="nl"><i>${NEED_INFO[k].icon}</i>${NEED_INFO[k].label}</span><span class="bar"><b></b></span>`;
  needsEl.appendChild(d);
  needEls[k] = { root: d, fill: d.querySelector('b') };
}

function moodLabel(m) {
  if (m > 78) return ['☻', 'Feliz'];
  if (m > 58) return ['☺', 'Bien'];
  if (m > 38) return ['😐', 'Regular'];
  if (m > 20) return ['☹', 'Mal'];
  return ['😫', 'Fatal'];
}

function updateHUD() {
  if (!host) return;
  for (const k of NEED_KEYS) {
    const v = host.needs[k], e = needEls[k];
    e.fill.style.width = `${Math.max(2, v)}%`;
    e.fill.style.background = v > 60 ? '#5fd35f' : v > 30 ? '#e6c84a' : '#e0503e';
    e.root.classList.toggle('alert', v < 15);
  }
  const m = host.mood(), [ic, txt] = moodLabel(m);
  $('hud-name').textContent = host.name;
  $('hud-mood').textContent = `${ic} ${txt}`;
  $('hud-mood').style.color = m > 58 ? '#9ff09f' : m > 38 ? '#f0e08f' : '#ff9f8f';
  $('hud-money').textContent = `◎ ${Math.floor(money)}`;
  $('hud-day').textContent = `Día ${Math.floor((Date.now() - born) / 86400000) + 1}`;
  updatePetHUD();
}

let menuFor = null, menuOpenT = 0;
function openCustomMenu(title, items, cx, cy, sub = '') {
  const el = $('actmenu');
  el.innerHTML = '';
  const h = document.createElement('div');
  h.className = 'mtitle';
  h.textContent = title;
  el.appendChild(h);
  if (sub) { const d = document.createElement('div'); d.className = 'msub'; d.textContent = sub; el.appendChild(d); }
  for (const [label, fn, cls] of items) {
    const b = document.createElement('button');
    b.textContent = label; if (cls) b.className = cls;
    b.addEventListener('click', (e) => { e.stopPropagation(); if (performance.now() - menuOpenT < 450) return; closeMenu(); audio.menu(); fn(); });
    el.appendChild(b);
  }
  el.hidden = false;
  menuOpenT = performance.now();
  const r = el.getBoundingClientRect();
  el.style.left = `${clamp(cx - r.width / 2, 6, innerWidth - r.width - 6)}px`;
  el.style.top = `${clamp(cy + 14, 6, innerHeight - r.height - 6)}px`;
  audio.menu();
}

function openMenu(f, cx, cy) {
  const el = $('actmenu');
  el.innerHTML = '';
  menuFor = f;
  const h = document.createElement('div');
  h.className = 'mtitle';
  h.textContent = `${f.def.icon} ${f.def.name}`;
  el.appendChild(h);
  if (f.type === 'bowl') { const d = document.createElement('div'); d.className = 'msub'; d.textContent = f.food > 0 ? `Comida: ${f.food} raciones` : 'Vacío'; el.appendChild(d); }
  const add = (label, fn, disabled = false, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label; b.disabled = disabled; if (cls) b.className = cls;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (performance.now() - menuOpenT < 450) return; // evita el "clic fantasma" del mismo toque que abrió el menú
      closeMenu(); audio.menu(); fn();
    });
    el.appendChild(b);
  };
  for (const def of f.def.actions) {
    const label = def.cost ? `${def.label} (${def.cost}◎)` : def.label;
    add(label, () => {
      if (def.id === 'toggle') { setLamp(f, !f.on); if (host && UPRIGHT.has(host.state)) host.say(f.on ? '¡Luz!' : '¿Quién ha apagado?', 1.2); return; }
      if (def.ui === 'wardrobe') { openWardrobe(f); return; }
      if (host.perform(f, def, { user: true })) { if (Math.random() < 0.5) host.say(pick(['¡Vale!', 'Voy', '¡Bien!', 'Ahora mismo']), 1); }
    }, def.cost && money < def.cost);
  }
  add('↻ Girar', () => rotateFurn(f), false, 'minor');
  const refund = Math.round(f.def.price * 0.6);
  add(`Vender (+${refund}◎)`, () => sellFurn(f), false, 'minor');
  el.hidden = false;
  menuOpenT = performance.now();
  const r = el.getBoundingClientRect();
  el.style.left = `${clamp(cx - r.width / 2, 6, innerWidth - r.width - 6)}px`;
  el.style.top = `${clamp(cy + 14, 6, innerHeight - r.height - 6)}px`;
  audio.menu();
}
function closeMenu() { $('actmenu').hidden = true; menuFor = null; }

function rotateFurn(f) {
  const old = f.rot;
  if (agents.some((a) => a.act && (a.act.seatF === f || a.act.f === f))) for (const a of agents) if (a.act && (a.act.seatF === f || a.act.f === f)) a.endAct(true);
  f.rot += HALF_PI;
  f.mainSeat = null;
  updateExtents(f);
  f.x = clamp(f.x, -W / 2 + f.hx, W / 2 - f.hx);
  f.y = clamp(f.y, -H / 2 + f.hy, H / 2 - f.hy);
  f.visRot = old;
  f.wob = 1;
  audio.blip(260, 380, 0.1, 'triangle', 0.12);
  save();
}

function sellFurn(f) {
  if (ESSENTIAL.has(f.type) && furn.filter((o) => o.type === f.type).length === 1) {
    if (!confirm(`Si vendes ${f.def.name.toLowerCase()}, ${host.name} lo pasará mal. ¿Seguro?`)) return;
  }
  const refund = Math.round(f.def.price * 0.6);
  removeFurn(f);
  earn(refund);
  audio.cash(true);
  toast(`Vendido: ${f.def.name} (+${refund}◎)`);
  save();
}

let shopTab = 'muebles';
function buildShop() {
  const tabs = $('shop-tabs');
  tabs.innerHTML = '';
  for (const c of SHOP_CATS) {
    const b = document.createElement('button');
    b.textContent = c.label;
    b.className = 'tab' + (c.id === shopTab ? ' sel' : '');
    b.addEventListener('click', () => { shopTab = c.id; buildShop(); audio.menu(); });
    tabs.appendChild(b);
  }
  const list = $('shop-list');
  list.innerHTML = '';
  list.scrollTop = 0;
  $('shop-money').textContent = `◎ ${Math.floor(money)}`;
  if (shopTab === 'ropa') {
    const w = furn.find((f) => f.type === 'wardrobe');
    const d = document.createElement('div');
    d.className = 'item';
    d.innerHTML = `<span class="ic">👕</span><span class="nm">${w ? 'Elige la ropa en el armario: camisetas, vestidos, trajes, gorras, gafas, coronas…' : 'Primero necesitas un armario (pestaña Casa).'}</span>`;
    if (w) { const b = document.createElement('button'); b.textContent = 'Abrir'; b.addEventListener('click', () => { $('shop').hidden = true; openWardrobe(w); }); d.appendChild(b); }
    list.appendChild(d);
    return;
  }
  if (shopTab === 'mascotas') {
    for (const [kind, K] of Object.entries(PET_KINDS)) {
      const item = document.createElement('div');
      item.className = 'item';
      const owned = pets.filter((p) => p.kind === kind).length;
      item.innerHTML = `<span class="ic">${K.icon}</span><span class="nm">${K.label}${owned ? ` <small>×${owned}</small>` : ''}<small class="ds">Mascota · necesita comida y cariño</small></span>`;
      const b = document.createElement('button');
      b.textContent = `${K.price}◎`;
      b.disabled = money < K.price || pets.length >= 3;
      b.addEventListener('click', () => adoptPet(kind));
      item.appendChild(b);
      list.appendChild(item);
    }
  }
  for (const type of Object.keys(DEFS).filter((k) => DEFS[k].cat === shopTab)) {
    const d = DEFS[type];
    const item = document.createElement('div');
    item.className = 'item';
    const owned = furn.filter((f) => f.type === type).length;
    item.innerHTML = `<span class="ic">${d.icon}</span><span class="nm">${d.name}${owned ? ` <small>×${owned}</small>` : ''}<small class="ds">${shopDesc(d)}</small></span>`;
    const b = document.createElement('button');
    const locked = d.unlockAt && clips.total < d.unlockAt;
    b.textContent = locked ? '🔒' : `${fmt(d.price)}◎`;
    b.disabled = locked || money < d.price;
    if (locked) item.querySelector('.ds').textContent = `Se desbloquea con ${fmt(d.unlockAt)} clips`;
    else if (d.clipRate) item.querySelector('.ds').textContent = `${d.clipRate} clips/s · ruido ${d.noise}`;
    b.addEventListener('click', () => buy(type));
    item.appendChild(b);
    list.appendChild(item);
  }
}
function shopDesc(d) {
  const tags = new Set();
  for (const a of d.actions) for (const k in a.adv || {}) tags.add(k === 'money' ? 'Dinero' : NEED_INFO[k].label);
  if (d.decor) tags.add('Ambiente');
  if (d.cat === 'mascotas') tags.add('Para mascotas');
  return tags.size ? [...tags].join(' · ') : 'Decoración';
}
function buy(type) {
  const d = DEFS[type];
  if (money < d.price) return;
  const spot = findSpotFor(type);
  if (!spot) { toast('No cabe. Vende algo o mueve los muebles.'); audio.blip(200, 150, 0.2, 'square', 0.06); return; }
  money -= d.price;
  const f = addFurn(type, spot.x, spot.y, spot.rot || 0);
  f.spawn = 1;
  audio.cash(true);
  $('shop').hidden = true;
  toast(`${d.icon} ${d.name} comprado. Arrástralo donde quieras.`);
  if (host && UPRIGHT.has(host.state)) {
    host.say(pick(['¡Oooh! ¡Algo nuevo!', '¡Qué bonito!', '¡Gracias!', '¡Me encanta!']), 1.6); host.voice('happy');
    host.addNeed('fun', 8);
    host.look = { x: f.x, y: f.y, z: 0.1 }; host.lookT = clock + 2;
  }
  save();
}

const toastEl = $('toast');
let toastTimer = 0;
function toast(text, ms = 3200) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
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
 *  Interacción con el dedo
 * ===================================================================== */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const hitV = new THREE.Vector3(), segA = new THREE.Vector3(), segB = new THREE.Vector3();
const pointers = new Map();

function rayAt(cx, cy) {
  ndc.set(((cx - viewRect.left) / viewRect.width) * 2 - 1, -((cy - viewRect.top) / viewRect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}
function planeHit(ray, z) {
  floorPlane.constant = -z;
  return ray.intersectPlane(floorPlane, hitV) ? { x: hitV.x, y: hitV.y } : null;
}
function hitAgent(ray) {
  let best = null, bd = 0.07 * 0.07;
  for (const p of pets) {
    segA.set(p.vis.x, p.vis.y, p.vis.z + 0.05);
    const d = ray.distanceSqToPoint(segA);
    if (d < 0.055 * 0.055 && d < bd) { bd = d; best = p; }
  }
  for (const a of agents) {
    if (a.gone) continue;
    a.rig.root.getWorldPosition(segA);
    a.rig.head.getWorldPosition(segB);
    segB.lerp(segA, -0.25);
    const d = ray.distanceSqToSegment(segA, segB);
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}
function hitFurn() {
  const hits = raycaster.intersectObjects(furn.map((f) => f.g), true);
  return hits.length ? hits[0].object.userData.furn : null;
}

function onDown(e) {
  audio.init();
  if (!running) return;
  closeMenu();
  canvas.setPointerCapture(e.pointerId);
  const ray = rayAt(e.clientX, e.clientY);
  const p = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now(), moved: false, kind: 'floor' };
  const floorPt = planeHit(ray, 0);
  const puddle = floorPt && puddles.find((q) => Math.hypot(q.x - floorPt.x, q.y - floorPt.y) < 0.06);
  const ag = !grab.agent && hitAgent(ray);
  if (ag) { p.kind = 'agent'; p.agent = ag; }
  else if (puddle) { p.kind = 'puddle'; p.puddle = puddle; }
  else {
    const f = hitFurn();
    if (f) {
      p.kind = 'furn'; p.f = f;
      const pt = floorPt || { x: f.x, y: f.y };
      p.ox = f.x - pt.x; p.oy = f.y - pt.y;
    } else {
      if (floorPt) { p.pt = floorPt; if (host) { host.look = { x: floorPt.x, y: floorPt.y, z: D }; host.lookT = clock + 1.2; } }
      ripple(e.clientX, e.clientY);
    }
  }
  pointers.set(e.pointerId, p);
}

function onMove(e) {
  if (e.pointerType === 'mouse' && !pointers.size) {
    mouse.active = true;
    mouse.x = ((e.clientX - viewRect.left) / viewRect.width) * 2 - 1;
    mouse.y = -(((e.clientY - viewRect.top) / viewRect.height) * 2 - 1);
  }
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX; p.y = e.clientY;
  if (!p.moved && Math.hypot(p.x - p.x0, p.y - p.y0) > 9) p.moved = true;
  const ray = rayAt(p.x, p.y);
  if (p.kind === 'agent') {
    if (p.moved && !grab.agent) startGrab(p);
    if (grab.agent && grab.id === p.id) { const pt = planeHit(ray, liftZ()); if (pt) { grab.x = pt.x; grab.y = pt.y; } }
  } else if (p.kind === 'furn' && p.moved) {
    const pt = planeHit(ray, 0);
    if (pt) {
      if (!p.f.drag) for (const a of agents) if (a.act && (a.act.f === p.f || a.act.seatF === p.f) && a.act.anim === 'stand') a.endAct(true);
      p.f.drag = { x: pt.x + p.ox, y: pt.y + p.oy };
    }
  } else if (p.kind === 'floor') {
    const pt = planeHit(ray, 0);
    if (pt) { p.pt = pt; if (finger.follow && finger.id === p.id) { finger.x = pt.x; finger.y = pt.y; } }
  }
}

function startGrab(p) {
  const a = p.agent;
  if (a.act) a.endAct(true);
  a.setState('held');
  a.holding = null;
  grab.agent = a; grab.id = p.id; grab.vx = grab.vy = 0;
  grab.x = a.x; grab.y = a.y;
  const pt = planeHit(rayAt(p.x, p.y), liftZ());
  if (pt) { grab.x = pt.x; grab.y = pt.y; }
  a.say(pick(['¡Eh!', '¡Bájame!', '¡Uaaa!', '¡Qué alto!']), 1.3);
  a.voice('alarm');
}

function onUp(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  pointers.delete(e.pointerId);
  const dur = performance.now() - p.t0;
  if (p.kind === 'agent') {
    const a = p.agent;
    if (grab.agent === a && grab.id === p.id) {
      grab.agent = null;
      a.setState('air');
      a.vx = clamp(grab.vx, -3, 3); a.vy = clamp(grab.vy, -3, 3); a.vz = 0.25;
      const sp = Math.hypot(a.vx, a.vy);
      a.thrown = sp > 0.6;
      a.spin = clamp(sp * 5, 0, 18) * (Math.random() < 0.5 ? -1 : 1);
      if (sp > 1.2) a.say(pick(['¡Wiiiii!', '¡Aaaaah!', '¡Vuelooo!']), 1.2);
      if (!a.isHost && sp > 1.6) a.angry = true;
      if (a.isPet) { a.love = Math.max(0, a.love - (sp > 1.2 ? 15 : 4)); if (sp > 1.2) a.say(a.kind === 'cat' ? '¡Fffff!' : '¡Iiih!', 1); }
    } else if (!p.moved && a.isPet && pets.includes(a)) openPetMenu(a, p.x, p.y);
    else if (!p.moved && agents.includes(a)) a.poke();
  } else if (p.kind === 'puddle') {
    if (!p.moved && puddles.includes(p.puddle)) cleanPuddle(p.puddle);
  } else if (p.kind === 'furn') {
    const f = p.f;
    if (f.drag) { f.drag = null; f.vx *= 0.5; f.vy *= 0.5; save(); }
    else if (!p.moved && dur < 400 && furn.includes(f)) openMenu(f, p.x, p.y);
  } else if (p.kind === 'floor') {
    if (finger.follow && finger.id === p.id) finger.follow = false;
    else if (!p.moved && dur < 350 && p.pt && host && (UPRIGHT.has(host.state) || (host.state === 'act' && !host.act.seat && host.act.def.id !== 'talk'))) {
      if (host.act) host.endAct(true);
      host.userCmd = true;
      host.walkTo(p.pt.x, p.pt.y, () => { host.setState('idle', rand(1.5, 3)); host.userCmd = false; });
      if (Math.random() < 0.4) host.say(pick(['¿Allí?', '¡Voy!', 'Vale, vale']), 1);
    }
  }
}

function checkHolds() {
  const now = performance.now();
  for (const p of pointers.values()) {
    if (p.kind === 'agent' && !grab.agent && !p.moved && now - p.t0 > 260 && (agents.includes(p.agent) || pets.includes(p.agent))) startGrab(p);
    if (p.kind === 'floor' && !p.moved && !finger.follow && p.pt && now - p.t0 > 550 && host) {
      finger.follow = true; finger.id = p.id; finger.x = p.pt.x; finger.y = p.pt.y;
      if (UPRIGHT.has(host.state) || (host.act && !host.userCmd && host.act.def.id !== 'talk' && host.act.anim !== 'lie')) {
        if (host.act) host.endAct(true);
        host.followFinger();
        host.say(pick(['¿Qué es eso?', '¡Un dedo!', '¡Ooh!']), 1.2);
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
 *  Visitas
 * ===================================================================== */
const PROFILES = [
  { name: 'Lola', skin: '#e8b996', shirt: '#d0574e', pants: '#3b3b5c', hair: '#2b1b12', hairStyle: 'long', pitch: 1.25 },
  { name: 'Pepe', skin: '#c68a62', shirt: '#e3c26a', pants: '#4a3a2a', hair: '#1a1410', hairStyle: 'flat', pitch: 0.8 },
  { name: 'Nuria', skin: '#f2d6c2', shirt: '#7d3f9b', pants: '#2f2f3a', hair: '#b4532a', hairStyle: 'bun', pitch: 1.2 },
  { name: 'Iker', skin: '#8a5a3c', shirt: '#4f9a6f', pants: '#2a3a5a', hair: '#141010', hairStyle: 'short', pitch: 0.9 },
  { name: 'Marta', skin: '#f0c8a8', shirt: '#e98fb0', pants: '#5a6a8a', hair: '#e2c26a', hairStyle: 'long', pitch: 1.15 },
  { name: 'Bruno', skin: '#5f3b26', shirt: '#e8e2d2', pants: '#3a3a3a', hair: '#141010', hairStyle: 'bald', pitch: 0.72, scale: 1.06 },
  { name: 'Abuela Rosa', skin: '#efd2bd', shirt: '#7f9fc2', pants: '#6a5a6a', hair: '#e6e2da', hairStyle: 'bun', pitch: 1.05, scale: 0.94 },
];
const HOST_PROFILE = { name: 'Nico', skin: '#f2d2b6', shirt: '#3f8f7f', pants: '#2f3d63', hair: '#5a3a22', hairStyle: 'short', pitch: 1 };

const visit = { t: rand(45, 90), pending: null, pizza: null };
const COURIER = { name: 'Repartidor', skin: '#d9a07a', shirt: '#c0504a', pants: '#2a2a2a', hair: '#1a1410', hairStyle: 'short', acc: 'cap', accColor: '#e3c26a', pitch: 0.95 };
function orderPizza() { visit.pizza = { t: rand(12, 18) }; toast('🍕 Pizza pedida. Llegará enseguida.'); }
function updateVisits(dt) {
  if (!host) return;
  for (const v of visitors()) {
    if (v.gone) {
      v.destroy();
      if (!v.courier) { visit.t = rand(110, 230); if (!v.angry) host.addNeed('social', 6); }
    }
  }
  if (visit.pizza) {
    visit.pizza.t -= dt;
    if (visit.pizza.t <= 0) { visit.pizza = null; audio.dingdong(); toast('🔔 ¡Pizza a domicilio!'); spawnVisitor(COURIER, true); }
  }
  const nearDoor = agents.some((a) => !a.isHost && (a.leaving || !a.arrived) && Math.hypot(a.x - door.x, a.y - H / 2) < 0.2)
    || pets.some((p) => p.entering && Math.hypot(p.x - door.x, p.y - H / 2) < 0.2);
  door.target = nearDoor || (visit.pending && visit.pending.t < 0.8) ? 1.6 : 0;
  if (visit.pending) {
    visit.pending.t -= dt;
    if (visit.pending.t <= 0) { spawnVisitor(visit.pending.profile); visit.pending = null; }
    return;
  }
  if (visitors().some((v) => !v.courier)) return;
  visit.t -= dt;
  if (visit.t > 0) return;
  if (host.state === 'held' || (host.act && host.act.anim === 'lie') || (host.act && ['pee', 'shower'].includes(host.act.def.id))) { visit.t = 20; return; }
  const profile = pick(PROFILES);
  visit.pending = { t: 2.2, profile };
  audio.dingdong();
  host.say('¡Llaman a la puerta!', 1.6);
  host.look = { x: door.x, y: H / 2, z: 0.15 }; host.lookT = clock + 2;
  toast(`🔔 ${profile.name} viene de visita`);
  for (const p of pets) if (p.kind === 'dog' && p.state !== 'sleep' && p.state !== 'held') { p.walkTo(door.x, H / 2 - 0.12, () => { p.setState('wait', 2); p.say('¡Guau! ¡Guau!', 1.5); p.voice(); }, true); }
}
function spawnVisitor(profile, courier = false) {
  if (!profile.eyes) {
    const r = (k) => pick(LOOKS[k])[0];
    profile = { ...profile, eyes: r('eyes'), brows: r('brows'), nose: r('nose'), mouth: pick(['smile', 'grin', 'line', 'open', 'pout']), eyeColor: pick(EYE_COLORS), cheeks: r('cheeks'), facial: Math.random() < 0.3 ? r('facial') : 'none' };
  }
  const v = new Agent(profile, false);
  v.courier = courier;
  v.place(door.x, H / 2 - 0.03);
  v.facing = v.targetFacing = -HALF_PI;
  v.leaveAt = clock + rand(55, 95);
  v.walkTo(door.x + rand(-0.06, 0.06), H / 2 - 0.2, () => {
    v.arrived = true;
    if (v.courier) {
      v.setState('wave', 1.5);
      v.say('¡Pizza a domicilio!', 1.8); v.voice('happy');
      v.leaveAt = clock + 1.4;
      if (host.state !== 'held') {
        if (host.act) host.endAct(true);
        host.say('¡PIZZA!', 1.4); host.voice('happy');
        setTimeout(() => { if (host.state !== 'held') host.startMeal('pizza'); }, 600);
      }
      return;
    }
    v.setState('wave', 1.6);
    v.say(pick([`¡Hola, ${host.name}!`, '¡Holaaa!', '¿Se puede?', `¡${host.name}! ¡Qué tal!`]), 1.8);
    v.voice('happy');
    if (Math.random() < 0.35) { const g = pick([15, 20, 30]); earn(g); audio.cash(true); toast(`🎁 ${profile.name} te ha traído un regalo: +${g}◎`); }
    if (host.canTalk()) { host.setState('wave', 1.6); host.targetFacing = Math.atan2(v.y - host.y, v.x - host.x); host.say(pick([`¡${profile.name}!`, '¡Una visita!', '¡Hola!']), 1.4); host.voice('happy'); }
  }, { timeout: 8 });
}

/* =====================================================================
 *  Guardar / cargar
 * ===================================================================== */
function save() {
  if (!host || !running) return;
  const data = {
    v: 2, name: host.name, money, needs: host.needs, born, lastDay, t: Date.now(), speed: settings.speed, depth: depthK, sound: audio.on,
    items: furn.map((f) => ({ type: f.type, fx: f.x / (W / 2), fy: f.y / (H / 2), rot: f.rot, on: f.on, food: f.food || 0 })),
    outfit: Object.fromEntries(['shirt', 'pants', 'hair', 'hairStyle', 'skin', 'top', 'acc', 'accColor', 'eyes', 'eyeColor', 'brows', 'nose', 'mouth', 'facial', 'cheeks', 'height'].map((k) => [k, host.p[k]])),
    unlocked: [...unlocked],
    clips: clipsSave(),
    pets: pets.map((p) => ({ kind: p.kind, name: p.name, coat: p.coat, hunger: p.hunger, love: p.love, energy: p.energy, fx: p.x / (W / 2), fy: p.y / (H / 2) })),
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch { /* sin almacenamiento */ }
}
function loadSave() {
  try { const d = JSON.parse(localStorage.getItem(SAVE_KEY)); return d && d.v === 2 ? d : null; } catch { return null; }
}

/* =====================================================================
 *  Fábrica de clips (juego incremental)
 *  Los clips son el objetivo. Se pueden vender para conseguir dinero (◎),
 *  pero la producción depende del ánimo de tu humano.
 * ===================================================================== */
const MILESTONES = [
  { n: 100, title: 'Primeros clips', money: 20, text: 'Desbloquea la Máquina de clips' },
  { n: 1000, title: 'Mil clips', money: 60, text: 'Nuevas mejoras en la fábrica' },
  { n: 5000, title: 'Pequeña empresa', money: 150, text: 'Publicidad y compra automática de alambre' },
  { n: 25000, title: 'Taller en marcha', money: 400, text: 'Desbloquea la Máquina industrial' },
  { n: 100000, title: 'Cien mil clips', money: 1000, text: 'Engranajes de titanio y campaña publicitaria' },
  { n: 500000, title: 'Medio millón', money: 3000, text: 'Desbloquea el Robot clipero' },
  { n: 2000000, title: 'Dos millones', money: 10000, text: 'Inteligencia clipificial' },
  { n: 10000000, title: '¡Diez millones de clips!', final: true, text: 'El objetivo final' },
];
const UPGRADES = [
  { id: 'fastbend', at: 1000, name: 'Doblado rápido', desc: 'Hace clips a mano el doble de rápido', price: 50 },
  { id: 'longcoil', at: 1000, name: 'Bobinas largas', desc: '+50% de clips por bobina de alambre', price: 120 },
  { id: 'oil', at: 1000, name: 'Aceite para máquinas', desc: 'Máquinas ×1,5 y se atascan menos', price: 300 },
  { id: 'radio', at: 5000, name: 'Anuncio en la radio', desc: 'Precio de venta ×1,3', price: 400 },
  { id: 'autowire', at: 5000, name: 'Compra automática de alambre', desc: 'Compra una bobina cuando se acaba', price: 600 },
  { id: 'autosell', at: 25000, name: 'Venta automática', desc: 'Vende los clips poco a poco al precio del momento', price: 900 },
  { id: 'soundproof', at: 25000, name: 'Insonorizar la habitación', desc: 'El ruido de las máquinas cansa la mitad', price: 1200 },
  { id: 'titanium', at: 100000, name: 'Engranajes de titanio', desc: 'Máquinas ×2', price: 4000 },
  { id: 'ads', at: 100000, name: 'Campaña publicitaria', desc: 'Precio de venta ×1,5', price: 7000 },
  { id: 'shifts', at: 500000, name: 'Turnos automáticos', desc: 'Las máquinas trabajan al 100% aunque duerma', price: 20000 },
  { id: 'ai', at: 2000000, name: 'Inteligencia clipificial', desc: 'Toda la producción ×2', price: 60000 },
];
const clips = {
  total: 0, stock: 0, wire: 1000, upg: new Set(), on: true, done: new Set(), acc: 0, sat: 0,
  moodAcc: 0, moodT: 0, won: false, startT: Date.now(), rate: 0, manualRate: 0, sold: 0, earned: 0, wireWarn: 0, effWarn: 0,
};
const has = (u) => clips.upg.has(u);
const fmt = (n) => {
  n = Math.floor(n);
  if (n >= 1e6) return (n / 1e6).toLocaleString('es-ES', { maximumFractionDigits: 2 }) + ' M';
  return n.toLocaleString('es-ES');
};
const coilSize = () => (has('longcoil') ? 1500 : 1000);
function wirePrice() { return Math.round(28 * (1 + 0.25 * Math.sin(clock / 53) + 0.1 * Math.sin(clock / 17)) * (1 + Math.log10(1 + clips.total / 1e5) * 0.3)); }
function clipPrice() {
  let p = 0.4 * (has('radio') ? 1.3 : 1) * (has('ads') ? 1.5 : 1);
  p *= 1 + 0.2 * Math.sin(clock / 37) + 0.08 * Math.sin(clock / 11);
  return p / (1 + clips.sat / 4000);
}
// Ánimo → eficiencia: con el humano contento la fábrica va a tope
function clipEff() {
  if (!host) return 0;
  return clamp((host.mood() - 15) / 65, 0, 1.3);
}
function machineMult() { return (has('oil') ? 1.5 : 1) * (has('titanium') ? 2 : 1) * (has('ai') ? 2 : 1); }
function noiseLevel() {
  if (!clips.on) return 0;
  let n = 0;
  for (const f of furn) if (f.def.noise && !f.jam) n += f.def.noise;
  return n * 0.05 * (has('soundproof') ? 0.5 : 1);
}
function hostSleeping() { return host && host.act && host.act.anim === 'lie'; }
function machineRate() {
  if (!clips.on) return 0;
  let r = 0;
  for (const f of furn) if (f.def.clipRate && !f.jam) r += f.def.clipRate;
  r *= machineMult() * clipEff();
  if (hostSleeping() && !has('shifts')) r *= 0.5;
  return r;
}
function produce(n) {
  if (n <= 0) return 0;
  if (clips.wire <= 0 && has('autowire')) buyWire(true);
  n = Math.min(n, clips.wire);
  clips.wire -= n;
  clips.acc += n;
  const whole = Math.floor(clips.acc);
  clips.acc -= whole;
  clips.total += whole;
  clips.stock += whole;
  return n;
}
function manualClips(dt) {
  const r = 2.5 * (has('fastbend') ? 2 : 1) * (has('ai') ? 2 : 1) * clipEff();
  clips.manualRate = r;
  produce(r * dt);
}
function buyWire(auto = false) {
  const p = wirePrice();
  if (money < p) { if (!auto) toast('No tienes dinero para alambre'); return false; }
  money -= p;
  clips.wire += coilSize();
  if (!auto) audio.cash(false);
  return true;
}
function sellClips(n, quiet = false) {
  n = Math.floor(Math.min(n, clips.stock));
  if (n <= 0) return 0;
  const v = n * clipPrice();
  clips.stock -= n;
  clips.sat += n;
  clips.sold += n;
  clips.earned += v;
  money += v;
  if (!quiet) { audio.cash(true); toast(`Vendidos ${fmt(n)} clips por ${fmt(v)}◎`); }
  return v;
}

let floatT = 0, autoSellT = 0;
function updateClips(dt) {
  const mr = machineRate();
  clips.rate = mr + (host && host.act && host.act.def.id === 'clips' ? clips.manualRate : 0);
  produce(mr * dt);
  clips.sat *= Math.exp(-dt * 0.03);
  // Estadística del ánimo durante la partida (para la puntuación final)
  if (host) { clips.moodAcc += host.mood() * dt; clips.moodT += dt; }
  // Atascos: más probables con el humano desanimado
  for (const f of furn) {
    if (!f.def.clipRate || f.jam || !clips.on) continue;
    const p = 0.0015 * (has('oil') ? 0.5 : 1) * (1.5 - Math.min(1, clipEff()));
    if (Math.random() < p * dt * 10) { f.jam = true; toast(`⚠️ ${f.def.name} atascada. Tócala para que ${host.name} la revise.`); audio.blip(220, 140, 0.25, 'square', 0.06); }
  }
  if (has('autosell')) {
    autoSellT -= dt;
    if (autoSellT <= 0) { autoSellT = 1; sellClips(Math.ceil(clips.stock * 0.15), true); }
  }
  if (clips.wire <= 0 && (mr > 0 || (host && host.act && host.act.def.id === 'clips'))) {
    clips.wireWarn -= dt;
    if (clips.wireWarn <= 0) { clips.wireWarn = 25; toast('🧵 ¡Se ha acabado el alambre! Compra más en la fábrica.'); if (host && UPRIGHT.has(host.state)) host.say('¡No queda alambre!', 1.6); }
  }
  if (clips.on && furn.some((f) => f.def.clipRate) && clipEff() < 0.35) {
    clips.effWarn -= dt;
    if (clips.effWarn <= 0) { clips.effWarn = 40; if (host && host.bubbleT <= 0) host.say(pick(['No tengo ánimo para las máquinas…', 'Así no hay quien trabaje…', 'Necesito cuidarme un poco']), 2); }
  }
  // Hitos
  MILESTONES.forEach((m, i) => {
    if (clips.done.has(i) || clips.total < m.n) return;
    clips.done.add(i);
    if (m.money) earn(m.money);
    audio.cash(true); audio.blip(880, 1760, 0.3, 'square', 0.05, 0.15);
    toast(`🏆 ${m.title}${m.money ? ` · +${m.money}◎` : ''} — ${m.text}`, 4500);
    if (host && UPRIGHT.has(host.state)) { host.say('¡Hito conseguido!', 1.6); host.voice('happy'); host.addNeed('fun', 10); }
    if (m.final && !clips.won) { clips.won = true; setTimeout(showWin, 1200); }
    save();
  });
  // Números flotando sobre las máquinas
  floatT -= dt;
  if (floatT <= 0) {
    floatT = 2;
    const each = machineMult() * clipEff() * (hostSleeping() && !has('shifts') ? 0.5 : 1);
    for (const f of furn) {
      if (!f.def.clipRate || f.jam || !clips.on || clips.wire <= 0 || each <= 0) continue;
      floatText(f.x, f.y, 0.2, `+${fmt(Math.max(1, f.def.clipRate * each * 2))} 📎`);
    }
    if (host && host.act && host.act.def.id === 'clips' && clips.wire > 0) floatText(host.x, host.y, 0.36, `+${fmt(Math.max(1, clips.manualRate * 2))} 📎`);
  }
}

function floatText(x, y, z, text) {
  projV.set(x, y, z).project(camera);
  const el = document.createElement('div');
  el.className = 'floaty';
  el.textContent = text;
  el.style.left = `${viewRect.left + (projV.x * 0.5 + 0.5) * viewRect.width}px`;
  el.style.top = `${viewRect.top + (-projV.y * 0.5 + 0.5) * viewRect.height}px`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1300);
}

function updateClipBar() {
  $('cb-clips').textContent = fmt(clips.total);
  $('cb-rate').textContent = `${fmt(clips.rate)}/s`;
  $('cb-wire').textContent = fmt(clips.wire);
  const e = Math.round(clipEff() * 100);
  const ce = $('cb-eff');
  ce.textContent = `${e}%`;
  ce.style.color = e >= 80 ? '#9ff09f' : e >= 45 ? '#f0e08f' : '#ff9f8f';
  $('cb-wire').style.color = clips.wire < 100 ? '#ff9f8f' : '';
  const next = MILESTONES.find((m, i) => !clips.done.has(i));
  const prev = [...MILESTONES].reverse().find((m, i) => clips.total >= m.n);
  const from = prev && next ? prev.n : 0;
  $('cb-goal').style.width = next ? `${clamp((clips.total - from) / (next.n - from), 0, 1) * 100}%` : '100%';
  if (!$('factory').hidden) renderFactory(false);
}

function renderFactory(full = true) {
  const body = $('factory-body');
  const e = clipEff();
  const price = clipPrice(), wp = wirePrice();
  const html = [];
  html.push(`<div class="fstats">
    <div><b>${fmt(clips.total)}</b><small>clips fabricados</small></div>
    <div><b>${fmt(clips.stock)}</b><small>en el almacén</small></div>
    <div><b>${fmt(clips.rate)}/s</b><small>producción</small></div>
    <div><b style="color:${e >= 0.8 ? '#9ff09f' : e >= 0.45 ? '#f0e08f' : '#ff9f8f'}">${Math.round(e * 100)}%</b><small>eficiencia</small></div>
  </div>`);
  html.push(`<p class="fnote">La fábrica rinde según el ánimo de ${host.name} (${Math.round(host.mood())}%). ${hostSleeping() && !has('shifts') ? 'Mientras duerme, las máquinas van a medio gas. ' : ''}${noiseLevel() > 0 ? `El ruido de las máquinas le cansa un ${Math.round(noiseLevel() * 100)}% más.` : ''}</p>`);
  html.push(`<div class="fsec">Vender clips · ${price.toLocaleString('es-ES', { maximumFractionDigits: 3 })}◎ el clip</div>
    <div class="frow"><button data-a="s100" ${clips.stock < 1 ? 'disabled' : ''}>Vender 100</button><button data-a="s1k" ${clips.stock < 1 ? 'disabled' : ''}>Vender 1.000</button><button data-a="sall" ${clips.stock < 1 ? 'disabled' : ''}>Vender todo</button></div>`);
  html.push(`<div class="fsec">Alambre · ${fmt(clips.wire)} clips restantes</div>
    <div class="frow"><button data-a="wire" ${money < wp ? 'disabled' : ''}>Comprar bobina (${fmt(coilSize())} clips) · ${wp}◎</button></div>`);
  html.push(`<div class="frow"><button data-a="toggle">${clips.on ? '⏸ Parar las máquinas (descanso)' : '▶ Encender las máquinas'}</button></div>`);
  const ups = UPGRADES.filter((u) => clips.total >= u.at && !has(u.id));
  if (ups.length) {
    html.push('<div class="fsec">Mejoras</div>');
    for (const u of ups) html.push(`<div class="item"><span class="nm">${u.name}<small class="ds">${u.desc}</small></span><button data-u="${u.id}" ${money < u.price ? 'disabled' : ''}>${fmt(u.price)}◎</button></div>`);
  }
  const owned = UPGRADES.filter((u) => has(u.id));
  if (owned.length) html.push(`<p class="fnote">Mejoras activas: ${owned.map((u) => u.name).join(' · ')}</p>`);
  html.push('<div class="fsec">Hitos</div>');
  MILESTONES.forEach((m, i) => {
    const done = clips.done.has(i);
    const pct = clamp(clips.total / m.n, 0, 1) * 100;
    html.push(`<div class="mile ${done ? 'done' : ''}"><span>${done ? '✔' : m.final ? '★' : '○'} ${fmt(m.n)} · ${m.title}<small>${m.text}${m.money ? ` · +${m.money}◎` : ''}</small></span>${done ? '' : `<span class="bar"><b style="width:${pct}%"></b></span>`}</div>`);
  });
  const sig = html.join('');
  if (!full && body.dataset.sig === sig) return;
  body.dataset.sig = sig;
  body.innerHTML = sig;
  $('factory-money').textContent = `◎ ${fmt(money)}`;
}
$('factory-body').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const a = b.dataset.a, u = b.dataset.u;
  if (a === 's100') sellClips(100);
  if (a === 's1k') sellClips(1000);
  if (a === 'sall') sellClips(clips.stock);
  if (a === 'wire') buyWire();
  if (a === 'toggle') { clips.on = !clips.on; toast(clips.on ? 'Máquinas encendidas' : 'Máquinas paradas: descanso para todos'); }
  if (u) {
    const up = UPGRADES.find((x) => x.id === u);
    if (up && money >= up.price) { money -= up.price; clips.upg.add(u); audio.cash(true); toast(`Mejora: ${up.name}`); }
  }
  renderFactory();
  updateHUD();
  save();
});

function showWin() {
  const avg = clips.moodT ? clips.moodAcc / clips.moodT : 0;
  const stars = avg >= 75 ? 3 : avg >= 55 ? 2 : 1;
  const hrs = (Date.now() - clips.startT) / 3600000;
  $('win-body').innerHTML = `<div class="stars">${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}</div>
    <p>¡${host.name} ha fabricado <b>10 millones de clips</b> sin salir de tu móvil!</p>
    <p>Ánimo medio durante la partida: <b>${Math.round(avg)}%</b>. ${stars === 3 ? 'Una fábrica feliz: lo has cuidado de maravilla.' : stars === 2 ? 'Buen equilibrio entre trabajo y bienestar.' : 'Muchos clips… pero tu humano lo ha pasado mal. ¿Lo intentas cuidando más?'}</p>
    <p class="fnote">Tiempo: ${hrs < 1 ? `${Math.round(hrs * 60)} min` : `${hrs.toFixed(1)} h`} · Vendidos: ${fmt(clips.sold)} clips · Ganado: ${fmt(clips.earned)}◎</p>
    <p class="fnote">Puedes seguir jugando: la fábrica no para.</p>`;
  $('win').hidden = false;
  audio.dingdong();
}

function clipsSave() {
  return { total: clips.total, stock: clips.stock, wire: clips.wire, upg: [...clips.upg], on: clips.on, done: [...clips.done], moodAcc: clips.moodAcc, moodT: clips.moodT, won: clips.won, startT: clips.startT, sold: clips.sold, earned: clips.earned, eff: clipEff(), jams: furn.filter((f) => f.jam).length };
}
function clipsLoad(d) {
  if (!d) return;
  Object.assign(clips, { total: d.total || 0, stock: d.stock || 0, wire: d.wire ?? 1000, on: d.on !== false, moodAcc: d.moodAcc || 0, moodT: d.moodT || 0, won: !!d.won, startT: d.startT || Date.now(), sold: d.sold || 0, earned: d.earned || 0 });
  clips.upg = new Set(d.upg || []);
  clips.done = new Set(d.done || []);
}
// Producción mientras no estás (a medio gas y como mucho 8 h, limitada por el alambre)
function offlineClips(d, secs) {
  if (!d || !clips.on) return 0;
  let r = 0;
  for (const f of furn) if (f.def.clipRate) r += f.def.clipRate;
  r *= machineMult() * (d.eff ?? 0.5) * 0.5;
  const before = clips.total;
  let n = r * Math.min(secs, 8 * 3600);
  if (has('autowire')) {
    while (n > clips.wire && money >= wirePrice()) { if (!buyWire(true)) break; }
  }
  produce(n);
  return clips.total - before;
}

/* =====================================================================
 *  Tamaño, bucle principal, arranque
 * ===================================================================== */
let landscape = false;
function checkOrientation() {
  landscape = isTouch && innerWidth > innerHeight;
  $('rotate').hidden = !landscape;
  if (landscape && running) save();
}
window.addEventListener('orientationchange', () => setTimeout(() => { checkOrientation(); resize(); }, 250));
function resize() {
  checkOrientation();
  const top = $('topbar').offsetHeight, bottom = $('panel').offsetHeight;
  const cw = innerWidth, ch = Math.max(100, innerHeight - top - bottom);
  canvas.style.top = `${top}px`;
  canvas.style.height = `${ch}px`;
  viewRect = { left: 0, top, width: cw, height: ch };
  const s = Math.min(cw, ch);
  const oldW = W, oldH = H;
  W = cw / s; H = ch / s; D = 0.9;
  CM_PER_UNIT = s / PX_PER_CM;
  const scale = clamp(250 / s, 0.25, 1);
  const rw = Math.round(cw * scale), rh = Math.round(ch * scale);
  renderer.setSize(rw, rh, false);
  if (!rt) rt = new THREE.WebGLRenderTarget(rw, rh, { depthBuffer: true });
  else rt.setSize(rw, rh);
  rt.texture.magFilter = rt.texture.minFilter = THREE.NearestFilter;
  buildRoom();
  for (const f of furn) {
    f.x = clamp((f.x / (oldW / 2)) * (W / 2), -W / 2 + f.hx, W / 2 - f.hx);
    f.y = clamp((f.y / (oldH / 2)) * (H / 2), -H / 2 + f.hy, H / 2 - f.hy);
  }
  for (const a of agents) { a.x = clamp(a.x, -W / 2 + H_R, W / 2 - H_R); a.y = clamp(a.y, -H / 2 + H_R, H / 2 - H_R); }
}
window.addEventListener('resize', resize);

let clock = 0, last = performance.now(), running = false, hudT = 0, saveT = 5;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  clock += dt;
  updateTilt(dt);
  if (running && !landscape) {
    updateClips(dt);
    detectFace(now);
    checkHolds();
    for (let i = 0; i < 2; i++) {
      stepFurniture(dt / 2);
      for (const a of agents) a.step(dt / 2);
      for (const pt of pets) pt.step(dt / 2);
      separateAgents();
    }
    host.updateNeeds(dt);
    updateVisits(dt);
    hudT -= dt;
    if (hudT <= 0) { hudT = 0.25; updateHUD(); updateClipBar(); }
    saveT -= dt;
    if (saveT <= 0) { saveT = 5; save(); }
  }
  if (!$('wardrobe').hidden) renderPreview(dt);
  door.open = damp(door.open, door.target, 5, dt);
  if (door.hinge) door.hinge.rotation.z = door.open;
  updateEye(dt);
  for (const a of agents) a.updateVisual(dt, clock);
  for (const pt of pets) pt.updateVisual(dt, clock);
  const music = updateFurnVisuals(dt, clock);
  audio.music(music);
  updateCamera();
  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  post.mat.uniforms.tDiffuse.value = rt.texture;
  renderer.render(post.scene, post.cam);
  for (const a of agents) a.updateBubble(dt);
  for (const pt of pets) pt.updateBubble(dt);
}

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

// Escena inicial (se ve detrás de la pantalla de inicio)
const saved = loadSave();
resize();
if (saved && saved.items && saved.items.length) {
  for (const it of saved.items) {
    if (!DEFS[it.type]) continue;
    const f = addFurn(it.type, 0, 0, it.rot || 0);
    f.x = clamp(it.fx * (W / 2), -W / 2 + f.hx, W / 2 - f.hx);
    f.y = clamp(it.fy * (H / 2), -H / 2 + f.hy, H / 2 - f.hy);
    f.on = !!it.on;
    f.food = it.food || 0;
  }
} else defaultLayout();
host = new Agent({ ...HOST_PROFILE, ...(saved && saved.outfit ? saved.outfit : {}), name: saved ? saved.name : HOST_PROFILE.name }, true);
host.place(0, H * 0.05);
if (saved && saved.unlocked) unlocked = new Set(saved.unlocked);
if (saved && saved.pets) for (const d of saved.pets) {
  if (!PET_KINDS[d.kind]) continue;
  const pt = new Pet(d.kind, d);
  pt.place(clamp(d.fx * (W / 2), -W / 2 + 0.04, W / 2 - 0.04), clamp(d.fy * (H / 2), -H / 2 + 0.04, H / 2 - 0.04));
}
buildPetHUD();
eye.z = 32 / CM_PER_UNIT;
updateHUD();
requestAnimationFrame(frame);

if (saved) {
  $('name-input').value = saved.name;
  $('btn-start').textContent = `Continuar con ${saved.name} (cámara 3D)`;
  $('btn-start-nocam').textContent = 'Continuar sin cámara';
  $('btn-new').hidden = false;
}

async function start(withCam) {
  audio.init();
  await requestSensors();
  const name = ($('name-input').value || '').trim().slice(0, 14) || 'Nico';
  host.name = name;
  if (saved) {
    money = saved.money ?? 150;
    born = saved.born || Date.now();
    lastDay = saved.lastDay || 0;
    settings.speed = saved.speed || 1;
    depthK = saved.depth || 1.6;
    audio.on = saved.sound !== false;
    if (saved.needs) for (const k of NEED_KEYS) host.needs[k] = saved.needs[k] ?? host.needs[k];
    clipsLoad(saved.clips);
    if (!furn.some((f) => f.type === 'clipbench')) { const sp = findSpotFor('clipbench'); if (sp) addFurn('clipbench', sp.x, sp.y, sp.rot); }
    // El tiempo pasa mientras no estás (más despacio, y nunca le deja en las últimas)
    const mins = Math.max(0, (Date.now() - (saved.t || Date.now())) / 60000);
    if (mins > 2) {
      for (const k of NEED_KEYS) host.needs[k] = Math.max(Math.min(host.needs[k], 15), host.needs[k] - NEED_INFO[k].decay * 60 * mins * 0.25 * settings.speed);
      for (const pt of pets) { pt.hunger = Math.max(Math.min(pt.hunger, 20), pt.hunger - 0.05 * 60 * mins * 0.25); pt.love = Math.max(Math.min(pt.love, 20), pt.love - 0.035 * 60 * mins * 0.25); }
      const made = offlineClips(saved.clips, mins * 60);
      if (made > 0) setTimeout(() => toast(`🏭 Mientras no estabas, las máquinas han hecho ${fmt(made)} clips.`, 4000), 5500);
      const hrs = mins / 60;
      setTimeout(() => toast(hrs >= 1 ? `Has estado fuera ${Math.floor(hrs)} h. ${name} te echaba de menos.` : `${name} te estaba esperando.`, 4000), 1500);
    }
  }
  const today = Math.floor(Date.now() / 86400000);
  if (lastDay && today > lastDay) { earn(40); setTimeout(() => { toast('☀️ ¡Nuevo día! Paga diaria: +40◎'); audio.cash(true); }, 5000); }
  lastDay = today;
  $('intro').hidden = true;
  running = true;
  resize();
  syncSettingsUI();
  try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('portrait').catch(() => {}); } catch { /* no disponible */ }
  tip(isTouch ? 'Toca un objeto para darle órdenes · toca al humano · mantén para cogerlo · inclina el móvil' : 'Clic en objetos para darle órdenes · flechas: inclinar · mantén y arrastra para coger', 6500);
  setTimeout(() => { host.say(saved ? `¡Hola otra vez!` : '¿Hola? ¿Hay alguien ahí?', 2.2); host.voice('happy'); }, 900);
  if (withCam) startFace();
  setEyeDot();
  updateHUD();
  save();
}

function syncSettingsUI() {
  $('btn-depth').textContent = `Efecto 3D: ×${depthK}`;
  $('btn-sound').textContent = `Sonido: ${audio.on ? 'SÍ' : 'NO'}`;
  $('btn-speed').textContent = `Ritmo de vida: ${settings.speed === 1 ? 'Normal' : settings.speed === 3 ? 'Rápido' : 'Lento'}`;
  setEyeDot();
}

$('btn-start').addEventListener('click', () => start(true));
$('btn-start-nocam').addEventListener('click', () => start(false));
$('btn-new').addEventListener('click', () => {
  if (!confirm('¿Empezar una partida nueva? Se perderá la actual.')) return;
  try { localStorage.removeItem(SAVE_KEY); } catch { /* nada */ }
  location.reload();
});
$('btn-shop').addEventListener('click', () => { audio.init(); closeMenu(); buildShop(); $('shop').hidden = false; audio.menu(); });
$('shop-close').addEventListener('click', () => { $('shop').hidden = true; });
$('wardrobe-close').addEventListener('click', closeWardrobe);
$('btn-factory').addEventListener('click', () => { audio.init(); closeMenu(); renderFactory(); $('factory').hidden = false; audio.menu(); });
$('factory-close').addEventListener('click', () => { $('factory').hidden = true; });
$('win-close').addEventListener('click', () => { $('win').hidden = true; });
$('btn-looks').addEventListener('click', () => { $('settings').hidden = true; openWardrobe(null, 'cara'); });
$('btn-looks-intro').addEventListener('click', () => { audio.init(); openWardrobe(null, 'cara'); });
$('btn-menu').addEventListener('click', () => { audio.init(); closeMenu(); syncSettingsUI(); $('settings').hidden = false; audio.menu(); });
$('settings-close').addEventListener('click', () => { $('settings').hidden = true; save(); });
$('btn-eyes').addEventListener('click', () => { if (face.enabled) stopFace(); else startFace(); });
$('btn-level').addEventListener('click', () => { recalibrate(); $('settings').hidden = true; tip('Nivelado: esta posición es ahora "plana".', 2000); });
const DEPTHS = [1, 1.6, 2.4];
$('btn-depth').addEventListener('click', () => { depthK = DEPTHS[(DEPTHS.indexOf(depthK) + 1) % DEPTHS.length]; syncSettingsUI(); });
$('btn-sound').addEventListener('click', () => { audio.on = !audio.on; syncSettingsUI(); });
$('btn-speed').addEventListener('click', () => { settings.speed = settings.speed === 1 ? 3 : settings.speed === 3 ? 0.5 : 1; syncSettingsUI(); });
$('btn-reset').addEventListener('click', () => {
  if (!confirm('¿Borrar la partida y empezar de cero?')) return;
  running = false;
  try { localStorage.removeItem(SAVE_KEY); } catch { /* nada */ }
  location.reload();
});
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); else last = performance.now(); });
window.addEventListener('pagehide', save);

// Para depurar desde la consola
window.__room = { clips, sellClips, buyWire, clipEff, pets, adoptPet, openWardrobe, Pet,  project: (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(camera); return [viewRect.left + (v.x * 0.5 + 0.5) * viewRect.width, viewRect.top + (-v.y * 0.5 + 0.5) * viewRect.height]; }, get host() { return host; }, agents, furn, tilt, sensor, eye, face, DEFS, get money() { return money; }, set money(v) { money = v; }, spawnVisitor, PROFILES, visit, puddles, addFurn, settings };
