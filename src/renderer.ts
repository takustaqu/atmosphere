// renderer.ts — atmosphere's renderer core (no dependencies, WebGL1)
//
// One fragment shader generates the atmosphere. Drawing is done in
// **view-ray basis, cast from the camera**: sky color, clouds, sun, moon and
// stars are all resolved as "what's visible in that direction". Only
// lens-side phenomena (droplets, flare, vignette) stay in screen space.
//
//   - the sun is given as azimuth/elevation (a real solar position from
//     latitude/longitude can be passed straight through)
//   - being ray-basis, drawing the 6 directions at fov=90° gives a cubemap
//
// The shaders' sources are in shaders/, and which variant of the fragment
// shader a state is drawn with is features.ts.
//
// Dev note: swapping this module out via HMR leaves an already-mounted
// AtmosphereRenderer running the old shader. Reload the page to see changes.

import { CLOUD_GENERA_IDS, type CloudMix } from './clouds.js';
import {
  ALL_FEATURES, CACHE_BITS, CACHE_BUILD, CACHE_COMP, CB_AUTO_BAND, FEATURE, SPLIT_KEY, firstPaintKey,
  backlitInView, cbModeOf, featureKeys, type CumulonimbusMode,
} from './features.js';
import { type ColorSpaceOption } from './gamut.js';
import {
  PROBE_FACE, PROBE_SUB, probeLayout, summarizeProbe,
  type LightMeasurement, type ProbeLayout,
} from './light.js';
import { NOISE_SIZE, noiseLattice, noiseQuads } from './noise.js';
import { parheliaAmounts, parheliaRects, parheliaShape } from './parhelia.js';
import { SOFT_SLOT, SkyCacheScheduler, stackSignature, stateAhead, type CacheBuild, type Keyframe as CacheKeyframe, type SkyCacheOptions } from './skycache.js';
import { MORPH_FRAG } from './shaders/morph.js';
import { fragSource } from './shaders/variants.js';
import { VERT } from './shaders/vert.js';
import { TURRET_ROWS, TURRET_SLOTS, stormAmount, turretTable } from './storm.js';
import { CUBE_FACE_CAMERAS, DEFAULT_CAMERA, type AtmosphereState, type Camera } from './state.js';
import { sunShape } from './sundisc.js';

/** how many variants to keep linked at once; the least recently drawn goes first */
const MAX_VARIANTS = 8;

function popcount(k: number): number {
  let n = 0;
  for (let b = k; b; b >>= 1) n += b & 1;
  return n;
}

/** one compiled program: a combination of features, and where it is in linking */
interface Variant {
  key: number;
  program: WebGLProgram;
  u: Uniforms;
  linked: boolean;
  failed: boolean;
  /** the frame counter when it last drew, for eviction */
  used: number;
}

/**
 * u_time's wrap period, in seconds (~68 min).
 *
 * The shader's float32 has a 24-bit mantissa, so an ever-growing u_time gets
 * coarser: after 8 hours the rain cycle (u_time × 8.5, fract'ed) is quantized
 * to ~3% steps and visibly stutters. 4096 keeps the worst-case fract step
 * under 0.5% while making the wrap rare. u_time only drives short-lived,
 * randomized screen effects (rain, snow, droplets, twinkle, lightning), so
 * the wrap amounts to a one-frame reshuffle of those patterns; cloud motion
 * rides u_windOff / u_evo and is unaffected.
 */
const TIME_WRAP_SEC = 4096;

/**
 * The direction the snow falls in, for a camera: straight down, leaned toward
 * the view's own down by how far the view is tilted. The snowflakes are drawn
 * from a thin shell of a 3D lattice around the eye, so motion along the view
 * ray carries them out of it — straight down while looking up, they blinked
 * rather than fell. Leaning the fall to be square to the view keeps them in
 * the shell across the middle of the frame. Level, the lean is nothing; looking
 * straight up it fades again, and the flakes come at the camera.
 */
export function snowFallDir(camera: Pick<Camera, 'yaw' | 'pitch'>): [number, number, number] {
  const sp = Math.sin(camera.pitch), cp = Math.cos(camera.pitch);
  // forward is dirFromAngles(pitch, yaw); minus Y plus forward × (forward·Y)
  // would be exactly square to it, and 0.85 of that leaves the zenith defined
  const lean = 0.85 * sp;
  const x = lean * cp * Math.sin(camera.yaw);
  const y = -1 + lean * sp;
  const z = lean * cp * Math.cos(camera.yaw);
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
}

/** a cloud scale worth splitting for: past 0.95 the split costs more than it saves */
function clampCloudScale(v: number): number {
  return Number.isFinite(v) && v < 0.95 ? Math.max(0.25, v) : 1;
}

/**
 * Whether any layer of the cloud stack draws. Every layer's gate in the
 * shader is its genus amount past 0.001 (or a stricter bound on the same
 * amounts), so below that the stack is the identity wash and splitting it out
 * would only add a pass and a composite — 1.25–1.45× a clear frame on a
 * Radeon 8060S.
 */
function hasCloudStack(c: CloudMix): boolean {
  for (const g of CLOUD_GENERA_IDS) if (c[g] > 0.001) return true;
  return false;
}

/**
 * How often to ask the driver whether the program has finished linking.
 *
 * Each ask is a cheap flag read, so this is only about how promptly the sky
 * appears once the compile lands — a frame's worth of latency, against a
 * compile that runs for seconds.
 */
const POLL_MS = 16;

/** how long the first link may run before a towering sky is given a first paint */
const FIRST_PAINT_AFTER_MS = 400;
/** how long the tower takes to come in over the first paint when it lands */
const FIRST_PAINT_FADE_MS = 1200;
/** a frame this soon after the last is part of a running loop, not a still frame */
const FIRST_PAINT_FADE_GAP_MS = 250;

type Uniforms = Record<string, WebGLUniformLocation | null>;

const UNIFORM_NAMES = [
  'u_noise', 'u_noiseQ', 'u_turrets',
  'u_frame', 'u_aspect', 'u_time', 'u_cam', 'u_sun', 'u_moon', 'u_moonEclipse',
  'u_cover', 'u_high', 'u_mid', 'u_low',
  'u_rain', 'u_snow', 'u_wind', 'u_thunder', 'u_haze', 'u_cbFeat', 'u_lent',
  'u_windOff', 'u_evo',
  'u_filtAmt', 'u_filtTint', 'u_filtSat', 'u_filtLift',
  'u_p3', 'u_headroom', 'u_tone', 'u_pol', 'u_sky', 'u_radiant', 'u_lensDrops', 'u_lensFx', 'u_fall', 'u_snowDrift',
  'u_sea', 'u_aurora', 'u_contrails', 'u_rays', 'u_sunset', 'u_sunLook',
  'u_cloudMode', 'u_clouds', 'u_xfade', 'u_parhelia',
  'u_map0', 'u_map1', 'u_mapStep', 'u_mapMix', 'u_clouds2',
  'u_flow', 'u_flow2', 'u_box0', 'u_box1', 'u_mapWind', 'u_mapTexels', 'u_evoPerWind', 'u_morph',
] as const;

export interface RendererOptions {
  /** which color space to render into. Defaults to `'auto'` — see {@link ColorSpaceOption} */
  colorSpace?: ColorSpaceOption;
  /**
   * Display ceiling, in multiples of SDR white. Defaults to 1 (standard range).
   *
   * The scene is composited in linear light and the light sources emit well past
   * 1.0, so this is the headroom the tone map's shoulder expands into. 1 keeps
   * the classic look — the sun's core flat white. Above 1 the sun, moon, stars
   * and lightning get brighter than paper white *if* the output can carry it.
   *
   * WebGL has no HDR output path today: `drawingBufferColorSpace` accepts only
   * `srgb` and `display-p3`, and neither `drawingBufferToneMapping` nor the
   * `rec2100-*` spaces are implemented in any shipping browser. So values above
   * 1 are clipped by the 8-bit drawing buffer for now, and this exists so the
   * shader is already correct when that changes (or when driven from a
   * float16 WebGPU/WebGL2 target).
   */
  headroom?: number;
  /**
   * When to find out whether the program linked.
   *
   * `'auto'` (the default) asks the driver via `KHR_parallel_shader_compile`
   * and keeps the main thread free while it works. The trade is that the
   * renderer is not usable the moment the constructor returns: {@link ready}
   * starts false, {@link render} draws nothing until it flips, and
   * {@link RendererOptions.onReady} fires when it does.
   *
   * `'sync'` blocks in the constructor until the program is linked, so one
   * `render()` right after it produces a frame. That is the right choice for a
   * one-shot bake (it is what {@link renderCubeFaces} uses) and the wrong one
   * for anything on screen: on Windows the link runs through ANGLE's D3D
   * backend, and this shader has been measured at around three seconds of
   * frozen page there — nineteen, before the noise lattice moved into a
   * texture. (Only on a first visit; browsers cache compiled shaders.)
   *
   * Where the extension is missing, `'auto'` degrades to `'sync'`.
   */
  compile?: 'auto' | 'sync';
  /**
   * Called once it is known whether this renderer will ever draw: the program
   * linked (`true`), it failed to compile or link, or WebGL itself is
   * unavailable (`false`).
   *
   * `false` means the caller should keep its fallback background up for good.
   *
   * It can fire before the constructor returns — always under
   * `compile: 'sync'`, and in either mode when WebGL is missing or the shader
   * fails to *compile* (only the link is deferred). So a listener attached
   * afterwards may miss it; read {@link ready} and {@link available} instead.
   */
  onReady?: (available: boolean) => void;
  /**
   * A variant has finished linking in the background (or been refused by
   * the driver), after {@link RendererOptions.onReady}. A frame drawn
   * meanwhile went without it, from a stand-in: a caller that isn't drawing
   * again anyway (a still frame) should draw this one again. It is also when
   * {@link AtmosphereRenderer.isSettled} may have come true.
   */
  onLinked?: () => void;
  /**
   * Draw the clouds at this fraction of the frame's resolution, each way, and
   * lay them over a full-resolution sky. Defaults to 1: one pass, as always.
   *
   * The clouds are most of the cost of a cloudy frame — three quarters or
   * more — so 0.5 draws them at a quarter of the pixels and roughly halves
   * the frame. What changes is only their edges, which soften by the same
   * factor; the sky, sun, moon, stars, rain, snow, lens and ground stay at
   * full resolution. One more difference: the 22° halo is laid under the
   * whole cloud stack rather than between the cirrostratus and the layers
   * above it.
   *
   * Needs half-float render targets (`OES_texture_half_float` with linear
   * filtering, and a half-float color buffer) and is ignored without them —
   * {@link AtmosphereRenderer.cloudScale} reads back what is in effect.
   *
   * Giving it at all — 1 included — is what makes it changeable at run time
   * through that setter. A frame that splits (a scale under 1, or the rays)
   * is drawn with a variant of the shader compiled to split, the first such
   * frame compiling it; at a scale of 1 it is the one-pass shader, untouched
   * — the split variant drawing one pass cost it up to a tenth just by
   * carrying the code. Changing the scale across 1 at run time links the other program,
   * the one in use drawing (the whole frame, at full resolution) meanwhile.
   */
  cloudScale?: number;
  /**
   * Crepuscular rays — shafts of sunlit air fanning out from the sun through
   * the gaps in a cloud deck — at this strength, 0..1. Defaults to 0.
   *
   * Drawn in the split variant's composite from the cloud stack's own
   * transmittance, so this needs {@link RendererOptions.cloudScale} given
   * (1 is fine); without it the option does nothing. With rays on, a cloudy
   * frame always takes the split's two passes, cloud scale 1 included.
   * Changeable at run time through {@link AtmosphereRenderer.rays}.
   */
  rays?: number;
  /**
   * Compile the shader per combination of features a frame needs (the
   * default), or everything into one program (`false`). See {@link FEATURE}:
   * the one program is what the renderer used to be, and it is slower on
   * every frame for the features it is not drawing — kept as a switch for
   * measuring that, and for a driver that chokes on a second compile.
   */
  variants?: boolean;
  /**
   * How the cumulonimbus's towers are drawn: `'volumetric'`, their lobes a
   * 3D density ray-marched and lit by its own self-shadowing; `'2d'`, the
   * same towers standing in the same places as a field over azimuth and
   * elevation with its lobes and shading painted on, a frame with a tower a
   * tenth to a sixth lighter; or `'auto'` (the default), the volumetric tower
   * but for a storm standing close, its base overhead (features.distance
   * under {@link CB_AUTO_BAND}), which takes the 2D one — the two crossfaded
   * across the band, so a storm drawing nearer does not jump from one to the
   * other, each frame inside it drawing both. The anvil, veil and
   * rain shafts are the 2D ones whichever. Each tower is a shader variant of
   * its own ({@link FEATURE}.CBVOL), so a frame outside the band carries only
   * the one it draws. Changeable at run time through
   * {@link AtmosphereRenderer.cumulonimbus}.
   */
  cumulonimbus?: CumulonimbusMode;
  /**
   * **Experimental.** Draw the cloud stack into a cache over directions
   * (azimuth × elevation) and read each frame's clouds back from it, rather
   * than drawing them per pixel. Off by default; `true` takes the defaults of
   * {@link SkyCacheOptions}.
   *
   * The stack depends on the direction and the state, not on the camera, so
   * a frame turning the camera costs it nothing; what moves it is the wind
   * and the clouds' evolution, which the cache follows as a series of
   * keyframes, each built whole for one moment over the frames before it is
   * shown, and each frame shown as a mix of the two either side of it. A set()
   * is followed the same way, the keyframes built for the state easing to
   * its target. With no keyframes to show — the first frames, a jump(), a view
   * outside a 'view' window — a small map, drawn whole in one frame, stands in
   * and hands over to the keyframes as they come whole. The first frame of
   * all, a still sky, a view that wants more texels than the budget allows (a
   * narrow fov) and the 'auto' tower's crossfade band are drawn directly.
   * Needs half-float render targets, as cloudScale does, and a second target
   * for the keyframes' motion, and every frame is drawn directly without them
   * (see {@link AtmosphereRenderer.skyCache}); while it is on, cloudScale is
   * not used.
   */
  skyCache?: boolean | SkyCacheOptions;
  /**
   * Measure how long each frame takes on the GPU (`EXT_disjoint_timer_query`),
   * for {@link AtmosphereRenderer.takeGpuTimes}. Off by default; the
   * measurement is asynchronous and does not stall, but there is no reason to
   * pay for queries nobody reads. Ignored where the extension is missing.
   */
  timing?: boolean;
}

