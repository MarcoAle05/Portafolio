// Progreso en el que cada escena está centrada (coincide con CAMERA_KEYS)
const SCENE_CENTERS = [0.05, 0.365, 0.677, 0.97];
const EASE = 0.075; // inercia de la cámara al hacer scroll (por frame a 60 Hz)

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const params = new URLSearchParams(window.location.search);

// Parámetros de revisión visual (no hacen nada si no se pasan):
//   ?p=0.677      fija el progreso del recorrido (ignora el scroll y salta la entrada)
//   ?detail=0.5   congela la vista de detalle en ese punto (0–1)
//   ?focus=1      fuerza el foco de una carta del archivo
//   ?freeze       congela el tiempo de las animaciones
//   ?intro=0.4    congela la apertura del cubo
const unit = (k) => (params.has(k) ? Math.min(1, Math.max(0, parseFloat(params.get(k)) || 0)) : null);
const FIXED_P = unit('p');
const FIXED_DETAIL = unit('detail');
const FIXED_FOCUS = params.has('focus') ? parseInt(params.get('focus'), 10) : null;
const FREEZE = params.has('freeze');

const root = document.getElementById('root');
const canvas = document.getElementById('gl');
const bar = document.getElementById('bar');
const html = document.documentElement;
const openButton = document.getElementById('intro-open');
const detailEl = document.getElementById('detail');
const detailBack = document.getElementById('detail-back');
const detailVideo = document.getElementById('detail-video');
const cursorHint = document.getElementById('cursor-hint');
const copies = [...document.querySelectorAll('[data-copy]')];
const copyParts = copies.map((el) => [...el.querySelectorAll('[data-rv]')]);
const rows = [...document.querySelectorAll('.index-row')];
[...detailEl.querySelectorAll('.rv')].forEach((el, i) => el.style.setProperty('--i', i));

// ---------- Entrada: el cubo ----------
// closed → opening → open. Mientras está cerrado no hay scroll; cualquier gesto
// de avance (clic, rueda, deslizar, Enter/Espacio/flecha abajo) abre el cubo.
const INTRO_MS = reduceMotion ? 700 : 3000;
let introState = 'closed';
let openAt = 0;
let intro = 0;

if (params.has('intro')) {
  introState = 'frozen';
  intro = unit('intro');
  html.classList.add('is-intro', 'is-opening');
} else if (params.has('skip') || FIXED_P !== null) {
  introState = 'open';
  intro = 1;
  html.classList.remove('is-intro');
} else {
  window.scrollTo(0, 0);
  html.classList.add('is-intro');
}

function openCube() {
  if (introState !== 'closed') return;
  introState = 'opening';
  openAt = performance.now();
  html.classList.add('is-opening');
}

openButton.addEventListener('click', openCube);
document.getElementById('stage').addEventListener('click', openCube);
window.addEventListener('wheel', (e) => e.deltaY > 0 && openCube(), { passive: true });
window.addEventListener('touchmove', openCube, { passive: true });
window.addEventListener('keydown', (e) => {
  if (introState !== 'closed') return;
  if (['Enter', ' ', 'ArrowDown', 'PageDown'].includes(e.key) && document.activeElement === document.body) {
    e.preventDefault();
    openCube();
  }
});

// El escenario 3D se carga aparte: el texto y la navegación aparecen al instante
// y Three.js llega después sin bloquear la primera pintura.
let world = null;
import('./scene/world.js')
  .then(({ createWorld }) => {
    world = createWorld(canvas, { reduceMotion, quality: params.get('q') });
    root.dataset.quality = world.tier;
    if (import.meta.env.DEV) window.__world = world;
    // redimensionar borra el lienzo: se vuelve a dibujar en el acto (sin cuadro negro)
    new ResizeObserver(() => {
      world.resize();
      world.render();
    }).observe(canvas);
    root.classList.add('gl-ready');
    if (FIXED_DETAIL !== null) freezeDetail();
  })
  .catch((err) => {
    console.warn('WebGL no disponible, se muestra el fondo estático.', err);
    root.classList.add('no-webgl');
  });

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  root.classList.add('no-webgl');
});

