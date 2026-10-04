import * as THREE from 'three';
import { W, Z_START, Z_END, TOWER_Z, BAND } from './layout.js';

export function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const IDQ = new THREE.Quaternion();

export function spectral(t) {
  const f = (o) => Math.min(1, Math.max(0, Math.abs((((t + o) % 1) + 1) % 1 * 6 - 3) - 1));
  return [f(0), f(2 / 3), f(1 / 3)];
}

// Acumula instancias de cajas y las vuelca en un InstancedMesh (1 draw call)
export class Batch {
  constructor() {
    this.mats = [];
    this.cols = [];
    this.params = [];
  }
  add(x, y, z, sx, sy, sz, color = [1, 1, 1], params = null, quat = IDQ) {
    this.mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), quat, new THREE.Vector3(sx, sy, sz)));
    this.cols.push(color);
    if (params) this.params.push(...params);
  }
  get count() {
    return this.mats.length;
  }
  mesh(material, { withParams = false } = {}) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const n = this.mats.length;
    const mesh = new THREE.InstancedMesh(geo, material, n);
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      mesh.setMatrixAt(i, this.mats[i]);
      const [r, g, b] = this.cols[i];
      mesh.setColorAt(i, c.setRGB(r, g, b));
    }
    if (withParams) {
      geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(new Float32Array(this.params), 4));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false; // el pasillo entero siempre envuelve a la cámara
    return mesh;
  }
}

// Paletas (RGB lineal) e intensidad base de cada luz
const C = {
  white: [1, 1, 1],
  warm: [1, 0.78, 0.55],
  orange: [1, 0.4, 0.09],
  amber: [1, 0.6, 0.18],
  red: [1, 0.1, 0.08],
  blue: [0.22, 0.42, 1],
  cyan: [0.2, 0.78, 1],
  violet: [0.55, 0.28, 1],
  green: [0.3, 1, 0.55],
  pink: [1, 0.32, 0.58],
};
const LEFT_LIGHTS = [
  [C.orange, 3.2], [C.warm, 2.6], [C.white, 2.8], [C.red, 2.6],
  [C.blue, 2.6], [C.amber, 3.4], [C.warm, 1.9], [C.orange, 2.2],
];
const RIGHT_LIGHTS = [
  [C.white, 2.2], [C.cyan, 2.6], [C.blue, 2.4], [C.warm, 2.2],
  [C.violet, 2.2], [C.pink, 2.2], [C.green, 1.8], [C.white, 1.6],
];

function stripParams(r, inten, pulseMax = 3) {
  return [r(), lerp(0.03, 0.14, r()), inten, lerp(0.4, pulseMax, r())];
}

