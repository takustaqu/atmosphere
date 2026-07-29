import { describe, expect, it } from 'vitest';
import { DEFAULT_CAMERA, resolveCamera, resolveConditions } from '../src/state';
import { FILTER_PRESETS, resolveFilter, type FilterId } from '../src/filter';
import { nominalSolarPosition, solarPosition } from '../src/sun';

const TOKYO = { latitude: 35.68, longitude: 139.77 };

describe('resolveConditions', () => {
  it('defaults to noon under a clear sky', () => {
    const s = resolveConditions({});
    expect(s.timeOfDay).toBe(12);
    expect(s.cloudCover).toBe(0);
    expect(s.rain).toBe(0);
  });

  it('without a location the sun follows the nominal arc', () => {
    const s = resolveConditions({ time: 12 });
    expect(s.sunElevation).toBeCloseTo(Math.asin(0.72), 12);
    expect(s.sunAzimuth).toBeCloseTo(Math.PI, 12);
  });

  it('a location plus a Date gives the real solar position', () => {
    const date = new Date('2026-06-21T11:43+09:00');
    const s = resolveConditions({ time: date, location: TOKYO });
    const real = solarPosition(date, TOKYO);
    expect(s.sunElevation).toBe(real.elevation);
    expect(s.sunAzimuth).toBe(real.azimuth);
  });

  it('a location without a Date still falls back to the nominal arc', () => {
    // a bare number carries no date, so there is nothing to place the sun with
    const s = resolveConditions({ time: 12, location: TOKYO });
    expect(s.sunElevation).toBeCloseTo(nominalSolarPosition(12).elevation, 12);
    expect(s.sunAzimuth).toBeCloseTo(nominalSolarPosition(12).azimuth, 12);
  });

  it('a null location behaves like no location at all', () => {
    const date = new Date('2026-06-21T11:43+09:00');
    const s = resolveConditions({ time: date, location: null });
    expect(s.sunElevation).toBeCloseTo(nominalSolarPosition(s.timeOfDay).elevation, 12);
  });

  it('the weather is folded into the same flat state', () => {
    const s = resolveConditions({ time: 12, weather: 'typhoon' });
    expect(s.rain).toBe(1);
    expect(s.wind).toBeGreaterThan(0.9);
    expect(s.cloudCover).toBe(1);
    // a fully covered, raining sky is nimbostratus
    expect(s.clouds.nimbostratus).toBe(1);
  });
});

describe('resolveFilter', () => {
  it('a preset name resolves to that preset grading', () => {
    const f = resolveFilter('sepia');
    expect(f.amount).toBe(FILTER_PRESETS.sepia.amount);
    expect(f.tint).toEqual(FILTER_PRESETS.sepia.tint);
    expect(f.saturation).toBe(FILTER_PRESETS.sepia.saturation);
    expect(f.lift).toBe(FILTER_PRESETS.sepia.lift);
  });

  it('does not hand back the shared preset object', () => {
    expect(resolveFilter('sepia')).not.toBe(FILTER_PRESETS.sepia);
  });

  it('an id with overrides keeps the preset and applies the override', () => {
    const f = resolveFilter({ id: 'sepia', amount: 0.6 });
    expect(f.amount).toBe(0.6);
    expect(f.tint).toEqual(FILTER_PRESETS.sepia.tint);
    expect(f.saturation).toBe(FILTER_PRESETS.sepia.saturation);
    expect(f.lift).toBe(FILTER_PRESETS.sepia.lift);
  });

  it('false, null and undefined disable the filter', () => {
    for (const input of [false, null, undefined] as const) {
      const f = resolveFilter(input);
      expect(f.amount).toBe(0);
      expect(f.tint).toEqual([1, 1, 1]);
      expect(f.saturation).toBe(1);
      expect(f.lift).toBe(0);
    }
  });

  it('true is the old `sepia: true` shorthand', () => {
    const f = resolveFilter(true);
    expect(f.amount).toBe(FILTER_PRESETS.sepia.amount);
    expect(f.tint).toEqual(FILTER_PRESETS.sepia.tint);
    expect(f.saturation).toBe(FILTER_PRESETS.sepia.saturation);
  });

  it('an unknown preset name disables the filter', () => {
    expect(resolveFilter('daguerreotype' as FilterId).amount).toBe(0);
  });

  it('a bare tint with no id just tints the luminance at full strength', () => {
    const f = resolveFilter({ tint: [0.5, 0.6, 0.7] });
    expect(f.amount).toBe(1);
    expect(f.saturation).toBe(0);
    expect(f.lift).toBe(0);
    expect(f.tint).toEqual([0.5, 0.6, 0.7]);
  });
});

describe('resolveCamera', () => {
  it('fills a partial camera in from the default framing', () => {
    expect(resolveCamera({ fov: 1.2 })).toEqual({ ...DEFAULT_CAMERA, fov: 1.2 });
    expect(resolveCamera({ yaw: 0 })).toEqual({ ...DEFAULT_CAMERA, yaw: 0 });
  });

  it('nothing given is the default framing', () => {
    expect(resolveCamera()).toEqual(DEFAULT_CAMERA);
    expect(resolveCamera(null)).toEqual(DEFAULT_CAMERA);
  });

  it('does not hand back the shared DEFAULT_CAMERA object', () => {
    expect(resolveCamera()).not.toBe(DEFAULT_CAMERA);
  });
});

describe('resolveFilter hygiene', () => {
  it('returns a plain ColorFilter — no preset label leaks through any input form', () => {
    for (const input of ['sepia', { id: 'sepia' as const }, true, false, null] as const) {
      expect(Object.keys(resolveFilter(input)).sort())
        .toEqual(['amount', 'lift', 'saturation', 'tint']);
    }
  });

  it('every form agrees: the preset name and { id } resolve identically', () => {
    expect(resolveFilter('sepia')).toEqual(resolveFilter({ id: 'sepia' }));
    expect(resolveFilter(true)).toEqual(resolveFilter('sepia'));
  });

  it('does not hand back the preset tint array, nor share it between calls', () => {
    const a = resolveFilter('sepia');
    const b = resolveFilter('sepia');
    expect(a.tint).not.toBe(FILTER_PRESETS.sepia.tint);
    expect(a.tint).not.toBe(b.tint);
    expect(a.tint).toEqual(FILTER_PRESETS.sepia.tint);
  });
});