// ---------- Scroll y cursor ----------
let target = FIXED_P ?? 0;
function readScroll() {
  if (FIXED_P !== null) return;
  const rect = root.getBoundingClientRect();
  const max = rect.height - window.innerHeight;
  target = max > 0 ? Math.min(1, Math.max(0, -rect.top / max)) : 0;
}
window.addEventListener('scroll', readScroll, { passive: true });

let tx = 0;
let ty = 0;
// cursor en coordenadas de la escena (NDC): para el hover de las cartas
const pointer = { x: 0, y: 0, active: false, wPx: window.innerWidth, hPx: window.innerHeight, cx: 0, cy: 0 };
window.addEventListener(
  'pointermove',
  (e) => {
    if (e.pointerType !== 'mouse') return;
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
    pointer.cx = e.clientX;
    pointer.cy = e.clientY;
    pointer.active = true;
    if (reduceMotion) return;
    tx = e.clientX / window.innerWidth - 0.5;
    ty = e.clientY / window.innerHeight - 0.5;
  },
  { passive: true }
);
html.addEventListener('mouseleave', () => (pointer.active = false));

// ---------- Índice del archivo ----------
// El índice y las cartas 3D comparten el foco: pasar por una fila adelanta su
// carta; pasar por una carta resalta su fila.
let rowFocus = FIXED_FOCUS ?? -1;
rows.forEach((row, i) => {
  const enter = () => (rowFocus = i);
  const leave = () => {
    if (rowFocus === i) rowFocus = -1;
  };
  row.addEventListener('mouseenter', enter);
  row.addEventListener('mouseleave', leave);
  row.addEventListener('focus', enter);
  row.addEventListener('blur', leave);
  row.addEventListener('click', () => {
    if (row.getAttribute('aria-disabled') === 'true') return;
    openDetail(row);
  });
});

// ---------- Vista de detalle de un proyecto ----------
// closed → opening → open → closing. Al abrir, la cámara se eleva por encima del
// escenario y la pantalla de la carta vuela hasta el <video> del detalle; al
// volver, todo regresa al punto exacto del recorrido (el scroll queda bloqueado).
const DETAIL_OPEN_MS = reduceMotion ? 350 : 1800;
const DETAIL_CLOSE_MS = reduceMotion ? 350 : 1400;
let detailState = 'closed';
let detail = 0;
let detailFrom = 0;
let detailAt = 0;
let detailRect = undefined;
let detailTrigger = null;
let detailByKeyboard = false;
// el anillo de foco del botón de volver solo se muestra si se abrió con el teclado
let lastKeyboard = false;
window.addEventListener('keydown', () => (lastKeyboard = true), true);
window.addEventListener('pointerdown', () => (lastKeyboard = false), true);

function measureDetailRect() {
  const r = detailVideo.getBoundingClientRect();
  const w = window.innerWidth;
  const h = window.innerHeight;
  detailRect = {
    x0: (r.left / w) * 2 - 1,
    x1: (r.right / w) * 2 - 1,
    y0: -(r.bottom / h) * 2 + 1,
    y1: -(r.top / h) * 2 + 1,
    hPx: h,
  };
}

function prewarmDetailVideo() {
  // arranca ya, oculto y adelantado lo que dura la transición: al aparecer tiene
  // cuadros listos y coincide con el de la carta
  detailVideo.preload = 'auto';
  if (world) {
    const v = world.projectVideo;
    const ahead = v.currentTime + DETAIL_OPEN_MS / 1000;
    try {
      detailVideo.currentTime = v.duration ? ahead % v.duration : ahead;
    } catch {}
  }
  detailVideo.play().catch(() => {});
}

function openDetail(trigger) {
  if (introState !== 'open' || (detailState !== 'closed' && detailState !== 'closing')) return;
  detailTrigger = trigger || null;
  detailByKeyboard = lastKeyboard;
  rowFocus = -1;
  detailEl.scrollTop = 0;
  measureDetailRect();
  prewarmDetailVideo();
  detailFrom = detail;
  detailAt = performance.now();
  detailState = 'opening';
  html.classList.add('is-detail');
  if (!history.state || !history.state.detail) history.pushState({ detail: 'nexo' }, '', '#nexo');
}