// ---------------------------------------------------------------------------
// Pasillo: muro izquierdo aterrazado y muro derecho alto con banda prismática
// ---------------------------------------------------------------------------
export function buildCorridor(r, density, { glossy, matte, strips }) {
  // ---- Muro izquierdo: cornisas horizontales apiladas, cada una con su vuelo
  for (let z = Z_START; z > Z_END; ) {
    const len = lerp(2.5, 11, r());
    const top = lerp(2.6, 4.9, r());
    let y = 0;
    while (y < top) {
      const h = lerp(0.04, 0.44, r() ** 1.7);
      const inset = r() < 0.25 ? lerp(0.3, 1.5, r()) : lerp(0, 0.35, r());
      const depth = lerp(0.6, 3.0, r());
      const segLen = len * lerp(0.55, 1, r());
      const zc = z - r() * (len - segLen) - segLen / 2;
      const tone = lerp(0.55, 1.45, r());
      (r() < 0.55 ? glossy : matte).add(-(W + inset + depth / 2), y + h / 2, zc, depth, h * 0.94, segLen, [tone, tone, tone]);

      if (r() < 0.42 * density) {
        const [col, base] = LEFT_LIGHTS[Math.floor(r() * LEFT_LIGHTS.length)];
        const sl = segLen * lerp(0.3, 1, r());
        const th = lerp(0.01, 0.05, r() ** 2);
        strips.add(-(W + inset) + 0.006, y + h - th / 2, zc + (r() - 0.5) * (segLen - sl), 0.012, th, sl, col, stripParams(r, base * lerp(0.55, 1.25, r())));
      }
      y += h;
    }
    // masa del fondo, más alta, para recortar el cielo
    const bh = lerp(3.5, 8.5, r());
    matte.add(-(W + lerp(4, 7, r())), bh / 2, z - len / 2, 3, bh, len * 0.96, [0.7, 0.7, 0.7]);
    z -= len;
  }

  // ---- Muro derecho
  for (let z = Z_START; z > Z_END; ) {
    const len = lerp(2, 9, r());
    const zc = z - len / 2;

    // base: escalones de vidrio que suben y se alejan (la zona rayada de la imagen)
    let y = 0;
    let x = W;
    while (y < 1.0) {
      const h = lerp(0.04, 0.16, r());
      const sl = len * lerp(0.82, 1, r());
      const tone = lerp(0.6, 1.3, r());
      glossy.add(x + 1.25, y + h / 2, zc, 2.5, h * 0.9, sl, [tone, tone, tone]);
      if (r() < 0.55 * density) {
        const [col, base] = RIGHT_LIGHTS[Math.floor(r() * RIGHT_LIGHTS.length)];
        const ll = sl * lerp(0.25, 1, r());
        strips.add(x - 0.006, y + h * 0.5, zc + (r() - 0.5) * (sl - ll), 0.012, lerp(0.006, 0.02, r()), ll, col, stripParams(r, base * lerp(0.3, 0.8, r())));
      }
      y += h;
      x += lerp(0.04, 0.16, r());
    }

    // cuerpo medio: aletas finas y densas
    while (y < BAND.y0 - 0.02) {
      const h = Math.min(lerp(0.03, 0.3, r() ** 1.5), BAND.y0 - y);
      const inset = lerp(0.45, 1.15, r());
      const depth = lerp(0.3, 1.6, r());
      const sl = len * lerp(0.6, 1, r());
      const zz = zc + (r() - 0.5) * (len - sl);
      const tone = lerp(0.5, 1.5, r());
      (r() < 0.6 ? glossy : matte).add(W + inset + depth / 2, y + h / 2, zz, depth, h * 0.92, sl, [tone, tone, tone]);
      if (r() < 0.28 * density) {
        const [col, base] = RIGHT_LIGHTS[Math.floor(r() * RIGHT_LIGHTS.length)];
        const ll = sl * lerp(0.3, 1, r());
        const th = lerp(0.008, 0.035, r() ** 2);
        strips.add(W + inset - 0.006, y + h - th / 2, zz + (r() - 0.5) * (sl - ll), 0.012, th, ll, col, stripParams(r, base * lerp(0.5, 1.1, r())));
      }
      y += h;
    }
    // respaldo continuo detrás de las aletas
    matte.add(W + 1.9, BAND.y0 / 2, zc, 1, BAND.y0, len, [0.5, 0.5, 0.5]);

    // cornisa sobre la banda + línea blanca en su canto
    glossy.add(W + 1.35, BAND.y1 + 0.09, zc, 1.7, 0.18, len * 0.995, [1.2, 1.2, 1.2]);
    strips.add(W + 0.5 - 0.006, BAND.y1 + 0.012, zc, 0.012, 0.022, len * 0.99, C.white, stripParams(r, 2.2, 1.5));

    // fachada alta: bloques que retroceden, con alguna luz suelta
    let uy = BAND.y1 + 0.18;
    const top = lerp(9.2, 10.1, r());
    while (uy < top) {
      const h = Math.min(lerp(0.25, 2.4, r()), top - uy);
      const inset = lerp(0.9, 2.4, r());
      const tone = lerp(0.5, 1.2, r());
      (r() < 0.5 ? glossy : matte).add(W + inset + 1.5, uy + h / 2, zc, 3, h * 0.97, len * lerp(0.9, 1, r()), [tone, tone, tone]);
      if (r() < 0.22 * density) {
        const [col, base] = RIGHT_LIGHTS[Math.floor(r() * RIGHT_LIGHTS.length)];
        strips.add(W + inset - 0.006, uy + h - 0.02, zc, 0.012, 0.02, len * lerp(0.3, 0.9, r()), col, stripParams(r, base * 0.8));
      }
      uy += h;
    }
    // canto superior iluminado (la línea que sube en la esquina de la imagen)
    strips.add(W + 0.9 - 0.006, top - 0.015, zc, 0.012, 0.03, len * 0.99, C.white, stripParams(r, 1.7, 1.2));
    // torre del fondo
    const th2 = lerp(12, 30, r());
    matte.add(W + lerp(6, 9, r()), th2 / 2, zc, 4, th2, len * 0.9, [0.6, 0.6, 0.6]);

    z -= len;
  }

  // ---- Banda prismática: segmentos de color que recorren el muro derecho
  const bandH = BAND.y1 - BAND.y0;
  for (let z = Z_START; z > Z_END; ) {
    const seg = lerp(0.9, 1.6, r());
    const hue = (((z * 0.03 + 0.02 * Math.sin(z * 0.7)) % 1) + 1) % 1;
    const col = spectral(hue).map((v) => lerp(v, 1, 0.22));
    strips.add(BAND.face - 0.02, BAND.y0 + bandH / 2, z - seg / 2, 0.04, bandH * lerp(0.9, 1, r()), seg - 0.07, col, [r(), 0.06, lerp(2.4, 3.6, r()), 0.8]);
    z -= seg;
  }
  matte.add(BAND.face + 0.6, BAND.y0 + bandH / 2, (Z_START + Z_END) / 2, 1.2, bandH + 0.02, Z_START - Z_END, [0.4, 0.4, 0.4]);
}

