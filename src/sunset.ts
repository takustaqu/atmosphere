// sunset.ts — how hard the sky burns
//
// The colors of a sunset are a chain of physics the renderer only sketches —
// how much aerosol is in the air, how far the light has come, what it has
// been scattered off — and two skies at the same hour can differ by a lot.
// Rather than pretend to compute that, this axis says how much: how strong
// and how red the band on the sun's side is, and how much of the glow the
// rest of the sky takes at magic hour. Both are 1 by default, which is the
// sunset the renderer draws on its own.

export interface Sunset {
  /**
   * 0..2 how strong and how red the band on the sun's side is.
   *
   * 0 is no warmth at all — a sunset with the color drained out of it, the
   * sky's own gradient going to grey-blue; 1 is the default; 2 is a hard,
   * red, hazy sunset that climbs higher up the sky.
   */
  warmth: number;
  /**
   * 0..2 how much the rest of the sky takes of the glow at magic hour: the
   * pink of the far side and the lavender above the band.
   *
   * 0 leaves the sky away from the sun cold, which is closer to a clear
   * day's sunset; 1 is the default; 2 is the whole sky lit.
   */
  glow: number;
}

export const DEFAULT_SUNSET: Sunset = { warmth: 1, glow: 1 };

/**
 * A sunset specification.
 * - `{ warmth: 1.4 }`           … a redder, harder sunset
 * - `{ glow: 0.3 }`             … a magic hour that stays blue away from the sun
 * - `null` / omitted            … the defaults
 */
export type SunsetInput = Partial<Sunset> | null | undefined;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Resolve a sunset specification */
export function resolveSunset(input: SunsetInput): Sunset {
  return {
    warmth: clamp(input?.warmth ?? DEFAULT_SUNSET.warmth, 0, 2),
    glow: clamp(input?.glow ?? DEFAULT_SUNSET.glow, 0, 2),
  };
}
