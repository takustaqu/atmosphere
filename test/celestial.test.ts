import { describe, expect, it } from 'vitest';
import { StateAnimator } from '../src/animator.js';
import {
  CELESTIAL_PRESETS, DEFAULT_CELESTIAL, isCelestialId, milkyWayFromBortle, resolveCelestial,
} from '../src/celestial.js';
import { resolveConditions } from '../src/state.js';

describe('resolveCelestial', () => {
  it('defaults to the suburban sky the renderer has always drawn', () => {
    expect(resolveCelestial(undefined)).toEqual({ bortle: 6, milkyWay: 0, meteors: 0, radiant: null });
    expect(resolveCelestial(null)).toEqual(resolveCelestial(undefined));
  });

  it('derives the Milky Way from bortle when neither is given', () => {
    // invisible in the suburbs, obvious at a dark site
    expect(resolveCelestial({ bortle: 6 }).milkyWay).toBe(0);
    expect(resolveCelestial({ bortle: 2 }).milkyWay).toBe(1);
    expect(resolveCelestial({ bortle: 4 }).milkyWay).toBeCloseTo(0.4286, 3);
  });

  it('does not overwrite a preset\'s authored Milky Way', () => {
    // perseids is bortle 3 but authored at 0.75, not the derived 0.714
    expect(resolveCelestial('perseids').milkyWay).toBe(0.75);
    expect(resolveCelestial({ id: 'perseids' }).milkyWay).toBe(0.75);
  });

  it('lets an explicit value win over both', () => {
    expect(resolveCelestial({ bortle: 1, milkyWay: 0 }).milkyWay).toBe(0);
  });

  it('clamps bortle to the scale and rejects negative rates', () => {
    expect(resolveCelestial({ bortle: 0 }).bortle).toBe(1);
    expect(resolveCelestial({ bortle: 99 }).bortle).toBe(9);
    expect(resolveCelestial({ meteors: -5 }).meteors).toBe(0);
  });

  it('carries a radiant, and null means sporadic', () => {
    expect(resolveCelestial('perseids').radiant).not.toBeNull();
    expect(resolveCelestial('dark-sky').radiant).toBeNull();
    // explicitly null must override the preset's radiant
    expect(resolveCelestial({ id: 'perseids', radiant: null }).radiant).toBeNull();
  });

  it('copies the radiant array rather than sharing the preset\'s', () => {
    const c = resolveCelestial('perseids');
    expect(c.radiant).not.toBe(CELESTIAL_PRESETS.perseids.radiant);
    expect('label' in c).toBe(false);
    expect(DEFAULT_CELESTIAL.meteors).toBe(0);
  });

  it('falls back for an unknown id', () => {
    expect(resolveCelestial('nope' as never)).toEqual(resolveCelestial(undefined));
  });

  it('isCelestialId', () => {
    expect(isCelestialId('geminids')).toBe(true);
    expect(isCelestialId('rain')).toBe(false);
  });
});

describe('milkyWayFromBortle', () => {
  it('matches naked-eye reality', () => {
    expect(milkyWayFromBortle(1)).toBe(1);
    expect(milkyWayFromBortle(3)).toBeCloseTo(0.714, 3);
    expect(milkyWayFromBortle(5.5)).toBe(0);
    expect(milkyWayFromBortle(9)).toBe(0);
  });
});

describe('celestial in state and animation', () => {
  it('resolves into state, defaulting to a no-op', () => {
    expect(resolveConditions({}).celestial).toEqual(resolveCelestial(undefined));
    expect(resolveConditions({ celestial: 'perseids' }).celestial.meteors).toBe(100);
  });

  it('interpolates the quantities', () => {
    const a = new StateAnimator(resolveConditions({}));
    const target = () => resolveConditions({ celestial: { bortle: 2, meteors: 80 } });
    for (let i = 0; i < 1500; i++) a.step(target(), 1 / 60);
    expect(a.current.celestial.bortle).toBeCloseTo(2, 2);
    expect(a.current.celestial.meteors).toBeCloseTo(80, 1);
  });

  it('cuts the radiant instead of sliding it', () => {
    // a radiant is a place; interpolating it would drag every meteor's origin
    // across the sky mid-shower
    const a = new StateAnimator(resolveConditions({ celestial: 'dark-sky' }));
    a.step(resolveConditions({ celestial: 'perseids' }), 1 / 60);
    expect(a.current.celestial.radiant).toEqual(CELESTIAL_PRESETS.perseids.radiant);
  });

  it('does not let the target drift', () => {
    const t = resolveConditions({ celestial: 'perseids' });
    const a = new StateAnimator(resolveConditions({}));
    for (let i = 0; i < 50; i++) a.step(t, 1 / 60);
    expect(t.celestial.meteors).toBe(100);
    expect(t.celestial.radiant).toEqual(CELESTIAL_PRESETS.perseids.radiant);
  });
});

describe('AtmosphereOptions carries the new axes', () => {
  it('forwards tone, polarizer and celestial from the constructor', async () => {
    // these are on Conditions, which AtmosphereOptions extends — but the class
    // copies named fields rather than spreading, so a new one is easy to drop
    const { Atmosphere } = await import('../src/atmosphere.js');
    const keys = ['time', 'location', 'weather', 'filter', 'tone', 'polarizer', 'celestial', 'camera'];
    const src = Atmosphere.prototype.constructor.toString();
    for (const k of keys) expect(src).toContain(`${k}: options.${k}`);
  });
});
