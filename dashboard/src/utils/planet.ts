import * as THREE from 'three';

export type PlanetKind = 'gas' | 'rock' | 'ocean' | 'ice' | 'lava' | 'metal' | 'swirl';

export function mix(hex: string, target: string, t: number) {
  return new THREE.Color(hex).lerp(new THREE.Color(target), t).getStyle();
}

/** 程序化生成行星表面贴图(canvas → CanvasTexture)。 */
export function makePlanetTexture(kind: PlanetKind, hex: string): THREE.CanvasTexture {
  const s = 512;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d')!;
  const rnd = () => Math.random();

  if (kind === 'gas' || kind === 'swirl') {
    x.fillStyle = mix(hex, '#000000', 0.5);
    x.fillRect(0, 0, s, s);
    let y = 0;
    while (y < s) {
      const h = 10 + rnd() * 38;
      x.globalAlpha = 0.55 + rnd() * 0.45;
      x.fillStyle = mix(hex, rnd() > 0.5 ? '#ffffff' : '#000000', 0.12 + rnd() * 0.38);
      if (kind === 'swirl') {
        x.save();
        x.translate(s / 2, s / 2);
        x.rotate((y / s) * 0.6);
        x.fillRect(-s, y - s / 2, s * 2, h);
        x.restore();
      } else {
        x.fillRect(0, y, s, h);
      }
      // 带内细纹,柔化条带边界
      x.globalAlpha = 0.18;
      x.fillStyle = mix(hex, '#ffffff', 0.3);
      x.fillRect(0, y + h * 0.35, s, Math.max(1.5, h * 0.12));
      x.globalAlpha = 1;
      y += h * (0.72 + rnd() * 0.28);
    }
  } else if (kind === 'rock') {
    x.fillStyle = mix(hex, '#000000', 0.42);
    x.fillRect(0, 0, s, s);
    for (let i = 0; i < 150; i++) {
      const r = 3 + rnd() * 18;
      const px = rnd() * s;
      const py = rnd() * s;
      x.beginPath();
      x.arc(px, py, r, 0, Math.PI * 2);
      x.fillStyle = mix(hex, '#000000', 0.5 + rnd() * 0.3);
      x.fill();
      x.globalAlpha = 0.45;
      x.lineWidth = 1;
      x.strokeStyle = mix(hex, '#ffffff', 0.25);
      x.stroke();
      // 环形山内侧高光
      x.beginPath();
      x.arc(px - r * 0.2, py - r * 0.2, r * 0.55, 0, Math.PI * 2);
      x.fillStyle = mix(hex, '#ffffff', 0.08);
      x.fill();
      x.globalAlpha = 1;
    }
  } else if (kind === 'ocean') {
    x.fillStyle = mix(hex, '#06203f', 0.35);
    x.fillRect(0, 0, s, s);
    for (let i = 0; i < 24; i++) {
      x.beginPath();
      const px = rnd() * s;
      const py = rnd() * s;
      x.fillStyle = mix(hex, rnd() > 0.5 ? '#3a7d44' : '#caa66a', 0.5);
      const pts = 10;
      for (let a = 0; a < pts; a++) {
        const ang = (a / pts) * Math.PI * 2;
        const rr = 20 + rnd() * 48;
        const lx = px + Math.cos(ang) * rr;
        const ly = py + Math.sin(ang) * rr;
        a === 0 ? x.moveTo(lx, ly) : x.lineTo(lx, ly);
      }
      x.closePath();
      x.globalAlpha = 0.9;
      x.fill();
      // 大陆边缘浅滩
      x.globalAlpha = 0.3;
      x.lineWidth = 3;
      x.strokeStyle = mix(hex, '#ffffff', 0.35);
      x.stroke();
      x.globalAlpha = 1;
    }
    // 云带
    for (let i = 0; i < 8; i++) {
      x.globalAlpha = 0.1 + rnd() * 0.1;
      x.fillStyle = '#ffffff';
      const cy = rnd() * s;
      x.fillRect(0, cy, s, 4 + rnd() * 10);
      x.globalAlpha = 1;
    }
  } else if (kind === 'ice') {
    x.fillStyle = mix(hex, '#ffffff', 0.55);
    x.fillRect(0, 0, s, s);
    x.strokeStyle = mix(hex, '#5b8bd8', 0.4);
    for (let i = 0; i < 52; i++) {
      x.beginPath();
      x.globalAlpha = 0.4 + rnd() * 0.6;
      x.lineWidth = 0.8 + rnd() * 1.4;
      let px = rnd() * s;
      let py = rnd() * s;
      x.moveTo(px, py);
      for (let k = 0; k < 5; k++) {
        px += (rnd() - 0.5) * 90;
        py += (rnd() - 0.5) * 90;
        x.lineTo(px, py);
      }
      x.stroke();
      x.globalAlpha = 1;
    }
  } else if (kind === 'lava') {
    x.fillStyle = mix(hex, '#000000', 0.78);
    x.fillRect(0, 0, s, s);
    for (let i = 0; i < 76; i++) {
      x.beginPath();
      x.globalAlpha = 0.6 + rnd() * 0.4;
      x.lineWidth = 1 + rnd() * 3.6;
      x.strokeStyle = rnd() > 0.5 ? mix(hex, '#ffb84d', 0.6) : '#ff5a2c';
      let px = rnd() * s;
      let py = rnd() * s;
      x.moveTo(px, py);
      for (let k = 0; k < 6; k++) {
        px += (rnd() - 0.5) * 66;
        py += (rnd() - 0.5) * 66;
        x.lineTo(px, py);
      }
      x.stroke();
      x.globalAlpha = 1;
    }
  } else {
    // metal
    const grad = x.createLinearGradient(0, 0, s, s);
    grad.addColorStop(0, mix(hex, '#ffffff', 0.3));
    grad.addColorStop(0.5, mix(hex, '#000000', 0.35));
    grad.addColorStop(1, mix(hex, '#ffffff', 0.15));
    x.fillStyle = grad;
    x.fillRect(0, 0, s, s);
    x.strokeStyle = mix(hex, '#000000', 0.5);
    for (let i = 0; i < 84; i++) {
      x.beginPath();
      x.globalAlpha = 0.35 + rnd() * 0.5;
      x.lineWidth = 0.6;
      const y = rnd() * s;
      x.moveTo(0, y);
      x.lineTo(s, y + (rnd() - 0.5) * 14);
      x.stroke();
      x.globalAlpha = 1;
    }
  }

  // 两极暗角:等距圆柱投影下上下边缘是极区,压暗以增强球体感
  const pole = x.createLinearGradient(0, 0, 0, s);
  pole.addColorStop(0, 'rgba(0,0,0,0.34)');
  pole.addColorStop(0.22, 'rgba(0,0,0,0)');
  pole.addColorStop(0.78, 'rgba(0,0,0,0)');
  pole.addColorStop(1, 'rgba(0,0,0,0.34)');
  x.fillStyle = pole;
  x.fillRect(0, 0, s, s);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
