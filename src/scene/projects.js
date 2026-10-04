import * as THREE from 'three';
import { cardTexture, CARD_LAYOUT } from './textures.js';
import { makeStripMaterial } from './materials.js';

// Archivo (escena 3): una escalera de tres cartas de cristal que cuelgan de hilos
// de luz. Están ligadas al índice del DOM (foco en ambos sentidos). La primera es
// Nexo: su pantalla reproduce el video y, al abrirla, se despega de la carta, sube
// con la cámara y termina exactamente donde está el <video> de la vista de detalle.

export const PROJECTS = [
  { index: '01', title: 'Nexo', desc: 'Espacio de conocimiento personal', video: '/media/nexo.mp4', clickable: true },
  { index: '02', title: '[Proyecto 02]', desc: 'Próximamente' },
  { index: '03', title: '[Proyecto 03]', desc: 'Próximamente' },
];

const CARD_W = 1.6;
const CARD_H = 1.0;
const CARD_R = 0.045;
const CARD_D = 0.026;
const BEVEL = 0.004;
const FRONT = CARD_D / 2 + BEVEL; // z de la cara frontal del cristal
const RIM = 0.0032; // grosor del canto de luz
const VIDEO_ASPECT = 1600 / 908;
const DETAIL_DIST = 3; // distancia a la cámara del video en la vista de detalle

// Disposición de las cartas: [x, y, z, giro, escala]. Cuelgan por encima del paso
// de la cámara (que pasa por debajo al seguir el recorrido).
// - "wide" (pantallas horizontales): tríptico sobre el centro del pasillo; Nexo
//   al centro y más grande, las otras dos a los lados, giradas hacia dentro.
// - "tall" (pantallas verticales): en T, Nexo grande arriba y las otras dos debajo,
//   todo por encima del texto de la escena.
const DECK = {
  wide: [
    [0, 2.95, -156.0, 0, 1.12],
    [-1.56, 2.88, -157.2, 0.24, 0.8],
    [1.56, 2.88, -157.2, -0.24, 0.8],
  ],
  tall: [
    [0, 3.5, -155.0, 0, 1.2],
    [-0.6, 2.62, -155.6, 0.08, 0.66],
    [0.6, 2.62, -155.6, -0.08, 0.66],
  ],
};
export const DECK_CENTER = new THREE.Vector3(0, 2.9, -156.5);

const smooth = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => 1 - Math.pow(1 - x, 3);

function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - r);
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + h);
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

