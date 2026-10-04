import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LOGO_PATHS } from './logos/data.js';
import { makeStripMaterial } from './materials.js';

// Especialidades: logos 3D que cuelgan de un hilo de luz entre la escena 1 y la 2.
// Bajan desde arriba conforme la cámara se acerca (atado al scroll, reversible).

const SIZE = 0.85; // lado mayor de cada logo (m)
const DEPTH = 0.07; // grosor de la pieza
const INLAY = 0.024; // cuánto sobresalen las capas en relieve
const REST_Y = 2.5; // altura de reposo
const DROP = 22; // desde cuánto más arriba bajan (fuera de cuadro hasta que empiezan, también en vertical)

// orden en el pasillo (de la escena 1 hacia la torre)
const ORDER = ['python', 'js', 'threejs', 'flutter', 'tauri', 'docker', 'arch', 'n8n', 'claude', 'codex'];
const INLAYS = { codex: ['prompt'], js: ['s'], flutter: ['mid'] };
// logos con trazos finos: bisel más pequeño para no deformarlos
const FINE = ['n8n', 'tauri', 'codex'];
export const LOGO_Z0 = -20;
export const LOGO_STEP = 5;

const smooth = THREE.MathUtils.smoothstep;

// Cara frontal: laca de color con barniz y reflejos; cantos: cromo oscuro
function faceMaterial(hex, envMap, glow = 0.16) {
  const c = new THREE.Color(hex);
  return new THREE.MeshPhysicalMaterial({
    color: c,
    metalness: 0.3,
    roughness: 0.14,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    iridescence: 0.18,
    envMap,
    envMapIntensity: 2.3,
    emissive: c,
    emissiveIntensity: glow,
  });
}

function buildTraced(key, envMap, sideMat) {
  const def = LOGO_PATHS[key];
  const loader = new SVGLoader();
  const layers = def.layers.map((l) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${def.w} ${def.h}"><path d="${l.d}" fill-rule="evenodd"/></svg>`;
    const shapes = loader.parse(svg).paths.flatMap((p) => p.toShapes());
    return { ...l, shapes };
  });

  const box = new THREE.Box2();
  layers.forEach((l) => l.shapes.forEach((s) => s.getPoints(3).forEach((p) => box.expandByPoint(p))));
  const size = box.getSize(new THREE.Vector2());
  const center = box.getCenter(new THREE.Vector2());
  const s = SIZE / Math.max(size.x, size.y);

  // grupo en píxeles del trazo, con y invertida (SVG crece hacia abajo)
  const inner = new THREE.Group();
  inner.scale.set(s, -s, s);
  for (const l of layers) {
    const inlay = INLAYS[key]?.includes(l.name);
    const geo = new THREE.ExtrudeGeometry(l.shapes, {
      depth: (DEPTH + (inlay ? INLAY : 0)) / s,
      bevelEnabled: true,
      bevelThickness: (FINE.includes(key) ? 0.008 : 0.016) / s,
      bevelSize: (FINE.includes(key) ? 0.004 : 0.008) / s,
      bevelSegments: 3,
      curveSegments: 7,
    });
    geo.translate(-center.x, -center.y, -DEPTH / 2 / s);
    const white = l.color.toLowerCase() === '#ffffff' || l.color.toLowerCase() === '#f5f5f7';
    const mesh = new THREE.Mesh(geo, [faceMaterial(l.color, envMap, white ? 0.55 : 0.16), sideMat]);
    inner.add(mesh);
  }
  return { object: inner, height: (size.y * s) / 2, color: def.layers[0].color };
}

