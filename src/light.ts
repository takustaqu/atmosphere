// light.ts — the sky's light, summarized for whoever draws in front of it
//
// A sky is rarely the whole picture. Something stands in front of it — an
// avatar, a product, a UI card — and it only belongs there if it is lit by the
// same light: rimmed from behind when the sun is ahead of the camera, washed at
// its edges by the colors behind it (light wrap), filled from above by the dome
// and from below by the ground. This module is the hand-off: plain numbers a
// different renderer (three.js, a 2D canvas, CSS) can take and light with.
//
// Two kinds of number, because they come from different places:
//
//   - the lights: the sun and the moon, as directional sources. These are
//     computed here from the same state the shader reads, with the shader's own
//     formulas, so they are exact, free, and follow the camera every frame.
//   - the measurement: what the sky actually looks like — the frame as a coarse
//     grid, and the dome all around as a few averages. These come from drawing
//     the real shader into a tiny offscreen buffer and reading it back (see
//     AtmosphereRenderer.probe), because clouds, haze, filters and the tone
//     curve are not something to re-derive on the CPU.
//
// No DOM dependency: the renderer does the drawing and hands the pixels here.

import { CUBE_FACE_CAMERAS, type AtmosphereState, type Camera } from './state.js';

export type Vec3 = [number, number, number];

/** One color, in the three forms a consumer is likely to want */
export interface LightSample {
  /** display-encoded sRGB, 0..1 — what the pixels are. For CSS and 2D canvas */
  srgb: Vec3;
  /** the same color decoded to linear light, 0..1 — what a lighting equation wants (three.js `Color`) */
  linear: Vec3;
  /** relative luminance (Rec. 709 Y of `linear`), 0..1 */
  luminance: number;
}

/**
 * The frame as a coarse grid of colors — for light wrap: sample it around
 * wherever the foreground stands (see {@link sampleLightGrid}).
 */
export interface LightGrid {
  cols: number;
  rows: number;
  /** row-major, starting at the top-left cell, like the screen */
  cells: LightSample[];
}

/** What is on screen */
export interface FrameLight {
  /** the whole frame, averaged in linear light */
  average: LightSample;
  grid: LightGrid;
}

/**
 * The dome all around the viewer, independent of the framing — for ambient
 * and fill light. Averages are weighted by solid angle, in linear light.
 */
export interface EnvironmentLight {
  /** everything above the horizon — a hemisphere light's sky color */
  sky: LightSample;
  /** everything below it — a hemisphere light's ground color */
  ground: LightSample;
  /** the cap more than 60° up */
  zenith: LightSample;
  /** the band from the horizon to 15° up — the light that grazes a standing figure */
  horizon: LightSample;
  /**
   * The average seen looking each way, in world axes (east = +x, up = +y,
   * north = +z). Six colors are an ambient cube: shade a normal by blending
   * the three it leans toward.
   */
  directions: {
    east: LightSample; west: LightSample;
    up: LightSample; down: LightSample;
    north: LightSample; south: LightSample;
  };
}

/** The measured half of {@link AtmosphereLight} */
export interface LightMeasurement {
  frame: FrameLight;
  /** null when the probe was asked to skip the environment */
  environment: EnvironmentLight | null;
}

/** The sun or the moon as a directional light */
export interface CelestialLight {
  /** unit vector toward the body, in world axes (x east, y up, z north) */
  direction: Vec3;
  /** radians above the horizon */
  elevation: number;
  /** radians, north = 0, east = π/2 */
  azimuth: number;
  /**
   * The same direction in the camera's frame: x right, y up, z into the
   * screen. `view[2] > 0` means the body is ahead of the camera — behind
   * anything standing in the frame — which is exactly when that thing is
   * backlit. `(view[0], view[1])` is which way on screen its rim should face.
   */
  view: Vec3;
  /**
   * Where it lands on screen, 0..1 with the origin at the top-left (the CSS
   * convention). Can fall outside 0..1 when it is out of frame; meaningless
   * when `inFront` is false.
   */
  screen: { x: number; y: number; inFront: boolean };
  /** linear RGB, scaled so the brightest channel is 1 */
  color: Vec3;
  /** 0..1 how much of it gets through: 0 below the horizon or behind a full deck */
  visibility: number;
  /**
   * `visibility` in the renderer's own emission scale, where a clear-sky sun
   * is 1. The moon tops out far lower (see {@link MOON_RELATIVE}).
   */
  intensity: number;
}

