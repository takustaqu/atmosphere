// governor.ts — holding a frame inside a GPU time budget by trading resolution
//
// The sky's cost scales with the pixels it draws — the same scene at 2160p
// costs 3.2-3.4x what it does at 1080p — so the resolution that fits a budget
// can be estimated from one measurement. Two things keep that from being the
// whole story, both measured on an M2 Max:
//
//   - the first frames at a new size run long (31 and 50 ms where the steady
//     state is 21), so a decision on them overshoots
//   - the GPU clocks down when there is less to do. At a smaller size a frame
//     reads longer per pixel than it did at full size, so per-pixel cost is
//     not a constant to extrapolate from in either direction: going down on
//     it overshoots, and going up on it never happens, because a down-clocked
//     GPU always looks busier than it would be once there was work again
//
// Hence the rules:
//   - only frames drawn at the current size count, and the first few at each
//     new size are dropped
//   - down is immediate, sized from the measurement (a frame over budget is a
//     dropped frame now)
//   - up is a probe: one step at a time when there is headroom, after a wait.
//     More work raises the clocks again, so a step that fits stays; a step
//     that does not is undone on the next decision, and the wait before the
//     next probe doubles, so the canvas cannot bounce
//   - the scale moves in fixed steps, so noise in the timings cannot jitter
//     the canvas size frame to frame
//
// No DOM: it is fed measurements and returns a scale. Atmosphere wires it to
// AtmosphereRenderer's GPU timing.

import type { GpuTime } from './renderer.js';

export interface GovernorOptions {
  /** GPU milliseconds per frame to stay under */
  budget: number;
  /** the lowest scale it may go to, each way. Defaults to 0.5 */
  min?: number;
  /** the highest. Defaults to 1 — never above the configured resolution */
  max?: number;
}

/** scale steps: 1/32 each way keeps a 4K canvas within ~120 px of the ideal */
const STEP = 1 / 32;
/** the estimate is the median of up to this many recent frames */
const WINDOW = 12;
/** and needs at least this many */
const MIN_SAMPLES = 6;
/** frames dropped after every size change, while the new size warms up */
const WARMUP = 3;
/** aim this far under the budget when going down */
const AIM = 0.88;
/** probe upward only while under this fraction of the budget */
const HEADROOM = 0.8;
/** a probe goes this far up at most */
const GROW = 1.1;
/** wait before the first probe after a change, doubling after each failed one */
const PROBE_MS = 2000;
const PROBE_MAX_MS = 60_000;
/** a probe undone within this long counts as failed */
const FAIL_MS = 5000;

export class ResolutionGovernor {
  private readonly budget: number;
  private readonly min: number;
  private readonly max: number;
  private samples: number[] = [];   // ms of frames at the current size
  private expected = 0;             // pixels a frame at the current size has
  private skip = WARMUP;
  private changedAt = -Infinity;
  private probeWait = PROBE_MS;
  private lastProbeAt = -Infinity;
  /** the current multiplier on the configured resolution, each way */
  scale: number;

  constructor(o: GovernorOptions) {
    this.budget = Math.max(0.1, o.budget);
    this.max = Math.min(1, Math.max(STEP, o.max ?? 1));
    this.min = Math.min(this.max, Math.max(STEP, o.min ?? 0.5));
    this.scale = this.max;
  }

  /**
   * Fold in new measurements and return the scale to draw at.
   *
   * @param times      GPU times of finished frames, with the pixels each drew
   * @param fullPixels how many pixels a frame has at scale 1
   * @param now        a clock in ms (performance.now())
   */
  update(times: readonly GpuTime[], fullPixels: number, now: number): number {
    // the size this scale draws at; a new one (this governor's change, or the
    // canvas resized under it) starts the measurement over
    const expected = fullPixels * this.scale * this.scale;
    if (Math.abs(expected - this.expected) > this.expected * 0.03) {
      this.expected = expected;
      this.samples = [];
      this.skip = WARMUP;
    }
    for (const t of times) {
      if (!(t.ms > 0) || !(t.pixels > 0)) continue;
      // frames still in flight from another size say little about this one
      // (see the header); 3% allows for the canvas size's rounding
      if (Math.abs(t.pixels - this.expected) > this.expected * 0.03) continue;
      if (this.skip > 0) { this.skip--; continue; }
      this.samples.push(t.ms);
    }
    if (this.samples.length > WINDOW) this.samples.splice(0, this.samples.length - WINDOW);
    if (this.samples.length < MIN_SAMPLES || fullPixels <= 0) return this.scale;

    const ms = median(this.samples);
    let next = this.scale;
    if (ms > this.budget) {
      // sized from the measurement, as if cost were per pixel; if the clocks
      // make that optimistic, the next decision at the new size goes on down
      next = Math.floor(this.scale * Math.sqrt((this.budget * AIM) / ms) / STEP) * STEP;
      if (next >= this.scale) next = this.scale - STEP;
      if (now - this.lastProbeAt < FAIL_MS) {
        this.probeWait = Math.min(PROBE_MAX_MS, this.probeWait * 2);
      }
    } else if (ms < this.budget * HEADROOM && this.scale < this.max
               && now - this.changedAt >= this.probeWait) {
      next = Math.max(this.scale + STEP, Math.floor((this.scale * GROW) / STEP) * STEP);
      this.lastProbeAt = now;
    } else if (now - this.changedAt >= 30_000) {
      // held a while without trouble: the next probe need not wait as long
      this.probeWait = PROBE_MS;
    }
    next = Math.min(this.max, Math.max(this.min, next));
    if (next !== this.scale) {
      this.scale = next;
      this.changedAt = now;
      this.expected = fullPixels * next * next;
      this.samples = [];
      this.skip = WARMUP;
    }
    return this.scale;
  }
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
