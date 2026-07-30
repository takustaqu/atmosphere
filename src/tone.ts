// tone.ts — the tone curve
//
// Scene-referred, unlike filter.ts. These knobs act on linear scene light before
// it becomes display values, which is the only place they mean anything: a
// multiply in linear light is an exposure, a multiply in gamma-encoded values is
// just an odd darkening. Everything here became possible when the compositing
// moved to linear light.
//
// Order (shader side, all in linear light):
//   light × 2^exposure                    … exposure
//   pivot contrast around 18% grey        … contrast
//   desaturate toward white near the top  … bleach
//   identity below knee, shoulder above   … the curve itself
//   encode                                → display space, then filter.ts grades it

export interface ToneCurve {
  /** exposure in stops. 0 is unchanged, +1 is twice the light */
  exposure: number;
  /** contrast pivoted on 18% grey. 1 is unchanged; below 1 flattens, above 1 steepens */
  contrast: number;
  /**
   * where the highlight shoulder starts, 0..1.
   *
   * Below this the curve is exactly identity, so the published look survives
   * untouched — the default 0.8 shapes only blown highlights. Bring it down to
   * put the curve through the midtones, which is where it starts to be a look.
   */
  knee: number;
  /**
   * 0..1 how much the highlights desaturate toward white as they approach the
   * ceiling.
   *
   * What film does, and what keeps a bright sky from clipping into a muddy hue.
   * Needs linear light to be right, so it wasn't expressible before.
   */
  bleach: number;
}

export type ToneId = 'neutral' | 'flat' | 'punch' | 'filmic' | 'blown';

export interface TonePreset extends ToneCurve {
  /** display name */
  label: string;
}

export const TONE_PRESETS: Record<ToneId, TonePreset> = {
  neutral: { label: 'Neutral', exposure: 0.00, contrast: 1.00, knee: 0.80, bleach: 0.00 },
  flat:    { label: 'Flat',    exposure: 0.15, contrast: 0.82, knee: 0.55, bleach: 0.25 },
  punch:   { label: 'Punch',   exposure: -0.20, contrast: 1.22, knee: 0.85, bleach: 0.10 },
  filmic:  { label: 'Filmic',  exposure: 0.10, contrast: 1.08, knee: 0.42, bleach: 0.55 },
  blown:   { label: 'Blown',   exposure: 0.85, contrast: 0.95, knee: 0.70, bleach: 0.40 },
};

export const TONE_IDS = Object.keys(TONE_PRESETS) as ToneId[];

export function isToneId(v: unknown): v is ToneId {
  return typeof v === 'string' && (TONE_IDS as string[]).includes(v);
}

/**
 * A tone specification.
 * - `'filmic'`                       … the preset
 * - `{ id: 'filmic', exposure: 0.3 }`… the preset, adjusted
 * - `{ contrast: 1.1 }`              … straight values on top of neutral
 * - `null` / omitted                 … neutral
 */
export type ToneInput =
  | ToneId
  | ({ id?: ToneId } & Partial<ToneCurve>)
  | null
  | undefined;

export const NEUTRAL_TONE: ToneCurve = TONE_PRESETS.neutral;

/** Strip a preset down to a plain curve (dropping `label`, so the result is freely mutable) */
function toTone(t: ToneCurve): ToneCurve {
  return { exposure: t.exposure, contrast: t.contrast, knee: t.knee, bleach: t.bleach };
}

/** Resolve a tone specification */
export function resolveTone(input: ToneInput): ToneCurve {
  if (input == null) return toTone(NEUTRAL_TONE);
  if (typeof input === 'string') return toTone(TONE_PRESETS[input] ?? NEUTRAL_TONE);
  const base = input.id ? TONE_PRESETS[input.id] ?? NEUTRAL_TONE : NEUTRAL_TONE;
  return toTone({
    exposure: input.exposure ?? base.exposure,
    contrast: input.contrast ?? base.contrast,
    // a knee at 0 would put the shoulder on black; keep it off the floor
    knee: Math.min(0.99, Math.max(0.02, input.knee ?? base.knee)),
    bleach: Math.min(1, Math.max(0, input.bleach ?? base.bleach)),
  });
}
