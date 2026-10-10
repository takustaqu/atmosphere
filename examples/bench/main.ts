// bench — the cost of the shader's variants, measured against one program
//
//   pnpm playground   → http://localhost:8791/examples/bench/
//
// Two renderers on two canvases, one compiling a variant per feature set and
// one with everything compiled in, driven through the same scenes in turn so
// the GPU's clock state is as near the same as it can be for both.

import { AtmosphereRenderer, DEFAULT_CAMERA, resolveConditions, type Conditions } from '../../src';

const W = 1600, H = 900;
const E = Math.PI / 2, S = Math.PI, N = 0, Wd = 3 * Math.PI / 2;
const SCENES: { name: string; c: Conditions; cam?: Partial<typeof DEFAULT_CAMERA>; rays?: number }[] = [
  { name: 'clear noon', c: { time: 12, weather: 'clear' } },
  { name: 'fair', c: { time: 14, weather: 'fair' } },
  { name: 'summer (Cu + Cb)', c: { time: 14, weather: 'summer' } },
  { name: 'overcast', c: { time: 14, weather: 'overcast' } },
  { name: 'rain', c: { time: 14, weather: 'rain' } },
  { name: 'thunderstorm', c: { time: 14, weather: 'thunderstorm' } },
  { name: 'suburban night', c: { time: 23, weather: 'clear' } },
  { name: 'dark-sky night', c: { time: 23, weather: 'clear', celestial: 'dark-sky' } },
  { name: 'magic hour, facing E', c: { time: 18.2, weather: 'fair' }, cam: { yaw: E, pitch: 0.2, fov: 1.0 } },
  { name: 'cirrostratus, low sun', c: { time: 17.6, weather: { clouds: { cirrostratus: 0.9 }, windSpeed: 3, visibility: 30 } }, cam: { yaw: Wd, pitch: 0.15, fov: 1.1 } },
  { name: 'shower with the sun out', c: { time: 16, weather: { cloudCover: 0.35, precipitation: 5, windSpeed: 4, visibility: 20 } }, cam: { yaw: 1.1, pitch: 0.25, fov: 1.3 } },
  { name: 'aurora, facing N', c: { time: 23, weather: 'clear', celestial: { id: 'dark-sky', aurora: 0.8 } }, cam: { yaw: N, pitch: 0.3, fov: 1.0 } },
  { name: 'sea, horizon mid-frame', c: { time: 14, weather: 'clear', ground: 'sea' }, cam: { yaw: S, pitch: 0, fov: 1.0 } },
  { name: 'CPL strong, facing E', c: { time: 14, weather: 'fair', polarizer: 'strong' }, cam: { yaw: E, pitch: 0.3, fov: 1.0 } },
];

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
}

function make(variants: boolean): { r: AtmosphereRenderer; canvas: HTMLCanvasElement } {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  document.body.append(canvas);
  const r = new AtmosphereRenderer(canvas, { compile: 'sync', timing: true, variants });
  return { r, canvas };
}

async function measure(r: AtmosphereRenderer, sc: typeof SCENES[number]): Promise<number> {
  const state = resolveConditions(sc.c);
  const cam = { ...DEFAULT_CAMERA, ...(sc.cam ?? {}) };
  r.takeGpuTimes();
  const times: number[] = [];
  for (let i = 0; i < 50; i++) {
    r.render(100 + i / 30, state, cam, 41.7, 7.3);
    await new Promise((res) => requestAnimationFrame(res));
    for (const t of r.takeGpuTimes()) times.push(t.ms);
  }
  // the first frames at a new scene run long
  times.splice(0, 10);
  return median(times);
}

(async () => {
  const a = make(true), b = make(false);
  const out = document.getElementById('out')!;
  const best = SCENES.map(() => ({ variants: Infinity, one: Infinity }));
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < SCENES.length; i++) {
      best[i].variants = Math.min(best[i].variants, await measure(a.r, SCENES[i]));
      best[i].one = Math.min(best[i].one, await measure(b.r, SCENES[i]));
      out.innerHTML = `<table><tr><th>scene</th><th>variants</th><th>one program</th><th>ratio</th></tr>`
        + SCENES.map((sc, j) => {
          const m = best[j];
          if (!Number.isFinite(m.one)) return '';
          return `<tr><td>${sc.name}</td><td>${m.variants.toFixed(2)} ms</td><td>${m.one.toFixed(2)} ms</td>`
            + `<td>${(m.variants / m.one).toFixed(2)}×</td></tr>`;
        }).join('') + `</table><p>round ${round + 1} of 3</p>`;
    }
  }
  a.r.dispose(); b.r.dispose();
})();
