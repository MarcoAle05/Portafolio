import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { Z_START, TOWER_LIGHT, BEAM, FOG, CAMERA_KEYS } from './layout.js';
import { shared, makeStripMaterial, makeWallMaterial, makeDustMaterial, floorShader, FinishShader } from './materials.js';
import { glowTexture, raysTexture, ringTexture } from './textures.js';
import { rng, Batch, spectral, buildCorridor, buildTower, shardData } from './build.js';
import { createIntroCube, CUBE_POS } from './intro.js';
import { createLogos } from './logos.js';
import { createProjects, DECK_CENTER } from './projects.js';

// Niveles de calidad. El nivel se elige por dispositivo y luego se ajusta solo
// según los FPS reales (ver adaptQuality).
const TIERS = {
  // cube: resolución de la cámara cúbica de reflejos; cubeEvery: cada cuántos frames se actualiza
  high: { dpr: 1.5, refl: 0.5, msaa: 4, density: 1, taps: 9, dust: 1800, shards: 28, cube: 256, cubeEvery: 1 },
  mid: { dpr: 1.25, refl: 0.4, msaa: 2, density: 0.8, taps: 7, dust: 1200, shards: 22, cube: 128, cubeEvery: 2 },
  low: { dpr: 1, refl: 0.32, msaa: 0, density: 0.6, taps: 5, dust: 700, shards: 16, cube: 96, cubeEvery: 3 },
};

function pickTier(forced) {
  if (forced && TIERS[forced]) return forced;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.screen.width, window.screen.height) < 700;
  if (coarse || small) return 'low';
  if ((navigator.hardwareConcurrency || 4) <= 4) return 'mid';
  return 'high';
}

const fovFor = (aspect) => (aspect < 0.75 ? 70 : aspect < 1.3 ? 60 : 50);

