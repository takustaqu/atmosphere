// skycache.ts — the sky cache's bookkeeping (RendererOptions.skyCache)
//
// The cloud stack — every layer, the cumulonimbus most of all — is a
// function of the view ray's direction, the state and the slowly running
// clocks (wind, evolution, time), and of nothing about the camera but how
// wide one pixel is. So it can be drawn once into a map over azimuth ×
// elevation and read back per pixel by direction: turning the camera then
// costs the stack nothing.
//
// What has to be paid for is that the stack moves. The map is redrawn as a
// series of keyframes, each one whole at one moment (its clocks frozen for
// the whole of its build, so no keyframe is ever two moments torn along a
// seam), and each frame shows the two that bracket it, mixed by how far the
// frame is between them. Keyframe j is shown from frame (j-1)N to (j+1)N —
// rising in as the second of the pair, then fading out as the first — and is
// built over the N frames before that, a slice of its columns a frame, for
// the clocks it will be shown at: the moment jN, predicted from the clocks'
// rates now. So the picture is not late, and the cost of a keyframe is
// spread evenly over N frames.
//
// This file is the scheduling alone, free of WebGL so it can be tested: what
// to build this frame and where, and which two keyframes to show, or none
// (and the renderer draws the frame directly).

import { type Camera } from './state.js';

export interface SkyCacheOptions {
  /**
   * What each keyframe covers. `'view'` (the default): a window round the
   * view, its middle where the view will be halfway through the keyframe's
   * showing and widened by how fast the camera turns — a keyframe some two
   * frames' worth of texels, 55-140 MB for three at 1080p; a view that
   * leaves it (a turn that speeds up faster than the window widens) is drawn
   * directly. `'panorama'`: the whole circle of azimuth, from just under the
   * horizon to a little above the view's top (the zenith once it is near) —
   * any turn of the camera free, a keyframe four to eight frames' worth,
   * 130-310 MB.
   */
  region?: 'panorama' | 'view';
  /** texels per radian, as a multiple of the view's pixels per radian at its middle (height / fov). Defaults to 1 */
  density?: number;
  /**
   * frames between keyframes (N). Defaults to 15: what a frame shows between
   * two keyframes is a mix of them, so an edge that moves is drawn as a
   * dissolve across the N frames — the fewer, the closer to the edge's own
   * motion, and the more a keyframe's cost weighs on each frame
   */
  frames?: number;
  /** the most texels one keyframe's map may hold; a view that needs more is drawn directly. Defaults to 16 million */
  budget?: number;
  /** radians kept round the view in a `'view'` window, past what its turning asks. Defaults to 0.12 */
  margin?: number;
}

/** a keyframe's map: the texture's grid laid over directions (radians) */
export interface MapRect {
  /** the azimuth at the map's middle column */
  azC: number;
  /** the elevation at the map's foot (its bottom edge) */
  el0: number;
  /** the azimuth the whole width spans */
  azSpan: number;
  /** the elevation the whole height spans */
  elSpan: number;
}

/** a range of texels, end exclusive */
export interface TexelBox { c0: number; c1: number; r0: number; r1: number }

/** the clocks a keyframe is built for */
export interface Clocks { time: number; wind: number; evo: number }

export interface Keyframe {
  /** its place on the schedule: shown whole at frame j·N */
  j: number;
  slot: number;
  rect: MapRect;
  /** the texels it holds (built, and only these valid) */
  box: TexelBox;
  /** the same, as directions: azimuth off rect.azC, and elevation */
  cover: { azLo: number; azHi: number; elLo: number; elHi: number };
  clocks: Clocks;
  /** the pixel angle of the view it was built for (fov / height) */
  viewPx: number;
  sig: number[];
  /** how many of its box's columns are built */
  built: number;
}

export interface CacheFrameInput {
  /** every number of the state the cloud stack reads (see stackSignature) */
  sig: number[];
  clocks: Clocks;
  camera: Camera;
  width: number;
  height: number;
  /** the largest texture the context can make */
  maxTexture: number;
}