// ---------------------------------------------------------------------------
// Torre de luz: barras prismáticas con núcleo blanco y bordes dispersos.
// Hueco central para que la cámara la atraviese.
// ---------------------------------------------------------------------------
const BARS = [
  // x, ancho, alto, color
  [-1.3, 0.1, 46, C.red],
  [-1.12, 0.28, 62, C.white],
  [-0.86, 0.07, 38, C.amber],
  [-0.68, 0.18, 54, [1, 0.94, 0.6]],
  [-0.5, 0.05, 30, [0.6, 0.8, 1]],
  [0.5, 0.06, 34, C.blue],
  [0.64, 0.3, 66, [0.9, 0.95, 1]],
  [0.96, 0.1, 44, C.cyan],
  [1.14, 0.16, 50, [1, 0.85, 0.3]],
  [1.33, 0.06, 40, C.violet],
];

export function buildTower(r, { bars, solids }) {
  for (const [x, w, h, col] of BARS) {
    const z = TOWER_Z - r() * 0.8;
    const inten = col === C.white ? lerp(2, 2.6, r()) : lerp(1.4, 2.2, r());
    bars.add(x, h / 2, z, w, h, w, col, [r(), lerp(0.04, 0.1, r()), inten, lerp(0.6, 1.6, r())]);
    if (w > 0.12) {
      // dispersión prismática a los lados del núcleo
      const fw = w * 0.22;
      bars.add(x - w / 2 - fw / 2, h * 0.45, z + 0.02, fw, h * 0.9, fw, C.red, [r(), 0.05, inten * 0.7, 1]);
      bars.add(x + w / 2 + fw / 2, h * 0.45, z + 0.02, fw, h * 0.9, fw, C.blue, [r(), 0.05, inten * 0.7, 1]);
    }
  }
  // caja oscura colgada de la torre, con cantos encendidos
  solids.add(0.98, 6.4, TOWER_Z + 0.6, 1.0, 2.4, 0.9, [1.4, 1.4, 1.4]);
  bars.add(0.48 + 0.005, 6.4, TOWER_Z + 1.06, 0.012, 2.4, 0.012, C.white, [0.3, 0.05, 2.2, 0.5]);
  bars.add(1.48 - 0.005, 6.4, TOWER_Z + 1.06, 0.012, 2.4, 0.012, C.cyan, [0.7, 0.05, 1.8, 0.5]);
}

// ---------------------------------------------------------------------------
// Escena 2: prismas iridiscentes suspendidos alrededor de la torre
// ---------------------------------------------------------------------------
export function shardData(r, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const sx = lerp(0.18, 0.7, r());
    const sy = lerp(0.35, 1.5, r());
    const sz = lerp(0.015, 0.05, r());
    out.push({
      // lejos del paso de la cámara: de cerca un cristal tapa la vista como un bloque negro
      pos: new THREE.Vector3(side * lerp(1.05, 1.95, r()), lerp(0.7, 4.6, r()), lerp(-80, -120, r())),
      rot: new THREE.Euler(lerp(-0.3, 0.3, r()), lerp(-1.2, 1.2, r()), lerp(-0.35, 0.35, r())),
      scale: new THREE.Vector3(sx, sy, sz),
      ph: r() * Math.PI * 2,
      f: lerp(0.35, 0.7, r()),
      spin: r() < 0.35 ? lerp(0.08, 0.2, r()) * (r() < 0.5 ? -1 : 1) : 0,
      hue: r(),
    });
  }
  return out;
}
