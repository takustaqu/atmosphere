// quality.ts — picture quality presets
//
//   new Atmosphere(canvas, { quality: 'balanced' });
//   sky.quality = 'low';
//
// A preset is only a pair of settings that already exist, chosen together:
// how finely the cloud stack is drawn (cloudScale) and how the cumulonimbus's
// towers are drawn (cumulonimbus). Given alongside either setting, the
// setting given wins.

import { type CumulonimbusMode } from './renderer.js';

export type QualityPreset = 'high' | 'balanced' | 'low';

export const QUALITY_IDS: readonly QualityPreset[] = ['high', 'balanced', 'low'];

export interface QualitySettings {
  cloudScale: number;
  cumulonimbus: CumulonimbusMode;
}

/**
 * - `high`: everything at full resolution, the volumetric tower — the default
 *   picture.
 * - `balanced`: the clouds at three quarters of the resolution each way;
 *   a cloudy frame takes about 0.8 of the time, its cloud edges a little
 *   softer.
 * - `low`: the clouds at half the resolution and the lighter 2D tower; a
 *   cloudy frame takes about half the time, a towering one less.
 */
export const QUALITY_PRESETS: Readonly<Record<QualityPreset, Readonly<QualitySettings>>> = {
  high: { cloudScale: 1, cumulonimbus: 'auto' },
  balanced: { cloudScale: 0.75, cumulonimbus: 'auto' },
  low: { cloudScale: 0.5, cumulonimbus: '2d' },
};

/**
 * The settings a preset stands for, with any given explicitly taking its
 * place. No preset and nothing given: nothing (the renderer's own defaults).
 */
export function resolveQuality(
  quality: QualityPreset | undefined,
  given: Partial<QualitySettings> = {},
): Partial<QualitySettings> {
  const p = quality ? QUALITY_PRESETS[quality] : undefined;
  return {
    cloudScale: given.cloudScale ?? p?.cloudScale,
    cumulonimbus: given.cumulonimbus ?? p?.cumulonimbus,
  };
}

/** The preset the settings in effect amount to, or undefined if none */
export function qualityOf(s: QualitySettings): QualityPreset | undefined {
  return QUALITY_IDS.find((id) =>
    QUALITY_PRESETS[id].cloudScale === s.cloudScale && QUALITY_PRESETS[id].cumulonimbus === s.cumulonimbus);
}
