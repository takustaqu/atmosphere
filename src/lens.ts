// lens.ts — what happens on the glass, not in the sky
//
// The renderer draws everything along view rays except a handful of things that
// belong to the camera rather than to the scene: raindrops sitting on the front
// element, the flare, the vignette. Those are a choice about the picture — a sky
// behind a UI may want rain without water on an imaginary lens — so they get an
// axis of their own instead of riding the weather.
//
// Each is switchable on its own. The droplets are the one that changes with
// the weather, and the one that distorts the sky behind it; the flare and the
// vignette are what an app that draws its own lens over the sky turns off.

export interface Lens {
  /**
   * 0..1 how strongly raindrops collect on the lens while it rains.
   *
   * 1 (the default) is the full effect; 0 turns it off. The droplets follow the
   * rain on their own, so this is a ceiling rather than an amount: at any value
   * a dry sky shows none.
   */
  droplets: number;
  /**
   * 0..1 how strong the lens flare is: the ghosts strung along the optical
   * axis, the faint ring and the horizontal streak, while the sun is in shot.
   *
   * 1 (the default) is the full effect; 0 turns it off, and the flare is then
   * not drawn at all.
   */
  flare: number;
  /**
   * 0..1 how strong the vignette is: the darkening toward the corners.
   *
   * 1 (the default) is the full effect; 0 leaves the corners as bright as the
   * middle.
   */
  vignette: number;
}

/**
 * A lens specification. Each field is a 0..1 strength or a boolean.
 * - `{ droplets: false }`              … no droplets on the lens, whatever the weather
 * - `{ droplets: 0.4 }`                … fainter, fewer-looking droplets
 * - `{ flare: false, vignette: false }` … none of the lens's own light, for an app that draws its own
 * - `null` / omitted                   … the defaults (all on)
 */
export type LensInput =
  | { droplets?: boolean | number; flare?: boolean | number; vignette?: boolean | number }
  | null
  | undefined;

export const DEFAULT_LENS: Lens = { droplets: 1, flare: 1, vignette: 1 };

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** a field given as a strength or as on / off, or left to its default */
const amount = (v: boolean | number | undefined, fallback: number): number =>
  v == null ? fallback : typeof v === 'boolean' ? (v ? 1 : 0) : clamp01(v);

/** Resolve a lens specification */
export function resolveLens(input: LensInput): Lens {
  return {
    droplets: amount(input?.droplets, DEFAULT_LENS.droplets),
    flare: amount(input?.flare, DEFAULT_LENS.flare),
    vignette: amount(input?.vignette, DEFAULT_LENS.vignette),
  };
}
