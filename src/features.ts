// features.ts — which shader variant draws a state
//
// The fragment shader is compiled per combination of the optional blocks a
// frame actually draws. This is the key of that combination: one bit per
// feature, read off the state with the same thresholds the shader's own
// gates use, and the bits for how a frame is drawn (split, sky cache) that
// ride alongside them.

import { parheliaPlates } from './parhelia.js';
import type { RendererOptions } from './renderer.js';
import type { AtmosphereState, Camera } from './state.js';
import { sunShape } from './sundisc.js';

/**
 * The optional parts of the shader, as bits of a key. Each is a block that
 * only runs when its state is on — the sea, the aurora, the halos — and yet
 * costs every frame by being compiled in: a branch never taken still holds
 * registers, and a bigger program runs fewer pixels at once. Measured against
 * 0.3.2 with everything compiled in, a clear noon paid 10–30% for features it
 * was not drawing. So the renderer compiles a variant per combination a
 * frame actually needs, on demand, and draws with the last one while the
 * next links.
 */
export const FEATURE = {
  SEA: 1,
  AURORA: 2,
  CONTRAILS: 4,
  RAYS: 8,
  HALOS: 16,
  RAINBOW: 32,
  BOLT: 64,
  /** a dark site: the deeper star grids, the Milky Way, airglow, zodiacal light */
  DARKSKY: 128,
  POLARIZER: 256,
  /** rain shafts hanging under a raining tower or deck */
  SHAFTS: 512,
  /**
   * the cumulonimbus: its towers, anvil and veil, the rain its towers drop,
   * and the small clouds' shading in front of it. The largest block in the
   * shader by far: carried by a sky without a tower, it made a fair or an
   * overcast sky's frame some two fifths longer (an M2 Max, 1080p)
   */
  CB: 1024,
  /**
   * light from behind: the cumulus's and the cumulonimbus's backlit and
   * side-lit shading, and the glow round a backlit tower's rim — only with a
   * sun that is up and not taken by an overcast, and a cloud for it to light
   */
  BACKLIT: 2048,
  /** iridescence: a thin water cloud colored near a sun that is up */
  IRIDESCENCE: 4096,
  /** a thin cloud lit through by the moon, colored by its corona */
  MOONLIT: 8192,
  /**
   * the cumulonimbus's towers ray-marched through a 3D density field instead
   * of drawn as a 2D field — {@link RendererOptions.cumulonimbus}. Not an
   * optional block like the others but a different tower: set by the option
   * (under `'auto'`, by how near the storm stands), and only alongside CB (a
   * sky without a tower shares the 2D variant)
   */
  CBVOL: 16384,
  /**
   * the parhelia: any thin ice cloud (cirrus, veil, cirrocumulus) under a sun
   * below some 45°, with its plates settled (see {@link parheliaPlates}). Apart from the veil's halo, which it would drag into every
   * sky with a wisp of cirrus
   */
  PARHELIA: 32768,
  /**
   * falling snow: its flakes and the whitening of the view behind them. A
   * large block for what it draws, and carried by a sky with no snow in it,
   * it made a fair sky's frame an eighth longer (an M2 Max, 1080p). (The bits
   * between are not features of the sky but of how a frame is drawn: see
   * {@link SPLIT_KEY} and {@link CACHE_BITS}.)
   */
  SNOW: 524288,
  /** falling rain: its streaks, and the greying of the view behind them */
  RAIN: 1048576,
} as const;

export const FEATURE_DEFINES: [number, string][] = [
  [FEATURE.SEA, 'FEAT_SEA'],
  [FEATURE.AURORA, 'FEAT_AURORA'],
  [FEATURE.CONTRAILS, 'FEAT_CONTRAILS'],
  [FEATURE.RAYS, 'FEAT_RAYS'],
  [FEATURE.HALOS, 'FEAT_HALOS'],
  [FEATURE.RAINBOW, 'FEAT_RAINBOW'],
  [FEATURE.BOLT, 'FEAT_BOLT'],
  [FEATURE.DARKSKY, 'FEAT_DARKSKY'],
  [FEATURE.POLARIZER, 'FEAT_POLARIZER'],
  [FEATURE.SHAFTS, 'FEAT_SHAFTS'],
  [FEATURE.CB, 'FEAT_CB'],
  [FEATURE.BACKLIT, 'FEAT_BACKLIT'],
  [FEATURE.IRIDESCENCE, 'FEAT_IRIDESCENCE'],
  [FEATURE.MOONLIT, 'FEAT_MOONLIT'],
  [FEATURE.CBVOL, 'FEAT_CBVOL'],
  [FEATURE.PARHELIA, 'FEAT_PARHELIA'],
  [FEATURE.SNOW, 'FEAT_SNOW'],
  [FEATURE.RAIN, 'FEAT_RAIN'],
];

