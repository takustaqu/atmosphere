// ground.ts — what lies below the horizon
//
// The sky is drawn along view rays, and half of all rays point down. Until now
// every one of them landed on the same flat plate of ground — out of frame in
// the default framing, there for the skybox's lower hemisphere and for anyone
// who tilts the camera down. This axis chooses what that lower half is.
//
// A sea is a mirror laid flat. What reaches the eye off water is mostly the
// sky, reflected — all of it at a grazing look, next to none looking straight
// down — which is why a sea takes the color of its hour exactly, and why the
// sun and the moon lay a path across it. The swell is what breaks that mirror
// up: its slopes scatter the reflection, and that scatter is the path.

export interface Ground {
  /**
   * 0..1 how much of the ground is open water.
   *
   * 0 (the default) is the plain ground the renderer has always drawn; 1 is a
   * sea to the horizon. Between the two it cross-fades, which is what makes a
   * change of ground ease in like everything else.
   */
  sea: number;
  /**
   * 0..1 how much the water heaves.
   *
   * 0 is glass — the sky mirrored unbroken; 1 is a long, heavy swell. The
   * chop on top of it follows the wind on its own. Only matters while `sea`
   * is up.
   */
  swell: number;
}

export type GroundId = 'land' | 'sea';

export interface GroundPreset extends Ground {
  /** display name */
  label: string;
}

export const GROUND_PRESETS: Record<GroundId, GroundPreset> = {
  land: { label: 'Land', sea: 0, swell: 0.4 },
  sea:  { label: 'Sea',  sea: 1, swell: 0.4 },
};

export const GROUND_IDS = Object.keys(GROUND_PRESETS) as GroundId[];

export function isGroundId(v: unknown): v is GroundId {
  return typeof v === 'string' && (GROUND_IDS as string[]).includes(v);
}

/** The ground the renderer has always drawn: a plain plate, no water */
export const DEFAULT_GROUND: Ground = { sea: 0, swell: 0.4 };

/**
 * A ground specification.
 * - `'sea'`                      … open water to the horizon, a light swell on it
 * - `{ swell: 0.8 }`             … the sea, heaving more (an object means the sea unless `sea` says otherwise)
 * - `{ sea: 0.5 }`               … halfway between — mostly for easing
 * - `null` / omitted / `'land'`  … the default plain ground
 */
export type GroundInput = GroundId | Partial<Ground> | null | undefined;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Resolve a ground specification */
export function resolveGround(input: GroundInput): Ground {
  if (input == null) return { ...DEFAULT_GROUND };
  if (typeof input === 'string') {
    const p = GROUND_PRESETS[input] ?? GROUND_PRESETS.land;
    return { sea: p.sea, swell: p.swell };
  }
  return {
    // asking for ground settings at all is asking for the sea: the plain
    // ground has nothing to set
    sea: clamp01(input.sea ?? 1),
    swell: clamp01(input.swell ?? DEFAULT_GROUND.swell),
  };
}
