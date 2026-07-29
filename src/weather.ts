// weather.ts — weather input
//
// Weather is accepted in **observation units**, not "renderer-friendly 0..1
// parameters". Pass a weather API's response through almost as-is and that
// weather gets reproduced.
//
//   atmosphere.set({ weather: { cloudCover: 0.95, precipitation: 12, windSpeed: 18 } });
//
// To decide the look of the clouds directly, pass the ten cloud genera instead
// of cloud cover.
//
//   atmosphere.set({ weather: { clouds: { cirrus: 0.5, cumulus: 0.3 } } });
//
// The named presets are defined with the same observation values, so presets
// and raw observations are on a continuum.

import {
  aggregateCover, defaultCloudFeatures, defaultCloudMix, resolveClouds,
  type CloudFeatures, type CloudMix, type CloudsInput,
} from './clouds.js';

export type PrecipitationType = 'rain' | 'snow';

/** Weather observation. Every field is optional (omitted = that phenomenon is absent). */
export interface Weather {
  /** Total cloud cover 0..1 (divide oktas by 8 before passing). `clouds` takes priority if given */
  cloudCover?: number;
  /** Amount of each of the ten cloud genera. Overrides the look directly when given */
  clouds?: CloudsInput;
  /** Convective development 0..1. Shorthand for `clouds.cumulonimbus` */
  convection?: number;
  /** Cumulonimbus companion forms (anvil / velum). Auto-derived from convection when omitted */
  features?: Partial<CloudFeatures>;
  /** Precipitation rate, mm/h */
  precipitation?: number;
  /** Precipitation type, defaults to 'rain' */
  precipitationType?: PrecipitationType;
  /** Surface wind speed, m/s */
  windSpeed?: number;
  /** Lightning activity 0..1 */
  thunder?: number;
  /** Visibility, km. Defaults to 30km (clear sky) */
  visibility?: number;
}

export type WeatherId =
  | 'clear' | 'fair' | 'summer' | 'overcast' | 'fog'
  | 'rain' | 'thunderstorm' | 'snow' | 'typhoon';

export interface WeatherPreset extends Weather {
  /** display name */
  label: string;
}

export const WEATHER_PRESETS: Record<WeatherId, WeatherPreset> = {
  clear:        { label: 'Clear',        cloudCover: 0,    windSpeed: 2,  visibility: 45 },
  fair:         { label: 'Fair',         cloudCover: 0.22, windSpeed: 3,  visibility: 35 },
  summer:       { label: 'Summer sky',   cloudCover: 0.38, windSpeed: 3,  visibility: 25, convection: 0.7 },
  overcast:     { label: 'Overcast',     cloudCover: 0.82, windSpeed: 5,  visibility: 15 },
  fog:          { label: 'Fog',          cloudCover: 0.75, windSpeed: 1,  visibility: 0.6 },
  rain:         { label: 'Rain',         cloudCover: 0.95, windSpeed: 7,  visibility: 8,  precipitation: 8, thunder: 0.08 },
  thunderstorm: { label: 'Thunderstorm', cloudCover: 0.97, windSpeed: 12, visibility: 5,  precipitation: 25, thunder: 1, convection: 0.5 },
  snow:         { label: 'Snow',         cloudCover: 0.90, windSpeed: 3,  visibility: 4,  precipitation: 3, precipitationType: 'snow' },
  typhoon:      { label: 'Typhoon',      cloudCover: 1.0,  windSpeed: 30, visibility: 6,  precipitation: 40, thunder: 0.5 },
};

export const WEATHER_IDS = Object.keys(WEATHER_PRESETS) as WeatherId[];

export function isWeatherId(v: unknown): v is WeatherId {
  return typeof v === 'string' && (WEATHER_IDS as string[]).includes(v);
}

/** Either a preset name or a raw observation */
export type WeatherInput = WeatherId | Weather | null | undefined;

/** The 0..1 weather the renderer interprets, derived from the observation */
export interface WeatherState {
  /** amount of each cloud genus */
  clouds: CloudMix;
  /** cumulonimbus companion forms */
  features: CloudFeatures;
  /** total occlusion of sun/stars; also feeds the cloud lighting's diffuseness */
  cloudCover: number;
  rain: number;         // 0..1 rain intensity
  snow: number;         // 0..1 snow intensity
  wind: number;         // 0..1 wind strength (cloud turbulence, rain/snow slant)
  thunder: number;      // 0..1 lightning activity
  haze: number;         // 0..1 haze, derived from visibility
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Precipitation rate mm/h → 0..1 (1 = heavy rain, saturates at 30mm/h) */
function precipCurve(mmPerHour: number): number {
  return clamp01(Math.pow(clamp01(mmPerHour / 30), 0.55));
}

/** Wind speed m/s → 0..1 (1 = typhoon-force, saturates at 33m/s) */
function windCurve(mps: number): number {
  return clamp01(Math.pow(clamp01(mps / 33), 0.8));
}

/** Snowfall rate mm/h (water equivalent) → 0..1. Unlike rain, 5mm/h is already heavy snow */
function snowCurve(mmPerHour: number): number {
  return clamp01(Math.pow(clamp01(mmPerHour / 5), 0.6));
}

/** Visibility km → 0..1 haze (0 past 20km, thick fog under 1km) */
function hazeCurve(km: number): number {
  return clamp01(Math.pow(clamp01((20 - km) / 20), 2.6));
}

/** Resolve a weather input into the 0..1 parameters the renderer interprets */
export function resolveWeather(input: WeatherInput): WeatherState {
  const w: Weather = typeof input === 'string'
    ? WEATHER_PRESETS[input] ?? WEATHER_PRESETS.clear
    : input ?? {};

  const mm = w.precipitation ?? 0;
  const isSnow = w.precipitationType === 'snow';
  const rain = isSnow ? 0 : precipCurve(mm);
  const snow = isSnow ? snowCurve(mm) : 0;
  const haze = hazeCurve(w.visibility ?? 30);
  const convection = clamp01(w.convection ?? 0);

  // If cloud genera are given, they're authoritative; otherwise build a
  // reasonable mix from cloud cover. Total occlusion is either accumulated
  // from that mix, or taken directly from cloudCover.
  //
  // `convection` is only shorthand for `clouds.cumulonimbus`, so it's ignored
  // entirely once `clouds` is given. Letting it fill in a zero cumulonimbus
  // would make an explicit `cumulonimbus: 0` impossible to express whenever a
  // preset left `convection` set.
  let clouds: CloudMix;
  let cloudCover: number;
  if (w.clouds != null) {
    clouds = resolveClouds(w.clouds);
    cloudCover = aggregateCover(clouds);
  } else {
    cloudCover = clamp01(w.cloudCover ?? 0);
    clouds = defaultCloudMix(cloudCover, Math.max(rain, snow), convection, haze);
  }

  const auto = defaultCloudFeatures(clouds.cumulonimbus);

  return {
    clouds,
    features: {
      anvil: clamp01(w.features?.anvil ?? auto.anvil),
      velum: clamp01(w.features?.velum ?? auto.velum),
    },
    cloudCover,
    rain,
    snow,
    wind: windCurve(w.windSpeed ?? 0),
    thunder: clamp01(w.thunder ?? 0),
    haze,
  };
}
