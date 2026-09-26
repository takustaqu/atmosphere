import { describe, expect, it } from 'vitest';
import { StateAnimator } from '../src/animator.js';
import { DEFAULT_LENS, resolveLens } from '../src/lens.js';
import { resolveConditions } from '../src/state.js';

describe('resolveLens', () => {
  it('keeps the droplets on by default, which is what the renderer has always drawn', () => {
    expect(resolveLens(undefined)).toEqual({ droplets: 1 });
    expect(resolveLens(null)).toEqual(DEFAULT_LENS);
    expect(resolveLens({})).toEqual(DEFAULT_LENS);
  });

  it('takes a boolean as on / off', () => {
    expect(resolveLens({ droplets: false }).droplets).toBe(0);
    expect(resolveLens({ droplets: true }).droplets).toBe(1);
  });

  it('takes a number as a strength, clamped to 0..1', () => {
    expect(resolveLens({ droplets: 0.4 }).droplets).toBe(0.4);
    expect(resolveLens({ droplets: -1 }).droplets).toBe(0);
    expect(resolveLens({ droplets: 3 }).droplets).toBe(1);
  });

  it('returns a fresh object, so the default is never shared', () => {
    const a = resolveLens(undefined);
    a.droplets = 0;
    expect(DEFAULT_LENS.droplets).toBe(1);
  });
});

describe('lens in the state', () => {
  it('rides along with the rest of the conditions', () => {
    expect(resolveConditions({ weather: 'rain' }).lens.droplets).toBe(1);
    expect(resolveConditions({ weather: 'rain', lens: { droplets: false } }).lens.droplets).toBe(0);
  });

  it('eases off rather than cutting, so the droplets dry away', () => {
    const a = new StateAnimator(resolveConditions({ weather: 'rain' }));
    const target = resolveConditions({ weather: 'rain', lens: { droplets: false } });
    a.step(target, 1 / 30);
    expect(a.current.lens.droplets).toBeGreaterThan(0);
    expect(a.current.lens.droplets).toBeLessThan(1);
    for (let i = 0; i < 2000; i++) a.step(target, 1 / 30);
    expect(a.current.lens.droplets).toBeCloseTo(0, 6);
  });

  it('the animator never aliases the target lens', () => {
    const target = resolveConditions({ lens: { droplets: 0.5 } });
    const a = new StateAnimator(target);
    a.jump(target);
    a.current.lens.droplets = 0;
    expect(target.lens.droplets).toBe(0.5);
  });
});