function showDetailDom() {
  // solo se corrige si se desfasaron de verdad (un salto de búsqueda se notaría)
  if (world && Math.abs(detailVideo.currentTime - world.projectVideo.currentTime) > 0.4) {
    try {
      detailVideo.currentTime = world.projectVideo.currentTime;
    } catch {}
  }
  detailVideo.play().catch(() => {});
  detailEl.classList.add('is-in');
  detailEl.setAttribute('aria-hidden', 'false');
  detailBack.focus({ preventScroll: true, focusVisible: detailByKeyboard });
}

function closeDetail() {
  if (detailState !== 'open' && detailState !== 'opening') return;
  measureDetailRect(); // el panel pudo desplazarse (móvil): el 3D parte de donde está el video
  detailEl.classList.remove('is-in');
  detailEl.setAttribute('aria-hidden', 'true');
  // la carta retoma desde donde se quedó el video grande (si lo adelantaste o regresaste)
  if (world && Math.abs(detailVideo.currentTime - world.projectVideo.currentTime) > 0.5) {
    world.projectVideo.currentTime = detailVideo.currentTime;
  }
  detailVideo.pause();
  detailFrom = detail;
  detailAt = performance.now();
  detailState = 'closing';
}

function freezeDetail() {
  const apply = () => {
    measureDetailRect();
    detail = FIXED_DETAIL;
    detailState = 'frozen';
    html.classList.add('is-detail');
    if (FIXED_DETAIL >= 1) {
      detailVideo.preload = 'auto';
      showDetailDom();
    }
  };
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(apply);
}

// la flecha (y Escape) usan el historial: el botón "atrás" del navegador también regresa
const goBack = () => (history.state && history.state.detail ? history.back() : closeDetail());
detailBack.addEventListener('click', goBack);
window.addEventListener('popstate', () => {
  if (!history.state || !history.state.detail) closeDetail();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (detailState === 'open' || detailState === 'opening')) goBack();
});
canvas.addEventListener('click', (e) => {
  if (!world || introState !== 'open' || detailState !== 'closed') return;
  const ndc = { x: (e.clientX / window.innerWidth) * 2 - 1, y: -(e.clientY / window.innerHeight) * 2 + 1 };
  const i = world.pick(ndc);
  if (i >= 0 && world.isClickable(i)) openDetail();
});
window.addEventListener('resize', () => {
  pointer.wPx = window.innerWidth;
  pointer.hPx = window.innerHeight;
  readScroll();
  if (detailState !== 'closed') measureDetailRect();
});

// ---------- Bucle ----------
let cur = target;
let mx = 0;
let my = 0;
let vel = 0;
let last = 0;
let raf = 0;
let hot = -2;
let hintOn = false;
const rvCache = new WeakMap();

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
function setRv(el, w) {
  const v = Math.round(w * 1000) / 1000;
  if (rvCache.get(el) === v) return;
  rvCache.set(el, v);
  el.style.setProperty('--w', v);
}