/**
 * Everything a foreground renderer needs to sit in this sky.
 *
 * `frame` and `environment` are null until a probe has run (or when it is
 * off); the lights are always there.
 */
export interface AtmosphereLight {
  sun: CelestialLight;
  moon: CelestialLight;
  /** whichever of the two is lighting the scene more, or null when neither is */
  key: 'sun' | 'moon' | null;
  frame: FrameLight | null;
  environment: EnvironmentLight | null;
}

/**
 * The moon's light relative to a clear sun.
 *
 * The real ratio is about 1:400,000, which as a light would be nothing at all.
 * This is the renderer's own ratio instead — the same stylization that lets its
 * moonlight silver the clouds — so a rim light driven by it reads at night the
 * way the sky itself does.
 */
export const MOON_RELATIVE = 0.15;

// ── The shader's own formulas, mirrored ──────────────────
// Each of these is a line of FRAG in renderer.ts; keep them in step.

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** GLSL smoothstep, including the reversed-edge form the shader leans on */
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const encode = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const luminance = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function dirFromAngles(elevation: number, azimuth: number): Vec3 {
  const ce = Math.cos(elevation);
  return [ce * Math.sin(azimuth), Math.sin(elevation), ce * Math.cos(azimuth)];
}

function normalizedColor(display: Vec3): Vec3 {
  const lin: Vec3 = [decode(display[0]), decode(display[1]), decode(display[2])];
  const m = Math.max(lin[0], lin[1], lin[2], 1e-6);
  return [lin[0] / m, lin[1] / m, lin[2] / m];
}

/** world direction → camera frame (projectDir's rotation) */
function toView(d: Vec3, cam: Camera): Vec3 {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const x = d[0] * cy - d[2] * sy, z0 = d[0] * sy + d[2] * cy;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  return [x, d[1] * cp - z0 * sp, d[1] * sp + z0 * cp];
}

function celestial(
  elevation: number, azimuth: number, cam: Camera, aspect: number,
  color: Vec3, visibility: number, scale: number,
): CelestialLight {
  const direction = dirFromAngles(elevation, azimuth);
  const view = toView(direction, cam);
  const t = Math.tan(cam.fov / 2);
  const z = Math.max(view[2], 1e-4);
  return {
    direction,
    elevation,
    azimuth,
    view,
    screen: {
      x: view[0] / (z * t * aspect) * 0.5 + 0.5,
      y: 0.5 - view[1] / (z * t) * 0.5,
      inFront: view[2] > 0,
    },
    color,
    visibility,
    intensity: visibility * scale,
  };
}

/**
 * The sun and the moon as directional lights, for this state seen through
 * this camera.
 *
 * Pure and cheap — call it every frame. `aspect` is the frame's width over
 * height, which only the on-screen position depends on.
 *
 * Visibility is the shader's: it follows the sun below the horizon and the
 * cloud cover, but it is one number for the whole sky, so a single cloud
 * drifting across the disc does not dim it. That is what the frame
 * measurement is for.
 */
