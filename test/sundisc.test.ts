import { describe, expect, it } from 'vitest';
import { StateAnimator } from '../src/animator.js';
import { stackSignature } from '../src/skycache.js';
import { resolveConditions } from '../src/state.js';
import { DEFAULT_SUN, DEFAULT_SUN_DISC, TRUE_SUN_DISC, resolveSun, sunShape } from '../src/sundisc.js';

const RAD = Math.PI / 180;

describe('resolveSun', () => {
  it('defaults to the big blown sun the renderer has always drawn', () => {
    expect(resolveSun(undefined)).toEqual({ disc: DEFAULT_SUN_DISC, glare: 1 });
    expect(resolveSun(null)).toEqual(DEFAULT_SUN);
    expect(resolveSun({})).toEqual(DEFAULT_SUN);
    expect(DEFAULT_SUN_DISC).toBeCloseTo(3.39, 2);
  });

  it('clamps the disc to 0.1..10 degrees and the glare to 0..1', () => {
    expect(resolveSun({ disc: TRUE_SUN_DISC }).disc).toBe(0.53);
    expect(resolveSun({ disc: 0 }).disc).toBe(0.1);
    expect(resolveSun({ disc: 40 }).disc).toBe(10);
    expect(resolveSun({ glare: 0.3 }).glare).toBe(0.3);
    expect(resolveSun({ glare: -1 }).glare).toBe(0);
    expect(resolveSun({ glare: 2 }).glare).toBe(1);
  });

  it('returns a fresh object, so the default is never shared', () => {
    const a = resolveSun(undefined);
    a.glare = 0;
    expect(DEFAULT_SUN.glare).toBe(1);
  });
});

describe('sunShape', () => {
  it('is exactly the constants the shader had at the default disc', () => {
    expect(sunShape(DEFAULT_SUN_DISC)).toEqual([900, 400, 0.035]);
  });

  it('puts the flat core\'s edge at half the diameter asked for', () => {
    for (const d of [TRUE_SUN_DISC, 1, DEFAULT_SUN_DISC, 8]) {
      const [k] = sunShape(d);
      const edge = (d / 2) * RAD;
      // (the core is exp(-θ²·k)·2.2, clamped to 1)
      expect(Math.exp(-edge * edge * k) * 2.2).toBeCloseTo(1, 10);
    }
  });

  it('scales the sea\'s disc and the corona\'s limb with it', () => {
    const [k, sea, limb] = sunShape(1);
    expect(sea / k).toBeCloseTo(400 / 900, 12);
    expect(limb).toBeCloseTo(0.035 / DEFAULT_SUN_DISC, 12);
  });
});

describe('sun in the state', () => {
  it('rides along with the rest of the conditions', () => {
    expect(resolveConditions({}).sun).toEqual(DEFAULT_SUN);
    expect(resolveConditions({ sun: { disc: 0.53, glare: 0 } }).sun).toEqual({ disc: 0.53, glare: 0 });
  });

  it('eases rather than cutting, and holds exactly still at the default', () => {
    const a = new StateAnimator(resolveConditions({}));
    a.step(resolveConditions({}), 1 / 30);
    expect(a.current.sun).toEqual(DEFAULT_SUN);
    const target = resolveConditions({ sun: { disc: 0.53, glare: 0 } });
    a.step(target, 1 / 30);
    expect(a.current.sun.disc).toBeLessThan(DEFAULT_SUN_DISC);
    expect(a.current.sun.disc).toBeGreaterThan(0.53);
    expect(a.current.sun.glare).toBeGreaterThan(0);
    for (let i = 0; i < 2000; i++) a.step(target, 1 / 30);
    expect(a.current.sun.disc).toBeCloseTo(0.53, 6);
    expect(a.current.sun.glare).toBeCloseTo(0, 6);
  });

  it('the animator never aliases the target sun', () => {
    const target = resolveConditions({ sun: { glare: 0.5 } });
    const a = new StateAnimator(target);
    a.jump(target);
    a.current.sun.glare = 0;
    expect(target.sun.glare).toBe(0.5);
  });

  it('is not part of what the sky cache\'s cloud stack reads', () => {
    const a = resolveConditions({ weather: 'fair' });
    const b = resolveConditions({ weather: 'fair', sun: { disc: 0.53, glare: 0 } });
    expect(stackSignature(b)).toEqual(stackSignature(a));
  });
});
