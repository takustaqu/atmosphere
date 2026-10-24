import { describe, expect, it } from 'vitest';
import { QUALITY_IDS, QUALITY_PRESETS, qualityOf, resolveQuality } from '../src/quality';

describe('quality presets', () => {
  it('high is the default picture, and each step down is lighter', () => {
    expect(QUALITY_PRESETS.high).toEqual({ cloudScale: 1, cumulonimbus: 'auto' });
    expect(QUALITY_PRESETS.balanced.cloudScale).toBe(0.75);
    expect(QUALITY_PRESETS.low).toEqual({ cloudScale: 0.5, cumulonimbus: '2d' });
  });

  it('a setting given explicitly takes the preset\'s place', () => {
    expect(resolveQuality('low', { cumulonimbus: 'auto' })).toEqual({ cloudScale: 0.5, cumulonimbus: 'auto' });
    expect(resolveQuality('balanced', { cloudScale: 1 })).toEqual({ cloudScale: 1, cumulonimbus: 'auto' });
  });

  it('no preset and nothing given leaves the renderer its defaults', () => {
    expect(resolveQuality(undefined)).toEqual({ cloudScale: undefined, cumulonimbus: undefined });
  });

  it('reads the preset back from the settings, or none', () => {
    for (const id of QUALITY_IDS) expect(qualityOf(QUALITY_PRESETS[id])).toBe(id);
    expect(qualityOf({ cloudScale: 0.5, cumulonimbus: 'volumetric' })).toBeUndefined();
  });
});
