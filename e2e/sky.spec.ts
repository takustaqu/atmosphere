import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import type { Atmosphere } from '../src/index.js';
import type { AtmosphereCanvasProps } from '../examples/react/index.js';

declare global {
  interface Window {
    Atmosphere: typeof Atmosphere;
    renderSky(id: string, props: AtmosphereCanvasProps): void;
    sky: Atmosphere;
  }
}

let bundle = '';

test.beforeAll(async () => {
  const out = await build({
    entryPoints: ['e2e/fixture.tsx'],
    bundle: true,
    format: 'iife',
    write: false,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  bundle = out.outputFiles[0].text;
});

// a blank canvas shows the page's magenta, or the black of a cleared one
const PAGE = `<!doctype html><style>
  body { margin: 0; background: #f0f; }
  canvas { display: block; width: 320px; height: 200px; }
</style><canvas id="c"></canvas><div id="a"></div><div id="b"></div>`;

async function open(page: Page, reducedMotion: 'reduce' | 'no-preference') {
  await page.emulateMedia({ reducedMotion });
  await page.setContent(PAGE);
  await page.addScriptTag({ content: bundle });
}

interface Picture { r: number; g: number; b: number; spread: number }

/** what is really on the screen where the selector is: a screenshot, not the drawing buffer */
async function picture(page: Page, selector: string): Promise<Picture> {
  const png = (await page.locator(selector).screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const x = c.getContext('2d')!;
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let r = 0, g = 0, b = 0, l2 = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
      l2 += l * l;
    }
    r /= n;
    g /= n;
    b /= n;
    const m = (r + g + b) / 3;
    return { r, g, b, spread: Math.sqrt(Math.max(l2 / n - m * m, 0)) };
  }, png);
}

// a daytime sky, not magenta or black: blue over red, bright, and not one flat color
const isDaylight = (p: Picture) => p.b > p.r && p.g > 60 && p.spread > 2;
const apart = (a: Picture, b: Picture) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

async function daylightOn(page: Page, selector: string) {
  await expect.poll(async () => isDaylight(await picture(page, selector)), { timeout: 30_000 }).toBe(true);
}

/** the picture once a few frames' worth of compile and draw have gone by and it has stopped changing */
async function settled(page: Page, selector: string): Promise<Picture> {
  let last = await picture(page, selector);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const now = await picture(page, selector);
    if (apart(now, last) < 0.5) return now;
    last = now;
  }
  return last;
}

test.describe('a still frame', () => {
  test('under reduced motion stays up through a resize', async ({ page }) => {
    await open(page, 'reduce');
    await page.evaluate(() => {
      window.sky = new window.Atmosphere(document.querySelector('canvas')!, { time: 14, weather: 'fair', resolutionScale: 1 });
    });
    await daylightOn(page, 'canvas');
    await page.evaluate(() => { document.querySelector('canvas')!.style.width = '400px'; });
    await page.waitForFunction(() => document.querySelector('canvas')!.width === 400);
    await daylightOn(page, 'canvas');
  });

  test('from a jump() before the shader has compiled is drawn when it has', async ({ page }) => {
    await open(page, 'no-preference');
    await page.evaluate(() => {
      window.sky = new window.Atmosphere(document.querySelector('canvas')!, { time: 14, weather: 'fair', resolutionScale: 1, autoStart: false });
      window.sky.jump();
    });
    await daylightOn(page, 'canvas');
  });

  test('takes the new weather under reduced motion, once its variant has linked', async ({ page }) => {
    await open(page, 'reduce');
    await page.evaluate(() => {
      window.sky = new window.Atmosphere(document.querySelector('canvas')!, { time: 14, weather: 'clear', resolutionScale: 1 });
    });
    await daylightOn(page, 'canvas');
    const clear = await settled(page, 'canvas');
    await page.evaluate(() => window.sky.set({ weather: 'overcast' }));
    await expect.poll(async () => {
      const p = await picture(page, 'canvas');
      return p.b - p.r < (clear.b - clear.r) / 2;
    }, { timeout: 30_000 }).toBe(true);
  });
});

test.describe('AtmosphereCanvas', () => {
  const cases: [string, AtmosphereCanvasProps, AtmosphereCanvasProps][] = [
    ['tone', { time: 14, weather: 'fair' }, { tone: { exposure: 1.5 } }],
    ['polarizer', { time: 14, weather: 'clear', camera: { yaw: 0, pitch: 0.7 } }, { polarizer: { strength: 1 } }],
    ['celestial', { time: 23, weather: 'clear', camera: { yaw: 0, pitch: 0.5 }, location: { latitude: 65, longitude: 25 } }, { celestial: 'aurora' }],
  ];

  for (const [name, base, prop] of cases) {
    test(`takes ${name}, when mounted and when it changes`, async ({ page }) => {
      await open(page, 'reduce');
      await page.evaluate((b) => window.renderSky('a', b), base);
      await page.waitForSelector('#a canvas');
      await page.waitForTimeout(500);
      const without = await settled(page, '#a canvas');
      await page.evaluate(([b, p]) => window.renderSky('a', { ...b, ...p }), [base, prop] as const);
      await expect.poll(async () => apart(await picture(page, '#a canvas'), without), { timeout: 30_000 })
        .toBeGreaterThan(1);
      // mounted with it from the start, the same picture: polled, as either may
      // still be going without a variant that is linking
      await page.evaluate(([b, p]) => window.renderSky('b', { ...b, ...p }), [base, prop] as const);
      await page.waitForSelector('#b canvas');
      await expect.poll(async () => {
        const [changed, mounted] = [await picture(page, '#a canvas'), await picture(page, '#b canvas')];
        return apart(changed, mounted) < 1.5 && apart(changed, without) > 4;
      }, { timeout: 30_000 }).toBe(true);
    });
  }
});