export function celestialLights(
  s: AtmosphereState, camera: Camera, aspect: number,
): Pick<AtmosphereLight, 'sun' | 'moon' | 'key'> {
  const sunY = Math.sin(s.sunElevation);
  const dayF = smoothstep(-0.12, 0.25, sunY);
  const nightF = 1 - dayF;
  const sunsetF = smoothstep(0.35, 0.02, Math.abs(sunY));
  const gloom = clamp01(Math.max(s.rain, Math.max(s.snow * 0.5, s.wind * 0.7)));

  const sunVis = smoothstep(-0.06, 0.06, sunY) * clamp01(1 - s.cloudCover * 0.75 - gloom * 0.95);
  const sunDisplay: Vec3 = [
    1.0 + (1.05 - 1.0) * sunsetF,
    0.98 + (0.6 - 0.98) * sunsetF,
    0.92 + (0.3 - 0.92) * sunsetF,
  ];
  const sun = celestial(s.sunElevation, s.sunAzimuth, camera, aspect,
    normalizedColor(sunDisplay), sunVis, 1);

  // the moon sits opposite the sun at a fixed height (the full-moon relationship)
  const moonVis = nightF * clamp01(1 - s.cloudCover * 0.9 - gloom);
  const moon = celestial(0.62, s.sunAzimuth + Math.PI, camera, aspect,
    normalizedColor([1.0, 0.96, 0.88]), moonVis, MOON_RELATIVE);

  const key = sun.intensity <= 0 && moon.intensity <= 0 ? null
    : sun.intensity >= moon.intensity ? 'sun' : 'moon';
  return { sun, moon, key };
}

// ── The probe's pixels → the measurement ─────────────────

/** Samples per grid cell, each way. Point samples, so a few per cell tame the aliasing */
export const PROBE_SUB = 4;
/** Environment face size in pixels. Six of these sit in a row above the frame */
export const PROBE_FACE = 16;

/** Where everything sits in the probe's framebuffer. Rows run bottom-up, as GL reads them */
export interface ProbeLayout {
  cols: number;
  rows: number;
  environment: boolean;
  width: number;
  height: number;
  /** height of the frame region at the bottom; the faces sit on top of it */
  frameHeight: number;
}

export function probeLayout(cols: number, rows: number, environment: boolean): ProbeLayout {
  cols = Math.max(1, Math.round(cols));
  rows = Math.max(1, Math.round(rows));
  const fw = cols * PROBE_SUB, fh = rows * PROBE_SUB;
  return {
    cols, rows, environment,
    width: environment ? Math.max(fw, PROBE_FACE * 6) : fw,
    height: environment ? fh + PROBE_FACE : fh,
    frameHeight: fh,
  };
}

const DECODE_LUT = Array.from({ length: 256 }, (_, i) => decode(i / 255));

export function sampleFromLinear(lin: Vec3): LightSample {
  const l: Vec3 = [Math.max(0, lin[0]), Math.max(0, lin[1]), Math.max(0, lin[2])];
  return { srgb: [encode(l[0]), encode(l[1]), encode(l[2])], linear: l, luminance: luminance(l) };
}

interface EnvTexel { weight: number; elevation: number }
let envTable: EnvTexel[][] | null = null;

/**
 * Direction and solid angle of every environment texel, per face.
 *
 * The same ray the shader casts (viewRay at fov 90°, aspect 1), so the bins
 * below split the dome where the drawn sky actually splits.
 */
function environmentTable(): EnvTexel[][] {
  if (envTable) return envTable;
  const N = PROBE_FACE;
  envTable = CUBE_FACE_CAMERAS.map((cam) => {
    const out: EnvTexel[] = [];
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const nx = ((x + 0.5) / N) * 2 - 1, ny = ((y + 0.5) / N) * 2 - 1;
        const len = Math.hypot(nx, ny, 1);
        // only the height matters for the bins, and yaw does not change it
        const dy = (ny * cp + sp) / len;
        out.push({
          // a cube texel's solid angle falls off as it leaves the face's centre
          weight: Math.pow(1 + nx * nx + ny * ny, -1.5),
          elevation: Math.asin(Math.max(-1, Math.min(1, dy))),
        });
      }
    }
    return out;
  });
  return envTable;
}

