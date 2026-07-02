import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import LineIcon from './LineIcon';
import type { LineIconName } from './LineIcon';
import {
  GALAXY,
  armTheta,
  makeDustTexture,
  omegaAt,
  sampleFarStars,
  sampleGalaxyStars,
} from '../utils/galaxy';
import { makePlanetTexture, mix, type PlanetKind } from '../utils/planet';

interface PlanetStyle {
  kind: PlanetKind;
  size: number;
  ring: boolean;
  moons: number;
  tilt: number;
}

const STYLES: PlanetStyle[] = [
  { kind: 'gas', size: 18, ring: false, moons: 0, tilt: 0.18 },
  { kind: 'metal', size: 16, ring: true, moons: 0, tilt: 0.42 },
  { kind: 'ocean', size: 15, ring: false, moons: 1, tilt: 0.14 },
  { kind: 'rock', size: 13, ring: false, moons: 0, tilt: 0.3 },
  { kind: 'swirl', size: 17, ring: false, moons: 1, tilt: 0.24 },
  { kind: 'gas', size: 15, ring: false, moons: 0, tilt: 0.5 },
  { kind: 'rock', size: 14, ring: false, moons: 2, tilt: 0.2 },
  { kind: 'ice', size: 14, ring: true, moons: 0, tilt: 0.62 },
  { kind: 'lava', size: 16, ring: false, moons: 0, tilt: 0.32 },
  { kind: 'metal', size: 13, ring: false, moons: 0, tilt: 0.4 },
];

export interface UniverseSection {
  path: string;
  title: string;
  desc: string;
  color: string;
  icon: LineIconName;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/** 性能档位:桌面高 / 桌面低·平板 / 移动 */
const TIERS = [
  { stars: 100_000, far: 5000, dust: 8 },
  { stars: 50_000, far: 3000, dust: 6 },
  { stars: 25_000, far: 2000, dust: 4 },
];

function pickTier() {
  if (window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 700) return 2;
  return (navigator.hardwareConcurrency || 4) <= 4 ? 1 : 0;
}

const STAR_VERT = /* glsl */ `
uniform float uTime;
uniform float uMotion;
uniform float uPixel;
uniform float uV0;
uniform float uRigid;
attribute float aRadius;
attribute float aTheta;
attribute float aHeight;
attribute float aSize;
attribute vec3 aColor;
attribute float aSeed;
varying vec3 vColor;
void main() {
  // 平坦自转曲线:核内刚体、核外 v≈v0 → ω=v/r 差速自转
  float v = uV0 * (aRadius < uRigid ? aRadius / uRigid : 1.0);
  float omega = v / max(aRadius, 1.0);
  float th = aTheta + omega * uTime * uMotion;
  vec3 p = vec3(cos(th) * aRadius, aHeight, sin(th) * aRadius);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float tw = 1.0 - 0.1 * uMotion * (0.5 + 0.5 * sin(uTime * (1.0 + fract(aSeed) * 2.0) + aSeed));
  vColor = aColor * tw;
  gl_PointSize = max(aSize * uPixel * (560.0 / -mv.z), 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float a = clamp(1.0 - d, 0.0, 1.0);
  a = a * a * a; // 收紧光斑,星点更"实"、少晕光
  gl_FragColor = vec4(vColor, a);
}
`;

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export default function CapabilityUniverse({ sections }: { sections: UniverseSection[] }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const [webgl] = useState(() => hasWebGL());

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !webgl) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const motion = reduce ? 0 : 1;

