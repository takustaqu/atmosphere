import { describe, expect, it } from 'vitest';
import { TURRET_ROWS, TURRET_SLOTS, cbReach, cbScale, cbShape, stormAmount, turretTable } from '../src/storm.js';

// what the shader's turretThrust and rowTurret read back from two bytes
const read = (t: Uint8Array, row: number, id: number, hi: number) => {
  const o = (row * TURRET_SLOTS + id) * 4 + hi;
  return t[o] / 255 + t[o + 1] / 255 / 255;
};
// a turret's height, as rowTurret reads it (stored halved)
const height = (t: Uint8Array, row: number, id: number) => read(t, row, id, 0) * 2;

describe('turretTable', () => {
  it('matches the shader at the middle distance: forty turrets, scale 1', () => {
    expect(cbScale(0.65)).toBe(1);
    const t = turretTable(0.65, 7.3);
    expect(t.length).toBe(TURRET_SLOTS * TURRET_ROWS * 4);
    for (const id of [0, 7, 39]) {
      const now = read(t, 0, id, 0);
      // an fbm4 of value noise: within its four octaves' reach
      expect(now).toBeGreaterThan(0);
      expect(now).toBeLessThan(0.9375);
    }
  });

  it('moves smoothly with the storm\'s clock, a frame at a time', () => {
    // one frame of the default evolution at 30 fps: no turret's thrust or
    // height may jump — the staircase this table replaced stood still, then
    // stepped
    const dEvo = 0.07 / 30;
    let worst = 0, worstH = 0, moved = 0;
    let prev = turretTable(0.65, 11);
    for (let f = 1; f <= 60; f++) {
      const cur = turretTable(0.65, 11 + f * dEvo);
      for (let id = 0; id < 40; id++) {
        const d = Math.abs(read(cur, 0, id, 0) - read(prev, 0, id, 0));
        worst = Math.max(worst, d);
        worstH = Math.max(worstH, Math.abs(height(cur, 1, id) - height(prev, 1, id)));
        if (d > 0) moved++;
      }
      prev = cur;
    }
    expect(worst).toBeLessThan(0.002);
    // (a pixel of a wide view is some 6e-4 of the storm's sky)
    expect(worstH).toBeLessThan(0.002);
    // and they do move, nearly every turret nearly every frame
    expect(moved).toBeGreaterThan(0.9 * 60 * 40);
  });

  it('keeps the past, the turrets and the skirt in their own slots', () => {
    const amount = 0.6;
    const t = turretTable(0.3, 20, amount);
    const n = 72 * cbScale(0.3), nT = 40 * cbScale(0.3);
    // the skirt stands no higher than its gain
    const skGain = 0.20 * (0.6 + 0.4 * amount);
    for (let id = 0; id < Math.ceil(n); id++) {
      const skirt = height(t, 2, id);
      expect(skirt).toBeGreaterThanOrEqual(0);
      expect(skirt).toBeLessThanOrEqual(skGain + 1e-4);
      // the center lies in its own cell
      expect(read(t, 2, id, 2)).toBeLessThan(1);
    }
    // a tower's turret stands no higher than its thrust carries it, nor
    // lower than three quarters of the way there (its clock), but in the
    // narrow cell that closes the row
    const ceil = 0.44 + 0.11 * amount;
    for (let id = 0; id < Math.floor(nT); id++) {
      const thrust = read(t, 0, id, 0);
      const top = cbShape(cbReach(Math.pow(Math.max(thrust - 0.42, 0) * 4.6, 1.5) * (1.05 + 1.35 * amount) + 0.25), ceil);
      expect(height(t, 1, id)).toBeLessThanOrEqual(top + 1e-3);
      expect(height(t, 1, id)).toBeGreaterThanOrEqual(top * 0.74 - 1e-3);
    }
    // the past differs from the present by the coarse pair's drift only
    let differ = 0;
    for (let id = 0; id < 20; id++) if (read(t, 0, id, 0) !== read(t, 0, id, 2)) differ++;
    expect(differ).toBeGreaterThan(10);
  });

  it('takes the storm\'s size as the shader does', () => {
    expect(stormAmount(0.8, 0, 0, 0)).toBeCloseTo(0.8);
    // held at a third below that, and less under the weather's gloom
    expect(stormAmount(0.1, 0, 0, 0)).toBeCloseTo(0.3);
    expect(stormAmount(0.8, 1, 0, 0)).toBeCloseTo(0.32);
    // a bigger storm stands taller wherever the thrust carries a turret at
    // all (and the rest at the same low stub)
    const lo = turretTable(0.65, 7.3, 0.3), hi = turretTable(0.65, 7.3, 1);
    let taller = 0;
    for (let id = 0; id < 40; id++) {
      expect(height(hi, 1, id)).toBeGreaterThanOrEqual(height(lo, 1, id) - 1e-4);
      if (height(hi, 1, id) > height(lo, 1, id) + 0.01) taller++;
    }
    expect(taller).toBeGreaterThan(3);
  });
});
