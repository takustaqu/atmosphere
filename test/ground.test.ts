import { describe, expect, it } from 'vitest';
import { StateAnimator } from '../src/animator.js';
import { DEFAULT_GROUND, GROUND_PRESETS, isGroundId, resolveGround } from '../src/ground.js';
import { resolveConditions } from '../src/state.js';

describe('resolveGround', () => {
  it('is the plain ground by default, which is what the renderer has always drawn', () => {
    expect(resolveGround(undefined)).toEqual({ sea: 0, swell: 0.4 });
    expect(resolveGround(null)).toEqual(DEFAULT_GROUND);
    expect(resolveGround('land')).toEqual(DEFAULT_GROUND);
  });

  it("'sea' is open water with a light swell", () => {
    expect(resolveGround('sea')).toEqual({ sea: 1, swell: 0.4 });
  });

  it('an object means the sea unless it says otherwise', () => {
    expect(resolveGround({})).toEqual({ sea: 1, swell: 0.4 });
    expect(resolveGround({ swell: 0.9 })).toEqual({ sea: 1, swell: 0.9 });
    expect(resolveGround({ sea: 0.5 })).toEqual({ sea: 0.5, swell: 0.4 });
  });

  it('clamps both to 0..1', () => {
    expect(resolveGround({ sea: 3, swell: -1 })).toEqual({ sea: 1, swell: 0 });
  });

  it('returns a fresh object, so neither the default nor a preset is ever shared', () => {
    const a = resolveGround('sea');
    a.swell = 0;
    expect(GROUND_PRESETS.sea.swell).toBe(0.4);
    const b = resolveGround(undefined);
    b.sea = 1;
    expect(DEFAULT_GROUND.sea).toBe(0);
  });

  it('knows its preset names', () => {
    expect(isGroundId('sea')).toBe(true);
    expect(isGroundId('ocean')).toBe(false);
  });
});

describe('ground in the state', () => {
  it('rides along with the rest of the conditions', () => {
    expect(resolveConditions({ weather: 'clear' }).ground).toEqual(DEFAULT_GROUND);
    expect(resolveConditions({ ground: 'sea' }).ground.sea).toBe(1);
  });

  it('eases in rather than cutting, so the water rises over the ground', () => {
    const a = new StateAnimator(resolveConditions({}));
    const target = resolveConditions({ ground: { swell: 1 } });
    a.step(target, 1 / 30);
    expect(a.current.ground.sea).toBeGreaterThan(0);
    expect(a.current.ground.sea).toBeLessThan(1);
    expect(a.current.ground.swell).toBeGreaterThan(0.4);
    for (let i = 0; i < 2000; i++) a.step(target, 1 / 30);
    expect(a.current.ground.sea).toBeCloseTo(1, 6);
    expect(a.current.ground.swell).toBeCloseTo(1, 6);
  });

  it('the animator never aliases the target ground', () => {
    const target = resolveConditions({ ground: 'sea' });
    const a = new StateAnimator(target);
    a.jump(target);
    a.current.ground.sea = 0;
    expect(target.ground.sea).toBe(1);
  });
});
