import * as THREE from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/addons/controls/OrbitControls.js';
import { GLTFLoader } from './vendor/three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from './vendor/three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from './vendor/three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/three/addons/postprocessing/OutputPass.js';

const MODEL_URL = '/assets/crucible-reactor.glb';
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const CAMERA_PRESETS = {
  hero: { pos: new THREE.Vector3(2.08, 2.74, 6.85), target: new THREE.Vector3(0.0, 1.72, 0.0) },
  core: { pos: new THREE.Vector3(0.55, 1.96, 3.65), target: new THREE.Vector3(0.0, 1.84, 0.0) },
  conduits: { pos: new THREE.Vector3(2.35, 4.70, 4.45), target: new THREE.Vector3(0.0, 1.25, 0.0) }
};

const TOOL_COLORS = {
  codex: new THREE.Color('#ff8a3d'),
  claude: new THREE.Color('#ff5d38'),
  opencode: new THREE.Color('#5ee2b4'),
  gemini: new THREE.Color('#66b8ff'),
  cursor: new THREE.Color('#a98bff'),
  default: new THREE.Color('#ff9d4d')
};

const HEARTH_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const HEARTH_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uHeat;
  uniform float uPlasma;
  uniform float uSurge;
  uniform float uCalm;
  varying vec2 vUv;

  vec2 hash22(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453123);
  }

  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
    float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
    float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float voronoiCrack(vec2 x, float t) {
    vec2 n = floor(x);
    vec2 f = fract(x);
    float md = 8.0;
    vec2 mr = vec2(0.0);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = hash22(n + g);
        o = 0.5 + 0.42 * sin(t * 0.7 + 6.2831 * o);
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < md) { md = d; mr = r; }
      }
    }
    md = 8.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = hash22(n + g);
        o = 0.5 + 0.42 * sin(t * 0.7 + 6.2831 * o);
        vec2 r = g + o - f;
        if (dot(mr - r, mr - r) > 0.00001) {
          md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
        }
      }
    }
    return md;
  }

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float radial = length(p);
    float mask = 1.0 - smoothstep(0.84, 1.0, radial);

    float flowT = uTime * (0.35 + uHeat * 0.9);
    vec2 warped = p * 3.4 + vec2(noise2(p * 2.2 + flowT * 0.25), noise2(p * 2.2 - flowT * 0.2)) * 0.42;
    float crackDist = voronoiCrack(warped, flowT);
    float crack = 1.0 - smoothstep(0.02, 0.24 + uHeat * 0.14, crackDist);
    float embers = noise2(p * 7.5 + vec2(0.0, flowT * 0.45));

    float energy = (0.28 + uHeat * 1.45 + uSurge * 0.75) * (0.25 + crack * 0.95 + embers * 0.22);
    energy *= mix(1.0, 0.55, smoothstep(0.45, 0.98, radial));

    vec3 crust = vec3(0.05, 0.02, 0.015);
    vec3 crimson = vec3(0.95, 0.14, 0.02);
    vec3 molten = vec3(1.0, 0.52, 0.08);
    vec3 bright = vec3(1.0, 0.92, 0.58);
    vec3 plasma = vec3(0.42, 0.88, 1.0);

    vec3 col = crust;
    col = mix(col, crimson, smoothstep(0.06, 0.42, energy));
    col = mix(col, molten, smoothstep(0.38, 0.95, energy));
    col = mix(col, bright, smoothstep(0.88, 1.55, energy));
    float centerHot = (1.0 - smoothstep(0.0, 0.70, radial)) * smoothstep(0.35, 1.15, energy);
    col = mix(col, plasma * 1.45, uPlasma * centerHot * 0.88);

    float boost = (0.85 + uHeat * 1.05 + uSurge * 0.45) * mix(1.0, 0.62, uCalm);
    gl_FragColor = vec4(col * boost * mask, 1.0);
  }
