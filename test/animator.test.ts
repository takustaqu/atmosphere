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