export function createWorld(canvas, { reduceMotion = false, quality = null } = {}) {
  const tierName = pickTier(quality);
  const tier = TIERS[tierName];
  const r = rng(20261003);

  // ---------- Renderer ----------
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // el MSAA va en el render target del composer
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setClearColor(0x020203, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020203);
  scene.fog = new THREE.FogExp2(FOG.color, FOG.density);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.08, 900);
  camera.rotation.order = 'YXZ';

  // ---------- Entorno: reflejos de los metales ----------
  // Un pequeño pasillo de luces renderizado a un mapa PMREM: los muros metálicos
  // reflejan franjas de color en vez de un gris plano.
  {
    const env = new THREE.Scene();
    env.background = new THREE.Color(0x000000);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const add = (x, y, z, sx, sy, sz, rgb, k) => {
      const m = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(rgb[0] * k, rgb[1] * k, rgb[2] * k) }));
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      env.add(m);
    };
    add(0, 3, -40, 3, 30, 1, [0.9, 0.95, 1], 6); // la luz del fondo
    for (let i = 0; i < 16; i++) add(4, 2.6, 22 - i * 3, 0.2, 0.5, 2.6, spectral(i / 16), 1.6); // banda derecha
    for (let i = 0; i < 4; i++) add(-4, -0.5 + i * 0.9, 0, 0.2, 0.025, 60, [1, 0.55, 0.25], 1.4); // luces cálidas
    for (let i = 0; i < 10; i++) add(r() < 0.5 ? -4 : 4, lerp(-2, 6, r()), lerp(-30, 30, r()), 0.2, 0.02, lerp(2, 12, r()), [1, 1, 1], 2.2);
    add(0, 22, 0, 60, 0.5, 60, [0.03, 0.035, 0.05], 1); // cielo
    add(0, -3, 0, 60, 0.2, 60, [0.015, 0.015, 0.02], 1); // suelo
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(env, 0.03).texture;
    pmrem.dispose();
    env.traverse((o) => o.material && o.material.dispose());
    box.dispose();
  }

  // ---------- Luces reales ----------
  const hemi = new THREE.HemisphereLight(0x7a88a8, 0x050505, 0.025);
  scene.add(hemi);
  const towerLight = new THREE.PointLight(0xe6edff, 100, 0, 2);
  towerLight.position.set(...TOWER_LIGHT);
  scene.add(towerLight);
  const beamLight = new THREE.PointLight(0xf2f5ff, 320, 0, 2);
  beamLight.position.set(BEAM[0], 2.5, BEAM[1] + 1.5);
  scene.add(beamLight);

  // ---------- Pasillo ----------
  const glossyMat = makeWallMaterial({ color: 0x0b0c0f, roughness: 0.12, metalness: 1, envMapIntensity: 0.5, glints: 1 });
  const matteMat = makeWallMaterial({ color: 0x07080a, roughness: 0.42, metalness: 0.75, envMapIntensity: 0.22, glints: 0.5 });
  const stripMat = makeStripMaterial();

  const glossy = new Batch();
  const matte = new Batch();
  const strips = new Batch();
  buildCorridor(r, tier.density, { glossy, matte, strips });

  // ---------- Torre ----------
  const bars = new Batch();
  buildTower(r, { bars, solids: glossy });

  const barsMat = makeStripMaterial({ alongY: true, fogScale: 0.42 });
  // el pasillo completo: se excluye de la cámara de reflejos mientras sigue apagado
  const corridor = [
    glossy.mesh(glossyMat),
    matte.mesh(matteMat),
    strips.mesh(stripMat, { withParams: true }),
    bars.mesh(barsMat, { withParams: true }),
  ];
  scene.add(...corridor);

  // ---------- Sprites de luz ----------
  const glowTex = glowTexture();
  const raysTex = raysTexture(r);
  const ringTex = ringTexture();
  const sprite = (tex, rgb, k, sx, sy, pos, opts = {}) => {
    const m = new THREE.SpriteMaterial({
      map: tex,
      color: new THREE.Color().setRGB(rgb[0] * k, rgb[1] * k, rgb[2] * k),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      fog: false,
      depthTest: opts.depthTest ?? true,
    });
    const s = new THREE.Sprite(m);
    s.scale.set(sx, sy, 1);
    s.position.set(...pos);
    scene.add(s);
    return s;
  };
  const skyHaze = sprite(glowTex, [0.6, 0.66, 0.78], 0.025, 170, 110, [-2, 16, -125]); // bruma del cielo
  const towerGlow = sprite(glowTex, [0.92, 0.95, 1], 0.55, 9, 9, TOWER_LIGHT);
  const towerCore = sprite(glowTex, [1, 1, 1], 5, 1.2, 1.2, TOWER_LIGHT);
  const rays = sprite(raysTex, [0.9, 0.94, 1], 0.22, 46, 46, [TOWER_LIGHT[0], TOWER_LIGHT[1] + 1, TOWER_LIGHT[2] - 0.5]);
  const towerFlare = sprite(glowTex, [1, 1, 1], 0.25, 30, 0.9, TOWER_LIGHT); // destello anamórfico

  // ---------- Reflejos vivos de los cristales ----------
  // Una cámara cúbica renderiza el escenario real desde el objeto de cristal que
  // está en juego (el cubo, los prismas o los paneles): reflejan las luces del
  // pasillo, el suelo y la torre, no un entorno fijo.
  const cubeRT = new THREE.WebGLCubeRenderTarget(tier.cube, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  const cubeCam = new THREE.CubeCamera(0.05, 320, cubeRT);
  const crystalMat = new THREE.MeshPhysicalMaterial({
    color: 0x0b0d12,
    metalness: 1,
    roughness: 0.035,
    iridescence: 1,
    iridescenceIOR: 1.75,
    iridescenceThicknessRange: [180, 720],
    envMap: cubeRT.texture,
    envMapIntensity: 1.5,
    // reflejo estirado en vertical, como el del suelo mojado
    anisotropy: 0.5,
    anisotropyRotation: Math.PI / 2,
  });

  // ---------- Cubo de entrada ----------
  const cube = createIntroCube(crystalMat, glowTex);
  scene.add(cube.root);
  // luces de estudio detrás de la cámara: no se ven en pantalla, pero el cubo
  // las refleja mientras el pasillo sigue apagado
  const studio = new Batch();
  studio.add(-2.8, 2.2, 13, 0.08, 3.4, 0.08, [0.9, 0.95, 1], [0.1, 0.05, 3.2, 0.6]);
  studio.add(2.8, 2.0, 13.5, 0.08, 3.0, 0.08, [1, 0.85, 0.7], [0.6, 0.05, 2.6, 0.6]);
  studio.add(0, 4.2, 12, 0.08, 4.5, 0.08, [0.8, 0.88, 1], [0.3, 0.05, 2.2, 0.6], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2));
  const studioMat = makeStripMaterial({ alongY: true, reveal: false, fogScale: 0 });
  const studioMesh = studio.mesh(studioMat, { withParams: true });
  scene.add(studioMesh);
  // paneles difusos (softboxes): dan a las caras del cubo degradados de luz suaves
  const softboxes = [
    [0, 2.4, 12.5, 7, 6, Math.PI, [1.6, 1.7, 2]],
    [-4.6, 2.0, 9.5, 4.5, 5, Math.PI / 2, [1.5, 1.2, 1]],
    [4.6, 2.2, 9.5, 4, 4.6, -Math.PI / 2, [0.9, 1.15, 1.7]],
  ].map(([x, y, z, w, h, ry, c]) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      // con caída radial: en el cristal se lee como un degradado de luz, no como un bloque
      new THREE.MeshBasicMaterial({
        map: glowTex,
        color: new THREE.Color().setRGB(...c),
        fog: false,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    m.position.set(x, y, z);
    m.rotation.y = ry;
    scene.add(m);
    return m;
  });

  // ---------- Entre la escena 1 y la 2: especialidades ----------
  const logos = createLogos({ envMap: cubeRT.texture, glowTex });
  scene.add(logos.root);
  // luz suave que acompaña a la cámara en este tramo: brillos especulares en el barniz
  const logoLight = new THREE.PointLight(0xe8eeff, 0, 14, 2);
  scene.add(logoLight);

  // ---------- Escena 2: prismas ----------
  const shards = shardData(r, tier.shards);
  const shardMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), crystalMat, shards.length);
  shardMesh.frustumCulled = false;
  const edgeGeo = new THREE.BoxGeometry(1, 1, 1);
  const edgeMesh = new THREE.InstancedMesh(edgeGeo, makeStripMaterial({ alongY: true, fogScale: 0.8 }), shards.length);
  edgeMesh.frustumCulled = false;
  {
    const params = new Float32Array(shards.length * 4);
    const c = new THREE.Color();
    shards.forEach((s, i) => {
      params.set([r(), 0.08, 3.2, 1.2], i * 4);
      const [cr, cg, cb] = spectral(s.hue);
      edgeMesh.setColorAt(i, c.setRGB(cr * 0.7 + 0.3, cg * 0.7 + 0.3, cb * 0.7 + 0.3));
    });
    edgeGeo.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
  }
  scene.add(shardMesh, edgeMesh);

  // ---------- Escena 3: cartas de proyectos (Nexo con video) ----------
  const projects = createProjects({ scene, crystalMat, exposure: renderer.toneMappingExposure });

  // ---------- Escena 4: haz de luz y horizonte ----------
  const beam = new Batch();
  beam.add(BEAM[0], 70, BEAM[1], 0.22, 140, 0.22, [1, 1, 1], [0.5, 0.05, 4.5, 0.6]);
  const beamMat = makeStripMaterial({ alongY: true, fogScale: 0.25 });
  const beamMesh = beam.mesh(beamMat, { withParams: true });
  scene.add(beamMesh);
  // cielo de la vista de detalle: un resplandor frío y suave detrás del contenido
  const detailSky = sprite(glowTex, [0.5, 0.56, 0.72], 0.16, 900, 340, [0, 34, -520]);
  detailSky.material.opacity = 0;
  // el horizonte solo se enciende al acercarse: desde el inicio no compite con la torre
  const horizonSprites = [
    sprite(glowTex, [0.85, 0.9, 1], 1.6, 22, 22, [BEAM[0], 1.5, BEAM[1]]),
    sprite(glowTex, [1, 1, 1], 0.85, 60, 2.2, [BEAM[0], 0.4, BEAM[1]]),
    sprite(glowTex, [0.55, 0.62, 0.8], 0.16, 420, 120, [BEAM[0] * 0.5, 6, -460]),
  ];
  const ring = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 16),
    new THREE.MeshBasicMaterial({
      map: ringTex,
      color: new THREE.Color().setRGB(1.6, 1.7, 1.9),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(BEAM[0], 0.02, BEAM[1]);
  scene.add(ring);

  // ---------- Polvo ----------
  const dustGeo = new THREE.BufferGeometry();
  {
    const n = tier.dust;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = lerp(-2.1, 2.1, r());
      pos[i * 3 + 1] = lerp(0.1, 7, r() ** 1.4);
      pos[i * 3 + 2] = lerp(Z_START, -300, r());
      seed[i] = r();
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  }
  const dust = new THREE.Points(dustGeo, makeDustMaterial());
  dust.frustumCulled = false;
  scene.add(dust);

  // ---------- Suelo mojado ----------
  const floor = new Reflector(new THREE.PlaneGeometry(160, 480), {
    clipBias: 0.003,
    textureWidth: 256,
    textureHeight: 256,
    color: 0x2a2c31,
    multisample: 0,
    shader: floorShader(tier.taps),
  });
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, -200);
  scene.add(floor);
  // sustituto barato del suelo para la cámara cúbica (evita 6 reflejos planares extra)
  const floorProxy = new THREE.Mesh(
    new THREE.PlaneGeometry(160, 480),
    new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.18, metalness: 0.7, envMapIntensity: 0.4 })
  );
  floorProxy.rotation.x = -Math.PI / 2;
  floorProxy.position.copy(floor.position);
  floorProxy.visible = false;
  scene.add(floorProxy);

  // ---------- Postproceso ----------
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: tier.msaa });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.42, 0.95);
  composer.addPass(bloom);
  const finish = new ShaderPass(FinishShader);
  composer.addPass(finish);
  composer.addPass(new OutputPass());

  // ---------- Tamaño y calidad adaptativa ----------
  let dpr = Math.min(window.devicePixelRatio || 1, tier.dpr);
  let width = 1;
  let height = 1;

  function resize() {
    width = Math.max(1, canvas.clientWidth);
    height = Math.max(1, canvas.clientHeight);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(dpr);
    composer.setSize(width, height);
    floor.getRenderTarget().setSize(Math.round(width * dpr * tier.refl), Math.round(height * dpr * tier.refl));
    camera.aspect = width / height;
    camera.fov = fovFor(camera.aspect);
    camera.updateProjectionMatrix();
    shared.uPixelScale.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / (height * dpr);
    finish.uniforms.uRes.value.set(width * dpr, height * dpr);
    dust.material.uniforms.uPR.value = dpr;
  }
  resize();

  let ema = 16.7;
  let slow = 0;
  let fast = 0;
  let lastDrop = -Infinity;
  let elapsed = 0;
  // Baja la resolución si los FPS caen; solo vuelve a subirla tras un rato largo
  // estable, para no oscilar (cada cambio de resolución se nota como un salto).
  function adaptQuality(dt) {
    elapsed += dt;
    ema += (dt - ema) * 0.05;
    if (ema > 26) {
      slow++;
      fast = 0;
    } else if (ema < 12.5) {
      fast++;
      slow = 0;
    } else {
      slow = 0;
      fast = 0;
    }
    if (slow > 45 && dpr > 0.65) {
      dpr = Math.max(0.65, dpr - 0.15);
      resize();
      slow = 0;
      ema = 18;
      lastDrop = elapsed;
    } else if (fast > 600 && elapsed - lastDrop > 30000 && dpr < Math.min(window.devicePixelRatio || 1, tier.dpr)) {
      dpr = Math.min(tier.dpr, dpr + 0.1);
      resize();
      fast = 0;
    }
  }

  // ---------- Animación ----------
  const keys = CAMERA_KEYS.map((k) => ({ ...k, pos: new THREE.Vector3(...k.pos) }));
  const pose = { pos: new THREE.Vector3(), pitch: 0, yaw: 0 };
  function cameraAt(p) {
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (p <= b.p) {
        const f = (p - a.p) / (b.p - a.p);
        const e = f * f * (3 - 2 * f);
        pose.pos.lerpVectors(a.pos, b.pos, e);
        pose.pitch = lerp(a.pitch, b.pitch, e);
        pose.yaw = lerp(a.yaw, b.yaw, e);
        return pose;
      }
    }
    const l = keys[keys.length - 1];
    pose.pos.copy(l.pos);
    pose.pitch = l.pitch;
    pose.yaw = l.yaw;
    return pose;
  }

  const m4 = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const edgeOffset = new THREE.Vector3(0.5, 0, 0);
  const lightPos = new THREE.Vector3(...TOWER_LIGHT);
  const baseCamera = new THREE.Matrix4();
  const edgeScale = new THREE.Vector3();
  const IDQ = new THREE.Quaternion();
  const smooth = THREE.MathUtils.smoothstep;

  const SHARD_CENTER = new THREE.Vector3(0, 2.6, -100);
  const LOGO_CAPTURE = new THREE.Vector3(0, 2.4, 0);
  const capVisible = [];
  let capTick = 0;
  function capture(at, hide) {
    floor.visible = false;
    floorProxy.visible = true;
    hide.forEach((o, i) => {
      capVisible[i] = o.visible;
      o.visible = false;
    });
    cubeCam.position.copy(at);
    cubeCam.updateMatrixWorld();
    cubeCam.update(renderer, scene);
    hide.forEach((o, i) => (o.visible = capVisible[i]));
    floor.visible = true;
    floorProxy.visible = false;
  }

  // intro: 0 = cubo cerrado, 1 = pasillo encendido del todo
  // detail: 0 = recorrido, 1 = vista de detalle de un proyecto (cámara arriba del escenario)
  function update({
    progress,
    mx,
    my,
    vel,
    time,
    dt,
    intro = 1,
    detail = 0,
    detailRect = DEFAULT_RECT,
    pointer = NO_POINTER,
    focus = -1,
  }) {
    const t = reduceMotion ? 0 : time;
    shared.uTime.value = t;
    shared.uVel.value = vel;
    // los pulsos de luz corren algo más rápido al avanzar, sin saltos de fase
    if (!reduceMotion) shared.uFlow.value += ((dt || 16.7) / 1000) * (1 + vel * 2.5);
    floor.material.uniforms.uTime.value = t;
    finish.uniforms.uTime.value = time;
    finish.uniforms.uVel.value = vel;
    // en la vista de detalle se apagan bloom, viñeta, aberración y grano: así el
    // plano 3D del video coincide píxel a píxel con el <video> del DOM en el relevo
    const fx = 1 - smooth(detail, 0.08, 0.45);
    bloom.strength = 0.45 * fx;
    bloom.enabled = fx > 0.001;
    finish.uniforms.uFx.value = fx;
    if (dt) adaptQuality(dt);

    // ---- apertura del cubo y ola de encendido ----
    const opening = Math.min(1, Math.max(0, intro));
    const wave = smooth(opening, 0.24, 0.95);
    // el frente de la ola sale del cubo y acelera hacia el fondo del pasillo
    const revealZ = opening >= 1 ? -1e5 : 20 - 265 * Math.pow(wave, 2.2);
    const flash = opening >= 1 ? 0 : smooth(opening, 0.18, 0.3) * (1 - smooth(opening, 0.85, 1));
    const pool = 1 - smooth(opening, 0.55, 1);
    shared.uRevealZ.value = revealZ;
    shared.uRevealFlash.value = flash;
    shared.uPool.value.set(CUBE_POS.x, CUBE_POS.z, pool);
    const fu = floor.material.uniforms;
    fu.uRevealZ.value = revealZ;
    fu.uRevealFlash.value = flash;
    fu.uPool.value.copy(shared.uPool.value);

    const towerOn = 1 - smooth(revealZ, -100, -82);
    hemi.intensity = 0.025 * (opening >= 1 ? 1 : wave);
    towerLight.intensity = 100 * towerOn;
    skyHaze.material.opacity = towerOn;
    towerFlare.material.opacity = towerOn;
    shardMesh.visible = edgeMesh.visible = revealZ < -76;
    studioMat.uniforms.uIntensity.value = pool;
    studioMesh.visible = pool > 0.001;
    softboxes.forEach((m) => {
      m.material.opacity = pool;
      m.visible = pool > 0.001;
    });
    cube.update(opening, t, reduceMotion ? 0 : dt || 16, mx, my);

    // el horizonte (haz y resplandor) se enciende al final del recorrido y también
    // como telón de fondo de la vista de detalle
    const horizonScroll = smooth(progress, 0.62, 0.9);
    const horizon = Math.max(horizonScroll, 0.85 * easeInOut(smooth(detail, 0.1, 0.9)));

    // cámara
    const c = cameraAt(progress);
    // en pantallas verticales el haz quedaría fuera de cuadro: la cámara gira hacia él
    const portraitYaw = camera.aspect < 1 ? -0.22 * horizonScroll : 0;
    camera.position.copy(c.pos);
    // mientras el cubo está cerrado la cámara está un poco más atrás y se acerca al abrir
    const back = 1 - smooth(opening, 0.05, 0.9);
    camera.position.z += back * 1.6;
    camera.position.y += back * 0.12;
    camera.position.x += mx * 0.35;
    camera.position.y += -my * 0.16 + (reduceMotion ? 0 : Math.sin(t * 0.5) * 0.025);
    camera.rotation.set(c.pitch - my * 0.035, c.yaw + portraitYaw - mx * 0.055, reduceMotion ? 0 : Math.sin(t * 0.31) * 0.004);

    // vista de detalle: la cámara se eleva por encima del escenario como una grúa
    camera.updateMatrixWorld();
    baseCamera.copy(camera.matrixWorld);
    // sube por encima de las torres del muro derecho (hasta 30 m) para ver el pasillo
    // como una pista de luz que se aleja hacia el horizonte
    const rise = easeInOut(smooth(detail, 0.04, 1));
    camera.position.y += 33 * rise;
    camera.position.z -= 10 * rise;
    camera.rotation.x -= 0.21 * rise;
    camera.updateMatrixWorld();
    projects.update({ camera, baseCamera, t, pointer, detail, rect: detailRect, revealZ, focus });

    logos.update(c.pos.z, t, revealZ);
    const logoZone = smooth(c.pos.z, -72, -60) * (1 - smooth(c.pos.z, -8, 2));
    logoLight.position.set(Math.sin(t * 0.3) * 0.6, 4.4, c.pos.z - 7);
    logoLight.intensity = 45 * logoZone * (opening >= 1 ? 1 : 0);

    // prismas flotando
    shards.forEach((s, i) => {
      e.set(s.rot.x + Math.sin(t * s.f + s.ph) * 0.06, s.rot.y + t * s.spin, s.rot.z + Math.sin(t * s.f * 0.8 + s.ph) * 0.05);
      q.setFromEuler(e);
      v.copy(s.pos);
      v.y += Math.sin(t * s.f + s.ph) * 0.12;
      m4.compose(v, q, s.scale);
      shardMesh.setMatrixAt(i, m4);
      // canto prismático: tira fina en el borde derecho del cristal
      edgeScale.set(0.022 / s.scale.x, 1, 1.4);
      local.compose(edgeOffset, IDQ, edgeScale);
      edgeMesh.setMatrixAt(i, m4.multiply(local));
    });
    shardMesh.instanceMatrix.needsUpdate = true;
    edgeMesh.instanceMatrix.needsUpdate = true;

    // el haz y su anillo solo al final del recorrido (en el detalle, visto desde
    // arriba, el haz se leería como una línea dura cruzando la pantalla)
    // resplandor de la base del haz: solo con el haz; el del horizonte también de fondo en el detalle
    horizonSprites[0].material.opacity = horizonScroll;
    horizonSprites[1].material.opacity = horizonScroll;
    horizonSprites[2].material.opacity = horizon;
    const noDetail = 1 - smooth(detail, 0, 0.3);
    beamMat.uniforms.uIntensity.value = horizonScroll * noDetail;
    // apagado no basta: una tira opaca a intensidad 0 se ve como una línea negra
    beamMesh.visible = horizonScroll * noDetail > 0.001;
    ring.material.opacity = horizonScroll * noDetail;
    beamLight.intensity = 320 * horizonScroll * noDetail;
    detailSky.material.opacity = easeInOut(smooth(detail, 0.15, 0.95));

    // los halos de la torre son del tamaño del mundo: al acercarse se atenúan
    // para que la luz no se convierta en una pantalla blanca
    const dTower = camera.position.distanceTo(lightPos);
    rays.material.rotation = t * 0.018;
    const far = THREE.MathUtils.smoothstep(dTower, 8, 55);
    rays.material.opacity = THREE.MathUtils.smoothstep(dTower, 14, 50) * towerOn;
    barsMat.uniforms.uIntensity.value = 0.32 + 0.68 * far;
    towerCore.material.opacity = (0.35 + 0.65 * far) * towerOn;
    towerGlow.material.opacity = (0.15 + 0.85 * THREE.MathUtils.smoothstep(dTower, 8, 40)) * (0.85 + Math.sin(t * 1.3) * 0.15) * towerOn;
    const s = 1 + Math.sin(t * 1.6) * 0.04;
    ring.scale.set(s, s, 1);

    // ---- reflejos vivos: cámara cúbica en el cristal que está en pantalla ----
    capTick++;
    if (capTick % tier.cubeEvery === 0) {
      const cz = camera.position.z;
      if (opening < 1) capture(cube.root.position, revealZ > Z_START ? [cube.root, ...corridor, logos.root] : [cube.root, logos.root]);
      else if (cz > -58) {
        // los logos reflejan el tramo de pasillo que tienen alrededor
        LOGO_CAPTURE.z = THREE.MathUtils.clamp(cz - 14, -62, -18);
        capture(LOGO_CAPTURE, [logos.root]);
      } else if (cz > -140) capture(SHARD_CENTER, [shardMesh, edgeMesh, logos.root]);
      else if (cz > -190) capture(DECK_CENTER, [...projects.hideables, logos.root]);
    }
  }

  function render() {
    composer.render();
  }

  function dispose() {
    renderer.dispose();
    composer.dispose();
  }

  return {
    update,
    render,
    resize,
    dispose,
    tier: tierName,
    renderer,
    // proyecto clicable bajo el cursor (-1 si ninguno)
    pick: (ndc) => projects.pick(ndc, camera),
    // carta bajo el cursor (cualquiera) y si se puede abrir
    get hoveredProject() {
      return projects.hovered;
    },
    isClickable: (i) => projects.isClickable(i),
    projectVideo: projects.video,
    debug: { scene, softboxes, cube, floor, crystalMat, cubeCam },
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function easeInOut(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

const DEFAULT_RECT = { x0: -0.9, x1: 0.2, y0: -0.4, y1: 0.4, hPx: 800 };
const NO_POINTER = { x: 0, y: 0, active: false, wPx: 1, hPx: 1 };
