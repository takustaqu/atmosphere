import { describe, expect, it } from 'vitest';
import {
  MOON_RELATIVE, PROBE_FACE, PROBE_SUB,
  cameraForward, celestialLights, mixMeasurement, probeLayout,
  sampleEnvironment, sampleFromLinear, sampleLightGrid, summarizeProbe,
  type LightGrid,
} from '../src/light.js';
import { DEFAULT_CAMERA, resolveConditions } from '../src/state.js';

describe('celestialLights', () => {
  it('a clear noon has a visible, near-white sun and no moon', () => {
    const l = celestialLights(resolveConditions({ time: 12, weather: 'clear' }), DEFAULT_CAMERA, 16 / 9);
    expect(l.key).toBe('sun');
    // not quite 1: the shader counts even a clear day's breeze toward its gloom
    expect(l.sun.visibility).toBeGreaterThan(0.9);
    expect(l.sun.intensity).toBe(l.sun.visibility);
    expect(Math.min(...l.sun.color)).toBeGreaterThan(0.8);
    expect(l.moon.visibility).toBe(0);
  });

  it('turns the sun orange toward the horizon', () => {
    const l = celestialLights(resolveConditions({ time: 17.9, weather: 'clear' }), DEFAULT_CAMERA, 16 / 9);
    expect(l.sun.color[0]).toBe(1);
    expect(l.sun.color[2]).toBeLessThan(0.3);
  });

  it('a full deck hides the sun', () => {
    const l = celestialLights(resolveConditions({ time: 12, weather: 'thunderstorm' }), DEFAULT_CAMERA, 16 / 9);
    expect(l.sun.visibility).toBe(0);
    expect(l.key).toBeNull();
  });

  it('at night the moon is the key, dimmer than a sun would be', () => {
    const l = celestialLights(resolveConditions({ time: 23, weather: 'clear' }), DEFAULT_CAMERA, 16 / 9);
    expect(l.key).toBe('moon');
    expect(l.moon.intensity).toBeCloseTo(l.moon.visibility * MOON_RELATIVE, 12);
    expect(l.moon.elevation).toBe(0.62);
  });

  it('directions are unit vectors in world axes (x east, y up, z north)', () => {
    const s = resolveConditions({ time: 12 });
    const l = celestialLights(s, DEFAULT_CAMERA, 1);
    expect(Math.hypot(...l.sun.direction)).toBeCloseTo(1, 12);
    // the nominal noon sun stands due south
    expect(l.sun.direction[2]).toBeLessThan(0);
    expect(l.sun.direction[1]).toBeCloseTo(Math.sin(s.sunElevation), 12);
  });

  it('a body straight ahead of the camera sits at the centre of the screen', () => {
    const s = resolveConditions({ time: 12 });
    const cam = { yaw: s.sunAzimuth, pitch: s.sunElevation, fov: 0.9 };
    const { sun } = celestialLights(s, cam, 16 / 9);
    expect(sun.screen.x).toBeCloseTo(0.5, 9);
    expect(sun.screen.y).toBeCloseTo(0.5, 9);
    expect(sun.screen.inFront).toBe(true);
    expect(sun.view[2]).toBeCloseTo(1, 9);
  });

  it('screen y runs top-down and x runs to the right', () => {
    const s = resolveConditions({ time: 12 });
    // look a little below and to the left of the sun: it should land up and right
    const cam = { yaw: s.sunAzimuth - 0.1, pitch: s.sunElevation - 0.1, fov: 0.9 };
    const { sun } = celestialLights(s, cam, 1);
    expect(sun.screen.y).toBeLessThan(0.5);
    // yaw grows clockwise seen from above (north → east), so turning left puts the sun to the right
    expect(sun.screen.x).toBeGreaterThan(0.5);
    expect(sun.view[0]).toBeGreaterThan(0);
    expect(sun.view[1]).toBeGreaterThan(0);
  });

  it('a body behind the camera is flagged', () => {
    const s = resolveConditions({ time: 12 });
    const cam = { yaw: s.sunAzimuth + Math.PI, pitch: 0, fov: 0.9 };
    expect(celestialLights(s, cam, 1).sun.screen.inFront).toBe(false);
  });
});

/** a probe readback filled with one 8-bit color everywhere */
function flatProbe(cols: number, rows: number, env: boolean, rgb: [number, number, number]) {
  const layout = probeLayout(cols, rows, env);
  const px = new Uint8Array(layout.width * layout.height * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = 255; }
  return { layout, px };
}

