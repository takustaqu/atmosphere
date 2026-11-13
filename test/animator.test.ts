import { describe, expect, it } from 'vitest';
import { lerpWrapped, StateAnimator } from '../src/animator';
import { resolveConditions } from '../src/state';

const TAU = Math.PI * 2;

describe('lerpWrapped', () => {
  it('takes the short way round midnight: 23:00 → 01:00 halfway is 00:00', () => {
    expect(lerpWrapped(23, 1, 0.5, 24)).toBe(0);
  });

  it('is symmetric: 01:00 → 23:00 halfway is also 00:00', () => {
    expect(lerpWrapped(1, 23, 0.5, 24)).toBe(0);
  });

  it('interpolates linearly when no wrap is involved', () => {
    expect(lerpWrapped(10, 14, 0.25, 24)).toBeCloseTo(11, 12);
  });

  it('k = 1 lands on the target, reduced mod the period', () => {
    expect(lerpWrapped(23, 1, 1, 24)).toBe(1);
    expect(lerpWrapped(1, 23, 1, 24)).toBe(23);
  });

  it('k = 0 stays put', () => {
    expect(lerpWrapped(23, 1, 0, 24)).toBe(23);
  });

  it('works on angles with a 2π period, crossing north the short way', () => {
    // 6.0 rad → 0.4 rad is +0.6832 rad forward, not −5.6 rad backward
    const half = lerpWrapped(6.0, 0.4, 0.5, TAU);
    expect(half).toBeCloseTo(0.058407346410207, 12);
    // the long way round would have landed near π
    expect(Math.abs(half - Math.PI)).toBeGreaterThan(1);
  });

  it('angles at k = 1 land on the target', () => {
    expect(lerpWrapped(6.0, 0.4, 1, TAU)).toBeCloseTo(0.4, 12);
  });
});

const CALM = resolveConditions({ time: 6, weather: 'clear' });
const STORM = resolveConditions({ time: 15, weather: 'thunderstorm', filter: 'sepia' });

describe('StateAnimator', () => {
  it('converges on the target when stepped long enough', () => {
    const a = new StateAnimator(CALM);
    for (let i = 0; i < 2000; i++) a.step(STORM, 0.1);

    expect(a.current.timeOfDay).toBeCloseTo(STORM.timeOfDay, 8);
    expect(a.current.sunElevation).toBeCloseTo(STORM.sunElevation, 8);
    expect(a.current.sunAzimuth).toBeCloseTo(STORM.sunAzimuth, 8);
    expect(a.current.cloudCover).toBeCloseTo(STORM.cloudCover, 8);
    expect(a.current.rain).toBeCloseTo(STORM.rain, 8);
    expect(a.current.thunder).toBeCloseTo(STORM.thunder, 8);
    expect(a.current.haze).toBeCloseTo(STORM.haze, 8);
    expect(a.current.clouds.cumulonimbus).toBeCloseTo(STORM.clouds.cumulonimbus, 8);
    expect(a.current.clouds.nimbostratus).toBeCloseTo(STORM.clouds.nimbostratus, 8);
    expect(a.current.features.anvil).toBeCloseTo(STORM.features.anvil, 8);
    expect(a.current.filter.amount).toBeCloseTo(STORM.filter.amount, 8);
    expect(a.current.filter.saturation).toBeCloseTo(STORM.filter.saturation, 8);
    expect(a.current.filter.tint[0]).toBeCloseTo(STORM.filter.tint[0], 8);
  });

  it('does not mutate the state it was constructed from', () => {
    const initial = resolveConditions({ time: 6, weather: 'clear' });
    const a = new StateAnimator(initial);
    a.step(STORM, 1);
    expect(initial.timeOfDay).toBe(6);
    expect(initial.cloudCover).toBe(0);
  });

  it('the wind offset advances monotonically, so clouds never jump', () => {
    const a = new StateAnimator(CALM);
    let prevWind = a.wind;
    let prevEvo = a.evolution;
    for (let i = 0; i < 60; i++) {
      a.step(STORM, 1 / 60);
      expect(a.wind).toBeGreaterThan(prevWind);
      expect(a.evolution).toBeGreaterThan(prevEvo);
      prevWind = a.wind;
      prevEvo = a.evolution;
    }
  });

  it('the offsets keep advancing even in dead calm weather', () => {
    const a = new StateAnimator(CALM);
    const before = a.wind;
    a.step(CALM, 1);
    expect(a.wind).toBeGreaterThan(before);
  });

  it('jump lands on the target immediately', () => {
    const a = new StateAnimator(CALM);
    a.jump(STORM);
    expect(a.current).toEqual(STORM);
  });

  it('jump copies the nested objects instead of aliasing the target', () => {
    const a = new StateAnimator(CALM);
    a.jump(STORM);
    expect(a.current).not.toBe(STORM);
    expect(a.current.clouds).not.toBe(STORM.clouds);
    expect(a.current.features).not.toBe(STORM.features);
    expect(a.current.filter).not.toBe(STORM.filter);

    // stepping on from a jump must not write back into the target
    a.step(CALM, 1);
    expect(STORM.clouds.cumulonimbus).toBe(
      resolveConditions({ time: 15, weather: 'thunderstorm' }).clouds.cumulonimbus,
    );
    expect(STORM.filter.amount).toBe(1);
  });
});