// Three.js rediseñado: la malla triangular del logo hecha de barras y nodos de cromo
function buildThree(envMap) {
  const A = new THREE.Vector2(54, 56);
  const B = new THREE.Vector2(401, 156);
  const C = new THREE.Vector2(140, 406);
  const n = 4;
  const P = (i, j) => A.clone().add(B.clone().sub(A).multiplyScalar(i / n)).add(C.clone().sub(A).multiplyScalar(j / n));
  const box = new THREE.Box2().setFromPoints([A, B, C]);
  const size = box.getSize(new THREE.Vector2());
  const center = box.getCenter(new THREE.Vector2());
  const s = SIZE / Math.max(size.x, size.y);
  const r = 0.02 / s;

  const parts = [];
  const bar = (p, q) => {
    const len = p.distanceTo(q);
    const g = new THREE.CylinderGeometry(r, r, len, 12, 1);
    g.rotateZ(Math.atan2(q.y - p.y, q.x - p.x) - Math.PI / 2);
    g.translate((p.x + q.x) / 2 - center.x, (p.y + q.y) / 2 - center.y, 0);
    parts.push(g);
  };
  for (let i = 0; i <= n; i++) {
    for (let j = 0; i + j <= n; j++) {
      if (i + 1 + j <= n) bar(P(i, j), P(i + 1, j));
      if (i + j + 1 <= n) bar(P(i, j), P(i, j + 1));
      if (i + j + 1 <= n) bar(P(i + 1, j), P(i, j + 1));
      const node = new THREE.SphereGeometry(r * 1.45, 16, 12);
      const p = P(i, j);
      node.translate(p.x - center.x, p.y - center.y, 0);
      parts.push(node);
    }
  }
  const geo = mergeGeometries(parts);
  parts.forEach((g) => g.dispose());
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xe4e8f0,
    metalness: 1,
    roughness: 0.12,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMap,
    envMapIntensity: 1.6,
    emissive: new THREE.Color(0x9fb4d8),
    emissiveIntensity: 0.08,
  });
  const inner = new THREE.Group();
  inner.scale.set(s, -s, s);
  inner.add(new THREE.Mesh(geo, mat));
  return { object: inner, height: (size.y * s) / 2, color: '#cfd8e8' };
}

export function createLogos({ envMap, glowTex }) {
  const root = new THREE.Group();
  const sideMat = new THREE.MeshPhysicalMaterial({
    color: 0x16181e,
    metalness: 1,
    roughness: 0.14,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
    envMap,
    envMapIntensity: 1.3,
  });

  const items = ORDER.map((key, i) => {
    const built = key === 'threejs' ? buildThree(envMap) : buildTraced(key, envMap, sideMat);
    const side = i % 2 === 0 ? -1 : 1;
    const holder = new THREE.Group();
    holder.add(built.object);

    // halo del color de la marca detrás de la pieza
    const c = new THREE.Color(built.color);
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        color: c.clone().multiplyScalar(0.22),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      })
    );
    halo.scale.set(2.6, 2.6, 1);
    halo.position.z = -0.25;
    holder.add(halo);
    root.add(holder);

    return {
      key,
      holder,
      color: c,
      half: built.height,
      x: side * 1.5,
      z: LOGO_Z0 - i * LOGO_STEP,
      yaw: -side * 0.45, // de cara al centro del pasillo
      side,
      phase: i * 1.37,
    };
  });

  // hilos de luz de los que cuelgan
  const threadGeo = new THREE.BoxGeometry(1, 1, 1);
  const threads = new THREE.InstancedMesh(threadGeo, makeStripMaterial({ alongY: true, fogScale: 0.9 }), items.length);
  threads.frustumCulled = false;
  {
    const params = new Float32Array(items.length * 4);
    items.forEach((it, i) => {
      params.set([i * 0.31, 0.12, 1.1, 1.6], i * 4);
      threads.setColorAt(i, it.color.clone().lerp(new THREE.Color(1, 1, 1), 0.55));
    });
    threadGeo.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
  }
  root.add(threads);

  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const TOP = 42;

  function update(cameraZ, t, revealZ) {
    items.forEach((it, i) => {
      const d = cameraZ - it.z; // distancia por delante de la cámara
      it.holder.visible = revealZ < it.z + 2;
      // 0 arriba (fuera de cuadro) → 1 en reposo
      const s = 1 - smooth(d, 8, 23);
      const e = 1 - Math.pow(1 - s, 3);
      const y = REST_Y + (1 - e) * DROP + Math.sin(t * 0.9 + it.phase) * 0.03;
      it.holder.position.set(it.x, y, it.z);
      it.holder.rotation.set(
        Math.sin(t * 0.5 + it.phase) * 0.04,
        it.yaw + Math.sin(t * 0.42 + it.phase) * 0.22,
        (1 - e) * 0.28 * it.side
      );

      const top = y + it.half;
      const h = Math.max(0.01, TOP - top);
      p.set(it.x, top + h / 2, it.z);
      sc.set(0.006, h, 0.006);
      m.compose(p, q, sc);
      threads.setMatrixAt(i, m);
    });
    threads.instanceMatrix.needsUpdate = true;
  }

  return { root, update, center: new THREE.Vector3(0, REST_Y, LOGO_Z0 - ((ORDER.length - 1) * LOGO_STEP) / 2) };
}
