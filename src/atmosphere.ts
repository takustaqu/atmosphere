// atmosphere.ts — atmosphere, as seen by the caller
//
//   const sky = new Atmosphere(canvas, { time: new Date(), weather: 'rain' });
//   sky.set({ weather: { cloudCover: 1, precipitation: 40, windSpeed: 30 } });
//
// A thin layer that just bundles a canvas, the renderer, and a render loop.
// To integrate with your own loop instead, use AtmosphereRenderer + StateAnimator directly.

import { StateAnimator, type AnimatorOptions } from './animator.js';
import { type ColorSpaceOption } from './gamut.js';
import { AtmosphereRenderer } from './renderer.js';
import {
  resolveCamera, resolveConditions,
  type AtmosphereState, type Camera, type Conditions,
} from './state.js';

export interface AtmosphereOptions extends Conditions {
  /** frame rate cap. Defaults to 30fps (battery-friendly) since this is meant for backgrounds */
  fps?: number;
  /**
   * internal resolution multiplier. fbm is expensive, so this defaults to
   * devicePixelRatio (capped at 1.5) × 0.55, rendered small and scaled up by CSS.
   */
  resolutionScale?: number;
  /**
   * which color space to render into. Defaults to `'auto'`: Display P3 where
   * the browser supports it, sRGB otherwise. The two look the same on an sRGB
   * display — what P3 buys is the sun, moon, stars, lightning and magic-hour
   * amber reaching colors sRGB can't express.
   */
  colorSpace?: ColorSpaceOption;
  /** tuning for following / wind / shape evolution */
  animator?: AnimatorOptions;
  /** pass false to not start rendering on construction */
  autoStart?: boolean;
  /**
   * Called once the shader has compiled, or failed to.
   *
   * The sky draws nothing until this fires — the shader is compiled off the
   * main thread so the page stays responsive, which takes a couple of seconds
   * the first time a browser sees it and is near-instant afterwards (browsers
   * cache compiled shaders on disk). Use it to cross-fade the canvas in over
   * whatever background was there, and to keep that background for good on
   * `false`, which means this device could not compile the shader at all.
   */
  onReady?: (available: boolean) => void;
  /**
   * pass false to keep animating even under `prefers-reduced-motion: reduce`.
   *
   * On by default: a full-screen sky in constant motion is hard on users with
   * vestibular disorders, so when the OS asks for reduced motion, `start()`
   * draws a single still frame instead of looping, and `set()` applies
   * changes as cuts (no transition).
   */
  respectReducedMotion?: boolean;
}

const DEFAULT_RESOLUTION_SCALE = () =>
  Math.min(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 1.5) * 0.55;

export class Atmosphere {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: AtmosphereRenderer;
  private readonly animator: StateAnimator;
  private readonly opts: AtmosphereOptions;

  private target: AtmosphereState;
  private conditions: Conditions;
  private cam: Camera;

  private raf = 0;
  private observer: ResizeObserver | null = null;
  private startedAt = 0;
  private last = 0;
  private lastDraw = 0;
  // "the caller wants rendering" — kept separate from the raf loop, so
  // reduced-motion can pause the loop without forgetting the caller's intent
  private wantRunning = false;
  private motionQuery: MediaQueryList | null = null;
  // The shader compiles asynchronously, so the frames the caller asked for
  // before it was ready drew nothing. A running loop picks itself up on its
  // next tick; a still frame — reduced motion, or a jump() before start() —
  // has no next tick and has to be drawn here or never.
  private readonly onRendererReady = (available: boolean) => {
    if (available && this.wantRunning && !this.raf) this.draw(performance.now());
    this.opts.onReady?.(available);
  };
  private readonly onMotionChange = () => {
    if (!this.wantRunning) return;
    if (this.reducedMotion) {
      this.stopLoop();
      this.jump();               // settle any half-finished transition, draw once
    } else {
      this.startLoop();
    }
  };