/**
 * every feature compiled in: the one program the renderer used to be. (Its
 * CBVOL bit swaps the 2D tower for the volumetric one rather than adding
 * anything, so a renderer compiling everything into one program takes that
 * bit from its own cumulonimbus option, not from here)
 */
export const ALL_FEATURES = 65535 | 524288 | 1048576;

/** how the cumulonimbus's towers are drawn — see {@link RendererOptions.cumulonimbus} */
export type CumulonimbusMode = 'auto' | '2d' | 'volumetric';

/** an option's mode, anything not named falling back to the default */
export function cbModeOf(v: unknown): CumulonimbusMode {
  return v === '2d' || v === 'volumetric' ? v : 'auto';
}

/**
 * Under `'auto'`, the storm distances (features.distance) the towers pass
 * from the 2D tower to the volumetric one across. A storm close by stands
 * over the eye with its base looming overhead, and there the march's coarse
 * lobes, a few hundred pixels across, come out as broad smooth slabs laid
 * over one another where the 2D tower's painted cauliflower holds up — still
 * at 0.4, where the base hangs over the top of a level view; by 0.5 the
 * storm has drawn back to the horizon and the volumetric tower is the better
 * one again, as from the middle distance every sky with a tower is set at
 * unless it says otherwise (0.65), and as close up through a narrow view,
 * which stands as large on the screen but not over the eye. The band leaves
 * an eighth of the range between it and the middle distance, and is narrow:
 * inside it both towers are drawn and crossfaded, and each frame costs what
 * the two cost together.
 */
export const CB_AUTO_BAND: readonly [number, number] = [0.42, 0.52];

/**
 * How much of the volumetric tower a storm at `distance` takes under
 * `'auto'`: 0 near, 1 from the middle distance in, smooth across
 * {@link CB_AUTO_BAND} (and exactly 0 or 1 outside it, so a frame outside the
 * band draws the one tower alone)
 */