class Acc {
  r = 0; g = 0; b = 0; w = 0;
  add(r: number, g: number, b: number, w: number) { this.r += r * w; this.g += g * w; this.b += b * w; this.w += w; }
  sample(): LightSample {
    const w = this.w || 1;
    return sampleFromLinear([this.r / w, this.g / w, this.b / w]);
  }
}

/**
 * Turn the probe's readback into a {@link LightMeasurement}.
 *
 * `pixels` is RGBA8 as `readPixels` returns it — bottom row first — laid out
 * as `layout` describes, and display-encoded sRGB. Everything is averaged in
 * linear light: averaging encoded values darkens every mix, the same mistake
 * the compositor stopped making in 0.2.0.
 */
export function summarizeProbe(pixels: Uint8Array, layout: ProbeLayout): LightMeasurement {
  const { cols, rows, width } = layout;
  const at = (x: number, y: number) => (y * width + x) * 4;

  const cells: LightSample[] = [];
  const all = new Acc();
  for (let r = 0; r < rows; r++) {
    // grid rows run top-down; the framebuffer's run bottom-up
    const y0 = (rows - 1 - r) * PROBE_SUB;
    for (let c = 0; c < cols; c++) {
      const cell = new Acc();
      for (let y = y0; y < y0 + PROBE_SUB; y++) {
        for (let x = c * PROBE_SUB; x < (c + 1) * PROBE_SUB; x++) {
          const i = at(x, y);
          cell.add(DECODE_LUT[pixels[i]], DECODE_LUT[pixels[i + 1]], DECODE_LUT[pixels[i + 2]], 1);
        }
      }
      all.add(cell.r / cell.w, cell.g / cell.w, cell.b / cell.w, 1);
      cells.push(cell.sample());
    }
  }
  const frame: FrameLight = { average: all.sample(), grid: { cols, rows, cells } };
  if (!layout.environment) return { frame, environment: null };

  const table = environmentTable();
  const faces = table.map(() => new Acc());
  const sky = new Acc(), ground = new Acc(), zenith = new Acc(), horizon = new Acc();
  const ZENITH = Math.PI / 3, HORIZON = Math.PI / 12;
  const N = PROBE_FACE;
  table.forEach((texels, f) => {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const t = texels[y * N + x];
        const i = at(f * N + x, layout.frameHeight + y);
        const r = DECODE_LUT[pixels[i]], g = DECODE_LUT[pixels[i + 1]], b = DECODE_LUT[pixels[i + 2]];
        faces[f].add(r, g, b, t.weight);
        if (t.elevation > 0) {
          sky.add(r, g, b, t.weight);
          if (t.elevation > ZENITH) zenith.add(r, g, b, t.weight);
          if (t.elevation < HORIZON) horizon.add(r, g, b, t.weight);
        } else {
          ground.add(r, g, b, t.weight);
        }
      }
    }
  });
  // CUBE_FACE_CAMERAS order: +X east, -X west, +Y up, -Y down, +Z north, -Z south
  const [east, west, up, down, north, south] = faces.map((a) => a.sample());
  return {
    frame,
    environment: {
      sky: sky.sample(), ground: ground.sample(),
      zenith: zenith.sample(), horizon: horizon.sample(),
      directions: { east, west, up, down, north, south },
    },
  };
}

// ── Smoothing ─────────────────────────────────────────────

function mixSample(a: LightSample, b: LightSample, k: number): LightSample {
  return sampleFromLinear([
    a.linear[0] + (b.linear[0] - a.linear[0]) * k,
    a.linear[1] + (b.linear[1] - a.linear[1]) * k,
    a.linear[2] + (b.linear[2] - a.linear[2]) * k,
  ]);
}

