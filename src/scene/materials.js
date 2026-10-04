import * as THREE from 'three';
import { FOG } from './layout.js';

// Uniforms compartidos por todos los materiales animados
export const shared = {
  uTime: { value: 0 },
  uVel: { value: 0 }, // velocidad de scroll normalizada (0–1)
  // tiempo de flujo de los pulsos: se integra en CPU (dt × (1 + velocidad)), así
  // acelerar no hace saltar la fase de los pulsos
  uFlow: { value: 0 },
  // tamaño de un píxel en metros a 1 m de distancia: evita líneas más finas que un píxel
  uPixelScale: { value: 0.001 },
  // Ola de revelado al abrir el cubo: todo lo que está por delante de uRevealZ
  // (z mayor) se ve; lo que queda detrás sigue apagado.
  uRevealZ: { value: 1e5 },
  uRevealFlash: { value: 0 },
  // charco de luz alrededor del cubo mientras el pasillo está apagado
  uPool: { value: new THREE.Vector3(0, 2.2, 0) }, // x, z, intensidad
};

const REVEAL_GLSL = /* glsl */ `
  float revealMask(float z) {
    return smoothstep(uRevealZ - 4.0, uRevealZ + 1.0, z);
  }
  float revealEdge(float z) {
    return exp(-pow((z - uRevealZ) / 2.5, 2.0)) * uRevealFlash;
  }
  float poolMask(vec2 xz) {
    return (1.0 - smoothstep(1.5, 9.0, length(xz - uPool.xy))) * uPool.z;
  }
`;

