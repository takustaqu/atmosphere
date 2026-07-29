// filter.ts — color filter
//
// A film-style grading: collapse the sky's color to luminance, then re-tint it
// any color. "Sepia" is just one preset of this — not a special case.
//
// Apply order (shader side):
//   mono = luminance × tint
//   c    = mix(mono, original × tint, saturation)
//   c    = c × (1 - lift) + lift          … lift the blacks for a faded look
//   out  = mix(original, c, amount)

export interface ColorFilter {
  /** 0..1 how strongly it applies. 0 disables it */
  amount: number;
  /** white point: the color luminance is multiplied by (1,1,1 = neutral) */
  tint: readonly [number, number, number];
  /** 0..1 how much of the original saturation survives. 0 = fully monochrome */
  saturation: number;
  /** 0..1 black lift, for that faded-film look */
  lift: number;
}

export type FilterId = 'none' | 'sepia' | 'mono' | 'faded' | 'cyanotype' | 'gold' | 'ash';

export interface FilterPreset extends ColorFilter {
  /** display name */
  label: string;
}

export const FILTER_PRESETS: Record<FilterId, FilterPreset> = {
  none:      { label: 'None',       amount: 0, tint: [1.00, 1.00, 1.00], saturation: 1.00, lift: 0.00 },
  sepia:     { label: 'Sepia',      amount: 1, tint: [1.07, 0.93, 0.72], saturation: 0.10, lift: 0.02 },
  mono:      { label: 'Monochrome', amount: 1, tint: [1.00, 1.00, 1.00], saturation: 0.00, lift: 0.00 },
  faded:     { label: 'Faded',      amount: 1, tint: [1.02, 0.99, 0.94], saturation: 0.35, lift: 0.06 },
  cyanotype: { label: 'Cyanotype',  amount: 1, tint: [0.72, 0.90, 1.12], saturation: 0.08, lift: 0.03 },
  gold:      { label: 'Gold',       amount: 1, tint: [1.15, 0.95, 0.60], saturation: 0.45, lift: 0.02 },
  ash:       { label: 'Ash',        amount: 1, tint: [0.92, 0.95, 1.00], saturation: 0.20, lift: 0.04 },
};

export const FILTER_IDS = Object.keys(FILTER_PRESETS) as FilterId[];

export function isFilterId(v: unknown): v is FilterId {
  return typeof v === 'string' && (FILTER_IDS as string[]).includes(v);
}

/**
 * A filter specification.
 * - `'sepia'`                     … the preset, full strength
 * - `{ id: 'sepia', amount: 0.6 }`… the preset, dialed down
 * - `{ tint: [...], ... }`        … a custom color
 * - `false` / `null` / omitted    … none
 */
export type FilterInput =
  | FilterId
  | ({ id?: FilterId } & Partial<ColorFilter>)
  | boolean
  | null
  | undefined;

export const NO_FILTER: ColorFilter = FILTER_PRESETS.none;

/**
 * Strip a preset down to a plain filter.
 *
 * A preset carries a `label`, and its `tint` array is shared by every caller
 * that spreads it — copy both away so the result is a clean, freely mutable
 * `ColorFilter` no matter which input form produced it.
 */
function toFilter(f: ColorFilter): ColorFilter {
  return {
    amount: f.amount,
    tint: [f.tint[0], f.tint[1], f.tint[2]],
    saturation: f.saturation,
    lift: f.lift,
  };
}

/** Resolve a filter specification */
export function resolveFilter(input: FilterInput): ColorFilter {
  if (input == null || input === false) return toFilter(NO_FILTER);
  // keep the old `sepia: true` shorthand working
  if (input === true) return toFilter(FILTER_PRESETS.sepia);
  if (typeof input === 'string') {
    return toFilter(FILTER_PRESETS[input] ?? NO_FILTER);
  }
  // With no id, fall back to "just tint the luminance" so tint alone is usable
  const base: ColorFilter = input.id
    ? FILTER_PRESETS[input.id] ?? NO_FILTER
    : { amount: 1, tint: [1, 1, 1], saturation: 0, lift: 0 };
  return toFilter({
    amount: input.amount ?? base.amount,
    tint: input.tint ?? base.tint,
    saturation: input.saturation ?? base.saturation,
    lift: input.lift ?? base.lift,
  });
}
