import { describe, expect, it } from 'vitest';
import { ALL_FEATURES, CB_AUTO_BAND, FEATURE, backlitInView, cbVolumetricShare, featureKey, featureKeys, parhelionAzimuth, parheliaAmounts, parheliaPlates, parheliaRects, parheliaShape } from '../src/renderer.js';
import { stackSignature } from '../src/skycache.js';
import { resolveWeather } from '../src/weather.js';
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

describe('parhelia', () => {
  const DEG = Math.PI / 180;
  const bit = (c: Parameters<typeof resolveConditions>[0]) => featureKey(resolveConditions(c)) & FEATURE.PARHELIA;

  // A ray traced through a 60° prism standing upright, its faces' normals
  // level: Snell at each face in 3D, the deviation read as the azimuth between
  // what came in and what went out (the elevation comes back as it went in)
  const refract = (d: number[], nrm: number[], eta: number): number[] => {
    const c = -(d[0] * nrm[0] + d[1] * nrm[1] + d[2] * nrm[2]);
    const k = 1 - eta * eta * (1 - c * c);
    return d.map((v, i) => eta * v + (eta * c - Math.sqrt(k)) * nrm[i]);
  };
  const deviation = (inc: number, e: number, n: number): number => {
    // in the prism's cross-section (x, z), up y; the entry face's normal along -z
    const d = [Math.cos(e) * Math.sin(inc), Math.sin(e), Math.cos(e) * Math.cos(inc)];
    const inside = refract(d, [0, 0, -1], 1 / n);
    const a = 60 * DEG;
    const out = refract(inside, [Math.sin(a), 0, Math.cos(a)].map((v) => -v), n);
    return Math.abs(Math.atan2(out[0], out[2]) - inc);
  };
  const minDeviation = (e: number, n: number): number => {
    let best = Infinity;
    for (let i = 0; i < 4000; i++) {
      const inc = (15 + i * 0.015) * DEG;
      const v = deviation(inc, e, n);
      if (Number.isFinite(v)) best = Math.min(best, v);
    }
    return best;
  };

  it('stand where a 60° prism throws the sun: at its minimum deviation in azimuth', () => {
    for (const el of [0, 10, 20, 30, 40, 45]) {
      expect(parhelionAzimuth(el * DEG)).toBeCloseTo(minDeviation(el * DEG, 1.31), 3);
    }
  });

  it('draw away from the 22° ring as the sun climbs', () => {
    expect(parhelionAzimuth(0) / DEG).toBeCloseTo(21.84, 1);
    expect(parhelionAzimuth(30 * DEG) / DEG).toBeCloseTo(28.7, 0);
    expect(parhelionAzimuth(45 * DEG) / DEG).toBeCloseTo(42.5, 0);
    // and across the sky too, not just in azimuth: the old 22° / cos e kept
    // the parhelion on the ring. At 30 up one stands near 25° from the sun
    const apart = (e: number) => Math.acos(Math.sin(e) ** 2 + Math.cos(e) ** 2 * Math.cos(parhelionAzimuth(e)));
    expect(apart(30 * DEG) / DEG).toBeGreaterThan(24.5);
    expect(apart(30 * DEG)).toBeGreaterThan(apart(0) + 2 * DEG);
  });

  it('are brightest with the sun low and gone above some 45°', () => {
    expect(parheliaShape(5 * DEG)[2]).toBe(1);
    expect(parheliaShape(15 * DEG)[2]).toBe(1);
    expect(parheliaShape(30 * DEG)[2]).toBeLessThan(parheliaShape(20 * DEG)[2]);
    expect(parheliaShape(40 * DEG)[2]).toBeGreaterThan(0.1);
    expect(parheliaShape(45 * DEG)[2]).toBe(0);
    expect(parheliaShape(60 * DEG)[2]).toBe(0);
    // red nearest the sun, and the spectrum wider the higher it stands
    const spread = (e: number) => parhelionAzimuth(e, 1.317) - parhelionAzimuth(e, 1.307);
    expect(spread(5 * DEG)).toBeGreaterThan(0);
    expect(spread(40 * DEG)).toBeGreaterThan(spread(5 * DEG));
  });

  it('compile in for ice under a low sun, and nothing else', () => {
    const ice = { clouds: { cirrus: 0.3 } };
    expect(bit({ time: 16.5, weather: ice })).toBe(FEATURE.PARHELIA);
    expect(bit({ time: 16.5, weather: { clouds: { cirrostratus: 0.3 } } })).toBe(FEATURE.PARHELIA);
    expect(bit({ time: 16.5, weather: { clouds: { cirrocumulus: 0.3 } } })).toBe(FEATURE.PARHELIA);
    // a wisp of cirrus does not bring the veil's halo with it, nor a veil lose it
    expect(featureKey(resolveConditions({ time: 16.5, weather: ice })) & FEATURE.HALOS).toBe(0);
    expect(featureKey(resolveConditions({ time: 16.5, weather: { clouds: { cirrostratus: 0.3 } } })) & FEATURE.HALOS).toBe(FEATURE.HALOS);
    // no ice, or water only
    expect(bit({ time: 16.5, weather: 'clear' })).toBe(0);
    expect(bit({ time: 16.5, weather: { clouds: { cumulus: 0.5, altocumulus: 0.4, stratus: 0.3 } } })).toBe(0);
    // the sun too high (the nominal noon stands at 46°), or down
    expect(bit({ time: 12, weather: ice })).toBe(0);
    expect(bit({ time: 23, weather: ice })).toBe(0);
    // the same threshold as the shader's 0.001
    const s = resolveConditions({ time: 16.5, weather: 'clear' });
    s.clouds.cirrus = 0.001;
    expect(featureKey(s) & FEATURE.PARHELIA).toBe(0);
    s.clouds.cirrus = 0.0011;
    expect(featureKey(s) & FEATURE.PARHELIA).toBe(FEATURE.PARHELIA);
  });

  describe('settled plates', () => {
    const icy = resolveConditions({ time: 16.5, weather: { clouds: { cirrus: 0.3 } } });
    const sweep = (s: typeof icy): [number, number][] => {
      const out: [number, number][] = [];
      for (let evo = 0; evo < 40000; evo += 2) out.push(parheliaPlates(s, evo));
      return out;
    };
    // the clock where they are fully off, and where both clear
    const find = (s: typeof icy, f: (a: number, b: number) => boolean): number => {
      for (let evo = 0; evo < 40000; evo += 1) { const [a, b] = parheliaPlates(s, evo); if (f(a, b)) return evo; }
      throw new Error('never');
    };

    it('leave most icy skies without a parhelion, some with a faint one and a few with a clear pair', () => {
      for (const w of [{ clouds: { cirrus: 0.3 } }, { clouds: { cirrostratus: 0.7 } }, 'fair', { clouds: { cirrus: 0.2, cirrocumulus: 0.3 } }] as const) {
        const all = sweep(resolveConditions({ time: 16.5, weather: w }));
        const share = (f: (a: number, b: number) => boolean) => all.filter(([a, b]) => f(a, b)).length / all.length;
        const off = share((a, b) => Math.max(a, b) <= 0);
        const faint = share((a, b) => Math.max(a, b) > 0 && Math.max(a, b) < 0.5);
        const pair = share((a, b) => Math.min(a, b) >= 0.5);
        expect(off).toBeGreaterThan(0.5);
        expect(off).toBeLessThan(0.75);
        expect(faint).toBeGreaterThan(0.12);
        expect(pair).toBeGreaterThan(0.05);
        expect(pair).toBeLessThan(0.2);
      }
    });

    it('are the same at the same moment, and drift over tens of minutes, not frames', () => {
      expect(parheliaPlates(icy, 123.4)).toEqual(parheliaPlates(icy, 123.4));
      // a calm sky's clock runs 0.07 a second: a tenth of a second a step
      let most = 0;
      for (let evo = 0; evo < 5000; evo += 0.007) {
        const [a, b] = parheliaPlates(icy, evo), [c, d] = parheliaPlates(icy, evo + 0.007);
        most = Math.max(most, Math.abs(a - c), Math.abs(b - d));
      }
      expect(most).toBeLessThan(0.002);
      // a spell on or off lasts a good while: a median over ten minutes (42 of the clock)
      const spells: number[] = [];
      let run = 0, was = Math.max(...parheliaPlates(icy, 0)) > 0;
      for (let evo = 0; evo < 40000; evo += 1) {
        const on = Math.max(...parheliaPlates(icy, evo)) > 0;
        if (on === was) run++;
        else { spells.push(run); run = 1; was = on; }
      }
      spells.sort((a, b) => a - b);
      expect(spells[spells.length >> 1]).toBeGreaterThan(42);
    });

    it('differ a little from one side to the other', () => {
      const all = sweep(icy);
      const onOne = all.filter(([a, b]) => (a > 0) !== (b > 0)).length / all.length;
      expect(onOne).toBeGreaterThan(0.02);
      expect(onOne).toBeLessThan(0.2);
    });

    it('differ between skies on one clock', () => {
      const other = resolveConditions({ time: 16.5, weather: { clouds: { cirrus: 0.5, cirrocumulus: 0.2 } } });
      const a = sweep(icy), b = sweep(other);
      const differ = a.filter((v, i) => (v[0] > 0) !== (b[i][0] > 0)).length / a.length;
      expect(differ).toBeGreaterThan(0.2);
    });

    it('take the parhelia off the key and the canvas when off, on the clock given', () => {
      const off = find(icy, (a, b) => a <= 0 && b <= 0), on = find(icy, (a, b) => a > 0.5 && b > 0.5);
      expect(featureKey(icy, 0, 'auto', off) & FEATURE.PARHELIA).toBe(0);
      expect(featureKey(icy, 0, 'auto', on) & FEATURE.PARHELIA).toBe(FEATURE.PARHELIA);
      // without the clock: whether this sky can ever have them
      expect(featureKey(icy) & FEATURE.PARHELIA).toBe(FEATURE.PARHELIA);
      expect(featureKeys(icy, 0, 'auto', off)[0].key & FEATURE.PARHELIA).toBe(0);
      const cam = { yaw: icy.sunAzimuth, pitch: icy.sunElevation, fov: 1.05 };
      expect(parheliaRects(icy, cam, 1920, 1080, off)).toEqual([]);
      expect(parheliaRects(icy, cam, 1920, 1080, on).length).toBe(2);
      expect(parheliaAmounts(icy, off)).toEqual([0, 0]);
    });

    it('draw only the side that has them', () => {
      const lesser = find(icy, (a, b) => a > 0.05 && b <= 0), greater = find(icy, (a, b) => a <= 0 && b > 0.05);
      const cam = { yaw: icy.sunAzimuth, pitch: icy.sunElevation, fov: 1.05 };
      const left = parheliaRects(icy, cam, 1920, 1080, lesser), right = parheliaRects(icy, cam, 1920, 1080, greater);
      expect(left.length).toBe(1);
      expect(right.length).toBe(1);
      // greater azimuth is to the right of the view
      expect(left[0][0]).toBeLessThan(960);
      expect(right[0][0]).toBeGreaterThan(960);
    });

    it('leave a veil its halo when the parhelia are off', () => {
      const veil = resolveConditions({ time: 16.5, weather: { clouds: { cirrostratus: 0.6 } } });
      const off = find(veil, (a, b) => a <= 0 && b <= 0);
      const k = featureKey(veil, 0, 'auto', off);
      expect(k & FEATURE.PARHELIA).toBe(0);
      expect(k & FEATURE.HALOS).toBe(FEATURE.HALOS);
    });

    it('can be held settled by the weather, and only then', () => {
      expect(resolveWeather('fair').icePlates).toBe(0);
      expect(resolveWeather({ icePlates: 7 }).icePlates).toBe(1);
      expect(resolveWeather({ icePlates: -1 }).icePlates).toBe(0);
      const held = resolveConditions({ time: 16.5, weather: { clouds: { cirrus: 0.3 }, icePlates: 1 } });
      for (let evo = 0; evo < 3000; evo += 7) {
        expect(parheliaPlates(held, evo)).toEqual([1, 1]);
        expect(featureKey(held, 0, 'auto', evo) & FEATURE.PARHELIA).toBe(FEATURE.PARHELIA);
      }
      // a floor, not a value: where the sky has them clearer they stay so
      const floor = resolveConditions({ time: 16.5, weather: { clouds: { cirrus: 0.3 }, icePlates: 0.3 } });
      const on = find(icy, (a, b) => a > 0.9 && b > 0.9);
      expect(Math.min(...parheliaPlates(floor, on))).toBeGreaterThan(0.3);
      // still no parhelia without ice, or with the sun too high
      const dry = resolveConditions({ time: 16.5, weather: { cloudCover: 0, icePlates: 1 } });
      expect(featureKey(dry, 0, 'auto', 100) & FEATURE.PARHELIA).toBe(0);
      const noon = resolveConditions({ time: 12, weather: { clouds: { cirrus: 0.3 }, icePlates: 1 } });
      expect(parheliaAmounts(noon, 100)).toEqual([0, 0]);
    });

    it('ease with the weather, and don\'t disturb a sky cache', () => {
      const a = new StateAnimator(icy);
      const held = resolveConditions({ time: 16.5, weather: { clouds: { cirrus: 0.3 }, icePlates: 1 } });
      a.step(held, 1);
      expect(a.current.icePlates).toBeGreaterThan(0);
      expect(a.current.icePlates).toBeLessThan(1);
      expect(stackSignature(held)).toEqual(stackSignature(icy));
    });
  });

  describe('parheliaRects', () => {
    const W = 1920, H = 1080;
    const s = resolveConditions({ time: 16.5, weather: { clouds: { cirrus: 0.3 } } });
    // a parhelion's place on the canvas, as the shader's viewRay would have it
    const place = (side: number, cam: { yaw: number; pitch: number; fov: number }, x = 0.02): [number, number] | null => {
      const az = s.sunAzimuth + side * (parheliaShape(s.sunElevation)[0] + x / Math.cos(s.sunElevation));
      const e = s.sunElevation, wx = Math.cos(e) * Math.sin(az), wy = Math.sin(e), wz = Math.cos(e) * Math.cos(az);
      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      const dx = wx * cy - wz * sy, dh = wx * sy + wz * cy;
      const dy = wy * cp - dh * sp, dz = wy * sp + dh * cp;
      if (dz <= 0) return null;
      const t = Math.tan(cam.fov / 2);
      return [(dx / dz / (W / H * t) * 0.5 + 0.5) * W, (dy / dz / t * 0.5 + 0.5) * H];
    };
    const inRect = (p: [number, number], r: number[]) => p[0] >= r[0] && p[0] <= r[0] + r[2] && p[1] >= r[1] && p[1] <= r[1] + r[3];

    it('has one round each parhelion in view, and each a few hundredths of the frame', () => {
      const cam = { yaw: s.sunAzimuth, pitch: s.sunElevation, fov: 1.05 };
      const rs = parheliaRects(s, cam, W, H);
      expect(rs.length).toBe(2);
      for (const side of [-1, 1]) {
        const p = place(side, cam)!;
        expect(rs.some((r) => inRect(p, r))).toBe(true);
      }
      for (const r of rs) expect(r[2] * r[3] / (W * H)).toBeLessThan(0.03);
    });

    it('has none looking away, or with the sun too high', () => {
      expect(parheliaRects(s, { yaw: s.sunAzimuth + Math.PI, pitch: 0.2, fov: 1.05 }, W, H)).toEqual([]);
      expect(parheliaRects(s, { yaw: s.sunAzimuth, pitch: 1.3, fov: 0.4 }, W, H)).toEqual([]);
      const high = { ...s, sunElevation: 50 * DEG };
      expect(parheliaRects(high, { yaw: s.sunAzimuth, pitch: 0.8, fov: 1.2 }, W, H)).toEqual([]);
    });

    it('stays on the canvas and holds a parhelion at every turn of the view', () => {
      for (let k = 0; k < 96; k++) {
        const cam = { yaw: s.sunAzimuth + k * Math.PI / 48, pitch: 0.2 + 0.1 * (k % 5), fov: 0.5 + 0.2 * (k % 4) };
        const rs = parheliaRects(s, cam, W, H);
        for (const r of rs) {
          expect(r[0]).toBeGreaterThanOrEqual(0);
          expect(r[1]).toBeGreaterThanOrEqual(0);
          expect(r[0] + r[2]).toBeLessThanOrEqual(W);
          expect(r[1] + r[3]).toBeLessThanOrEqual(H);
        }
        for (const side of [-1, 1]) {
          const p = place(side, cam);
          if (p && p[0] > 0 && p[0] < W && p[1] > 0 && p[1] < H) expect(rs.some((r) => inRect(p, r))).toBe(true);
        }
      }
    });
  });
});

