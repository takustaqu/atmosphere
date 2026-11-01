import { describe, expect, it } from 'vitest';
import { CACHE_EL0, SOFT_SLOT, SkyCacheScheduler, stackSignature, stateAhead, viewExtent, type CacheFrameInput } from '../src/skycache.js';
import { resolveConditions } from '../src/state.js';

const frame = (o: Partial<CacheFrameInput> = {}, i = 0, rate = { wind: 0.001, evo: 0.002 }): CacheFrameInput => ({
  sig: [1, 2, 3],
  clocks: { time: 100 + i / 60, wind: 40 + i * rate.wind, evo: 7 + i * rate.evo },
  camera: { yaw: 0, pitch: 0.3, fov: 1.0 },
  width: 640,
  height: 360,
  maxTexture: 16384,
  ...o,
});

describe('viewExtent', () => {
  it('spans the fov round a level view', () => {
    const e = viewExtent({ yaw: 0, pitch: 0, fov: 1 }, 1, 0);
    expect(e.full).toBe(false);
    expect(e.elHi).toBeCloseTo(0.5, 2);
    expect(e.elLo).toBeCloseTo(-0.5, 2);
    expect(e.azHi).toBeCloseTo(0.5, 2);
    expect(e.azLo).toBeCloseTo(-0.5, 2);
  });
  it('takes the whole circle once the zenith is in the frame', () => {
    const e = viewExtent({ yaw: 1, pitch: 1.3, fov: 1 }, 1.6, 1);
    expect(e.full).toBe(true);
    expect(e.elHi).toBe(Math.PI / 2);
  });
  it('is measured off the given azimuth, wrapped', () => {
    const e = viewExtent({ yaw: 3.1, pitch: 0, fov: 0.5 }, 1, -3.1);
    expect(e.full).toBe(false);
    expect((e.azLo + e.azHi) / 2).toBeCloseTo(6.2 - 2 * Math.PI, 3);
  });
});

describe('stackSignature', () => {
  it('leaves out what only the finish reads', () => {
    const s = resolveConditions({ time: 13, weather: 'fair' });
    const a = stackSignature(s);
    const t = { ...s, tone: { ...s.tone, exposure: s.tone.exposure + 1 }, timeOfDay: 3 };
    expect(stackSignature(t)).toEqual(a);
    const c = { ...s, clouds: { ...s.clouds, cumulus: s.clouds.cumulus + 0.1 } };
    expect(stackSignature(c)).not.toEqual(a);
  });
});

describe('stateAhead', () => {
  it('goes on at the rate since the frame before, every number, deep', () => {
    const prev = { a: 1, b: { c: [0.5, 2] }, d: 'x', e: null, f: true };
    const s = { a: 1.25, b: { c: [0.4, 2] }, d: 'x', e: null, f: true };
    const o = stateAhead(s, prev, 2);
    expect(o).toEqual({ a: 1.75, b: { c: [expect.closeTo(0.2, 9), 2] }, d: 'x', e: null, f: true });
  });
  it('makes a copy that does not follow its source', () => {
    const s = { b: { c: [1] } };
    const o = stateAhead(s, s, 5);
    expect(o).toEqual(s);
    s.b.c[0] = 2;
    expect(o.b.c[0]).toBe(1);
  });
  it('leaves a number that wrapped round where it is', () => {
    expect(stateAhead({ az: 0.01 }, { az: 6.27 }, 10).az).toBe(0.01);
  });
  it('keeps the shape of a real state', () => {
    const s = resolveConditions({ time: 13, weather: 'fair' });
    expect(stateAhead(s, s, 3)).toEqual(s);
  });
});

