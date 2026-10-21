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

  it('rain shafts are compiled in under rain or a thundering tower, and nowhere else', () => {
    expect(featureKey(resolveConditions({ time: 17, weather: 'thunderstorm' })) & FEATURE.SHAFTS).toBe(FEATURE.SHAFTS);
    expect(featureKey(resolveConditions({ time: 15, weather: 'rain' })) & FEATURE.SHAFTS).toBe(FEATURE.SHAFTS);
    expect(featureKey(resolveConditions({ time: 12, weather: 'typhoon' })) & FEATURE.SHAFTS).toBe(FEATURE.SHAFTS);
    expect(featureKey(resolveConditions({ time: 12, weather: 'clear' })) & FEATURE.SHAFTS).toBe(0);
    expect(featureKey(resolveConditions({ time: 14, weather: 'fair' })) & FEATURE.SHAFTS).toBe(0);
    // a tower that rains with no rain falling here: thunder alone is enough
    const s = resolveConditions({ time: 17, weather: 'thunderstorm' });
    s.rain = 0;
    expect(featureKey(s) & FEATURE.SHAFTS).toBe(FEATURE.SHAFTS);
    s.thunder = 0;
    expect(featureKey(s) & FEATURE.SHAFTS).toBe(0);
  });

  it('compiles the cumulonimbus in only where there is one', () => {
    expect(featureKey(resolveConditions({ time: 13, weather: 'summer' })) & FEATURE.CB).toBe(FEATURE.CB);
    expect(featureKey(resolveConditions({ time: 17, weather: 'thunderstorm' })) & FEATURE.CB).toBe(FEATURE.CB);
    expect(featureKey(resolveConditions({ time: 14, weather: 'fair' })) & FEATURE.CB).toBe(0);
    expect(featureKey(resolveConditions({ time: 11, weather: 'overcast' })) & FEATURE.CB).toBe(0);
    // the shader's gate is the amount past 0.001
    const s = resolveConditions({ weather: { convection: 0.5 } });
    s.clouds.cumulonimbus = 0.001;
    expect(featureKey(s) & FEATURE.CB).toBe(0);
  });

  it('compiles light from behind in only with a sun up, no overcast and a cloud to light', () => {
    const bit = (c: Parameters<typeof resolveConditions>[0]) => featureKey(resolveConditions(c)) & FEATURE.BACKLIT;
    expect(bit({ time: 14, weather: 'fair' })).toBe(FEATURE.BACKLIT);
    expect(bit({ time: 13, weather: 'summer' })).toBe(FEATURE.BACKLIT);
    expect(bit({ time: 12, weather: 'clear' })).toBe(0);
    expect(bit({ time: 23, weather: 'fair' })).toBe(0);
    // a thunderstorm's overcast takes the sun
    expect(bit({ time: 17, weather: 'thunderstorm' })).toBe(0);
    // the shader's gate: the sun's sine past -0.05
    const s = resolveConditions({ time: 14, weather: 'fair' });
    s.sunElevation = Math.asin(-0.051);
    expect(featureKey(s) & FEATURE.BACKLIT).toBe(0);
    s.sunElevation = Math.asin(-0.0499);
    expect(featureKey(s) & FEATURE.BACKLIT).toBe(FEATURE.BACKLIT);
  });

  it('compiles iridescence in only by day under a water cloud', () => {
    const bit = (c: Parameters<typeof resolveConditions>[0]) => featureKey(resolveConditions(c)) & FEATURE.IRIDESCENCE;
    expect(bit({ time: 10, weather: { clouds: { altocumulus: 0.5 } } })).toBe(FEATURE.IRIDESCENCE);
    expect(bit({ time: 14, weather: 'fair' })).toBe(FEATURE.IRIDESCENCE);
    expect(bit({ time: 23, weather: 'fair' })).toBe(0);
    // ice gives a halo instead
    expect(bit({ time: 10, weather: { clouds: { cirrocumulus: 0.5, cirrostratus: 0.5 } } })).toBe(0);
    expect(bit({ time: 12, weather: 'clear' })).toBe(0);
  });

  it('compiles the moon-lit cloud in only at night with a moon up', () => {
    const bit = (c: Parameters<typeof resolveConditions>[0]) => featureKey(resolveConditions(c)) & FEATURE.MOONLIT;
    expect(bit({ time: 23, weather: 'fair' })).toBe(FEATURE.MOONLIT);
    expect(bit({ time: 23, weather: { clouds: { cirrocumulus: 0.5 } } })).toBe(FEATURE.MOONLIT);
    expect(bit({ time: 14, weather: 'fair' })).toBe(0);
    expect(bit({ time: 23, weather: 'clear' })).toBe(0);
    const s = resolveConditions({ time: 23, weather: 'fair' });
    s.moonElevation = -0.2;
    expect(featureKey(s) & FEATURE.MOONLIT).toBe(0);
    s.moonElevation = 0.5;
    s.moonPhase = 0;
    expect(featureKey(s) & FEATURE.MOONLIT).toBe(0);
  });

  it('lets go of the dark sky once an eased bortle is all but back at 6', () => {
    const s = resolveConditions({ time: 22, weather: 'clear', celestial: 'suburban' });
    s.celestial.bortle = 5.9999;
    expect(featureKey(s) & FEATURE.DARKSKY).toBe(0);
  });
});
