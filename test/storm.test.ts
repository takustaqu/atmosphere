import { describe, expect, it } from 'vitest';
import { TURRET_SLOTS, cbScale, turretTable } from '../src/storm.js';

// what the shader's turretThrust reads back from two bytes
const read = (t: Uint8Array, row: number, id: number, hi: number) => {
  const o = (row * TURRET_SLOTS + id) * 4 + hi;
  return t[o] / 255 + t[o + 1] / 255 / 255;
};

describe('turretTable', () => {
  it('matches the shader at the middle distance: forty turrets, scale 1', () => {
    expect(cbScale(0.65)).toBe(1);
    const t = turretTable(0.65, 7.3);
    expect(t.length).toBe(TURRET_SLOTS * 2 * 4);
    for (const id of [0, 7, 39]) {
      const now = read(t, 0, id, 0);
      // an fbm4 of value noise: within its four octaves' reach
      expect(now).toBeGreaterThan(0);
      expect(now).toBeLessThan(0.9375);
    }
  });

  it('moves smoothly with the storm\'s clock, a frame at a time', () => {
    // one frame of the default evolution at 30 fps: no turret's thrust may
    // jump — the staircase this table replaced stood still, then stepped
    const dEvo = 0.07 / 30;
    let worst = 0, moved = 0;
    let prev = turretTable(0.65, 11);
    for (let f = 1; f <= 60; f++) {
      const cur = turretTable(0.65, 11 + f * dEvo);
      for (let id = 0; id < 40; id++) {
        const d = Math.abs(read(cur, 0, id, 0) - read(prev, 0, id, 0));
        worst = Math.max(worst, d);
        if (d > 0) moved++;
      }
      prev = cur;
    }
    expect(worst).toBeLessThan(0.002);
    // and they do move, nearly every turret nearly every frame
    expect(moved).toBeGreaterThan(0.9 * 60 * 40);
  });

  it('keeps the past and the skirt in their own slots', () => {
    const t = turretTable(0.3, 20);
    const n = 72 * cbScale(0.3);
    for (let id = 0; id < Math.ceil(n); id++) {
      const skirt = read(t, 1, id, 0);
      expect(skirt).toBeGreaterThanOrEqual(0);
      expect(skirt).toBeLessThan(0.75);
    }
    // the past differs from the present by the coarse pair's drift only
    let differ = 0;
    for (let id = 0; id < 20; id++) if (read(t, 0, id, 0) !== read(t, 0, id, 2)) differ++;
    expect(differ).toBeGreaterThan(10);
  });
});
