import { describe, expect, it } from 'vitest';
import { CACHE_EL0, SkyCacheScheduler, stackSignature, viewExtent, type CacheFrameInput } from '../src/skycache.js';
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

describe('SkyCacheScheduler', () => {
  it('builds two keyframes before showing, then shows each pair across N frames', () => {
    const N = 10;
    const c = new SkyCacheScheduler({ frames: N });
    const reasons: string[] = [];
    const mixes: number[] = [];
    for (let i = 0; i < 6 * N; i++) {
      const p = c.frame(frame({}, i));
      reasons.push(p.reason);
      if (p.show) mixes.push(p.show.mix);
    }
    expect(reasons[0]).toBe('jump');
    expect(reasons.slice(1, 2 * N + 1).every((r) => r === 'warm')).toBe(true);
    expect(reasons.slice(2 * N + 1).every((r) => r === 'ok')).toBe(true);
    expect(mixes.slice(0, N)).toEqual(Array.from({ length: N }, (_, k) => k / N));
  });

  it('draws every column of a keyframe once, in order, across its N frames', () => {
    const N = 7;
    const c = new SkyCacheScheduler({ frames: N });
    const built = new Map<number, [number, number][]>();
    for (let i = 0; i < 8 * N; i++) {
      const p = c.frame(frame({}, i));
      if (p.build) (built.get(p.build.key.j) ?? built.set(p.build.key.j, []).get(p.build.key.j)!).push([p.build.c0, p.build.c1]);
    }
    const W = c.size[0];
    for (const [j, sl] of built) {
      if (j > 6) continue;   // the last ones are still building
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
      if (p.build) wind.set(p.build.key.j, p.build.key.clocks.wind);
      if (p.show && p.show.mix === 0) at.set(p.show.a.j, i);
    }
    for (const [j, i] of at) expect(wind.get(j)).toBeCloseTo(frame({}, i).clocks.wind, 9);
  });

  it('draws directly while the state animates, and starts over after', () => {
    const c = new SkyCacheScheduler({ frames: 5 });
    for (let i = 0; i < 20; i++) c.frame(frame({}, i));
    expect(c.frame(frame({}, 20)).reason).toBe('ok');
    const p = c.frame(frame({ sig: [1, 2.01, 3] }, 21));
    expect(p.reason).toBe('animating');
    expect(p.show).toBeNull();
    expect(c.frame(frame({ sig: [1, 2.01, 3] }, 22)).reason).toBe('warm');
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
    const c = new SkyCacheScheduler({ frames: 4 });
    let p = c.frame(frame({}, 0));
    for (let i = 1; i < 12; i++) p = c.frame(frame({}, i));
    expect(p.show!.a.rect.el0).toBe(CACHE_EL0);
    expect(p.show!.a.rect.azSpan).toBeGreaterThan(2 * Math.PI);
  });
});