/** One GPU-time measurement of a frame: how long it took, and how many pixels it drew */
export interface GpuTime {
  ms: number;
  pixels: number;
}

/** The parts of EXT_disjoint_timer_query this uses (WebGL1 has no type for it) */
interface TimerQueryExt {
  TIME_ELAPSED_EXT: number;
  QUERY_RESULT_EXT: number;
  QUERY_RESULT_AVAILABLE_EXT: number;
  GPU_DISJOINT_EXT: number;
  createQueryEXT(): WebGLQuery | null;
  deleteQueryEXT(q: WebGLQuery | null): void;
  beginQueryEXT(target: number, q: WebGLQuery): void;
  endQueryEXT(target: number): void;
  getQueryObjectEXT(q: WebGLQuery, pname: number): number | boolean;
}

export interface ProbeOptions {
  /**
   * The frame grid's size, `[cols, rows]`. Defaults to `[8, 6]`.
   *
   * Cells are cut from the picture as shown, whatever its aspect, so choose
   * the grid for how finely the foreground needs to read its surroundings,
   * not to match the canvas.
   */
  grid?: [number, number];
  /** also measure the dome all around (six small cube faces). Defaults to true */
  environment?: boolean;
}

/**
 * The atmosphere renderer. One `render()` call is one frame (one image seen from one camera).
 *
 * To bake a cubemap, pass each face of `CUBE_FACE_CAMERAS` in turn and draw 6 times.
 */