export interface CacheFramePlan {
  /** the texture size every slot must have this frame (reallocate on change) */
  size: [number, number];
  /** the slice to draw into a keyframe this frame */
  build: { key: Keyframe; c0: number; c1: number; step: [number, number] } | null;
  /** the two keyframes to show and the second's share; null: draw directly */
  show: { a: Keyframe; b: Keyframe; mix: number } | null;
  /** why nothing is shown, for measurement */
  reason: string;
}

/** the lowest elevation a map holds: a little under the horizon, where the stack has faded to nothing */
export const CACHE_EL0 = -0.12;

const TAU = Math.PI * 2;
const wrapPi = (a: number): number => a - TAU * Math.floor(a / TAU + 0.5);

/**
 * The extent of a view in azimuth (off azC, unwrapped round it) and
 * elevation: its border's rays, since neither has an extreme inside a
 * frame that does not hold a pole — and the whole circle of azimuth when it
 * does. The same projection as the shader's viewRay
 */
export function viewExtent(camera: Camera, aspect: number, azC: number): { azLo: number; azHi: number; elLo: number; elHi: number; full: boolean } {
  const t = Math.tan(camera.fov / 2);
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  let azLo = Infinity, azHi = -Infinity, elLo = Infinity, elHi = -Infinity;
  const ray = (nx: number, ny: number): void => {
    let x = nx * aspect * t, y = ny * t, z = 1;
    const n = Math.hypot(x, y, z);
    x /= n; y /= n; z /= n;
    const y2 = y * cp + z * sp, z2 = -y * sp + z * cp;
    const wx = x * cy + z2 * sy, wz = -x * sy + z2 * cy;
    const az = wrapPi(Math.atan2(wx, wz) - azC);
    const el = Math.asin(Math.max(-1, Math.min(1, y2)));
    azLo = Math.min(azLo, az); azHi = Math.max(azHi, az);
    elLo = Math.min(elLo, el); elHi = Math.max(elHi, el);
  };
  const S = 16;
  for (let i = 0; i <= S; i++) {
    const u = -1 + (2 * i) / S;
    ray(u, -1); ray(u, 1); ray(-1, u); ray(1, u);
  }
  // a pole inside the frame: its direction projects within the border
  const inside = (py: number): boolean => {
    // the pole (0, py, 0) in view space: un-yaw is nothing for it; un-pitch
    const vy = py * cp, vz = py * sp;
    if (vz <= 0) return false;
    return Math.abs(vy / (vz * t)) <= 1;
  };
  const up = inside(1), down = inside(-1);
  if (up) elHi = Math.PI / 2;
  if (down) elLo = -Math.PI / 2;
  // (unwrapped round azC: a frame straddling azC ± π reads as the whole circle)
  const full = up || down || azHi - azLo > Math.PI;
  if (full) { azLo = -Math.PI; azHi = Math.PI; }
  return { azLo, azHi, elLo, elHi, full };
}

/**
 * The numbers of a state the cloud stack reads, flattened — all of it but
 * the parts only the picture's finish reads (tone, filter, polarizer, lens)
 * and the time of day, which reaches the shader only as the sun and moon.
 * A change in any of them between frames that the keyframes cannot follow
 * is what sends the frame back to the direct draw
 */
export function stackSignature(s: object): number[] {
  const out: number[] = [];
  const SKIP = new Set(['tone', 'filter', 'polarizer', 'lens', 'timeOfDay']);
  const walk = (v: unknown, top: boolean): void => {
    if (typeof v === 'number') out.push(v);
    else if (typeof v === 'boolean') out.push(v ? 1 : 0);
    else if (Array.isArray(v)) for (const x of v) walk(x, false);
    else if (v && typeof v === 'object') {
      for (const k of Object.keys(v).sort()) if (!top || !SKIP.has(k)) walk((v as Record<string, unknown>)[k], false);
    }
  };
  walk(s, true);
  return out;
}

