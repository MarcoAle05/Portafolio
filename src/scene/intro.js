import * as THREE from 'three';
import { makeStripMaterial } from './materials.js';
import { spectral } from './build.js';

// El cubo de entrada: mismo cristal iridiscente que los prismas, aristas de luz
// prismática y un núcleo de luz que estalla al abrirse.

export const CUBE_POS = new THREE.Vector3(0, 1.4, 2.2);
const SIZE = 1.1;
const HALF = SIZE / 2;
const THICK = 0.035;

const smooth = THREE.MathUtils.smoothstep;
const Z = new THREE.Vector3(0, 0, 1);

export function createIntroCube(crystalMat, glowTex) {
  // root no gira (halo, núcleo, luces); spinner gira con las caras
  const root = new THREE.Group();
  root.position.copy(CUBE_POS);
  const group = new THREE.Group();

  // seis caras: cada una es una losa de cristal que sale despedida en su normal
  const normals = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ].map((n) => new THREE.Vector3(...n));
  const baseQ = normals.map((n) => new THREE.Quaternion().setFromUnitVectors(Z, n));
  const tumbleAxis = normals.map((_, i) =>
    new THREE.Vector3(Math.sin(i * 2.3 + 0.4), Math.cos(i * 1.7), Math.sin(i * 3.1 + 1.1)).normalize()
  );
  const tumbleDir = normals.map((_, i) => (i % 2 === 0 ? 1 : -1));

  const faces = new THREE.InstancedMesh(new THREE.BoxGeometry(SIZE, SIZE, THICK), crystalMat, 6);
  faces.frustumCulled = false;

  // aristas: 4 por cara (se superponen con las de la cara vecina mientras está cerrado)
  const edgeMat = makeStripMaterial({ alongY: true, reveal: false, fogScale: 0.6 });
  const edgeGeo = new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.InstancedMesh(edgeGeo, edgeMat, 24);
  edges.frustumCulled = false;
  const edgeLocal = [];
  {
    const params = new Float32Array(24 * 4);
    const c = new THREE.Color();
    const w = 0.014;
    const L = SIZE + 0.004;
    const rz = new THREE.Quaternion().setFromAxisAngle(Z, Math.PI / 2);
    const id = new THREE.Quaternion();
    const defs = [
      [0, HALF, rz], // arriba (a lo largo de x)
      [0, -HALF, rz], // abajo
      [-HALF, 0, id], // izquierda (a lo largo de y)
      [HALF, 0, id], // derecha
    ];
    for (let f = 0; f < 6; f++) {
      defs.forEach(([x, y, q], e) => {
        const i = f * 4 + e;
        edgeLocal.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, THICK / 2), q, new THREE.Vector3(w, L, w)));
        const [r, g, b] = spectral((i * 0.137) % 1);
        edges.setColorAt(i, c.setRGB(r * 0.6 + 0.4, g * 0.6 + 0.4, b * 0.6 + 0.4));
        params.set([(i * 0.618) % 1, 0.18, 2.4, 1.6], i * 4);
      });
    }
    edgeGeo.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
  }

  // núcleo de luz: oculto dentro del cubo hasta que se abre
  const core = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTex,
      color: new THREE.Color().setRGB(2.2, 2.35, 2.7),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false, // el destello no se recorta contra las siluetas apagadas del pasillo
      transparent: true,
      fog: false,
    })
  );
  core.scale.setScalar(0.001);
  core.renderOrder = 2;
  const coreLight = new THREE.PointLight(0xdfe8ff, 0, 9, 2);

  // halo tenue detrás del cubo para separarlo del negro
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTex,
      color: new THREE.Color().setRGB(0.07, 0.08, 0.11),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
    })
  );
  halo.scale.set(9, 9, 1);
  halo.position.set(0, 0.2, -2.5);

  group.add(faces, edges);
  root.add(group, core, coreLight, halo);

  const m = new THREE.Matrix4();
  const me = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const qt = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  let spin = 0;

  // intro: 0 = cerrado, 1 = abierto del todo
  function update(intro, t, dt, mx, my) {
    if (intro >= 1) {
      root.visible = false;
      coreLight.intensity = 0;
      return;
    }
    root.visible = true;

    // rotación continua; se frena al abrir para que la explosión se lea bien
    const idle = 1 - smooth(intro, 0, 0.18);
    spin += (dt / 1000) * (0.12 + 0.2 * idle);
    group.rotation.set(0.3 + Math.sin(t * 0.37) * 0.08 * idle - my * 0.25, spin + mx * 0.45, 0.14);
    root.position.y = CUBE_POS.y + Math.sin(t * 0.8) * 0.06 * idle;

    const sep = smooth(intro, 0.08, 0.62);
    const d = sep * sep * 5.5;
    const shrink = 1 - smooth(intro, 0.38, 0.8);

    for (let f = 0; f < 6; f++) {
      p.copy(normals[f]).multiplyScalar(HALF + d);
      qt.setFromAxisAngle(tumbleAxis[f], sep * 2.4 * tumbleDir[f]);
      q.copy(qt).multiply(baseQ[f]);
      s.setScalar(Math.max(shrink, 0.0001));
      m.compose(p, q, s);
      faces.setMatrixAt(f, m);
      for (let e = 0; e < 4; e++) {
        edges.setMatrixAt(f * 4 + e, me.multiplyMatrices(m, edgeLocal[e]));
      }
    }
    faces.instanceMatrix.needsUpdate = true;
    edges.instanceMatrix.needsUpdate = true;

    // las aristas se encienden antes de abrirse y se apagan con las caras
    const charge = Math.sin(Math.PI * smooth(intro, 0, 0.32));
    edgeMat.uniforms.uIntensity.value = (1 + charge * 2.6 + Math.sin(t * 1.6) * 0.12 * idle) * shrink;

    const burst = Math.sin(Math.PI * smooth(intro, 0.1, 0.6));
    core.scale.setScalar(0.001 + burst * 3.4);
    core.material.opacity = burst;
    coreLight.intensity = burst * 12 + charge * 4;
    halo.material.opacity = 1 - smooth(intro, 0.2, 0.6);
  }

  return { root, update };
}