export class AtmosphereRenderer {
  private canvas: HTMLCanvasElement;
  private readonly opts: RendererOptions;
  private gl: WebGLRenderingContext | null = null;
  // the compiled variants by feature key (see FEATURE), the one that drew the
  // last frame, and the key the last frame asked for
  private variants = new Map<number, Variant>();
  private current: Variant | null = null;
  private wanted = 0;
  private frame = 0;
  // the snow's fall, integrated along snowFallDir; and the clock it was at
  private snowDrift: [number, number, number] = [0, 0, 0];
  private snowAt = Number.NaN;
  // whether the first drawable variant has been reported through onReady
  private reported = false;
  // variants asked for ahead of need, waiting for the links in flight to land
  // (ensureLater)
  private linkQueue: number[] = [];
  // the first-paint variant, once it has been asked for (see startFirstPaint),
  // and when the first link began
  private firstPaint = -1;
  private linkBegan = 0;
  // when the first-paint variant began giving way to the sky's own, and when
  // the last frame was drawn (firstPaintFade)
  private fadeBegan = 0;
  private lastFrame = 0;
  private parallel: { COMPLETION_STATUS_KHR: number } | null = null;
  private explicitLod = false;
  private buffer: WebGLBuffer | null = null;
  private noise: WebGLTexture | null = null;
  // the lattice again, each texel's square of four in rgba: unit 2, for vnoiseHQ
  private noiseQ: WebGLTexture | null = null;
  // each turret's thrust (storm.ts): unit 3, refilled when the storm's clock
  // or distance moves; turretKey is what it was last filled for
  private turrets: WebGLTexture | null = null;
  private turretData = new Uint8Array(TURRET_SLOTS * TURRET_ROWS * 4);
  private turretKey = '';
  // the light probe's offscreen target, made on first use and resized to the layout
  private probeFbo: WebGLFramebuffer | null = null;
  private probeTex: WebGLTexture | null = null;
  private probeSize: [number, number] = [0, 0];
  private probePixels: Uint8Array | null = null;
  // the cloud stack's own target, when cloudScale < 1 (see RendererOptions.cloudScale)
  private cloudScaleWanted: number;
  private raysWanted: number;
  private cbMode: CumulonimbusMode;
  // under 'auto' inside the band, the second of the two variants a frame is
  // drawn with: kept from eviction as `wanted` is
  private wantedVol = -1;
  // the evolution clock as of the last frame: whether the parhelia's plates are settled (parheliaPlates)
  private evoNow = 0;
  // whether the split variant may be drawn with (a cloud scale given at
  // construction): which frames do is SPLIT_KEY, in keysFor
  private readonly split: boolean;
  private cloudSupport: boolean | null = null;   // null = not asked yet on this context
  private cloudFbo: WebGLFramebuffer | null = null;
  private cloudTex: WebGLTexture | null = null;
  private cloudSize: [number, number] = [0, 0];
  // the sky cache (RendererOptions.skyCache): its schedule, its three
  // keyframe slots and its soft map, the state each slot is built for, and
  // the programs it drew the last frame with
  private sky: SkyCacheScheduler | null = null;
  private skyTex: (WebGLTexture | null)[] = [null, null, null, null];
  private skyFbo: (WebGLFramebuffer | null)[] = [null, null, null, null];
  private skyState: (AtmosphereState | null)[] = [null, null, null, null];
  private skyPrev: AtmosphereState | null = null;
  private skyPrevClock = 0;
  // each slot's motion, its second target (null: no motion compensation),
  // and the extension that draws both at once, asked for when the context
  // is made (the build's source depends on it)
  private skyFlow: (WebGLTexture | null)[] = [null, null, null, null];
  private skyDraw: WEBGL_draw_buffers | null = null;
  // each slot's morph from the keyframe before it (MORPH_FRAG), a quarter
  // the size each way, and the program that finds it
  private skyMorph: (WebGLTexture | null)[] = [null, null, null, null];
  private skyMorphFbo: (WebGLFramebuffer | null)[] = [null, null, null, null];
  private morph: { program: WebGLProgram; u: Uniforms } | null = null;
  private morphLink: WebGLProgram | null = null;
  private morphFailed = false;
  private skySize: [number, number] = [0, 0];
  private skySupport: boolean | null = null;
  private skyKeys: number[] = [];
  private skyReason = 'off';
  private skyMix = -1;
  // GPU timing (RendererOptions.timing): queries in flight, and finished results
  private timer: TimerQueryExt | null = null;
  private pending: { q: WebGLQuery; pixels: number }[] = [];
  private gpuTimes: GpuTime[] = [];
  private u: Uniforms = {};
  private lost = false;
  private p3 = false;
  // Timer for the parallel-compile poll. The renderer polls itself rather than
  // leaning on render() being called: under reduced motion the caller draws
  // exactly one frame, and nothing would ever ask again.
  //
  // A timer and not requestAnimationFrame: rAF stops in a hidden tab and in an
  // offscreen canvas that nothing paints, and a renderer built there would
  // never report itself ready. A background tab throttles this to about once a
  // second, which is nothing against a compile measured in seconds.
  private poll: ReturnType<typeof setTimeout> | 0 = 0;
  // kept so dispose() can detach them. A disposed renderer that still listens
  // would re-init on a context restore and steal the live renderer's program
  private readonly onLost = (e: Event) => { e.preventDefault(); this.lost = true; };
  private readonly onRestored = () => { this.lost = false; this.init(); };

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.opts = options;
    this.cloudScaleWanted = options.cloudScale ?? 1;
    this.raysWanted = options.rays ?? 0;
    this.cbMode = cbModeOf(options.cumulonimbus);
    this.split = options.cloudScale !== undefined;
    if (options.skyCache) this.sky = new SkyCacheScheduler(options.skyCache === true ? {} : options.skyCache);
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.init();
  }

  /**
   * false in environments where WebGL isn't available, or once the shader has
   * failed to compile (the caller should keep its fallback background).
   *
   * Under the default `compile: 'auto'` a shader failure is only discovered
   * later, so this can start true and go false. {@link RendererOptions.onReady}
   * is the callback for that moment.
   */
  get available(): boolean { return this.gl !== null; }

  /**
   * true once a program is linked and `render()` will actually draw: the
   * variant the last frame asked for, or — once anything has been drawn —
   * whatever drew it, which stands in while a newly needed variant links.
   *
   * Always true by the time the constructor returns under `compile: 'sync'`,
   * where each variant is compiled on the spot when first needed.
   */
  get ready(): boolean {
    if (!this.gl) return false;
    if (!this.parallel) return true;
    return !!this.variants.get(this.wanted)?.linked || this.current !== null
      || !!this.variants.get(this.firstPaint)?.linked;
  }

  /**
   * true when this state is drawn by its own programs: {@link ready}, and
   * none of the variants it needs (as {@link prepare} starts them: its frame's,
   * both towers' inside the 'auto' crossfade, the parhelia's, the sky
   * cache's) is still linking. Until then a frame of it is drawn by a stand-in,
   * without whatever feature the missing variant carries, and a bake of it
   * would be too. Call prepare(s) first, so that what it needs is linking.
   *
   * Cheap enough for every frame: with nothing linking it is a look over the
   * variants in hand, and the state's own keys are only worked out while
   * something is. A variant the driver refused counts as done (the frame goes
   * without its feature for good), and so does one never asked for. Always
   * true while {@link ready} under `compile: 'sync'`, where nothing is ever
   * left linking.
   */
  isSettled(s: AtmosphereState): boolean {
    if (!this.gl || this.lost || !this.ready) return false;
    if (this.fadeBegan > 0 && performance.now() - this.fadeBegan < FIRST_PAINT_FADE_MS) return false;
    let linking = this.linkQueue.length > 0;
    if (!linking) for (const v of this.variants.values()) if (!v.linked && !v.failed) { linking = true; break; }
    if (!linking) return true;
    for (const k of this.programsFor(s)) {
      const v = this.variants.get(k);
      if ((v && !v.linked && !v.failed) || this.linkQueue.includes(k)) return false;
    }
    return true;
  }

  /**
   * The space actually being rendered into — `'display-p3'` only where the
   * browser supports it, whatever was requested.
   *
   * A 2D canvas that receives a `drawImage` of this one should be created with
   * the same `colorSpace`, or the wide-gamut pixels get clipped in the copy.
   */
  get colorSpace(): PredefinedColorSpace { return this.p3 ? 'display-p3' : 'srgb'; }

  /**
   * The cloud stack's resolution relative to the frame, as in effect: what
   * was asked for, or 1 where half-float targets are missing. Setting it
   * takes effect on the next frame (once the split variant of the shader has
   * linked, the first time it goes under 1) — but only on a renderer
   * constructed with {@link RendererOptions.cloudScale} (any value, 1
   * included). Without it this stays 1.
   */
  get cloudScale(): number {
    return !this.split || this.cloudSupport === false ? 1 : clampCloudScale(this.cloudScaleWanted);
  }
  set cloudScale(v: number) { this.cloudScaleWanted = v; }

  /**
   * Whether the sky cache is in effect: false without
   * {@link RendererOptions.skyCache}, and where the device cannot do it (no
   * half-float targets, or no second target for its motion, or no memory for
   * its maps), which is found out when the context is made or, for the last, on
   * the first frame it builds. Every frame is then drawn directly.
   */
  get skyCache(): boolean {
    return this.sky !== null && this.gl !== null && this.skySupport !== false;
  }

  /**
   * The crepuscular rays' strength in effect — see {@link RendererOptions.rays}.
   * 0 on a renderer built without `cloudScale`, whatever was asked for.
   */
  get rays(): number {
    return !this.split || this.cloudSupport === false ? 0 : Math.min(1, Math.max(0, this.raysWanted));
  }
  set rays(v: number) { this.raysWanted = v; }

  /**
   * How the cumulonimbus's towers are drawn — see
   * {@link RendererOptions.cumulonimbus}. Setting it takes effect once the
   * variant it needs has linked.
   */
  get cumulonimbus(): CumulonimbusMode { return this.cbMode; }
  set cumulonimbus(v: CumulonimbusMode) { this.cbMode = cbModeOf(v); }

  /**
   * the variants a state is drawn with and each one's share (see
   * featureKeys; null: the one that draws anything — under 'auto' the
   * volumetric tower, which the middle distance every sky is set at takes)
   */
  private keysFor(s: AtmosphereState | null, camera?: Camera, aspect = 1): { key: number; share: number }[] {
    // (the split program only for a frame that splits: see SPLIT_KEY)
    const sp = this.cloudScale < 1 || this.rays > 0 ? SPLIT_KEY : 0;
    const all = (ALL_FEATURES & ~FEATURE.CBVOL) | (this.cbMode !== '2d' ? FEATURE.CBVOL : 0) | sp;
    if (s === null) return [{ key: all, share: 1 }];
    const ks = featureKeys(s, this.rays, this.cbMode, this.evoNow);
    if (this.opts.variants === false) {
      // everything in one program — the one above for a sky without a tower,
      // which either tower's program draws alike (asked for by its own key,
      // a fair tile in a gallery drawn with the volumetric program waited on
      // a second compile and came out blank); with one, the key's own tower
      if (!(ks[0].key & FEATURE.CB)) return [{ key: all, share: 1 }];
      for (const k of ks) k.key = (ALL_FEATURES & ~FEATURE.CBVOL) | (k.key & FEATURE.CBVOL);
    }
    for (const k of ks) k.key |= sp;
    // and the light from behind only in a view it can be seen in (see
    // backlitInView) — not under the 2D tower, whose lobes' cast shadows
    // take a share of it however far round the sun is, nor in the one
    // program that carries everything, nor where the variants link on the
    // spot: a view turning away from the sun would stop the page for a
    // compile, and a bake's faces looking away from it would compile a
    // second program for the sake of a frame or two
    if (camera && this.parallel && this.opts.variants !== false && (ks[0].key & FEATURE.BACKLIT)
        && !backlitInView(s, camera, aspect)) {
      for (const k of ks) if (!(k.key & FEATURE.CB) || (k.key & FEATURE.CBVOL)) k.key &= ~FEATURE.BACKLIT;
    }
    return ks;
  }

  /**
   * The GPU times of the frames measured since the last call, oldest first —
   * empty without {@link RendererOptions.timing} or the extension.
   *
   * Asynchronous by construction: a frame's time can only be read once the
   * GPU has finished it, so results trail render() by a frame or two. Frames
   * spanning a GPU disjoint event (a clock change, a context switch) are
   * dropped rather than reported wrong.
   */
  takeGpuTimes(): GpuTime[] {
    this.harvestTimes();
    const out = this.gpuTimes;
    this.gpuTimes = [];
    return out;
  }

  private init(): void {
    this.variants = new Map();
    this.linkQueue = [];
    this.firstPaint = -1;
    this.linkBegan = 0;
    this.fadeBegan = 0;
    this.lastFrame = 0;
    this.current = null;
    this.reported = false;
    this.u = {};
    this.stopPolling();
    // handles from a lost context are dead; the probe and cloud targets are
    // rebuilt on demand, and the new context is asked about half floats again
    this.probeFbo = null;
    this.probeTex = null;
    this.probeSize = [0, 0];
    this.cloudFbo = null;
    this.cloudTex = null;
    this.cloudSize = [0, 0];
    this.cloudSupport = null;
    this.skyTex = [null, null, null, null];
    this.skyFbo = [null, null, null, null];
    this.skyFlow = [null, null, null, null];
    this.skyMorph = [null, null, null, null];
    this.skyMorphFbo = [null, null, null, null];
    this.morph = null;
    this.morphLink = null;
    this.morphFailed = false;
    this.skySize = [0, 0];
    this.skySupport = null;
    this.skyKeys = [];
    this.sky?.reset();
    this.pending = [];
    const gl = this.canvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'low-power',
    });
    if (!gl) { this.gl = null; this.notifyReady(false); return; }
    this.gl = gl;

    // Assigning an unsupported value is specified to leave the property alone,
    // so read it back rather than trusting the write. init() also runs on
    // context restore, which is what re-applies this after a GPU reset
    this.p3 = false;
    if (this.opts.colorSpace !== 'srgb' && 'drawingBufferColorSpace' in gl) {
      gl.drawingBufferColorSpace = 'display-p3';
      this.p3 = gl.drawingBufferColorSpace === 'display-p3';
    }

    this.explicitLod = gl.getExtension('EXT_shader_texture_lod') !== null;
    // the sky cache's keyframes carry their motion in a second target, one draw
    // filling two (see cacheFetch). Where that is not to be had — nor the half
    // floats it draws into, nor the eight texture units its composite reads —
    // there is no cache to speak of: mixed as they stand, the keyframes are a
    // crossfade plain to see, so unless that is what was asked for (motion:
    // false) every frame is drawn directly
    this.skyDraw = this.sky?.motion ? gl.getExtension('WEBGL_draw_buffers') : null;
    if (this.sky && (!gl.getExtension('OES_texture_half_float') || !gl.getExtension('OES_texture_half_float_linear')
      || (gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number) < 8
      || (this.sky.motion && (!this.skyDraw || (gl.getParameter(this.skyDraw.MAX_DRAW_BUFFERS_WEBGL) as number) < 2)))) {
      this.skySupport = false;
    }
    // On Windows, linkProgram is where ANGLE hands the whole shader to the
    // D3D compiler, and reading LINK_STATUS is what waits for it. Asking the
    // driver whether it's finished instead keeps the page alive through it.
    this.parallel = this.opts.compile === 'sync'
      ? null
      : gl.getExtension('KHR_parallel_shader_compile');

    this.noise = this.createNoise(gl);
    this.noiseQ = this.createNoiseQuads(gl);
    this.turrets = this.createTurrets(gl);

    // a fullscreen triangle. Every variant binds a_pos to attribute 0 before
    // it links, so this is set up once for all of them
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.timer = this.opts.timing
      ? gl.getExtension('EXT_disjoint_timer_query') as TimerQueryExt | null
      : null;

    // Nothing is compiled until a frame (or prepare()) says which variant it
    // needs: compiling the bare one first would only delay the right one.
    // Under 'sync' the first render() compiles on the spot, so the renderer
    // is usable the moment the constructor returns, as before
    if (!this.parallel) this.notifyReady(true);
    // A renderer driven directly may wait for onReady before its first
    // render(), and then nothing ever says which variant to compile. If a
    // turn passes without a prepare() or a frame, compile the one program
    // that can draw anything, so onReady still comes
    else setTimeout(() => {
      if (!this.gl || this.lost || this.variants.size > 0) return;
      this.wanted = this.keysFor(null)[0].key;
      this.ensure(this.wanted);
    }, 0);
  }

  /**
   * Start compiling the variant this state will need, without drawing, so
   * it is linked by the time the first frame asks. `Atmosphere` calls this
   * with its target on construction and on every `set()`, well ahead of the
   * transition that crosses a feature's threshold.
   */
  prepare(s: AtmosphereState): void {
    if (!this.gl || this.lost) return;
    const keys = this.programsFor(s);
    // (what the first frame will ask for: without the parhelia, drawn apart)
    if (this.current === null) this.wanted = keys[0];
    keys.forEach((key, i) => { if (i === 0) this.ensure(key); else this.ensureLater(key); });
  }

  /** the variants a state is drawn with, in the order prepare() starts them */
  private programsFor(s: AtmosphereState): number[] {
    const ks = this.keysFor(s);
    const out: number[] = [];
    // (a sky with parhelia is drawn without them and then again with them on
    // top: see drawParhelia. Its plain frame first, for the first frame to ask for)
    if (ks.length === 1 && this.parheliaApart(s)) out.push(ks[0].key & ~FEATURE.PARHELIA);
    for (const k of ks) out.push(k.key);
    // and the sky cache's two programs, behind them: until both link, the
    // frames are drawn directly
    if (this.sky && this.skySupport !== false && ks.length === 1 && hasCloudStack(s.clouds)) {
      const key = ks[0].key & ~SPLIT_KEY;
      out.push((key & ~FEATURE.PARHELIA) | CACHE_BUILD);
      if (this.parheliaApart(s)) out.push((key & ~FEATURE.PARHELIA) | CACHE_COMP);
      out.push(key | CACHE_COMP);
    }
    return out;
  }

  /** the variant for a key, compiling it if this is the first ask */
  private ensure(key: number): Variant | null {
    const have = this.variants.get(key);
    if (have) return have;
    const gl = this.gl;
    if (!gl) return null;
    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      // (asking now would wait out the compile on this thread. In parallel
      // the asking waits for the link to finish, whose log tells of it too)
      if (!this.parallel && !gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('atmosphere shader compile error:', gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, fragSource(this.explicitLod, (key & SPLIT_KEY) !== 0, key, this.skyDraw !== null));
    const prog = vs && fs ? gl.createProgram() : null;
    if (!vs || !fs || !prog) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      const dead: Variant = { key, program: null as unknown as WebGLProgram, u: {}, linked: false, failed: true, used: this.frame };
      this.variants.set(key, dead);
      this.onVariantFailed(dead);
      return dead;
    }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_pos');
    gl.linkProgram(prog);
    if (!this.linkBegan) this.linkBegan = performance.now();
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    const v: Variant = { key, program: prog, u: {}, linked: false, failed: false, used: this.frame };
    this.variants.set(key, v);
    this.evict();
    if (!this.parallel) this.finishLink(v);
    else this.startPolling();
    return v;
  }

  /**
   * The variant for a key that no frame is waiting on yet: compiled once
   * the links in flight have landed. Links started side by side slow each
   * other where the driver compiles through D3D: on a Radeon 8060S under
   * ANGLE / Direct3D 11, two take 1.5× as long as one and four 2.1×, and a
   * towering sky's own program came a third later for the parhelia's linking
   * beside it.
   */
  private ensureLater(key: number): void {
    if (this.variants.has(key) || this.linkQueue.includes(key)) return;
    if (!this.parallel) { this.ensure(key); return; }
    for (const v of this.variants.values()) {
      if (!v.linked && !v.failed) { this.linkQueue.push(key); return; }
    }
    this.ensure(key);
  }

  /**
   * The variant to draw this frame with: the one the key names once it is
   * linked, and until then whatever can stand in — a linked variant with
   * every feature this one needs, else the one that drew the last frame
   * (missing the new feature for the fraction of a second it takes). Before
   * anything has been drawn there is nothing to stand in, and the first
   * frame waits for the right one.
   */
  private pick(key: number): Variant | null {
    this.wanted = key;
    const exact = this.ensure(key);
    if (!exact) return null;
    if (exact.linked) return exact;
    if (exact.failed) {
      // a feature's variant the driver refused: draw without it rather than nothing
      if (key === 0) return null;
      const base = this.ensure(0);
      return base?.linked ? base : null;
    }
    return this.standIn(key) ?? (this.current?.linked && !(this.current.key & CACHE_BITS) ? this.current : null)
      ?? this.firstPaintFor(key);
  }

  /** the first-paint variant, if it has linked and draws nothing this key does not */
  private firstPaintFor(key: number): Variant | null {
    const v = this.variants.get(this.firstPaint);
    return v?.linked && !(v.key & ~key) ? v : null;
  }

  /**
   * A towering sky's program takes tens of seconds to link where the driver
   * compiles through D3D (ANGLE on Windows, on a first visit only), and until
   * something has linked the canvas stays empty. So if the first link is still
   * running a moment in, and it is one of those, compile the sky without the
   * tower beside it, a few seconds' work, to draw until the tower's own lands
   * (see firstPaintKey). Where links take milliseconds, as they do elsewhere
   * and on any later visit, the moment passes first and this never happens.
   */
  private startFirstPaint(): void {
    if (this.reported || this.firstPaint >= 0 || this.opts.variants === false) return;
    if (performance.now() - this.linkBegan < FIRST_PAINT_AFTER_MS) return;
    const key = firstPaintKey(this.wanted);
    if (key === this.wanted) return;
    this.firstPaint = key;
    this.ensure(key);
  }

  /**
   * a linked variant that draws everything a key's does, the fewest extra
   * features first. CBVOL is not a feature added but a tower swapped, so a
   * variant with a tower in it stands in only for a key with the same
   * tower: a 2D key stood in for by the volumetric variant drew a near storm
   * as the other tower for as long as its own took to link
   */
  private standIn(key: number): Variant | null {
    let best: Variant | null = null;
    for (const v of this.variants.values()) {
      if (!v.linked || (v.key & key) !== key) continue;
      if ((key & FEATURE.CB) && ((v.key ^ key) & FEATURE.CBVOL)) continue;
      // (the sky cache's programs draw half a frame each: never in another's place)
      if ((v.key ^ key) & CACHE_BITS) continue;
      if (!best || popcount(v.key) < popcount(best.key)) best = v;
    }
    return best;
  }

  /** drop the least recently drawn variants past the cap, never the one in use */
  private evict(): void {
    const gl = this.gl;
    if (!gl) return;
    while (this.variants.size > MAX_VARIANTS) {
      let victim: Variant | null = null;
      for (const v of this.variants.values()) {
        if (v === this.current || v.key === this.wanted || v.key === this.wantedVol || this.skyKeys.includes(v.key) || !(v.linked || v.failed)) continue;
        if (!victim || v.used < victim.used) victim = v;
      }
      if (!victim) return;
      if (!victim.failed) gl.deleteProgram(victim.program);
      this.variants.delete(victim.key);
    }
  }

  private startPolling(): void {
    if (this.poll) return;
    const step = (): void => {
      this.poll = 0;
      const gl = this.gl, parallel = this.parallel;
      if (!gl || !parallel) return;
      this.startFirstPaint();
      let pending = false, finished = false;
      for (const v of this.variants.values()) {
        if (v.linked || v.failed) continue;
        if (gl.getProgramParameter(v.program, parallel.COMPLETION_STATUS_KHR)) {
          const first = !this.reported;
          this.finishLink(v);
          // (the first one to be drawn is onReady's to tell; any other that
          // lands in the same turn, before or after it, is onLinked's)
          if (!(first && this.reported)) finished = true;
        } else pending = true;
      }
      if (pending) this.poll = setTimeout(step, POLL_MS);
      else {
        // the next one that is still to do, if any (an urgent ask may have
        // started one of them since, and a shader that fails to compile
        // starts nothing to wait for)
        while (this.gl && this.linkQueue.length) {
          const v = this.ensure(this.linkQueue.shift()!);
          if (v && !v.linked && !v.failed) break;
        }
      }
      if (finished && this.reported && this.gl) this.opts.onLinked?.();
    };
    // a turn of the event loop before the first ask, so the caller gets to
    // finish constructing and paint its fallback first
    this.poll = setTimeout(step, POLL_MS);
  }

  /** the baked value-noise lattice, tiling and bilinear-filtered — see noise.ts */
  private createNoise(gl: WebGLRenderingContext): WebGLTexture | null {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, NOISE_SIZE, NOISE_SIZE, 0,
      gl.LUMINANCE, gl.UNSIGNED_BYTE, noiseLattice());
    // REPEAT is what lets the lattice tile, LINEAR is what does vnoise's
    // interpolation, and no mipmaps: a minified fetch must stay the same noise
    // the neighbouring pixel read, or the fbm chains lose their high octaves
    // in a smear wherever the projection compresses
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  /**
   * The lattice's squares of four (noiseQuads), on unit 2. Read only at texel
   * centers, so unfiltered: what comes back is the texel, nothing blended in
   */
  private createNoiseQuads(gl: WebGLRenderingContext): WebGLTexture | null {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, NOISE_SIZE, NOISE_SIZE, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, noiseQuads());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    return tex;
  }

  /**
   * The turrets (turretTable), on unit 3: TURRET_SLOTS × TURRET_ROWS, read at
   * texel centers and so unfiltered. Filled per frame by updateTurrets
   */
  private createTurrets(gl: WebGLRenderingContext): WebGLTexture | null {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TURRET_SLOTS, TURRET_ROWS, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, this.turretData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.activeTexture(gl.TEXTURE0);
    this.turretKey = '';
    return tex;
  }

  /**
   * Read every turret's thrust for this frame's storm, if it moved since the
   * last fill (a sky with no tower in it never reads them). Leaves unit 3
   * active with the table bound
   */
  private updateTurrets(gl: WebGLRenderingContext, s: AtmosphereState, evo: number): void {
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.turrets);
    if (!this.turrets || !(s.clouds.cumulonimbus > 0)) return;
    // (the storm's size sets how high the thrust carries each turret)
    const amount = stormAmount(s.clouds.cumulonimbus, s.rain, s.snow, s.wind);
    const key = s.features.distance + ' ' + evo + ' ' + amount;
    if (key === this.turretKey) return;
    this.turretKey = key;
    turretTable(s.features.distance, evo, amount, this.turretData);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TURRET_SLOTS, TURRET_ROWS, gl.RGBA, gl.UNSIGNED_BYTE, this.turretData);
  }

  /**
   * Carry the snow's fall forward to this frame. A frame that does not follow
   * on from the last (the first, a jump in the clock, its wrap) starts the
   * fall over as if it had always been in this direction, so a one-off frame
   * at a given time is the same frame whatever was drawn before it
   */
  private advanceSnow(timeSec: number, camera: Camera): void {
    const t = timeSec % TIME_WRAP_SEC;
    const dir = snowFallDir(camera);
    const dt = t - this.snowAt;
    const d = this.snowDrift;
    if (dt >= 0 && dt <= 1) {
      d[0] += dir[0] * dt; d[1] += dir[1] * dt; d[2] += dir[2] * dt;
    } else {
      d[0] = dir[0] * t; d[1] = dir[1] * t; d[2] = dir[2] * t;
    }
    this.snowAt = t;
  }

  /** collect a variant's link result and the per-program setup that depends on it */
  private finishLink(v: Variant): void {
    const gl = this.gl;
    if (!gl) return;
    if (!gl.getProgramParameter(v.program, gl.LINK_STATUS)) {
      console.error('atmosphere shader link error:', gl.getProgramInfoLog(v.program));
      gl.deleteProgram(v.program);
      v.failed = true;
      this.onVariantFailed(v);
      return;
    }
    gl.useProgram(v.program);
    for (const name of UNIFORM_NAMES) v.u[name] = gl.getUniformLocation(v.program, name);
    // the sampler bindings live in the program, so once per program; which
    // texture each unit holds is context state, and render() re-establishes that
    gl.uniform1i(v.u.u_noise, 0);
    gl.uniform1i(v.u.u_clouds, 1);
    gl.uniform1i(v.u.u_noiseQ, 2);
    gl.uniform1i(v.u.u_turrets, 3);
    gl.uniform1i(v.u.u_clouds2, 4);
    gl.uniform1i(v.u.u_flow, 5);
    gl.uniform1i(v.u.u_flow2, 6);
    gl.uniform1i(v.u.u_morph, 7);
    v.linked = true;
    if (!this.reported && (v.key === this.wanted || v.key === this.firstPaint)) {
      this.reported = true;
      this.notifyReady(true);
    }
  }

  /**
   * A variant the driver refused. The bare one failing means the device
   * cannot run this shader at all; a feature's variant failing only means
   * that feature is drawn without, from the bare variant
   */
  private onVariantFailed(v: Variant): void {
    if (v.key !== 0) {
      if (v.key === this.wanted && !this.reported) this.ensure(0);
      return;
    }
    const gl = this.gl;
    if (gl) {
      for (const o of this.variants.values()) if (o.linked) gl.deleteProgram(o.program);
      if (this.noise) gl.deleteTexture(this.noise);
      if (this.noiseQ) gl.deleteTexture(this.noiseQ);
      if (this.turrets) gl.deleteTexture(this.turrets);
    }
    this.variants = new Map();
    this.current = null;
    this.noise = null;
    this.noiseQ = null;
    this.turrets = null;
    this.gl = null;
    this.notifyReady(false);
  }

  private notifyReady(available: boolean): void {
    this.opts.onReady?.(available);
  }

  private stopPolling(): void {
    if (!this.poll) return;
    clearTimeout(this.poll);
    this.poll = 0;
  }

  resize(width: number, height: number): void {
    // assigning a canvas's size clears it, even to the size it already has
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.gl?.viewport(0, 0, width, height);
  }

  /**
   * Draw one frame.
   *
   * @param timeSec elapsed seconds (used for real-time phenomena: rain, snow, lightning, twinkling).
   *   Wrapped modulo {@link TIME_WRAP_SEC} before upload — the shader's float32
   *   would otherwise quantize fast cycles (rain) into visible stepping after a
   *   few hours. Cloud motion rides the integrated offsets, so the wrap only
   *   reshuffles short-lived screen effects once per period.
   * @param s       the resolved state
   * @param camera  the viewpoint. Defaults to the default framing
   * @param windOff wind's integrated offset (speed×dt, accumulated by the caller)
   * @param evo     shape evolution's integrated offset (same idea)
   */
  render(
    timeSec: number,
    s: AtmosphereState,
    camera: Camera = DEFAULT_CAMERA,
    windOff = 0,
    evo = 0,
  ): void {
    this.advanceSnow(timeSec, camera);
    this.evoNow = evo;
    const passes = this.passes(s, camera, this.canvas.width / Math.max(1, this.canvas.height));
    if (!passes) return;
    const gl = this.gl!;
    const w = this.canvas.width, h = this.canvas.height;
    const query = this.beginTiming(w * h);
    if (!this.sky || !this.drawCached(gl, passes.length, timeSec, s, camera, windOff, evo)) {
      let mode = 0;
      passes.forEach((p, i) => { mode = this.drawFrame(gl, p.v, i > 0 ? p.share : 1, timeSec, s, camera, windOff, evo); });
      if (passes.length === 1) this.drawParhelia(gl, passes[0].v, mode, timeSec, s, camera, windOff, evo);
    }
    if (query) this.timer!.endQueryEXT(this.timer!.TIME_ELAPSED_EXT);
  }

  /**
   * Whether a frame of this sky has its parhelia drawn apart from it (drawParhelia)
   * rather than in its program: not the one program that carries everything,
   * nor through a lens with drops on it, which bends rays across the frame
   * from outside any rectangle. (A crossfade's two frames keep them in as well:
   * neither alone is the picture to lay them over.)
   */
  private parheliaApart(s: AtmosphereState): boolean {
    return this.opts.variants !== false && !(s.rain > 0.05 && s.lens.droplets > 0.001);
  }

  /**
   * The parhelia, over the plain frame just drawn: the same frame again from
   * the program that carries them, only where one can show. They are two spots
   * in a sky with a wisp of ice in it, which is most of them below 45°; carried
   * by the program that draws the whole frame they cost it a tenth to a sixth
   * of its time (an M2 Max, 1080p: a fair sky, a cirrus one), with a parhelion in view
   * or not, though they run on a few thousandths of its pixels. A parhelia() cut
   * down to its gates cost nothing, and either its noise or its colors alone
   * brought the whole of that back, so it looks to be how the rest of the
   * program compiles around them, not their work. This way every pixel
   * outside the rectangles is the frame without them, at its cost, and the
   * rectangles are a few hundredths of the frame. It keeps the whole sky's
   * variant, so turning the view doesn't compile another, and until that has
   * linked the frame goes without. A split frame's stack stays as it was drawn
   * and only the composite is drawn again.
   */
  private drawParhelia(
    gl: WebGLRenderingContext, main: Variant, mode: number,
    timeSec: number, s: AtmosphereState, camera: Camera, windOff: number, evo: number,
  ): void {
    const key = this.keysFor(s)[0].key;
    if (!(key & FEATURE.PARHELIA) || (main.key & FEATURE.PARHELIA)) return;
    // (over this very sky, not a stand-in for it while its own links; the
    // light from behind is left out of a frame only where it would draw nothing)
    if ((main.key | FEATURE.BACKLIT | FEATURE.PARHELIA) !== (key | FEATURE.BACKLIT)) return;
    const w = this.canvas.width, h = this.canvas.height;
    const rects = parheliaRects(s, camera, w, h, evo);
    if (!rects.length) return;
    const v = this.ensure(key);
    if (!v?.linked) return;
    this.drawFrame(gl, v, 1, timeSec, s, camera, windOff, evo, { rects, mode });
    // (what the frame was drawn with, as far as what is linked and in use goes)
    this.current = main;
  }

  /**
   * What the sky cache did with the last frame, for measurement: why it was
   * drawn directly ('ok' when it was drawn from the cache), how far it was
   * from the first keyframe to the second (-1 when drawn directly), the
   * maps' density and size, their memory, and the texels built since the
   * last read
   */
  takeSkyCacheStats(): { reason: string; mix: number; texelsPerRad: number; size: [number, number]; bytes: number; texelsBuilt: number } | null {
    const c = this.sky;
    if (!c) return null;
    const out = { reason: this.skyReason, mix: this.skyMix, texelsPerRad: c.texelsPerRad, size: c.size, bytes: c.bytes, texelsBuilt: c.texelsBuilt };
    c.texelsBuilt = 0;
    return out;
  }

  /**
   * One frame through the sky cache: this frame's slice of the keyframe
   * being built, then — when the cache can stand for the direct draw — the
   * frame composited from the two keyframes either side of it. false: the
   * frame is to be drawn directly (the slice, if any, is drawn regardless,
   * so the cache keeps up while a frame it cannot draw goes by)
   */
  private drawCached(
    gl: WebGLRenderingContext, passCount: number,
    timeSec: number, s: AtmosphereState, camera: Camera, windOff: number, evo: number,
  ): boolean {
    const sky = this.sky!;
    const no = (reason: string): boolean => { sky.reset(); this.skyReason = reason; this.skyMix = -1; return false; };
    // (the 'auto' tower's crossfade band is two programs' frames laid one
    // over the other; a cache for each would be twice the memory for the
    // band's sake alone)
    if (passCount > 1) return no('band');
    if (!hasCloudStack(s.clouds)) return no('clear');
    if (this.skySupport === false) return no('unsupported');
    // the whole sky's key, the light from behind kept in: a panorama looks
    // every way. Not the split program's: the cache is a split of its own
    const key = this.keysFor(s)[0].key & ~SPLIT_KEY;
    // (the parhelia stand still on the sky as the keyframes move past: they
    // are the composite's, which reads the ice at them for itself, and apart
    // from it as any frame's are)
    const apart = this.parheliaApart(s);
    const kb = (key & ~FEATURE.PARHELIA) | CACHE_BUILD, kc = (apart ? key & ~FEATURE.PARHELIA : key) | CACHE_COMP;
    const kd = key | CACHE_COMP;
    // (while this sky's own link, as a frame drawn directly goes on with what
    // it has, whatever can stand in or else the program of the last frame)
    const [lb, lc] = this.skyKeys;
    const ready = (k: number, last: number): Variant | null => {
      const v = this.ensure(k);
      if (v?.linked) return v;
      const o = this.standIn(k) ?? this.variants.get(last);
      return o?.linked && !v?.failed ? o : null;
    };
    const vb = ready(kb, lb), vc = ready(kc, lc);
    if (!vb || !vc) return no(this.variants.get(kb)?.failed || this.variants.get(kc)?.failed ? 'failed' : 'compiling');
    this.skyKeys = [vb.key, vc.key, kd, kb, kc];
    const w = this.canvas.width, h = this.canvas.height;
    const plan = sky.frame({
      sig: stackSignature(s), clocks: { time: timeSec, wind: windOff, evo }, camera,
      width: w, height: h, maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    });
    this.skyReason = plan.reason;
    this.skyMix = plan.show ? plan.show.mix : -1;
    if ((plan.builds.length || plan.show) && !this.skyTargets(gl, plan.size, plan.softSize)) return no('unsupported');
    for (const b of plan.builds) {
      // (the state it will be shown in, as far as the state's way now tells,
      // kept for all of its build: a state on the move would tear a keyframe
      // along its slices)
      if (b.c0 === b.key.box.c0) {
        // (as many of the last frame's moves as the clouds' clock has of them
        // to run to it: one long frame moved everything further, clock and all)
        const run = windOff + evo - this.skyPrevClock;
        this.skyState[b.key.slot] = stateAhead(s, this.skyPrev ?? s, run > 0 ? Math.max(0, (b.key.clock - windOff - evo) / run) : 0);
      }
      this.drawKeyframeSlice(gl, vb, b, this.skyState[b.key.slot] ?? s);
      // and as much of how it reshapes from the one before it as its built columns tell
      if (this.skyMorph[b.key.slot]) this.drawMorph(gl, b.key, b.prev, b.done);
    }
    this.skyPrev = stateAhead(s, s, 0);
    this.skyPrevClock = windOff + evo;
    if (!plan.show) return false;
    const { a, b, mix } = plan.show;
    this.drawComposite(gl, vc, a, b, mix, timeSec, s, camera, windOff, evo);
    if (kd !== kc) {
      const rects = parheliaRects(s, camera, w, h, evo);
      const vd = rects.length ? this.ensure(kd) : null;
      if (vd?.linked) {
        this.drawComposite(gl, vd, a, b, mix, timeSec, s, camera, windOff, evo, rects);
        this.current = vc;
      }
    }
    return true;
  }

  /** a frame composited from two keyframes, or these rectangles of one */
  private drawComposite(
    gl: WebGLRenderingContext, v: Variant, a: CacheKeyframe, b: CacheKeyframe, mix: number,
    timeSec: number, s: AtmosphereState, camera: Camera, windOff: number, evo: number,
    rects?: [number, number, number, number][],
  ): void {
    const w = this.canvas.width, h = this.canvas.height;
    this.bind(v, timeSec, s, windOff, evo);
    const u = this.u;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.skyTex[a.slot]);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.skyTex[b.slot]);
    // their motion (without it — no second target on this context — the
    // composite reads nothing to move and mixes them as they stand)
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.skyFlow[a.slot]);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.skyFlow[b.slot]);
    gl.activeTexture(gl.TEXTURE7);
    // (nothing to go along from the soft map, whose reads then all come back zero)
    gl.bindTexture(gl.TEXTURE_2D, a.slot === SOFT_SLOT ? null : this.skyMorph[b.slot]);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform4f(u.u_map0, a.rect.azC, a.rect.el0, a.rect.azSpan, a.rect.elSpan);
    gl.uniform4f(u.u_map1, b.rect.azC, b.rect.el0, b.rect.azSpan, b.rect.elSpan);
    gl.uniform1f(u.u_mapMix, mix);
    // the wind run since the first keyframe's moment and still to run to the
    // second's: the frame's own wind against each one's
    gl.uniform2f(u.u_mapWind, windOff - a.clocks.wind, b.clocks.wind - windOff);
    // the texels each holds, as directions, a texel and a half in from its
    // edge: the moved reads are held inside, with room for the cubic's reach
    gl.uniform4f(u.u_mapTexels, a.size[0], a.size[1], b.size[0], b.size[1]);
    const box = (k: typeof a): [number, number, number, number] => {
      const c = k.cover, f = (x: number) => Math.max(-1e4, Math.min(1e4, x));
      const iAz = 1.5 * k.rect.azSpan / k.size[0], iEl = 1.5 * k.rect.elSpan / k.size[1];
      return [f(c.azLo + iAz), f(c.azHi - iAz), f(c.elLo + iEl), f(c.elHi - iEl)];
    };
    gl.uniform4f(u.u_box0, ...box(a));
    gl.uniform4f(u.u_box1, ...box(b));
    gl.uniform1f(u.u_xfade, 0);
    gl.uniform1f(u.u_aspect, w / Math.max(1, h));
    gl.uniform3f(u.u_cam, camera.yaw, camera.pitch, camera.fov);
    gl.uniform4f(u.u_frame, 0, 0, w, h);
    gl.uniform1f(u.u_p3, this.p3 ? 1 : 0);
    gl.uniform1f(u.u_lensDrops, s.lens.droplets);
    gl.uniform2f(u.u_lensFx, s.lens.flare, s.lens.vignette);
    if (rects) this.drawRects(gl, rects);
    else gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * A slice of columns of a keyframe, drawn for the clocks it will be shown
   * at. The scissor keeps the draw to the slice; the viewport and u_frame
   * stay the whole map, so every texel's direction is the map's own
   */
  private drawKeyframeSlice(gl: WebGLRenderingContext, v: Variant, build: CacheBuild, s: AtmosphereState): void {
    const { key, c0, c1, step } = build;
    const [W, H] = key.size;
    this.bind(v, key.clocks.time, s, key.clocks.wind, key.clocks.evo);
    const u = this.u;
    // no slot (nor its motion) may sit on a unit while one of them is drawn into
    for (const unit of [gl.TEXTURE1, gl.TEXTURE4, gl.TEXTURE5, gl.TEXTURE6, gl.TEXTURE7]) {
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    // (the sheets' crawl with evolution, in units of wind: see MV_STRAT)
    gl.uniform1f(u.u_evoPerWind, build.evoPerWind);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.skyFbo[key.slot]);
    gl.viewport(0, 0, W, H);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(c0, key.box.r0, c1 - c0, key.box.r1 - key.box.r0);
    gl.uniform4f(u.u_frame, 0, 0, W, H);
    gl.uniform4f(u.u_map0, key.rect.azC, key.rect.el0, key.rect.azSpan, key.rect.elSpan);
    gl.uniform3f(u.u_mapStep, step[0], step[1], key.viewPx);
    gl.uniform1f(u.u_xfade, 0);
    gl.uniform1f(u.u_aspect, 1);
    gl.uniform1f(u.u_lensDrops, 0);
    gl.uniform1f(u.u_p3, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * A keyframe's morph from the one before it (MORPH_FRAG), into its slot's
   * quarter-size target: as its columns are built, the morph's columns whose
   * reads they hold (a window reaches five texels round), and the rest once
   * it is whole — spread over its build as the build is, rather than a whole
   * keyframe's search in one frame. With no keyframe before it (the first of
   * a run) there is nothing to find, and the target is cleared: nothing moves
   */
  private drawMorph(gl: WebGLRenderingContext, key: CacheKeyframe, prev: CacheKeyframe | null, done: boolean): void {
    const fbo = this.skyMorphFbo[key.slot];
    if (!fbo) return;
    const [W, H] = this.skySize;
    const w = Math.ceil(W / 4), h = Math.ceil(H / 4);
    // the morph's columns to find this frame: from where it stands to as far
    // as the built columns hold every read
    const m0 = Math.max(key.morphed, Math.floor(key.box.c0 / 4) - 1, 0);
    const m1 = Math.min(w, done ? Math.ceil(key.box.c1 / 4) + 1 : Math.floor((key.box.c0 + key.built - 10) / 4));
    if (m1 <= m0) return;
    key.morphed = m1;
    const y0 = Math.max(0, Math.floor(key.box.r0 / 4) - 1), y1 = Math.min(h, Math.ceil(key.box.r1 / 4) + 1);
    const p = prev ? this.morphProgram(gl) : null;
    // no target may sit on a unit while it is drawn into
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(m0, y0, m1 - m0, y1 - y0);
    if (!p || !prev) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      gl.useProgram(p.program);
      const u = p.u;
      const units: [number, WebGLTexture | null][] = [
        [gl.TEXTURE1, this.skyTex[prev.slot]], [gl.TEXTURE4, this.skyTex[key.slot]],
        [gl.TEXTURE5, this.skyFlow[prev.slot]], [gl.TEXTURE6, this.skyFlow[key.slot]],
      ];
      for (const [unit, tex] of units) { gl.activeTexture(unit); gl.bindTexture(gl.TEXTURE_2D, tex); }
      gl.activeTexture(gl.TEXTURE0);
      const r = (k: CacheKeyframe): [number, number, number, number] => [k.rect.azC, k.rect.el0, k.rect.azSpan, k.rect.elSpan];
      gl.uniform4f(u.u_mapA, ...r(prev));
      gl.uniform4f(u.u_mapB, ...r(key));
      // the earlier's reads held inside the texels it holds (as the
      // composite's are), the later's inside its own, as texel coordinates
      const c = prev.cover, f = (x: number) => Math.max(-1e4, Math.min(1e4, x));
      const iAz = 1.5 * prev.rect.azSpan / W, iEl = 1.5 * prev.rect.elSpan / H;
      gl.uniform4f(u.u_boxA, f(c.azLo + iAz), f(c.azHi - iAz), f(c.elLo + iEl), f(c.elHi - iEl));
      gl.uniform4f(u.u_boxB, (key.box.c0 + 0.5) / W, (key.box.c1 - 0.5) / W, (key.box.r0 + 0.5) / H, (key.box.r1 - 0.5) / H);
      gl.uniform2f(u.u_texels, W, H);
      gl.uniform2f(u.u_out, w, h);
      gl.uniform1f(u.u_dw, key.clocks.wind - prev.clocks.wind);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      for (const [unit] of units) { gl.activeTexture(unit); gl.bindTexture(gl.TEXTURE_2D, null); }
      // (the next draw binds its own program again: see bind)
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** MORPH_FRAG's program; null where it will not compile, and while it does, not waited for (a keyframe's morph is then left clear) */
  private morphProgram(gl: WebGLRenderingContext): { program: WebGLProgram; u: Uniforms } | null {
    if (this.morph) return this.morph;
    if (this.morphFailed) return null;
    if (!this.morphLink) {
      const compile = (type: number, src: string): WebGLShader | null => {
        const sh = gl.createShader(type);
        if (!sh) return null;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return sh;
      };
      const vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, MORPH_FRAG);
      const program = vs && fs ? gl.createProgram() : null;
      if (vs && fs && program) {
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.bindAttribLocation(program, 0, 'a_pos');
        gl.linkProgram(program);
      }
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      if (!program) { this.morphFailed = true; return null; }
      this.morphLink = program;
    }
    const program = this.morphLink;
    if (this.parallel && !gl.getProgramParameter(program, this.parallel.COMPLETION_STATUS_KHR)) return null;
    this.morphLink = null;
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('atmosphere morph shader link error:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      this.morphFailed = true;
      return null;
    }
    gl.useProgram(program);
    const u: Uniforms = {};
    for (const n of ['u_ka', 'u_kb', 'u_fa', 'u_fb', 'u_mapA', 'u_mapB', 'u_boxA', 'u_boxB', 'u_texels', 'u_out', 'u_dw']) u[n] = gl.getUniformLocation(program, n);
    gl.uniform1i(u.u_ka, 1);
    gl.uniform1i(u.u_kb, 4);
    gl.uniform1i(u.u_fa, 5);
    gl.uniform1i(u.u_fb, 6);
    this.morph = { program, u };
    return this.morph;
  }

  /**
   * The sky cache's three keyframe slots and its soft map, half-float, (re)made to size.
   * false — and the cache stays off for this context — where half floats
   * cannot be rendered to and filtered
   */
  private skyTargets(gl: WebGLRenderingContext, size: [number, number], softSize: [number, number]): boolean {
    if (this.skySupport === false) return false;
    if (this.skyFbo[0] && this.skySize[0] === size[0] && this.skySize[1] === size[1]) return true;
    const hf = gl.getExtension('OES_texture_half_float');
    const hfLinear = gl.getExtension('OES_texture_half_float_linear');
    gl.getExtension('EXT_color_buffer_half_float');
    if (!hf || !hfLinear) { this.skySupport = false; return false; }
    const mk = (w = size[0], h = size[1]): WebGLTexture | null => {
      const tex = gl.createTexture();
      if (!tex) return null;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, hf.HALF_FLOAT_OES, null);
      // NPOT: clamped, and no mips — the composite reads it bilinear, and
      // the seam's spare texels stand in for a repeat
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
      return tex;
    };
    // The motion is a second target of the same half-float RGBA (a draw into
    // two must draw into alike: an 8-bit second is FRAMEBUFFER_UNSUPPORTED
    // on Metal), twice the slots' memory
    const db = this.skyDraw;
    this.freeSky(gl);
    let ok = true;
    for (let i = 0; i < 4 && ok; i++) {
      const [w, h] = i === SOFT_SLOT ? softSize : size;
      const tex = mk(w, h), flow = db ? mk(w, h) : null, fbo = gl.createFramebuffer();
      this.skyTex[i] = tex;
      this.skyFlow[i] = flow;
      this.skyFbo[i] = fbo;
      if (!tex || !fbo || (db && !flow)) { ok = false; break; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (db && flow) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, db.COLOR_ATTACHMENT1_WEBGL, gl.TEXTURE_2D, flow, 0);
        db.drawBuffersWEBGL([db.COLOR_ATTACHMENT0_WEBGL, db.COLOR_ATTACHMENT1_WEBGL]);
      }
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      if (ok && db && i !== SOFT_SLOT) {
        // and its morph (MORPH_FRAG), a quarter the size each way, cleared:
        // until one is found, nothing moves
        const m = mk(Math.ceil(size[0] / 4), Math.ceil(size[1] / 4)), mf = gl.createFramebuffer();
        this.skyMorph[i] = m;
        this.skyMorphFbo[i] = mf;
        if (!m || !mf) ok = false;
        else {
          gl.bindFramebuffer(gl.FRAMEBUFFER, mf);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, m, 0);
          ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
          if (ok) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    // (a context out of memory for all this says so here, and goes on drawing directly)
    if (!ok || gl.getError() === gl.OUT_OF_MEMORY) {
      this.freeSky(gl);
      this.skySupport = false;
      return false;
    }
    this.skySupport = true;
    this.skySize = [size[0], size[1]];
    this.sky!.layers = db ? 2 : 1;
    // (its program's compile started now, not on the frame that first wants it)
    if (db) this.morphProgram(gl);
    return true;
  }

  private freeSky(gl: WebGLRenderingContext): void {
    for (let i = 0; i < 4; i++) {
      if (this.skyFbo[i]) gl.deleteFramebuffer(this.skyFbo[i]);
      if (this.skyTex[i]) gl.deleteTexture(this.skyTex[i]);
      if (this.skyFlow[i]) gl.deleteTexture(this.skyFlow[i]);
      if (this.skyMorph[i]) gl.deleteTexture(this.skyMorph[i]);
      if (this.skyMorphFbo[i]) gl.deleteFramebuffer(this.skyMorphFbo[i]);
      this.skyFbo[i] = null;
      this.skyTex[i] = null;
      this.skyFlow[i] = null;
      this.skyMorph[i] = null;
      this.skyMorphFbo[i] = null;
    }
    this.skySize = [0, 0];
  }


  /**
   * The variants this frame is drawn with, and the share each is laid over
   * the one before at: one, whole — or under 'auto' inside the band, the 2D
   * tower's and over it the volumetric one's, the crossfade (featureKeys).
   * Two only once both can draw (linked, or stood in for by a variant with
   * the same tower): while one of them links, the other draws alone, whole,
   * rather than a tower faded halfway into nothing. null: nothing yet
   */
  private passes(s: AtmosphereState, camera?: Camera, aspect = 1): { v: Variant; share: number }[] | null {
    if (!this.gl || this.lost) return null;
    const ks = this.keysFor(s, camera, aspect);
    // (the parhelia are drawn on their own over the frame: see drawParhelia)
    if (ks.length === 1 && this.parheliaApart(s)) ks[0].key &= ~FEATURE.PARHELIA;
    // (a view that leaves the light from behind out has the variants that
    // carry it compiling behind it, for when it turns toward the sun: drawn
    // for this view while they link, they draw the same picture, but the
    // other way round a frame would wait on them — see backlitInView)
    if (camera && this.parallel) {
      const whole = this.keysFor(s);
      whole.forEach((k, i) => { if (k.key !== ks[i]?.key) this.ensureLater(k.key); });
    }
    if (ks.length === 1) {
      this.wantedVol = -1;
      const v = this.pick(ks[0].key);
      return v ? this.firstPaintFade(v) ?? [{ v, share: 1 }] : null;
    }
    const [a, b] = ks;
    this.wantedVol = b.key;
    const ready = (key: number): Variant | null => {
      const v = this.ensure(key);
      return v?.linked ? v : this.standIn(key);
    };
    const va = ready(a.key), vb = ready(b.key);
    // (wanted: the tower with the larger share, which is what a frame drawn
    // with one alone would take — and what says ready)
    this.wanted = b.share >= 0.5 ? b.key : a.key;
    if (va && vb) return [{ v: va, share: 1 }, { v: vb, share: b.share }];
    const v = va ?? vb ?? this.pick(this.wanted);
    return v ? [{ v, share: 1 }] : null;
  }

  /**
   * The tower coming in over the first paint, once its program has landed:
   * the sky's own frame laid over the first-paint one at a share that climbs,
   * through the 'auto' crossfade's own draw. Null when there is nothing to fade
   * — and for a still frame, which is drawn once and would stay at the start of
   * the fade: only a frame following closely on the last one starts it.
   */
  private firstPaintFade(v: Variant): { v: Variant; share: number }[] | null {
    const now = performance.now();
    const follows = now - this.lastFrame < FIRST_PAINT_FADE_GAP_MS;
    this.lastFrame = now;
    const from = this.variants.get(this.firstPaint);
    if (!from?.linked || v === from || !(v.key & FEATURE.CB)) return null;
    if (!this.fadeBegan) {
      if (this.current !== from || !follows) return null;
      this.fadeBegan = now;
    }
    const share = (now - this.fadeBegan) / FIRST_PAINT_FADE_MS;
    if (share >= 1) { this.fadeBegan = 0; this.firstPaint = -1; return null; }
    // (0 is not a share to the shader: it reads as no crossfade at all)
    return [{ v: from, share: 1 }, { v, share: Math.max(0.001, share) }];
  }

  /**
   * One frame drawn with one variant: laid over what the canvas holds at
   * `share` (the second tower of a crossfade), or over nothing at 1. Returns
   * the cloud mode it was drawn in. `again`: only these parts of a frame just
   * drawn in that mode, whose cloud stack still stands
   */
  private drawFrame(
    gl: WebGLRenderingContext, v: Variant, share: number,
    timeSec: number, s: AtmosphereState, camera: Camera, windOff: number, evo: number,
    again?: { rects: [number, number, number, number][]; mode: number },
  ): number {
    this.bind(v, timeSec, s, windOff, evo);
    const u = this.u;
    const w = this.canvas.width, h = this.canvas.height;
    // (the crossfade's second draw leaves alone whatever it would only
    // repeat of the first: see cbXfadeSkip in the shader)
    gl.uniform1f(u.u_xfade, share < 1 ? share : 0);
    gl.uniform1f(u.u_aspect, w / Math.max(1, h));
    gl.uniform3f(u.u_cam, camera.yaw, camera.pitch, camera.fov);

    // the cloud stack on its own, at its own resolution (mode 1), then the
    // frame with that stack laid in (mode 2) — or the frame in one pass (mode
    // 0), which is also what a cloudless frame takes: the same picture, and
    // none of the split's two extra steps
    let mode = again ? again.mode : 0;
    const scale = this.cloudScale;
    // the rays are read off the cloud stack's target, so they too want the
    // split (and only the split program can: a one-pass one standing in
    // while it links draws the frame whole)
    if (!again && (scale < 1 || this.rays > 0) && hasCloudStack(s.clouds) && (v.key & SPLIT_KEY)) {
      const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      if (this.cloudTarget(gl, cw, ch)) {
        // the target's texture must not sit on a unit the program samples
        // while it is being drawn into, or the draw is a feedback loop
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.cloudFbo);
        gl.viewport(0, 0, cw, ch);
        gl.uniform4f(u.u_frame, 0, 0, cw, ch);
        gl.uniform1f(u.u_cloudMode, 1);
        // the stack is drawn for the undistorted rays; the composite reads it
        // back wherever a droplet has bent each pixel's ray
        gl.uniform1f(u.u_lensDrops, 0);
        gl.uniform1f(u.u_p3, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, w, h);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.cloudTex);
        gl.activeTexture(gl.TEXTURE0);
        mode = 2;
      }
    }

    gl.uniform4f(u.u_frame, 0, 0, w, h);
    gl.uniform1f(u.u_cloudMode, mode);
    gl.uniform1f(u.u_p3, this.p3 ? 1 : 0);
    gl.uniform1f(u.u_lensDrops, s.lens.droplets);
    gl.uniform2f(u.u_lensFx, s.lens.flare, s.lens.vignette);
    // (only the frame itself is laid over the last: the cloud stack's own
    // pass above replaces its target's contents, as it always does)
    if (share < 1) this.blendOver(gl);
    if (again) this.drawRects(gl, again.rects);
    else gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (share < 1) gl.disable(gl.BLEND);
    return mode;
  }

  /** the frame's triangle, only inside these rectangles */
  private drawRects(gl: WebGLRenderingContext, rects: [number, number, number, number][]): void {
    gl.enable(gl.SCISSOR_TEST);
    for (const [x, y, w, h] of rects) {
      gl.scissor(x, y, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  /**
   * draw the next draws over what the target holds at their share: a
   * straight mix of the two pictures, each already toned and encoded — the
   * two are the same sky but for the tower, so it is the tower alone that
   * fades. The share is the alpha the volumetric variant writes (u_xfade),
   * 0 where it leaves the first draw's pixel as it is (cbXfadeSkip); the
   * target's own alpha is kept
   */
  private blendOver(gl: WebGLRenderingContext): void {
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
  }

  /** start a timer query for this frame, if timing is on and not too many are in flight */
  private beginTiming(pixels: number): WebGLQuery | null {
    const t = this.timer;
    if (!t) return null;
    this.harvestTimes();
    // a GPU that falls this far behind is reporting late anyway; skip a frame
    if (this.pending.length >= 8) return null;
    const q = t.createQueryEXT();
    if (!q) return null;
    t.beginQueryEXT(t.TIME_ELAPSED_EXT, q);
    this.pending.push({ q, pixels });
    return q;
  }

  /** move finished timer queries into gpuTimes, oldest first */
  private harvestTimes(): void {
    const t = this.timer, gl = this.gl;
    if (!t || !gl) return;
    // a disjoint event makes every query in flight meaningless
    if (gl.getParameter(t.GPU_DISJOINT_EXT)) {
      for (const p of this.pending) t.deleteQueryEXT(p.q);
      this.pending = [];
      return;
    }
    while (this.pending.length) {
      const p = this.pending[0];
      if (!t.getQueryObjectEXT(p.q, t.QUERY_RESULT_AVAILABLE_EXT)) break;
      const ns = t.getQueryObjectEXT(p.q, t.QUERY_RESULT_EXT) as number;
      t.deleteQueryEXT(p.q);
      this.pending.shift();
      this.gpuTimes.push({ ms: ns / 1e6, pixels: p.pixels });
    }
    // nobody is reading: keep only the recent past
    if (this.gpuTimes.length > 120) this.gpuTimes.splice(0, this.gpuTimes.length - 120);
  }

  /**
   * The cloud stack's half-float target, (re)made to size. false — and
   * cloudScale falls back to 1 for this context — where half floats cannot be
   * rendered to and filtered.
   */
  private cloudTarget(gl: WebGLRenderingContext, w: number, h: number): boolean {
    if (this.cloudSupport === false) return false;
    if (this.cloudFbo && this.cloudSize[0] === w && this.cloudSize[1] === h) return true;
    const hf = gl.getExtension('OES_texture_half_float');
    // the composite upsamples with the sampler's bilinear filter
    const hfLinear = gl.getExtension('OES_texture_half_float_linear');
    gl.getExtension('EXT_color_buffer_half_float');
    if (!hf || !hfLinear) { this.cloudSupport = false; return false; }
    this.freeClouds(gl);
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) { this.cloudSupport = false; return false; }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // half float, not 8-bit: what the stack adds runs past 1.0 where lightning
    // lights a cloud from inside, and 8 bits would clip it
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, hf.HALF_FLOAT_OES, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.cloudTex = tex;
    this.cloudFbo = fbo;
    if (!ok) { this.freeClouds(gl); this.cloudSupport = false; return false; }
    this.cloudSupport = true;
    this.cloudSize = [w, h];
    return true;
  }

  private freeClouds(gl: WebGLRenderingContext): void {
    if (this.cloudFbo) gl.deleteFramebuffer(this.cloudFbo);
    if (this.cloudTex) gl.deleteTexture(this.cloudTex);
    this.cloudFbo = null;
    this.cloudTex = null;
    this.cloudSize = [0, 0];
  }

  /**
   * Measure the sky's light: draw the same frame, tiny, into an offscreen
   * buffer — plus six cube faces for the dome all around — and read it back.
   *
   * For lighting whatever stands in front of the sky; see light.ts. The frame
   * is drawn exactly as {@link render} would draw it for this camera and the
   * canvas's current aspect, lens effects included, since light wrap wants
   * what is actually behind the foreground. The cube faces leave the lens out:
   * a flare or a vignette is not light in the scene.
   *
   * Always sRGB, whatever the drawing buffer is. The canvas is untouched.
   *
   * **This synchronizes with the GPU** — readPixels waits for the draw to
   * finish — so it is not free the way render() is. The draws themselves are
   * a few thousand pixels against the frame's million or so; the cost is the
   * wait. Call it at a few hertz rather than every frame (Atmosphere's
   * `lightProbe` option does that and smooths the series), and before
   * render() in a frame rather than after, so it waits only on its own draws.
   *
   * @returns null until the shader is ready (or when WebGL is unavailable)
   */
  probe(
    timeSec: number,
    s: AtmosphereState,
    camera: Camera = DEFAULT_CAMERA,
    windOff = 0,
    evo = 0,
    options: ProbeOptions = {},
  ): LightMeasurement | null {
    const [cols, rows] = options.grid ?? [8, 6];
    const layout = probeLayout(cols, rows, options.environment ?? true);
    // (the cube faces look all round, the light from behind included)
    const passes = this.passes(s, layout.environment ? undefined : camera,
      this.canvas.width / Math.max(1, this.canvas.height));
    const gl = this.gl;
    if (!passes || !gl || !this.probeTarget(gl, layout)) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeFbo);
    // (crossfaded inside the band as the frame is, every draw of the second)
    passes.forEach((p, i) => {
      if (i > 0) this.blendOver(gl);
      this.drawProbe(gl, p.v, layout, timeSec, s, camera, windOff, evo, i > 0 ? p.share : 0);
      if (i > 0) gl.disable(gl.BLEND);
    });
    const px = this.probePixels!;
    gl.readPixels(0, 0, layout.width, layout.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    return summarizeProbe(px, layout);
  }

  /** the probe's draws with one variant, into its bound target */
  private drawProbe(
    gl: WebGLRenderingContext, v: Variant, layout: ProbeLayout,
    timeSec: number, s: AtmosphereState, camera: Camera, windOff: number, evo: number,
    xfade = 0,
  ): void {
    this.bind(v, timeSec, s, windOff, evo);
    const u = this.u;
    gl.uniform1f(u.u_xfade, xfade);
    // sRGB regardless of the canvas: these numbers leave the GPU for someone
    // else's pipeline, and sRGB is the one every consumer assumes
    gl.uniform1f(u.u_p3, 0);

    const fw = layout.cols * PROBE_SUB, fh = layout.frameHeight;
    gl.viewport(0, 0, fw, fh);
    gl.uniform4f(u.u_frame, 0, 0, fw, fh);
    gl.uniform1f(u.u_aspect, this.canvas.width / Math.max(1, this.canvas.height));
    gl.uniform3f(u.u_cam, camera.yaw, camera.pitch, camera.fov);
    gl.uniform1f(u.u_lensDrops, s.lens.droplets);
    gl.uniform2f(u.u_lensFx, s.lens.flare, s.lens.vignette);
    // one pass: at a few dozen pixels there is nothing to save by splitting
    gl.uniform1f(u.u_cloudMode, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (layout.environment) {
      gl.uniform1f(u.u_aspect, 1);
      gl.uniform1f(u.u_lensDrops, 0);
      gl.uniform2f(u.u_lensFx, 0, 0);
      CUBE_FACE_CAMERAS.forEach((face, i) => {
        gl.viewport(i * PROBE_FACE, fh, PROBE_FACE, PROBE_FACE);
        gl.uniform4f(u.u_frame, i * PROBE_FACE, fh, PROBE_FACE, PROBE_FACE);
        gl.uniform3f(u.u_cam, face.yaw, face.pitch, face.fov);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      });
    }
  }

  /**
   * Make a variant's program current and upload everything that follows the
   * state — the part render() and probe() share
   */
  private bind(v: Variant, timeSec: number, s: AtmosphereState, windOff: number, evo: number): void {
    const gl = this.gl!;
    this.current = v;
    v.used = ++this.frame;
    this.u = v.u;
    // bind every frame rather than only at init: another renderer sharing this
    // canvas (or anything else touching the context) may have swapped programs
    gl.useProgram(v.program);
    this.updateTurrets(gl, s, evo);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.noiseQ);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.noise);
    const u = this.u;
    gl.uniform1f(u.u_time, timeSec % TIME_WRAP_SEC);
    gl.uniform3f(u.u_snowDrift, this.snowDrift[0], this.snowDrift[1], this.snowDrift[2]);
    gl.uniform2f(u.u_sun, s.sunElevation, s.sunAzimuth);
    // The moon's third number is how much light it gives, not its shape: a
    // moon in the Earth's shadow lights the clouds, its halo and the sea a
    // tenth as much as the same moon outside it. Everything that is lit by
    // the moon reads it from here; the disc itself takes its phase back out
    const eclipse = Math.min(Math.max(s.moonEclipse ?? 0, 0), 1);
    gl.uniform3f(u.u_moon, s.moonElevation, s.moonAzimuth, s.moonPhase * (1 - 0.9 * eclipse));
    gl.uniform1f(u.u_moonEclipse, eclipse);
    const c = s.clouds;
    gl.uniform1f(u.u_cover, s.cloudCover);
    gl.uniform3f(u.u_high, c.cirrus, c.cirrostratus, c.cirrocumulus);
    {
      const [red, width] = parheliaShape(s.sunElevation), [lesser, greater] = parheliaAmounts(s, evo);
      gl.uniform4f(u.u_parhelia, red, width, lesser, greater);
    }
    gl.uniform3f(u.u_mid, c.altostratus, c.altocumulus, c.nimbostratus);
    gl.uniform4f(u.u_low, c.stratus, c.stratocumulus, c.cumulus, c.cumulonimbus);
    gl.uniform1f(u.u_rain, s.rain);
    gl.uniform1f(u.u_snow, s.snow);
    gl.uniform1f(u.u_fall, s.particles.precipitation);
    gl.uniform2f(u.u_sea, s.ground.sea, s.ground.swell);
    gl.uniform2f(u.u_sunset, s.sunset.warmth, s.sunset.glow);
    {
      const [sky, sea, limb] = sunShape(s.sun.disc);
      gl.uniform4f(u.u_sunLook, sky, sea, s.sun.glare, limb);
    }
    gl.uniform1f(u.u_wind, s.wind);
    gl.uniform1f(u.u_thunder, s.thunder);
    gl.uniform1f(u.u_haze, s.haze);
    gl.uniform1f(u.u_lent, s.features.lenticular);
    gl.uniform4f(u.u_cbFeat, s.features.anvil, s.features.velum, s.features.distance, s.features.softness);
    gl.uniform1f(u.u_windOff, windOff);
    gl.uniform1f(u.u_evo, evo);
    gl.uniform1f(u.u_filtAmt, s.filter.amount);
    gl.uniform3f(u.u_filtTint, s.filter.tint[0], s.filter.tint[1], s.filter.tint[2]);
    gl.uniform1f(u.u_filtSat, s.filter.saturation);
    gl.uniform1f(u.u_filtLift, s.filter.lift);
    gl.uniform1f(u.u_headroom, Math.max(1, this.opts.headroom ?? 1));
    const t = s.tone;
    gl.uniform4f(u.u_tone, t.exposure, t.contrast, t.knee, t.bleach);
    const pz = s.polarizer;
    gl.uniform4f(u.u_pol, pz.strength, pz.angle, pz.saturation, pz.stopLoss);
    const ce = s.celestial;
    gl.uniform4f(u.u_sky, ce.bortle, ce.milkyWay, ce.meteors, ce.radiant ? 1 : 0);
    gl.uniform2f(u.u_radiant, ce.radiant?.[0] ?? 0, ce.radiant?.[1] ?? 0);
    gl.uniform1f(u.u_aurora, ce.aurora);
    gl.uniform1f(u.u_contrails, s.particles.contrails);
    gl.uniform1f(u.u_rays, this.rays);
  }

  /** the probe's framebuffer, (re)made to fit the layout. false if the driver refuses it */
  private probeTarget(gl: WebGLRenderingContext, layout: ProbeLayout): boolean {
    if (this.probeFbo && this.probeSize[0] === layout.width && this.probeSize[1] === layout.height) {
      return true;
    }
    this.freeProbe(gl);
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) return false;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, layout.width, layout.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null);
    // NPOT in WebGL1: clamp and no mipmaps, or the texture is incomplete
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // unit 0 is the noise lattice's, and the draw that follows expects it bound there
    gl.bindTexture(gl.TEXTURE_2D, this.noise);
    this.probeTex = tex;
    this.probeFbo = fbo;
    if (!ok) { this.freeProbe(gl); return false; }
    this.probeSize = [layout.width, layout.height];
    this.probePixels = new Uint8Array(layout.width * layout.height * 4);
    return true;
  }

  private freeProbe(gl: WebGLRenderingContext): void {
    if (this.probeFbo) gl.deleteFramebuffer(this.probeFbo);
    if (this.probeTex) gl.deleteTexture(this.probeTex);
    this.probeFbo = null;
    this.probeTex = null;
    this.probeSize = [0, 0];
  }

  /**
   * Release GPU resources.
   *
   * @param options.loseContext
   *   Force the WebGL context itself to be released. Off by default: the same
   *   canvas usually gets reused across remounts (React StrictMode runs
   *   effects twice, and getContext would otherwise come back in a lost
   *   state). Turn it on for a throwaway canvas — e.g. an offscreen one used
   *   to bake a cubemap. Browsers cap how many contexts can be alive at once
   *   and evict the oldest, so leaking throwaway contexts eventually kills
   *   the live renderer's own context.
   */
  dispose(options: { loseContext?: boolean } = {}): void {
    const gl = this.gl;
    this.stopPolling();
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (gl) {
      for (const v of this.variants.values()) if (!v.failed) gl.deleteProgram(v.program);
      if (this.buffer) gl.deleteBuffer(this.buffer);
      if (this.noise) gl.deleteTexture(this.noise);
      if (this.noiseQ) gl.deleteTexture(this.noiseQ);
      if (this.turrets) gl.deleteTexture(this.turrets);
      this.freeProbe(gl);
      this.freeClouds(gl);
      this.freeSky(gl);
      if (this.morph) gl.deleteProgram(this.morph.program);
      if (this.morphLink) gl.deleteProgram(this.morphLink);
      for (const p of this.pending) this.timer?.deleteQueryEXT(p.q);
      this.pending = [];
      if (options.loseContext) {
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    }
    this.gl = null;
    this.variants = new Map();
    this.current = null;
    this.buffer = null;
    this.noise = null;
    this.noiseQ = null;
    this.turrets = null;
    this.morph = null;
  }
}
