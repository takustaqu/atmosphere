import { describe, expect, it } from 'vitest';
import {
  DISPLAY_P3_TO_SRGB,
  SRGB_TO_DISPLAY_P3,
  displayP3ToSrgb,
  glslMat3,
  srgbToDisplayP3,
  transferDecode,
  transferEncode,
  type Rgb,
} from '../src/gamut.js';

/** the actual literals the shader is tuned with — the palette this must not shift */
const SHADER_LITERALS: Rgb[] = [
  [0.10, 0.34, 0.74],     // day zenith
  [0.66, 0.83, 0.96],     // day horizon
  [0.010, 0.018, 0.048],  // night zenith
  [1.0, 0.47, 0.22],      // magic hour warm
  [0.45, 0.28, 0.45],     // magic hour mauve
  [0.93, 0.95, 1.0],      // moon disc
  [0.4, 0.5, 0.7],        // moon glow
  [0.8, 0.88, 1.0],       // cool star
  [1.0, 0.93, 0.85],      // warm star
  [0.16, 0.18, 0.21],     // leaden grey
];

const mul = (m: readonly number[], v: Rgb): Rgb => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];

describe('gamut matrices', () => {
  it('maps neutrals to themselves (every row sums to 1)', () => {
    // this is what makes marking a near-white highlight for widening a no-op
    for (const m of [SRGB_TO_DISPLAY_P3, DISPLAY_P3_TO_SRGB]) {
      for (let row = 0; row < 3; row++) {
        expect(m[row * 3] + m[row * 3 + 1] + m[row * 3 + 2]).toBeCloseTo(1, 7);
      }
    }
  });

  it('are inverses of each other', () => {
    for (let i = 0; i < 3; i++) {
      const basis: Rgb = [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
      const back = mul(DISPLAY_P3_TO_SRGB, mul(SRGB_TO_DISPLAY_P3, basis));
      expect(back[0]).toBeCloseTo(basis[0], 7);
      expect(back[1]).toBeCloseTo(basis[1], 7);
      expect(back[2]).toBeCloseTo(basis[2], 7);
    }
  });

  it('has no blue leak into red or green (both spaces share the sRGB blue primary)', () => {
    expect(SRGB_TO_DISPLAY_P3[2]).toBe(0);
    expect(SRGB_TO_DISPLAY_P3[5]).toBe(0);
  });
});

describe('transfer function', () => {
  it('round-trips across the piecewise knee', () => {
    // 7 digits, not more: the standard's two knee constants (0.04045 encoded,
    // 0.0031308 linear) are rounded and aren't exact reciprocals, so a value
    // landing between them takes the linear branch one way and the power branch
    // the other. The resulting ~3e-8 error is 1e-5 of one 8-bit step
    for (const v of [0, 0.001, 0.0031308, 0.004, 0.04045, 0.05, 0.5, 1, 1.1]) {
      expect(transferEncode(transferDecode(v))).toBeCloseTo(v, 7);
    }
  });

  it('is continuous at the knee', () => {
    expect(transferEncode(0.0031308)).toBeCloseTo(0.04045, 5);
  });
});

describe('srgbToDisplayP3', () => {
  it('leaves white and black alone', () => {
    for (const v of srgbToDisplayP3([1, 1, 1])) expect(v).toBeCloseTo(1, 12);
    expect(srgbToDisplayP3([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('keeps greys neutral', () => {
    for (const g of [0.05, 0.25, 0.5, 0.75]) {
      const [r, gg, b] = srgbToDisplayP3([g, g, g]);
      expect(r).toBeCloseTo(g, 6);
      expect(gg).toBeCloseTo(g, 6);
      expect(b).toBeCloseTo(g, 6);
    }
  });

  it('pulls each sRGB primary inside P3', () => {
    // sRGB's gamut is a strict subset of P3's, so a saturated sRGB color needs
    // less purity to look the same there: the peak drops below 1 and the other
    // two channels lift off 0
    const red = srgbToDisplayP3([1, 0, 0]);
    expect(red[0]).toBeCloseTo(0.917488, 5);
    expect(red[1]).toBeCloseTo(0.200287, 5);
    expect(red[2]).toBeCloseTo(0.138561, 5);

    const green = srgbToDisplayP3([0, 1, 0]);
    expect(green[0]).toBeCloseTo(0.458402, 5);
    expect(green[1]).toBeCloseTo(0.985265, 5);
    expect(green[2]).toBeCloseTo(0.298295, 5);

    // both spaces share the blue primary, so blue only moves via the matrix's
    // third row (the green/red terms feeding into it are zero for pure blue)
    const blue = srgbToDisplayP3([0, 0, 1]);
    expect(blue[0]).toBeCloseTo(0, 6);
    expect(blue[1]).toBeCloseTo(0, 6);
    expect(blue[2]).toBeCloseTo(0.959588, 5);
  });

  it('round-trips every shader literal', () => {
    for (const c of SHADER_LITERALS) {
      const back = displayP3ToSrgb(srgbToDisplayP3(c));
      expect(back[0]).toBeCloseTo(c[0], 6);
      expect(back[1]).toBeCloseTo(c[1], 6);
      expect(back[2]).toBeCloseTo(c[2], 6);
    }
  });

  it('stays in range for in-gamut input', () => {
    for (const c of SHADER_LITERALS) {
      for (const v of srgbToDisplayP3(c)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('displayP3ToSrgb', () => {
  it('reports out-of-sRGB colors instead of clipping them', () => {
    // P3's own red primary is exactly what sRGB cannot reach — the inverse must
    // come back over 1, or the wide-gamut verification pass can't tell the
    // difference between "widened" and "unchanged"
    const [r, g, b] = displayP3ToSrgb([1, 0, 0]);
    expect(r).toBeGreaterThan(1);
    expect(g).toBeLessThan(0);
    expect(b).toBeLessThan(0);
  });
});

describe('glslMat3', () => {
  it('emits the matrix transposed, since GLSL mat3() takes columns', () => {
    const src = glslMat3([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // first constructor argument is column 0 = (m00, m10, m20) = 1, 4, 7
    expect(src.startsWith('mat3(1.00000000, 4.00000000, 7.00000000,')).toBe(true);
    expect(src.replace(/\s+/g, ' ')).toBe(
      'mat3(1.00000000, 4.00000000, 7.00000000, 2.00000000, 5.00000000, 8.00000000,'
      + ' 3.00000000, 6.00000000, 9.00000000)',
    );
  });
});
