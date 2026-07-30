import { describe, expect, it } from 'vitest';
import { StateAnimator } from '../src/animator.js';
import { NO_POLARIZER, POLARIZER_PRESETS, isPolarizerId, resolvePolarizer } from '../src/polarizer.js';
import { resolveConditions } from '../src/state.js';
import { NEUTRAL_TONE, TONE_PRESETS, isToneId, resolveTone } from '../src/tone.js';

describe('resolveTone', () => {
  it('defaults to neutral', () => {
    expect(resolveTone(undefined)).toEqual({ exposure: 0, contrast: 1, knee: 0.8, bleach: 0 });
    expect(resolveTone(null)).toEqual(resolveTone(undefined));
  });

  it('resolves a preset by id', () => {
    expect(resolveTone('filmic').bleach).toBe(TONE_PRESETS.filmic.bleach);
  });

  it('adjusts a preset', () => {
    const t = resolveTone({ id: 'filmic', exposure: 0.5 });
    expect(t.exposure).toBe(0.5);
    expect(t.contrast).toBe(TONE_PRESETS.filmic.contrast);
  });

  it('takes bare values on top of neutral', () => {
    expect(resolveTone({ contrast: 1.3 })).toEqual({ exposure: 0, contrast: 1.3, knee: 0.8, bleach: 0 });
  });

  it('falls back to neutral for an unknown id', () => {
    expect(resolveTone('nope' as never)).toEqual(resolveTone(undefined));
  });

  it('keeps the knee off both floor and ceiling', () => {
    // a knee at 0 would put the shoulder on black and crush everything
    expect(resolveTone({ knee: 0 }).knee).toBeGreaterThan(0);
    expect(resolveTone({ knee: 5 }).knee).toBeLessThan(1);
  });

  it('clamps bleach to 0..1', () => {
    expect(resolveTone({ bleach: -3 }).bleach).toBe(0);
    expect(resolveTone({ bleach: 9 }).bleach).toBe(1);
  });

  it('returns a fresh object, not the preset', () => {
    const t = resolveTone('punch');
    expect(t).not.toBe(TONE_PRESETS.punch);
    t.exposure = 99;
    expect(TONE_PRESETS.punch.exposure).not.toBe(99);
    expect(NEUTRAL_TONE.exposure).toBe(0);
  });

  it('has no label leaking out of the preset', () => {
    expect('label' in resolveTone('flat')).toBe(false);
  });

  it('isToneId', () => {
    expect(isToneId('filmic')).toBe(true);
    expect(isToneId('sepia')).toBe(false);
    expect(isToneId(3)).toBe(false);
  });
});

describe('resolvePolarizer', () => {
  it('defaults to none', () => {
    expect(resolvePolarizer(undefined).strength).toBe(0);
    expect(resolvePolarizer(false).strength).toBe(0);
    expect(resolvePolarizer(null).strength).toBe(0);
  });

  it('true is a light CPL (the shorthand)', () => {
    expect(resolvePolarizer(true).strength).toBe(POLARIZER_PRESETS.light.strength);
  });

  it('resolves and adjusts presets', () => {
    expect(resolvePolarizer('strong').strength).toBe(0.85);
    const p = resolvePolarizer({ id: 'strong', angle: 0.4 });
    expect(p.angle).toBe(0.4);
    expect(p.strength).toBe(0.85);
  });

  it('clamps strength and saturation but not angle', () => {
    expect(resolvePolarizer({ strength: 3 }).strength).toBe(1);
    expect(resolvePolarizer({ saturation: -1 }).saturation).toBe(0);
    // angle stays raw so the animator can rotate it along the shorter arc
    expect(resolvePolarizer({ angle: 99 }).angle).toBe(99);
  });

  it('applies no stop loss by default', () => {
    // emulating the 1.3-stop bite without emulating the exposure compensation
    // just makes the picture dark, so it is opt-in
    for (const p of Object.values(POLARIZER_PRESETS)) expect(p.stopLoss).toBe(0);
  });

  it('returns a fresh object, not the preset', () => {
    const p = resolvePolarizer('light');
    expect(p).not.toBe(POLARIZER_PRESETS.light);
    expect('label' in p).toBe(false);
    expect(NO_POLARIZER.strength).toBe(0);
  });

  it('isPolarizerId', () => {
    expect(isPolarizerId('crossed')).toBe(true);
    expect(isPolarizerId('mono')).toBe(false);
  });
});

describe('conditions carry tone and polarizer', () => {
  it('resolves both into state', () => {
    const s = resolveConditions({ tone: 'punch', polarizer: 'strong' });
    expect(s.tone.contrast).toBe(TONE_PRESETS.punch.contrast);
    expect(s.polarizer.strength).toBe(0.85);
  });

  it('defaults both when omitted', () => {
    const s = resolveConditions({});
    expect(s.tone).toEqual(resolveTone(undefined));
    expect(s.polarizer.strength).toBe(0);
  });
});

describe('animating tone and polarizer', () => {
  const target = () => resolveConditions({ tone: { exposure: 1, contrast: 1.4, knee: 0.4, bleach: 1 }, polarizer: 'strong' });

  it('moves toward the target', () => {
    const a = new StateAnimator(resolveConditions({}));
    // the animator eases exponentially, so give it enough frames to settle
    // (400 frames only reaches ~0.95 of the way)
    for (let i = 0; i < 1500; i++) a.step(target(), 1 / 60);
    expect(a.current.tone.exposure).toBeCloseTo(1, 2);
    expect(a.current.tone.knee).toBeCloseTo(0.4, 2);
    expect(a.current.polarizer.strength).toBeCloseTo(0.85, 2);
  });

  it('rotates the polarizer along the shorter arc over 180 degrees', () => {
    // 170deg -> 10deg should cross through 180/0, not sweep back through 90
    const from = resolveConditions({ polarizer: { strength: 1, angle: (170 * Math.PI) / 180 } });
    const to = resolveConditions({ polarizer: { strength: 1, angle: (10 * Math.PI) / 180 } });
    const a = new StateAnimator(from);
    a.step(to, 1 / 60);
    const deg = (a.current.polarizer.angle * 180) / Math.PI;
    expect(deg).toBeGreaterThan(170);
  });

  it('does not let the target drift (nested state is copied)', () => {
    const t = target();
    const a = new StateAnimator(resolveConditions({}));
    for (let i = 0; i < 50; i++) a.step(t, 1 / 60);
    expect(t.tone.exposure).toBe(1);
    expect(t.polarizer.strength).toBe(0.85);
  });
});
