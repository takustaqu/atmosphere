// celestial.ts — what is in the sky beyond the atmosphere
//
// The counterpart to weather.ts. Weather covers everything the air is doing;
// this covers everything behind it — the star field, the Milky Way, meteors.
// They are separate axes because they are independent: a meteor shower is not a
// weather condition, and the same shower looks entirely different under cloud.
//
// Two kinds of thing live here, and they are already distinguishable in the
// renderer even though nothing named the distinction before:
//
//   - fixed on the celestial sphere: stars, the Milky Way. Pinned to a direction,
//     unchanged as the view swings.
//   - transient events: meteors. Fired stochastically off the clock, with a
//     lifetime, then gone — the same machinery lightning already uses.
//
// Units follow the same rule as weather: whatever the observation is actually
// measured in. Light pollution has the Bortle scale, meteor showers have ZHR.

export interface Celestial {
  /**
   * Bortle dark-sky scale, 1..9.
   *
   * 1 is a pristine site where the Milky Way casts shadows; 9 is an inner-city
   * sky with a handful of stars. Drives star density, the horizon glow of city
   * light, and (unless given outright) whether the Milky Way is visible at all.
   *
   * Defaults to 6 — a bright suburban sky, which is what the renderer has always
   * drawn.
   */
  bortle: number;
  /**
   * 0..1 how visible the Milky Way is.
   *
   * Derived from `bortle` when not given: it fades out around Bortle 5 and is
   * gone by 6, which is why the default sky has never shown one.
   */
  milkyWay: number;
  /**
   * meteors per hour, as ZHR (zenithal hourly rate) — the rate an observer would
   * count with the radiant overhead under a dark sky.
   *
   * ~5 is the sporadic background on any night. The Perseids peak near 100, the
   * Geminids near 150. Defaults to 0: a meteor is an event, and a background
   * renderer should not start firing them unless asked.
   *
   * Not capped at anything real, because a ZHR is what a whole-sky observer
   * counts and a rendered frame covers well under a fifth of the sky. An honest
   * 150 puts a meteor in shot every few minutes — correct, and far too rare to
   * watch. Values in the thousands are not a physical sky; they are what it takes
   * for a viewer looking at one framing to actually see them.
   */
  meteors: number;
  /**
   * where meteors radiate from, as `[elevation, azimuth]` in radians.
   *
   * A shower's meteors all appear to stream from one point — that is what makes
   * it a shower rather than a scatter. `null` gives sporadics, which come from
   * anywhere.
   */
  radiant: readonly [number, number] | null;
}

export type CelestialId = 'dark-sky' | 'rural' | 'suburban' | 'city' | 'perseids' | 'geminids';

export interface CelestialPreset extends Celestial {
  /** display name */
  label: string;
}

/** Perseus, high in the northeast — where the Perseids radiate from on an August night */
const PERSEUS: readonly [number, number] = [1.05, 0.79];
/** Gemini, high in the east — the Geminid radiant on a December night */
const GEMINI: readonly [number, number] = [0.98, 1.48];

export const CELESTIAL_PRESETS: Record<CelestialId, CelestialPreset> = {
  'dark-sky': { label: 'Dark sky',  bortle: 2, milkyWay: 1.00, meteors: 5, radiant: null },
  rural:      { label: 'Rural',     bortle: 4, milkyWay: 0.45, meteors: 5, radiant: null },
  suburban:   { label: 'Suburban',  bortle: 6, milkyWay: 0.00, meteors: 0, radiant: null },
  city:       { label: 'City',      bortle: 8, milkyWay: 0.00, meteors: 0, radiant: null },
  perseids:   { label: 'Perseids',  bortle: 3, milkyWay: 0.75, meteors: 100, radiant: PERSEUS },
  geminids:   { label: 'Geminids',  bortle: 3, milkyWay: 0.75, meteors: 150, radiant: GEMINI },
};

export const CELESTIAL_IDS = Object.keys(CELESTIAL_PRESETS) as CelestialId[];

export function isCelestialId(v: unknown): v is CelestialId {
  return typeof v === 'string' && (CELESTIAL_IDS as string[]).includes(v);
}

/**
 * The sky the renderer has always drawn: a suburban one. Keeping this as the
 * default is what makes the whole axis a no-op until someone asks for it.
 */
export const DEFAULT_CELESTIAL: Celestial = {
  bortle: 6,
  milkyWay: 0,
  meteors: 0,
  radiant: null,
};

/**
 * How visible the Milky Way is at a given Bortle class.
 *
 * Naked-eye reality: obvious at 1–3, washed out by 4–5, effectively gone at 6.
 * Exported because it is the same shape of derivation `defaultCloudMix` does —
 * fill in the thing nobody measured from the thing everybody reports.
 */
export function milkyWayFromBortle(bortle: number): number {
  return Math.min(1, Math.max(0, (5.5 - bortle) / 3.5));
}

/**
 * A celestial specification.
 * - `'perseids'`                       … the preset
 * - `{ id: 'rural', meteors: 40 }`     … the preset, adjusted
 * - `{ bortle: 3 }`                    … raw values (Milky Way derived from it)
 * - `null` / omitted                   … the default suburban sky
 */
export type CelestialInput =
  | CelestialId
  | ({ id?: CelestialId } & Partial<Celestial>)
  | null
  | undefined;

function toCelestial(c: Celestial): Celestial {
  return {
    bortle: c.bortle,
    milkyWay: c.milkyWay,
    meteors: c.meteors,
    radiant: c.radiant ? [c.radiant[0], c.radiant[1]] : null,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Resolve a celestial specification */
export function resolveCelestial(input: CelestialInput): Celestial {
  if (input == null) return toCelestial(DEFAULT_CELESTIAL);
  if (typeof input === 'string') {
    return toCelestial(CELESTIAL_PRESETS[input] ?? DEFAULT_CELESTIAL);
  }
  const base = input.id ? CELESTIAL_PRESETS[input.id] ?? DEFAULT_CELESTIAL : DEFAULT_CELESTIAL;
  const bortle = clamp(input.bortle ?? base.bortle, 1, 9);
  return toCelestial({
    bortle,
    // Only derive when the caller neither named a preset nor gave a value —
    // a preset's Milky Way is an authored choice and shouldn't be overwritten
    milkyWay: clamp(
      input.milkyWay ?? (input.id ? base.milkyWay : milkyWayFromBortle(bortle)),
      0, 1,
    ),
    meteors: Math.max(0, input.meteors ?? base.meteors),
    radiant: input.radiant !== undefined ? input.radiant : base.radiant,
  });
}