export const NOISE = /* glsl */ `
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
      mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  float fbm3(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 3; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + 17.1;
      a *= 0.5;
    }
    return v;
  }
  vec3 spectral(float t) {
    return clamp(abs(fract(t + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Tiras de luz instanciadas: un solo draw call para cientos de luces.
// aParams = (semilla, velocidad del pulso, intensidad, fuerza del pulso)
// ---------------------------------------------------------------------------
export function makeStripMaterial({ alongY = false, fogScale = 1, intensity = 1, reveal = true } = {}) {
  return new THREE.ShaderMaterial({
    defines: alongY ? { ALONG_Y: '' } : {},
    uniforms: {
      uTime: shared.uTime,
      uFlow: shared.uFlow,
      uPixelScale: shared.uPixelScale,
      uFogDensity: { value: FOG.density * fogScale },
      uIntensity: { value: intensity },
      uRevealZ: reveal ? shared.uRevealZ : { value: -1e5 },
      uRevealFlash: reveal ? shared.uRevealFlash : { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aParams;
      uniform float uPixelScale;
      varying vec3 vColor;
      varying vec4 vParams;
      varying float vAlong;
      varying float vLen;
      varying float vDepth;
      varying float vWZ;
      varying float vThin;
      void main() {
        // Anti-parpadeo: una tira más fina que ~1.4 px aparece y desaparece al
        // moverse. Se ensancha hasta ese mínimo y se atenúa en proporción, de modo
        // que la luz total se conserva y la línea queda estable.
        vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vec4 cw = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float minW = 1.4 * uPixelScale * max(0.2, -(viewMatrix * cw).z);
        vec3 pos = position;
        #ifdef ALONG_Y
          vec2 f = max(vec2(1.0), minW / sc.xz);
          pos.xz *= f;
          vAlong = position.y + 0.5;
          vLen = sc.y;
        #else
          vec2 f = max(vec2(1.0), minW / sc.xy);
          pos.xy *= f;
          vAlong = position.z + 0.5;
          vLen = sc.z;
        #endif
        vThin = inversesqrt(f.x * f.y);
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #else
          vColor = vec3(1.0);
        #endif
        vParams = aParams;
        vec4 wp = modelMatrix * instanceMatrix * vec4(pos, 1.0);
        vWZ = wp.z;
        vec4 mv = viewMatrix * wp;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uFlow;
      uniform float uFogDensity;
      uniform float uIntensity;
      uniform float uRevealZ;
      uniform float uRevealFlash;
      varying float vWZ;
      varying float vThin;
      varying vec3 vColor;
      varying vec4 vParams;
      varying float vAlong;
      varying float vLen;
      varying float vDepth;
      void main() {
        float seed = vParams.x;
        float speed = vParams.y;
        float inten = vParams.z;
        float pulseAmt = vParams.w;
        // extremos suaves: la luz nace y muere en el metal
        float e = clamp(1.2 / vLen, 0.002, 0.5);
        float ends = smoothstep(0.0, e, vAlong) * smoothstep(1.0, 1.0 - e, vAlong);
        // pulso que viaja a lo largo de la tira (hacia la cámara)
        float x = vAlong * vLen;
        float ph = fract(x * 0.035 - uFlow * speed + seed * 7.0);
        float pulse = exp(-pow((ph - 0.5) * 5.0, 2.0));
        // respiración lenta y sutil (antes era un parpadeo de hasta 1 Hz)
        float breathe = 0.95 + 0.05 * sin(uTime * (0.35 + seed * 0.5) + seed * 40.0);
        float glow = (0.55 + pulse * pulseAmt * 0.45) * breathe;
        #ifdef ALONG_Y
          glow *= mix(1.0, 0.28, smoothstep(0.03, 0.85, vAlong));
        #endif
        vec3 c = vColor * inten * uIntensity * glow * ends * vThin;
        // ola de encendido: apagado detrás del frente, destello en el frente
        float rv = smoothstep(uRevealZ - 4.0, uRevealZ + 1.0, vWZ);
        float edge = exp(-pow((vWZ - uRevealZ) / 2.5, 2.0)) * uRevealFlash;
        c = c * rv + vColor * edge * 2.5 * ends * vThin;
        float fog = exp(-pow(uFogDensity * vDepth, 2.0));
        gl_FragColor = vec4(c * fog, 1.0);
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Muros: metal oscuro PBR + estrías horizontales + destellos prismáticos.
// Todo procedural en el shader: sin texturas que descargar.
// ---------------------------------------------------------------------------
export function makeWallMaterial({ color, roughness, metalness, envMapIntensity, glints = 1 }) {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness, envMapIntensity });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uGlints = { value: glints };
    shader.uniforms.uRevealZ = shared.uRevealZ;
    shader.uniforms.uRevealFlash = shared.uRevealFlash;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace(
        '#include <project_vertex>',
        /* glsl */ `#include <project_vertex>
        vec4 wpp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wpp = instanceMatrix * wpp;
        #endif
        vWPos = (modelMatrix * wpp).xyz;`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nuniform float uTime;\nuniform float uGlints;\nuniform float uRevealZ;\nuniform float uRevealFlash;\n${NOISE}`)
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
        // estrías largas a lo largo del pasillo, como metal cepillado
        // las estrías finas se apagan a lo lejos (más finas que un píxel = moiré al moverse)
        float hf = 1.0 - smoothstep(0.3, 1.0, fwidth(vWPos.y * 38.0));
        float stri = mix(0.5, vnoise(vec2(vWPos.y * 38.0 + vWPos.x * 9.0, vWPos.z * 0.08)), hf);
        float stri2 = vnoise(vec2(vWPos.y * 6.0 + vWPos.x * 2.0, vWPos.z * 0.025));
        float sn = stri * 0.6 + stri2 * 0.4;
        roughnessFactor = clamp(roughnessFactor * mix(0.3, 1.7, sn), 0.03, 1.0);
        diffuseColor.rgb *= mix(0.5, 1.45, sn);`
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        // destellos: puntos de luz estirados, como luces vistas en movimiento
        vec3 gp = vWPos * vec3(10.0, 48.0, 3.5);
        vec3 cell = floor(gp);
        float h = hash13(cell);
        float on = step(0.9965, h);
        vec3 fc = fract(gp);
        float shape = smoothstep(0.0, 0.35, fc.z) * smoothstep(1.0, 0.65, fc.z) * smoothstep(0.5, 0.15, abs(fc.y - 0.5));
        // solo donde el destello ocupa más de un píxel; si no, titila al moverse
        float glintAA = 1.0 - smoothstep(0.07, 0.22, max(fwidth(gp.y), fwidth(gp.z) * 0.5));
        float tw = 0.7 + 0.3 * sin(uTime * (0.4 + h * 1.2) + h * 60.0);
        vec3 gc = mix(vec3(1.0), spectral(fract(h * 7.3)), 0.7);
        totalEmissiveRadiance += gc * on * shape * tw * glintAA * 1.6 * uGlints;`
      )
      .replace(
        '#include <dithering_fragment>',
        /* glsl */ `#include <dithering_fragment>
        float rvW = smoothstep(uRevealZ - 3.0, uRevealZ + 1.0, vWPos.z);
        float edgeW = exp(-pow((vWPos.z - uRevealZ) / 2.0, 2.0)) * uRevealFlash;
        gl_FragColor.rgb = gl_FragColor.rgb * rvW + vec3(0.55, 0.7, 1.0) * edgeW * 0.12;`
      );
  };
  return m;
}

