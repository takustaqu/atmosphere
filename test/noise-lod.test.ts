import { describe, expect, it } from 'vitest';
import baselineGlsl from './fixtures/frag-baseline.glsl?raw';
import baselineNoLodGlsl from './fixtures/frag-baseline-nolod.glsl?raw';
import { NOISE_SIZE, noiseLattice, noiseMoments } from '../src/noise';
import { fragSource, noisePixelAngle, resolveNoiseLod } from '../src/renderer';

const FIXTURES: Record<string, string> = {
  'frag-baseline.glsl': baselineGlsl,
  'frag-baseline-nolod.glsl': baselineNoLodGlsl,
};
const fixture = (name: string) => FIXTURES[name]!;

/**
 * Preprocess the NOISE_LOD conditionals the way the GLSL compiler does when
 * NOISE_LOD is *not* defined: drop `#ifdef NOISE_LOD` bodies, keep `#else`
 * bodies. Nesting is not allowed (the variant never nests), so reject it.
 */
function withoutNoiseLod(src: string): string {
  const out: string[] = [];
  let state: 'none' | 'if' | 'else' = 'none';
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (t === '#ifdef NOISE_LOD') {
      if (state !== 'none') throw new Error('nested #ifdef NOISE_LOD');
      state = 'if';
      continue;
    }
    if (t === '#else' && state === 'if') { state = 'else'; continue; }
    if (t === '#endif' && state !== 'none') { state = 'none'; continue; }
    if (state === 'if') continue;
    out.push(line);
  }
  if (state !== 'none') throw new Error('unterminated #ifdef NOISE_LOD');
  return out.join('\n');
}

