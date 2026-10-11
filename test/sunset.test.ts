import { describe, expect, it } from 'vitest';
import { StateAnimator } from '../src/animator.js';
import { DEFAULT_SUNSET, resolveSunset } from '../src/sunset.js';
import { resolveConditions } from '../src/state.js';

describe('resolveSunset', () => {
  it('defaults to 1 and 1, the sunset the renderer draws on its own', () => {
    expect(resolveSunset(undefined)).toEqual({ warmth: 1, glow: 1 });
    expect(resolveSunset(null)).toEqual(DEFAULT_SUNSET);
    expect(resolveSunset({})).toEqual(DEFAULT_SUNSET);
  });

  it('takes either field alone and clamps both to 0..2', () => {
    expect(resolveSunset({ warmth: 1.4 })).toEqual({ warmth: 1.4, glow: 1 });
    expect(resolveSunset({ glow: 0.3 })).toEqual({ warmth: 1, glow: 0.3 });
    expect(resolveSunset({ warmth: 5, glow: -1 })).toEqual({ warmth: 2, glow: 0 });
  });

  it('rides the state and eases like the rest', () => {
    expect(resolveConditions({}).sunset).toEqual(DEFAULT_SUNSET);
    const a = new StateAnimator(resolveConditions({}));
    a.step(resolveConditions({ sunset: { warmth: 2 } }), 1 / 30);
    expect(a.current.sunset.warmth).toBeGreaterThan(1);
    expect(a.current.sunset.warmth).toBeLessThan(2);
  });
});