    let width = mount.clientWidth || 800;
    let height = mount.clientHeight || 560;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 6000);
    camera.position.set(0, 320, 560);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.domElement.style.cursor = 'grab';
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 300;
    controls.maxDistance = 1700;
    controls.autoRotate = !reduce;
    controls.autoRotateSpeed = 0.4;
    controls.minPolarAngle = Math.PI * 0.02;
    controls.maxPolarAngle = Math.PI * 0.52;

    const geos: THREE.BufferGeometry[] = [];
    const mats: THREE.Material[] = [];
    const texs: THREE.Texture[] = [];

    let tier = pickTier();

    // 盘面星场:单个 Points,差速自转在顶点 shader 中完成
    const starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: {
        uTime: { value: 0 },
        uMotion: { value: motion },
        uPixel: { value: renderer.getPixelRatio() },
        uV0: { value: GALAXY.v0 },
        uRigid: { value: GALAXY.rigidCore },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    mats.push(starMat);

    let starPoints: THREE.Points | null = null;
    const buildStars = (count: number) => {
      if (starPoints) {
        scene.remove(starPoints);
        starPoints.geometry.dispose();
      }
      const data = sampleGalaxyStars(count);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geo.setAttribute('aRadius', new THREE.BufferAttribute(data.radius, 1));
      geo.setAttribute('aTheta', new THREE.BufferAttribute(data.theta, 1));
      geo.setAttribute('aHeight', new THREE.BufferAttribute(data.height, 1));
      geo.setAttribute('aSize', new THREE.BufferAttribute(data.size, 1));
      geo.setAttribute('aColor', new THREE.BufferAttribute(data.color, 3));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(data.seed, 1));
      starPoints = new THREE.Points(geo, starMat);
      starPoints.frustumCulled = false; // 真实位置在 shader 里算,包围盒不可信
      starPoints.renderOrder = 1;
      scene.add(starPoints);
    };
    buildStars(TIERS[tier].stars);

    // 远景背景星
    const far = sampleFarStars(TIERS[tier].far, 2400);
    const farGeo = new THREE.BufferGeometry();
    farGeo.setAttribute('position', new THREE.BufferAttribute(far.position, 3));
    farGeo.setAttribute('color', new THREE.BufferAttribute(far.color, 3));
    const farMat = new THREE.PointsMaterial({
      size: 1.4,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const farPoints = new THREE.Points(farGeo, farMat);
    farPoints.renderOrder = 0;
    scene.add(farPoints);
    geos.push(farGeo);
    mats.push(farMat);

    // 核球光晕
    // 行星照明:银心当光源 + 微弱环境光(沿用原行星版的观感)
    const light = new THREE.PointLight(0xfff0d0, 2.6, 0, 1.0);
    scene.add(light);
    scene.add(new THREE.AmbientLight(0x4a5480, 1.1));
    // 相机方向弱补光:只提亮行星朝向观察者的一面,避免近侧行星成黑剪影
    const fill = new THREE.DirectionalLight(0x99aadd, 0.6);
    scene.add(fill);
    scene.add(fill.target);

    // 银心恒星:沿用原设计的中心恒星(熔岩贴图 + 双层光壳)
    const sunTex = makePlanetTexture('lava', '#ffcc66');
    texs.push(sunTex);
    const sunGeo = new THREE.SphereGeometry(32, 48, 48);
    const sunMat = new THREE.MeshBasicMaterial({ map: sunTex, color: 0xffe0a0 });
    const sun = new THREE.Mesh(sunGeo, sunMat);
    scene.add(sun);
    geos.push(sunGeo);
    mats.push(sunMat);
    [46, 68].forEach((r, i) => {
      const g = new THREE.SphereGeometry(r, 40, 40);
      const m = new THREE.MeshBasicMaterial({
        color: 0xffb060, transparent: true, opacity: i ? 0.05 : 0.13,
        side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      scene.add(new THREE.Mesh(g, m));
      geos.push(g);
      mats.push(m);
    });


    // 尘埃带:旋臂内缘的暗色遮光片,按各自半径的 ω(r) 公转
    interface Dust {
      mesh: THREE.Mesh;
      r: number;
      theta0: number;
      rotZ0: number;
      y: number;
    }
    const dusts: Dust[] = [];
    const dustTex = makeDustTexture();
    texs.push(dustTex);
    const dustGeo = new THREE.PlaneGeometry(1, 1);
    geos.push(dustGeo);
    const dustCount = TIERS[tier].dust;
    for (let i = 0; i < dustCount; i++) {
      const fr = dustCount === 1 ? 0.5 : i / (dustCount - 1);
      const arm = i % 2;
      const rArm = 150 + fr * 250;
      const r = rArm * 0.88; // 尘埃位于旋臂内缘
      const theta0 = armTheta(rArm, arm) + (((i * 0.618) % 1) - 0.5) * 0.2;
      const rotZ0 = -(theta0 + Math.PI / 2 + GALAXY.pitch);
      const m = new THREE.MeshBasicMaterial({ map: dustTex, transparent: true, depthWrite: false, opacity: 0.6 });
      const mesh = new THREE.Mesh(dustGeo, m);
      const len = 110 + r * 0.4;
      mesh.scale.set(len, len * 0.4, 1);
      mesh.rotation.set(-Math.PI / 2, 0, rotZ0);
      mesh.renderOrder = 3;
      scene.add(mesh);
      mats.push(m);
      dusts.push({ mesh, r, theta0, rotZ0, y: (((i * 0.382) % 1) - 0.5) * 6 });
    }

    // 模块行星(原行星元素,嵌入银河沿旋臂分布) + 引线标签
    interface Moon {
      mesh: THREE.Mesh;
      angle: number;
      radius: number;
      speed: number;
    }
    interface ModuleStar {
      group: THREE.Group;
      sphere: THREE.Mesh;
      moons: Moon[];
      spin: number;
      hit: THREE.Mesh;
      label: HTMLButtonElement;
      section: UniverseSection;
      r: number;
      theta0: number;
      y: number;
    }
    const moduleStars: ModuleStar[] = [];

    const labelLayer = document.createElement('div');
    labelLayer.className = 'universe-labels';
    mount.appendChild(labelLayer);

    const hitGeo = new THREE.SphereGeometry(30, 12, 12);
    const hitMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true });
    geos.push(hitGeo);
    mats.push(hitMat);

    sections.forEach((s, i) => {
      const n = Math.max(sections.length - 1, 1);
      const r = 150 + (i / n) * 270; // 沿主旋臂由内向外
      const jitter = ((i * 0.6180339887) % 1) - 0.5;
      const theta0 = armTheta(r, i % 4) + jitter * 0.5; // 分散到 4 条臂,标签不扎堆
      const y = jitter * 12;

      const style = STYLES[i % STYLES.length];
      const size = style.size * 1.35; // 相机比原行星版更远,等比放大
      const color = new THREE.Color(s.color);
      const group = new THREE.Group();
      group.rotation.z = style.tilt;

      const tex = makePlanetTexture(style.kind, s.color);
      texs.push(tex);
      const geo = new THREE.SphereGeometry(size, 40, 40);
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: style.kind === 'metal' ? 0.35 : 0.8,
        metalness: style.kind === 'metal' ? 0.7 : 0.15,
        emissive: style.kind === 'lava' ? color : new THREE.Color(0x000000),
        emissiveMap: style.kind === 'lava' ? tex : null,
        emissiveIntensity: style.kind === 'lava' ? 1.1 : 0,
      });
      const sphere = new THREE.Mesh(geo, mat);
      group.add(sphere);
      geos.push(geo);
      mats.push(mat);

      if (style.ring) {
        const rGeo = new THREE.RingGeometry(size * 1.5, size * 2.4, 64);
        const rMat = new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.4, side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(rGeo, rMat);
        ring.rotation.x = Math.PI / 2 - 0.3;
        group.add(ring);
        geos.push(rGeo);
        mats.push(rMat);
      }

      const moons: Moon[] = [];
      for (let m = 0; m < style.moons; m++) {
        const mGeo = new THREE.SphereGeometry(size * 0.28, 16, 16);
        const mMat = new THREE.MeshStandardMaterial({ color: mix(s.color, '#ffffff', 0.4), roughness: 0.9 });
        const moon = new THREE.Mesh(mGeo, mMat);
        group.add(moon);
        geos.push(mGeo);
        mats.push(mMat);
        moons.push({ mesh: moon, angle: Math.random() * Math.PI * 2, radius: size * (2 + m * 0.8), speed: 1.2 + m * 0.5 });
      }

      // 轨道环(星图注记,绕银心)
      const orbGeo = new THREE.RingGeometry(r - 0.7, r + 0.7, 220);
      const orbMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, side: THREE.DoubleSide });
      const orbit = new THREE.Mesh(orbGeo, orbMat);
      orbit.rotation.x = Math.PI / 2;
      scene.add(orbit);
      geos.push(orbGeo);
      mats.push(orbMat);

      const hit = new THREE.Mesh(hitGeo, hitMat);
      group.add(hit);
      scene.add(group);

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'planet-tag';
      label.style.setProperty('--c', s.color);
      label.innerHTML =
        `<span class="planet-tag-code">${ROMAN[i] ?? i + 1}</span>` +
        `<span class="planet-tag-name">${s.title}</span>` +
        `<span class="planet-tag-desc">${s.desc}</span>`;
      label.addEventListener('click', () => navRef.current(s.path));
      labelLayer.appendChild(label);

      moduleStars.push({
        group, sphere, moons, hit, label, section: s, r, theta0, y,
        spin: 0.2 + ((i * 0.317) % 1) * 0.4,
      });
    });

    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let hovered: ModuleStar | null = null;
    const setHover = (p: ModuleStar | null) => {
      if (hovered === p) return;
      if (hovered) hovered.label.classList.remove('is-hover');
      hovered = p;
      if (hovered) hovered.label.classList.add('is-hover');
      renderer.domElement.style.cursor = hovered ? 'pointer' : 'grab';
    };
    const onMove = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      ray.setFromCamera(ndc, camera);
      const hitObj = ray.intersectObjects(moduleStars.map((p) => p.hit))[0];
      setHover(hitObj ? moduleStars.find((p) => p.hit === hitObj.object) ?? null : null);
    };
    const onClick = () => {
      if (hovered) navRef.current(hovered.section.path);
    };
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('click', onClick);

    const clock = new THREE.Clock();
    const proj = new THREE.Vector3();
    const scl = new THREE.Vector3();
    let raf = 0;
    let running = true;

    // 头几秒实测 FPS,不达标降一档重建星场(仅一次)
    const probe = { started: 0, frames: 0, done: false };

    let tPrev = 0;
    const animate = () => {
      if (!running) return;
      raf = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      const dt = Math.min(t - tPrev, 0.1);
      tPrev = t;
      starMat.uniforms.uTime.value = t;

      moduleStars.forEach((p) => {
        const th = p.theta0 + omegaAt(p.r) * t * motion;
        p.group.position.set(Math.cos(th) * p.r, p.y, Math.sin(th) * p.r);
        p.sphere.rotation.y += dt * p.spin;
        p.moons.forEach((mn) => {
          if (!reduce) mn.angle += dt * mn.speed;
          mn.mesh.position.set(Math.cos(mn.angle) * mn.radius, Math.sin(mn.angle * 1.6) * 2, Math.sin(mn.angle) * mn.radius);
        });
        const s = hovered === p ? 1.35 : 1;
        p.group.scale.lerp(scl.set(s, s, s), 0.15);
        proj.copy(p.group.position).project(camera);
        const px = (proj.x * 0.5 + 0.5) * width;
        const py = (-proj.y * 0.5 + 0.5) * height;
        p.label.style.transform = `translate(-50%, -160%) translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
        p.label.style.opacity = proj.z < 1 ? '1' : '0';
      });

      dusts.forEach((d) => {
        const th = d.theta0 + omegaAt(d.r) * t * motion;
        d.mesh.position.set(Math.cos(th) * d.r, d.y, Math.sin(th) * d.r);
        d.mesh.rotation.z = d.rotZ0 - (th - d.theta0);
      });

      sun.rotation.y += dt * 0.12;
      fill.position.copy(camera.position);

      if (!probe.done) {
        const now = performance.now();
        if (!probe.started) probe.started = now;
        const el = now - probe.started;
        if (el > 1500) probe.frames++;
        if (el > 3500) {
          probe.done = true;
          const fps = probe.frames / ((el - 1500) / 1000);
          if (fps < 38 && tier < TIERS.length - 1) {
            tier++;
            buildStars(TIERS[tier].stars);
          }
        }
      }

      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resize = () => {
      width = mount.clientWidth || 800;
      height = mount.clientHeight || 560;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        clock.getDelta();
        if (!probe.done) {
          probe.started = 0;
          probe.frames = 0;
        }
        animate();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('click', onClick);
      document.removeEventListener('visibilitychange', onVisibility);
      ro.disconnect();
      controls.dispose();
      if (starPoints) {
        scene.remove(starPoints);
        starPoints.geometry.dispose();
      }
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      texs.forEach((t) => t.dispose());
      renderer.dispose();
      labelLayer.remove();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [sections, webgl]);

  if (!webgl) {
    return (
      <div className="grid-3 mb-4">
        {sections.map((s) => (
          <Link key={s.path} to={s.path} style={{ textDecoration: 'none' }}>
            <div className="tool-card" style={{ borderTop: `3px solid ${s.color}` }}>
              <div className="overview-module-icon" style={{ color: s.color }}>
                <LineIcon name={s.icon} />
              </div>
              <div className="tool-card-name" style={{ color: s.color }}>{s.title}</div>
              <div className="tool-card-desc">{s.desc}</div>
            </div>
          </Link>
        ))}
      </div>
    );
  }

  return (
    <div className="universe-wrap">
      <div ref={mountRef} className="universe-stage" />
      <div className="universe-hint">拖动旋转 · 滚轮缩放 · 点击行星进入</div>
    </div>
  );
}