describe('SkyCacheScheduler', () => {
  it('starts from the soft map, hands over to keyframe 0, then shows each pair across N frames', () => {
    const N = 10;
    const c = new SkyCacheScheduler({ frames: N });
    const reasons: string[] = [];
    const mixes: number[] = [];
    const handed: number[] = [];
    for (let i = 0; i < 6 * N; i++) {
      const p = c.frame(frame({}, i));
      reasons.push(p.reason);
      if (p.reason === 'ok') mixes.push(p.show!.mix);
      if (p.reason === 'handover') {
        expect(p.show!.a.slot).toBe(SOFT_SLOT);
        expect(p.show!.b.j).toBe(0);
        handed.push(p.show!.mix);
      }
      if (p.reason === 'soft') {
        expect(p.show!.a.slot).toBe(SOFT_SLOT);
        expect(p.show!.b).toBe(p.show!.a);
      }
    }
    // (the first frame knows nothing of the clocks, so a still sky stays sharp)
    expect(reasons[0]).toBe('jump');
    expect(reasons.slice(1, N + 1).every((r) => r === 'soft')).toBe(true);
    expect(reasons.slice(N + 1, 2 * N + 1).every((r) => r === 'handover')).toBe(true);
    expect(reasons.slice(2 * N + 1).every((r) => r === 'ok')).toBe(true);
    handed.forEach((m, k) => expect(m).toBeCloseTo(k / N, 9));
    mixes.slice(0, N).forEach((m, k) => expect(m).toBeCloseTo(k / N, 9));
  });

  it('draws the soft map whole in one frame, and a fraction of a keyframe', () => {
    const c = new SkyCacheScheduler({ frames: 10 });
    c.frame(frame({}, 0));
    const p = c.frame(frame({}, 1));
    const soft = p.builds.find((b) => b.key.slot === SOFT_SLOT)!;
    expect([soft.c0, soft.c1]).toEqual([soft.key.box.c0, soft.key.box.c1]);
    expect(soft.done).toBe(true);
    expect(soft.key.size).toEqual(p.softSize);
    expect((p.softSize[0] * p.softSize[1]) / (p.size[0] * p.size[1])).toBeLessThan(0.2);
    // covering what a keyframe would
    expect(soft.key.rect.azSpan).toBeCloseTo(p.size[0] / c.texelsPerRad, 1);
    // and drawn once
    expect(c.frame(frame({}, 2)).builds.some((b) => b.key.slot === SOFT_SLOT)).toBe(false);
  });

  it('never draws a still sky soft', () => {
    const c = new SkyCacheScheduler({ frames: 10 });
    for (let i = 0; i < 5; i++) {
      const p = c.frame(frame({ clocks: { time: 100, wind: 40, evo: 7 } }, i));
      expect(p.show).toBeNull();
      expect(p.builds.length).toBe(0);
    }
  });

  it('draws every column of a keyframe once, in order, across its N frames', () => {
    const N = 7;
    const c = new SkyCacheScheduler({ frames: N, region: 'panorama' });
    const built = new Map<number, [number, number][]>();
    for (let i = 0; i < 8 * N; i++) {
      const p = c.frame(frame({}, i));
      for (const b of p.builds) (built.get(b.key.j) ?? built.set(b.key.j, []).get(b.key.j)!).push([b.c0, b.c1]);
    }
    const W = c.size[0];
    for (const [j, sl] of built) {
      if (j > 6 || j < 0) continue;   // the last ones are still building (and the soft map is whole at once)
      expect(sl.length).toBe(N);
      expect(sl[0][0]).toBe(0);
      for (let k = 1; k < sl.length; k++) expect(sl[k][0]).toBe(sl[k - 1][1]);
      expect(sl[sl.length - 1][1]).toBe(W);
    }
  });

  it('builds each keyframe for the clocks at the frame it is shown whole', () => {
    const N = 10;
    const c = new SkyCacheScheduler({ frames: N });
    const at = new Map<number, number>();   // keyframe j → the frame index it is shown whole (mix 0, as first)
    const wind = new Map<number, number>();
    for (let i = 0; i < 6 * N; i++) {
      const p = c.frame(frame({}, i));
      for (const b of p.builds) wind.set(b.key.j, b.key.clocks.wind);
      if (p.reason === 'ok' && p.show!.mix < 1e-9) at.set(p.show!.a.j, i);
    }
    for (const [j, i] of at) expect(wind.get(j)).toBeCloseTo(frame({}, i).clocks.wind, 9);
  });

  it('follows the clock, not the frame count, through uneven frame times', () => {
    // a 30 fps cap on a 60 Hz display: frames 17, 33 and 50 ms apart
    const N = 10;
    const c = new SkyCacheScheduler({ frames: N });
    const dts = [1, 2, 1, 3, 2, 1, 2, 2, 3, 1];
    let t = 0;
    const shown: { evo: number; at: number }[] = [];
    let lastJ = -1;
    for (let i = 0; i < 12 * N; i++) {
      t += dts[i % dts.length];
      const f = frame({}, t);
      const p = c.frame(f);
      if (i < 3 * N) continue;
      expect(p.reason).toBe('ok');
      const { a, b, mix } = p.show!;
      // the pair brackets the frame's own clock, and the mix is how far
      // between them it has come: the picture is the clock's, frame by frame
      expect(a.clocks.evo).toBeLessThanOrEqual(f.clocks.evo + 1e-9);
      expect(b.clocks.evo).toBeGreaterThan(f.clocks.evo - 1e-9);
      expect(a.clocks.evo + mix * (b.clocks.evo - a.clocks.evo)).toBeCloseTo(f.clocks.evo, 9);
      expect(a.clocks.wind + mix * (b.clocks.wind - a.clocks.wind)).toBeCloseTo(f.clocks.wind, 9);
      if (a.j !== lastJ) { shown.push({ evo: a.clocks.evo, at: f.clocks.evo }); lastJ = a.j; }
    }
    // keyframes evenly spaced on the clock
    for (let k = 2; k < shown.length; k++) {
      expect(shown[k].evo - shown[k - 1].evo).toBeCloseTo(shown[1].evo - shown[0].evo, 9);
    }
  });

  it('keeps keyframes closer than N frames where the clocks run fast', () => {
    const c = new SkyCacheScheduler({ frames: 15 });
    const steps = new Set<number>();
    let prev: number | null = null;
    for (let i = 0; i < 80; i++) {
      // a strong wind: 0.003 of it a frame, so windRun's 0.012 is four frames
      const p = c.frame(frame({}, i, { wind: 0.003, evo: 0.001 }));
      if (p.show) {
        if (prev !== null && p.show.a.j !== prev) steps.add(i);
        prev = p.show.a.j;
      }
    }
    const at = [...steps];
    for (let k = 1; k < at.length; k++) expect(at[k] - at[k - 1]).toBe(4);
  });

  it('finishes a keyframe a long frame left short, and starts over after a leap', () => {
    const N = 6;
    const c = new SkyCacheScheduler({ frames: N });
    let t = 0;
    for (let i = 0; i < 4 * N; i++) c.frame(frame({}, ++t));
    // a frame two thirds of an interval long: the next keyframe is finished now
    t += 4;
    const p = c.frame(frame({}, t));
    expect(p.reason).toBe('ok');
    const whole = p.builds.filter((b) => b.done).map((b) => b.key.j);
    expect(whole.length).toBeGreaterThan(0);
    // one longer than two intervals: drawn directly, and the schedule starts over
    t += 3 * N;
    expect(c.frame(frame({}, t)).reason).toBe('passed');
    expect(c.frame(frame({}, ++t)).reason).toBe('soft');
  });

  it('goes on showing keyframes while the state eases to another', () => {
    const c = new SkyCacheScheduler({ frames: 5 });
    for (let i = 0; i < 20; i++) c.frame(frame({}, i));
    expect(c.frame(frame({}, 20)).reason).toBe('ok');
    // a set(): a number moving by a hundredth of a unit a frame, and for long
    for (let i = 21; i < 200; i++) {
      const p = c.frame(frame({ sig: [1, 2 + 0.01 * (i - 20), 3] }, i));
      expect(p.reason).toBe('ok');
      expect(p.show).not.toBeNull();
    }
  });

  it('starts over from the soft map when the state leaps', () => {
    const c = new SkyCacheScheduler({ frames: 5 });
    for (let i = 0; i < 20; i++) c.frame(frame({}, i));
    expect(c.frame(frame({ sig: [1, 2.5, 3] }, 20)).reason).toBe('leap');
    expect(c.frame(frame({ sig: [1, 2.5, 3] }, 21)).reason).toBe('soft');
  });

  it('brings the keyframes closer as the clock speeds up, and never into a frame or two', () => {
    const N = 15;
    const c = new SkyCacheScheduler({ frames: N });
    let wind = 40, evo = 7, i = 0;
    const run = (frames: number, rw: number, re: number) => {
      const shownAt: number[] = [];
      let last: number | null = null, worst = 0;
      for (let k = 0; k < frames; k++, i++) {
        wind += rw; evo += re;
        const p = c.frame(frame({ clocks: { time: 100 + i / 60, wind, evo } }, i));
        if (i > 0) expect(p.show).not.toBeNull();
        if (p.reason === 'ok' && p.show!.a.j !== last) { last = p.show!.a.j; shownAt.push(k); }
        worst = Math.max(worst, p.builds.reduce((u, b) => u + (b.key.slot === SOFT_SLOT ? 0 : (b.c1 - b.c0) / (b.key.box.c1 - b.key.box.c0)), 0));
      }
      return { shownAt, worst };
    };
    run(100, 0.0008, 0.0015);
    // the time of day wound on: the wind eight times as fast, and it does not fall behind
    const fast = run(100, 0.0065, 0.002);
    const gaps = fast.shownAt.slice(4).map((f, k) => f - fast.shownAt[k + 3]);
    gaps.forEach((g) => expect(g).toBeGreaterThanOrEqual(3));
    gaps.slice(-4).forEach((g) => expect(g).toBeLessThanOrEqual(5));
    // never more than a keyframe's worth to draw in one frame, only as it changes step
    expect(fast.worst).toBeLessThanOrEqual(1);
    // and back
    const calm = run(200, 0.0008, 0.0015);
    const g2 = calm.shownAt.slice(-4).map((f, k) => f - calm.shownAt[calm.shownAt.length - 5 + k]);
    g2.forEach((g) => expect(g).toBeGreaterThanOrEqual(11));
  });

  it('draws a view that left its keyframes from the soft map, and hands back at the start of an interval', () => {
    const N = 10;
    const c = new SkyCacheScheduler({ frames: N });
    let yaw = 0;
    const cam = () => ({ yaw, pitch: 0.3, fov: 1.0 });
    let i = 0;
    for (; i < 5 * N; i++) c.frame(frame({ camera: cam() }, i));
    expect(c.frame(frame({ camera: cam() }, i++)).reason).toBe('ok');
    // a whip of the camera, a long way in one go
    yaw = 2;
    const p = c.frame(frame({ camera: cam() }, i++));
    expect(p.reason).toBe('soft');
    expect(p.builds.some((b) => b.key.slot === SOFT_SLOT)).toBe(true);
    const seen: string[] = [];
    for (let k = 0; k < 5 * N; k++) {
      const q = c.frame(frame({ camera: cam() }, i++));
      if (seen[seen.length - 1] !== q.reason) seen.push(q.reason);
      // handing over from a mix of nothing
      if (q.reason === 'handover' && seen[seen.length - 1] === 'handover' && seen.length === 2 && k < N * 3) expect(q.show!.mix).toBeLessThan(1);
    }
    expect(seen).toEqual(['soft', 'handover', 'ok']);
  });

  it('leaves a view that wants more texels than the budget to the direct draw', () => {
    const c = new SkyCacheScheduler({ budget: 1e6 });
    c.frame(frame({ height: 1080, width: 1920 }, 0));
    expect(c.frame(frame({ height: 1080, width: 1920, camera: { yaw: 0, pitch: 0.3, fov: 0.55 } }, 1)).reason).toBe('density');
  });

  it("holds a steadily turning view inside a 'view' window", () => {
    const N = 10;
    const c = new SkyCacheScheduler({ frames: N, region: 'view' });
    const reasons: Record<string, number> = {};
    for (let i = 0; i < 10 * N; i++) {
      const p = c.frame(frame({ camera: { yaw: 0.005 * i, pitch: 0.3, fov: 1.0 } }, i));
      if (i > 2 * N + 1) reasons[p.reason] = (reasons[p.reason] ?? 0) + 1;
    }
    expect(reasons).toEqual({ ok: 10 * N - 2 * N - 2 });
  });

  it('maps a panorama from just under the horizon', () => {
    const c = new SkyCacheScheduler({ frames: 4, region: 'panorama' });
    let p = c.frame(frame({}, 0));
    for (let i = 1; i < 12; i++) p = c.frame(frame({}, i));
    expect(p.show!.a.rect.el0).toBe(CACHE_EL0);
    expect(p.show!.a.rect.azSpan).toBeGreaterThan(2 * Math.PI);
  });
});
