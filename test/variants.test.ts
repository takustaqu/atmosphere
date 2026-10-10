import { describe, expect, it } from 'vitest';
import { ALL_FEATURES, FEATURE, featureKey } from '../src/renderer.js';
import { resolveConditions } from '../src/state.js';

describe('featureKey', () => {
  it('a clear suburban noon needs nothing optional', () => {
    expect(featureKey(resolveConditions({ time: 12, weather: 'clear' }))).toBe(0);
  });

  it('each feature sets its own bit, at the threshold the shader gates on', () => {
    expect(featureKey(resolveConditions({ ground: 'sea' }))).toBe(FEATURE.SEA);
    expect(featureKey(resolveConditions({ celestial: { aurora: 0.5 } }))).toBe(FEATURE.AURORA);
    expect(featureKey(resolveConditions({ celestial: 'aurora' }))).toBe(FEATURE.AURORA | FEATURE.DARKSKY);
    expect(featureKey(resolveConditions({ particles: { contrails: 1 } }))).toBe(FEATURE.CONTRAILS);
    expect(featureKey(resolveConditions({}), 1)).toBe(FEATURE.RAYS);
    expect(featureKey(resolveConditions({ weather: { clouds: { cirrostratus: 0.5 } } }))).toBe(FEATURE.HALOS);
    expect(featureKey(resolveConditions({ weather: 'thunderstorm' })) & FEATURE.BOLT).toBe(FEATURE.BOLT);
    expect(featureKey(resolveConditions({ weather: 'thunderstorm' })) & FEATURE.RAINBOW).toBe(FEATURE.RAINBOW);
    expect(featureKey(resolveConditions({ celestial: 'dark-sky' }))).toBe(FEATURE.DARKSKY);
    expect(featureKey(resolveConditions({ polarizer: 'strong' }))).toBe(FEATURE.POLARIZER);
  });

  it('the suburban default is not a dark sky, and a Milky Way alone is', () => {
    expect(featureKey(resolveConditions({ celestial: 'suburban' }))).toBe(0);
    expect(featureKey(resolveConditions({ celestial: { milkyWay: 0.5 } })) & FEATURE.DARKSKY).toBe(FEATURE.DARKSKY);
  });

  it('ALL_FEATURES covers every bit', () => {
    let all = 0;
    for (const v of Object.values(FEATURE)) all |= v;
    expect(all).toBe(ALL_FEATURES);
  });
});
