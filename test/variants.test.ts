import { describe, expect, it } from 'vitest';
import { ALL_FEATURES, CB_AUTO_BAND, FEATURE, cbVolumetricShare, featureKey, featureKeys } from '../src/renderer.js';
import { resolveConditions } from '../src/state.js';
import { StateAnimator } from '../src/animator.js';

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

  it('compiles the volumetric tower in only when asked for, and only alongside a tower', () => {
    const summer = resolveConditions({ time: 13, weather: 'summer' });
    const fair = resolveConditions({ time: 14, weather: 'fair' });
    expect(featureKey(summer, 0, '2d') & FEATURE.CBVOL).toBe(0);
    expect(featureKey(summer, 0, 'volumetric') & FEATURE.CBVOL).toBe(FEATURE.CBVOL);
    // the rest of the key is the 2D one's
    expect(featureKey(summer, 0, 'volumetric') & ~FEATURE.CBVOL).toBe(featureKey(summer, 0, '2d'));
    // a sky without a tower shares the 2D variant, whichever the mode
    for (const mode of ['auto', '2d', 'volumetric'] as const) {
      expect(featureKey(fair, 0, mode)).toBe(featureKey(fair, 0, '2d'));
    }
  });

  it('draws a storm close overhead with the 2D tower under auto, and any other with the volumetric one', () => {
    const at = (distance: number) => resolveConditions({
      time: 13, weather: { cloudCover: 0.25, convection: 0.9, features: { distance } },
    });
    const [lo, hi] = CB_AUTO_BAND;
    // the default is auto, and the middle distance every sky is set at is volumetric
    const summer = resolveConditions({ time: 13, weather: 'summer' });
    expect(featureKey(summer)).toBe(featureKey(summer, 0, 'volumetric'));
    expect(featureKeys(summer)).toEqual([{ key: featureKey(summer, 0, 'volumetric'), share: 1 }]);
    for (const d of [hi, 0.6, 0.65, 0.95]) {
      const ks = featureKeys(at(d), 0, 'auto');
      expect(ks).toEqual([{ key: featureKey(at(d), 0, 'volumetric'), share: 1 }]);
    }
    for (const d of [0, 0.1, 0.3, 0.4, lo]) {
      const ks = featureKeys(at(d), 0, 'auto');
      expect(ks).toEqual([{ key: featureKey(at(d), 0, '2d'), share: 1 }]);
      expect(featureKey(at(d), 0, 'auto') & FEATURE.CBVOL).toBe(0);
    }
    // inside the band both, the 2D tower first and the volumetric one over it
    // at its share, which climbs from 0 to 1 across the band
    let last = 0;
    for (let d = lo + 0.005; d < hi; d += 0.01) {
      const ks = featureKeys(at(d), 0, 'auto');
      expect(ks.map((k) => k.key)).toEqual([featureKey(at(d), 0, '2d'), featureKey(at(d), 0, 'volumetric')]);
      expect(ks[0].share).toBe(1);
      expect(ks[1].share).toBeGreaterThan(last);
      expect(ks[1].share).toBeLessThan(1);
      expect(ks[1].share).toBeCloseTo(cbVolumetricShare(d), 9);
      last = ks[1].share;
      // and the one key is the tower with the larger share
      expect(featureKey(at(d), 0, 'auto') & FEATURE.CBVOL).toBe(ks[1].share >= 0.5 ? FEATURE.CBVOL : 0);
    }
    // the explicit modes are pure at every distance
    for (const d of [0.1, (lo + hi) / 2, 0.65]) {
      expect(featureKeys(at(d), 0, '2d')).toEqual([{ key: featureKey(at(d), 0, '2d'), share: 1 }]);
      expect(featureKeys(at(d), 0, 'volumetric')).toEqual([{ key: featureKey(at(d), 0, 'volumetric'), share: 1 }]);
    }
    // the band keeps clear of the close storm and of the middle distance
    expect(lo).toBeGreaterThan(0.4);
    expect(hi).toBeLessThanOrEqual(0.55);
  });

  it('keeps the cumulonimbus compiled in for as long as any of it can show, easing away or in', () => {
    // The towers sink into their base as the amount falls, and the last of
    // them is gone by 0.03 (cbLive and the alpha's fade in the shader): the
    // variant must not drop the tower before then, nor add it after it has
    // begun to climb back out. Stepped as the hero eases one scene into the next
    const storm = resolveConditions({ time: 13, weather: { cloudCover: 0.18, convection: 0.85, windSpeed: 3, visibility: 30 } });
    const fair = resolveConditions({ time: 17.8, weather: 'fair' });
    const visible = 0.03;
    for (const [from, to] of [[storm, fair], [fair, storm]]) {
      const an = new StateAnimator(from);
      let dropped = false;
      for (let i = 0; i < 30 * 30; i++) {
        an.step(to, 1 / 30);
        const cb = an.current.clouds.cumulonimbus;
        const on = (featureKey(an.current) & FEATURE.CB) !== 0;
        if (cb >= visible) expect(on).toBe(true);
        if (!on) dropped = true;
      }
      // and it does let go of it, once the amount is all but gone
      expect(dropped).toBe(to === fair);
    }
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
