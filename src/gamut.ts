// gamut.ts — sRGB ⇄ Display P3
//
// The shader's ~60 color literals are hand-tuned sRGB-encoded values, composited
// in that same gamma-encoded space (there is no linear-light stage anywhere).
// So going wide gamut is a single conversion at the very end of the shader:
// decode with the sRGB transfer function, change primaries, re-encode. Display
// P3 shares sRGB's transfer function and white point (D65), so the only thing
// that actually differs is the RGB primaries — one 3×3 matrix, no white-point
// adaptation.
//
// The matrix lives here rather than as a GLSL literal so that the numbers the
// tests check are the numbers that ship: renderer.ts interpolates these
// constants into the fragment shader source.

/**
 * Which color space to render into.
 *
 * - `'auto'` … Display P3 where the browser supports it, sRGB otherwise (default)
 * - `'srgb'` … always sRGB
 * - `'display-p3'` … request Display P3; silently falls back to sRGB if unsupported
 *
 * On an sRGB display the P3 path is indistinguishable from the sRGB one — the
 * conversion is appearance-preserving. What P3 buys is the light sources (sun,
 * moon, stars, lightning) and the magic-hour amber reaching colors sRGB cannot
 * express; see `GAMUT_REACH` in renderer.ts.
 */
export type ColorSpaceOption = 'auto' | 'srgb' | 'display-p3';

/**
 * linear sRGB → linear Display P3, row-major.
 *
 * Derived from the two sets of primaries (sRGB R 0.640,0.330 / G 0.300,0.600 /
 * B 0.150,0.060 — P3 R 0.680,0.320 / G 0.265,0.690 / B 0.150,0.060) against a
 * shared D65 white. Every row sums to 1, i.e. neutrals map to themselves: this
 * is why marking a near-white highlight for gamut expansion is a no-op rather
 * than a hazard.
 *
 * sRGB's gamut is a strict subset of P3's, so an in-range input always yields
 * an in-range output — no gamut clipping is needed on this direction.
 */
export const SRGB_TO_DISPLAY_P3 = [
  0.82246197, 0.17753803, 0.00000000,
  0.03319420, 0.96680580, 0.00000000,
  0.01708263, 0.07239744, 0.91051993,
] as const;

/** linear Display P3 → linear sRGB, row-major. The inverse of {@link SRGB_TO_DISPLAY_P3} */
export const DISPLAY_P3_TO_SRGB = [
   1.22494017, -0.22494017,  0.00000000,
  -0.04205696,  1.04205696,  0.00000000,
  -0.01963755, -0.07863604,  1.09827360,
] as const;

/** the sRGB transfer function, decode (also Display P3's) */
export function transferDecode(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** the sRGB transfer function, encode (also Display P3's) */
export function transferEncode(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

export type Rgb = readonly [number, number, number];

/**
 * Convert an encoded color between the two spaces: decode → matrix → encode.
 *
 * The reference implementation of what the shader does. Tests compare against
 * it, and the verification pass converts a P3 framebuffer back to sRGB with it
 * to prove the palette didn't shift.
 */
function convert(m: readonly number[], c: Rgb): [number, number, number] {
  const l = [transferDecode(c[0]), transferDecode(c[1]), transferDecode(c[2])];
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    out.push(transferEncode(m[i * 3] * l[0] + m[i * 3 + 1] * l[1] + m[i * 3 + 2] * l[2]));
  }
  return [out[0], out[1], out[2]];
}

/** an sRGB-encoded color → the Display P3-encoded color that looks the same */
export function srgbToDisplayP3(c: Rgb): [number, number, number] {
  return convert(SRGB_TO_DISPLAY_P3, c);
}

/**
 * a Display P3-encoded color → the sRGB-encoded color that looks the same.
 *
 * Components outside 0..1 mean the color is outside sRGB's gamut and genuinely
 * cannot be shown there — that's the point of the wide-gamut path, and this
 * function reports it rather than clipping.
 */
export function displayP3ToSrgb(c: Rgb): [number, number, number] {
  return convert(DISPLAY_P3_TO_SRGB, c);
}

/**
 * `SRGB_TO_DISPLAY_P3` as a GLSL `mat3` constructor.
 *
 * GLSL's `mat3(...)` takes columns, so the row-major constants are transposed
 * here — `M * v` then means the matrix as written above.
 */
export function glslMat3(m: readonly number[]): string {
  const col = (j: number) => [m[j], m[j + 3], m[j + 6]].map((v) => v.toFixed(8)).join(', ');
  return `mat3(${col(0)},\n       ${col(1)},\n       ${col(2)})`;
}