export function cbVolumetricShare(distance: number): number {
  const [lo, hi] = CB_AUTO_BAND;
  const t = Math.min(Math.max((distance - lo) / (hi - lo), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * Which features a state needs drawn — the key of the shader variant that
 * draws it. Each test is the same threshold the shader's own gate uses, so a
 * feature is compiled in exactly when it would be drawn.
 */
export function featureKey(s: AtmosphereState, rays = 0, cumulonimbus: CumulonimbusMode = 'auto', evo?: number): number {
  let k = 0;
  if (s.ground.sea > 0.001) k |= FEATURE.SEA;
  if (s.celestial.aurora > 0.001) k |= FEATURE.AURORA;
  if (s.particles.contrails > 0.001) k |= FEATURE.CONTRAILS;
  if (rays > 0) k |= FEATURE.RAYS;
  if (s.clouds.cirrostratus > 0.001) k |= FEATURE.HALOS;
  // the parhelia's gate: ice, and a sun both up and below their 45° (their low, and
  // sunVis). The sine a hair past each, as for the lighting below. Given the
  // evolution clock, plates settled on one side or the other as well; without
  // it, whether this sky can ever have them
  const c0 = s.clouds, sinSun = Math.sin(s.sunElevation);
  if ((c0.cirrus > 0.001 || c0.cirrostratus > 0.001 || c0.cirrocumulus > 0.001)
      && sinSun > -0.0601 && sinSun < 0.7001
      && (evo === undefined || Math.max(...parheliaPlates(s, evo)) > 0)) {
    k |= FEATURE.PARHELIA;
  }
  if (s.snow > 0.001) k |= FEATURE.SNOW;
  if (s.rain > 0.001) k |= FEATURE.RAIN;
  if (s.rain > 0.01) k |= FEATURE.RAINBOW;
  if (s.thunder > 0.001) k |= FEATURE.BOLT;
  // an eased bortle only approaches 6 on its way back from a dark site, so
  // `< 6` would keep the dark-sky variant (and its cost) for good after one
  if (s.celestial.bortle < 5.95 || s.celestial.milkyWay > 0.001) k |= FEATURE.DARKSKY;
  if (s.polarizer.strength > 0.001) k |= FEATURE.POLARIZER;
  // a thunderstorm's tower rains whether or not it is raining here
  if (s.rain > 0.01 || (s.clouds.cumulonimbus > 0.05 && s.thunder > 0.001)) k |= FEATURE.SHAFTS;
  // the tower's own gate is this amount, less the gloom's share of it
  const c = s.clouds;
  if (c.cumulonimbus > 0.001) k |= FEATURE.CB;
  // (the volumetric tower only while there is a tower to march: a sky
  // without one shares the 2D variant rather than compiling a second program
  // that draws the same)
  // Under 'auto' this is the tower that takes the larger share: inside the
  // band the frame is drawn with both (featureKeys)
  const vol = cumulonimbus === 'volumetric'
    || (cumulonimbus === 'auto' && cbVolumetricShare(s.features.distance) >= 0.5);
  if (vol && (k & FEATURE.CB)) k |= FEATURE.CBVOL;
  // The three below are all lighting the clouds take from a sun or a moon
  // that may not be there. Each gate is the shader's own, where its light
  // falls to exactly nothing; the elevations are compared a hair early, so
  // float rounding on the GPU can only ever find the feature compiled in
  // and its light at nothing, never the other way round.
  const sunY = Math.sin(s.sunElevation);
  // the cumulus's gate, and a tower's
  if (sunY > -0.0501 && s.cloudCover < 0.95 && (c.cumulus > 0.02 || c.cumulonimbus > 0.001)) {
    k |= FEATURE.BACKLIT;
  }
  // the layers lit through cloudColor: water ones, and the cirrocumulus's ice
  const water = c.altocumulus > 0.001 || c.stratocumulus > 0.001 || c.cumulus > 0.02 || c.stratus > 0.001;
  if (sunY > -0.0201 && water) k |= FEATURE.IRIDESCENCE;
  const eclipse = Math.min(Math.max(s.moonEclipse ?? 0, 0), 1);
  if ((water || c.cirrocumulus > 0.001) && Math.sin(s.moonElevation) > -0.0301
      && sunY < 0.1401 && s.moonPhase * (1 - 0.9 * eclipse) > 0) {
    k |= FEATURE.MOONLIT;
  }
  return k;
}

/**
 * Every variant a state is drawn with, and how much of the frame each one
 * gives: one, at 1 — or under `'auto'`, for a tower inside
 * {@link CB_AUTO_BAND}, the 2D tower's variant and then the volumetric one's,
 * drawn over it at its share. The same picture but for the tower, so the
 * crossfade is the tower's alone.
 */
export function featureKeys(s: AtmosphereState, rays = 0, cumulonimbus: CumulonimbusMode = 'auto', evo?: number): { key: number; share: number }[] {
  const k = featureKey(s, rays, cumulonimbus, evo);
  if (cumulonimbus !== 'auto' || !(k & FEATURE.CB)) return [{ key: k, share: 1 }];
  const v = cbVolumetricShare(s.features.distance);
  if (v <= 0 || v >= 1) return [{ key: k, share: 1 }];
  return [{ key: k & ~FEATURE.CBVOL, share: 1 }, { key: k | FEATURE.CBVOL, share: v }];
}

/**
 * Whether any ray of a view can be lit from behind — whether FEATURE.BACKLIT
 * can draw anything in it. The light from behind is the one feature whose
 * gate is a direction: a cloud takes it only within a few tenths of a radian
 * of the sun as sunApart measures it (the tower's backT out to 0.60–1.65,
 * by how low the sun is, its aura and its plate's to no further; a cumulus's
 * to 1.0–1.3, CU_BACK to CU_BACK_DAY by how high the sun is, its angle squashed differently), and the frame is a window a
 * radian or so across. Turned away from the sun every one of those terms is
 * exactly nothing for every pixel, and the program carrying them was some
 * tenth slower for it (an M2 Max, 1080p: a sky of towers seen with the sun
 * behind or beside the eye, or a tower close up). So keysFor leaves the
 * feature out of such a frame — the same picture, pixel for pixel.
 *
 * Read off a grid of the view's rays, conservatively: the least angle any
 * ray takes, less the most any cell of the grid spans (a ray between grid
 * points lies within a cell's diagonal of one), each in the squashed sky
 * sunApart reasons in. A lens with drops on it bends rays by up to half the
 * frame, so the window is widened by that much then.
 */
export function backlitInView(s: AtmosphereState, camera: Camera, aspect: number): boolean {
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
  };
  const sun = sunDirection(s);
  const sunY = sun[1];
  const lowS = 1 - smooth(0.20, 0.55, sunY);
  const lift = smooth(0.15, 0.60, sunY);
  // [the tower's squash, its reach] and the cumulus's
  const gates: [number, number][] = [[0.35 + 0.65 * lift, 0.60 + 1.05 * lowS], [0.5 + 0.5 * lift, 1.0 + 0.3 * smooth(0.30, 0.50, sunY)]];
  const rays = viewRays(s, camera, aspect);
  return gates.some(([q, reach]) => leastAngle(rays, sun, q) < reach + 0.02);
}

/**
 * Whether any ray of a view passes near enough the sun for a thin cloud to be
 * colored by it — whether FEATURE.IRIDESCENCE can draw anything in it. Its
 * light is the sun's carried on forward, and the shader cuts that off 0.30 rad
 * out from the limb (g_sunFwd): past it every term is exactly nothing, and the
 * program carrying them was 7 to 10% slower for it on a fair, a summer, an
 * overcast or a snowy sky, 2 to 3% on a rainy one (an M2 Max, 1080p, looking
 * away from the sun, the light from behind already left out). So keysFor
 * leaves the feature out of such a frame, as it does that light (see
 * {@link backlitInView}, and for how the grid is read) — the same picture,
 * pixel for pixel.
 */
export function iridescenceInView(s: AtmosphereState, camera: Camera, aspect: number): boolean {
  const limb = sunShape(s.sun.disc)[2];
  const rays = viewRays(s, camera, aspect), sun = sunDirection(s);
  // (the sky as it is, unsquashed: the nearest ray is the one with the greatest cosine)
  let near = -1;
  for (const r of rays) near = Math.max(near, r[0] * sun[0] + r[1] * sun[1] + r[2] * sun[2]);
  return Math.acos(Math.min(near, 1)) - gridCell(rays) < 0.30 + limb + 0.02;
}

type Vec3 = [number, number, number];

/** where the sun stands, as the shader's sunDir */
function sunDirection(s: AtmosphereState): Vec3 {
  const ce = Math.cos(s.sunElevation);
  return [ce * Math.sin(s.sunAzimuth), Math.sin(s.sunElevation), ce * Math.cos(s.sunAzimuth)];
}

const NX = 24, NY = 16;

// the last view's grid: a view is asked about every frame, by each gate, and seldom turns
let lastGrid: { yaw: number; pitch: number; fov: number; aspect: number; span: number; rays: Vec3[]; cell: number } | null = null;

/** the view's rays on a grid, as the shader's viewRay casts them: over a frame wider by what drops on the lens can bend them */
function viewRays(s: AtmosphereState, camera: Camera, aspect: number): Vec3[] {
  const drops = s.rain > 0.05 && s.lens.droplets > 0.001;
  const span = drops ? 1.6 : 1;
  const g = lastGrid;
  if (g && g.yaw === camera.yaw && g.pitch === camera.pitch && g.fov === camera.fov && g.aspect === aspect && g.span === span) return g.rays;
  const t = Math.tan(camera.fov * 0.5);
  const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
  const rays: Vec3[] = [];
  for (let j = 0; j <= NY; j++) {
    for (let i = 0; i <= NX; i++) {
      const x = (i / NX * 2 - 1) * span * aspect * t, y = (j / NY * 2 - 1) * span * t;
      const l = Math.hypot(x, y, 1);
      const dx = x / l, dy0 = y / l, dz0 = 1 / l;
      const dy = dy0 * cp + dz0 * sp, dz = -dy0 * sp + dz0 * cp;
      rays.push([dx * cy + dz * sy, dy, -dx * sy + dz * cy]);
    }
  }
  lastGrid = { yaw: camera.yaw, pitch: camera.pitch, fov: camera.fov, aspect, span, rays, cell: -1 };
  return rays;
}

const angle = (a: Vec3, b: Vec3) => Math.acos(Math.min(Math.max(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1), 1));

/** the most any cell of a grid of rays spans, corner to corner: a ray between grid points lies within that of one */
function cellSpan(r: Vec3[]): number {
  let cell = 0;
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const k = j * (NX + 1) + i;
      cell = Math.max(cell, angle(r[k], r[k + NX + 2]), angle(r[k + 1], r[k + NX + 1]));
    }
  }
  return cell;
}

