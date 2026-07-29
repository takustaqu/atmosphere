// clouds.ts — the ten cloud genera
//
// The World Meteorological Organization's ten cloud genera, handled by name.
// The sky shows several genera at once, so instead of picking one "main"
// genus, we layer an amount 0..1 per genus.
//
//   clouds: { cirrus: 0.5, cumulus: 0.3 }   // cotton clouds floating under cirrus
//
// The renderer reduces the ten genera to "4 forms × 3 altitudes":
//   filament   … cirrus
//   stratiform … cirrostratus / altostratus / nimbostratus / stratus (differ only in altitude and thickness)
//   granular   … cirrocumulus / altocumulus / stratocumulus (differ only in grain size and altitude)
//   convective … cumulus / cumulonimbus

export type CloudGenus =
  | 'cirrus' | 'cirrostratus' | 'cirrocumulus'
  | 'altostratus' | 'altocumulus' | 'nimbostratus'
  | 'stratus' | 'stratocumulus' | 'cumulus' | 'cumulonimbus';

export type CloudLevel = 'high' | 'mid' | 'low';
export type CloudForm = 'filament' | 'stratiform' | 'granular' | 'convective';

export interface CloudGenusInfo {
  /** display name */
  label: string;
  /** common nickname */
  alias?: string;
  /** abbreviation */
  abbr: string;
  level: CloudLevel;
  form: CloudForm;
  /** at amount 1, how much of the whole sky it occludes. Cumulonimbus stays a small patch even when pitch black */
  opacity: number;
}

export const CLOUD_GENERA: Record<CloudGenus, CloudGenusInfo> = {
  cirrus:        { label: 'Cirrus',        alias: "Mare's tail",  abbr: 'Ci', level: 'high', form: 'filament',   opacity: 0.15 },
  cirrostratus:  { label: 'Cirrostratus',  alias: 'Veil cloud',   abbr: 'Cs', level: 'high', form: 'stratiform', opacity: 0.45 },
  cirrocumulus:  { label: 'Cirrocumulus',  alias: 'Mackerel sky', abbr: 'Cc', level: 'high', form: 'granular',   opacity: 0.25 },
  altostratus:   { label: 'Altostratus',   alias: 'Grey veil',    abbr: 'As', level: 'mid',  form: 'stratiform', opacity: 0.90 },
  altocumulus:   { label: 'Altocumulus',   alias: 'Sheep cloud',  abbr: 'Ac', level: 'mid',  form: 'granular',   opacity: 0.45 },
  nimbostratus:  { label: 'Nimbostratus',  alias: 'Rain cloud',   abbr: 'Ns', level: 'mid',  form: 'stratiform', opacity: 1.00 },
  stratus:       { label: 'Stratus',       alias: 'Fog cloud',    abbr: 'St', level: 'low',  form: 'stratiform', opacity: 0.95 },
  stratocumulus: { label: 'Stratocumulus', alias: 'Roll cloud',   abbr: 'Sc', level: 'low',  form: 'granular',   opacity: 0.75 },
  cumulus:       { label: 'Cumulus',       alias: 'Cotton cloud', abbr: 'Cu', level: 'low',  form: 'convective', opacity: 0.40 },
  cumulonimbus:  { label: 'Cumulonimbus',  alias: 'Thunderhead',  abbr: 'Cb', level: 'low',  form: 'convective', opacity: 0.28 },
};