function frame(now) {
  const t = FREEZE ? 12000 : now;
  const rawDt = last ? now - last : 16.7;
  const dt = Math.min(100, rawDt);
  last = now;
  const k = reduceMotion || FIXED_P !== null ? 1 : 1 - Math.pow(1 - EASE, dt / 16.7);
  const prev = cur;
  cur += (target - cur) * k;
  if (Math.abs(target - cur) < 1e-5) cur = target;

  const kp = 1 - Math.pow(0.95, dt / 16.7);
  mx += (tx - mx) * kp;
  my += (ty - my) * kp;

  // velocidad de avance normalizada: acelera un poco los pulsos de luz
  const speed = Math.min(1, (Math.abs(cur - prev) / (Math.max(rawDt, 1) / 1000)) * 1.6);
  vel += (speed - vel) * (1 - Math.pow(0.9, dt / 16.7));

  if (introState === 'opening') {
    intro = Math.min(1, (now - openAt) / INTRO_MS);
    if (intro >= 1) {
      introState = 'open';
      html.classList.remove('is-intro', 'is-opening');
      readScroll();
    }
  }

  if (detailState === 'opening' || detailState === 'closing') {
    const p = Math.min(1, (now - detailAt) / (detailState === 'opening' ? DETAIL_OPEN_MS : DETAIL_CLOSE_MS));
    detail = detailState === 'opening' ? detailFrom + (1 - detailFrom) * p : detailFrom * (1 - p);
    if (p >= 1 && detailState === 'opening') {
      detailState = 'open';
      showDetailDom();
    } else if (p >= 1) {
      detailState = 'closed';
      detail = 0;
      html.classList.remove('is-detail');
      if (detailTrigger) detailTrigger.focus({ preventScroll: true, focusVisible: detailByKeyboard });
      readScroll();
    }
  }
  const still = 1 - detail; // en el detalle la cámara no sigue al cursor
  const inArchive = detailState === 'closed' || detailState === 'frozen';
  const focus = inArchive ? rowFocus : -1;

  if (world) {
    world.update({
      progress: cur,
      mx: mx * still,
      my: my * still,
      vel: reduceMotion ? 0 : vel,
      time: t / 1000,
      dt: FREEZE ? 0 : dt,
      intro,
      detail,
      detailRect,
      pointer,
      focus,
    });
    world.render();

    // carta bajo el cursor ↔ fila del índice; "Ver proyecto" junto al cursor
    const hovered = pointer.active && detailState === 'closed' ? world.hoveredProject : -1;
    const nowHot = detailState === 'closed' ? (rowFocus >= 0 ? rowFocus : hovered) : -1;
    if (nowHot !== hot) {
      hot = nowHot;
      rows.forEach((r, i) => r.classList.toggle('is-hot', i === hot));
    }
    const over = hovered >= 0 && world.isClickable(hovered);
    if (over !== hintOn) {
      hintOn = over;
      cursorHint.classList.toggle('is-on', over);
      canvas.style.cursor = over ? 'pointer' : '';
    }
    if (over) cursorHint.style.transform = `translate(${pointer.cx + 18}px, ${pointer.cy + 14}px)`;
  }

  bar.style.transform = `scaleX(${cur.toFixed(4)})`;

  // Texto de las escenas: cada bloque aparece por turnos (y sale en orden inverso)
  const copyIn = introState === 'open' ? 1 : Math.max(0, (intro - 0.7) / 0.3);
  const detailOut = Math.max(0, 1 - detail * 3);
  copies.forEach((el, i) => {
    // meseta: texto completo a ±0.07 del centro, invisible a ±0.14
    let w = (0.14 - Math.abs(cur - SCENE_CENTERS[i])) / 0.07;
    if (i === 0 && cur < SCENE_CENTERS[0]) w = 1;
    if (i === copies.length - 1 && cur > SCENE_CENTERS[i]) w = 1;
    w = clamp01(w) * copyIn * detailOut;
    el.style.visibility = w < 0.005 ? 'hidden' : 'visible';
    const parts = copyParts[i];
    const n = parts.length;
    const step = n > 1 ? Math.min(0.12, 0.55 / (n - 1)) : 0;
    const span = 1 - step * (n - 1);
    parts.forEach((part, j) => setRv(part, easeOutCubic(clamp01((w - j * step) / span))));
  });

  raf = requestAnimationFrame(frame);
}

// Control para la revisión visual automatizada (solo en desarrollo)
if (import.meta.env.DEV) {
  window.__qa = {
    // fija cualquier estado: { p, detail, focus, intro } (null = devolver el control)
    set({ p, detail: d, focus: f, intro: it } = {}) {
      if (p !== undefined) {
        target = cur = p;
        introState = 'open';
        intro = 1;
        html.classList.remove('is-intro', 'is-opening');
      }
      if (it !== undefined) {
        introState = 'frozen';
        intro = it;
        html.classList.add('is-intro', 'is-opening');
      }
      if (f !== undefined) rowFocus = f;
      if (d !== undefined) {
        measureDetailRect();
        detail = d;
        detailState = d > 0 ? 'frozen' : 'closed';
        html.classList.toggle('is-detail', d > 0);
        if (d >= 1) showDetailDom();
        else {
          detailEl.classList.remove('is-in');
          detailEl.setAttribute('aria-hidden', 'true');
        }
      }
    },
    state: () => ({ cur, detail, detailState, introState, intro, rowFocus, rect: detailRect }),
  };
}

// Sin pestaña visible no se dibuja nada
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(raf);
  } else {
    last = 0;
    raf = requestAnimationFrame(frame);
  }
});

readScroll();
cur = target;
raf = requestAnimationFrame(frame);
