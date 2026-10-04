import * as THREE from 'three';

// Texturas generadas en canvas: nada que descargar, se crean en milisegundos.

function canvasTexture(w, h, draw, colorSpace = THREE.NoColorSpace) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = colorSpace;
  return t;
}

// Halo de luz con caída suave (núcleo intenso, cola larga)
export function glowTexture() {
  return canvasTexture(256, 256, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.06, 'rgba(255,255,255,0.75)');
    r.addColorStop(0.18, 'rgba(255,255,255,0.22)');
    r.addColorStop(0.4, 'rgba(255,255,255,0.06)');
    r.addColorStop(0.7, 'rgba(255,255,255,0.015)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, s, s);
  });
}

// Rayos de luz (god rays) en abanico desde el centro
export function raysTexture(rand) {
  return canvasTexture(1024, 1024, (g, s) => {
    g.translate(s / 2, s / 2);
    for (let i = 0; i < 180; i++) {
      const a = rand() * Math.PI * 2;
      const w = 0.002 + rand() * 0.016;
      const len = s * (0.22 + rand() * 0.28);
      g.fillStyle = `rgba(255,255,255,${0.03 + rand() * 0.16})`;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(Math.cos(a - w) * len, Math.sin(a - w) * len);
      g.lineTo(Math.cos(a + w) * len, Math.sin(a + w) * len);
      g.closePath();
      g.fill();
    }
    g.globalCompositeOperation = 'destination-in';
    const r = g.createRadialGradient(0, 0, 0, 0, 0, s / 2);
    r.addColorStop(0, 'rgba(0,0,0,1)');
    r.addColorStop(0.3, 'rgba(0,0,0,0.55)');
    r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r;
    g.fillRect(-s / 2, -s / 2, s, s);
  });
}

// Anillos de luz para el suelo del horizonte
export function ringTexture() {
  return canvasTexture(512, 512, (g, s) => {
    g.translate(s / 2, s / 2);
    const rings = [
      [0.07, 0.9, 6],
      [0.2, 0.45, 4],
      [0.33, 0.28, 3],
      [0.46, 0.14, 2],
    ];
    for (const [rad, a, blur] of rings) {
      g.shadowColor = `rgba(255,255,255,${a})`;
      g.shadowBlur = blur * 4;
      g.strokeStyle = `rgba(255,255,255,${a})`;
      g.lineWidth = blur;
      g.beginPath();
      g.arc(0, 0, rad * s, 0, Math.PI * 2);
      g.stroke();
    }
    const r = g.createRadialGradient(0, 0, 0, 0, 0, s * 0.12);
    r.addColorStop(0, 'rgba(255,255,255,0.9)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(-s / 2, -s / 2, s, s);
  });
}

// Cara de una carta de proyecto (2048×1280 para 1.6×1.0 m). La zona de pantalla
// se exporta para colocar encima el plano de video exactamente.
export const CARD_LAYOUT = { W: 2048, H: 1280, pad: 80, screenTop: 200, screenBottom: 1000, radius: 28 };

const FONT = 'Geist, "Helvetica Neue", Helvetica, Arial, sans-serif';

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function cardTexture({ index, title, desc, clickable = false, media = false }) {
  const { W, H, pad, screenTop, screenBottom, radius } = CARD_LAYOUT;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const track = (px) => {
    if ('letterSpacing' in g) g.letterSpacing = px;
  };

  const draw = () => {
    g.clearRect(0, 0, W, H);
    // vidrio oscuro con un brillo suave arriba
    const bg = g.createLinearGradient(0, 0, W * 0.6, H);
    bg.addColorStop(0, '#16171c');
    bg.addColorStop(1, '#08080a');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    const sheen = g.createLinearGradient(0, 0, 0, H * 0.45);
    sheen.addColorStop(0, 'rgba(255,255,255,0.06)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sheen;
    g.fillRect(0, 0, W, H * 0.45);

    // cabecera: número y acción
    g.textBaseline = 'alphabetic';
    track('0px');
    g.font = `500 50px ${FONT}`;
    g.fillStyle = '#8b8b96';
    g.fillText(index, pad, 142);
    const action = clickable ? 'Ver proyecto  ↗' : 'Próximamente';
    g.fillStyle = clickable ? '#f4f4f6' : '#8b8b96';
    g.fillText(action, W - pad - g.measureText(action).width, 142);

    // pantalla
    const sw = W - pad * 2;
    const sh = screenBottom - screenTop;
    roundRectPath(g, pad, screenTop, sw, sh, radius);
    if (media) {
      g.fillStyle = '#000';
      g.fill();
    } else {
      g.save();
      g.clip();
      g.fillStyle = '#0b0c10';
      g.fillRect(pad, screenTop, sw, sh);
      g.strokeStyle = 'rgba(255,255,255,0.045)';
      g.lineWidth = 2;
      for (let x = pad + 64; x < pad + sw; x += 64) {
        g.beginPath();
        g.moveTo(x, screenTop);
        g.lineTo(x, screenBottom);
        g.stroke();
      }
      for (let y = screenTop + 64; y < screenBottom; y += 64) {
        g.beginPath();
        g.moveTo(pad, y);
        g.lineTo(pad + sw, y);
        g.stroke();
      }
      const glow = g.createRadialGradient(W / 2, screenTop + sh / 2, 0, W / 2, screenTop + sh / 2, sw * 0.45);
      glow.addColorStop(0, 'rgba(160,180,255,0.10)');
      glow.addColorStop(1, 'rgba(160,180,255,0)');
      g.fillStyle = glow;
      g.fillRect(pad, screenTop, sw, sh);
      g.fillStyle = '#5f5f69';
      g.font = `500 44px ${FONT}`;
      const ph = 'En preparación';
      g.fillText(ph, W / 2 - g.measureText(ph).width / 2, screenTop + sh / 2 + 16);
      g.restore();
    }
    roundRectPath(g, pad, screenTop, sw, sh, radius);
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 2;
    g.stroke();

    // pie: título y descripción
    track('-5px');
    g.font = `500 128px ${FONT}`;
    g.fillStyle = '#f4f4f6';
    g.fillText(title, pad - 4, H - pad - 4);
    track('-0.5px');
    g.font = `400 44px ${FONT}`;
    g.fillStyle = '#8b8b96';
    g.fillText(desc, W - pad - g.measureText(desc).width, H - pad - 12);
    track('0px');
    tex.needsUpdate = true;
  };

  draw();
  if (document.fonts) {
    Promise.all([document.fonts.load(`500 128px Geist`), document.fonts.load(`400 44px Geist`)])
      .then(draw)
      .catch(() => {});
  }
  return tex;
}
