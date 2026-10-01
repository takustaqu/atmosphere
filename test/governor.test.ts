import { describe, expect, it } from 'vitest';
import { ResolutionGovernor } from '../src/governor.js';

const FULL = 3840 * 2160;

/** n frames of a scene costing cost(scale) ms, drawn at `scale` */
function frames(n: number, cost: number | ((s: number) => number), scale: number, jitter = 0) {
  const pixels = Math.round(FULL * scale * scale);
  const ms = typeof cost === 'number' ? cost * scale * scale : cost(scale);
  return Array.from({ length: n }, (_, i) => ({ ms: ms * (1 + jitter * Math.sin(i * 2.3)), pixels }));
}

/** drive the governor for `seconds` at 30 frames a second; returns the scales it chose, one per second */
function run(g: ResolutionGovernor, cost: number | ((s: number) => number), seconds: number, t0 = 0, jitter = 0) {
  const out: number[] = [];
  for (let t = 0; t < seconds; t++) {
    for (let f = 0; f < 30; f += 5) g.update(frames(5, cost, g.scale, jitter), FULL, t0 + t * 1000 + f * 33);
    out.push(g.scale);
  }
  return out;
}

describe('ResolutionGovernor', () => {
  it('holds full resolution while the frame fits the budget', () => {
    const g = new ResolutionGovernor({ budget: 25 });
    expect(run(g, 18, 10)).toEqual(Array(10).fill(1));
  });

  it('ignores the first frames at a size, and waits for enough of the rest', () => {
    const g = new ResolutionGovernor({ budget: 12.5 });
    // a long first frame is warm-up, not cost
    expect(g.update([{ ms: 50, pixels: FULL }, { ms: 31, pixels: FULL }, { ms: 21, pixels: FULL }], FULL, 0)).toBe(1);
    expect(g.update(frames(5, 18, 1), FULL, 10)).toBe(1);
  });

  it('drops straight to a scale that fits, in whole steps', () => {
    // 2160p at 18 ms against a 60 fps budget
    const g = new ResolutionGovernor({ budget: 12.5 });
    const s = g.update(frames(12, 18, 1), FULL, 0);
    expect(s).toBeLessThan(1);
    expect(18 * s * s).toBeLessThanOrEqual(12.5 * 0.88 + 1e-9);
    expect((s * 32) % 1).toBe(0);
  });

  it('settles and stays put under noisy timings', () => {
    const g = new ResolutionGovernor({ budget: 12.5 });
    const scales = run(g, 18, 60, 0, 0.06);
    const settled = scales[2];
    expect(scales.slice(2).every((s) => s === settled)).toBe(true);
    expect(18 * settled * settled).toBeLessThanOrEqual(12.5);
  });

  it('climbs back step by step once the scene gets cheaper', () => {
    const g = new ResolutionGovernor({ budget: 12.5 });
    run(g, 18, 3);
    const low = g.scale;
    expect(low).toBeLessThan(1);
    // the sky clears and the cost halves: back to full, a step at a time
    const up = run(g, 9, 40, 10_000);
    expect(up[up.length - 1]).toBe(1);
    for (let i = 1; i < up.length; i++) expect(up[i] - up[i - 1]).toBeLessThanOrEqual(low * 0.11 + 1 / 32);
  });

  it('is not fooled by a GPU that clocks down at smaller sizes', () => {
    // per-pixel cost rises as the work shrinks — what a down-clocking GPU reports.
    // Full size costs 14 ms against a 12.5 ms budget; just under full fits
    const cost = (s: number) => 14 * s * s * (1 + 0.6 * (1 - s));
    const g = new ResolutionGovernor({ budget: 12.5 });
    const scales = run(g, cost, 120);
    const end = scales[scales.length - 1];
    // it does not collapse toward the floor...
    expect(end).toBeGreaterThan(0.85);
    // ...and a failing probe backs off rather than bouncing every few seconds
    let changes = 0;
    for (let i = 61; i < scales.length; i++) if (scales[i] !== scales[i - 1]) changes++;
    expect(changes).toBeLessThanOrEqual(4);
  });

  it('respects min and max', () => {
    const g = new ResolutionGovernor({ budget: 1, min: 0.6 });
    run(g, 40, 10);
    expect(g.scale).toBe(0.6);
    const h = new ResolutionGovernor({ budget: 100, max: 0.8 });
    expect(h.scale).toBe(0.8);
    run(h, 5, 10);
    expect(h.scale).toBe(0.8);
  });

  it('frames from a previous size do not count toward the current one', () => {
    const g = new ResolutionGovernor({ budget: 12.5 });
    const s = g.update(frames(12, 18, 1), FULL, 0);
    // full-size frames still in flight after the drop must not push it down again
    expect(g.update(frames(12, 18, 1), FULL, 100)).toBe(s);
  });
});
