import { describe, expect, it, vi } from 'vitest';
import { CLOUD_GENERA_IDS } from '../src/clouds.js';
import { CLOUD_FEATURES, FEATURE, backlitInView, featureKey, iridescenceInView } from '../src/features.js';
import { DEFAULT_CAMERA, resolveConditions } from '../src/state.js';
import { turretTable } from '../src/storm.js';
import { uniformSlot, uniform1f, uniform2f, uniform3f, uniform4f } from '../src/uniforms.js';

describe('cloud specialization preserves the layer gates', () => {
  for (const genus of CLOUD_GENERA_IDS) {
    it(genus, () => {
      const threshold = genus === 'cumulus' ? 0.02 : 0.001;
      const mask = genus === 'cumulonimbus' ? 0 : genus === 'cumulus' ? FEATURE.CUMULUS : FEATURE.CLOUD_LAYERS;
      const at = (amount: number) => featureKey(resolveConditions({ weather: { clouds: { [genus]: amount } } })) & CLOUD_FEATURES;
      expect(at(0)).toBe(0);
      expect(at(threshold)).toBe(0);
      expect(at(threshold + 0.00001)).toBe(mask);
      expect(at(1)).toBe(mask);
    });
  }

  it('keeps lenticular banks without any cloud genera', () => {
    const s = resolveConditions({ weather: { clouds: {}, features: { lenticular: 0.8 } } });
    expect(featureKey(s) & CLOUD_FEATURES).toBe(FEATURE.CLOUD_LAYERS);
  });
});

describe('view visibility reuse', () => {
  for (const gate of [backlitInView, iridescenceInView]) {
    it(`${gate.name} follows in-place changes to the sun, lens and camera`, () => {
      const s = resolveConditions({ time: 14, weather: 'fair' });
      const c = { ...DEFAULT_CAMERA };
      const seen = new Set<boolean>();
      let aspect = 1;
      // Check a warm result against a fresh view after every change. The
      // animator and callers both mutate objects, so identity is not a key.
      for (let i = 0; i < 270; i++) {
        // Change only one dependency at a time: a camera change must not
        // accidentally hide a missing sun/disc/lens dependency in the cache.
        const j = Math.floor(i / 9);
        switch (i % 9) {
          case 0: s.sunElevation = 0.1 + (j % 4) * 0.2; break;
          case 1: s.sunAzimuth = (j % 8) * Math.PI / 4; break;
          case 2: s.sun.disc = j % 2 ? 0.53 : 10; break;
          case 3: s.rain = j % 5 ? 0 : 0.7; break;
          case 4: s.lens.droplets = j % 7 ? 1 : 0; break;
          case 5: c.yaw = Math.floor(j / 8) * 0.4; break;
          case 6: c.pitch = j % 2 ? 0.2 : 0.4; break;
          case 7: c.fov = j % 3 ? 0.86 : 1.2; break;
          case 8: aspect = 1 + (j % 3) * 0.5; break;
        }
        const warm = gate(s, c, aspect);
        expect(gate(s, c, aspect)).toBe(warm);
        gate(s, { ...c, yaw: c.yaw + 1 }, aspect);
        expect(gate(s, c, aspect)).toBe(warm);
        seen.add(warm);
      }
      expect(seen.size).toBe(2);
    });
  }
});

describe('turret layout reuse', () => {
  it('keeps the pre-optimization texture bytes, including after changing distance', () => {
    // Frozen from d2839e4, before caching the layout. Every byte feeds the
    // cloud shader, so test the whole texture rather than selected heights.
    const cases: [number, number, number, number][] = [
      [0, 7.3, 0.3, 269751406],
      [0.47, 13, 0.8, 582426585],
      [0.65, 7.3, 0.3, 3852674093],
      [1, 10000, 1, 3614372172],
    ];
    for (const [d, e, a, hash] of [...cases, ...[...cases].reverse()]) {
      for (let repeat = 0; repeat < 2; repeat++) {
        let checksum = 2166136261;
        for (const byte of turretTable(d, e, a)) checksum = Math.imul(checksum ^ byte, 16777619);
        expect(checksum >>> 0).toBe(hash);
      }
    }
  });
});

describe('program uniform values', () => {
  const fakeGL = () => ({ uniform1f: vi.fn(), uniform2f: vi.fn(), uniform3f: vi.fn(), uniform4f: vi.fn() });

  it('uploads once per program, and restores an override from a probe or split pass', () => {
    const calls = fakeGL(), gl = calls as unknown as WebGLRenderingContext;
    const a = uniformSlot({} as WebGLUniformLocation), b = uniformSlot({} as WebGLUniformLocation);
    uniform4f(gl, a, 0, 0, 1280, 720);
    uniform4f(gl, a, 0, 0, 1280, 720);
    uniform4f(gl, b, 0, 0, 1280, 720);
    expect(calls.uniform4f).toHaveBeenCalledTimes(2);
    uniform4f(gl, a, 0, 0, 32, 20);
    uniform4f(gl, a, 0, 0, 1280, 720);
    expect(calls.uniform4f).toHaveBeenCalledTimes(4);
    expect(calls.uniform4f).toHaveBeenLastCalledWith(a!.location, 0, 0, 1280, 720);
  });

  it('handles all components, missing uniforms, and a newly linked location', () => {
    const calls = fakeGL(), gl = calls as unknown as WebGLRenderingContext;
    const a = uniformSlot({} as WebGLUniformLocation);
    uniform1f(gl, null, 1);
    uniform2f(gl, null, 1, 2);
    uniform3f(gl, null, 1, 2, 3);
    uniform4f(gl, null, 1, 2, 3, 4);
    expect(Object.values(calls).every(f => f.mock.calls.length === 0)).toBe(true);
    uniform1f(gl, a, 0); uniform1f(gl, a, 0); uniform1f(gl, a, -0);
    expect(calls.uniform1f).toHaveBeenCalledTimes(2);
    const b = uniformSlot({} as WebGLUniformLocation);
    uniform2f(gl, b, 1, 2); uniform2f(gl, b, 1, 2); uniform2f(gl, b, 1, 3);
    expect(calls.uniform2f).toHaveBeenCalledTimes(2);
    const c = uniformSlot({} as WebGLUniformLocation);
    uniform3f(gl, c, 1, 2, 3); uniform3f(gl, c, 1, 2, 3); uniform3f(gl, c, 1, 2, 4);
    expect(calls.uniform3f).toHaveBeenCalledTimes(2);
    uniform1f(gl, uniformSlot({} as WebGLUniformLocation), 0);
    expect(calls.uniform1f).toHaveBeenCalledTimes(3);
  });
});
