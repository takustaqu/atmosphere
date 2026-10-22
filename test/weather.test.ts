import { describe, expect, it } from 'vitest';
import { resolveWeather, WEATHER_PRESETS, type WeatherId } from '../src/weather';
import { aggregateCover, DEFAULT_CB_DISTANCE, DEFAULT_CB_SOFTNESS, defaultCloudFeatures, resolveClouds } from '../src/clouds';

describe('resolveWeather precipitation', () => {
  it('rain saturates at 30mm/h and stays saturated beyond', () => {
    expect(resolveWeather({ precipitation: 30 }).rain).toBe(1);
    expect(resolveWeather({ precipitation: 60 }).rain).toBe(1);
  });

  it('no precipitation means no rain', () => {
    expect(resolveWeather({ precipitation: 0 }).rain).toBe(0);
    expect(resolveWeather({}).rain).toBe(0);
  });

  it('intermediate rates fall strictly between 0 and 1', () => {
    const { rain } = resolveWeather({ precipitation: 15 });
    expect(rain).toBeGreaterThan(0);
    expect(rain).toBeLessThan(1);
  });
});

describe('resolveWeather wind', () => {
  it('wind saturates at 33m/s (typhoon force)', () => {
    expect(resolveWeather({ windSpeed: 33 }).wind).toBe(1);
    expect(resolveWeather({ windSpeed: 50 }).wind).toBe(1);
  });

  it('a moderate breeze stays below 1', () => {
    const { wind } = resolveWeather({ windSpeed: 10 });
    expect(wind).toBeGreaterThan(0);
    expect(wind).toBeLessThan(1);
  });
});

describe('resolveWeather snow', () => {
  it("precipitationType 'snow' routes precipitation to snow, not rain", () => {
    const state = resolveWeather({ precipitation: 3, precipitationType: 'snow' });
    expect(state.rain).toBe(0);
    expect(state.snow).toBeGreaterThan(0);
  });

  it('snow saturates already at 5mm/h water equivalent', () => {
    expect(resolveWeather({ precipitation: 5, precipitationType: 'snow' }).snow).toBe(1);
    expect(resolveWeather({ precipitation: 20, precipitationType: 'snow' }).snow).toBe(1);
  });
});

describe('resolveWeather haze', () => {
  it('default visibility (30km) yields zero haze', () => {
    expect(resolveWeather({}).haze).toBe(0);
  });

  it('0.6km visibility (fog) yields heavy haze', () => {
    expect(resolveWeather({ visibility: 0.6 }).haze).toBeGreaterThan(0.9);
  });
});

describe('resolveWeather presets', () => {
  it('a preset name resolves to the same state as the preset observation', () => {
    expect(resolveWeather('typhoon')).toEqual(resolveWeather(WEATHER_PRESETS.typhoon));
  });

  it('typhoon rain (40mm/h) is saturated', () => {
    expect(resolveWeather('typhoon').rain).toBe(1);
  });

  it('an unknown preset name falls back to clear', () => {
    expect(resolveWeather('blizzard' as WeatherId)).toEqual(resolveWeather('clear'));
  });
});

describe('resolveWeather cloud genera priority', () => {
  it('cloudCover is derived from the given genera, overriding an explicit cloudCover', () => {
    const state = resolveWeather({ cloudCover: 0.9, clouds: { cirrus: 1 } });
    // aggregateCover of cirrus alone is its opacity (0.15), not the 0.9 passed in
    expect(state.cloudCover).toBeCloseTo(aggregateCover(resolveClouds({ cirrus: 1 })), 10);
    expect(state.cloudCover).toBeCloseTo(0.15, 10);
  });

  it('convection is ignored once clouds are given', () => {
    const state = resolveWeather({ clouds: ['cumulus'], convection: 1 });
    expect(state.clouds.cumulonimbus).toBe(0);
  });

  it('without clouds, convection does raise cumulonimbus', () => {
    const state = resolveWeather({ cloudCover: 0.5, convection: 1 });
    expect(state.clouds.cumulonimbus).toBeGreaterThan(0);
  });
});

describe('resolveWeather cumulonimbus features', () => {
  it('without features the storm stands at the default distance', () => {
    expect(resolveWeather({ convection: 0.9, cloudCover: 0.3 }).features.distance).toBe(DEFAULT_CB_DISTANCE);
    expect(resolveWeather('thunderstorm').features.distance).toBe(DEFAULT_CB_DISTANCE);
  });

  it('a distance alone keeps the forms derived from the development', () => {
    const w = { convection: 1, cloudCover: 0.3 };
    const auto = resolveWeather(w).features;
    const near = resolveWeather({ ...w, features: { distance: 0.1 } }).features;
    expect(near.distance).toBe(0.1);
    expect(near.anvil).toBe(auto.anvil);
    expect(near.velum).toBe(auto.velum);
    expect(auto.anvil).toBe(defaultCloudFeatures(resolveWeather(w).clouds.cumulonimbus).anvil);
  });

  it('the distance is clamped to 0..1', () => {
    expect(resolveWeather({ features: { distance: -2 } }).features.distance).toBe(0);
    expect(resolveWeather({ features: { distance: 7 } }).features.distance).toBe(1);
  });

  it('the softness defaults, is kept apart from the forms, and is clamped to 0..1', () => {
    expect(resolveWeather('thunderstorm').features.softness).toBe(DEFAULT_CB_SOFTNESS);
    const w = { convection: 1, cloudCover: 0.3 };
    const soft = resolveWeather({ ...w, features: { softness: 1 } }).features;
    expect(soft.softness).toBe(1);
    expect(soft.anvil).toBe(resolveWeather(w).features.anvil);
    expect(soft.distance).toBe(DEFAULT_CB_DISTANCE);
    expect(resolveWeather({ features: { softness: -1 } }).features.softness).toBe(0);
    expect(resolveWeather({ features: { softness: 3 } }).features.softness).toBe(1);
  });
});
