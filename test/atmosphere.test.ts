import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Atmosphere } from '../src/atmosphere.js';

// The Atmosphere's bookkeeping round a renderer that does nothing: what gets
// drawn when there is no loop to draw it. A canvas here is only its numbers.

const { made, FakeRenderer } = vi.hoisted(() => {
  const made: InstanceType<typeof FakeRenderer>[] = [];
  class FakeRenderer {
    available = true;
    ready = false;
    colorSpace = 'srgb';
    cloudScale = 1;
    rays = 0;
    cumulonimbus = 'auto';
    render = vi.fn();
    prepare = vi.fn();
    dispose = vi.fn();
    takeGpuTimes = () => [];
    readonly canvas: HTMLCanvasElement;
    readonly opts: { onReady?: (available: boolean) => void; onLinked?: () => void };
    constructor(canvas: HTMLCanvasElement, opts: FakeRenderer['opts']) {
      this.canvas = canvas;
      this.opts = opts;
      made.push(this);
    }
    resize(w: number, h: number) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }
  return { made, FakeRenderer };
});

vi.mock('../src/renderer.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/renderer.js')>(),
  AtmosphereRenderer: FakeRenderer,
}));

const sized = (w: number, h: number) =>
  ({ width: 0, height: 0, clientWidth: w, clientHeight: h }) as HTMLCanvasElement;

function mount(options: ConstructorParameters<typeof Atmosphere>[1], canvas = sized(640, 360)) {
  const sky = new Atmosphere(canvas, { resolutionScale: 1, ...options });
  return { sky, canvas, renderer: made[made.length - 1] };
}

function reduceMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', () => ({ matches, addEventListener() {}, removeEventListener() {} }));
}

beforeEach(() => {
  made.length = 0;
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  reduceMotion(false);
});

afterEach(() => vi.unstubAllGlobals());

describe('a still frame under reduced motion', () => {
  beforeEach(() => reduceMotion(true));

  it('is drawn again after a resize, which clears the canvas', () => {
    const { sky, canvas, renderer } = mount({});
    expect(renderer.render).toHaveBeenCalledTimes(1);
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(canvas.width).toBe(800);
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('is not drawn again when the size has not changed', () => {
    const { sky, renderer } = mount({});
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('is the same moment each time, so a redraw moves nothing', () => {
    const { sky, canvas, renderer } = mount({});
    const wind = sky.state.timeOfDay;
    const first = renderer.render.mock.calls[0];
    const windOff = first[3], evo = first[4], time = first[0];
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    const again = renderer.render.mock.calls[1];
    expect(again[0]).toBe(time);
    expect(again[3]).toBe(windOff);
    expect(again[4]).toBe(evo);
    expect(sky.state.timeOfDay).toBe(wind);
  });

  it('is drawn again when the variant it needed has linked', () => {
    const { renderer } = mount({});
    renderer.opts.onLinked?.();
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });
});

describe('a jump() with no loop', () => {
  it('is drawn when the shader comes ready, though start() was never called', () => {
    const { sky, renderer } = mount({ autoStart: false });
    sky.jump();
    expect(renderer.render).toHaveBeenCalledTimes(1);   // too early: this one draws nothing
    renderer.opts.onReady?.(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('stays up through a resize', () => {
    const { sky, canvas, renderer } = mount({ autoStart: false });
    sky.jump();
    (canvas as { clientHeight: number }).clientHeight = 500;
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('is forgotten by stop()', () => {
    const { sky, canvas, renderer } = mount({ autoStart: false });
    sky.jump();
    sky.stop();
    renderer.opts.onReady?.(true);
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });
});

describe('with nothing asked for', () => {
  it('draws nothing when the shader comes ready or the canvas resizes', () => {
    const { sky, canvas, renderer } = mount({ autoStart: false });
    renderer.opts.onReady?.(true);
    renderer.opts.onLinked?.();
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('still tells the caller the shader is ready', () => {
    const onReady = vi.fn();
    const { renderer } = mount({ autoStart: false, onReady });
    renderer.opts.onReady?.(true);
    expect(onReady).toHaveBeenCalledWith(true);
  });
});

describe('a running loop', () => {
  it('is left to its next tick', () => {
    const { sky, canvas, renderer } = mount({});
    sky.jump();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    renderer.opts.onReady?.(true);
    renderer.opts.onLinked?.();
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });
});