  constructor(canvas: HTMLCanvasElement, options: AtmosphereOptions = {}) {
    this.canvas = canvas;
    this.opts = options;
    this.conditions = {
      time: options.time,
      location: options.location,
      weather: options.weather,
      filter: options.filter,
      tone: options.tone,
      polarizer: options.polarizer,
      celestial: options.celestial,
      camera: options.camera,
    };
    this.target = resolveConditions(this.conditions);
    this.cam = resolveCamera(options.camera);
    this.renderer = new AtmosphereRenderer(canvas, {
      colorSpace: options.colorSpace,
      onReady: this.onRendererReady,
    });
    this.animator = new StateAnimator(this.target, options.animator);

    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(canvas);
    }
    if (options.respectReducedMotion !== false && typeof matchMedia !== 'undefined') {
      this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
      this.motionQuery.addEventListener('change', this.onMotionChange);
    }
    if (options.autoStart !== false) this.start();
  }

  /** true when the environment asks for reduced motion (and the option honors it) */
  get reducedMotion(): boolean { return this.motionQuery?.matches ?? false; }

  /** false in environments where WebGL isn't available, or once the shader has failed to compile */
  get available(): boolean { return this.renderer.available; }

  /**
   * true once the shader has compiled and frames are actually reaching the
   * canvas. Starts false; {@link AtmosphereOptions.onReady} fires when it flips.
   */
  get ready(): boolean { return this.renderer.ready; }

  /** the space actually being rendered into (`'display-p3'` only where supported) */
  get colorSpace(): PredefinedColorSpace { return this.renderer.colorSpace; }

  /**
   * A snapshot of the current (mid-transition) state.
   *
   * The animator mutates its state in place every frame, so this returns a
   * copy — safe to hold on to and compare across frames. For a zero-copy live
   * view (e.g. a custom render loop), use `StateAnimator.current` directly.
   */
  get state(): Readonly<AtmosphereState> {
    const c = this.animator.current;
    return {
      ...c,
      clouds: { ...c.clouds },
      features: { ...c.features },
      filter: { ...c.filter, tint: [...c.filter.tint] },
      tone: { ...c.tone },
      polarizer: { ...c.polarizer },
      celestial: {
        ...c.celestial,
        radiant: c.celestial.radiant ? [c.celestial.radiant[0], c.celestial.radiant[1]] : null,
      },
    };
  }

  /** the direction currently being faced */
  get camera(): Readonly<Camera> { return this.cam; }

  /**
   * update the target. Only the given fields change, transitioning over a few
   * seconds (under reduced motion the change applies as a cut instead)
   */
  set(c: Conditions): void {
    this.applyConditions(c);
    // with the loop stopped by reduced motion, a transition would never be
    // drawn — apply the new target to the still frame directly
    if (this.wantRunning && !this.raf && this.reducedMotion) {
      this.animator.jump(this.target);
      this.draw(performance.now());
    }
  }

  /** apply instantly, with no transition (for initial display, or a scene cut) */
  jump(c: Conditions = {}): void {
    this.applyConditions(c);
    this.animator.jump(this.target);
    this.draw(performance.now());
  }

  private applyConditions(c: Conditions): void {
    this.conditions = { ...this.conditions, ...c };
    this.target = resolveConditions(this.conditions);
    if (c.camera) this.cam = resolveCamera({ ...this.cam, ...c.camera });
  }

  /** recompute internal resolution from the canvas's displayed size */
  resize(): void {
    const scale = this.opts.resolutionScale ?? DEFAULT_RESOLUTION_SCALE();
    const w = this.canvas.clientWidth || this.canvas.width;
    const h = this.canvas.clientHeight || this.canvas.height;
    this.renderer.resize(
      Math.max(1, Math.round(w * scale)),
      Math.max(1, Math.round(h * scale)),
    );
  }

  start(): void {
    if (!this.available) return;
    this.wantRunning = true;
    if (this.reducedMotion) {
      // a still sky: settle the transition and draw exactly one frame
      this.jump();
      return;
    }
    this.startLoop();
  }

  /** stop the render loop (let the GPU rest). State is preserved */
  stop(): void {
    this.wantRunning = false;
    this.stopLoop();
  }

  private startLoop(): void {
    if (this.raf) return;
    const now = performance.now();
    if (!this.startedAt) this.startedAt = now;
    this.last = now;
    const tick = (t: number) => {
      this.raf = requestAnimationFrame(tick);
      const interval = 1000 / (this.opts.fps ?? 30);
      const elapsed = t - this.lastDraw;
      if (elapsed < interval) return;
      // carry the remainder instead of resetting to t: with rAF quantized to
      // the display's refresh, "t - lastDraw < interval" alone rounds a 30fps
      // cap on a 120Hz display down to 24fps
      this.lastDraw = t - (elapsed % interval);
      this.draw(t);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private draw(t: number): void {
    // jump() can be called before start(). Pin the reference time here
    if (!this.startedAt) { this.startedAt = t; this.last = t; }
    const dt = Math.min(0.2, (t - this.last) / 1000);
    this.last = t;
    this.animator.step(this.target, dt);
    // A meteor only reads as a meteor because it moves. Under reduced motion the
    // loop draws a single still frame, so one caught mid-flight would sit there
    // as a scratch across the sky — suppress them rather than freeze them.
    if (this.reducedMotion) this.animator.current.celestial.meteors = 0;
    this.renderer.render(
      (t - this.startedAt) / 1000,
      this.animator.current,
      this.cam,
      this.animator.wind,
      this.animator.evolution,
    );
  }

  /**
   * Stop drawing and release resources.
   *
   * @param options.loseContext see {@link AtmosphereRenderer.dispose}. Turn it
   *   on only for a throwaway canvas; a canvas that gets remounted should keep
   *   its context.
   */
  dispose(options: { loseContext?: boolean } = {}): void {
    this.stop();
    this.observer?.disconnect();
    this.observer = null;
    this.motionQuery?.removeEventListener('change', this.onMotionChange);
    this.motionQuery = null;
    this.renderer.dispose(options);
  }
}
