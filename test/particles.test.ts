import { describe, expect, it } from 'vitest';
import { StateAnimator } from '../src/animator.js';
import { DEFAULT_PARTICLES, resolveParticles } from '../src/particles.js';
import { resolveConditions } from '../src/state.js';

describe('resolveParticles', () => {
  it('keeps the rain and snow on by default, which is what the renderer has always drawn', () => {
    expect(resolveParticles(undefined)).toEqual({ precipitation: 1 });
    expect(resolveParticles(null)).toEqual(DEFAULT_PARTICLES);
    expect(resolveParticles({})).toEqual(DEFAULT_PARTICLES);
  });

  it('takes a boolean as on / off', () => {
    expect(resolveParticles({ precipitation: false }).precipitation).toBe(0);
    expect(resolveParticles({ precipitation: true }).precipitation).toBe(1);
  });

  it('takes a number as a strength, clamped to 0..1', () => {
    expect(resolveParticles({ precipitation: 0.4 }).precipitation).toBe(0.4);
    expect(resolveParticles({ precipitation: -1 }).precipitation).toBe(0);
    expect(resolveParticles({ precipitation: 3 }).precipitation).toBe(1);
  });

  it('returns a fresh object, so the default is never shared', () => {
    const a = resolveParticles(undefined);
    a.precipitation = 0;
    expect(DEFAULT_PARTICLES.precipitation).toBe(1);
  });
});

describe('particles in the state', () => {
  it('rides along with the rest of the conditions', () => {
    expect(resolveConditions({ weather: 'snow' }).particles.precipitation).toBe(1);
    expect(resolveConditions({ weather: 'snow', particles: { precipitation: false } }).particles.precipitation).toBe(0);
  });

  it('leaves the weather alone: only the drawing of what falls is switched', () => {
    const on = resolveConditions({ weather: 'snow' });
    const off = resolveConditions({ weather: 'snow', particles: { precipitation: false } });
    expect(off.snow).toBe(on.snow);
    expect(off.rain).toBe(on.rain);
    expect(off.cloudCover).toBe(on.cloudCover);
  });

  it('eases off rather than cutting, so the rain thins out', () => {
    const a = new StateAnimator(resolveConditions({ weather: 'rain' }));
    const target = resolveConditions({ weather: 'rain', particles: { precipitation: false } });
    a.step(target, 1 / 30);
    expect(a.current.particles.precipitation).toBeGreaterThan(0);
    expect(a.current.particles.precipitation).toBeLessThan(1);
    for (let i = 0; i < 2000; i++) a.step(target, 1 / 30);
    expect(a.current.particles.precipitation).toBeCloseTo(0, 6);
  });

  it('the animator never aliases the target particles', () => {
    const target = resolveConditions({ particles: { precipitation: 0.5 } });
    const a = new StateAnimator(target);
    a.jump(target);
    a.current.particles.precipitation = 0;
    expect(target.particles.precipitation).toBe(0.5);
  });
});