export const CLOUD_GENERA_IDS = Object.keys(CLOUD_GENERA) as CloudGenus[];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** smoothstep */
function ramp(x: number, a: number, b: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** amount 0..1 of each cloud genus */
export type CloudMix = Record<CloudGenus, number>;

/**
 * Companion forms attached to cumulonimbus. Not new genera — they're
 * sub-classifications of the ten. Auto-derived from `cumulonimbus`'s
 * development when omitted.
 */
export interface CloudFeatures {
  /** 0..1 anvil cloud (incus): the ice-crystal head spreading at the tropopause */
  anvil: number;
  /** 0..1 veil cloud (velum): a thin sheet draped like cloth over the tower's flank */
  velum: number;
}

export const NO_FEATURES: CloudFeatures = { anvil: 0, velum: 0 };

/**
 * Derive the companion forms from how developed the cumulonimbus is.
 * Velum accompanies a growing towering cumulus through a young cumulonimbus,
 * and fades once it matures and the anvil spreads.
 */
export function defaultCloudFeatures(cumulonimbus: number): CloudFeatures {
  const cb = clamp01(cumulonimbus);
  return {
    anvil: ramp(cb, 0.68, 1.0),
    velum: ramp(cb, 0.22, 0.50) * (1 - ramp(cb, 0.68, 0.95)),
  };
}

/** A cloud genus specification: an array of names, or an amount-keyed dict */
export type CloudsInput = CloudGenus | CloudGenus[] | Partial<CloudMix> | null | undefined;

export const NO_CLOUDS: CloudMix = {
  cirrus: 0, cirrostratus: 0, cirrocumulus: 0,
  altostratus: 0, altocumulus: 0, nimbostratus: 0,
  stratus: 0, stratocumulus: 0, cumulus: 0, cumulonimbus: 0,
};

/** Resolve a cloud genus specification into an amount dict */
export function resolveClouds(input: CloudsInput): CloudMix {
  if (input == null) return { ...NO_CLOUDS };
  if (typeof input === 'string') return { ...NO_CLOUDS, [input]: 1 };
  if (Array.isArray(input)) {
    const mix = { ...NO_CLOUDS };
    for (const g of input) mix[g] = 1;
    return mix;
  }
  const mix = { ...NO_CLOUDS };
  for (const g of CLOUD_GENERA_IDS) mix[g] = clamp01(input[g] ?? 0);
  return mix;
}

/**
 * Build a plausible cloud-genus mix from cloud cover, precipitation,
 * convection and haze when no genera were specified.
 *
 * A weather API returns cloud cover, not cloud genera, so the pass-through
 * path lands here. It follows an ordinary sky's makeup: cumulus and cirrus
 * when clouds are sparse, stratocumulus and altostratus as they thicken,
 * nimbostratus once it's raining.
 */
export function defaultCloudMix(
  cover: number,
  precipitation: number,
  convection: number,
  haze: number,
): CloudMix {
  const c = clamp01(cover);
  const wet = clamp01(precipitation);
  const dry = 1 - wet;
  // as cover increases, high clouds get hidden behind the lower deck
  const visibleAloft = 1 - ramp(c, 0.45, 0.85);
  // as cover increases, billowing cumulus gets smoothed into a single sheet
  const stillLumpy = 1 - ramp(c, 0.50, 0.85);

  return {
    cirrus:        ramp(c, 0.02, 0.45) * 0.70 * visibleAloft,
    cirrostratus:  ramp(c, 0.10, 0.45) * 0.45 * visibleAloft,
    cirrocumulus:  ramp(c, 0.14, 0.40) * 0.35 * visibleAloft * dry,
    altostratus:   ramp(c, 0.55, 0.90) * 0.85 * dry,
    altocumulus:   ramp(c, 0.22, 0.55) * 0.70 * (1 - ramp(c, 0.70, 0.95)) * dry,
    nimbostratus:  wet * ramp(c, 0.50, 0.85),
    stratus:       ramp(c, 0.50, 0.90) * haze * 0.90,
    stratocumulus: ramp(c, 0.30, 0.75) * 0.85 * (1 - wet * 0.7),
    cumulus:       ramp(c, 0.03, 0.35) * stillLumpy * dry,
    // Cap convection by cloud cover. Cumulonimbus is itself a cloud, so a
    // towering cumulonimbus in a sky reported as zero cloud cover is a
    // contradiction.
    cumulonimbus:  clamp01(convection) * ramp(c, 0.02, 0.25),
  };
}

/** From a cloud-genus mix, get the total occlusion of sun/stars */
export function aggregateCover(mix: CloudMix): number {
  let clear = 1;
  for (const g of CLOUD_GENERA_IDS) clear *= 1 - mix[g] * CLOUD_GENERA[g].opacity;
  return clamp01(1 - clear);
}
