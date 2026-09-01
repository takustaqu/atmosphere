// noise.ts — the value-noise lattice, baked once on the CPU
//
// Every cloud, every dust lane and every fray in this renderer bottoms out in
// `vnoise`, and `vnoise` used to bottom out in four `hash12` calls. That is
// fine arithmetic and disastrous compilation: `fbm` inlines five `vnoise`,
// each inlines four `hash12`, and the shader calls `fbm` from several dozen
// places. Windows' ANGLE hands the result to the D3D compiler, which inlines
// and unrolls everything — measured at 19 s of frozen main thread to link the
// program on a Radeon 780M, against 2.4 s once `vnoise` became a texture fetch.
//
// So the lattice is generated here instead, uploaded as a small tiling
// texture, and the GPU's own bilinear filter does the interpolation. See
// `vnoise` in renderer.ts for why the filter reproduces the old arithmetic
// exactly rather than approximating it.

/**
 * Side length of the lattice texture, in texels — and therefore the period at
 * which the noise repeats, in lattice units.
 *
 * The old hash never repeated. This one does, so the number has to be past the
 * point where a repeat could land twice on screen. The coarse octaves — the
 * only ones whose repetition the eye could name — run at a few dozen lattice
 * units across a frame, an order of magnitude inside 256; the octaves that do
 * wrap within a frame are the fine ones near the horizon, where `horizonFade`
 * and the widened density ramp have already dissolved them into haze.
 *
 * 256 also keeps the whole lattice at 64 KB, small enough to stay resident in
 * the texture cache through the fetch-heavy fbm chains.
 */
export const NOISE_SIZE = 256;

const f = Math.fround;
const K = f(0.1031);
const C = f(33.33);
const fract = (x: number): number => f(x - Math.floor(x));

/**
 * `hash12` from the shader, evaluated in float32.
 *
 * Ported operation for operation, and rounded to float32 at each step, so the
 * baked lattice carries the same values the shader used to compute — the sky
 * keeps the exact noise field it was hand-tuned against, rather than a
 * different draw from the same distribution. (GPUs may contract a multiply-add
 * differently, so the last bit or two can disagree; the 8-bit texture quantizes
 * far more than that anyway.)
 */
export function hash12(x: number, y: number): number {
  // p3 = fract(vec3(p.xyx) * 0.1031) — the third component is x again
  let a = fract(f(x * K));
  let b = fract(f(y * K));
  let c = a;
  // dot(p3, p3.yzx + 33.33)
  const d = f(f(f(a * f(b + C)) + f(b * f(c + C))) + f(c * f(a + C)));
  a = f(a + d);
  b = f(b + d);
  c = f(c + d);
  return fract(f(f(a + b) * c));
}

let cached: Uint8Array | null = null;

/**
 * The lattice as 8-bit luminance texels, row-major from (0,0).
 *
 * 8 bits is enough because these are the *endpoints* the filter interpolates
 * between, not the interpolated result: quantizing them perturbs a random
 * value by up to 1/512, which is another equally random value. What would show
 * as banding is coarse interpolation, and that is the sampler's job, at higher
 * precision than the texels it reads.
 *
 * Memoized — one lattice serves every renderer on the page.
 */
export function noiseLattice(): Uint8Array {
  if (cached) return cached;
  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE);
  for (let y = 0; y < NOISE_SIZE; y++) {
    for (let x = 0; x < NOISE_SIZE; x++) {
      data[y * NOISE_SIZE + x] = Math.round(hash12(x, y) * 255);
    }
  }
  cached = data;
  return data;
}