const maxDiff = (a: number[], b: number[]): number => {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

/**
 * How much a state may move in one frame and still be cached: the most any
 * of its numbers may change. A set() transition moves the cloud amounts by
 * a few thousandths a frame, and is drawn directly; a running clock moves the
 * sun by a millionth of a radian. And how far it may drift from what a
 * keyframe was built with before the keyframes are thrown away and rebuilt
 */
const STEP_EPS = 2e-4;
const DRIFT_EPS = 3e-3;

export class SkyCacheScheduler {
  readonly region: 'panorama' | 'view';
  readonly density: number;
  readonly frames: number;
  readonly budget: number;
  readonly margin: number;
  /** texels per radian of the maps in use (0: none yet) */
  texelsPerRad = 0;
  size: [number, number] = [0, 0];
  /** the elevation the panorama's maps reach to (their allocation's top) */
  private top = 0;
  private keys: Keyframe[] = [];
  /** the frame counter on the keyframes' schedule; starts at -2N, so the first two keyframes are built before anything is shown */
  private m = 0;
  private running = false;
  private prevSig: number[] | null = null;
  private prev: Clocks | null = null;
  private prevCam: Camera | null = null;
  // the clocks' and the camera's rates per frame, smoothed
  private rate: Clocks = { time: 0, wind: 0, evo: 0 };
  private camRate = { yaw: 0, pitch: 0 };
  /** texels drawn into keyframes since the last take, for measurement */
  texelsBuilt = 0;

  constructor(o: SkyCacheOptions = {}) {
    this.region = o.region === 'panorama' ? 'panorama' : 'view';
    this.density = o.density ?? 1;
    this.frames = Math.max(2, Math.round(o.frames ?? 15));
    this.budget = o.budget ?? 16e6;
    this.margin = o.margin ?? 0.12;
  }

  /** forget every keyframe (a state that jumped, a view the maps cannot hold) */
  reset(): void {
    this.keys = [];
    this.running = false;
  }

  /** every keyframe slot's memory, in bytes (half-float RGBA, three slots) */
  get bytes(): number {
    return this.size[0] * this.size[1] * 8 * 3;
  }

  frame(f: CacheFrameInput): CacheFramePlan {
    const N = this.frames;
    const { camera } = f;
    const aspect = f.width / Math.max(1, f.height);
    const viewPx = camera.fov / Math.max(1, f.height);
    const none = (reason: string): CacheFramePlan => ({ size: this.size, build: null, show: null, reason });

    // ── the state and the clocks: following on from the last frame? ──
    const step = this.prevSig ? maxDiff(f.sig, this.prevSig) : Infinity;
    this.prevSig = f.sig;
    const p = this.prev;
    this.prev = { ...f.clocks };
    let jumped = !p;
    if (p) {
      const d: Clocks = { time: f.clocks.time - p.time, wind: f.clocks.wind - p.wind, evo: f.clocks.evo - p.evo };
      // a clock that stepped back or leapt (a jump in the time of day, a
      // fresh animator) does not follow on
      if (d.wind < 0 || d.evo < 0 || d.wind > 0.05 || d.evo > 0.05 || Math.abs(d.time) > 1) jumped = true;
      else {
        const k = this.running ? 0.2 : 1;
        this.rate.time += (d.time - this.rate.time) * k;
        this.rate.wind += (d.wind - this.rate.wind) * k;
        this.rate.evo += (d.evo - this.rate.evo) * k;
      }
    }
    const pc = this.prevCam;
    this.prevCam = { ...camera };
    if (pc) {
      const k = this.running ? 0.3 : 1;
      this.camRate.yaw += (wrapPi(camera.yaw - pc.yaw) - this.camRate.yaw) * k;
      this.camRate.pitch += (camera.pitch - pc.pitch - this.camRate.pitch) * k;
    }
    if (jumped || step > STEP_EPS) { this.reset(); return none(jumped ? 'jump' : 'animating'); }

    // ── the maps' size, for the view's density ──
    const want = this.density / viewPx;
    const ext0 = viewExtent(camera, aspect, camera.yaw);
    const topNeed = Math.min(Math.PI / 2, ext0.elHi + 0.3);
    // (a window's width: the view's own and the margin either side, with
    // room to widen into as the view turns — see layout)
    const azNeed = (ext0.full ? TAU : ext0.azHi - ext0.azLo) + 2 * this.margin;
    const narrow = this.region === 'view' && this.size[0] > 0 && azNeed * this.texelsPerRad > this.size[0] - 4
      && this.size[0] < Math.ceil(TAU * this.texelsPerRad) + 2;
    if (!this.texelsPerRad || Math.abs(want / this.texelsPerRad - 1) > 0.2 || ext0.elHi + 0.05 > this.top || narrow) {
      const top = topNeed > Math.PI / 2 - 0.35 ? Math.PI / 2 : topNeed;
      const whole = Math.ceil(TAU * want) + 2;
      const W = this.region === 'view' ? Math.min(whole, Math.ceil(azNeed * 1.4 * want) + 2) : whole;
      const H = Math.ceil((top - CACHE_EL0) * want);
      if (W > f.maxTexture || H > f.maxTexture || W * H > this.budget) {
        this.reset();
        this.texelsPerRad = 0;
        return { size: this.size, build: null, show: null, reason: 'density' };
      }
      this.reset();
      this.texelsPerRad = want;
      this.top = top;
      this.size = [W, H];
    }
    // a key built for a view of another width of pixel, or another state
    if (this.keys.some((k) => Math.abs(k.viewPx / viewPx - 1) > 0.15 || maxDiff(k.sig, f.sig) > DRIFT_EPS)) this.reset();

    const [W, H] = this.size;
    // a panorama's columns close the circle with one to spare either side
    // of its seam; a window's are at the density asked for
    const whole = W >= Math.ceil(TAU * this.texelsPerRad) + 2;
    const dAz = whole ? TAU / (W - 2) : 1 / this.texelsPerRad, dEl = (this.top - CACHE_EL0) / H;

    if (!this.running) { this.running = true; this.m = -2 * N; this.keys = []; }
    const m = this.m++;
    const a = Math.floor(m / N);
    const into = m - a * N;

    // ── build: keyframe a+2, a slice of it ──
    const j = a + 2;
    let key = this.keys.find((k) => k.j === j);
    if (!key) {
      // the slot neither of the two shown holds
      const used = new Set(this.keys.filter((k) => k.j === a || k.j === a + 1).map((k) => k.slot));
      const slot = [0, 1, 2].find((s) => !used.has(s))!;
      this.keys = this.keys.filter((k) => k.slot !== slot);
      const ahead = j * N - m;
      const clocks: Clocks = {
        time: f.clocks.time + this.rate.time * ahead,
        wind: f.clocks.wind + this.rate.wind * ahead,
        evo: f.clocks.evo + this.rate.evo * ahead,
      };
      key = this.layout(j, slot, camera, aspect, ahead, clocks, viewPx, f.sig, W, H, dAz, dEl);
      this.keys.push(key);
    }
    const cols = key.box.c1 - key.box.c0;
    const target = Math.min(cols, Math.ceil(((into + 1) / N) * cols));
    let build: CacheFramePlan['build'] = null;
    if (target > key.built) {
      build = { key, c0: key.box.c0 + key.built, c1: key.box.c0 + target, step: [dAz, dEl] };
      this.texelsBuilt += (target - key.built) * (key.box.r1 - key.box.r0);
      key.built = target;
    }

    // ── show: keyframes a and a+1, if whole and holding the view ──
    const ka = this.keys.find((k) => k.j === a), kb = this.keys.find((k) => k.j === a + 1);
    const plan = (show: CacheFramePlan['show'], reason: string): CacheFramePlan => ({ size: this.size, build, show, reason });
    if (!ka || !kb || ka.built < ka.box.c1 - ka.box.c0 || kb.built < kb.box.c1 - kb.box.c0) return plan(null, 'warm');
    for (const k of [ka, kb]) {
      const e = viewExtent(camera, aspect, k.rect.azC);
      const pad = 2 * dEl;
      if (e.elHi + pad > k.cover.elHi || e.elLo - pad < k.cover.elLo) return plan(null, 'outside');
      if (e.azLo - pad < k.cover.azLo || e.azHi + pad > k.cover.azHi) return plan(null, 'outside');
    }
    return plan({ a: ka, b: kb, mix: into / N }, 'ok');
  }

  /** a keyframe's map and the texels of it to build */
  private layout(
    j: number, slot: number, camera: Camera, aspect: number, ahead: number, clocks: Clocks,
    viewPx: number, sig: number[], W: number, H: number, dAz: number, dEl: number,
  ): Keyframe {
    const N = this.frames;
    const row = (el: number): number => Math.max(0, Math.min(H, Math.floor((el - CACHE_EL0) / dEl)));
    if (this.region === 'panorama') {
      // the whole circle, its middle where the view is and so the seam
      // behind it (the seam is drawn across, so that is only for neatness),
      // every row the maps hold. Under the foot the read clamps, which is
      // the stack's own nothing there: no floor to the cover
      const rect: MapRect = { azC: wrapPi(camera.yaw), el0: CACHE_EL0, azSpan: W * dAz, elSpan: H * dEl };
      return {
        j, slot, rect, box: { c0: 0, c1: W, r0: 0, r1: H },
        cover: { azLo: -Infinity, azHi: Infinity, elLo: -Infinity, elHi: CACHE_EL0 + (H - 1) * dEl },
        clocks, viewPx, sig, built: 0,
      };
    }
    // a window round where the view will be at the middle of the keyframe's
    // showing (frame jN), wide enough to hold it the N frames either side at
    // the rate it turns now
    const cam: Camera = {
      yaw: camera.yaw + this.camRate.yaw * ahead,
      pitch: Math.max(-1.5, Math.min(1.5, camera.pitch + this.camRate.pitch * ahead)),
      fov: camera.fov,
    };
    const e = viewExtent(cam, aspect, cam.yaw);
    const mAz = Math.abs(this.camRate.yaw) * N * 1.25 + this.margin;
    const mEl = Math.abs(this.camRate.pitch) * N * 1.25 + this.margin;
    const azLo = e.full ? -Math.PI : Math.max(-Math.PI, e.azLo - mAz);
    const azHi = e.full ? Math.PI : Math.min(Math.PI, e.azHi + mAz);
    const elLo = Math.max(CACHE_EL0, e.elLo - mEl), elHi = Math.min(CACHE_EL0 + H * dEl, e.elHi + mEl);
    const rect: MapRect = { azC: wrapPi(cam.yaw), el0: CACHE_EL0, azSpan: W * dAz, elSpan: H * dEl };
    const col = (az: number): number => Math.max(0, Math.min(W, Math.floor(W / 2 + az / dAz)));
    const full = azHi - azLo >= TAU - 1e-6 && W * dAz > TAU;
    const box: TexelBox = full ? { c0: 0, c1: W, r0: row(elLo), r1: Math.min(H, row(elHi) + 1) }
      : { c0: col(azLo), c1: Math.min(W, col(azHi) + 1), r0: row(elLo), r1: Math.min(H, row(elHi) + 1) };
    return {
      j, slot, rect, box,
      cover: {
        azLo: full ? -Infinity : (box.c0 - W / 2 + 1) * dAz, azHi: full ? Infinity : (box.c1 - W / 2 - 1) * dAz,
        elLo: box.r0 === 0 ? -Infinity : CACHE_EL0 + (box.r0 + 1) * dEl, elHi: CACHE_EL0 + (box.r1 - 1) * dEl,
      },
      clocks, viewPx, sig, built: 0,
    };
  }
}