/**
 * Ease one measurement toward the next — `k` = 0 keeps `from`, 1 takes `to`.
 *
 * The probe point-samples a moving sky at a few dozen pixels, so a raw series
 * shimmers as cloud edges cross the samples; a light that shimmers is worse
 * than one a fraction of a second late. Blended in linear light. When the two
 * disagree in shape (the grid was resized, the environment switched on) `to`
 * is taken whole.
 */
export function mixMeasurement(from: LightMeasurement, to: LightMeasurement, k: number): LightMeasurement {
  const fg = from.frame.grid, tg = to.frame.grid;
  if (fg.cols !== tg.cols || fg.rows !== tg.rows || !from.environment !== !to.environment) return to;
  const frame: FrameLight = {
    average: mixSample(from.frame.average, to.frame.average, k),
    grid: { cols: tg.cols, rows: tg.rows, cells: tg.cells.map((c, i) => mixSample(fg.cells[i], c, k)) },
  };
  const fe = from.environment, te = to.environment;
  if (!fe || !te) return { frame, environment: null };
  const d = (key: keyof EnvironmentLight['directions']) => mixSample(fe.directions[key], te.directions[key], k);
  return {
    frame,
    environment: {
      sky: mixSample(fe.sky, te.sky, k),
      ground: mixSample(fe.ground, te.ground, k),
      zenith: mixSample(fe.zenith, te.zenith, k),
      horizon: mixSample(fe.horizon, te.horizon, k),
      directions: {
        east: d('east'), west: d('west'), up: d('up'), down: d('down'), north: d('north'), south: d('south'),
      },
    },
  };
}

/**
 * The frame's color at a point, bilinear across the grid — what is behind the
 * foreground there, for light wrap.
 *
 * `x`, `y` are 0..1 with the origin at the top-left (the same convention as
 * {@link CelestialLight.screen}); outside that range the edge cells hold.
 */
export function sampleLightGrid(grid: LightGrid, x: number, y: number): LightSample {
  const gx = clamp01(x) * grid.cols - 0.5, gy = clamp01(y) * grid.rows - 0.5;
  const c0 = Math.max(0, Math.min(grid.cols - 1, Math.floor(gx)));
  const r0 = Math.max(0, Math.min(grid.rows - 1, Math.floor(gy)));
  const c1 = Math.min(grid.cols - 1, c0 + 1), r1 = Math.min(grid.rows - 1, r0 + 1);
  const fx = clamp01(gx - c0), fy = clamp01(gy - r0);
  const cell = (c: number, r: number) => grid.cells[r * grid.cols + c];
  return mixSample(mixSample(cell(c0, r0), cell(c1, r0), fx), mixSample(cell(c0, r1), cell(c1, r1), fx), fy);
}

/**
 * The ambient light reaching a surface that faces `normal` (world axes, need
 * not be unit length) — the six directions evaluated as an ambient cube.
 *
 * A figure standing in the frame faces the camera, so its front is lit by
 * whatever is *behind* the camera: pass the camera's backward direction and
 * that is the fill light the frame itself never shows.
 */
export function sampleEnvironment(env: EnvironmentLight, normal: Vec3): LightSample {
  const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const x = normal[0] / len, y = normal[1] / len, z = normal[2] / len;
  const d = env.directions;
  const sx = x >= 0 ? d.east : d.west;
  const sy = y >= 0 ? d.up : d.down;
  const sz = z >= 0 ? d.north : d.south;
  const w = [x * x, y * y, z * z];
  return sampleFromLinear([0, 1, 2].map((c) =>
    sx.linear[c] * w[0] + sy.linear[c] * w[1] + sz.linear[c] * w[2]) as Vec3);
}

/** The direction a camera faces, in world axes — negate it for what a figure in the frame faces */
export function cameraForward(cam: Camera): Vec3 {
  const cp = Math.cos(cam.pitch);
  return [cp * Math.sin(cam.yaw), Math.sin(cam.pitch), cp * Math.cos(cam.yaw)];
}