describe('noise LOD: off is the shader as it always was', () => {
  // The fixtures are fragSource() frozen just before the variant went in: 0.3.1
  // plus two equal-output savings outside the variant (the cumulonimbus's
  // anvilTop computed only in tower columns, the veil gated on massE > 0.50;
  // a GPU readback diff against 0.3.1 was zero). Equal preprocessed text means
  // the compiler sees the same token stream, so the same program.
  it('with the explicit-LOD extension', () => {
    expect(withoutNoiseLod(fragSource(true, false))).toBe(fixture('frag-baseline.glsl'));
  });
  it('without it', () => {
    expect(withoutNoiseLod(fragSource(false, false))).toBe(fixture('frag-baseline-nolod.glsl'));
  });
  it('the default is off, and off defines nothing', () => {
    expect(fragSource(true)).toBe(fragSource(true, false));
    expect(fragSource(true, false)).not.toMatch(/#define NOISE_LOD/);
  });
  it('none of the variant survives preprocessing', () => {
    const off = withoutNoiseLod(fragSource(true, false));
    const on = fragSource(true, true);
    for (const word of ['fbmL', 'vnoiseL', 'lodVar', 'cloudVar', 'lodLevel', 'lodStep', 'lodLow', 'lodPlaneAt',
      'LOD_START', 'LOD_STEP', 'LOD_TOP', 'u_noiseLod', 'NOISE_MEAN', 'NOISE_VAR']) {
      expect(on).toContain(word);   // keeps this list from going stale when something is renamed
      expect(off).not.toContain(word);
    }
  });
});

describe('noise LOD: on', () => {
  it('defines the variant right after the extension preamble', () => {
    const src = fragSource(true, true);
    const lines = src.split('\n');
    expect(lines[0]).toBe('#extension GL_EXT_shader_texture_lod : enable');
    expect(lines[2]).toBe('#define NOISE_LOD');
    expect(lines[3]).toBe('#define NOISE_MEAN 0.4976296');
    expect(lines[4]).toBe('#define NOISE_VAR 0.0460056');
  });
});

describe('noiseMoments', () => {
  it('matches the lattice', () => {
    const m = noiseMoments();
    expect(m.mean).toBeCloseTo(8316227 / (255 * 65536), 9);
    expect(m.variance).toBeCloseTo(0.0460056, 6);
  });
  it('is memoized', () => {
    expect(noiseMoments()).toBe(noiseMoments());
  });
});

describe('resolveNoiseLod', () => {
  it('is off unless asked for', () => {
    expect(resolveNoiseLod(undefined, true)).toEqual({ active: false, bias: 0 });
    expect(resolveNoiseLod(false, true)).toEqual({ active: false, bias: 0 });
  });
  it('true and {} both mean bias 0', () => {
    expect(resolveNoiseLod(true, true)).toEqual({ active: true, bias: 0 });
    expect(resolveNoiseLod({}, true)).toEqual({ active: true, bias: 0 });
  });
  it('needs the explicit-LOD extension', () => {
    expect(resolveNoiseLod(true, false).active).toBe(false);
  });
  it('clamps the bias: NaN reads as 0, the top is 8, -Infinity is allowed', () => {
    expect(resolveNoiseLod({ bias: Number.NaN }, true).bias).toBe(0);
    expect(resolveNoiseLod({ bias: 20 }, true).bias).toBe(8);
    expect(resolveNoiseLod({ bias: -Infinity }, true).bias).toBe(-Infinity);
  });
});

describe('noisePixelAngle', () => {
  it('is the image-centre pixel angle', () => {
    const fov = (48 * Math.PI) / 180;
    expect(noisePixelAngle(fov, 1080, 0)).toBeCloseTo(8.245e-4, 6);
    expect(noisePixelAngle(fov, 1080, 1)).toBeCloseTo(2 * noisePixelAngle(fov, 1080, 0), 12);
    expect(noisePixelAngle(fov, 1080, -Infinity)).toBe(0);
  });
});

// ── the shader's math, ported to check its claims ──────────────────────
// (kept in step with FRAG by the constants test below)

const LOD_START = Math.log2(1.53), LOD_STEP = Math.log2(2.03);
const lodLevel = (F: number) => Math.log2(Math.max(F, 1e-6)) - LOD_START;

// the lattice and its mipmaps, as generateMipmap builds them (2x2 box, 8-bit per level)
const lattice = noiseLattice();
const mips: Float32Array[] = [];
{
  let size = NOISE_SIZE;
  let cur = Float32Array.from(lattice, (v) => v / 255);
  mips.push(cur);
  while (size > 1) {
    const n = size / 2, next = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const s = cur[2 * y * size + 2 * x]! + cur[2 * y * size + 2 * x + 1]!
        + cur[(2 * y + 1) * size + 2 * x]! + cur[(2 * y + 1) * size + 2 * x + 1]!;
      next[y * n + x] = Math.round((s / 4) * 255) / 255;
    }
    mips.push(next); cur = next; size = n;
  }
}
// LINEAR sampling of one level at normalized uv, REPEAT wrap
function bilinear(level: number, u: number, v: number): number {
  const size = NOISE_SIZE >> level, m = mips[level]!;
  const x = u * size - 0.5, y = v * size - 0.5;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const at = (a: number, b: number) => m[(((b % size) + size) % size) * size + (((a % size) + size) % size)]!;
  return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy)
    + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
}
// texture2DLodEXT with LINEAR_MIPMAP_LINEAR
function sampleLod(u: number, v: number, lod: number): number {
  if (lod <= 0) return bilinear(0, u, v);
  const top = mips.length - 1, k = Math.min(Math.floor(lod), top), t = Math.min(lod, top) - k;
  return t > 0 && k < top ? bilinear(k, u, v) * (1 - t) + bilinear(k + 1, u, v) * t : bilinear(k, u, v);
}
const sstep = (f: number) => f * f * (3 - 2 * f);
function vnoiseL(px: number, py: number, l: number): number {
  const ix = Math.floor(px), iy = Math.floor(py);
  return sampleLod((ix + sstep(px - ix) + 0.5) / NOISE_SIZE, (iy + sstep(py - iy) + 0.5) / NOISE_SIZE, l);
}
function fbmL(px: number, py: number, l: number, keep0: number): number {
  let v = 0, a = 0.5;
  for (let i = 0; i < 5; i++) {
    let li = Math.min(Math.max(l, 0), 8);
    if (i === 0) li *= 1 - keep0;
    v += a * vnoiseL(px, py, li);
    px = px * 2.03 + 17.3; py = py * 2.03 + 9.1;
    a *= 0.5; l += LOD_STEP;
  }
  return v;
}
const { variance: VAR } = noiseMoments();
function lodVar(l: number, keep0: number): number {
  let s = 0, w = 0.25;
  for (let i = 0; i < 5; i++) {
    let li = Math.min(Math.max(l, 0), 8);
    if (i === 0) li *= 1 - keep0;
    s += w * (1 - 2 ** (-2 * li));
    w *= 0.25; l += LOD_STEP;
  }
  return VAR * s;
}
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const lodStep = (e0: number, e1: number, x: number, s2: number) => {
  if (s2 <= 0) return smooth(e0, e1, x);
  const c = 0.5 * (e0 + e1), h = 0.5 * Math.sqrt((e1 - e0) ** 2 + 20 * s2);
  return smooth(c - h, c + h, x);
};
const moments = (f: (x: number, y: number) => number) => {
  const N = 40000;
  let s = 0, q = 0;
  for (let i = 0; i < N; i++) {
    const x = ((i * 0.6180339887) % 1) * 250, y = ((i * 0.7548776662) % 1) * 250;
    const v = f(x, y); s += v; q += v * v;
  }
  return { mean: s / N, variance: q / N - (s / N) ** 2 };
};

