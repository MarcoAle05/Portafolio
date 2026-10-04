// Medidas del escenario, en metros. El pasillo corre a lo largo de -z.
// Proporciones tomadas de la imagen de referencia: pasillo estrecho, muro izquierdo
// bajo y aterrazado, muro derecho alto con una banda prismática a media altura,
// y una torre de luz centrada al fondo.

export const W = 2.2; // medio ancho del pasillo (suelo libre entre muros)
export const Z_START = 16; // detrás de la cámara inicial
export const Z_END = -205; // donde termina el pasillo y se abre el horizonte

export const TOWER_Z = -95;
export const TOWER_LIGHT = [-0.95, 3.4, -94.2];
export const BEAM = [14, -272]; // x, z del haz de luz: a la derecha, para no cruzar el texto

export const BAND = { y0: 4.9, y1: 5.65, face: W + 0.75 }; // banda prismática del muro derecho

export const FOG = { color: 0x06070a, density: 0.0118 };

// Recorrido de cámara: progreso de scroll → posición, inclinación (pitch) y giro (yaw).
// Cada clave coincide con el centro de una escena del contenido.
export const CAMERA_KEYS = [
  { p: 0, pos: [0, 1.15, 6], pitch: 0.035, yaw: 0 }, // 01 Umbral: la vista de la imagen
  { p: 0.365, pos: [0, 1.45, -76], pitch: 0.12, yaw: 0 }, // 02 Prisma: frente a la torre
  { p: 0.677, pos: [0, 1.6, -151], pitch: 0.03, yaw: 0 }, // 03 Archivo: entre los paneles
  { p: 1, pos: [-1, 2.0, -228], pitch: 0.07, yaw: 0 }, // 04 Horizonte: fuera del pasillo
];
