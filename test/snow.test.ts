import { describe, expect, it } from 'vitest';
import { snowFallDir } from '../src/renderer.js';

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
