// lens.ts — what happens on the glass, not in the sky
//
// The renderer draws everything along view rays except a handful of things that
// belong to the camera rather than to the scene: raindrops sitting on the front
// element, the flare, the vignette. Those are a choice about the picture — a sky
// behind a UI may want rain without water on an imaginary lens — so they get an
// axis of their own instead of riding the weather.
//
// Only the droplets are switchable for now. They are the one lens effect that
// changes with the weather, and the one that distorts the sky behind it.

export interface Lens {
  /**
   * 0..1 how strongly raindrops collect on the lens while it rains.
   *
   * 1 (the default) is the full effect; 0 turns it off. The droplets follow the
   * rain on their own, so this is a ceiling rather than an amount: at any value
   * a dry sky shows none.
   */
  droplets: number;
}

/**
 * A lens specification.
 * - `{ droplets: false }`   … no droplets on the lens, whatever the weather
 * - `{ droplets: 0.4 }`     … fainter, fewer-looking droplets
 * - `null` / omitted        … the defaults (droplets on)
 */
export type LensInput =
  | { droplets?: boolean | number }
  | null
  | undefined;

export const DEFAULT_LENS: Lens = { droplets: 1 };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Resolve a lens specification */
export function resolveLens(input: LensInput): Lens {
  const d = input?.droplets;
  return {
    droplets: d == null ? DEFAULT_LENS.droplets : typeof d === 'boolean' ? (d ? 1 : 0) : clamp01(d),
  };
}
