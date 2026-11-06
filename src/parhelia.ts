// parhelia.ts — the sun dogs, worked out on the CPU
//
// Where the parhelia stand off the sun, how wide and bright they are, how
// settled the plate crystals that make them are, and which part of the
// canvas a frame can show them in. The fragment shader draws them from these
// numbers (its parhelia()); featureKey reads the plates to decide whether
// to compile them in at all.

import type { AtmosphereState, Camera } from './state.js';

/**
 * Where the parhelia stand, in azimuth off the sun (radians), for a sun at
 * `elevation`: a plate crystal's side faces are a 60° prism, and a ray
 * inclined to the prism's cross-section by the sun's elevation e bends as a
 * level one would through ice of Bravais's index n' = sqrt(n² - sin²e) / cos e.
 * The crystals pile the light up at the minimum deviation, 2 asin(n' / 2) - 60°:
 * 21.8° with the sun on the horizon, 24.6° at 20, 28.7° at 30, 36.3° at 40 and
 * 42.5° at 45, so a parhelion draws away from the 22° ring as the sun climbs.
 */
export function parhelionAzimuth(elevation: number, n = 1.31): number {
  const s = Math.sin(elevation), c = Math.max(Math.cos(elevation), 1e-3);
  return 2 * Math.asin(Math.min(Math.sqrt(n * n - s * s) / c / 2, 1)) - Math.PI / 3;
}

/** ice's index for the red and violet ends of the spectrum */
const ICE_RED = 1.307;
const ICE_VIOLET = 1.317;

/**
 * The parhelia for a sun at `elevation`, as the shader takes them: the red's
 * azimuth off the sun; the width of the spectrum across the sky (radians, red
 * to violet at cos e of their azimuths, with the sun's own half degree and the
 * crystals' wobble smearing it); how bright, 1 with the sun below some 20° and
 * falling away to nothing at the 44° or so past which the crystals' tilt
 * scatters it out; and cos e.
 */
export function parheliaShape(elevation: number): [number, number, number, number] {
  const c = Math.cos(elevation), red = parhelionAzimuth(elevation, ICE_RED);
  const t = Math.min(Math.max((0.70 - Math.sin(elevation)) / 0.35, 0), 1);
  return [red, (parhelionAzimuth(elevation, ICE_VIOLET) - red) * c + 0.010, (2 - t) * t, c];
}

/** a smooth noise of one variable, 0..1, the same everywhere: an integer hash between the cells */
function plateNoise(u: number): number {
  const hash = (i: number): number => {
    let h = Math.imul(i | 0, 0x9e3779b1);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca77);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  };
  const i = Math.floor(u), f = u - i, t = f * f * (3 - 2 * f);
  return hash(i) + (hash(i + 1) - hash(i)) * t;
}

/** how much evolution one cell of the plates' field takes: 24 minutes in a calm, 15 in a wind */
const PLATE_EVO = 100;
/** where the field starts to show parhelia, and where they are at their full */
const PLATE_LO = 0.56;
const PLATE_HI = 0.82;

/**
 * How settled the plate crystals are on each side of the sun, 0..1, [the side
 * of lesser azimuth, of greater]. A parhelion takes plates falling flat, and most
 * ice cloud hasn't many: most icy skies show no parhelion at all, some a faint one and
 * a few a clear pair. So this is a coarse field drifting on the evolution clock,
 * over tens of minutes, nothing in the sky's look to read it from; read at a
 * place set by the hour and the amounts of ice, so skies with different ice
 * differ on the same clock, and the two sides a little apart along it. Exactly
 * 0 over much of its range, where the program that draws the parhelia need not even
 * compile. {@link WeatherState.icePlates} is a floor under it.
 */
export function parheliaPlates(s: AtmosphereState, evo: number): [number, number] {
  const c = s.clouds;
  const u = evo / PLATE_EVO + s.timeOfDay * 0.37 + c.cirrus * 5.3 + c.cirrostratus * 7.1 + c.cirrocumulus * 9.7;
  const field = plateNoise(u) * 0.65 + plateNoise(u * 2.37 + 19.3) * 0.35;
  const side = (k: number): number => {
    const t = Math.min(Math.max((field + (plateNoise(u * 1.9 + k) - 0.5) * 0.16 - PLATE_LO) / (PLATE_HI - PLATE_LO), 0), 1);
    return Math.max(t * t * (3 - 2 * t), Math.min(Math.max(s.icePlates, 0), 1));
  };
  return [side(53), side(90)];
}

/** how bright each parhelion is at this moment, [the side of lesser azimuth, of greater]: the sun's height's and the plates' */
export function parheliaAmounts(s: AtmosphereState, evo: number): [number, number] {
  const bright = parheliaShape(s.sunElevation)[2], [a, b] = parheliaPlates(s, evo);
  return [bright * a, bright * b];
}

/**
 * Where on the canvas a frame can show the parhelia: a scissor rectangle
 * [x, y, width, height] in pixels from its lower left for each parhelion in view,
 * none when neither is. Read off a grid over the patch of sky the shader's
 * parhelia can touch (keep the two windows the same: x in -0.03..0.16 along the
 * parhelic line, 0.045 up and down it), which is small enough for the grid's
 * straight lines to follow it, with a pixel or two over. Its corners may fall
 * behind the eye; what is left of them there is far off the frame's edge.
 * Given the evolution clock, none for a parhelion whose plates aren't settled.
 */
export function parheliaRects(s: AtmosphereState, camera: Camera, width: number, height: number, evo?: number): [number, number, number, number][] {
  const [red, , bright, c] = parheliaShape(s.sunElevation);
  if (bright <= 0) return [];
  const amounts = evo === undefined ? null : parheliaAmounts(s, evo);
  const aspect = width / Math.max(1, height);
  const t = Math.tan(camera.fov * 0.5);
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  const out: [number, number, number, number][] = [];
  for (const side of [-1, 1]) {
    if (amounts && amounts[side < 0 ? 0 : 1] <= 0) continue;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let j = 0; j <= 4; j++) {
      const el = s.sunElevation + (j / 2 - 1) * 0.045;
      const ce = Math.cos(el), wy = Math.sin(el);
      for (let i = 0; i <= 5; i++) {
        const az = s.sunAzimuth + side * (red + (-0.03 + 0.19 * i / 5) / c);
        // the shader's viewRay run backward: world to camera to the frame
        const wx = ce * Math.sin(az), wz = ce * Math.cos(az);
        const dx = wx * cy - wz * sy, dzh = wx * sy + wz * cy;
        const dy = wy * cp - dzh * sp, dz = wy * sp + dzh * cp;
        if (dz <= 0.02) continue;
        const px = (dx / dz / (aspect * t) * 0.5 + 0.5) * width, py = (dy / dz / t * 0.5 + 0.5) * height;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px);
        y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
    }
    const a = Math.max(Math.floor(x0) - 2, 0), b = Math.min(Math.ceil(x1) + 2, width);
    const d = Math.max(Math.floor(y0) - 2, 0), e = Math.min(Math.ceil(y1) + 2, height);
    if (a < b && d < e) out.push([a, d, b - a, e - d]);
  }
  return out;
}
