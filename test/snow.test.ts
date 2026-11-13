import { describe, expect, it } from 'vitest';
import { snowFallDir, snowVelocity, snowWindRun } from '../src/renderer.js';

const forward = (yaw: number, pitch: number) =>
  [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('snowFallDir', () => {
  it('falls straight down for a level view', () => {
    const d = snowFallDir({ yaw: 1.1, pitch: 0 });
    expect(d[0]).toBeCloseTo(0, 9);
    expect(d[1]).toBeCloseTo(-1, 9);
    expect(d[2]).toBeCloseTo(0, 9);
  });

  it('is a unit vector that still falls', () => {
    for (const pitch of [-0.3, 0.2, 0.46, 0.9, 1.3, Math.PI / 2]) {
      const d = snowFallDir({ yaw: 2.4, pitch });
      expect(Math.hypot(...d)).toBeCloseTo(1, 9);
      expect(d[1]).toBeLessThan(0);
    }
  });

  it('runs nearly square to a tilted view, where straight down would not', () => {
    const yaw = Math.PI, pitch = 0.46; // the default framing
    const along = Math.abs(dot(snowFallDir({ yaw, pitch }), forward(yaw, pitch)));
    const down = Math.abs(dot([0, -1, 0], forward(yaw, pitch)));
    expect(along).toBeLessThan(down * 0.2);
  });

  it('comes at the camera looking straight up', () => {
    const d = snowFallDir({ yaw: 0, pitch: Math.PI / 2 });
    expect(d[1]).toBeCloseTo(-1, 6);
  });
});

describe('snowVelocity', () => {
  it('is the fall alone in still air', () => {
    for (const cam of [{ yaw: 1.1, pitch: 0 }, { yaw: Math.PI, pitch: 0.46 }, { yaw: 0.3, pitch: 1.2 }]) {
      const v = snowVelocity(cam, 0), d = snowFallDir(cam);
      for (let i = 0; i < 3; i++) expect(v[i]).toBeCloseTo(d[i], 12);
    }
  });

  it('runs west with the wind, further the harder it blows', () => {
    // looking south, across the wind: all of its run shows
    const cam = { yaw: Math.PI, pitch: 0 };
    let last = 0;
    for (const wind of [0.1, 0.3, 0.6, 1]) {
      const v = snowVelocity(cam, wind);
      expect(v[0]).toBeCloseTo(-snowWindRun(wind), 9);
      expect(v[1]).toBeCloseTo(-1, 9);
      expect(-v[0]).toBeGreaterThan(last);
      last = -v[0];
    }
    // a breath of wind leans the fall a few degrees, a gale lays it nearly flat
    expect(Math.atan(snowWindRun(0.15)) * 180 / Math.PI).toBeLessThan(20);
    expect(Math.atan(snowWindRun(1)) * 180 / Math.PI).toBeGreaterThan(70);
  });

  it('keeps the wind\'s run out of the view\'s depth, as it does the fall', () => {
    // looking down the wind, most of its run is along the view and is dropped
    const along = snowVelocity({ yaw: -Math.PI / 2, pitch: 0 }, 0.6);
    const across = snowVelocity({ yaw: Math.PI, pitch: 0 }, 0.6);
    expect(Math.abs(along[0])).toBeLessThan(Math.abs(across[0]) * 0.2);
    for (const yaw of [0, 1, 2, 3, 4, 5]) for (const pitch of [0, 0.46, 1.0]) {
      const f = forward(yaw, pitch), v = snowVelocity({ yaw, pitch }, 0.8);
      const flat = [-snowWindRun(0.8), -1, 0];
      expect(Math.abs(dot(v, f))).toBeLessThan(Math.abs(dot(flat, f)) * 0.5 + 0.2);
    }
  });
});