describe('fbmL', () => {
  it('far below level 0 reads level 0 throughout, which is fbm', () => {
    for (let i = 0; i < 100; i++) {
      const x = i * 1.37, y = i * 0.71;
      let v = 0, a = 0.5, px = x, py = y;
      for (let k = 0; k < 5; k++) { v += a * vnoiseL(px, py, 0); px = px * 2.03 + 17.3; py = py * 2.03 + 9.1; a *= 0.5; }
      expect(fbmL(x, y, -20, 0)).toBe(v);
    }
  });
  it('leaves an octave alone up to 1.53 lattice cells a pixel', () => {
    expect(lodLevel(1.53)).toBeCloseTo(0, 12);
    expect(lodLevel(1.0)).toBeLessThan(0);
  });
  it('never exceeds FBM_MAX, so cloudField\'s early out stays exact', () => {
    for (let i = 0; i < 2000; i++) {
      expect(fbmL(i * 0.913, i * 0.377, -1 + i * 0.004, 0)).toBeLessThanOrEqual(0.96875);
    }
  });
  it('keeps the mean, and takes out about the variance lodVar says', () => {
    const base = moments((x, y) => fbmL(x, y, -20, 0));
    for (const l of [0.5, 1.5, 3]) {
      const m = moments((x, y) => fbmL(x, y, l, 1));
      expect(Math.abs(m.mean - base.mean)).toBeLessThan(0.004);
      const lost = base.variance - m.variance;
      // the 4^-level rule is the texel average's. Below level 1 the real loss
      // runs up to ~10% over it (the ramps widen a little short); above, ±1%
      expect(lost / lodVar(l, 1)).toBeGreaterThan(0.9);
      expect(lost / lodVar(l, 1)).toBeLessThan(1.15);
    }
    const m = moments((x, y) => fbmL(x, y, 0.5, 0));
    const lost0 = base.variance - m.variance;
    expect(lost0 / lodVar(0.5, 0)).toBeGreaterThan(0.9);
    expect(lost0 / lodVar(0.5, 0)).toBeLessThan(1.15);
  });
});

describe('lodStep', () => {
  it('is smoothstep when nothing was filtered', () => {
    for (let x = -0.2; x < 1.2; x += 0.01) expect(lodStep(0.3, 0.6, x, 0)).toBe(smooth(0.3, 0.6, x));
  });
  it('matches smoothstep averaged over the variance that was taken out', () => {
    const s2 = 0.004, sd = Math.sqrt(s2);
    for (let x = 0; x < 1; x += 0.02) {
      let e = 0;
      const K = 400;
      for (let k = 0; k < K; k++) {
        // a gaussian by inverse CDF on a regular grid
        const u = (k + 0.5) / K;
        const z = Math.SQRT2 * erfinv(2 * u - 1);
        e += smooth(0.4, 0.55, x + z * sd);
      }
      expect(Math.abs(lodStep(0.4, 0.55, x, s2) - e / K)).toBeLessThan(0.035);
    }
  });
});

describe('FRAG and this port agree', () => {
  it('on the constants', () => {
    const src = fragSource(true, true);
    for (const c of ['LOD_START = 0.6135', 'LOD_STEP = 1.0215', 'LOD_TOP = 8.0', 'lB + 0.6781', 'lB + 1.7225',
      'l + 1.7225 + 4.0 * LOD_STEP <= 0.0', 'max(F, 1.0 / 4096.0)', 'exp2(-2.0 * li)', '20.0 * s2', '4.84', '0.5184', '0.0784']) {
      expect(src).toContain(c);
    }
    expect(Math.log2(1.53)).toBeCloseTo(0.6135, 4);
    expect(Math.log2(2.03)).toBeCloseTo(1.0215, 4);
    expect(Math.log2(1.6)).toBeCloseTo(0.6781, 4);
    expect(Math.log2(3.3)).toBeCloseTo(1.7225, 4);
    expect((2.2 * 0.72) ** 2).toBeCloseTo(4.84 * 0.5184, 10);
    expect((2.2 * 0.28) ** 2).toBeCloseTo(4.84 * 0.0784, 10);
  });
});

// Giles' single-precision approximation, plenty for a test's gaussian
function erfinv(x: number): number {
  let w = -Math.log((1 - x) * (1 + x)), p: number;
  if (w < 5) {
    w -= 2.5;
    p = 2.81022636e-8;
    for (const c of [3.43273939e-7, -3.5233877e-6, -4.39150654e-6, 0.00021858087, -0.00125372503, -0.00417768164, 0.246640727, 1.50140941]) p = c + p * w;
  } else {
    w = Math.sqrt(w) - 3;
    p = -0.000200214257;
    for (const c of [0.000100950558, 0.00134934322, -0.00367342844, 0.00573950773, -0.0076224613, 0.00943887047, 1.00167406, 2.83297682]) p = c + p * w;
  }
  return p * x;
}