describe('backlitInView', () => {
  // the shader's sunApart, its gates' squash and reach, over a dense sweep of
  // a view's rays (viewRay's arithmetic): the least margin by which any ray
  // stays out of the light from behind's reach, negative if one is inside it
  const margin = (s: ReturnType<typeof resolveConditions>, cam: { yaw: number; pitch: number; fov: number }, aspect: number) => {
    const sm = (a: number, b: number, x: number) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
    const ce = Math.cos(s.sunElevation);
    const sun = [ce * Math.sin(s.sunAzimuth), Math.sin(s.sunElevation), ce * Math.cos(s.sunAzimuth)];
    const lowS = 1 - sm(0.20, 0.55, sun[1]), lift = sm(0.15, 0.60, sun[1]);
    const gates = [[0.35 + 0.65 * lift, 0.60 + 1.05 * lowS], [0.5 + 0.5 * lift, 1.0 + 0.3 * sm(0.30, 0.50, sun[1])]];
    const t = Math.tan(cam.fov / 2);
    let least = Infinity;
    for (let j = 0; j <= 90; j++) for (let i = 0; i <= 160; i++) {
      const x = (i / 160 * 2 - 1) * aspect * t, y = (j / 90 * 2 - 1) * t, l = Math.hypot(x, y, 1);
      const d0 = [x / l, y / l, 1 / l];
      const d1 = [d0[0], d0[1] * Math.cos(cam.pitch) + d0[2] * Math.sin(cam.pitch), -d0[1] * Math.sin(cam.pitch) + d0[2] * Math.cos(cam.pitch)];
      const rd = [d1[0] * Math.cos(cam.yaw) + d1[2] * Math.sin(cam.yaw), d1[1], -d1[0] * Math.sin(cam.yaw) + d1[2] * Math.cos(cam.yaw)];
      for (const [q, reach] of gates) {
        const a = [rd[0], rd[1] * q, rd[2]], b = [sun[0], sun[1] * q, sun[2]];
        const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]));
        least = Math.min(least, Math.acos(Math.min(Math.max(c, -1), 1)) - reach);
      }
    }
    return least;
  };

  it('keeps the light from behind for a view toward the sun, and leaves it out turned away', () => {
    const s = resolveConditions({ time: 15, weather: 'fair' });
    const toward = { yaw: s.sunAzimuth, pitch: Math.max(s.sunElevation, 0.2), fov: 0.86 };
    expect(backlitInView(s, toward, 16 / 9)).toBe(true);
    expect(backlitInView(s, { ...toward, yaw: s.sunAzimuth + Math.PI }, 16 / 9)).toBe(false);
  });

  it('never leaves it out of a view any ray of which it can reach', () => {
    // suns from the horizon up, views all round, narrow and wide, tilted up
    // and down: wherever the dense sweep finds a ray within reach the view
    // keeps it — and the grid's own allowance stays modest: a view whose
    // rays all clear the reach by a third of a radian leaves it out
    let out = 0;
    for (const time of [6.3, 7, 9, 12, 15, 17.6]) {
      const s = resolveConditions({ time, weather: 'fair' });
      for (let k = 0; k < 16; k++) for (const pitch of [-0.3, 0.25, 0.8, 1.4]) for (const fov of [0.5, 1.25, 2.0]) {
        const cam = { yaw: k / 16 * 2 * Math.PI, pitch, fov };
        const m = margin(s, cam, 16 / 9);
        const kept = backlitInView(s, cam, 16 / 9);
        if (m < 0) expect(kept).toBe(true);
        if (m > 0.35) expect(kept).toBe(false);
        if (!kept) out++;
      }
    }
    expect(out).toBeGreaterThan(100);
  });

  it('widens the window under a lens with drops on it', () => {
    const wet = resolveConditions({ time: 15, weather: { cloudCover: 0.3, precipitation: 3 }, lens: { droplets: 1 } });
    const dry = { ...wet, lens: { ...wet.lens, droplets: 0 } };
    // the sun just past the frame's side: out of reach of the frame's own
    // rays, not of the rays the drops bend in from beyond its edge
    let differ = 0;
    for (let k = 0; k < 64; k++) {
      const cam = { yaw: wet.sunAzimuth + 0.6 + k * 0.05, pitch: Math.max(wet.sunElevation, 0.1), fov: 0.86 };
      const a = backlitInView(wet, cam, 16 / 9), b = backlitInView(dry, cam, 16 / 9);
      if (a !== b) differ++;
      if (!a) expect(b).toBe(false);
    }
    expect(differ).toBeGreaterThan(0);
  });
});
