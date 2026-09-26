// particles.ts — the things drawn falling through the air
//
// Rain and snow do two things to a picture: they change the sky (the gloom of a
// rain cloud, the whiteout of heavy snow) and they put something in front of it
// (streaks, flakes). The first is the weather and stays with it. The second is
// a choice about the picture — a sky behind a UI may want a snowy day without
// flakes crossing the text — so it gets an axis of its own, the way the lens
// droplets did.

export interface Particles {
  /**
   * 0..1 how strongly the falling rain streaks and snowflakes are drawn.
   *
   * 1 (the default) is the full effect; 0 turns them off. They follow the
   * weather on their own, so this is a ceiling rather than an amount: at any
   * value a dry sky shows none. Turning them off leaves the weather's effect
   * on the sky itself alone — heavy snow still whites out the view.
   */
  precipitation: number;
}

/**
 * A particle specification.
 * - `{ precipitation: false }` … no falling rain or snow drawn, whatever the weather
 * - `{ precipitation: 0.4 }`   … fainter, sparser-looking rain and snow
 * - `null` / omitted           … the defaults (drawn)
 */
export type ParticlesInput =
  | { precipitation?: boolean | number }
  | null
  | undefined;

export const DEFAULT_PARTICLES: Particles = { precipitation: 1 };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Resolve a particle specification */
export function resolveParticles(input: ParticlesInput): Particles {
  const p = input?.precipitation;
  return {
    precipitation: p == null
      ? DEFAULT_PARTICLES.precipitation
      : typeof p === 'boolean' ? (p ? 1 : 0) : clamp01(p),
  };
}
