import * as THREE from 'three';
import { mix } from './planet';

/** 银河系尺度参数(场景单位)。比例取真实银河系量级,绝对值为观感调校。 */
export const GALAXY = {
  radius: 500, // 盘半径
  scaleLength: 125, // 指数盘标长 h ≈ R/4
  coreRadius: 85, // 核球尺度 ≈ R/6
  thickness: 13, // 薄盘标高(随半径 flaring)
  pitch: (12 * Math.PI) / 180, // 旋臂螺距角 ~12°(银河系实测量级)
  armR0: 55, // 对数螺旋起始半径
  v0: 8, // 平坦自转曲线线速度
  rigidCore: 95, // 此半径内近似刚体转动
};

/** 旋臂相位:2 条主臂 + 2 条弱臂 */
export const ARM_PHASES = [0, Math.PI, Math.PI * 0.5, Math.PI * 1.5];
const ARM_CUM = [0.38, 0.76, 0.88, 1];

/** 平坦自转曲线:核内近似刚体,核外 v≈v0,角速度 ω=v/r 内快外慢 */
export function omegaAt(r: number) {
  const v = r < GALAXY.rigidCore ? (GALAXY.v0 * r) / GALAXY.rigidCore : GALAXY.v0;
  return v / Math.max(r, 1);
}

/** 对数螺旋:半径 r 处第 k 条旋臂的方位角 */
export function armTheta(r: number, k: number) {
  return ARM_PHASES[k] + Math.log(Math.max(r, GALAXY.armR0 * 0.6) / GALAXY.armR0) / Math.tan(GALAXY.pitch);
}

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 光谱型分布。真实丰度约 M 76% / K 12% / G 7.6% / F 3% / A 0.6% / B 0.13% / O 3e-5%;
 * 此处对采样比例做可见性加权(压 M、抬 A/B/O),否则画面整体过红过暗、蓝星几乎不可见;
 * 亮度与大小仍保持"蓝亮而稀、红暗而众"的物理关系。末项为红巨星点缀。
 */
const SPECTRAL: Array<{
  p: number;
  c: [number, number, number];
  s: [number, number];
  l: [number, number];
  young?: boolean;
}> = [
  { p: 0.46, c: [1, 0.6, 0.42], s: [0.7, 1.1], l: [0.2, 0.35] }, // M
  { p: 0.21, c: [1, 0.78, 0.56], s: [0.8, 1.3], l: [0.3, 0.46] }, // K
  { p: 0.13, c: [1, 0.93, 0.8], s: [0.9, 1.5], l: [0.38, 0.56] }, // G
  { p: 0.09, c: [0.99, 0.98, 0.92], s: [1, 1.7], l: [0.46, 0.64] }, // F
  { p: 0.06, c: [0.83, 0.88, 1], s: [1.2, 2], l: [0.56, 0.78], young: true }, // A
  { p: 0.032, c: [0.69, 0.78, 1], s: [1.4, 2.2], l: [0.66, 0.92], young: true }, // B
  { p: 0.008, c: [0.6, 0.7, 1], s: [1.7, 2.6], l: [0.78, 1.05], young: true }, // O
  { p: 0.01, c: [1, 0.5, 0.3], s: [1.6, 2.4], l: [0.6, 0.8] }, // 红巨星
];

function pickSpectral(oldPopulation: boolean) {
  for (let tries = 0; tries < 8; tries++) {
    let x = Math.random();
    let chosen = SPECTRAL[0];
    for (const sp of SPECTRAL) {
      x -= sp.p;
      if (x <= 0) {
        chosen = sp;
        break;
      }
    }
    // 核球是年老星族:不出年轻蓝星,重采样
    if (!(oldPopulation && chosen.young)) return chosen;
  }
  return SPECTRAL[0];
}

export interface StarField {
  radius: Float32Array;
  theta: Float32Array;
  height: Float32Array;
  size: Float32Array;
  color: Float32Array;
  seed: Float32Array;
}

