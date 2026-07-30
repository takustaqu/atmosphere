// polarizer.ts — circular polarizer (CPL) emulation
//
// Not a grade. A CPL is an optical filter that rejects light by its polarization,
// so it is a *transmission multiply on scene light* — which is only meaningful now
// that compositing happens in linear light. In gamma-encoded values the same
// multiply would be neither an exposure nor a transmission.
//
// The physics that gives a CPL its look:
//
//  1. Rayleigh-scattered skylight is partially polarized, most strongly at 90°
//     from the sun. Straight at the sun and straight away from it, barely at all.
//     Degree of polarization: sin²θ / (1 + cos²θ) for scattering angle θ.
//  2. Cloud light is scattered by droplets far larger than the wavelength (Mie),
//     and comes out essentially unpolarized. So is direct sunlight.
//  3. Therefore the filter darkens the sky and leaves the clouds alone — which is
//     the entire reason photographers carry one. Clouds "pop" because the sky
//     behind them dropped, not because the clouds got brighter.
//  4. Because the effect tracks the angle to the sun, a wide frame gets an uneven
//     band of darkening. That is a real and characterful artifact, not a bug, and
//     this reproduces it.
//
// The renderer gets this right structurally by applying the transmission to the
// sky gradient *before* the clouds, sun, moon and stars are composited over it.

export interface Polarizer {
  /**
   * 0..1 how much of the polarized component the filter rejects.
   *
   * 0 is no filter. 1 is a full physical polarizer, normalized so that
   * unpolarized light passes unchanged (a real one also eats ~1.3 stops overall —
   * see `stopLoss`).
   */
  strength: number;
  /**
   * filter rotation in radians.
   *
   * A real CPL is rotated in its mount to aim the effect, and 0 is roughly the
   * darkening orientation: measured on a clear noon sky facing away from the sun,
   * 0 drops the sky to ~62% and π/2 lifts it to ~126% of unfiltered.
   *
   * "Roughly" because there is no angle that darkens everywhere at once — the
   * polarization direction rotates across the frame and as the camera swings, so
   * the best setting shifts with the shot. That is not an approximation artifact;
   * it is the same reason you re-rotate the ring after recomposing, and the same
   * reason a wide frame gets an uneven band.
   */
  angle: number;
  /**
   * 0..1 extra saturation on the light that survives.
   *
   * A polarizer removes the multiply-scattered white veil along with the
   * polarized component, so what is left reads more saturated than the darkening
   * alone accounts for.
   */
  saturation: number;
  /**
   * 0..1 how much of the filter's real light loss to apply.
   *
   * A physical polarizer costs about 1.3 stops on *everything*, clouds included,
   * and photographers open up to compensate. Defaults to 0 because emulating the
   * loss without emulating the compensation just makes the picture dark; set it
   * to 1 with `tone.exposure` raised if the exposure trade matters to you.
   */
  stopLoss: number;
}

export type PolarizerId = 'none' | 'light' | 'strong' | 'crossed';

export interface PolarizerPreset extends Polarizer {
  /** display name */
  label: string;
}

export const POLARIZER_PRESETS: Record<PolarizerId, PolarizerPreset> = {
  none:    { label: 'None',        strength: 0.00, angle: 0, saturation: 0.00, stopLoss: 0 },
  light:   { label: 'Light CPL',   strength: 0.45, angle: 0, saturation: 0.20, stopLoss: 0 },
  strong:  { label: 'Strong CPL',  strength: 0.85, angle: 0, saturation: 0.40, stopLoss: 0 },
  // rotated off the darkening axis: the 90°-from-sun band brightens instead.
  // Mostly useful for seeing what the filter is actually keyed to
  crossed: { label: 'Crossed CPL', strength: 0.85, angle: Math.PI / 2, saturation: 0.10, stopLoss: 0 },
};

export const POLARIZER_IDS = Object.keys(POLARIZER_PRESETS) as PolarizerId[];

export function isPolarizerId(v: unknown): v is PolarizerId {
  return typeof v === 'string' && (POLARIZER_IDS as string[]).includes(v);
}

/**
 * A polarizer specification.
 * - `'strong'`                            … the preset
 * - `{ id: 'light', angle: 0.4 }`         … the preset, rotated
 * - `{ strength: 0.6 }`                   … straight values
 * - `true`                                … a light CPL
 * - `false` / `null` / omitted            … none
 */
export type PolarizerInput =
  | PolarizerId
  | ({ id?: PolarizerId } & Partial<Polarizer>)
  | boolean
  | null
  | undefined;

export const NO_POLARIZER: Polarizer = POLARIZER_PRESETS.none;

/** Strip a preset down to a plain polarizer (dropping `label`) */
function toPolarizer(p: Polarizer): Polarizer {
  return { strength: p.strength, angle: p.angle, saturation: p.saturation, stopLoss: p.stopLoss };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Resolve a polarizer specification */
export function resolvePolarizer(input: PolarizerInput): Polarizer {
  if (input == null || input === false) return toPolarizer(NO_POLARIZER);
  if (input === true) return toPolarizer(POLARIZER_PRESETS.light);
  if (typeof input === 'string') return toPolarizer(POLARIZER_PRESETS[input] ?? NO_POLARIZER);
  const base = input.id ? POLARIZER_PRESETS[input.id] ?? NO_POLARIZER : NO_POLARIZER;
  return toPolarizer({
    strength: clamp01(input.strength ?? base.strength),
    // left unwrapped: the animator interpolates it along the shorter arc over π
    // (a polarizer is symmetric every 180°), and wrapping here would fight that
    angle: input.angle ?? base.angle,
    saturation: clamp01(input.saturation ?? base.saturation),
    stopLoss: clamp01(input.stopLoss ?? base.stopLoss),
  });
}
