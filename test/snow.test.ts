import { describe, expect, it } from 'vitest';
import { snowVelocity, snowWindRun } from '../src/renderer.js';

describe('snowVelocity', () => {
  it('is the fall alone in still air', () => {
    expect(snowVelocity(0)).toEqual([-0, -1, 0]);
  });

  it('runs west with the wind, further the harder it blows', () => {
    let last = 0;
    for (const wind of [0.1, 0.3, 0.6, 1]) {
      const v = snowVelocity(wind);
      expect(v[0]).toBeCloseTo(-snowWindRun(wind), 9);
      expect(v[1]).toBe(-1);
      expect(-v[0]).toBeGreaterThan(last);
      last = -v[0];
    }
    // a breath of wind leans the fall a few degrees, a gale lays it nearly flat
    expect(Math.atan(snowWindRun(0.15)) * 180 / Math.PI).toBeLessThan(20);
    expect(Math.atan(snowWindRun(1)) * 180 / Math.PI).toBeGreaterThan(70);
  });

  it('has no part north or south: the shader takes the axis the flakes come down to lie in that plane', () => {
    for (const wind of [0, 0.2, 0.7, 1]) expect(snowVelocity(wind)[2]).toBe(0);
  });
});