/** {@link cellSpan} of a view's own grid, kept with it */
function gridCell(rays: Vec3[]): number {
  if (lastGrid?.rays !== rays) return cellSpan(rays);
  if (lastGrid.cell < 0) lastGrid.cell = cellSpan(rays);
  return lastGrid.cell;
}

/**
 * The least angle any ray of a view can make with a direction, in a sky
 * squashed by q: the least on the grid, less the most any cell of it spans
 */
function leastAngle(rays: Vec3[], to: Vec3, q: number): number {
  const squash = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1] * q, v[2]);
    return [v[0] / l, v[1] * q / l, v[2] / l];
  };
  const b = squash(to);
  const r = rays.map(squash);
  let least = Infinity;
  for (const v of r) least = Math.min(least, angle(v, b));
  return least - cellSpan(r);
}

/**
 * The bit of a variant's key that marks the split program (CLOUD_SPLIT,
 * {@link RendererOptions.cloudScale}) — not a feature of the state but of
 * how the frame is drawn, so kept clear of {@link ALL_FEATURES}. A renderer
 * given a cloud scale used to compile every variant split, and at a scale of
 * 1 drew the one pass with a program that merely carried the split's code —
 * which cost that pass a tenth on a fair or an overcast sky, a fiftieth
 * under a tower (an M2 Max, 1080p). Now only a frame that splits (a scale
 * under 1, or the rays) asks for it, and a scale of 1 takes the one-pass
 * program; changing it at run time compiles the other, the last one
 * drawing while it links.
 */
