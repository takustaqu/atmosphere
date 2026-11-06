import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import type { Atmosphere, AtmosphereRenderer, Conditions, resolveConditions } from '../src/index.js';
import type { AtmosphereCanvasProps } from '../examples/react/index.js';

declare global {
  interface Window {
    Atmosphere: typeof Atmosphere;
    AtmosphereRenderer: typeof AtmosphereRenderer;
    resolveConditions: typeof resolveConditions;
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

test.describe('a canvas out of view', () => {
  /** how many draws the page's WebGL has made so far */
  const draws = (page: Page) => page.evaluate(() => (window as unknown as { draws: number }).draws);
  const counting = (page: Page) => page.evaluate(() => {
    const w = window as unknown as { draws: number };
    w.draws = 0;
    const proto = WebGLRenderingContext.prototype, orig = proto.drawArrays;
    proto.drawArrays = function (...a) { w.draws++; return orig.apply(this, a); };
  });

  test('is not drawn, and is drawn again with the sky moved on when it comes back', async ({ page }) => {
    await open(page, 'no-preference');
    await counting(page);
    await page.evaluate(() => {
      document.body.append(Object.assign(document.createElement('div'), { style: 'height:3000px' }));
      window.sky = new window.Atmosphere(document.querySelector('canvas')!, { time: 14, weather: 'fair', resolutionScale: 1 });
    });
    await daylightOn(page, 'canvas');
    await expect.poll(() => draws(page)).toBeGreaterThan(0);

    await page.evaluate(() => window.scrollTo(0, 2000));
    await page.waitForTimeout(300);
    const out = await draws(page);
    await page.waitForTimeout(700);
    expect(await draws(page)).toBe(out);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => draws(page)).toBeGreaterThan(out);
    await daylightOn(page, 'canvas');
  });

  test('comes back from under display: none, at its new size', async ({ page }) => {
    await open(page, 'no-preference');
    await page.evaluate(() => {
      window.sky = new window.Atmosphere(document.querySelector('canvas')!, { time: 14, weather: 'fair', resolutionScale: 1 });
    });
    await daylightOn(page, 'canvas');
    await page.evaluate(() => { document.querySelector('canvas')!.style.display = 'none'; });
    await page.waitForTimeout(300);
    await page.evaluate(() => { document.querySelector('canvas')!.style.cssText = 'display:block;width:400px'; });
    await page.waitForFunction(() => document.querySelector('canvas')!.width === 400);
    await daylightOn(page, 'canvas');
  });

  test('is drawn on under pauseOffscreen: false', async ({ page }) => {
    await open(page, 'no-preference');
    await counting(page);
    await page.evaluate(() => {
      document.body.append(Object.assign(document.createElement('div'), { style: 'height:3000px' }));
      window.sky = new window.Atmosphere(document.querySelector('canvas')!, { time: 14, weather: 'fair', resolutionScale: 1, pauseOffscreen: false });
      window.scrollTo(0, 2000);
    });
    await expect.poll(() => draws(page), { timeout: 30_000 }).toBeGreaterThan(0);
    const before = await draws(page);
    await expect.poll(() => draws(page)).toBeGreaterThan(before);
  });
});

test.describe('AtmosphereCanvas', () => {
  const cases: [string, AtmosphereCanvasProps, AtmosphereCanvasProps][] = [
    ['tone', { time: 14, weather: 'fair' }, { tone: { exposure: 1.5 } }],
    ['polarizer', { time: 14, weather: 'clear', camera: { yaw: 0, pitch: 0.7 } }, { polarizer: { strength: 1 } }],
    ['celestial', { time: 23, weather: 'clear', camera: { yaw: 0, pitch: 0.5 }, location: { latitude: 65, longitude: 25 } }, { celestial: 'aurora' }],
    ['lens', { time: 14, weather: 'fair' }, { lens: { vignette: false } }],
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

/** what is really on the screen there, every pixel: rgba rows from the top */
async function pixels(page: Page, selector: string): Promise<{ width: number; height: number; data: number[] }> {
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
    return { width: c.width, height: c.height, data: Array.from(x.getImageData(0, 0, c.width, c.height).data) };
  }, png);
}

type Pixels = Awaited<ReturnType<typeof pixels>>;

/** how many pixels are near white, and the mean level of those `from`..`to` px from a point */
function aroundSun(p: Pixels, x: number, y: number, from: number, to: number) {
  let white = 0, sum = 0, n = 0;
  for (let j = 0; j < p.height; j++) for (let i = 0; i < p.width; i++) {
    const k = (j * p.width + i) * 4, d = p.data;
    if (Math.min(d[k], d[k + 1], d[k + 2]) >= 250) white++;
    const r = Math.hypot(i - x, j - y);
    if (r >= from && r <= to) { sum += (d[k] + d[k + 1] + d[k + 2]) / 3; n++; }
  }
  return { white, ring: sum / Math.max(1, n) };
}

/** how many pixels of two pictures differ by more than a few levels */
function changed(a: Pixels, b: Pixels): number {
  let n = 0;
  for (let k = 0; k < a.data.length; k += 4) {
    if (Math.max(Math.abs(a.data[k] - b.data[k]), Math.abs(a.data[k + 1] - b.data[k + 1]), Math.abs(a.data[k + 2] - b.data[k + 2])) > 4) n++;
  }
  return n;
}

test.describe('the lens and the sun', () => {
  // a still noon sky looking just off the sun, the canvas drawn at 480×300
  async function sunInShot(page: Page): Promise<{ x: number; y: number }> {
    await open(page, 'reduce');
    return page.evaluate(async () => {
      const canvas = document.querySelector('canvas')!;
      canvas.style.cssText = 'width:480px;height:300px';
      const s = window.resolveConditions({ time: 12, weather: 'clear' });
      const camera = { yaw: s.sunAzimuth + 0.12, pitch: s.sunElevation - 0.08, fov: 1.05 };
      window.sky = new window.Atmosphere(canvas, { time: 12, weather: 'clear', camera, resolutionScale: 1 });
      await window.sky.whenSettled();
      const { x, y } = window.sky.light.sun.screen;
      return { x: x * 480, y: y * 300 };
    });
  }

  /** the still frame once these conditions are on it */
  async function under(page: Page, c: Conditions): Promise<Pixels> {
    await page.evaluate(async (c) => { window.sky.set(c); await window.sky.whenSettled(); }, c);
    await settled(page, 'canvas');
    return pixels(page, 'canvas');
  }

  test('switches the flare and the vignette off on their own', async ({ page }) => {
    await sunInShot(page);
    const base = await under(page, {});
    const noFlare = await under(page, { lens: { flare: false } });
    const noVignette = await under(page, { lens: { flare: true, vignette: false } });
    const back = await under(page, { lens: { vignette: true } });
    const [flare, vignette, again] = [changed(base, noFlare), changed(base, noVignette), changed(base, back)];
    console.log(`pixels changed: flare off ${flare}, vignette off ${vignette}, both back on ${again} (of ${base.data.length / 4})`);
    expect(flare).toBeGreaterThan(300);
    expect(vignette).toBeGreaterThan(5000);
    expect(again).toBeLessThan(50);
    // the vignette darkens the corners: without it they are brighter
    const corner = (p: Pixels) => p.data[0] + p.data[1] + p.data[2];
    expect(corner(noVignette)).toBeGreaterThan(corner(base) + 6);
  });

  test('draws the sun smaller, and without its glare', async ({ page }) => {
    const { x, y } = await sunInShot(page);
    const at = (p: Pixels) => aroundSun(p, x, y, 25, 80);
    const base = at(await under(page, {}));
    const small = at(await under(page, { sun: { disc: 0.53 } }));
    const bare = at(await under(page, { sun: { disc: 0.53, glare: 0 } }));
    // (a set() replaces the whole of the sun's settings: the disc goes back to its default)
    const glareless = at(await under(page, { sun: { glare: 0 } }));
    console.log(`near-white px / mean level 25-80 px out: default ${base.white} / ${base.ring.toFixed(1)}, `
      + `disc 0.53 ${small.white} / ${small.ring.toFixed(1)}, disc 0.53 glare 0 ${bare.white} / ${bare.ring.toFixed(1)}, `
      + `glare 0 ${glareless.white} / ${glareless.ring.toFixed(1)}`);
    expect(base.white).toBeGreaterThan(400);
    expect(small.white).toBeLessThan(base.white / 10);
    expect(small.white).toBeGreaterThan(0);
    expect(glareless.ring).toBeLessThan(base.ring - 10);
    expect(bare.ring).toBeLessThan(small.ring - 10);
  });
});

test.describe('settling', () => {
  test('is said after the start and again after a set() that needs a new variant', async ({ page }) => {
    await open(page, 'no-preference');
    const said = () => page.evaluate(() => (window as unknown as { said: boolean[] }).said);
    await page.evaluate(() => {
      const w = window as unknown as { said: boolean[] };
      w.said = [];
      window.sky = new window.Atmosphere(document.querySelector('canvas')!, {
        time: 14, weather: 'clear', resolutionScale: 1, onSettled: (ok) => w.said.push(ok),
      });
    });
    await expect.poll(said, { timeout: 30_000 }).toEqual([true]);
    expect(await page.evaluate(() => window.sky.settled)).toBe(true);
    await daylightOn(page, 'canvas');

    // the sea is a variant of its own, not linked until asked for
    expect(await page.evaluate(() => { window.sky.set({ ground: 'sea' }); return window.sky.settled; })).toBe(false);
    expect(await page.evaluate(() => window.sky.whenSettled())).toBe(true);
    expect(await said()).toEqual([true, true]);

    // and a set() that needs nothing new says nothing
    expect(await page.evaluate(() => { window.sky.set({ time: 14.5 }); return window.sky.settled; })).toBe(true);
    await page.waitForTimeout(500);
    expect(await said()).toEqual([true, true]);
  });

  test('on the renderer: at once under compile: sync, and from prepare() to the link under auto', async ({ page }) => {
    await open(page, 'no-preference');
    const r = await page.evaluate(async () => {
      const until = async (f: () => boolean) => {
        const t0 = performance.now();
        while (!f() && performance.now() - t0 < 30_000) await new Promise((go) => setTimeout(go, 20));
        return f();
      };
      const fair = window.resolveConditions({ time: 14, weather: 'fair' });
      const sea = window.resolveConditions({ time: 14, weather: 'fair', ground: 'sea' });

      const sync = new window.AtmosphereRenderer(document.createElement('canvas'), { compile: 'sync' });
      sync.prepare(fair);
      const syncFair = sync.isSettled(fair);
      sync.prepare(sea);
      const syncSea = sync.isSettled(sea);
      sync.dispose({ loseContext: true });

      const auto = new window.AtmosphereRenderer(document.createElement('canvas'));
      auto.prepare(fair);
      const autoBefore = auto.isSettled(fair);
      const autoAfter = await until(() => auto.isSettled(fair));
      auto.prepare(sea);
      const seaBefore = auto.isSettled(sea);
      const seaAfter = await until(() => auto.isSettled(sea));
      auto.dispose({ loseContext: true });
      return { syncFair, syncSea, autoBefore, autoAfter, seaBefore, seaAfter };
    });
    expect(r).toEqual({ syncFair: true, syncSea: true, autoBefore: false, autoAfter: true, seaBefore: false, seaAfter: true });
  });

  test('says false where there is no WebGL, as onReady does', async ({ page }) => {
    await open(page, 'no-preference');
    const r = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.getContext = (() => null) as typeof canvas.getContext;
      const ready: boolean[] = [], said: boolean[] = [];
      const sky = new window.Atmosphere(canvas, { onReady: (ok) => ready.push(ok), onSettled: (ok) => said.push(ok) });
      return { ready, said, settled: sky.settled, when: await sky.whenSettled() };
    });
    expect(r).toEqual({ ready: [false], said: [false], settled: false, when: false });
  });
});