`;

const FIRE_VOLUME_VERT = /* glsl */ `
  varying vec3 vLocalPos;
  void main() {
    vLocalPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FIRE_VOLUME_FRAG = /* glsl */ `
  precision highp float;

  uniform vec3 uLocalCam;
  uniform float uTime;
  uniform float uRadius;
  uniform float uHeight;
  uniform float uIntensity;
  uniform float uTempNorm;
  uniform float uPlasmaMix;
  uniform float uSurge;
  uniform float uCalm;
  uniform float uIsCrown;

  varying vec3 vLocalPos;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i);
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    float nx00 = mix(n000, n100, u.x);
    float nx10 = mix(n010, n110, u.x);
    float nx01 = mix(n001, n101, u.x);
    float nx11 = mix(n011, n111, u.x);
    float nxy0 = mix(nx00, nx10, u.y);
    float nxy1 = mix(nx01, nx11, u.y);
    return mix(nxy0, nxy1, u.z);
  }

  float fbm3(vec3 p) {
    float v = 0.0;
    float a = 0.54;
    for (int i = 0; i < 3; i++) {
      v += a * noise3(p);
      p = p * 2.06 + vec3(13.1, -7.4, 5.7);
      a *= 0.48;
    }
    return v;
  }

  vec2 intersectCylinder(vec3 ro, vec3 rd, float R, float halfH) {
    float a = dot(rd.xz, rd.xz);
    float b = 2.0 * dot(ro.xz, rd.xz);
    float c = dot(ro.xz, ro.xz) - R * R;
    float t0 = -1e5;
    float t1 = 1e5;
    if (a > 1e-6) {
      float disc = b * b - 4.0 * a * c;
      if (disc < 0.0) return vec2(1.0, -1.0);
      float s = sqrt(disc);
      t0 = (-b - s) / (2.0 * a);
      t1 = (-b + s) / (2.0 * a);
    } else if (c > 0.0) {
      return vec2(1.0, -1.0);
    }
    if (abs(rd.y) > 1e-6) {
      float ty0 = (-halfH - ro.y) / rd.y;
      float ty1 = (halfH - ro.y) / rd.y;
      t0 = max(t0, min(ty0, ty1));
      t1 = min(t1, max(ty0, ty1));
    } else if (abs(ro.y) > halfH) {
      return vec2(1.0, -1.0);
    }
    return vec2(max(t0, 0.0), t1);
  }

  void main() {
    vec3 ro = uLocalCam;
    vec3 rd = normalize(vLocalPos - uLocalCam);
    float halfH = uHeight * 0.5;
    vec2 hit = intersectCylinder(ro, rd, uRadius, halfH);
    if (hit.y <= hit.x) discard;

    const int STEPS = 28;
    float span = hit.y - hit.x;
    float dt = span / float(STEPS);
    float jitter = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + uTime * 11.7) * 43758.5453);
    float t = hit.x + dt * jitter;

    float flameReach = mix(0.38, 1.02, clamp(uIntensity * 0.85 + uTempNorm * 0.25 + uSurge * 0.22, 0.0, 1.0));
    float speed = 1.65 + uIntensity * 2.55 + uSurge * 1.4;

    vec3 accumColor = vec3(0.0);
    float accumAlpha = 0.0;

    for (int i = 0; i < STEPS; i++) {
      vec3 p = ro + rd * t;
      float hNorm = clamp((p.y + halfH) / uHeight, 0.0, 1.0);
      float hFlame = hNorm / max(0.18, flameReach);

      if (hFlame < 1.04) {
        // Gentle helical swirl & rising sway
        float ang = hNorm * (2.2 + uIntensity * 1.8) - uTime * (1.2 + uIntensity * 1.3);
        float cs = cos(ang);
        float sn = sin(ang);
        vec2 sway = vec2(sin(uTime * 2.1 + hNorm * 5.0), cos(uTime * 1.7 + hNorm * 4.2)) * (0.045 + uIntensity * 0.05) * hNorm;
        vec2 xz = p.xz + sway;
        vec2 rotXZ = vec2(xz.x * cs - xz.y * sn, xz.x * sn + xz.y * cs);
        float rad = length(xz) / uRadius;

        float targetRad = mix(0.86, 0.14, pow(clamp(hFlame, 0.0, 1.0), 0.78));
        if (uIsCrown > 0.5) targetRad *= 0.88;

        vec3 nPos = vec3(rotXZ.x * 2.4, p.y * 2.1 - uTime * speed, rotXZ.y * 2.4);
        float turb = fbm3(nPos);
        float fine = noise3(nPos * 2.2 - vec3(0.0, uTime * speed * 0.8, 0.0));

        float radialShape = 1.0 - smoothstep(targetRad * 0.24, targetRad * 1.05, rad + (turb - 0.52) * 0.42);
        float bottomFade = smoothstep(0.0, 0.08, hNorm);
        float topFade = 1.0 - smoothstep(0.62, 1.0, hFlame);
        float density = radialShape * bottomFade * topFade * (0.48 + 0.92 * turb + 0.36 * fine);

        if (density > 0.025) {
          float heatVal = clamp(density * (0.58 + uIntensity * 0.62 + uSurge * 0.25) * (1.0 - hFlame * 0.36), 0.0, 1.45);

          vec3 cRed = vec3(0.90, 0.09, 0.012);
          vec3 cOrange = vec3(1.0, 0.40, 0.04);
          vec3 cGold = vec3(1.0, 0.82, 0.30);
          vec3 cWhite = vec3(1.0, 0.94, 0.76);

          vec3 sampleCol = mix(cRed, cOrange, smoothstep(0.06, 0.45, heatVal));
          sampleCol = mix(sampleCol, cGold, smoothstep(0.42, 0.90, heatVal));
          sampleCol = mix(sampleCol, cWhite, smoothstep(0.88, 1.35, heatVal));

          // Superheated blue-white plasma core: suppress warm red/orange in the inner column so additive blend reads vivid sapphire-white
          float radialZone = 1.0 - smoothstep(0.12, 0.68, rad);
          float axialZone = smoothstep(0.03, 0.16, hFlame) * (1.0 - smoothstep(0.55, 0.94, hFlame));
          float innerCoreMask = radialZone * axialZone * smoothstep(0.18, 0.75, heatVal);
          vec3 plasmaSapphire = vec3(0.08, 0.56, 1.0);
          vec3 plasmaCyanWhite = vec3(0.66, 0.95, 1.0);
          vec3 plasmaCol = mix(plasmaSapphire, plasmaCyanWhite, smoothstep(0.32, 0.88, innerCoreMask)) * (1.45 + uPlasmaMix * 0.65);

          float plasmaReplace = clamp(uPlasmaMix * radialZone * (0.55 + 0.45 * innerCoreMask), 0.0, 0.98);
          sampleCol = mix(sampleCol, plasmaCol, plasmaReplace * (uIsCrown > 0.5 ? 0.78 : 1.0));

          if (uCalm > 0.5) {
            float luma = dot(sampleCol, vec3(0.33, 0.5, 0.17));
            sampleCol = mix(sampleCol, vec3(luma * 0.95, luma * 0.84, luma * 0.62), 0.48);
          }

          float gain = (0.58 + uIntensity * 0.88 + uSurge * 0.35) * (uIsCrown > 0.5 ? (0.38 + uTempNorm * 0.85) : 1.0);
          gain *= mix(1.0, 0.58, uCalm);
          float stepAlpha = clamp(density * dt * 1.28, 0.0, 0.50);
          accumColor += (1.0 - accumAlpha) * sampleCol * gain * stepAlpha;
          accumAlpha += (1.0 - accumAlpha) * stepAlpha;
          if (accumAlpha > 0.96) break;
        }
      }
      t += dt;
    }

    if (accumAlpha < 0.004) discard;
    gl_FragColor = vec4(accumColor, accumAlpha);
  }
`;

const QUARTZ_FRESNEL_VERT = /* glsl */ `
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDirW = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const QUARTZ_FRESNEL_FRAG = /* glsl */ `
  uniform float uHeat;
  uniform float uPlasma;
  uniform float uCalm;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  varying vec2 vUv;

  void main() {
    float ndv = abs(dot(normalize(vNormalW), normalize(vViewDirW)));
    float fresnel = pow(1.0 - clamp(ndv, 0.0, 1.0), 2.8);
    float edgeBands = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.88, 1.0, vUv.y));
    float rimGlow = mix(0.25, 1.0, fresnel) * (0.35 + 0.65 * (1.0 - edgeBands));

    vec3 warmTint = mix(vec3(0.45, 0.72, 0.90), vec3(1.0, 0.56, 0.22), smoothstep(0.05, 0.65, uHeat));
    warmTint = mix(warmTint, vec3(0.68, 0.92, 1.0), uPlasma * 0.55);
    if (uCalm > 0.5) warmTint *= 0.6;

    float alpha = clamp(fresnel * (0.28 + uHeat * 0.25) + (1.0 - edgeBands) * 0.08, 0.0, 0.65);
    gl_FragColor = vec4(warmTint * (0.65 + uHeat * 0.85) * rimGlow, alpha);
  }