describe('summarizeProbe', () => {
  it('lays the frame out at PROBE_SUB samples per cell, with the faces above it', () => {
    const l = probeLayout(8, 6, true);
    expect(l.frameHeight).toBe(6 * PROBE_SUB);
    expect(l.height).toBe(6 * PROBE_SUB + PROBE_FACE);
    expect(l.width).toBe(Math.max(8 * PROBE_SUB, 6 * PROBE_FACE));
    expect(probeLayout(8, 6, false).height).toBe(6 * PROBE_SUB);
  });

  it('a flat readback gives that color everywhere, round-tripped through linear', () => {
    const { layout, px } = flatProbe(4, 3, true, [128, 64, 200]);
    const m = summarizeProbe(px, layout);
    expect(m.frame.grid.cells).toHaveLength(12);
    const expectSrgb = (srgb: number[]) => {
      expect(srgb[0] * 255).toBeCloseTo(128, 3);
      expect(srgb[1] * 255).toBeCloseTo(64, 3);
      expect(srgb[2] * 255).toBeCloseTo(200, 3);
    };
    expectSrgb(m.frame.average.srgb);
    expectSrgb(m.environment!.sky.srgb);
    expectSrgb(m.environment!.ground.srgb);
    expectSrgb(m.environment!.directions.north.srgb);
  });

  it('grid rows run top-down though the readback runs bottom-up', () => {
    const { layout, px } = flatProbe(2, 2, false, [0, 0, 0]);
    // paint the bottom row of the framebuffer — the bottom of the picture — white
    for (let y = 0; y < PROBE_SUB; y++) {
      for (let x = 0; x < layout.width; x++) px.fill(255, (y * layout.width + x) * 4, (y * layout.width + x) * 4 + 3);
    }
    const g = summarizeProbe(px, layout).frame.grid;
    expect(g.cells[0].luminance).toBe(0);            // top-left
    expect(g.cells[2].luminance).toBeCloseTo(1, 6);  // bottom-left
  });

  it('averages in linear light, not in encoded values', () => {
    const { layout, px } = flatProbe(2, 1, false, [0, 0, 0]);
    // left cell black, right cell white
    for (let y = 0; y < layout.height; y++) {
      for (let x = PROBE_SUB; x < 2 * PROBE_SUB; x++) px.fill(255, (y * layout.width + x) * 4, (y * layout.width + x) * 4 + 3);
    }
    const avg = summarizeProbe(px, layout).frame.average;
    expect(avg.linear[0]).toBeCloseTo(0.5, 6);
    // half the light encodes well above half the code value
    expect(avg.srgb[0]).toBeGreaterThan(0.7);
  });

  it('splits the dome at the horizon: sky from above, ground from below', () => {
    const { layout, px } = flatProbe(1, 1, true, [0, 0, 0]);
    // light only the up face (+Y is the third face)
    for (let y = 0; y < PROBE_FACE; y++) {
      for (let x = 2 * PROBE_FACE; x < 3 * PROBE_FACE; x++) {
        const i = ((layout.frameHeight + y) * layout.width + x) * 4;
        px.fill(255, i, i + 3);
      }
    }
    const env = summarizeProbe(px, layout).environment!;
    expect(env.directions.up.luminance).toBeCloseTo(1, 6);
    expect(env.zenith.luminance).toBeCloseTo(1, 6);
    expect(env.ground.luminance).toBe(0);
    expect(env.horizon.luminance).toBe(0);
    expect(env.sky.luminance).toBeGreaterThan(0.2);
    expect(env.sky.luminance).toBeLessThan(0.8);
  });
});

describe('mixMeasurement / sampleLightGrid', () => {
  const measure = (v: number) => {
    const { layout, px } = flatProbe(2, 2, true, [v, v, v]);
    return summarizeProbe(px, layout);
  };

  it('eases between measurements in linear light', () => {
    const m = mixMeasurement(measure(0), measure(255), 0.25);
    expect(m.frame.average.linear[1]).toBeCloseTo(0.25, 6);
    expect(m.environment!.horizon.linear[1]).toBeCloseTo(0.25, 6);
  });

  it('takes the new measurement whole when the shapes disagree', () => {
    const { layout, px } = flatProbe(3, 2, true, [255, 255, 255]);
    const to = summarizeProbe(px, layout);
    expect(mixMeasurement(measure(0), to, 0.1)).toBe(to);
  });

  it('samples the grid bilinearly, holding the edges', () => {
    const grid: LightGrid = {
      cols: 2, rows: 1,
      cells: [sampleFromLinear([0, 0, 0]), sampleFromLinear([1, 1, 1])],
    };
    expect(sampleLightGrid(grid, 0.5, 0.5).linear[0]).toBeCloseTo(0.5, 9);
    expect(sampleLightGrid(grid, 0.25, 0.5).linear[0]).toBeCloseTo(0, 9);
    expect(sampleLightGrid(grid, -3, 0.5).linear[0]).toBe(0);
    expect(sampleLightGrid(grid, 9, 9).linear[0]).toBe(1);
  });
});

describe('sampleEnvironment / cameraForward', () => {
  const env = () => {
    const { layout, px } = flatProbe(1, 1, true, [0, 0, 0]);
    const e = summarizeProbe(px, layout).environment!;
    e.directions.east = sampleFromLinear([1, 0, 0]);
    e.directions.up = sampleFromLinear([0, 1, 0]);
    e.directions.south = sampleFromLinear([0, 0, 1]);
    return e;
  };

  it('a normal along an axis sees exactly that direction', () => {
    expect(sampleEnvironment(env(), [2, 0, 0]).linear).toEqual([1, 0, 0]);
    expect(sampleEnvironment(env(), [0, 0, -1]).linear).toEqual([0, 0, 1]);
    expect(sampleEnvironment(env(), [-1, 0, 0]).linear).toEqual([0, 0, 0]);
  });

  it('a diagonal normal blends the faces it leans toward, by cos²', () => {
    const s = sampleEnvironment(env(), [1, 1, 0]);
    expect(s.linear[0]).toBeCloseTo(0.5, 9);
    expect(s.linear[1]).toBeCloseTo(0.5, 9);
  });

  it('the default camera faces south and a little up', () => {
    const f = cameraForward(DEFAULT_CAMERA);
    expect(f[2]).toBeLessThan(-0.8);
    expect(f[1]).toBeCloseTo(Math.sin(DEFAULT_CAMERA.pitch), 12);
    expect(Math.hypot(...f)).toBeCloseTo(1, 12);
  });
});
