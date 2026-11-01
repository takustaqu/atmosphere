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
// seam), and each frame shows the two that bracket it. The keyframes stand
// at even steps of the clouds' own clock (wind + evolution), N frames' worth
// apart: keyframe j is shown while the clock runs from keyframe j-1's to
// j+1's — rising in as the second of the pair, then going as the first — and
// is built while it runs the step before that, a slice of its columns a
// frame, for the very clocks it will be shown at. So the picture is never
// late, a frame shows the pair either side of its own clock however unevenly
// the frames come, and the cost of a keyframe is spread over its N frames.
//
// A change of weather does not stop this. The keyframes go on being built,
// each for the state it will be shown in, as far as the state's way when its
// build starts tells, and the mix between two of them is the change as it
// goes: a set() costs what any other frame does, and the keyframes' clock runs
// on through it, oftener where the time of day is being wound on and the
// clouds' clocks with it.
//
// With no keyframes to show — the first frames, a state that jumped, a view
// that left them — the frame is drawn from the soft map: one small keyframe,
// its texels a fraction of a keyframe's, drawn whole in one frame, for less
// than a direct draw would have cost, and moved along the drift like any
// other. It hands over to the next keyframe to come whole by the mix between
// them, across the interval up to that keyframe's moment, so the sky sharpens
// and does not jump.
//
// How the renderer gets from the two keyframes to the frame is its own
// (see its cacheFetch): each moved along the clouds' drift and reshaping
// to the frame's moment, then mixed.
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
   * frames' worth of texels; a view that leaves it (a turn that speeds up
   * faster than the window widens) is drawn from the soft map. `'panorama'`:
   * the whole circle of azimuth, from just under the horizon to a little
   * above the view's top (the zenith once it is near) — any turn of the camera
   * free, a keyframe four to eight frames' worth.
   */
  region?: 'panorama' | 'view';
  /** texels per radian, as a multiple of the view's pixels per radian at its middle (height / fov). Defaults to 1 */
  density?: number;
  /**
   * frames between keyframes (N), at most (see windRun). Defaults to 15. A
   * frame is drawn from the two keyframes either side of it, moved to its
   * moment (see motion); what that cannot follow dissolves across the
   * interval — the fewer frames, the less of it, and the more a keyframe's
   * cost weighs on each frame
   */
  frames?: number;
  /** the most texels one keyframe's map may hold; a view that needs more is drawn directly. Defaults to 16 million */
  budget?: number;
  /** radians kept round the view in a `'view'` window, past what its turning asks. Defaults to 0.12 */
  margin?: number;
  /**
   * Move each keyframe's picture to the frame's moment before mixing the
   * two (see the renderer's cacheFetch): along the drift every layer is
   * known to have, and along the reshaping found between the keyframes. A
   * cloud then moves on continuously, rather than sitting still and
   * dissolving into its next place a keyframe later. Needs a second target
   * per slot (WEBGL_draw_buffers): the slots' memory twice over, and a
   * sixteenth more; without it the keyframes are mixed as they stand.
   * Defaults to true
   */
  motion?: boolean;
  /**
   * The most of the clouds' clocks one keyframe interval may span — the
   * animator's integrated wind and evolution: where they run fast for the
   * frame rate (a strong wind, or 30 frames a second rather than 60)
   * keyframes come oftener than every `frames`, down to every 4 frames.
   * What the keyframes' motion cannot follow — a fast layer over a slower
   * one, a reshaping too large to find — dissolves over the interval: at
   * 30 fps and 15 frames a fast scud in a 12 m/s wind crossed some thirty
   * pixels of a 1080p view, and a tower's flank grew by several. Default
   * 0.012 of wind and 0.025 of evolution: fifteen 60 fps frames of a 3 m/s
   * breeze stay fifteen, at 30 fps they are nine
   */
  windRun?: number;
  evoRun?: number;
  /** the soft map's texels per radian, as a share of a keyframe's. Defaults to 0.4: about a sixth of a keyframe's texels */
  soft?: number;
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
  /** its place on the schedule: shown whole at frame j·N, with the clocks steady (the soft map: -1) */
  j: number;
  /** its slot: 0..2, or SOFT_SLOT */
  slot: number;
  /** the slot's texture size */
  size: [number, number];
  /** the clouds' clock (wind + evolution) at its moment */
  clock: number;
  rect: MapRect;
  /** the texels it holds (built, and only these valid) */
  box: TexelBox;
  /** the same, as directions: azimuth off rect.azC, and elevation */
  cover: { azLo: number; azHi: number; elLo: number; elHi: number };
  clocks: Clocks;
  /** the pixel angle of the view it was built for (fov / height) */
  viewPx: number;
  /** how many of its box's columns are built */
  built: number;
  /** how many columns of its morph from the keyframe before it are found (the renderer's bookkeeping, in its morph target's columns) */
  morphed: number;
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