`;

const CONDUIT_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDirW = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const CONDUIT_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uActive;
  uniform float uWaiting;
  uniform float uHighlight;
  uniform float uSurge;
  uniform float uCalm;
  uniform vec3 uColor;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vViewDirW;

  void main() {
    float ndv = abs(dot(normalize(vNormalW), normalize(vViewDirW)));
    float fresnel = pow(1.0 - clamp(ndv, 0.0, 1.0), 2.1);

    float flowSpeed = mix(0.55, 3.6, uActive) + uHighlight * 1.4 + uSurge * 2.2;
    float wave1 = 0.5 + 0.5 * sin(vUv.x * 16.0 - uTime * flowSpeed);
    float wave2 = 0.5 + 0.5 * sin(vUv.x * 34.0 - uTime * flowSpeed * 1.7 + 1.4);
    float pulse = pow(wave1, 3.0) * 0.72 + pow(wave2, 5.0) * 0.45;
    float breathe = 0.5 + 0.5 * sin(uTime * 2.4 + vUv.x * 4.0);

    float statePower = uActive > 0.5
      ? (0.45 + pulse * 1.35)
      : uWaiting > 0.5
        ? (0.18 + breathe * 0.26)
        : 0.06;

    float surgeFront = fract(uTime * 2.2);
    float surgePacket = uSurge * exp(-pow((vUv.x - surgeFront) * 9.0, 2.0)) * 1.6;
    float totalGlow = (statePower + uHighlight * (0.65 + pulse * 0.85) + surgePacket) * mix(1.0, 0.58, uCalm);

    vec3 glassShell = vec3(0.06, 0.04, 0.035) + fresnel * vec3(0.24, 0.14, 0.09);
    vec3 coreTint = mix(uColor, vec3(0.95, 0.98, 1.0), clamp(pulse * 0.4 + uHighlight * 0.3, 0.0, 0.75));
    vec3 finalCol = glassShell + coreTint * totalGlow * (0.55 + 0.65 * (1.0 - fresnel));

    gl_FragColor = vec4(finalCol, 1.0);
  }
`;

const SPARK_VERT = /* glsl */ `
  attribute float aScale;
  attribute float aPhase;
  uniform float uPixelRatio;
  uniform float uHeat;
  varying float vAlpha;
  varying float vPhase;
  void main() {
    vPhase = aPhase;
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPos;
    float size = aScale * uPixelRatio * (0.85 + uHeat * 0.75);
    gl_PointSize = clamp(size * (120.0 / max(1.0, -mvPos.z)), 1.5, 28.0);
    vAlpha = clamp(aScale, 0.0, 1.0);
  }
`;

const SPARK_FRAG = /* glsl */ `
  uniform vec3 uWarmColor;
  uniform vec3 uHotColor;
  uniform vec3 uPlasmaColor;
  uniform float uPlasma;
  uniform float uCalm;
  varying float vAlpha;
  varying float vPhase;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float core = pow(1.0 - d * 2.0, 2.2);
    vec3 col = mix(uWarmColor, uHotColor, fract(vPhase * 3.17));
    if (uPlasma > 0.05 && fract(vPhase * 7.31) > 0.52) {
      col = mix(col, uPlasmaColor, uPlasma * 0.92);
    }
    if (uCalm > 0.5) col *= 0.55;
    gl_FragColor = vec4(col * (1.45 + core * 1.1), core * vAlpha);
  }
`;

function createForgedNoiseTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const data = img.data;
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < size * size; i += 1) {
    const v = Math.floor(110 + rand() * 85);
    const p = i * 4;
    data[p] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}