export const SPLIT_KEY = 65536;

/**
 * The bits of a variant's key that mark the sky cache's programs
 * ({@link RendererOptions.skyCache}): the cloud stack alone, drawn into a
 * keyframe over azimuth × elevation (CACHE_BUILD), and the frame with the
 * stack read back from two keyframes by direction (CACHE_COMP). Like
 * SPLIT_KEY a matter of how the frame is drawn, not of the state; and
 * unlike it never a stand-in for any other key, nor any other for them —
 * neither draws a frame on its own
 */
export const CACHE_BUILD = 131072;
export const CACHE_COMP = 262144;
export const CACHE_BITS = CACHE_BUILD | CACHE_COMP;

/**
 * What to draw a towering sky with while its own program links, the first
 * time, where that takes a long while: the key without the tower and without
 * the lighting and ornaments that are only ever seen for what they add to a
 * finished sky, keeping what changes the whole picture (the sea, a dark
 * site's stars, the aurora, a polarizer) and how the frame is drawn. On a
 * Radeon 8060S under ANGLE / Direct3D 11 it links in 2–3 s where the
 * volumetric tower's takes 10–40 s. A key with no
 * tower is its own: there is nothing long to wait for.
 */
export function firstPaintKey(key: number): number {
  if (!(key & FEATURE.CB) || (key & CACHE_BITS)) return key;
  return key & (FEATURE.SEA | FEATURE.AURORA | FEATURE.DARKSKY | FEATURE.POLARIZER | SPLIT_KEY);
}