/** 采样盘面恒星:指数盘 + 高斯核球 + 对数螺旋密度波(年轻蓝星更贴臂) */
export function sampleGalaxyStars(count: number): StarField {
  const R = GALAXY.radius;
  const radius = new Float32Array(count);
  const theta = new Float32Array(count);
  const height = new Float32Array(count);
  const size = new Float32Array(count);
  const color = new Float32Array(count * 3);
  const seed = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const inBulge = Math.random() < 0.24;
    const sp = pickSpectral(inBulge);
    let r: number;
    let th: number;
    let h: number;

    if (inBulge) {
      const x = gauss() * GALAXY.coreRadius * 0.5;
      const z = gauss() * GALAXY.coreRadius * 0.5;
      r = Math.min(Math.hypot(x, z), GALAXY.coreRadius * 2.2);
      r = 44 + r * 0.85; // 让开银心恒星(半径 32 + 光壳),粒子不糊在恒星本体上
      th = Math.atan2(z, x);
      h = gauss() * GALAXY.coreRadius * 0.3;
    } else {
      do {
        r = -GALAXY.scaleLength * Math.log(1 - Math.random());
      } while (r > R);
      r = Math.max(r, 8);
      const armed = Math.random() < (sp.young ? 0.95 : 0.78);
      if (armed) {
        let k = 0;
        const x = Math.random();
        while (x > ARM_CUM[k]) k++;
        const spread = sp.young ? 0.05 : 0.11 + 0.07 * (r / R);
        th = armTheta(r, k) + gauss() * spread;
      } else {
        th = Math.random() * Math.PI * 2;
      }
      h = gauss() * GALAXY.thickness * (0.5 + (r / R) * 1.3);
    }

    radius[i] = r;
    theta[i] = th;
    height[i] = h;
    size[i] = sp.s[0] + Math.random() * (sp.s[1] - sp.s[0]);
    const lum = (sp.l[0] + Math.random() * (sp.l[1] - sp.l[0])) * 0.8;
    const warm = inBulge ? 1.06 : 1;
    color[i * 3] = sp.c[0] * lum * warm;
    color[i * 3 + 1] = sp.c[1] * lum;
    color[i * 3 + 2] = sp.c[2] * lum * (inBulge ? 0.92 : 1);
    seed[i] = Math.random() * 100;
  }
  return { radius, theta, height, size, color, seed };
}

/** 远景背景星:球壳分布,静态 */
export function sampleFarStars(count: number, shellRadius: number) {
  const position = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const tints: Array<[number, number, number]> = [
    [0.75, 0.78, 0.9],
    [0.9, 0.86, 0.78],
    [0.85, 0.85, 0.85],
    [0.65, 0.7, 0.85],
  ];
  for (let i = 0; i < count; i++) {
    const z = Math.random() * 2 - 1;
    const phi = Math.random() * Math.PI * 2;
    const xy = Math.sqrt(1 - z * z);
    const r = shellRadius * (0.85 + Math.random() * 0.3);
    position[i * 3] = xy * Math.cos(phi) * r;
    position[i * 3 + 1] = z * r;
    position[i * 3 + 2] = xy * Math.sin(phi) * r;
    const t = tints[(Math.random() * tints.length) | 0];
    const dim = 0.35 + Math.random() * 0.55;
    color[i * 3] = t[0] * dim;
    color[i * 3 + 1] = t[1] * dim;
    color[i * 3 + 2] = t[2] * dim;
  }
  return { position, color };
}

function rgba(hex: string, a: number) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function makeCanvas(size: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function toTexture(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 核球光晕贴图 */
export function makeCoreGlowTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = makeCanvas(s);
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,238,210,0.85)');
  g.addColorStop(0.18, 'rgba(255,215,165,0.5)');
  g.addColorStop(0.45, 'rgba(255,180,110,0.18)');
  g.addColorStop(1, 'rgba(255,160,90,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, s, s);
  return toTexture(c);
}

/** 模块亮星贴图:模块色径向光晕 + 四芒星芒 */
export function makeModuleStarTexture(hex: string): THREE.CanvasTexture {
  const s = 256;
  const c = makeCanvas(s);
  const x = c.getContext('2d')!;
  const ct = s / 2;
  x.globalCompositeOperation = 'lighter';

  const glow = x.createRadialGradient(ct, ct, 0, ct, ct, ct * 0.55);
  glow.addColorStop(0, mix(hex, '#ffffff', 0.8));
  glow.addColorStop(0.22, mix(hex, '#ffffff', 0.4));
  glow.addColorStop(0.55, rgba(hex, 0.5));
  glow.addColorStop(1, rgba(hex, 0));
  x.fillStyle = glow;
  x.fillRect(0, 0, s, s);

  for (const a of [0, Math.PI / 2]) {
    x.save();
    x.translate(ct, ct);
    x.rotate(a);
    x.scale(1, 0.055);
    const spike = x.createRadialGradient(0, 0, 0, 0, 0, ct * 0.95);
    spike.addColorStop(0, 'rgba(255,255,255,0.7)');
    spike.addColorStop(0.35, rgba(hex, 0.5));
    spike.addColorStop(1, rgba(hex, 0));
    x.fillStyle = spike;
    x.beginPath();
    x.arc(0, 0, ct * 0.95, 0, Math.PI * 2);
    x.fill();
    x.restore();
  }
  return toTexture(c);
}

/** 尘埃带贴图:中带聚集的暗棕噪声团块(alpha 遮光) */
export function makeDustTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = makeCanvas(s);
  const x = c.getContext('2d')!;
  for (let i = 0; i < 46; i++) {
    const px = Math.random() * s;
    const py = s * 0.5 + gauss() * s * 0.14;
    const pr = 14 + Math.random() * 38;
    const a = 0.1 + Math.random() * 0.2;
    const g = x.createRadialGradient(px, py, 0, px, py, pr);
    g.addColorStop(0, `rgba(24,15,10,${a})`);
    g.addColorStop(1, 'rgba(24,15,10,0)');
    x.fillStyle = g;
    x.beginPath();
    x.arc(px, py, pr, 0, Math.PI * 2);
    x.fill();
  }
  return toTexture(c);
}
