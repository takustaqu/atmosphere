// Compare the working renderer with a Git revision, on the same browser/GPU.
// node scripts/bench-render.mjs --baseline main --out build/perf
// No resolution/quality changes: each pair receives identical clocks and state.
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const { values } = parseArgs({ options: {
  baseline: { type: 'string', default: 'main' },
  out: { type: 'string', default: 'build/perf' },
  width: { type: 'string', default: '1280' },
  height: { type: 'string', default: '720' },
  frames: { type: 'string', default: '40' },
  rounds: { type: 'string', default: '3' },
  scenes: { type: 'string' },
  compile: { type: 'string', default: 'auto' },
  control: { type: 'boolean', default: false },
} });
const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const revision = git('rev-parse', '--verify', `${values.baseline}^{commit}`);
const out = resolve(root, values.out);
await mkdir(out, { recursive: true });
const config = {
  width: Number(values.width), height: Number(values.height),
  frames: Number(values.frames), rounds: Number(values.rounds), compile: values.compile,
};
for (const k of ['width', 'height', 'frames', 'rounds']) {
  if (!Number.isInteger(config[k]) || config[k] <= 0) throw new Error(`Invalid ${k}`);
}
if (!['auto', 'sync'].includes(config.compile)) throw new Error('Invalid compile mode');

async function bundle(name, baseline) {
  const result = await build({
    entryPoints: [resolve(root, 'src/index.ts')], bundle: true, write: false,
    format: 'iife', globalName: name, target: 'es2022',
    plugins: baseline ? [{ name: 'git-baseline', setup(b) {
      b.onLoad({ filter: /\.ts$/ }, ({ path }) => ({
        contents: git('show', `${revision}:${relative(root, path)}`), loader: 'ts',
        resolveDir: resolve(path, '..'),
      }));
    } }] : [],
  });
  return result.outputFiles[0].text;
}
const [before, after] = await Promise.all([bundle('Before', true), bundle('After', values.control)]);
const scenes = [
  ...['clear', 'fair', 'summer', 'overcast', 'fog', 'rain', 'thunderstorm', 'snow', 'typhoon']
    .map(weather => ({ name: weather, conditions: { time: 14, weather } })),
  { name: 'night', conditions: { time: 23, weather: 'clear', celestial: 'dark-sky' } },
  { name: 'aurora', conditions: { time: 23, weather: 'clear', celestial: 'aurora' }, camera: { yaw: 0, pitch: 0.4 } },
  { name: 'sunset', conditions: { time: 18.2, weather: 'fair' }, camera: { yaw: 4.7, pitch: 0.15, fov: 1.1 } },
  { name: 'halos', conditions: { time: 17, weather: { clouds: { cirrostratus: 0.9 }, icePlates: 1 } }, camera: { yaw: 4.7, pitch: 0.15, fov: 1.1 } },
  { name: 'sea', conditions: { time: 14, weather: 'fair', ground: 'sea' }, camera: { pitch: 0, fov: 1 } },
  { name: 'tower-near', conditions: { time: 14, weather: { cloudCover: 0.3, convection: 0.9, features: { distance: 0.2 } } } },
  { name: 'tower-crossfade', conditions: { time: 14, weather: { cloudCover: 0.3, convection: 0.9, features: { distance: 0.47 } } } },
  { name: 'split', conditions: { time: 14, weather: 'summer' }, options: { cloudScale: 0.5 } },
  { name: 'rays', conditions: { time: 16, weather: 'fair' }, options: { cloudScale: 0.75, rays: 1 }, camera: { yaw: 4.3, pitch: 0.3 } },
  { name: 'cache', conditions: { time: 14, weather: 'summer' }, options: { skyCache: true } },
  ...['cirrus', 'cirrostratus', 'cirrocumulus', 'altostratus', 'altocumulus', 'nimbostratus', 'stratus', 'stratocumulus', 'cumulus', 'cumulonimbus']
    .map(genus => ({ name: `genus-${genus}`, conditions: { time: 14, weather: { clouds: { [genus]: 0.7 } } } })),
  { name: 'lenticular', conditions: { time: 17, weather: { clouds: {}, features: { lenticular: 1 } } }, camera: { pitch: 0.1 } },
];
const chosen = values.scenes ? scenes.filter(s => values.scenes.split(',').includes(s.name)) : scenes;
if (!chosen.length) throw new Error('No scenes selected');