// ---------------------------------------------------------------------------
// Suelo de piedra mojada con reflejo planar: charcos nítidos, piedra seca con
// reflejo estirado en vertical (como en la imagen), juntas y grietas.
// ---------------------------------------------------------------------------
export function floorShader(taps = 9) {
  const half = Math.max(1, Math.floor(taps / 2));
  return {
    name: 'WetFloor',
    uniforms: {
      color: { value: null },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      uTime: { value: 0 },
      uFogColor: { value: new THREE.Color(FOG.color) },
      uFogDensity: { value: FOG.density },
      uRevealZ: { value: 1e5 },
      uRevealFlash: { value: 0 },
      uPool: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */ `
      uniform mat4 textureMatrix;
      varying vec4 vUv;
      varying vec3 vW;
      varying float vDepth;
      void main() {
        vUv = textureMatrix * vec4(position, 1.0);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vec4 mv = viewMatrix * w;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform float uRevealZ;
      uniform float uRevealFlash;
      uniform vec3 uPool;
      varying vec4 vUv;
      varying vec3 vW;
      varying float vDepth;
      ${NOISE}
      ${REVEAL_GLSL}
      void main() {
        vec2 p = vW.xz;
        float big = fbm3(p * vec2(0.21, 0.08) + 4.7);
        float puddle = smoothstep(0.47, 0.6, big);
        // charco-espejo bajo el cubo de la entrada
        puddle = max(puddle, uPool.z * (1.0 - smoothstep(1.8, 5.5, length(p - uPool.xy))));
        float grain = vnoise(p * 2.7) * 0.6 + vnoise(p * 9.0) * 0.4;

        // micro relieve: distorsiona el reflejo; en los charcos, ondas lentas
        vec2 nrm = vec2(vnoise(p * 3.3 + 1.7), vnoise(p * 3.3 + 9.2)) - 0.5;
        nrm += (vec2(vnoise(p * 11.0 + uTime * 0.15), vnoise(p * 11.0 - uTime * 0.12)) - 0.5) * 0.15 * puddle;
        // incluso el charco más liso conserva algo de desenfoque: las líneas finas
        // reflejadas no titilan al moverse
        float rough = mix(1.0, 0.2, puddle);

        vec4 uv = vUv;
        uv.xy += nrm * vec2(0.004, 0.012) * mix(1.0, 0.25, puddle) * uv.w;
        vec3 refl = vec3(0.0);
        float ws = 0.0;
        for (int i = -${half}; i <= ${half}; i++) {
          float f = float(i) / ${half}.0;
          float w = 1.0 - abs(f) * 0.7;
          vec4 u = uv;
          u.y += f * rough * 0.12 * u.w;
          refl += texture2DProj(tDiffuse, u).rgb * w;
          ws += w;
        }
        refl /= ws;

        // losas, juntas y grietas
        vec2 cellP = p / vec2(1.8, 2.6);
        vec2 g = abs(fract(cellP) - 0.5);
        float dEdge = 0.5 - max(g.x, g.y);
        float aa = fwidth(dEdge) * 1.5;
        float seam = 1.0 - smoothstep(0.0, aa + 0.006, dEdge);
        float cr = 1.0 - abs(vnoise(p * 0.9 + 3.0) * 2.0 - 1.0);
        float crack = smoothstep(0.965, 0.995, cr) * (1.0 - puddle);
        float tileTone = 0.75 + 0.5 * hash12(floor(cellP));

        vec3 stone = color * tileTone * (0.55 + 0.9 * grain);
        float k = mix(0.24, 0.95, puddle);
        vec3 c = stone + refl * k;
        c *= 1.0 - seam * 0.6 * (1.0 - puddle * 0.7);
        c *= 1.0 - crack * 0.7;

        float fog = 1.0 - exp(-pow(uFogDensity * vDepth, 2.0));
        c = mix(c, uFogColor, fog);
        // con el pasillo apagado solo se ve el charco de luz bajo el cubo
        float pool = poolMask(p);
        c *= max(revealMask(vW.z), pool);
        c += vec3(0.5, 0.62, 0.9) * pool * pool * 0.012;
        c += vec3(0.55, 0.7, 1.0) * revealEdge(vW.z) * 0.2;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  };
}

// ---------------------------------------------------------------------------
// Polvo suspendido: puntos aditivos que flotan y titilan
// ---------------------------------------------------------------------------
export function makeDustMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: shared.uTime,
      uPR: { value: 1 },
      uFogDensity: { value: FOG.density },
      uRevealZ: shared.uRevealZ,
      uRevealFlash: shared.uRevealFlash,
      uPool: shared.uPool,
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uPR;
      uniform float uFogDensity;
      uniform float uRevealZ;
      uniform float uRevealFlash;
      uniform vec3 uPool;
      varying float vAlpha;
      varying vec3 vCol;
      ${NOISE}
      ${REVEAL_GLSL}
      void main() {
        vec3 p = position;
        float s = aSeed;
        p.x += sin(uTime * 0.13 + s * 31.0) * 0.35;
        p.y += sin(uTime * 0.11 + s * 17.0) * 0.5;
        p.z += sin(uTime * 0.07 + s * 11.0) * 0.6;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float d = -mv.z;
        float size = uPR * (0.6 + fract(s * 7.3) * 1.6) * (9.0 / max(d, 0.5));
        // por debajo de 1.5 px el punto no se encoge: se desvanece (sin parpadeo)
        gl_PointSize = clamp(size, 1.5, 14.0 * uPR);
        float tw = 0.75 + 0.25 * sin(uTime * (0.3 + s * 0.8) + s * 50.0);
        vAlpha = exp(-pow(uFogDensity * d, 2.0)) * tw * smoothstep(0.4, 2.5, d) * min(1.0, size / 1.5);
        vAlpha *= max(revealMask(p.z), poolMask(p.xz) * 0.8);
        vCol = mix(vec3(1.0), spectral(fract(s * 13.1)), 0.35);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying vec3 vCol;
      void main() {
        float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
        gl_FragColor = vec4(vCol * 1.6, a * vAlpha);
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Acabado de lente: aberración cromática, desenfoque radial al hacer scroll,
// viñeta y grano fino. Trabaja en lineal, antes del tone mapping.
// ---------------------------------------------------------------------------
export const FinishShader = {
  name: 'LensFinish',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uVel: { value: 0 },
    uCA: { value: 0.012 },
    uFx: { value: 1 }, // 0 = imagen limpia (vista de detalle)
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uRes;
    uniform float uVel;
    uniform float uCA;
    uniform float uFx;
    varying vec2 vUv;
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float r2 = dot(d, d);
      vec2 ca = d * r2 * (uCA + uVel * 0.004) * uFx;
      vec3 col = vec3(
        texture2D(tDiffuse, uv - ca).r,
        texture2D(tDiffuse, uv).g,
        texture2D(tDiffuse, uv + ca).b
      );
      float vig = smoothstep(0.92, 0.18, length(d * vec2(1.0, 1.12)));
      col *= mix(1.0, mix(0.32, 1.0, vig), uFx);
      float g = hash(uv * uRes + fract(uTime * 0.37) * 911.0) - 0.5;
      col += g * 0.02 * (0.12 + col) * uFx;
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};