// UV de 0 a 1 sobre el rectángulo (ShapeGeometry los deja en coordenadas de forma)
function planarUV(geo, w, h) {
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / w + 0.5;
    uv[i * 2 + 1] = pos.getY(i) / h + 0.5;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

// Pantalla de video con esquinas redondeadas. En el detalle compensa el tone
// mapping ACES de la salida (inverso exacto de la curva de three.js), de modo que
// el plano 3D se ve igual que el <video> del DOM y el relevo no se nota.
function makeScreenMaterial(map, exposure) {
  const acesIn = new THREE.Matrix3().set(0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777);
  const acesOut = new THREE.Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602);
  return new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      map: { value: map },
      uRepeat: { value: new THREE.Vector2(1, 1) },
      uOffset: { value: new THREE.Vector2(0, 0) },
      uAspect: { value: 1 },
      uRadius: { value: 0.035 },
      uOpacity: { value: 1 },
      uUntone: { value: 0 },
      uGain: { value: 0.86 },
      uExposure: { value: exposure },
      uInvIn: { value: acesIn.invert() },
      uInvOut: { value: acesOut.invert() },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec2 uRepeat;
      uniform vec2 uOffset;
      uniform float uAspect;
      uniform float uRadius;
      uniform float uOpacity;
      uniform float uUntone;
      uniform float uGain;
      uniform float uExposure;
      uniform mat3 uInvIn;
      uniform mat3 uInvOut;
      varying vec2 vUv;
      vec3 srgbToLinear(vec3 c) {
        return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
      }
      // inversa de RRTAndODTFit (resuelve la cuadrática por canal)
      vec3 fitInverse(vec3 y) {
        y = clamp(y, 0.0, 0.995);
        vec3 A = 1.0 - 0.983729 * y;
        vec3 B = 0.0245786 - 0.4329510 * y;
        vec3 C = -0.000090537 - 0.238081 * y;
        return (-B + sqrt(max(B * B - 4.0 * A * C, vec3(0.0)))) / (2.0 * A);
      }
      void main() {
        vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
        vec2 q = abs(p) - (vec2(uAspect, 1.0) * 0.5 - uRadius);
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
        float aa = max(fwidth(d), 1e-4);
        float mask = 1.0 - smoothstep(-aa, aa, d);
        vec3 c = srgbToLinear(texture2D(map, vUv * uRepeat + uOffset).rgb) * uGain;
        vec3 untoned = (uInvIn * fitInverse(uInvOut * c)) * (0.6 / uExposure);
        c = mix(c, max(untoned, 0.0), uUntone);
        gl_FragColor = vec4(c, mask * uOpacity);
      }
    `,
  });
}

export function createProjects({ scene, crystalMat, exposure = 0.9 }) {
  const { W, H, pad, screenTop, screenBottom, radius } = CARD_LAYOUT;
  const mPerPx = CARD_W / W;
  const screen = {
    w: (W - pad * 2) * mPerPx,
    h: (screenBottom - screenTop) * mPerPx,
    y: (H / 2 - (screenTop + screenBottom) / 2) * mPerPx,
    r: radius * mPerPx,
  };
  const coverRepeatY = Math.min(1, VIDEO_ASPECT / (screen.w / screen.h));

  // geometrías compartidas
  const slabGeo = new THREE.ExtrudeGeometry(roundedRect(CARD_W, CARD_H, CARD_R), {
    depth: CARD_D,
    bevelEnabled: true,
    bevelThickness: BEVEL,
    bevelSize: BEVEL,
    bevelSegments: 2,
    curveSegments: 10,
  });
  slabGeo.translate(0, 0, -CARD_D / 2);
  const faceGeo = planarUV(
    new THREE.ShapeGeometry(roundedRect(CARD_W - 0.004, CARD_H - 0.004, CARD_R - 0.002), 10),
    CARD_W - 0.004,
    CARD_H - 0.004
  );
  const rimShape = roundedRect(CARD_W, CARD_H, CARD_R);
  rimShape.holes.push(roundedRect(CARD_W - RIM * 2, CARD_H - RIM * 2, CARD_R - RIM));
  const rimGeo = new THREE.ShapeGeometry(rimShape, 10);

  const cards = PROJECTS.map((def, i) => {
    const group = new THREE.Group();
    const slabMat = crystalMat.clone(); // propio, para poder desvanecerlo
    slabMat.transparent = true;
    const slab = new THREE.Mesh(slabGeo, slabMat);
    const faceMat = new THREE.MeshBasicMaterial({
      map: cardTexture({ ...def, media: !!def.video }),
      transparent: true,
      color: new THREE.Color().setRGB(0.9, 0.9, 0.92),
    });
    const face = new THREE.Mesh(faceGeo, faceMat);
    face.position.z = FRONT + 0.0006;
    const rimBase = new THREE.Color().setRGB(1.25, 1.3, 1.45);
    const rimMat = new THREE.MeshBasicMaterial({ color: rimBase.clone(), transparent: true });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.position.z = FRONT + 0.0012;
    group.add(slab, face, rim);
    scene.add(group);
    return {
      def,
      group,
      face,
      slabMat,
      faceMat,
      rimMat,
      rimBase,
      phase: i * 1.9,
      pos: new THREE.Vector3(),
      rotY: 0,
      rz: 0,
      size: 1,
      hover: 0,
      focus: 0,
      dim: 0,
      u: 0,
      v: 0,
      prox: 0,
      pu: 0,
      pv: 0,
      visible: false,
    };
  });

  // hilos de luz de los que cuelgan las cartas
  const threadGeo = new THREE.BoxGeometry(1, 1, 1);
  const threadMat = makeStripMaterial({ alongY: true, fogScale: 0.9 });
  const threads = new THREE.InstancedMesh(threadGeo, threadMat, cards.length);
  threads.frustumCulled = false;
  {
    const params = new Float32Array(cards.length * 4);
    cards.forEach((c, i) => {
      params.set([0.2 + i * 0.27, 0.1, 1.0, 1.4], i * 4);
      threads.setColorAt(i, new THREE.Color(0.85, 0.9, 1));
    });
    threadGeo.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
  }
  scene.add(threads);

  // ---- video de Nexo ----
  const nexo = cards[0];
  const video = document.createElement('video');
  video.src = nexo.def.video;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  const vtex = new THREE.VideoTexture(video);
  vtex.colorSpace = THREE.SRGBColorSpace;
  vtex.generateMipmaps = false;
  const smat = makeScreenMaterial(vtex, exposure);
  const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), smat);
  screenMesh.matrixAutoUpdate = false;
  screenMesh.frustumCulled = false;
  screenMesh.renderOrder = 2;
  scene.add(screenMesh);
  let playing = false;
  const setPlaying = (on) => {
    if (on === playing) return;
    playing = on;
    if (on) video.play().catch(() => (playing = false));
    else video.pause();
  };

  // ---- auxiliares ----
  const corners = [
    new THREE.Vector3(-CARD_W / 2, -CARD_H / 2, 0),
    new THREE.Vector3(CARD_W / 2, -CARD_H / 2, 0),
    new THREE.Vector3(CARD_W / 2, CARD_H / 2, 0),
    new THREE.Vector3(-CARD_W / 2, CARD_H / 2, 0),
  ];
  const tmp = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const baseM = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const local = new THREE.Matrix4();
  const mA = new THREE.Matrix4();
  const invBase = new THREE.Matrix4();
  const mT = new THREE.Matrix4();
  const pA = new THREE.Vector3();
  const pB = new THREE.Vector3();
  const qA = new THREE.Quaternion();
  const qB = new THREE.Quaternion();
  const sA = new THREE.Vector3();
  const sB = new THREE.Vector3();
  const sT = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  let hovered = -1;

  /**
   * pointer: cursor { x, y (NDC), active, wPx, hPx }
   * detail: 0 en el recorrido → 1 en la vista de detalle (lineal; aquí se suaviza)
   * rect: rectángulo del <video> del detalle en NDC { x0, x1, y0, y1, hPx }
   * focus: carta enfocada desde el índice del DOM (-1 ninguna)
   * baseCamera: matriz de la cámara antes de elevarse para el detalle
   */
  function update({ camera, baseCamera, t, pointer, detail, rect, revealZ, focus }) {
    const d = detail;
    const wide = smooth(camera.aspect, 0.75, 1.25);
    hovered = -1;

    // 1) pose base de cada carta y proximidad del cursor
    cards.forEach((c, i) => {
      const a = DECK.tall[i];
      const b = DECK.wide[i];
      c.pos.set(lerp(a[0], b[0], wide), lerp(a[1], b[1], wide), lerp(a[2], b[2], wide));
      c.pos.y += Math.sin(t * 0.55 + c.phase) * 0.035;
      c.rotY = lerp(a[3], b[3], wide);
      c.size = lerp(a[4], b[4], wide);
      c.rz = Math.sin(t * 0.4 + c.phase) * 0.01;
      c.visible = revealZ < c.pos.z + 2;
      c.prox = 0;
      c.pu = 0;
      c.pv = 0;
      if (!pointer.active || d > 0 || !c.visible) return;
      e.set(0, c.rotY, c.rz);
      baseM.compose(c.pos, q.setFromEuler(e), sT.setScalar(c.size));
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of corners) {
        tmp.copy(p).applyMatrix4(baseM).project(camera);
        if (tmp.z > 1) return; // detrás de la cámara
        minX = Math.min(minX, tmp.x);
        maxX = Math.max(maxX, tmp.x);
        minY = Math.min(minY, tmp.y);
        maxY = Math.max(maxY, tmp.y);
      }
      const dx = Math.max(minX - pointer.x, 0, pointer.x - maxX) * pointer.wPx * 0.5;
      const dy = Math.max(minY - pointer.y, 0, pointer.y - maxY) * pointer.hPx * 0.5;
      c.prox = 1 - smooth(Math.hypot(dx, dy), 0, 150);
      c.pu = THREE.MathUtils.clamp((pointer.x - (minX + maxX) / 2) / ((maxX - minX) / 2 || 1), -1.4, 1.4);
      c.pv = THREE.MathUtils.clamp((pointer.y - (minY + maxY) / 2) / ((maxY - minY) / 2 || 1), -1.4, 1.4);
      if (c.prox > 0.999 && (hovered < 0 || c.pos.z > cards[hovered].pos.z)) hovered = i;
    });

    // 2) foco (índice del DOM o carta bajo el cursor) y movimiento
    const active = focus >= 0 ? focus : hovered;
    const fade = 1 - smooth(d, 0.1, 0.42); // en el detalle la escalera se disuelve
    const flare = 1 + 2.2 * Math.sin(Math.PI * smooth(d, 0, 0.3)); // el canto destella al abrir
    cards.forEach((c, i) => {
      const f = active === i ? 1 : 0;
      const dim = active >= 0 && active !== i ? 1 : 0;
      c.hover += (c.prox - c.hover) * 0.12;
      c.u += (c.pu - c.u) * 0.12;
      c.v += (c.pv - c.v) * 0.12;
      c.focus += (f - c.focus) * 0.1;
      c.dim += (dim - c.dim) * 0.1;

      dir.set(-c.pos.x, 0, camera.position.z - c.pos.z).normalize(); // hacia la cámara
      const lift = i === 0 ? 0.5 * easeOut(smooth(d, 0, 0.35)) : 0;
      c.group.visible = c.visible && fade > 0.001;
      c.group.position.copy(c.pos).addScaledVector(dir, 0.12 * c.hover + 0.32 * c.focus + lift);
      c.group.position.y += 0.03 * c.hover;
      c.group.rotation.set(-c.v * 0.12 * c.hover, c.rotY + c.u * 0.18 * c.hover, c.rz);
      c.group.scale.setScalar(c.size * (1 + 0.035 * c.focus));
      c.group.updateMatrixWorld();

      const glow = (1 + 1.3 * Math.max(c.hover, c.focus)) * (1 - 0.45 * c.dim);
      c.rimMat.color.copy(c.rimBase).multiplyScalar(glow * (i === 0 ? flare : 1));
      c.rimMat.opacity = fade;
      c.faceMat.color.setScalar(0.9 * (1 - 0.35 * c.dim));
      c.faceMat.opacity = fade;
      c.slabMat.opacity = fade;

      // hilo: del borde superior de la carta hacia el cielo
      const top = c.group.position.y + (CARD_H / 2) * c.group.scale.y;
      const h = Math.max(0.01, 40 - top);
      mT.compose(tmp.set(c.group.position.x, top + h / 2, c.group.position.z), q.identity(), sT.set(0.005, h, 0.005));
      threads.setMatrixAt(i, mT);
    });
    threads.instanceMatrix.needsUpdate = true;
    threads.visible = cards.some((c) => c.visible) && fade > 0.001;
    threadMat.uniforms.uIntensity.value = fade;

    // 3) pantalla de Nexo: sobre la carta en el recorrido, sobre el <video> en el detalle.
    // La transición se interpola en el espacio de la vista: la pantalla va en línea
    // recta desde donde la viste hasta su lugar final, mientras la cámara se eleva
    // (si se interpolara en el mundo, al subir la cámara saldría por abajo del cuadro).
    local.compose(tmp.set(0, screen.y, FRONT + 0.0018), q.identity(), sA.set(screen.w, screen.h, 1));
    mA.multiplyMatrices(nexo.group.matrixWorld, local);
    const kd = easeInOut(smooth(d, 0.08, 0.92));
    let radiusFrac = screen.r / screen.h;
    if (d > 0 && baseCamera) {
      mA.premultiply(invBase.copy(baseCamera).invert()); // dónde estaba en la vista
      mA.decompose(pA, qA, sA);
      const halfH = DETAIL_DIST * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      const halfW = halfH * camera.aspect;
      pB.set(((rect.x0 + rect.x1) / 2) * halfW, ((rect.y0 + rect.y1) / 2) * halfH, -DETAIL_DIST);
      qB.identity();
      sB.set((rect.x1 - rect.x0) * halfW, (rect.y1 - rect.y0) * halfH, 1);
      pA.lerp(pB, kd);
      qA.slerp(qB, kd);
      sA.lerp(sB, kd);
      mA.compose(pA, qA, sA).premultiply(camera.matrixWorld);
      const rectHpx = ((rect.y1 - rect.y0) / 2) * rect.hPx;
      radiusFrac = lerp(radiusFrac, 14 / Math.max(1, rectHpx), kd);
    }
    mA.decompose(pA, qA, sA);
    screenMesh.visible = nexo.visible || d > 0;
    // en la transición la pantalla vuela hacia ti: va por encima de todo (si no, al
    // avanzar la cámara cruzaría el plano de su propia carta y quedaría tapada)
    smat.depthTest = d <= 0;
    smat.depthWrite = d <= 0;
    screenMesh.matrix.compose(pA, qA, sA);
    screenMesh.matrixWorldNeedsUpdate = true;
    const ry = lerp(coverRepeatY, 1, kd);
    smat.uniforms.uRepeat.value.set(1, ry);
    smat.uniforms.uOffset.value.set(0, (1 - ry) / 2);
    smat.uniforms.uAspect.value = sA.x / Math.max(1e-4, sA.y);
    smat.uniforms.uRadius.value = radiusFrac;
    smat.uniforms.uGain.value = lerp(0.86, 1, kd);
    smat.uniforms.uUntone.value = smooth(d, 0.35, 0.92);

    // solo se decodifica el video cuando la carta está cerca o en el detalle
    const dz = camera.position.z - nexo.pos.z;
    setPlaying(d > 0 || (nexo.visible && dz < 70 && dz > -8));
  }

  // carta bajo el cursor (rayo exacto) o -1
  function pick(ndc, camera) {
    raycaster.setFromCamera(ndc, camera);
    const targets = cards.filter((c) => c.group.visible).map((c) => c.face);
    if (screenMesh.visible) targets.push(screenMesh);
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (!hit) return -1;
    return hit.object === screenMesh ? 0 : cards.findIndex((c) => c.face === hit.object);
  }

  return {
    update,
    pick,
    get hovered() {
      return hovered;
    },
    isClickable: (i) => !!(cards[i] && cards[i].def.clickable),
    video,
    hideables: [...cards.map((c) => c.group), screenMesh, threads],
  };
}