describe('StateAnimator state isolation', () => {
  it('jump copies filter.tint too, so the target never drifts with the animation', () => {
    const target = resolveConditions({ time: 12, weather: 'clear', filter: 'sepia' });
    const a = new StateAnimator(resolveConditions({ time: 12, weather: 'clear' }));
    a.jump(target);
    expect(a.current.filter.tint).not.toBe(target.filter.tint);
    expect(a.current.filter.tint).toEqual(target.filter.tint);

    // step() rewrites current.filter.tint; the target's copy must be untouched
    const before = [...target.filter.tint];
    a.step(resolveConditions({ time: 12, weather: 'clear', filter: 'cyanotype' }), 1);
    expect([...target.filter.tint]).toEqual(before);
  });

  it('the constructor copies filter.tint as well', () => {
    const initial = resolveConditions({ time: 12, weather: 'clear', filter: 'gold' });
    const a = new StateAnimator(initial);
    expect(a.current.filter.tint).not.toBe(initial.filter.tint);
  });
});

describe('StateAnimator storm distance', () => {
  it('a storm draws nearer gradually, and arrives', () => {
    const far = resolveConditions({ time: 15, weather: { convection: 1, cloudCover: 0.3, features: { distance: 1 } } });
    const near = resolveConditions({ time: 15, weather: { convection: 1, cloudCover: 0.3, features: { distance: 0 } } });
    const a = new StateAnimator(far);
    a.step(near, 0.1);
    expect(a.current.features.distance).toBeLessThan(1);
    expect(a.current.features.distance).toBeGreaterThan(0);
    for (let i = 0; i < 2000; i++) a.step(near, 0.1);
    expect(a.current.features.distance).toBeCloseTo(0, 8);
    expect(far.features.distance).toBe(1);
  });
});

describe('StateAnimator rain and snow', () => {
  const SNOW = resolveConditions({ time: 15, weather: 'snow' });
  const FAIR = resolveConditions({ time: 15, weather: 'fair' });

  it('a snowfall stops sooner than it starts', () => {
    const starting = new StateAnimator(FAIR);
    const stopping = new StateAnimator(SNOW);
    for (let i = 0; i < 120; i++) { starting.step(SNOW, 1 / 60); stopping.step(FAIR, 1 / 60); }
    // two seconds in: the fall coming on is short of its amount by more than
    // the fall going off still has of it
    expect(SNOW.snow - starting.current.snow).toBeGreaterThan(2 * stopping.current.snow);
    expect(stopping.current.snow).toBeGreaterThan(0);
  });

  it('and is all but over when the clouds are still on their way out', () => {
    const a = new StateAnimator(SNOW);
    for (let i = 0; i < 150; i++) a.step(FAIR, 1 / 60);
    // two and a half seconds: under the amount at which a flake is still
    // drawn at all, with a third of the overcast yet to clear
    expect(a.current.snow).toBeLessThan(0.01);
    expect(a.current.cloudCover - FAIR.cloudCover).toBeGreaterThan(0.1);
  });

  it('and so does rain, gone before it could show against the next sky', () => {
    const RAIN = resolveConditions({ time: 15, weather: 'rain' });
    const starting = new StateAnimator(FAIR);
    const stopping = new StateAnimator(RAIN);
    for (let i = 0; i < 180; i++) { starting.step(RAIN, 1 / 60); stopping.step(FAIR, 1 / 60); }
    // three seconds: a quarter of the way still to come, and next to none left
    expect(RAIN.rain - starting.current.rain).toBeGreaterThan(0.2 * RAIN.rain);
    expect(stopping.current.rain).toBeLessThan(0.005);
    expect(stopping.current.rain).toBeGreaterThan(0);
  });

  it('whatever the frame rate', () => {
    const fine = new StateAnimator(SNOW), coarse = new StateAnimator(SNOW);
    for (let i = 0; i < 120; i++) fine.step(FAIR, 1 / 60);
    for (let i = 0; i < 20; i++) coarse.step(FAIR, 1 / 10);
    expect(coarse.current.snow).toBeCloseTo(fine.current.snow, 10);
  });
});