function createFloorRadialAlpha() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 12, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
  grad.addColorStop(0.55, 'rgba(220, 220, 220, 0.72)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

function makeParticleSystem(count, radiusMin, radiusMax, yMin, yMax, baseSize, warmHex, hotHex, plasmaHex) {
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const phases = new Float32Array(count);
  const meta = [];

  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const r = radiusMin + Math.random() * (radiusMax - radiusMin);
    const y = yMin + Math.random() * (yMax - yMin);
    positions[i * 3] = Math.cos(angle) * r;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = Math.sin(angle) * r;
    scales[i] = (0.45 + Math.random() * 0.75) * baseSize;
    phases[i] = Math.random();
    meta.push({
      angle,
      radius: r,
      speedY: 0.45 + Math.random() * 0.85,
      swirl: (Math.random() > 0.5 ? 1 : -1) * (0.7 + Math.random() * 1.4),
      life: Math.random()
    });
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

  const mat = new THREE.ShaderMaterial({
    vertexShader: SPARK_VERT,
    fragmentShader: SPARK_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uPixelRatio: { value: Math.min(2, window.devicePixelRatio || 1) },
      uHeat: { value: 0.2 },
      uWarmColor: { value: new THREE.Color(warmHex) },
      uHotColor: { value: new THREE.Color(hotHex) },
      uPlasmaColor: { value: new THREE.Color(plasmaHex) },
      uPlasma: { value: 0.0 },
      uCalm: { value: 0.0 }
    }
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, geo, mat, positions, scales, meta, radiusMin, radiusMax, yMin, yMax, baseSize };
}

class CrucibleSceneController {
  constructor() {
    this.canvas = null;
    this.fallbackImg = null;
    this.stageEl = null;
    this.mounted = false;
    this.ready = false;
    this.disposed = false;
    this.rafId = 0;
    this.paused = false;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.state = {
      temperature: 22,
      tierId: 'cold',
      burnRateTokensPerMin: 0,
      progressPercent: 0,
      cacheRatio: 0,
      burning: false,
      cooling: false,
      palette: 'thermal',
      burners: []
    };
    this.smoothTemp = 22;
    this.smoothProgress = 0;
    this.smoothCache = 0;
    this.surgeEnergy = 0;
    this.highlightedConduit = -1;
    this.elapsed = 0;
    this.lastFrameTime = performance.now();
    this.pointerOffset = new THREE.Vector2(0, 0);
    this.targetPointer = new THREE.Vector2(0, 0);
    this.userInteracting = false;
    this.cameraTween = null;

    this.nodes = {
      ringInner: null,
      ringOuter: null,
      ringInnerGlow: null,
      ringOuterGlow: null,
      ventPivots: [],
      turbineL: null,
      turbineR: null,
      gaugePivot: null,
      boilSegs: [],
      cacheHalo: null,
      hearthBed: null,
      hearthGrate: null,
      crownGlow: null,
      conduitTubes: [],
      conduitLamps: [],
      fireAnchor: new THREE.Vector3(0, 1.84, 0),
      exhaustAnchor: new THREE.Vector3(0, 3.28, 0)
    };
  }

  mount({ canvas, fallbackImg, stageEl }) {
    if (this.mounted) return;
    this.mounted = true;
    this.canvas = canvas;
    this.fallbackImg = fallbackImg;
    this.stageEl = stageEl;

    try {
      this.initThree();
      this.bindEvents();
      this.loadModel();
      this.startLoop();
    } catch (err) {
      console.warn('3D Crucible fallback activated:', err?.message || err);
      this.activateFallback();
    }
  }

  activateFallback() {
    if (this.canvas) this.canvas.hidden = true;
    if (this.fallbackImg) this.fallbackImg.hidden = false;
  }

  initThree() {
    const rect = this.stageEl.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || 800));
    const height = Math.max(280, Math.round(rect.height || 620));
    const dpr = Math.min(1.75, window.devicePixelRatio || 1);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false
    });
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#080709');
    this.scene.fog = new THREE.FogExp2('#080709', 0.052);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = envTex;
    this.scene.environmentIntensity = 0.42;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 60);
    this.camera.position.copy(CAMERA_PRESETS.hero.pos);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.copy(CAMERA_PRESETS.hero.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.9;
    this.controls.maxDistance = 10.5;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.update();

    this.controls.addEventListener('start', () => {
      this.userInteracting = true;
      this.cameraTween = null;
    });
    this.controls.addEventListener('end', () => {
      this.userInteracting = false;
    });

    this.setupEnvironmentAndLights();
    this.setupFireAndParticles();

    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(width, height);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.34, 0.46, 0.92);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  setupEnvironmentAndLights() {
    this.forgedTex = createForgedNoiseTexture();
    const floorAlpha = createFloorRadialAlpha();

    const floorGeo = new THREE.CircleGeometry(14, 64);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      color: '#110d0d',
      roughness: 0.48,
      metalness: 0.72,
      roughnessMap: this.forgedTex,
      bumpMap: this.forgedTex,
      bumpScale: 0.015,
      alphaMap: floorAlpha,
      transparent: true
    });
    this.floorMesh = new THREE.Mesh(floorGeo, floorMat);
    this.floorMesh.position.y = -0.005;
    this.floorMesh.receiveShadow = true;
    this.scene.add(this.floorMesh);

    // Subtle concentric foundry floor groove rings
    const ringGeo = new THREE.RingGeometry(1.78, 1.82, 64);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: '#3b241a', transparent: true, opacity: 0.45 });
    const floorRing = new THREE.Mesh(ringGeo, ringMat);
    floorRing.position.y = 0.002;
    this.scene.add(floorRing);

    this.coreLight = new THREE.PointLight('#ff6e24', 8, 11, 1.9);
    this.coreLight.position.set(0, 1.75, 0);
    this.coreLight.castShadow = true;
    this.coreLight.shadow.mapSize.set(512, 512);
    this.coreLight.shadow.bias = -0.002;
    this.scene.add(this.coreLight);

    this.hearthBounceLight = new THREE.PointLight('#ff561c', 3, 7, 1.9);
    this.hearthBounceLight.position.set(0.25, 0.88, 1.45);
    this.scene.add(this.hearthBounceLight);

    this.crownLight = new THREE.PointLight('#ff7e2c', 1.5, 6, 1.9);
    this.crownLight.position.set(0, 3.45, 0.25);
    this.scene.add(this.crownLight);

    this.rimCool = new THREE.DirectionalLight('#72adff', 1.65);
    this.rimCool.position.set(-4.2, 4.4, -2.5);
    this.scene.add(this.rimCool);

    this.rimCopper = new THREE.DirectionalLight('#ff9452', 1.50);
    this.rimCopper.position.set(4.5, 3.6, 2.2);
    this.scene.add(this.rimCopper);

    this.keyLight = new THREE.DirectionalLight('#f4efe9', 1.05);
    this.keyLight.position.set(1.8, 6.2, 4.8);
    this.scene.add(this.keyLight);
  }

  setupFireAndParticles() {
    this.fireUniforms = {
      uLocalCam: { value: new THREE.Vector3(0, 2, 6) },
      uTime: { value: 0 },
      uRadius: { value: 0.69 },
      uHeight: { value: 1.96 },
      uIntensity: { value: 0.2 },
      uTempNorm: { value: 0.1 },
      uPlasmaMix: { value: 0.0 },
      uSurge: { value: 0.0 },
      uCalm: { value: 0.0 },
      uIsCrown: { value: 0.0 }
    };
    const fireGeo = new THREE.CylinderGeometry(0.69, 0.69, 1.96, 32, 1, false);
    const fireMat = new THREE.ShaderMaterial({
      vertexShader: FIRE_VOLUME_VERT,
      fragmentShader: FIRE_VOLUME_FRAG,
      uniforms: this.fireUniforms,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.fireMesh = new THREE.Mesh(fireGeo, fireMat);
    this.fireMesh.position.copy(this.nodes.fireAnchor);
    this.fireMesh.renderOrder = 2;
    this.scene.add(this.fireMesh);

    this.crownFireUniforms = {
      uLocalCam: { value: new THREE.Vector3(0, 2, 6) },
      uTime: { value: 0 },
      uRadius: { value: 0.42 },
      uHeight: { value: 1.15 },
      uIntensity: { value: 0.2 },
      uTempNorm: { value: 0.1 },
      uPlasmaMix: { value: 0.0 },
      uSurge: { value: 0.0 },
      uCalm: { value: 0.0 },
      uIsCrown: { value: 1.0 }
    };
    const crownGeo = new THREE.CylinderGeometry(0.42, 0.34, 1.15, 24, 1, false);
    const crownMat = new THREE.ShaderMaterial({
      vertexShader: FIRE_VOLUME_VERT,
      fragmentShader: FIRE_VOLUME_FRAG,
      uniforms: this.crownFireUniforms,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.crownFireMesh = new THREE.Mesh(crownGeo, crownMat);
    this.crownFireMesh.position.set(0, 3.65, 0);
    this.crownFireMesh.renderOrder = 5;
    this.scene.add(this.crownFireMesh);

    this.innerSparks = makeParticleSystem(180, 0.14, 0.64, 0.92, 2.75, 1.0, '#ff8e36', '#ffe38e', '#92ecff');
    this.innerSparks.points.renderOrder = 3;
    this.scene.add(this.innerSparks.points);

    this.crownEmbers = makeParticleSystem(140, 0.06, 0.56, 3.18, 5.4, 1.15, '#ff6824', '#ffd068', '#8ae8ff');
    this.crownEmbers.points.renderOrder = 5;
    this.scene.add(this.crownEmbers.points);

    this.hearthShaderMat = new THREE.ShaderMaterial({
      vertexShader: HEARTH_VERT,
      fragmentShader: HEARTH_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uHeat: { value: 0.1 },
        uPlasma: { value: 0.0 },
        uSurge: { value: 0.0 },
        uCalm: { value: 0.0 }
      }
    });
  }

  loadModel() {
    const loader = new GLTFLoader();
    loader.load(
      MODEL_URL,
      gltf => {
        if (this.disposed) return;
        const root = gltf.scene;
        this.crucibleRoot = root;
        this.bindModelNodes(root);
        this.scene.add(root);
        this.ready = true;
        document.dispatchEvent(new CustomEvent('crucible-ready'));
      },
      undefined,
      err => {
        console.warn('Failed to load crucible GLB:', err?.message || err);
        this.activateFallback();
      }
    );
  }

  bindModelNodes(root) {
    const quartzMeshes = [];
    const boilMap = new Map();
    const ventMap = new Map();
    const conduitTubeMap = new Map();
    const conduitLampMap = new Map();

    root.traverse(obj => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        const matName = obj.material?.name || '';
        if (matName.includes('CastIron')) {
          obj.material.roughnessMap = this.forgedTex;
          obj.material.bumpMap = this.forgedTex;
          obj.material.bumpScale = 0.014;
          obj.material.needsUpdate = true;
        } else if (matName.includes('AgedCopper')) {
          obj.material.roughnessMap = this.forgedTex;
          obj.material.bumpMap = this.forgedTex;
          obj.material.bumpScale = 0.009;
          obj.material.needsUpdate = true;
        }
      }

      const name = obj.name || '';
      if (name === 'FireVolumeAnchor') obj.getWorldPosition(this.nodes.fireAnchor);
      else if (name === 'ExhaustAnchor') obj.getWorldPosition(this.nodes.exhaustAnchor);
      else if (name === 'RingInner') this.nodes.ringInner = obj;
      else if (name === 'RingOuter') this.nodes.ringOuter = obj;
      else if (name === 'RingInnerGlow') this.nodes.ringInnerGlow = obj;
      else if (name === 'RingOuterGlow') this.nodes.ringOuterGlow = obj;
      else if (name === 'TurbineRotor_L') {
        obj.userData.baseQuat = obj.quaternion.clone();
        this.nodes.turbineL = obj;
      } else if (name === 'TurbineRotor_R') {
        obj.userData.baseQuat = obj.quaternion.clone();
        this.nodes.turbineR = obj;
      } else if (name === 'GaugeNeedlePivot') {
        obj.userData.baseQuat = obj.quaternion.clone();
        this.nodes.gaugePivot = obj;
      } else if (name === 'CacheHaloRing') {
        obj.material = obj.material.clone();
        this.nodes.cacheHalo = obj;
      } else if (name === 'CrownInnerGlow') {
        obj.material = obj.material.clone();
        this.nodes.crownGlow = obj;
      } else if (name === 'HearthBed') {
        obj.material = this.hearthShaderMat;
        obj.renderOrder = 1;
        obj.castShadow = false;
        this.nodes.hearthBed = obj;
      } else if (name === 'HearthGrate') {
        obj.material = obj.material.clone();
        this.nodes.hearthGrate = obj;
      } else if (name === 'QuartzShell') {
        quartzMeshes.push(obj);
      } else if (/^BoilSeg_(\d+)$/.test(name)) {
        const idx = Number(name.match(/^BoilSeg_(\d+)$/)[1]);
        obj.material = obj.material.clone();
        boilMap.set(idx, obj);
      } else if (/^VentPivot_(\d+)$/.test(name)) {
        const idx = Number(name.match(/^VentPivot_(\d+)$/)[1]);
        obj.userData.baseQuat = obj.quaternion.clone();
        ventMap.set(idx, obj);
      } else if (/^ConduitTube_(\d+)$/.test(name)) {
        const idx = Number(name.match(/^ConduitTube_(\d+)$/)[1]);
        conduitTubeMap.set(idx, obj);
      } else if (/^ConduitLamp_(\d+)$/.test(name)) {
        const idx = Number(name.match(/^ConduitLamp_(\d+)$/)[1]);
        obj.material = obj.material.clone();
        conduitLampMap.set(idx, obj);
      }
    });

    for (const qMesh of quartzMeshes) {
      qMesh.castShadow = false;
      qMesh.receiveShadow = false;
      qMesh.renderOrder = 4;
      qMesh.material = new THREE.MeshPhysicalMaterial({
        color: '#dceeff',
        transparent: true,
        opacity: 0.22,
        roughness: 0.07,
        metalness: 0.06,
        clearcoat: 1.0,
        clearcoatRoughness: 0.06,
        envMapIntensity: 1.9,
        depthWrite: false
      });

      this.quartzFresnelMat = new THREE.ShaderMaterial({
        vertexShader: QUARTZ_FRESNEL_VERT,
        fragmentShader: QUARTZ_FRESNEL_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uHeat: { value: 0.15 },
          uPlasma: { value: 0.0 },
          uCalm: { value: 0.0 }
        }
      });
      const fresnelOverlay = new THREE.Mesh(qMesh.geometry, this.quartzFresnelMat);
      fresnelOverlay.scale.setScalar(1.003);
      fresnelOverlay.renderOrder = 4;
      qMesh.parent.add(fresnelOverlay);
    }

    this.nodes.boilSegs = [...boilMap.entries()].sort((a, b) => a[0] - b[0]).map(([, o]) => o);
    this.nodes.ventPivots = [...ventMap.entries()].sort((a, b) => a[0] - b[0]).map(([, o]) => o);
    this.nodes.conduitLamps = [...conduitLampMap.entries()].sort((a, b) => a[0] - b[0]).map(([, o]) => o);

    const tubes = [...conduitTubeMap.entries()].sort((a, b) => a[0] - b[0]);
    this.nodes.conduitTubes = tubes.map(([, obj]) => {
      const mat = new THREE.ShaderMaterial({
        vertexShader: CONDUIT_VERT,
        fragmentShader: CONDUIT_FRAG,
        uniforms: {
          uTime: { value: 0 },
          uActive: { value: 0 },
          uWaiting: { value: 0 },
          uHighlight: { value: 0 },
          uSurge: { value: 0 },
          uCalm: { value: 0 },
          uColor: { value: TOOL_COLORS.default.clone() }
        }
      });
      obj.material = mat;
      return { mesh: obj, mat };
    });

    if (this.nodes.ringInnerGlow) this.nodes.ringInnerGlow.material = this.nodes.ringInnerGlow.material.clone();
    if (this.nodes.ringOuterGlow) this.nodes.ringOuterGlow.material = this.nodes.ringOuterGlow.material.clone();

    this.fireMesh.position.copy(this.nodes.fireAnchor);
    this.crownFireMesh.position.set(this.nodes.exhaustAnchor.x, this.nodes.exhaustAnchor.y + 0.36, this.nodes.exhaustAnchor.z);
  }

  bindEvents() {
    let resizeRaf = 0;
    this.onResize = () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        if (!this.stageEl || !this.renderer) return;
        const rect = this.stageEl.getBoundingClientRect();
        const width = Math.max(240, Math.round(rect.width));
        const height = Math.max(240, Math.round(rect.height));
        const dpr = Math.min(1.75, window.devicePixelRatio || 1);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setPixelRatio(dpr);
        this.renderer.setSize(width, height, false);
        this.composer.setPixelRatio(dpr);
        this.composer.setSize(width, height);
        this.bloomPass.resolution.set(width, height);
        this.innerSparks.mat.uniforms.uPixelRatio.value = dpr;
        this.crownEmbers.mat.uniforms.uPixelRatio.value = dpr;
      });
    };

    this.resizeObserver = new ResizeObserver(this.onResize);
    this.resizeObserver.observe(this.stageEl);

    this.onPointerMove = event => {
      if (this.reducedMotion) return;
      const rect = this.stageEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nx = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
      const ny = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
      this.targetPointer.set(nx * 0.14, ny * 0.08);
    };
    this.onPointerLeave = () => this.targetPointer.set(0, 0);
    this.onDoubleClick = () => this.setCameraPreset('hero');

    this.stageEl.addEventListener('pointermove', this.onPointerMove);
    this.stageEl.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
  }

  updateState(next) {
    if (!next) return;
    this.state = {
      ...this.state,
      ...next,
      burners: Array.isArray(next.burners) ? next.burners : this.state.burners
    };
  }

  triggerSurge(strength = 0.85) {
    this.surgeEnergy = Math.min(1.35, Math.max(this.surgeEnergy, strength));
  }

  highlightConduit(index) {
    this.highlightedConduit = Number.isInteger(index) ? index : -1;
  }

  setCameraPreset(presetName) {
    const preset = CAMERA_PRESETS[presetName] || CAMERA_PRESETS.hero;
    this.cameraTween = {
      startPos: this.camera.position.clone(),
      startTarget: this.controls.target.clone(),
      endPos: preset.pos.clone(),
      endTarget: preset.target.clone(),
      progress: 0
    };
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (!this.paused) {
      this.lastFrameTime = performance.now();
    }
  }

  startLoop() {
    const tick = now => {
      if (this.disposed) return;
      this.rafId = requestAnimationFrame(tick);
      if (this.paused || document.hidden) return;
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrameTime) / 1000));
      this.lastFrameTime = now;
      this.step(dt);
      this.composer.render();
    };
    this.rafId = requestAnimationFrame(tick);
  }

  step(dt) {
    const motionScale = this.reducedMotion ? 0.25 : 1.0;
    this.elapsed += dt * motionScale;
    this.surgeEnergy = Math.max(0, this.surgeEnergy - dt * 0.45);

    const targetTemp = Number.isFinite(this.state.temperature) ? this.state.temperature : 22;
    this.smoothTemp += (targetTemp - this.smoothTemp) * Math.min(1, dt * 4.5);
    this.smoothProgress += ((this.state.progressPercent || 0) - this.smoothProgress) * Math.min(1, dt * 5.0);
    this.smoothCache += ((this.state.cacheRatio || 0) - this.smoothCache) * Math.min(1, dt * 4.0);

    const tempNorm = THREE.MathUtils.clamp((this.smoothTemp - 22) / 103, 0, 1);
    const burnNorm = Math.min(1, Math.log1p(Math.max(0, this.state.burnRateTokensPerMin || 0) / 2200) / Math.log1p(35));
    const intensity = THREE.MathUtils.clamp(0.10 + tempNorm * 0.72 + burnNorm * 0.25 + this.surgeEnergy * 0.25, 0.08, 1.05);
    const plasmaMix = THREE.MathUtils.smoothstep(this.smoothTemp, 95, 118);
    const isCalm = this.state.palette === 'calm' ? 1.0 : 0.0;

    // Background & bloom mood
    const bgHex = isCalm > 0.5 ? '#0c100e' : '#080709';
    if (this.scene.background.getHexString() !== bgHex.slice(1)) {
      this.scene.background.set(bgHex);
      this.scene.fog.color.set(bgHex);
    }
    this.bloomPass.strength = (0.20 + intensity * 0.24 + plasmaMix * 0.14 + this.surgeEnergy * 0.08) * (isCalm > 0.5 ? 0.45 : 1.0);
    this.bloomPass.threshold = isCalm > 0.5 ? 1.02 : 0.92;

    // Update camera preset tween & gentle pointer parallax
    if (this.cameraTween) {
      this.cameraTween.progress = Math.min(1, this.cameraTween.progress + dt * 2.4);
      const t = 1 - Math.pow(1 - this.cameraTween.progress, 3);
      this.camera.position.lerpVectors(this.cameraTween.startPos, this.cameraTween.endPos, t);
      this.controls.target.lerpVectors(this.cameraTween.startTarget, this.cameraTween.endTarget, t);
      if (this.cameraTween.progress >= 1) this.cameraTween = null;
    } else if (!this.userInteracting && !this.reducedMotion) {
      this.pointerOffset.lerp(this.targetPointer, Math.min(1, dt * 3.0));
      this.controls.target.x = this.pointerOffset.x * 0.45;
      this.controls.target.y = 1.72 - this.pointerOffset.y * 0.35;
    }
    this.controls.update();

    // Dynamic lights
    const flicker = 0.90 + 0.10 * Math.sin(this.elapsed * 13.7) + 0.06 * Math.cos(this.elapsed * 21.3);
    const warmLight = new THREE.Color('#ff5e1a').lerp(new THREE.Color('#ffaa46'), tempNorm);
    const coreColor = warmLight.clone().lerp(new THREE.Color('#5ad4ff'), plasmaMix * 0.78);
    this.coreLight.color.copy(coreColor);
    this.coreLight.intensity = (4 + intensity * 18 + this.surgeEnergy * 6) * flicker * (isCalm > 0.5 ? 0.65 : 1.0);
    this.hearthBounceLight.color.copy(coreColor);
    this.hearthBounceLight.intensity = (1.5 + intensity * 6.5) * flicker * (isCalm > 0.5 ? 0.65 : 1.0);
    this.crownLight.color.copy(coreColor);
    this.crownLight.intensity = (0.4 + Math.max(0, tempNorm - 0.25) * 9.5) * flicker;

    // Layer 1 & 2 shaders (raymarch camera synced in local space)
    this.hearthShaderMat.uniforms.uTime.value = this.elapsed;
    this.hearthShaderMat.uniforms.uHeat.value = intensity;
    this.hearthShaderMat.uniforms.uPlasma.value = plasmaMix;
    this.hearthShaderMat.uniforms.uSurge.value = this.surgeEnergy;
    this.hearthShaderMat.uniforms.uCalm.value = isCalm;

    if (this.quartzFresnelMat) {
      this.quartzFresnelMat.uniforms.uHeat.value = intensity;
      this.quartzFresnelMat.uniforms.uPlasma.value = plasmaMix;
      this.quartzFresnelMat.uniforms.uCalm.value = isCalm;
    }

    this.fireMesh.updateMatrixWorld();
    const invFire = new THREE.Matrix4().copy(this.fireMesh.matrixWorld).invert();
    this.fireUniforms.uLocalCam.value.copy(this.camera.position).applyMatrix4(invFire);
    this.fireUniforms.uTime.value = this.elapsed;
    this.fireUniforms.uIntensity.value = intensity;
    this.fireUniforms.uTempNorm.value = tempNorm;
    this.fireUniforms.uPlasmaMix.value = plasmaMix;
    this.fireUniforms.uSurge.value = this.surgeEnergy;
    this.fireUniforms.uCalm.value = isCalm;

    this.crownFireMesh.updateMatrixWorld();
    const invCrown = new THREE.Matrix4().copy(this.crownFireMesh.matrixWorld).invert();
    this.crownFireUniforms.uLocalCam.value.copy(this.camera.position).applyMatrix4(invCrown);
    this.crownFireUniforms.uTime.value = this.elapsed;
    this.crownFireUniforms.uIntensity.value = intensity;
    this.crownFireUniforms.uTempNorm.value = tempNorm;
    this.crownFireUniforms.uPlasmaMix.value = plasmaMix;
    this.crownFireUniforms.uSurge.value = this.surgeEnergy;
    this.crownFireUniforms.uCalm.value = isCalm;
    this.crownFireMesh.visible = tempNorm > 0.14 || this.surgeEnergy > 0.08;

    // Layer 3: GPU particles
    this.stepParticles(this.innerSparks, dt * motionScale, intensity, plasmaMix, isCalm, true);
    this.stepParticles(this.crownEmbers, dt * motionScale, Math.max(0.08, tempNorm * 1.15), plasmaMix, isCalm, false);

    // Layer 4 & 5: Articulated mechanics & conduits
    this.stepMechanics(dt * motionScale, tempNorm, burnNorm, intensity, plasmaMix, isCalm);
  }

  stepParticles(sys, dt, intensity, plasmaMix, isCalm, helical) {
    sys.mat.uniforms.uHeat.value = intensity;
    sys.mat.uniforms.uPlasma.value = plasmaMix;
    sys.mat.uniforms.uCalm.value = isCalm;

    const span = sys.yMax - sys.yMin;
    const speedBoost = 0.65 + intensity * 1.8 + this.surgeEnergy * 1.35;

    for (let i = 0; i < sys.meta.length; i += 1) {
      const m = sys.meta[i];
      const idx = i * 3;
      let y = sys.positions[idx + 1] + m.speedY * speedBoost * dt;
      if (y > sys.yMax) {
        y = sys.yMin + (y - sys.yMax);
        m.radius = sys.radiusMin + Math.random() * (sys.radiusMax - sys.radiusMin);
        m.angle = Math.random() * Math.PI * 2;
      }
      const normY = (y - sys.yMin) / span;
      m.angle += m.swirl * (0.8 + intensity * 1.6) * dt;
      const rSpread = helical ? m.radius * (1.0 - normY * 0.25) : m.radius * (0.7 + normY * 1.15);
      sys.positions[idx] = Math.cos(m.angle) * rSpread;
      sys.positions[idx + 1] = y;
      sys.positions[idx + 2] = Math.sin(m.angle) * rSpread;

      const fade = Math.sin(normY * Math.PI);
      const activeRatio = helical ? 1.0 : THREE.MathUtils.clamp((intensity - 0.05) * 1.25, 0.12, 1.0);
      sys.scales[i] = sys.baseSize * fade * activeRatio * (0.65 + 0.55 * m.life);
    }
    sys.geo.attributes.position.needsUpdate = true;
    sys.geo.attributes.aScale.needsUpdate = true;
  }

  stepMechanics(dt, tempNorm, burnNorm, intensity, plasmaMix, isCalm) {
    const spinRate = (0.28 + tempNorm * 1.15 + burnNorm * 1.45 + this.surgeEnergy * 1.2) * (isCalm > 0.5 ? 0.55 : 1.0);

    if (this.nodes.ringInner) {
      this.nodes.ringInner.rotation.y += spinRate * 0.72 * dt;
      const tiltAmp = 0.22 + tempNorm * 0.14;
      this.nodes.ringInner.rotation.x = Math.sin(this.elapsed * 0.62) * tiltAmp;
      this.nodes.ringInner.rotation.z = Math.cos(this.elapsed * 0.51) * (tiltAmp * 0.85);
    }
    if (this.nodes.ringOuter) {
      this.nodes.ringOuter.rotation.y -= spinRate * 0.48 * dt;
      const tiltAmp = 0.26 + tempNorm * 0.18;
      this.nodes.ringOuter.rotation.x = Math.cos(this.elapsed * 0.46) * tiltAmp;
      this.nodes.ringOuter.rotation.z = Math.sin(this.elapsed * 0.58) * tiltAmp;
    }

    const ringGlowCol = new THREE.Color('#ff6a22').lerp(new THREE.Color('#42caff'), plasmaMix * 0.88);
    const ringEmissiveInt = (0.35 + intensity * 1.35) * (isCalm > 0.5 ? 0.55 : 1.0);
    for (const gNode of [this.nodes.ringInnerGlow, this.nodes.ringOuterGlow]) {
      if (gNode?.material) {
        gNode.material.emissive.copy(ringGlowCol);
        gNode.material.emissiveIntensity = ringEmissiveInt;
      }
    }

    // Articulated exhaust petals (0 deg closed at cold -> 42 deg wide open at boiling)
    const openRad = THREE.MathUtils.degToRad(4 + tempNorm * 38 + this.surgeEnergy * 8);
    const qOpen = new THREE.Quaternion();
    for (let i = 0; i < this.nodes.ventPivots.length; i += 1) {
      const vp = this.nodes.ventPivots[i];
      if (!vp.userData.baseQuat) continue;
      const flutter = Math.sin(this.elapsed * 4.2 + i * 1.1) * 0.025 * intensity;
      qOpen.setFromAxisAngle(X_AXIS, openRad + flutter);
      vp.quaternion.copy(vp.userData.baseQuat).multiply(qOpen);
    }

    // Blower turbine rotors spin proportionally to burn rate + surge
    const rotorSpeed = 1.1 + burnNorm * 10.5 + tempNorm * 3.2 + this.surgeEnergy * 8.0;
    if (this.nodes.turbineL) this.nodes.turbineL.rotateZ(rotorSpeed * dt);
    if (this.nodes.turbineR) this.nodes.turbineR.rotateZ(-rotorSpeed * dt);

    // Analog brass dial needle: +2.05 rad (22°C) -> -2.05 rad (125°C)
    if (this.nodes.gaugePivot?.userData.baseQuat) {
      const jitter = (Math.sin(this.elapsed * 19.0) * 0.03) * (burnNorm + this.surgeEnergy * 0.5);
      const needleAngle = THREE.MathUtils.lerp(2.05, -2.05, tempNorm) + jitter;
      const qNeedle = new THREE.Quaternion().setFromAxisAngle(Z_AXIS, needleAngle);
      this.nodes.gaugePivot.quaternion.copy(this.nodes.gaugePivot.userData.baseQuat).multiply(qNeedle);
    }

    // Heated grate & crown throat glow
    if (this.nodes.hearthGrate?.material) {
      this.nodes.hearthGrate.material.emissive.set('#ff3d0a').lerp(new THREE.Color('#ff9d42'), tempNorm);
      this.nodes.hearthGrate.material.emissiveIntensity = Math.pow(tempNorm, 1.5) * 2.4;
    }
    if (this.nodes.crownGlow?.material) {
      this.nodes.crownGlow.material.emissive.copy(ringGlowCol);
      this.nodes.crownGlow.material.emissiveIntensity = (0.2 + tempNorm * 3.6 + this.surgeEnergy * 1.4) * (isCalm > 0.5 ? 0.5 : 1.0);
    }

    // 24-segment Boil Progress Ring on the plinth
    const litCount = Math.round(THREE.MathUtils.clamp(this.smoothProgress, 0, 100) / 100 * this.nodes.boilSegs.length);
    const segWarmCol = tempNorm > 0.8 ? new THREE.Color('#4cd2ff') : tempNorm > 0.55 ? new THREE.Color('#ff7a2e') : new THREE.Color('#f3b559');
    const pulse = this.smoothProgress >= 100 ? (0.78 + 0.28 * Math.sin(this.elapsed * 8.0)) : 1.0;
    for (let i = 0; i < this.nodes.boilSegs.length; i += 1) {
      const seg = this.nodes.boilSegs[i];
      const lit = i < litCount;
      seg.material.emissive.copy(lit ? segWarmCol : new THREE.Color('#1d1715'));
      seg.material.emissiveIntensity = lit ? (1.35 * pulse * (isCalm > 0.5 ? 0.55 : 1.0)) : 0.08;
    }

    // Cache recovery halo ring at base
    if (this.nodes.cacheHalo?.material) {
      const cRatio = THREE.MathUtils.clamp(this.smoothCache, 0, 1);
      this.nodes.cacheHalo.material.emissive.set(isCalm > 0.5 ? '#8fc77a' : '#e8a238');
      this.nodes.cacheHalo.material.emissiveIntensity = 0.15 + cRatio * 1.45;
    }

    // 4 Fuel Intake Conduits mapped to top active burners
    const burners = this.state.burners || [];
    for (let i = 0; i < this.nodes.conduitTubes.length; i += 1) {
      const tube = this.nodes.conduitTubes[i];
      const lamp = this.nodes.conduitLamps[i];
      const b = burners[i];
      const active = b?.state === 'running' ? 1.0 : 0.0;
      const waiting = b?.state === 'waiting' ? 1.0 : 0.0;
      const hl = this.highlightedConduit === i ? 1.0 : 0.0;
      const color = (b && TOOL_COLORS[b.client]) || TOOL_COLORS.default;

      tube.mat.uniforms.uTime.value = this.elapsed;
      tube.mat.uniforms.uActive.value = active;
      tube.mat.uniforms.uWaiting.value = waiting;
      tube.mat.uniforms.uHighlight.value = hl;
      tube.mat.uniforms.uSurge.value = this.surgeEnergy;
      tube.mat.uniforms.uCalm.value = isCalm;
      tube.mat.uniforms.uColor.value.copy(color);

      if (lamp?.material) {
        lamp.material.emissive.copy(color);
        lamp.material.emissiveIntensity = active > 0.5
          ? (2.6 + hl * 1.4)
          : waiting > 0.5
            ? (1.1 + hl * 1.2)
            : (0.18 + hl * 1.5);
      }
    }
  }
}

const controller = new CrucibleSceneController();

window.TokemperatureCrucible = {
  mount: opts => controller.mount(opts),
  updateState: next => controller.updateState(next),
  triggerSurge: strength => controller.triggerSurge(strength),
  highlightConduit: idx => controller.highlightConduit(idx),
  setCameraPreset: preset => controller.setCameraPreset(preset),
  setPaused: paused => controller.setPaused(paused)
};
