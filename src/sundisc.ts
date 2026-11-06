// sundisc.ts — how big the sun is drawn, and how much it glares
//
// The sun the renderer draws is an overexposure, not a disc: a core several
// times the real sun's half a degree, blown flat white, with a bleed of light
// round it. That is deliberate — a sun you cannot look at is what the eye
// reports — and it stays the default. But an app that draws its own glare
// over the sky (streaks, a bloom, a flare of its own) wants the sun small and
// bare underneath, so both are adjustable here.
//
// Not part of the lens: the disc and its glare are drawn into the sky itself,
// so they are mirrored in the sea and baked into a skybox's faces as well,
// where the lens has no part.

export interface Sun {
  /**
   * The angular diameter, in degrees, of the sun's blown core: the part drawn
   * flat white, at full emission, before the tone curve.
   *
   * Defaults to {@link DEFAULT_SUN_DISC} (about 3.4°), the sun the renderer has
   * always drawn; the real sun is {@link TRUE_SUN_DISC} (0.53°). The soft edge
   * round the core scales with it, and it still blooms past it on screen: at
   * the default exposure what reads as white is about twice the diameter
   * given. 0.1..10.
   */
  disc: number;
  /**
   * 0..1 how much glare surrounds the sun: the wide bleed of light round the
   * disc, in the sky and in the sun's path on the sea.
   *
   * 1 (the default) is the glare the renderer has always drawn; 0 leaves the
   * disc bare against the sky. The sky's own brightening toward the sun and
   * the clouds lit through from behind are the air's, and stay.
   */
  glare: number;
}

/** The real sun's angular diameter, in degrees */
export const TRUE_SUN_DISC = 0.53;

// The core is exp(-θ²·900)·2.2 clamped to 1 (θ in radians), on the sea
// exp(-θ²·400)·2.2: flat where that reaches 1, which is ln 2.2 / 900 squared
// radians out. Drawn at another size, the falloff is scaled to put the flat
// edge there instead
const CORE_FALLOFF = 900;
const SEA_FALLOFF = 400;
const CORE_GAIN = 2.2;
// how far out the disc's limb is taken to be by the thin clouds' corona
const CORONA_LIMB = 0.035;

/** The diameter of the blown core the renderer has always drawn, in degrees (about 3.39) */
export const DEFAULT_SUN_DISC = 2 * Math.sqrt(Math.log(CORE_GAIN) / CORE_FALLOFF) * 180 / Math.PI;

export const DEFAULT_SUN: Sun = { disc: DEFAULT_SUN_DISC, glare: 1 };

/**
 * A sun specification.
 * - `{ disc: 0.53 }`            … the sun at its true size
 * - `{ glare: 0 }`              … the disc with no bleed round it
 * - `{ disc: 1, glare: 0.3 }`   … a small sun, a little glare, for drawing your own over it
 * - `null` / omitted            … the defaults (the big blown sun)
 */
export type SunInput = Partial<Sun> | null | undefined;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Resolve a sun specification */
export function resolveSun(input: SunInput): Sun {
  return {
    disc: clamp(input?.disc ?? DEFAULT_SUN.disc, 0.1, 10),
    glare: clamp(input?.glare ?? DEFAULT_SUN.glare, 0, 1),
  };
}

/**
 * What the shader takes of a sun: the core's falloff in the sky and on the
 * sea (the θ² coefficient), and the limb the thin clouds' corona is measured
 * from, in radians. At the default disc these are exactly the 900, 400 and
 * 0.035 the shader has always used
 */
export function sunShape(disc: number): [sky: number, sea: number, limb: number] {
  const r = DEFAULT_SUN_DISC / disc;
  return [CORE_FALLOFF * r * r, SEA_FALLOFF * r * r, CORONA_LIMB / r];
}
