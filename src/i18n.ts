// i18n.ts — locale-aware display labels for presets
//
// The renderer itself has no notion of locale: everything it consumes is a
// numeric parameter or an id (WeatherId, FilterId, CloudGenus). Locale only
// matters where those ids get turned into text for a UI, so it lives here
// rather than inside the preset tables.
//
// English is not spelled out again here. The preset tables already carry
// English `label` (and `alias`) fields as part of their public API, so the
// `en` dictionaries are derived from them. Only the translations are literal —
// otherwise renaming a preset would leave two English names disagreeing.

import { CLOUD_GENERA, type CloudGenus } from './clouds';
import { FILTER_PRESETS, type FilterId } from './filter';
import { WEATHER_PRESETS, type WeatherId } from './weather';

export type Locale = 'en' | 'ja';

function mapValues<K extends string, T, U>(
  src: Record<K, T>,
  fn: (v: T) => U,
): Record<K, U> {
  const out = {} as Record<K, U>;
  for (const k of Object.keys(src) as K[]) out[k] = fn(src[k]);
  return out;
}

export const WEATHER_LABELS: Record<Locale, Record<WeatherId, string>> = {
  en: mapValues(WEATHER_PRESETS, (p) => p.label),
  ja: {
    clear: '快晴',
    fair: '晴れ',
    summer: '夏空',
    overcast: '曇り',
    fog: '霧',
    rain: '雨',
    thunderstorm: '雷雨',
    snow: '雪',
    typhoon: '台風',
  },
};

export const FILTER_LABELS: Record<Locale, Record<FilterId, string>> = {
  en: mapValues(FILTER_PRESETS, (p) => p.label),
  ja: {
    none: 'なし',
    sepia: 'セピア',
    mono: 'モノクローム',
    faded: '褪色',
    cyanotype: '青の記憶',
    gold: '黄昏',
    ash: '灰',
  },
};

export interface CloudGenusLabel {
  /** proper name of the genus */
  label: string;
  /** common nickname, if any */
  alias?: string;
}

export const CLOUD_LABELS: Record<Locale, Record<CloudGenus, CloudGenusLabel>> = {
  en: mapValues(CLOUD_GENERA, (g) => ({ label: g.label, alias: g.alias })),
  ja: {
    cirrus: { label: '巻雲', alias: 'すじ雲' },
    cirrostratus: { label: '巻層雲', alias: 'うす雲' },
    cirrocumulus: { label: '巻積雲', alias: 'うろこ雲・いわし雲' },
    altostratus: { label: '高層雲', alias: 'おぼろ雲' },
    altocumulus: { label: '高積雲', alias: 'ひつじ雲' },
    nimbostratus: { label: '乱層雲', alias: 'あま雲' },
    stratus: { label: '層雲', alias: 'きり雲' },
    stratocumulus: { label: '層積雲', alias: 'くもり雲' },
    cumulus: { label: '積雲', alias: 'わた雲' },
    cumulonimbus: { label: '積乱雲', alias: '入道雲' },
  },
};

export function weatherLabel(id: WeatherId, locale: Locale = 'en'): string {
  return WEATHER_LABELS[locale][id];
}

export function filterLabel(id: FilterId, locale: Locale = 'en'): string {
  return FILTER_LABELS[locale][id];
}

export function cloudGenusLabel(id: CloudGenus, locale: Locale = 'en'): CloudGenusLabel {
  return CLOUD_LABELS[locale][id];
}
