import { describe, expect, it } from 'vitest';
import {
  aggregateCover,
  CLOUD_GENERA,
  CLOUD_GENERA_IDS,
  DEFAULT_CB_DISTANCE,
  defaultCloudFeatures,
  defaultCloudMix,
  NO_CLOUDS,
  resolveClouds,
} from '../src/clouds';

describe('resolveClouds', () => {
  it('a bare genus name gives that genus alone, at full amount', () => {
    expect(resolveClouds('cumulus')).toEqual({ ...NO_CLOUDS, cumulus: 1 });
  });

  it('an array gives every listed genus at full amount', () => {
    expect(resolveClouds(['cirrus', 'cumulus'])).toEqual({
      ...NO_CLOUDS,
      cirrus: 1,
      cumulus: 1,
    });
  });

  it('a dict keeps the listed amounts and zeroes the rest', () => {
    expect(resolveClouds({ cirrus: 0.5 })).toEqual({ ...NO_CLOUDS, cirrus: 0.5 });
  });

  it('dict amounts are clamped to 0..1', () => {
    const mix = resolveClouds({ cirrus: 5, cumulus: -2 });
    expect(mix.cirrus).toBe(1);
    expect(mix.cumulus).toBe(0);
  });

  it('null and undefined give a cloudless sky', () => {
    expect(resolveClouds(null)).toEqual(NO_CLOUDS);
    expect(resolveClouds(undefined)).toEqual(NO_CLOUDS);
  });

  it('returns a fresh object rather than the shared NO_CLOUDS constant', () => {
    expect(resolveClouds(null)).not.toBe(NO_CLOUDS);
    resolveClouds(null).cirrus = 1;
    expect(NO_CLOUDS.cirrus).toBe(0);
  });
});

describe('aggregateCover', () => {
  it('a cloudless sky occludes nothing', () => {
    expect(aggregateCover(NO_CLOUDS)).toBe(0);
  });

  it('a single genus at full amount occludes exactly its opacity', () => {
    for (const g of CLOUD_GENERA_IDS) {
      expect(aggregateCover(resolveClouds(g))).toBeCloseTo(CLOUD_GENERA[g].opacity, 12);
    }
  });

  it('every genus at once saturates at 1 and never overshoots', () => {
    const cover = aggregateCover(resolveClouds(CLOUD_GENERA_IDS));
    expect(cover).toBe(1);
    expect(cover).toBeLessThanOrEqual(1);
  });

  it('a thick deck without the fully opaque genera still stays under 1', () => {
    const cover = aggregateCover({
      ...NO_CLOUDS,
      altostratus: 1,
      stratus: 1,
      stratocumulus: 1,
    });
    expect(cover).toBeLessThan(1);
    expect(cover).toBeGreaterThan(0.99);
  });
});

describe('defaultCloudMix', () => {
  it('nothing in, nothing out', () => {
    expect(defaultCloudMix(0, 0, 0, 0)).toEqual(NO_CLOUDS);
  });

  it('at full cover the high clouds are hidden behind the lower deck', () => {
    const mix = defaultCloudMix(1, 0, 0, 0);
    expect(mix.cirrus).toBe(0);
    expect(mix.cirrostratus).toBe(0);
    expect(mix.cirrocumulus).toBe(0);
  });

  it('a sparse sky is cumulus and cirrus', () => {
    const mix = defaultCloudMix(0.3, 0, 0, 0);
    expect(mix.cirrus).toBeGreaterThan(0);
    expect(mix.cumulus).toBeGreaterThan(0);
    expect(mix.nimbostratus).toBe(0);
  });

  it('cumulus follows the cover instead of reaching its ceiling early', () => {
    // a third cloudy must not be drawn as a full cumulus field (about 80% of the sky)
    expect(defaultCloudMix(0.38, 0, 0, 0).cumulus).toBeLessThan(0.7);
    let last = 0;
    for (const c of [0.05, 0.1, 0.2, 0.3, 0.4, 0.5]) {
      const cu = defaultCloudMix(c, 0, 0, 0).cumulus;
      expect(cu).toBeGreaterThan(last);
      last = cu;
    }
  });

  it('convection is capped by cloud cover: no thunderhead in a reported clear sky', () => {
    expect(defaultCloudMix(0, 0, 1, 0).cumulonimbus).toBe(0);
    expect(defaultCloudMix(0.5, 0, 1, 0).cumulonimbus).toBeGreaterThan(0);
  });
});

describe('defaultCloudFeatures', () => {
  it('no cumulonimbus means no companion forms', () => {
    expect(defaultCloudFeatures(0)).toEqual({ anvil: 0, velum: 0, distance: DEFAULT_CB_DISTANCE });
  });

  it('the storm stands at the middle distance however developed it is', () => {
    for (const cb of [0, 0.3, 0.55, 0.8, 1]) {
      expect(defaultCloudFeatures(cb).distance).toBe(DEFAULT_CB_DISTANCE);
    }
    expect(DEFAULT_CB_DISTANCE).toBeGreaterThan(0);
    expect(DEFAULT_CB_DISTANCE).toBeLessThan(1);
  });

  it('a fully mature cumulonimbus has spread its anvil and lost its velum', () => {
    const { anvil, velum } = defaultCloudFeatures(1);
    expect(anvil).toBe(1);
    expect(velum).toBeCloseTo(0, 12);
  });

  it('a mid-development tower carries a velum but no anvil yet', () => {
    const { anvil, velum } = defaultCloudFeatures(0.55);
    expect(velum).toBeGreaterThan(0);
    expect(anvil).toBe(0);
  });
});