/** a slice of a keyframe to draw, and how far evolution runs for each unit of wind */
export interface CacheBuild {
  key: Keyframe; c0: number; c1: number; step: [number, number]; evoPerWind: number;
  /** this slice finishes the keyframe; and the keyframe before it, if whole: the one it will be shown after */
  done: boolean; prev: Keyframe | null;
}

export interface CacheFramePlan {
  /** the texture size every slot must have this frame (reallocate on change), and the soft map's */
  size: [number, number];
  softSize: [number, number];
  /** the slices to draw into keyframes this frame: one, but for a frame long enough to need the rest of the next keyframe too */
  builds: CacheBuild[];
  /** the two keyframes to show and the second's share (the soft map on its own: it, twice, at 0); null: draw directly */
  show: { a: Keyframe; b: Keyframe; mix: number } | null;
  /** why nothing is shown, for measurement */
  reason: string;
}

/** the soft map's slot: after the three keyframes' */
export const SOFT_SLOT = 3;

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
 * A leap in any of them between frames is what sends the cache back to its
 * soft map
 */
export function stackSignature(s: object): number[] {
  const out: number[] = [];
  // (and the parhelia's plates: the parhelia are not in the stack)
  const SKIP = new Set(['tone', 'filter', 'polarizer', 'lens', 'timeOfDay', 'icePlates']);
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
 * How much of a state may move in one frame and still follow on from the
 * keyframes in hand: the most any of its numbers may change. A set() moves a
 * number by under a hundredth of how far it has to go each 60 fps frame, and
 * the keyframes follow that; a jump() of any size is a new sky
 */
const LEAP_EPS = 0.25;

/**
 * A copy of a state, deep (the animator's is changed in place every frame),
 * gone on by `ahead` times what it moved since `prev`, the state of the frame
 * before. A number wrapping round (an azimuth past 2π) is not moved. The
 * animator's easing slows as it goes, so going on in a straight line for less
 * than its time constant stops short of where it is heading
 */
export function stateAhead<T>(s: T, prev: T, ahead: number): T {
  if (typeof s === 'number') {
    const d = s - (prev as number);
    return (Math.abs(d) < 1 ? s + d * ahead : s) as T;
  }
  if (Array.isArray(s)) return s.map((x, i) => stateAhead(x, (prev as unknown[])[i], ahead)) as T;
  if (s && typeof s === 'object') {
    const o = {} as Record<string, unknown>;
    for (const k of Object.keys(s)) o[k] = stateAhead((s as Record<string, unknown>)[k], (prev as Record<string, unknown>)[k], ahead);
    return o as T;
  }
  return s;
}

export class SkyCacheScheduler {
  readonly region: 'panorama' | 'view';
  readonly density: number;
  readonly frames: number;
  readonly budget: number;
  readonly margin: number;
  readonly windRun: number;
  readonly evoRun: number;
  readonly motion: boolean;
  readonly soft: number;
  /** the targets a slot holds: 1, or 2 with its motion (set by the renderer) */
  layers = 1;
  /** texels per radian of the maps in use (0: none yet) */
  texelsPerRad = 0;
  size: [number, number] = [0, 0];
  softSize: [number, number] = [0, 0];
  /** the elevation the panorama's maps reach to (their allocation's top) */
  private top = 0;
  private keys: Keyframe[] = [];
  /** where the frame stands on the schedule: the pair a, a+1 is shown while the clock runs from marks[0] to marks[1], and a+2 is to stand at marks[2] (see frame()) */
  private a = 0;
  private marks: number[] = [];
  /** the clock's run between keyframes, as of the last keyframe laid out */
  private dC = 0;
  private running = false;
  /** the soft map; whether it is what the frames are drawn from, the keyframe it is handing over to, and the a that was last seen */
  private softKey: Keyframe | null = null;
  private softly = true;
  private handTo: number | null = null;
  private lastA = 0;
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
    this.windRun = o.windRun ?? 0.012;
    this.evoRun = o.evoRun ?? 0.025;
    this.motion = o.motion ?? true;
    this.soft = o.soft ?? 0.4;
  }

  /** forget every keyframe (a state that jumped, a view the maps cannot hold) */
  reset(): void {
    this.keys = [];
    this.running = false;
    this.softKey = null;
    this.softly = true;
    this.handTo = null;
  }

  /** every slot's memory, in bytes (half-float RGBA, three slots, each one target or, with its motion, two and a quarter-size morph, and the soft map's one or two) */
  get bytes(): number {
    const [W, H] = this.size, [w, h] = this.softSize;
    return 8 * this.layers * w * h + 3 * 8 * (W * H * this.layers + (this.layers > 1 ? Math.ceil(W / 4) * Math.ceil(H / 4) : 0));
  }

  frame(f: CacheFrameInput): CacheFramePlan {
    const N = this.frames;
    const { camera } = f;
    const aspect = f.width / Math.max(1, f.height);
    const viewPx = camera.fov / Math.max(1, f.height);
    const none = (reason: string): CacheFramePlan => ({ size: this.size, softSize: this.softSize, builds: [], show: null, reason });

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
        // (smoothed from the second sample on, running or not: the interval is
        // set from these when a schedule starts, and one frame of an uneven
        // run is a third off either way)
        const k = this.rate.wind > 0 || this.rate.evo > 0 ? 0.2 : 1;
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
    if (jumped || step > LEAP_EPS) { this.reset(); return none(jumped ? 'jump' : 'leap'); }

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
        return none('density');
      }
      this.reset();
      this.texelsPerRad = want;
      this.top = top;
      this.size = [W, H];
      this.softSize = [Math.max(8, Math.ceil(W * this.soft)), Math.max(8, Math.ceil(H * this.soft))];
    }
    // a key built for a view of another width of pixel
    if (this.keys.some((k) => Math.abs(k.viewPx / viewPx - 1) > 0.15)) this.reset();

    const [W, H] = this.size;
    // a panorama's columns close the circle with one to spare either side
    // of its seam; a window's are at the density asked for
    const whole = W >= Math.ceil(TAU * this.texelsPerRad) + 2;
    const dAz = whole ? TAU / (W - 2) : 1 / this.texelsPerRad, dEl = (this.top - CACHE_EL0) / H;

    // ── where the frame stands on the schedule ──
    // The schedule runs on the clouds' own clock, wind + evolution (both only
    // ever run forward, and between them every motion of the stack), not on
    // a count of frames: keyframe j stands at a mark on the clock, the last
    // mark and an interval on, the interval N frames' worth of it as things
    // run when the keyframe is laid out. Frames come at uneven times — a 30
    // fps cap on a 60 Hz display draws 17, 33 and 50 ms frames as the
    // timestamps fall — and a schedule by frame count built each keyframe for
    // clocks predicted from the last few frames' rate: a fifth of an interval
    // off, either way, keyframe to keyframe. Shown at their frames regardless,
    // the clouds ran slow through one interval and fast through the next, a
    // lurch at every keyframe. On the clock, each keyframe is built for the
    // very clock it is shown at, the frame shows the pair either side of its
    // own clock, and the mix is how far between them that clock has come. And
    // a clock that speeds up or slows down (a set() winding on the time of
    // day, a wind getting up) has its marks closer or further apart from the
    // next keyframe on, so a keyframe never falls on many fewer frames than
    // windRun and evoRun ask for
    const clock = f.clocks.wind + f.clocks.evo;
    const rClock = this.rate.wind + this.rate.evo;
    if (!(rClock > 0) && !this.running) return none('still');
    // (N frames' worth, or fewer where the clocks would run further than
    // windRun or evoRun between keyframes: see SkyCacheOptions.windRun. Left
    // alone unless it is well out: the rate of an uneven run wavers by a fifth)
    const n = Math.min(N, this.windRun / Math.max(this.rate.wind, 1e-12), this.evoRun / Math.max(this.rate.evo, 1e-12));
    const wantC = rClock * Math.max(Math.min(4, N), n);
    if (!this.running || Math.abs(wantC / this.dC - 1) > 0.25) this.dC = wantC;
    if (!this.running) {
      this.running = true;
      this.keys = [];
      this.a = -2;
      this.marks = [clock, clock + this.dC, clock + 2 * this.dC];
      this.lastA = this.a;
    }
    // in keyframe intervals: the pair a, a+1 is shown while the clock runs from one mark to the next
    while (clock >= this.marks[1] - 1e-9 * this.dC) {
      this.a++;
      this.marks = [this.marks[1], this.marks[2], this.marks[2] + this.dC];
    }
    const a = this.a;
    // a clock that leapt past the keyframe it needed next (a frame longer
    // than an interval) cannot be followed from what was built
    if (a >= 0 && !this.keys.some((k) => k.j === a + 1)) { this.reset(); return none('passed'); }
    const span = this.marks[1] - this.marks[0];
    const at = Math.min(1, Math.max(0, (clock - this.marks[0]) / span));

    // ── build: each keyframe up to a+2 its share by now ──
    // keyframe j is built while the clock runs the interval before last of
    // its moment, a frame's share ahead of the clock, so it is whole by the
    // last frame before it is shown; one that a long frame left short of that
    // is finished now
    const builds: CacheBuild[] = [];
    const evoPerWind = this.rate.wind > 1e-9 ? this.rate.evo / this.rate.wind : 0;
    const clocksAt = (c: number): Clocks => {
      // each at its share of the clock's run to the keyframe's (the shares
      // hold while the state does: both run at rates set by the wind)
      const dc = c - clock, r = Math.max(rClock, 1e-12);
      return {
        time: f.clocks.time + (this.rate.time / r) * dc,
        wind: f.clocks.wind + (this.rate.wind / r) * dc,
        evo: f.clocks.evo + (this.rate.evo / r) * dc,
      };
    };
    for (let j = Math.max(0, a); j <= a + 2; j++) {
      let key = this.keys.find((k) => k.j === j);
      if (!key) {
        // the slot neither of the two shown holds
        const used = new Set(this.keys.filter((k) => k.j === a || k.j === a + 1).map((k) => k.slot));
        const slot = [0, 1, 2].find((x) => !used.has(x))!;
        this.keys = this.keys.filter((k) => k.slot !== slot);
        const c = this.marks[j - a];
        key = this.layout(j, slot, camera, aspect, (c - clock) / Math.max(rClock, 1e-12), c, clocksAt(c), viewPx, [W, H], dAz, dEl);
        this.keys.push(key);
      }
      const cols = key.box.c1 - key.box.c0;
      const share = j === a + 2 ? Math.min(1, at + rClock / span) : 1;
      const target = Math.max(0, Math.min(cols, Math.ceil(share * cols - 1e-6)));
      if (target > key.built) {
        const done = target === cols;
        const prev = this.keys.find((k) => k.j === j - 1 && k.built === k.box.c1 - k.box.c0) ?? null;
        builds.push({ key, c0: key.box.c0 + key.built, c1: key.box.c0 + target, step: [dAz, dEl], evoPerWind, done, prev });
        this.texelsBuilt += (target - key.built) * (key.box.r1 - key.box.r0);
        key.built = target;
      }
    }

    // ── show: keyframes a and a+1, if whole and holding the view ──
    const holds = (k: Keyframe | undefined): k is Keyframe => {
      if (!k || k.built < k.box.c1 - k.box.c0) return false;
      const e = viewExtent(camera, aspect, k.rect.azC);
      const pad = 2 * k.rect.elSpan / k.size[1];
      return e.elHi + pad <= k.cover.elHi && e.elLo - pad >= k.cover.elLo && e.azLo - pad >= k.cover.azLo && e.azHi + pad <= k.cover.azHi;
    };
    const plan = (show: CacheFramePlan['show'], reason: string): CacheFramePlan => ({ size: this.size, softSize: this.softSize, builds, show, reason });
    const ka = this.keys.find((k) => k.j === a), kb = this.keys.find((k) => k.j === a + 1);
    const first = a !== this.lastA;
    this.lastA = a;
    // the soft map's handover over: the keyframe it went to is now the pair's first
    if (this.handTo !== null && a > this.handTo - 1) { this.handTo = null; if (holds(ka) && holds(kb)) this.softly = false; }
    if (!this.softly && holds(ka) && holds(kb)) return plan({ a: ka, b: kb, mix: at }, 'ok');

    // ── or else the soft map, whole in this one frame ──
    this.softly = true;
    if (!holds(this.softKey ?? undefined) || clock - this.softKey!.clock > 4 * this.dC) {
      const [w, h] = this.softSize;
      const sAz = whole ? TAU / (w - 2) : (W * dAz) / w, sEl = (this.top - CACHE_EL0) / h;
      const k = this.layout(-1, SOFT_SLOT, camera, aspect, 0, clock, { ...f.clocks }, viewPx, [w, h], sAz, sEl);
      this.softKey = k;
      this.handTo = null;
      k.built = k.box.c1 - k.box.c0;
      builds.push({ key: k, c0: k.box.c0, c1: k.box.c1, step: [sAz, sEl], evoPerWind, done: true, prev: null });
      this.texelsBuilt += (k.box.c1 - k.box.c0) * (k.box.r1 - k.box.r0);
    }
    const sk = this.softKey!;
    // handing over to the next keyframe whole, across the whole of the interval up to its moment
    if (this.handTo === null && first && holds(kb)) this.handTo = a + 1;
    if (this.handTo === a + 1 && holds(kb)) return plan({ a: sk, b: kb, mix: at }, 'handover');
    this.handTo = null;
    return plan({ a: sk, b: sk, mix: 0 }, 'soft');
  }

  /** a keyframe's map and the texels of it to build */
  private layout(
    j: number, slot: number, camera: Camera, aspect: number, ahead: number, clock: number, clocks: Clocks,
    viewPx: number, size: [number, number], dAz: number, dEl: number,
  ): Keyframe {
    const N = this.frames;
    const [W, H] = size;
    const row = (el: number): number => Math.max(0, Math.min(H, Math.floor((el - CACHE_EL0) / dEl)));
    if (this.region === 'panorama') {
      // the whole circle, its middle where the view is and so the seam
      // behind it (the seam is drawn across, so that is only for neatness),
      // every row the maps hold. Under the foot the read clamps, which is
      // the stack's own nothing there: no floor to the cover
      const rect: MapRect = { azC: wrapPi(camera.yaw), el0: CACHE_EL0, azSpan: W * dAz, elSpan: H * dEl };
      return {
        j, slot, size, clock, rect, box: { c0: 0, c1: W, r0: 0, r1: H },
        cover: { azLo: -Infinity, azHi: Infinity, elLo: -Infinity, elHi: CACHE_EL0 + (H - 1) * dEl },
        clocks, viewPx, built: 0, morphed: 0,
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
      j, slot, size, clock, rect, box,
      cover: {
        azLo: full ? -Infinity : (box.c0 - W / 2 + 1) * dAz, azHi: full ? Infinity : (box.c1 - W / 2 - 1) * dAz,
        elLo: box.r0 === 0 ? -Infinity : CACHE_EL0 + (box.r0 + 1) * dEl, elHi: CACHE_EL0 + (box.r1 - 1) * dEl,
      },
      clocks, viewPx, built: 0, morphed: 0,
    };
  }
}
