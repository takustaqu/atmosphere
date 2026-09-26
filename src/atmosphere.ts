// atmosphere.ts — atmosphere, as seen by the caller
//
//   const sky = new Atmosphere(canvas, { time: new Date(), weather: 'rain' });
//   sky.set({ weather: { cloudCover: 1, precipitation: 40, windSpeed: 30 } });
//
// A thin layer that just bundles a canvas, the renderer, and a render loop.
// To integrate with your own loop instead, use AtmosphereRenderer + StateAnimator directly.

import { StateAnimator, type AnimatorOptions } from './animator.js';
import { type ColorSpaceOption } from './gamut.js';
import {
  celestialLights, mixMeasurement,
  type AtmosphereLight, type LightMeasurement,
} from './light.js';
import { AtmosphereRenderer, type ProbeOptions } from './renderer.js';
import {
  resolveCamera, resolveConditions,
  type AtmosphereState, type Camera, type Conditions,
} from './state.js';

export interface LightProbeOptions extends ProbeOptions {
  /** measurements per second. Defaults to 10 */
  rate?: number;
  /**
   * Time constant of the smoothing, in seconds. Defaults to 0.3.
   *
   * The probe point-samples a moving sky, so a raw series shimmers as cloud
   * edges cross the samples. 0 takes every measurement as it comes — lightning
   * then reaches the foreground at full strength, shimmer and all.
   */
  smoothing?: number;
}

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
   * `false`, which means this device has no WebGL or could not compile the
   * shader at all.
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
  /**
   * Measure the sky's light for whatever is drawn in front of it — see
   * {@link Atmosphere.light}. Off by default: each measurement is a small
   * extra draw and a GPU readback. `true` takes the defaults.
   */
  lightProbe?: boolean | LightProbeOptions;
  /**
   * Called after each light measurement (at the probe's rate), with the same
   * object {@link Atmosphere.light} would return. The place to push the
   * numbers into another renderer's lights.
   */
  onLight?: (light: AtmosphereLight) => void;
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
  private measured: LightMeasurement | null = null;
  private lastProbe = -Infinity;
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
      lens: options.lens,
      particles: options.particles,
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
      lens: { ...c.lens },
      particles: { ...c.particles },
    };
  }

  /** the direction currently being faced */
  get camera(): Readonly<Camera> { return this.cam; }

  /**
   * The sky's light, for lighting whatever stands in front of it: the sun and
   * moon as directional lights, and — with {@link AtmosphereOptions.lightProbe}
   * on — the frame and the dome around it as measured colors. See light.ts.
   *
   * The lights are computed fresh on every read, so they track the camera and
   * the transition exactly. The measurements update at the probe's rate and
   * are null until the first one lands (and always, with the probe off).
   */
  get light(): AtmosphereLight {
    const w = this.canvas.width, h = this.canvas.height;
    return {
      ...celestialLights(this.animator.current, this.cam, w / Math.max(1, h)),
      frame: this.measured?.frame ?? null,
      environment: this.measured?.environment ?? null,
    };
  }

  /**
   * Measure now, without waiting for the probe's next turn and without
   * smoothing — for a still sky, or a one-off read. Works with the probe
   * option off too. Returns {@link light} afterwards, or null while the shader
   * is still compiling.
   */
  measureLight(options: ProbeOptions = {}): AtmosphereLight | null {
    const m = this.probe(performance.now(), { ...this.probeOptions, ...options });
    if (!m) return null;
    this.measured = m;
    this.lastProbe = performance.now();
    const light = this.light;
    this.opts.onLight?.(light);
    return light;
  }

  private get probeOptions(): LightProbeOptions {
    const o = this.opts.lightProbe;
    return typeof o === 'object' ? o : {};
  }

  private probe(t: number, options: ProbeOptions): LightMeasurement | null {
    return this.renderer.probe(
      (t - (this.startedAt || t)) / 1000,
      this.animator.current,
      this.cam,
      this.animator.wind,
      this.animator.evolution,
      options,
    );
  }

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
    if (this.opts.lightProbe) this.maybeProbe(t);
    this.renderer.render(
      (t - this.startedAt) / 1000,
      this.animator.current,
      this.cam,
      this.animator.wind,
      this.animator.evolution,
    );
  }

  /**
   * Take a light measurement if one is due, folded into the running average.
   *
   * Before the frame's own draw on purpose: readPixels waits for everything
   * queued ahead of it, and the tiny probe is far cheaper to wait on than the
   * full frame. A still frame (reduced motion, jump()) always measures and
   * takes the result unsmoothed — there is no series for it to belong to.
   */
  private maybeProbe(t: number): void {
    const o = this.probeOptions;
    const still = !this.raf;
    const interval = 1000 / Math.max(0.1, o.rate ?? 10);
    if (!still && t - this.lastProbe < interval) return;
    const m = this.probe(t, o);
    if (!m) return;
    const tau = Math.max(0, o.smoothing ?? 0.3);
    // the gap since the last measurement, not this frame's dt: they are a probe interval apart
    const gap = Math.min(1, (t - this.lastProbe) / 1000);
    const k = still || !this.measured || tau === 0 ? 1 : 1 - Math.exp(-gap / tau);
    this.measured = this.measured ? mixMeasurement(this.measured, m, k) : m;
    this.lastProbe = t;
    this.opts.onLight?.(this.light);
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