const browser = await chromium.launch({ channel: 'chrome', args: [
  '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-webgl',
] });
const report = {
  revision, candidateBundleSha256: createHash('sha256').update(after).digest('hex'),
  browser: browser.version(), node: process.version, measuredAt: new Date().toISOString(),
  control: values.control, config, gpu: null, scenes: [],
};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setContent('<!doctype html><body style="margin:0;background:#222"></body>');
  await page.addScriptTag({ content: before });
  await page.addScriptTag({ content: after });
  for (const scene of chosen) {
    const result = await page.evaluate(async ({ scene, config }) => {
      const { width: w, height: h, frames, rounds } = config;
      const raf = () => new Promise(go => requestAnimationFrame(go));
      const median = a => [...a].sort((x, y) => x - y)[a.length >> 1] ?? null;
      const quantile = (a, q) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)] ?? null;
      // Share the drawing context as well as the GPU, avoiding compositor and
      // context scheduling differences between two otherwise identical skies.
      const canvas = document.body.appendChild(document.createElement('canvas'));
      canvas.style.cssText = 'width:480px;height:270px;display:block';
      const make = lib => {
        const r = new lib.AtmosphereRenderer(canvas, {
          compile: config.compile, timing: true, colorSpace: 'srgb', ...scene.options,
        });
        r.resize(w, h);
        const gl = canvas.getContext('webgl');
        if (!r.available || !gl) throw new Error('WebGL unavailable');
        const s = lib.resolveConditions(scene.conditions);
        const camera = { ...lib.DEFAULT_CAMERA, ...scene.camera };
        return { canvas, r, gl, s, camera };
      };
      const pair = [make(Before), make(After)];
      const ext = pair[0].gl.getExtension('WEBGL_debug_renderer_info');
      const gpu = ext ? pair[0].gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
      const draw = (p, i) => p.r.render(100 + i / 30, p.s, p.camera, 41.7 + i * 0.001, 7.3 + i * 0.002);
      try {
        const deadline = performance.now() + 120000;
        // Draw to ask for camera-specific variants too. Compile time is excluded
        // from steady-state timings; keep it separately as a diagnostic.
        const started = performance.now();
        do {
          for (const p of pair) draw(p, 0);
          await raf();
          if (performance.now() > deadline) throw new Error('Shader did not settle');
        } while (!pair.every(p => p.r.isSettled(p.s)));
        const settleMs = performance.now() - started;
        for (let i = 0; i < 30; i++) { for (const p of pair) draw(p, i); await raf(); }
        // Compare full pixels at three moments, outside the timing interval.
        const pictures = [];
        for (const moment of [40, 75, 110]) {
          const bytes = [], png = [];
          for (const p of pair) {
            draw(p, moment);
            const data = new Uint8Array(w * h * 4);
            p.gl.readPixels(0, 0, w, h, p.gl.RGBA, p.gl.UNSIGNED_BYTE, data);
            if (p.gl.getError() !== p.gl.NO_ERROR) throw new Error('WebGL error while capturing');
            bytes.push(data);
            png.push(p.canvas.toDataURL());
          }
          let sum = 0, max = 0, changed = 0, over2 = 0, over8 = 0;
          const diff = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < bytes[0].length; i += 4) {
            let d = 0;
            const y = Math.floor(i / 4 / w), x = i / 4 % w, j = ((h - y - 1) * w + x) * 4;
            for (let c = 0; c < 3; c++) {
              const v = Math.abs(bytes[0][i + c] - bytes[1][i + c]);
              sum += v; d = Math.max(d, v); diff[j + c] = Math.min(255, v * 16);
            }
            diff[j + 3] = 255;
            max = Math.max(max, d); changed += d > 0; over2 += d > 2; over8 += d > 8;
          }
          const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
          canvas.getContext('2d').putImageData(new ImageData(diff, w, h), 0, 0);
          pictures.push({ moment, mean: sum / (w * h * 3), max, changed, over2, over8,
            png: [...png, canvas.toDataURL()] });
        }
        const timings = [];
        for (let round = 0; round < rounds; round++) {
          const gpuTimes = [[], []], cpuTimes = [[], []];
          // Measure one renderer in a block. Alternating draws within a frame
          // biases even A/A on Metal; reverse each round to balance drift.
          for (const k of round % 2 ? [1, 0] : [0, 1]) {
            const p = pair[k];
            for (let i = 0; i < 15; i++) {
              draw(p, i);
              await raf();
            }
            p.gl.finish();
            await raf();
            p.r.takeGpuTimes();
            for (let i = 0; i < frames; i++) {
              const t = performance.now();
              draw(p, 120 + i);
              cpuTimes[k].push(performance.now() - t);
              await raf();
              gpuTimes[k].push(...p.r.takeGpuTimes().map(t => t.ms));
            }
            for (let i = 0; i < 5; i++) await raf();
            gpuTimes[k].push(...p.r.takeGpuTimes().map(t => t.ms));
          }
          timings.push(pair.map((_, k) => ({
            gpuMedian: median(gpuTimes[k]), gpuP95: quantile(gpuTimes[k], 0.95),
            cpuMedian: median(cpuTimes[k]), samples: gpuTimes[k].length,
          })));
        }
        return { gpu, settleMs, pictures, timings };
      } finally {
        pair[0].r.dispose();
        pair[1].r.dispose({ loseContext: true });
        canvas.remove();
      }
    }, { scene, config });
    if (errors.length) throw new Error(errors.join('\n'));
    report.gpu = result.gpu;
    for (const picture of result.pictures) {
      const png = picture.png; delete picture.png;
      picture.files = ['before', 'after', 'diff'].map(label => `${scene.name}-${picture.moment}-${label}.png`);
      await Promise.all(png.map((data, i) => writeFile(resolve(out, picture.files[i]), Buffer.from(data.split(',')[1], 'base64'))));
    }
    const entry = { name: scene.name, ...result };
    report.scenes.push(entry);
    await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
    const ms = result.timings.map(t => t.map(v => v.gpuMedian?.toFixed(3) ?? 'unavailable').join(' → ')).join(' / ');
    console.log(`${scene.name}: GPU ${ms} ms; max Δ ${Math.max(...result.pictures.map(p => p.max))}; mean Δ ${Math.max(...result.pictures.map(p => p.mean)).toFixed(5)}`);
  }
  const rows = report.scenes.map(s => `<h2>${s.name}</h2>` + s.pictures.map(p =>
    `<p>Frame ${p.moment}: mean Δ ${p.mean.toFixed(5)}, max Δ ${p.max}, pixels > 2: ${p.over2}</p><div>${p.files.map(f => `<a href="${f}"><img src="${f}" width="400"></a>`).join('')}</div>`).join('')).join('');
  await writeFile(resolve(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Renderer comparison</title><style>body{background:#222;color:#eee;font:14px system-ui}img{max-width:32%}div{display:flex;gap:8px}a{display:contents}</style><h1>Before / After / Difference ×16</h1><p>${revision} · ${report.gpu} · ${config.width}×${config.height}</p>${rows}`);
  console.log(`Report: ${resolve(out, 'index.html')}`);
} finally { await browser.close(); }
