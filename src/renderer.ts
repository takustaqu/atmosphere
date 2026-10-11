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
// Dev note: swapping this module out via HMR leaves an already-mounted
// AtmosphereRenderer running the old shader. Reload the page to see changes.

import { CLOUD_GENERA_IDS, type CloudMix } from './clouds.js';
import { SRGB_TO_DISPLAY_P3, glslMat3, type ColorSpaceOption } from './gamut.js';
import {
  PROBE_FACE, PROBE_SUB, probeLayout, summarizeProbe,
  type LightMeasurement, type ProbeLayout,
} from './light.js';
import { NOISE_SIZE, noiseLattice } from './noise.js';
import { CUBE_FACE_CAMERAS, DEFAULT_CAMERA, type AtmosphereState, type Camera } from './state.js';

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

/**
 * How far the marked light sources reach past sRGB. 0 disables the widening,
 * making the Display P3 path appearance-identical to the sRGB one; 1 is the
 * naive "just flip the flag" over-saturation. Per-part strengths are folded
 * into `wide` at each site in main(), so this is the single global trim.
 *
 * **Held at 0 deliberately, on measurement.** The widening does not work on this
 * palette, and the reason is structural: sRGB and Display P3 share the same blue
 * primary, so P3's extra room is entirely in red and green — and a sky renderer
 * is blue-dominated. Its one warm color (`warm`, at magic hour) composites down
 * to a desaturated salmon that sits nowhere near a gamut boundary. Measured
 * against a two-space readback diff: at reach 1 the widened pixels land only
 * 0.7–1.5% outside sRGB and magic hour never leaves sRGB at all; pushing to
 * reach 6 changes the color a lot (16.8/255 across 46% of the frame) while the
 * excursion stays at ~1%. It distorts hue inside sRGB rather than reaching past
 * it, which is the opposite of the point.
 *
 * The conversion below is still worth having on its own: it is exactly
 * appearance-preserving, and highlights that run past 1.0 (the sun's core, a
 * lightning flash) clip later in P3, so a little more of the blowout survives.
 *
 * Raising this only pays off after the palette itself is re-tuned for P3.
 */
const GAMUT_REACH = 0.0;

const FRAG = `
// highp is optional for fragment shaders in WebGL1. Without this guard the
// shader fails to compile outright on older mobile GPUs, and the sky silently
// disappears (available === false). Banding gets worse at mediump, but a
// degraded sky beats no sky.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
precision highp sampler2D;
#else
precision mediump float;
precision mediump sampler2D;
#endif

// The sampler's precision is what carries vnoise's interpolation, not the
// texel's: at the default lowp a filtered fetch comes back in ~1/128 steps and
// every cloud edge terraces. The texels themselves are only 8-bit endpoints.
uniform sampler2D u_noise;   // the baked value-noise lattice — see noise.ts

uniform vec4  u_frame;     // the viewport being drawn: origin xy, size zw (pixels)
uniform float u_aspect;    // width / height of the picture this viewport stands for
uniform float u_time;      // seconds
uniform vec3  u_cam;       // yaw, pitch, fov (radians)
uniform vec2  u_sun;       // sun's elevation, azimuth (radians)
uniform vec3  u_moon;      // moon's elevation, azimuth (radians), and the lit fraction of its disc
uniform float u_cover;     // 0..1 total occlusion (accumulated from the cloud-genus mix)
uniform vec3  u_high;      // amount of the ten cloud genera: cirrus Ci, cirrostratus Cs, cirrocumulus Cc
uniform vec3  u_mid;       //                                 altostratus As, altocumulus Ac, nimbostratus Ns
uniform vec4  u_low;       //                                 stratus St, stratocumulus Sc, cumulus Cu, cumulonimbus Cb
uniform float u_rain;      // 0..1 rain
uniform float u_snow;      // 0..1 snow
uniform float u_wind;      // 0..1 wind
uniform float u_thunder;   // 0..1 thunder
uniform float u_haze;      // 0..1 haze
uniform vec2  u_cbFeat;    // cumulonimbus companion forms: anvil, veil
uniform float u_windOff;   // wind's integrated offset (speed×dt accumulated on the CPU side)
uniform float u_evo;       // shape evolution's integrated offset (same idea)
uniform float u_filtAmt;   // color filter: strength
uniform vec3  u_filtTint;  //               white point
uniform float u_filtSat;   //               saturation kept
uniform float u_filtLift;  //               black lift
uniform float u_p3;        // 1 when the drawing buffer is Display P3, else 0
uniform float u_headroom;  // display ceiling in multiples of SDR white. 1 = SDR
uniform vec4  u_tone;      // tone curve: exposure (stops), contrast, knee, bleach
uniform vec4  u_pol;       // polarizer: strength, angle, saturation, stopLoss
uniform vec4  u_sky;       // celestial: bortle, milkyWay, meteors/hr, hasRadiant
uniform vec2  u_radiant;   // meteor radiant: elevation, azimuth (radians)
uniform float u_lensDrops; // 0..1 ceiling on the raindrops that collect on the lens
uniform float u_lensFx;    // 1 = draw the flare and vignette, 0 = the bare sky (environment probes)
uniform float u_fall;      // 0..1 ceiling on the falling rain streaks and snowflakes
uniform vec2  u_sea;       // ground: how much is open water, how much it heaves
uniform vec2  u_sunset;    // sunset: the warmth of the band on the sun's side, the glow all round
uniform float u_aurora;    // 0..1 how much aurora is in the sky
uniform float u_contrails; // 0..1 how often a jet draws a trail
uniform float u_rays;      // 0..1 crepuscular rays, in the split variant's composite
#ifdef CLOUD_SPLIT
uniform float u_cloudMode; // 0 = one pass, 1 = the cloud stack alone, 2 = composite it from u_clouds
uniform sampler2D u_clouds; // the cloud stack drawn by mode 1: rgb = what it adds, a = what it lets through
#endif

const float PI = 3.14159265;
// how many radians the default framing (fov 0.86) shows top to bottom, near
// the middle. The falling rain and snow were tuned in screen units at that
// framing; dividing by this re-expresses those scales per radian of view
const float FALL_REF = 0.88;

// ── Linear light ──
// Every color literal below is authored as an sRGB-encoded value (that is how
// they were hand-tuned), but compositing them in that space is wrong: mixing two
// gamma-encoded colors darkens the midpoint, and adding light is only additive in
// linear light. So each literal is decoded on the way in with L(), the whole
// composite runs in linear light, and the result is tone-mapped and re-encoded at
// the end.
//
// Two properties make this a small change rather than a rewrite:
//   - a mix()'s endpoints are preserved exactly; only midpoints move (that IS the fix)
//   - a multiplicative tint is exactly equivalent, since L(g*v) = L(g)*L(v) above
//     the knee — so every "* vec3(1.12, 0.92, 0.76)" style gain keeps its meaning
vec3 L(vec3 c) {
  c = max(c, 0.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 encodeSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

/**
 * An artistic overlay: a wash of the whole picture toward some color.
 *
 * Unlike adding light, this is not a physical process — it is a chosen
 * appearance, and every one of these was hand-tuned as a display-space blend. So
 * do the blend where it was authored and come back to linear. That keeps the
 * palette exactly as published while the additive light stays correct.
 */
vec3 overlay(vec3 lin, vec3 dispCol, float a) {
  return L(mix(encodeSrgb(lin), dispCol, a));
}

// How much light each source emits, in multiples of SDR white. Nowhere near
// physically right (the sun is ~10^5 SDR white); these are set to what reads
// correctly once the shoulder has them.
//
// SUN_LUM deliberately blooms wider than the pre-linear-light renderer did. That
// is not drift to be corrected — a sun you cannot look at is what the eye
// actually reports, and it was judged closer to perception than the old flat
// disc. Emission is the one place this pipeline is *meant* to depart from the
// published look; brightness that leaks in anywhere else is a bug.
//
// Raise u_headroom and this is the range they expand into.
const float SUN_LUM   = 12.0;
const float HALO_LUM  = 1.6;
const float FLASH_LUM = 6.0;
const float MOON_LUM  = 2.6;
const float STAR_LUM  = 2.5;
const float AURORA_LUM = 1.4;

/**
 * Linear scene light → display.
 *
 * Scene-referred, so every stage here means what it says: the exposure is a
 * multiply, the contrast pivots on 18% grey, and the highlights desaturate the way
 * film does. None of that was expressible while compositing ran on gamma-encoded
 * values.
 *
 * The shoulder is identity below u_tone.z, so at the default knee of 0.8 only
 * blown highlights are shaped and the published look is untouched. Bring the knee
 * down to put the curve through the midtones — that is where it becomes a look.
 * The same shoulder is what expands into u_headroom when there is HDR to expand
 * into, so a curve dialled in today stays the curve later.
 */
vec3 tonemap(vec3 c) {
  const float PIVOT = 0.18;   // 18% grey, the photographic anchor

  c = max(c, 0.0) * exp2(u_tone.x);

  if (abs(u_tone.y - 1.0) > 0.001) {
    c = PIVOT * pow(max(c / PIVOT, 1e-5), vec3(u_tone.y));
  }

  float knee = u_tone.z;

  // bleach: as a pixel climbs toward the ceiling, pull it toward its own peak
  // channel. Keeps brightness, drops hue — so a blown sky goes white instead of
  // clipping into a muddy cast
  if (u_tone.w > 0.001) {
    float peak = max(max(c.r, c.g), c.b);
    float t = clamp((peak - knee) / max(1.0 - knee, 1e-4), 0.0, 1.0);
    c = mix(c, vec3(peak), t * u_tone.w);
  }

  // x/(1+x) shoulder, rescaled to start with slope 1 at the knee and approach
  // the headroom as x grows
  vec3 hi = max(c - knee, 0.0);
  float span = max(u_headroom - knee, 1e-4);
  return min(c, knee) + span * (hi / (span + hi));
}

/**
 * Degree of polarization of Rayleigh-scattered skylight along this view ray.
 *
 * sin(theta)^2 / (1 + cos(theta)^2) for scattering angle theta — zero straight at
 * the sun and straight away from it, peaking in the band 90 degrees off. Capped
 * below 1 because multiple scattering, aerosols and ground bounce all depolarize
 * a real sky; a clear high-altitude sky tops out near 0.75.
 */
float skyPolarization(vec3 rd, vec3 sunDir) {
  float ct = dot(rd, sunDir);
  return 0.75 * (1.0 - ct * ct) / (1.0 + ct * ct);
}

/**
 * Transmission through a circular polarizer, normalized so unpolarized light
 * passes unchanged (Malus's law with the filter's flat 50% loss factored out —
 * u_pol.w reintroduces the real loss if asked for).
 *
 * aim is where the ring is turned to: the e-vector's angle at the middle of
 * the frame, so that u_pol.y = 0 is the crossed orientation there — the one that
 * kills the polarized component and darkens the sky. Rotating by 90 degrees
 * passes it instead and the same band brightens, which is exactly what happens
 * when you turn the ring on a real one.
 */
float polarizerTransmission(float dop, float ePhi, float aim) {
  float d = sin(ePhi - aim - u_pol.y);
  float t = (1.0 - dop) + 2.0 * dop * d * d;
  t = mix(1.0, t, u_pol.x);
  return t * mix(1.0, 0.40, u_pol.w);   // 0.40 ~ the real 1.3-stop bite
}

// ── Wide gamut ──
// Everything above is authored and composited as sRGB-encoded values, so the
// conversion is: decode with the sRGB transfer function, change primaries,
// re-encode with the same curve (Display P3 shares it). Matrix from gamut.ts.
const mat3 SRGB_TO_P3 = ${glslMat3(SRGB_TO_DISPLAY_P3)};

vec3 srgbToDisplayP3(vec3 c) {
  // clamp before every pow(): a negative base is undefined, and mix() computes
  // both branches, so one NaN would leak into the selected one
  c = max(c, 0.0);
  vec3 lin = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  lin = max(SRGB_TO_P3 * lin, 0.0);
  return mix(lin * 12.92, 1.055 * pow(lin, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, lin));
}

float hash11(float n) { return fract(sin(n) * 43758.5453123); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
/**
 * Value noise — the four lattice corners and their bilinear blend, read out of
 * a baked texture rather than hashed here.
 *
 * This is not an approximation of the arithmetic it replaces. Smoothstepping
 * the *coordinate* and then letting the sampler filter linearly computes
 * mix(mix(a, b, f.x), mix(c, d, f.x), f.y) over exactly the same four texels —
 * which is the expression that used to be spelled out below. The differences
 * are that the lattice now repeats every NOISE_SIZE units (see noise.ts) and
 * that its values are quantized to 8 bits.
 *
 * The half-texel offset lands the sample on texel centers, so floor(p) picks
 * the same corner the hash used to.
 *
 * hash12 stays: the stars, snowflakes, raindrops, lens droplets, blob lattice
 * and dither all want an unfiltered point hash at unbounded coordinates, and
 * measurement showed moving those to a texture bought nothing.
 */
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return NOISE_FETCH((i + f + 0.5) * ${(1 / NOISE_SIZE).toFixed(10)}).r;
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return v;
}
float fbm4(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return v;
}
// two octaves, for modulators that only need broad unevenness cheaply
float fbm2(vec2 p) {
  return vnoise(p) * 0.667 + vnoise(p * 2.03 + vec2(17.3, 9.1)) * 0.333;
}
// ── Camera ──────────────────────────────────────────────
// World space is x=east, y=up, z=north. yaw=0 faces north; pitch>0 looks up.

vec3 viewRay(vec2 ndc, float yaw, float pitch, float fov, float aspect) {
  float t = tan(fov * 0.5);
  vec3 d = normalize(vec3(ndc.x * aspect * t, ndc.y * t, 1.0));
  float cp = cos(pitch), sp = sin(pitch);
  d = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
  float cy = cos(yaw), sy = sin(yaw);
  return normalize(vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy));
}

// world direction → NDC. Positive z means in front of the screen (used for the lens flare's optical axis)
vec3 projectDir(vec3 d, float yaw, float pitch, float fov, float aspect) {
  float cy = cos(yaw), sy = sin(yaw);
  vec3 v = vec3(d.x * cy - d.z * sy, d.y, d.x * sy + d.z * cy);
  float cp = cos(pitch), sp = sin(pitch);
  v = vec3(v.x, v.y * cp - v.z * sp, v.y * sp + v.z * cp);
  float t = tan(fov * 0.5);
  float z = max(v.z, 1e-4);
  return vec3(v.x / (z * t * aspect), v.y / (z * t), v.z);
}

// view direction → a 2D coordinate for placing stars (folded onto a plane per cubemap face)
// an offset is added per face so neighboring faces don't share the same cell IDs
vec2 starGrid(vec3 d) {
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) return d.zy / a.x + vec2(d.x > 0.0 ? 11.0 : 23.0, 0.0);
  if (a.y >= a.z)               return d.xz / a.y + vec2(d.y > 0.0 ? 37.0 : 53.0, 0.0);
  return d.xy / a.z + vec2(d.z > 0.0 ? 71.0 : 97.0, 0.0);
}

// azimuth, elevation → unit direction vector
vec3 dirFromAngles(float elevation, float azimuth) {
  float ce = cos(elevation);
  return vec3(ce * sin(azimuth), sin(elevation), ce * cos(azimuth));
}

/**
 * The Milky Way, as a band around a fixed galactic pole.
 *
 * The renderer has no sidereal time — the star field is pinned to the view
 * direction, not to a rotating celestial sphere — so the galactic plane is a
 * fixed great circle too. Chosen to arc overhead at an angle that reads like a
 * summer sky rather than to match any particular date.
 *
 * Returns additive light, which is only correct because the composite is linear
 * now: a faint band over a near-black sky is exactly the case where adding in
 * gamma-encoded values goes wrong.
 */
#ifdef FEAT_DARKSKY
float milkyWayBand(vec3 rd, float amt, out float bulgeOut, out float riftOut,
                   out float glowOut, out float baseOut) {
  bulgeOut = 0.0;
  riftOut = 0.0;
  glowOut = 0.0;
  baseOut = 0.0;
  if (amt < 0.001) return 0.0;
  const vec3 POLE = vec3(0.4338, 0.8073, 0.4000);
  float lat = asin(clamp(dot(rd, POLE), -1.0, 1.0));

  // a coordinate running ALONG the band, so structure can be stretched the way
  // a galaxy's is instead of being isotropic blobs
  vec3 e1 = normalize(cross(POLE, vec3(0.0, 1.0, 0.0)));
  vec3 e2 = cross(POLE, e1);
  float lon = atan(dot(rd, e2), dot(rd, e1));

  // The galactic-centre bulge: the band is not uniform along its length — one
  // stretch swells wide and bright, and the rest thins away from it. Chord
  // distance (2 sin(dl/2)) keeps the falloff periodic in lon with no seam.
  // -2.45 sits low in the default framing's field of view (measured, not
  // guessed), so the band reads brightest near the horizon and thins overhead.
  float dl = 2.0 * sin(0.5 * (lon + 2.45));
  float bulge = exp(-dl * dl * 2.2);
  bulgeOut = bulge;

  // width swells around the bulge (smaller exponent = wider profile) and the
  // whole band brightens there
  float w = mix(1.45, 0.70, bulge);
  float band = exp(-lat * lat * 30.0 * w) * 0.62 + exp(-lat * lat * 6.0 * w) * 0.38;
  band *= 0.40 + 1.05 * bulge;
  // the SMOOTH band, before the star-cloud structure and the dust: the star
  // grain follows this. Real star density varies gently along the band — the
  // patchiness the eye sees is absorption, which the rift term carries — and
  // driving the grain off the structured value instead punches holes of
  // missing stars into every dip of the glow
  baseOut = band * amt;

  // star clouds: two octaves, stretched along the band
  vec2 q = vec2(lon * 2.6, lat * 7.0);
  float structure = fbm4(q) * 0.62 + fbm(q * 3.4) * 0.38;
  band *= 0.30 + 1.25 * structure;

  // Dust, three scales. All of it lives close to the plane, so skip the whole
  // stack for the wide faint skirts of the profile.
  if (abs(lat) < 0.45) {
    // the Great Rift: one long dark lane running along the band past the bulge,
    // wandering off-axis, its width and depth uneven along its length. This is
    // deliberately a path in (lon, lat), not a threshold on isotropic noise —
    // that is what keeps it reading as a rift and not as blobs. A second,
    // finer wobble roughens the shoulders so the edge reads torn, not drawn.
    float riftPath = (fbm2(vec2(lon * 1.1, 2.7)) - 0.5) * 0.24
                   + (fbm2(vec2(lon * 6.3, 4.4)) - 0.5) * 0.055;
    float riftHalf = 0.035 + 0.060 * fbm2(vec2(lon * 1.7, 8.9));
    float rp = (lat - riftPath) / riftHalf;
    float riftDepth = smoothstep(0.04, 0.50, bulge)
                    * (0.45 + 0.55 * fbm2(vec2(lon * 2.3, 15.1)));
    // exported: the dust sits in FRONT of the star field, so the star layers
    // multiply this in — a rift that only dims the glow floats behind the
    // stars. Faded with amt (saturating well below full) or the rift-hidden
    // stars would pop back the instant the Milky Way crosses zero
    riftOut = exp(-rp * rp) * riftDepth * min(amt * 2.0, 1.0);
    band *= 1.0 - 0.85 * riftOut;

    // Several soft irregular mid-scale lanes, not one drawn line — and their
    // latitude sheared by a longer noise so they cross the band at shifting
    // angles instead of stacking into corduroy parallel to it
    float laneLat = lat + (fbm2(vec2(lon * 3.1, 7.7)) - 0.5) * 0.16;
    float dust = fbm(vec2(lon * 1.9, laneLat * 5.5) + 11.0);
    float lanes = smoothstep(0.40, 0.66, dust) * smoothstep(0.20, 0.02, abs(laneLat));
    band *= 1.0 - 0.42 * lanes;

    // small-scale mottling, sheared against the band axis for the same reason:
    // the patchiness that keeps the bright parts from reading as an airbrush
    float mott = smoothstep(0.46, 0.80, fbm(vec2(lon * 4.6 + lat * 2.2, lat * 14.0) + 31.0))
               * smoothstep(0.28, 0.05, abs(lat));
    band *= 1.0 - 0.50 * mott;
  }

  // the bulge as light, not only as width: a broad band-shaped swelling for the
  // glow pass to add in the core color. Rift-cut here so it cannot fill the
  // dark lane back in
  glowOut = bulge * bulge * exp(-lat * lat * 7.0) * (1.0 - 0.75 * riftOut) * amt;

  return max(band, 0.0) * amt;
}
#endif


/**
 * One meteor from one independent stream. See meteorStreak for the rate maths.
 */
vec3 meteorOne(vec3 rd, float t, float rate, float hasRadiant, vec2 radiant, float seed) {
  const float CELL = 1.2;                       // seconds per slot
  // Fraction of the slot the head takes to cross its nominal span. It does not
  // stop there: BURN_IN..BURN_OUT is when it goes out, and it keeps travelling
  // the whole time. Halting it and then dimming — which is what this did at
  // first — reads exactly as "it stopped", because it did.
  const float FLIGHT = 0.22;
  const float BURN_IN = 0.72;                   // in units of the nominal flight
  const float BURN_OUT = 1.20;
  float slot = floor(t / CELL) + seed;
  float p = hash11(slot * 1.37);
  if (p > clamp(rate / 3600.0 * CELL, 0.0, 0.92)) return vec3(0.0);
  // one in sixteen is a fireball: far brighter, wider, slower to burn out,
  // and it leaves a train that lingers
  float fb = step(0.94, hash11(slot * 23.7));

  float ph = fract(t / CELL);
  float travel = ph / FLIGHT;                   // 1.0 at the nominal end, keeps rising
  if (travel > BURN_OUT) return vec3(0.0);

  float a = hash11(slot * 3.11) * 6.2831;
  float e = 0.12 + hash11(slot * 5.77) * 1.15;
  vec3 origin = dirFromAngles(e, a);
  vec3 dir;
  if (hasRadiant > 0.5) {
    vec3 rad = dirFromAngles(radiant.x, radiant.y);
    vec3 away = normalize(origin - rad * dot(origin, rad));
    origin = normalize(rad + away * (0.10 + hash11(slot * 7.3) * 0.35));
    // re-derive the tangent AT the moved origin. Reusing away would leave dir
    // non-orthogonal to origin, and the perp term below — which subtracts both
    // components — would then never reach zero, hiding the streak completely
    dir = normalize(origin - rad);
    dir = normalize(dir - origin * dot(dir, origin));
  } else {
    vec3 up = abs(origin.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 rt = normalize(cross(up, origin));
    vec3 uu = cross(origin, rt);
    float th = hash11(slot * 9.13) * 6.2831;
    dir = normalize(rt * cos(th) + uu * sin(th));
  }

  float along = dot(rd, dir);
  float front = dot(rd, origin);
  if (front < 0.45) return vec3(0.0);
  float perp = length(rd - dir * along - origin * front);

  // how far it crosses, in radians. 0.58..1.06 is 33 to 61 degrees
  float span = 0.58 + hash11(slot * 11.7) * 0.48;
  float head = travel * span;                   // never clamped — it never halts
  float back = head - along;
  if (back < 0.0) return vec3(0.0);

  // the trail marks where the head has already been, so it grows out of nothing
  // rather than existing at full length on the first frame
  float maxTrail = span * 0.88;
  float trailLen = min(maxTrail, head);
  if (back > trailLen) return vec3(0.0);
  float u = back / max(trailLen, 1e-4);

  // near-constant width, about a pixel: any taper draws a wedge, and a wedge
  // reads as a comet. Brightness carries the shape instead
  float width = mix(0.0019, 0.0016, clamp(u, 0.0, 1.0)) * (1.0 + 1.6 * fb);
  float core = exp(-(perp * perp) / (width * width));

  float u01 = clamp(u, 0.0, 1.0);
  float prof = smoothstep(0.0, 0.07, u01) * (1.0 - smoothstep(0.30, 1.0, u01));
  // decay on age, not position, so the tail is left behind rather than towed
  prof *= exp(-(back / max(span, 1e-4) * FLIGHT) * 3.2);

  // It burns out over a long, smooth ramp while still moving, so there is never a
  // frame where it is stationary and visible. Squared so the last of it goes
  // gently rather than stepping off.
  float burn = 1.0 - smoothstep(BURN_IN, BURN_OUT + 0.6 * fb, travel);
  burn *= burn;
  float life = smoothstep(0.0, 0.035, ph) * burn;
  // the fireball's train: its wake, decaying slower than the trail does
  prof = mix(prof, max(prof, exp(-(back / max(span, 1e-4) * FLIGHT) * 1.2) * 0.35), fb);

  float hue = hash11(slot * 17.3);
  vec3 trailCol = hue < 0.38 ? vec3(0.62, 1.00, 0.70)
                : hue < 0.72 ? vec3(1.00, 0.88, 0.55)
                             : vec3(0.86, 0.92, 1.00);
  vec3 col = mix(trailCol, vec3(1.0), (1.0 - smoothstep(0.0, 0.30, u01)) * 0.7);

  return col * core * prof * life * (0.55 + 0.45 * hash11(slot * 13.9)) * (1.0 + 5.0 * fb);
}

/**
 * Meteors — the same event machinery as lightning: chop the clock into slots,
 * hash each one, and fire if it clears the threshold.
 *
 * Drawn in ray space, so a meteor stays where it is in the sky while the view
 * swings rather than being glued to the frame.
 *
 * zhr is a real ZHR, and a ZHR is defined for an observer watching the *whole
 * sky*. A 49-degree frame covers under a tenth of it, so an honest ZHR 100 puts
 * roughly one meteor in shot every few minutes — correct, and useless as a
 * control. What was actually wrong was the ceiling: one meteor per slot capped
 * the whole-sky rate no matter how high the number went. Several independent
 * streams run in parallel now, each carrying its share, so the rate means
 * something across the range and more than one can be in the air at once (which
 * is what shower photographs show anyway).
 */
vec3 meteorStreak(vec3 rd, float t, float zhr, float hasRadiant, vec2 radiant) {
  if (zhr < 0.01) return vec3(0.0);
  const int STREAMS = 4;
  vec3 total = vec3(0.0);
  for (int k = 0; k < STREAMS; k++) {
    float fk = float(k);
    // offset each stream's clock and its hash, or all four fire together
    total += meteorOne(rd, t + fk * 0.31, zhr / float(STREAMS), hasRadiant, radiant, fk * 131.7);
  }
  return total;
}




#ifdef FEAT_AURORA
// ── Aurora ──
// Curtains of light standing in the upper air toward the north, folding along
// wavy lines that run east to west and shimmering in vertical rays. A curtain
// is a vertical sheet between two altitudes, so a ray crosses it along some
// length of the sheet — which is what makes the folds: seen edge-on the sheet
// is a bright rib, seen face-on a faint veil. Marched in a few steps of
// altitude; each step projects the ray onto that altitude's plane, the way the
// cloud planes do, and asks how close it lands to the curtain's line. The
// curtains come overhead as the activity rises.
//
// Linear light; the caller gates it on night and cloud and scales it.
vec3 aurora(vec3 rd, float amt) {
  if (amt < 0.001 || rd.y < 0.02) return vec3(0.0);
  const int STEPS = 12;
  const float A_LO = 1.0;     // the lower edge, ~100 km up: the bright green rim
  const float A_HI = 2.8;     // the top, where the red has faded
  float stand = mix(3.2, 0.3, amt);
  float t = u_time;
  // the march is coarse, and a coarse march through a thin sheet draws the
  // sheet once per step, as a stack of bands. Starting each pixel's march at
  // its own fraction of a step turns the stack into grain, which the eye
  // reads as the curtain's own shimmer; the sheet also thickens with height
  // (the top of a curtain is a diffuse glow, not a rib), so the upper steps
  // overlap into one. The fraction is interleaved gradient noise rather than
  // a hash — evenly spread over any few neighbouring pixels, so the grain
  // stays fine instead of clumping — stepped along the golden ratio each
  // frame so it never settles into a pattern
  float jitter = fract(52.9829189 * fract(0.06711056 * gl_FragCoord.x + 0.00583715 * gl_FragCoord.y)
                       + floor(t * 30.0) * 0.618034);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    float k = (float(i) + jitter) / float(STEPS);
    float a = mix(A_LO, A_HI, k);
    vec2 p = rd.xz / rd.y * a;          // where the ray crosses this altitude
    // the main curtain's line across the sky: a slow, drifting wander
    float wander = (fbm2(vec2(p.x * 0.22 + t * 0.012, 3.1)) - 0.5) * 2.2
                 + (fbm2(vec2(p.x * 0.9 - t * 0.02, 7.7)) - 0.5) * 0.5;
    float d = p.y - (stand + wander);
    // the sheet's thickness varies along its length — folds bunch and
    // spread — and grows with height
    float w = (0.10 + 0.16 * fbm2(vec2(p.x * 0.5 + 11.0, t * 0.01))) * (1.0 + 2.2 * k);
    float band = exp(-d * d / (w * w));
    // a second, fainter curtain further north
    float d2 = p.y - (stand + 1.4 + (fbm2(vec2(p.x * 0.3 - t * 0.009, 19.0)) - 0.5) * 2.0);
    float w2 = 0.25 * (1.0 + 2.2 * k);
    band += 0.5 * exp(-d2 * d2 / (w2 * w2));
    // rays: vertical striations along the curtain, shimmering, softer up top
    float ray = vnoise(vec2(p.x * 7.0 + t * 0.35, 1.3)) * 0.6
              + vnoise(vec2(p.x * 19.0 - t * 0.6, 5.1)) * 0.4;
    ray = mix(ray * ray * 1.6 + 0.15, 0.75, k * 0.7);
    // bright at the lower edge, thinning upward
    float prof = exp(-k * 2.2);
    // green at the foot, red up top; at high activity a purple fringe below the green
    vec3 col = mix(vec3(0.20, 1.00, 0.45), vec3(0.95, 0.25, 0.40), smoothstep(0.25, 1.0, k));
    col = mix(col, vec3(0.70, 0.35, 1.00), smoothstep(0.2, 0.0, k) * amt * 0.6);
    sum += col * band * ray * prof;
  }
  // the path through the slab lengthens as the ray flattens toward the
  // horizon. Brightness rises faster than the amount: a quiet night's arc is
  // faint, a storm's curtains are not
  return sum * (1.0 / float(STEPS)) * amt * (0.35 + 0.65 * amt)
       * min(1.0 / max(rd.y, 0.15), 3.0) * 0.35;
}
#endif

#ifdef FEAT_HALOS
// ── Ice halos ──
// What the ice crystals of a cirrostratus do with the sun and the moon: the
// 22° halo (refraction through the crystals, red on its inner edge), the
// parhelia — the sun dogs — that sit on it level with a low sun, and a pillar
// of light standing on a sun at the horizon, off the flat faces of falling
// plates. The moon gets its halo too. Linear light to add; nothing without
// the veil.
vec3 iceHalo(vec3 rd, float el, vec3 sunDir, float sunAng, float sunVis,
             vec3 moonDir, float moonAng, float moonVis, float nightF) {
  float ice = u_high.y;
  if (ice < 0.001 || rd.y < 0.0) return vec3(0.0);
  // The crystals are where the veil is. A halo drawn evenly round the sun is
  // a drawn circle; the real one is patchy and broken where the veil thins,
  // so everything here is weighted by the veil's own density along this ray
  vec2 vuv = rd.xz / max(rd.y, 0.03) * (3.2 * 0.5) + vec2(u_windOff * 0.3, u_windOff * 0.045);
  float veil = 0.35 + 0.65 * smoothstep(0.30, 0.72, fbm4(vuv + vec2(u_evo * 0.15, 0.0)));
  vec3 add = vec3(0.0);
  if (sunVis > 0.0) {
    float sunEl = sunDir.y;
    // the 22° halo: a sharp inner edge, red, and a long fade outward into a
    // faint brightening of the sky — the refraction has a minimum deviation
    // and no maximum. The inside of the ring is a shade darker than the sky
    float d = sunAng - 0.379;
    float ring = smoothstep(-0.014, 0.006, d) * exp(-max(d, 0.0) * 22.0);
    vec3 ringCol = mix(vec3(1.0, 0.62, 0.50), vec3(1.0, 0.96, 0.90), smoothstep(0.0, 0.035, d));
    add += L(ringCol) * ring * 0.16 * sunVis;
    // sun dogs: level with the sun, 22° out and a little more as it climbs,
    // red on the side toward the sun and a white tail trailing away from it;
    // brightest with the sun low, gone above 45° or so
    float low = smoothstep(0.70, 0.10, sunEl);
    if (low > 0.0) {
      float spread = 0.384 / max(sqrt(1.0 - sunEl * sunEl), 0.5);
      vec2 hs = normalize(sunDir.xz + vec2(1e-5)), hr = normalize(rd.xz + vec2(1e-5));
      // signed azimuth from the sun, scaled to sky radians at this elevation
      float dAz = atan(hr.x * hs.y - hr.y * hs.x, dot(hr, hs)) * sqrt(max(1.0 - rd.y * rd.y, 0.0));
      float dEl = el - u_sun.x;
      float x = abs(dAz) - spread * sqrt(max(1.0 - sunEl * sunEl, 0.0));   // outward from the dog
      float dog = exp(-dEl * dEl / 0.00028)
                * (exp(-x * x / 0.0004) + smoothstep(0.0, 0.02, x) * exp(-x * 22.0) * 0.5);
      vec3 dogCol = mix(vec3(1.0, 0.55, 0.40), vec3(1.0, 0.95, 0.88), smoothstep(-0.012, 0.012, x));
      add += L(dogCol) * dog * 0.45 * low * sunVis;
    }
    // the pillar: a column above and below a sun near the horizon
    float lowP = smoothstep(0.20, 0.02, sunEl) * smoothstep(-0.08, 0.0, sunEl);
    if (lowP > 0.0) {
      vec2 hs = normalize(sunDir.xz + vec2(1e-5)), hr = normalize(rd.xz + vec2(1e-5));
      float dAz = acos(clamp(dot(hs, hr), -1.0, 1.0)) * sqrt(max(1.0 - rd.y * rd.y, 0.0));
      float dEl = el - u_sun.x;
      float column = exp(-dAz * dAz / 0.0008) * exp(-abs(dEl) * 12.0) * smoothstep(0.0, 0.02, abs(dEl));
      add += L(vec3(1.0, 0.70, 0.45)) * column * 0.25 * lowP * sunVis;
    }
  }
  if (moonVis > 0.0) {
    float d = moonAng - 0.379;
    float ring = smoothstep(-0.014, 0.006, d) * exp(-max(d, 0.0) * 22.0);
    add += L(vec3(0.95, 0.95, 1.0)) * ring * 0.07 * moonVis * u_moon.z * nightF;
  }
  return add * ice * veil;
}
#endif

#ifdef FEAT_RAINBOW
// a rainbow's colors across its width: 0 the inner edge (violet), 1 the outer (red)
vec3 spectrum(float t) {
  return clamp(vec3(
    smoothstep(0.55, 1.0, t) + smoothstep(0.25, 0.0, t) * 0.45,
    smoothstep(0.15, 0.5, t) * smoothstep(0.95, 0.6, t),
    smoothstep(0.45, 0.0, t)
  ), 0.0, 1.0);
}
#endif

// ── Clouds ──────────────────────────────────────────────
// cloud field density and lit-ness (x=density 0..1, y=lit-ness -1..1, z=raw density value)
// the difference against a resample shifted slightly toward the sun becomes lit/shadowed
//
// clear is the raw density at or below which the caller draws nothing at all —
// the lower edge of whichever smoothstep its alpha is cut with. Below it the
// lit-ness is never looked at, so the resample is skipped; and where even the
// most the detail octaves could add would not lift the density past it, the
// detail is skipped too. Both are exact: fbm is a sum of texels in 0..1 under
// weights that total FBM_MAX, so that is a hard ceiling, not an estimate.
const float FBM_MAX = 0.96875;
vec3 cloudField(vec2 cuv, float churn, vec2 ldir, float edge, float ramp, float clear) {
  // shape evolution: the warp field itself drifts slowly, so the silhouette
  // crumbles and reassembles over time
  // (u_evo is integrated on the CPU side, so the offset doesn't jump even when the wind picks up)
  vec2 q = cuv + (0.30 + churn * 0.34) * vec2(
    fbm(cuv * 1.6 + u_evo),
    fbm(cuv * 1.6 - u_evo * 0.8)
  );
  // detail drifts at a different speed from the base, so edges erode and reform gradually.
  // rides u_evo rather than u_time: the CPU integrates it, so the phase
  // survives u_time's wrap, and the rate follows the wind like the rest of
  // the cloud motion (the factors reproduce the old u_time × 0.026 / 0.017
  // at light wind)
  vec2 drift = vec2(u_evo * 0.33, -u_evo * 0.21);
  float base = fbm(q);
  float dmax = (base * 0.72 + FBM_MAX * 0.28 - 0.5) * 2.2 + 0.5;
  if (dmax <= clear) return vec3(0.0, 0.0, dmax);
  float detail = fbm(q * 3.3 + 17.0 + drift);
  float dcomb = (base * 0.72 + detail * 0.28 - 0.5) * 2.2 + 0.5;
  float den = smoothstep(edge - 0.01, edge + ramp, dcomb);
  float lit = 0.0;
  if (dcomb > clear) {
    vec2 ql = q + ldir * 0.16;
    float dl = fbm(ql) * 0.72 + fbm(ql * 3.3 + 17.0 + drift) * 0.28;
    // ×4 saturates immediately into flat blocks of light and dark, so keep it gentle
    lit = clamp((dcomb - dl) * 2.5, -1.0, 1.0);
  }
  return vec3(den, lit, dcomb);
}

// ── Forms of the ten cloud genera ──────────────────────
// The ten genera reduce to "4 forms (filament/stratiform/granular/convective)
// × 3 altitudes". Altitude is handled by the cloud plane's projection scale;
// per-genus differences are the parameters passed to the functions below.
// Convective forms (cumulus/cumulonimbus) aren't a plane, so each is built
// inline in the body instead.

// intersection of the view ray with a cloud plane at altitude alt. Higher clouds make same-size lumps look smaller
vec2 planeUV(vec3 rd, float rdY, float alt, float wind) {
  return rd.xz / rdY * alt + vec2(wind, wind * 0.15);
}

// Stratiform (cirrostratus / altostratus / nimbostratus / stratus) — sheet-like clouds.
//
// Higher clouds look flatter, but a thick low-hanging layer (nimbostratus)
// shows a belly of "boundary-less mass sagging and undulating". turb is
// that strength. Raising breakup opens up gaps. Return value: x=coverage,
// y=thickness (0=thin, 1=thick)
vec2 stratiform(vec2 uv, float breakup, float turb) {
  vec2 q = uv + vec2(u_evo * 0.15, 0.0);
  float d;
  if (turb > 0.001) {
    // domain-warp to let the mass sag, and add detail at another scale for a smoke-like skin
    q += turb * 1.15 * vec2(fbm4(uv * 0.60 + u_evo * 0.35),
                            fbm4(uv * 0.60 + 9.0 - u_evo * 0.28));
    float n = fbm(q);
    d = mix(n, n * 0.66 + fbm(q * 2.7 + 11.0) * 0.34, turb);
  } else {
    d = fbm4(q);
  }
  // fbm's values cluster toward the middle, so the thickness threshold needs
  // to be narrow or the shading goes dull
  return vec2(mix(1.0, smoothstep(0.34, 0.70, d), breakup),
              smoothstep(0.34, 0.68, d));
}

// Granular (cirrocumulus / altocumulus / stratocumulus) — mackerel sky, sheep clouds, roll clouds.
//
// What defines these three's look is "grains of a consistent size, placed
// irregularly". Arranging grains on a grid is too regular and reads as
// wallpaper; using fbm mixes large and small grains into cumulus instead.
// **Thresholding a single noise octave** is the sweet spot: one consistent
// feature size, with placement that's irregular the way noise is.
//
// Raising pack makes grains bigger and denser, merging into a mottled
// pattern. roll < 1 stretches them into rolls. Return value: x=coverage, y=lit-ness (-1..1)
vec2 granular(vec2 uv, float pack, float roll, float patch, vec2 ldir) {
  // slowly reshuffle the arrangement of grains
  vec2 q = uv * vec2(1.0, roll)
         + 0.7 * vec2(vnoise(uv * 0.22 + u_evo * 0.20),
                      vnoise(uv * 0.22 + 17.0 - u_evo * 0.16));
  float n  = vnoise(q) * 0.72 + vnoise(q * 2.1 + 5.0) * 0.28;
  // fraying at the edge. Thresholding a single noise octave alone gives a
  // smooth curved boundary, reading as spilled milk rather than cloud.
  // Add high frequency at small amplitude to break it up.
  float fineN = fbm4(q * 5.0);
  n += (fineN - 0.47) * 0.17;

  // keep the threshold band narrow. Too wide and the edge bleeds endlessly
  // into a formless smudge
  float e0 = 0.62 - pack * 0.24;
  float cell = smoothstep(e0, e0 + 0.11, n);
  // between the grains there is nothing to shade: every caller draws with
  // g.x as its alpha, so the lit-ness there is never seen
  if (cell <= 0.0) return vec2(0.0);
  // grains gather sparsely into "flocks". Filling uniformly gives the whole
  // sky the same face everywhere. Raising patch merges the flocks into one
  // mottled sheet covering the sky (stratocumulus)
  float f = fbm4(uv * 0.16 + 21.0);
  cell *= smoothstep(mix(0.34, 0.02, patch), mix(0.68, 0.38, patch), f);
  if (cell <= 0.0) return vec2(0.0);

  // lit-ness: the difference against density resampled shifted toward the sun (per-grain shading)
  vec2 ql = q + ldir * 0.35;
  float nl = vnoise(ql) * 0.72 + vnoise(ql * 2.1 + 5.0) * 0.28;
  float lit = (n - nl) * 4.0;
  // fine surface grain, taken from the same field that frays the edge
  lit += (fineN - fbm4((q + ldir * 0.12) * 5.0)) * 2.4;
  return vec2(cell, clamp(lit, -1.0, 1.0));
}

// Filament (cirrus) — a stroke swept by a brush.
// Stretch strongly along the wind direction (uv's x-axis), and bend it with
// low frequency across the perpendicular direction for a flowing look
float filament(vec2 uv) {
  float bend = fbm4(uv * vec2(0.30, 0.85)) - 0.5;
  vec2 q = uv + vec2(0.0, bend * 1.5);
  float f = smoothstep(0.46, 0.76, fbm(q * vec2(0.30, 3.2)));
  float sparse = smoothstep(0.32, 0.62, fbm4(uv * 0.20 + 13.0));   // sparseness of the strands
  // Mare's tails: a cirrus is not strands all of one weight but tufts — a
  // dense head where the ice forms, with a fibrous tail streaming away from
  // it downwind as the crystals fall into slower air. The heads are knots
  // of a coarser noise; the tails are the strands, kept only where the
  // same noise, read a little upwind, says a head is there to stream from
  float head = smoothstep(0.56, 0.74, fbm4(uv * 0.42 + 7.0));
  float tail = smoothstep(0.42, 0.64, fbm4((uv + vec2(1.1, 0.0)) * 0.42 + 7.0));
  float strands = f * sparse * (0.30 + 0.70 * max(head, tail * 0.8));
  // the heads themselves: denser knots, with a little of the strand texture through them
  return min(strands + head * sparse * (0.45 + 0.35 * f), 1.0);
}

// A cluster of round lobes (the cauliflower texture of cumulus/cumulonimbus).
//
// As long as noise is cut with a threshold, the boundary is fractal at every
// scale. Dropping octaves smooths it, but never makes it round (it just
// becomes a formless, meandering shape). Cutting a sum of jittered spheres
// on a grid, on the other hand, always gives a boundary made of overlapping
// circular arcs. Real cumulus silhouettes look like "arcs joined together"
// precisely because they *are* a cluster of risen bubbles — this construction
// mirrors that origin directly.
float blobs(vec2 p, float radius) {
  vec2 ip = floor(p), fp = fract(p);
  float sum = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = vec2(hash12(ip + g), hash12(ip + g + 31.7));
      float r = radius * (0.60 + 0.70 * hash12(ip + g + 7.3));
      vec2 d = g + o - fp;
      float q = max(1.0 - dot(d, d) / (r * r), 0.0);
      sum += q * q;   // squaring smooths the falloff at the edge
    }
  }
  return sum;
}

// lens-flare ghost (a soft disc)
float ghost(vec2 p, vec2 pos, float r, float aspect) {
  float d = length((p - pos) * vec2(aspect, 1.0));
  return smoothstep(r, r * 0.4, d);
}

// ── The light the clouds are lit by ──
// Every cloud — the plane layers through cloudColor, and the cumulonimbus with
// its own lobe shading — takes its palette from these, so an hour, an overcast
// or a storm reaches them all through one door and two clouds side by side
// can never disagree about the color of the light. (The tower used to carry a
// hand-authored palette of its own, and read as a cream or a blue-grey mass
// against the cotton beside it.) Display-encoded, like the palette they feed.
//   ambient  the sky's own light on every face — all there is at night
//   glow     the afterglow on top of it: the pink of magic hour
//   sun      direct sunlight on top of both, already scaled by how much there is
//   shade    what reaches a face thick enough that only sky light gets in
//   moon     the faint silver on a night cloud
//   leaden   where severe weather drags everything
//   diffuse  0..1 how much of the sun the overcast has taken away
void cloudLight(float dayF, float nightF, float sunsetF, vec3 cloudSun, float alt,
                out vec3 ambient, out vec3 glow, out vec3 sun, out vec3 shade,
                out vec3 moon, out vec3 leaden, out float diffuse) {
  // under full overcast there's no direct sunlight, only diffuse light
  diffuse = smoothstep(0.55, 0.95, u_cover);
  // Whether the sun still reaches this layer: a cloud at 10 km is lit until
  // the sun is three degrees under, one at 1 km loses it as the sun touches
  // the horizon. That order — the low deck going grey while the high clouds
  // still burn — is most of what a sunset's clouds look like
  float sunEl = sin(u_sun.x);
  float sunUp = smoothstep(-0.035 - 0.07 * alt, 0.015 - 0.015 * alt, sunEl);
  ambient = mix(vec3(0.035, 0.045, 0.07), vec3(0.68, 0.73, 0.82), dayF);
  // the afterglow: a pink on the clouds once their direct sun has gone
  glow = vec3(0.30, 0.17, 0.13) * sunsetF * (1.0 - dayF) * (1.0 - sunUp * 0.7);
  // direct sun on the lit face, strongest and reddest at the horizon
  sun = cloudSun * max(dayF, sunsetF * 0.9) * sunUp;
  // not a flat grey: a blue-tinted shadow color (ambient light from the sky)
  shade = (ambient + glow) * vec3(0.50, 0.54, 0.64) + vec3(0.02, 0.03, 0.05);
  moon = vec3(0.10, 0.12, 0.18) * nightF;
  leaden = vec3(0.09, 0.10, 0.12) + vec3(0.10) * dayF;
}

// cloud color (lighting shared by every plane layer)
vec3 cloudColor(float den, float lit, float thick, float dayF, float nightF, float sunsetF,
                float flash, float gloom, float darkMul, vec3 cloudSun, float alt) {
  vec3 ambient, glow, sun, shade, moon, leaden;
  float diffuse;
  cloudLight(dayF, nightF, sunsetF, cloudSun, alt, ambient, glow, sun, shade, moon, leaden, diffuse);
  // under overcast, weaken the lit/shadow contrast, the base shadow, and the
  // silver lining together
  float litE = lit * (1.0 - diffuse * 0.75);
  // the lit face
  vec3 c = ambient + glow + sun * (0.42 + 0.45 * litE);
  // shadow from thickness: sink smoothly into the shade as thickness increases
  float sh = thick * (0.62 - diffuse * 0.28) * darkMul;
  sh *= 0.75 + 0.25 * (1.0 - litE);   // the sun-facing side has a shallower shadow
  c = mix(c, shade, clamp(sh, 0.0, 0.85));
  // night: a faint glow from moonlight
  c += moon * (0.3 + 0.4 * litE);
  // silver lining (the edge glows on the sun side — only with direct light)
  float rim = den * (1.0 - den) * 4.0 * max(litE, 0.0) * (1.0 - diffuse);
  c += cloudSun * rim * 0.35 * max(dayF, sunsetF * 0.5);
  // severe-weather clouds: a torn, leaden grey
  c = mix(c, leaden, gloom * 0.85);
  // lightning flickers inside the cloud
  c += flash * vec3(0.75, 0.8, 1.0) * (0.35 + den * 0.65);
  return c;
}

// ── The sky's own color, by direction ──
// The gradient, the magic hour and the anti-twilight: what the sky is before
// the polarizer, the overcast and the gloom act on it, and before any light is
// added to it. A function of direction rather than a stretch of main() so the
// sea can ask what it mirrors. Display-encoded (see the note at disp in
// main); wide collects the gamut claim the way main's does.
vec3 skyBase(vec3 rd, float el, float h, vec3 sunDir, float sunEl,
             float dayF, float sunsetF, inout float wide) {
  // ── Base sky gradient ──
  // These four and the two ramps below stay display-encoded: the gradient was
  // hand-tuned as a straight line in that space, and a straight line in linear
  // light is a different curve (measurably ~+28/255 brighter at the midpoint).
  // Interpolate where it was authored, then decode once into the scene.
  vec3 dayZen  = vec3(0.10, 0.34, 0.74);      // deep summer blue
  vec3 dayHor  = vec3(0.66, 0.83, 0.96);
  vec3 nightZen = vec3(0.010, 0.018, 0.048);
  vec3 nightHor = vec3(0.045, 0.065, 0.115);
  vec3 zen = mix(nightZen, dayZen, dayF);
  vec3 hor = mix(nightHor, dayHor, dayF);
  // the approach to zenith color should look like scattering: saturate it
  // exponentially against elevation
  // (the top of the screen isn't the zenith, so holding this in screen
  // coordinates would make the blue shallower depending on framing)
  vec3 disp = mix(hor, zen, 1.0 - exp(-max(el, 0.0) * 2.6));

  // ── Magic hour ──
  // Toward the sun the horizon goes red, then orange, then yellow up into
  // the blue: the sunlight's own color after its long path through the air,
  // scattered back by the air near the horizon. The band climbs as the sun
  // sinks and shrinks to a rim once the sun is well under; away from the
  // sun the horizon stays cool — the Earth's shadow and the Belt of Venus
  // are what is there, below. The zenith keeps its blue all along: a sunset
  // sky is blue overhead, not mauve. (This used to be one orange laid over
  // the whole lower sky, the far side included, with a mauve over the rest;
  // every sunset came out the same salmon.)
  float towardSun = clamp(dot(normalize(vec3(rd.x, 0.0, rd.z) + 1e-5),
                              normalize(vec3(sunDir.x, 0.0, sunDir.z) + 1e-5)), -1.0, 1.0);
  // not zero on the far side: at magic hour the whole lower air is lit by
  // the reddened sun and takes a cast of its own, fainter and pinker than
  // the band — the glow the hour is named for, which a far side left cold
  // lost
  float side = 0.22 * u_sunset.y + (1.0 - 0.22 * u_sunset.y) * smoothstep(-0.55, 0.85, towardSun);
  // how much of the sun's warmth there is: golden hour in from 14° up, full
  // from the horizon to 3° under, gone by 9° under
  float warmth = smoothstep(0.25, 0.03, sunEl) * smoothstep(-0.16, -0.05, sunEl);
  if (warmth > 0.001) {
    // the band's height in h: climbs as the sun goes down, then collapses
    float bandTop = 0.22 + 0.30 * smoothstep(0.10, -0.03, sunEl) - 0.34 * smoothstep(-0.05, -0.15, sunEl);
    // a harder sunset climbs higher and goes redder
    bandTop *= 0.75 + 0.25 * u_sunset.x;
    float y = h / max(bandTop, 0.05);
    vec3 red = vec3(1.0, 0.36, 0.14), orange = vec3(1.0, 0.58, 0.22), yellow = vec3(1.0, 0.86, 0.50);
    vec3 warmCol = y < 0.35 ? mix(red, orange, y / 0.35) : mix(orange, yellow, min((y - 0.35) / 0.65, 1.0));
    // redder the lower the sun: the light has farther to come
    warmCol = mix(warmCol, warmCol * vec3(1.0, 0.72, 0.55), smoothstep(0.03, -0.08, sunEl) * 0.6);
    warmCol = mix(warmCol, warmCol * vec3(1.0, 0.70, 0.55), clamp(u_sunset.x - 1.0, 0.0, 1.0) * 0.6);
    // the far side's share is pinker: it is lit light, not the sun's own
    warmCol = mix(mix(warmCol, vec3(0.95, 0.62, 0.62), 0.5), warmCol, smoothstep(-0.3, 0.6, towardSun));
    float wedge = (1.0 - smoothstep(0.45, 1.0, y)) * side * warmth;
    disp = mix(disp, warmCol, min(wedge * 0.85 * u_sunset.x, 1.0));
    // a lavender wash where the band meets the blue: faint all round, more
    // on the sun's side
    vec3 mauve = vec3(0.60, 0.42, 0.62);
    float band = smoothstep(0.6, 1.05, y) * (1.0 - smoothstep(1.3, 2.0, y)) * warmth;
    disp = mix(disp, mauve, min(band * (0.12 * u_sunset.y + 0.18 * side), 1.0));
    wide = max(wide, wedge * 0.5);
  }

  // ── Anti-twilight: the Earth's shadow and the Belt of Venus ──
  // Opposite a sun just under the horizon, the Earth's own shadow climbs the
  // sky as a band of blue-grey, and above it the air still in sunlight sends
  // back reddened light as a band of rose — the anti-twilight arch. The
  // shadow's edge stands about as high as the sun is deep, arching down away
  // from the antisolar point; the belt rides a few degrees above it. In by
  // sundown, gone by civil dusk, and the same again before sunrise. Without
  // it the far horizon at magic hour was only the amber's leftover, a beige
  // where the real sky goes cool.
  float twi = smoothstep(0.04, -0.01, sunEl) * smoothstep(-0.14, -0.06, sunEl);
  float away = smoothstep(0.45, -0.55, towardSun);
  float amt = twi * away;
  if (amt > 0.001) {
    float edge = max(-sunEl, 0.0) * max(-towardSun, 0.0);
    // the shadow: cooler and darker than the lit air above it, and it
    // takes back the amber the far horizon was given above
    float shadow = smoothstep(edge + 0.035, edge - 0.025, rd.y);
    disp *= mix(vec3(1.0), vec3(0.72, 0.78, 0.94), shadow * amt * 0.8);
    // the belt: a soft band of rose, brightest right above the shadow's
    // edge and fading away upward into the blue — a sharp foot, a long head
    float c = edge + 0.04;
    float d = (rd.y - c) / (rd.y > c ? 0.085 : 0.035);
    float belt = exp(-d * d) * smoothstep(-0.02, 0.01, rd.y);
    // dimmer the deeper the sun: the sky it sits in is dimming too
    vec3 rose = mix(vec3(0.60, 0.34, 0.42), vec3(0.98, 0.62, 0.64), smoothstep(-0.08, 0.0, sunEl));
    disp = mix(disp, rose, belt * amt * 0.36);
    wide = max(wide, belt * amt * 0.36 * 0.5);
  }
  return disp;
}

// what the weather does to the sky's color, wherever it is looked at
vec3 skyWeather(vec3 disp, float dayF, float gloom) {
  // overcast: the sky's blue drains toward a bright grey (including the sky peeking through gaps)
  float overcastSky = smoothstep(0.5, 0.95, u_cover);
  disp = mix(disp, mix(vec3(0.050, 0.055, 0.070), vec3(0.70, 0.73, 0.76), dayF), overcastSky * 0.85);
  // severe weather: darken the whole sky to a leaden grey
  disp = mix(disp, vec3(0.16, 0.18, 0.21) * (0.25 + 0.75 * dayF), gloom * 0.75);
  return disp;
}

#ifdef FEAT_SEA
// ── Waves ──
// The slope of one travelling sine across the water, height a·sin(k·p − ωt):
// its gradient, a·k·cos(k·p − ωt). Slopes are all the sea needs — they tilt
// the mirror — so the height itself is never summed
vec2 waveSlope(vec2 p, vec2 k, float a, float w, float t) {
  return a * k * cos(dot(k, p) - w * t);
}
#endif

// One layer of the cloud stack: a display-space wash, disp = mix(disp, col, a).
//
// The split variant (CLOUD_SPLIT, compiled only when cloudScale is asked for)
// uses that a run of such washes composes to a single affine map
// disp -> disp * cT + cC — cT what the stack lets through, cC what it adds —
// and accumulates the map instead, which is what lets the stack be drawn on
// its own at a lower resolution and laid over the sky afterwards
// (u_cloudMode). Mathematically identical to washing disp layer by layer.
//
// Without it, every macro below reduces to the one-pass shader as it always
// was. That matters for more than tidiness: carrying the split's unused
// branches and sampler cost the one pass 6-16% even with no clouds at all
// (an M2 Max, paired GPU timer queries), a whole-program effect of their mere
// presence.
#ifdef CLOUD_SPLIT
#define OVER(col, a) { float a_ = (a); cC = mix(cC, (col), a_); cT *= 1.0 - a_; }
#define CLOUD_STACK (u_cloudMode < 1.5)
#define SKY_LIGHT (u_cloudMode < 0.5 || u_cloudMode > 1.5)
#else
#define OVER(col, a) disp = mix(disp, (col), (a))
#define CLOUD_STACK true
#define SKY_LIGHT true
#endif

void main() {
  // Normally the viewport is the whole canvas and these reduce to the obvious.
  // The light probe draws the same frame into a far smaller viewport — and
  // cube faces beside it — so the picture's shape has to come from u_aspect,
  // not from how many pixels happen to be drawing it.
  vec2 p = (gl_FragCoord.xy - u_frame.xy) / u_frame.zw;   // 0..1 (y is up)
  float aspect = u_aspect;

  // ── Lens droplets (rain only. Refract the UV before deciding the view direction, distorting the image itself) ──
  // u_lensDrops at 0 skips the whole block — and the rim darkening at the end, which keys off dropMask
  float dropAmt = smoothstep(0.05, 0.5, u_rain) * u_lensDrops;
  float dropMask = 0.0;
  if (dropAmt > 0.001) {
    vec2 dg = p * vec2(aspect, 1.0) * 4.0;
    vec2 cell = floor(dg);
    float rc = hash12(cell);
    // attaches occasionally over a long cycle, lingers a while, then dries
    float cyc = u_time * 0.05 + rc * 9.0;
    float phase = fract(cyc);
    float active = step(0.6, hash12(cell + floor(cyc) * 0.618));
    float life = smoothstep(0.0, 0.04, phase) * smoothstep(0.55, 0.30, phase);
    vec2 dpos = vec2(0.25) + 0.5 * vec2(hash12(cell + 11.1), hash12(cell + 23.3));
    vec2 dv = fract(dg) - dpos;
    float r = 0.05 + hash12(cell + 31.7) * 0.08;
    float inside = smoothstep(r, r * 0.6, length(dv));
    float str = inside * life * active * dropAmt;
    p += dv * str * 2.2;
    dropMask = max(dropMask, str);
  }

  // ── View ray ──
  vec3 rd = viewRay(p * 2.0 - 1.0, u_cam.x, u_cam.y, u_cam.z, aspect);
  float el = asin(clamp(rd.y, -1.0, 1.0));
  float h = clamp(el / (PI * 0.5), 0.0, 1.0);   // horizon=0, zenith=1

  // ── Sun and day/night ──
  vec3 sunDir = dirFromAngles(u_sun.x, u_sun.y);
  float sunEl = sunDir.y;                      // sine of elevation, -1..1
  // Daylight falls away slowly through twilight: at sunset it is still
  // three fifths of noon, a fifth at civil dusk, gone by nautical. It used
  // to be a quarter by sunset — a sunset sky that was already dim, under a
  // wash of one warm color. Photographs expose for the sky, and that is
  // the look this draws
  float dayF = smoothstep(-0.17, 0.14, sunEl);
  float nightF = 1.0 - dayF;
  // the deep night the stars and the rest of the night sky's light keep to:
  // in after civil dusk, full by nautical — not the twilight nightF still
  // carries, which would put stars on a sunset
  float starF = 1.0 - smoothstep(-0.22, -0.08, sunEl);
  float sunsetF = smoothstep(0.35, 0.02, abs(sunEl));

  // ── Severity of the weather (rebuilt from rain/snow/wind instead of the old "storm") ──
  float gloom = clamp(max(u_rain, max(u_snow * 0.5, u_wind * 0.7)), 0.0, 1.0);
  float churn = clamp(u_wind * 0.9 + u_rain * 0.3, 0.0, 1.0);

  // How much this pixel should reach past sRGB, accumulated by the sections
  // below (magic hour, stars, moon, sun, lightning) and spent at the very end.
  // Only saturated light sources claim it — the clouds deliberately don't, since
  // their sunlit edges are small and high-frequency and widening them would
  // harden the outline.
  //
  // Invariant: a claim is the *fraction of the pixel that source contributes* —
  // the same weight it composites with, bleed factors included. Claim more and
  // you widen whatever lies underneath: exp(-sunAng * 4.0) alone still reads 0.1
  // a third of a radian out, which drags a whole quadrant of plain blue sky with
  // the sun.
  float wide = 0.0;

  // ── The sky's color in this direction: gradient, magic hour, anti-twilight ──
  // Held display-encoded as disp rather than decoded straight away: every
  // overlay() below would only re-encode it. See the note on disp at the clouds.
  vec3 disp = skyBase(rd, el, h, sunDir, sunEl, dayF, sunsetF, wide);

  // ── Circular polarizer ──
  // Applied here on purpose: this is the scattered skylight, and it is the only
  // thing a CPL acts on. Everything composited after this point — clouds (Mie
  // scattering, essentially unpolarized), the sun, the moon, the stars — is
  // direct or depolarized light and passes through untouched. That ordering is
  // what makes the clouds "pop": the sky behind them drops and they do not.
  float dop = skyPolarization(rd, sunDir);
  // Where the ring is turned to, and how much of this pixel's sky it took.
  // Both are read again below: the aim by the sea, the cut by the haze
  float polAim = 0.0;
  float polCut = 0.0;
#ifdef FEAT_POLARIZER
  if (u_pol.x > 0.001) {
    vec3 sky = L(disp);
    // The e-vector is perpendicular to the scattering plane, so it already lies
    // across the view ray; measure its angle in the frame's own basis, or the
    // filter would not track the camera as it swings.
    vec3 fwd = dirFromAngles(u_cam.y, u_cam.x);
    vec3 camRight = normalize(cross(vec3(0.0, 1.0, 0.0), fwd) + vec3(1e-6, 0.0, 0.0));
    vec3 camUp = cross(fwd, camRight);
    // The ring is aimed, the way a photographer aims it: turned so that the
    // middle of the frame is darkened most, and the given angle is a turn
    // from there. Held fixed in the frame instead, the filter sat at 45° to
    // the sky's polarization in whole ranges of framings — the sun mid-high
    // and off to one side is the common case — where a filter at 45° passes
    // exactly as much as none, and the "strong" preset did nothing visible.
    // (The e-vector's angle turns across the frame, so the aim is only right
    // at the middle; that falloff toward the edges is the real filter's.)
    // Looking straight at the sun or away from it the aim is undefined, and
    // so is the effect, so any aim will do: horizontal
    vec3 e0 = cross(fwd, sunDir);
    float e0len = length(e0);
    e0 = e0len > 1e-3 ? e0 / e0len : camRight;
    polAim = atan(dot(e0, camUp), dot(e0, camRight));
    vec3 e = normalize(cross(rd, sunDir) + vec3(1e-6));
    float ePhi = atan(dot(e, camUp), dot(e, camRight));

    float tr = polarizerTransmission(dop, ePhi, polAim);
    // the rejection alone, without the flat stop loss — negative where the
    // ring is turned to pass the polarized light and the band brightens
    polCut = 1.0 - tr / mix(1.0, 0.40, u_pol.w);
    sky *= tr;

    // the veil a polarizer removes is multiply-scattered white light, so what
    // survives reads more saturated than the darkening alone would explain.
    // dot() against the Rec.709 coefficients is a real luminance here — in the
    // old gamma-encoded pipeline it never was. Keyed to what was actually
    // rejected: a ring turned to brighten the band takes no veil away
    if (u_pol.z > 0.001) {
      float lum = dot(sky, vec3(0.2126, 0.7152, 0.0722));
      sky = max(mix(vec3(lum), sky, 1.0 + u_pol.z * max(polCut, 0.0)), 0.0);
    }
    disp = encodeSrgb(sky);
  }
#endif

  // overcast and severe weather
  disp = skyWeather(disp, dayF, gloom);

  // into linear light for the part of the sky that is added light
  vec3 sky = L(disp);

  // the cloud-stack pass (mode 1) writes only the clouds, so the night sky's
  // light below — the dearest of it, the star grids — is not drawn there
  bool skyLight = SKY_LIGHT;

  // ── Stars (night, low cloud. Determined by direction, so they stay pinned to the celestial sphere as the view swings) ──
  // Every term in here is scaled by this product — the star field, all three
  // grids and the Milky Way — so where it is zero (all day, and under heavy
  // cloud or gloom at night) the block adds exactly nothing and is skipped.
  // It is uniform across the frame, so the branch never diverges.
  if (starF * clamp(1.0 - u_cover * 1.4, 0.0, 1.0) * (1.0 - gloom) > 0.0 && skyLight) {
    // fold the view direction onto a cubemap-like 2D grid.
    // pulling from a 3D grid leaves most lattice points off the sphere the
    // view ray actually passes through, so almost no stars show up
    vec2 sg = starGrid(rd) * 62.0;
    vec2 cell = floor(sg);
    float sr = hash12(cell);
    // Nearly the full cell. At the old +/-0.25 every star sat in the middle of its
    // own cell, which reads as a lattice the moment enough of them are visible —
    // and the magnitude model made a lot more of them visible.
    vec2 off = (vec2(hash12(cell + 7.7), hash12(cell + 3.3)) - 0.5) * 0.84;
    float d = length(fract(sg) - 0.5 - off);

    float darkness = (9.0 - u_sky.x) / 8.0;
    // The Milky Way is a star cloud, not luminous fog: it reaches deeper into the
    // field where the band runs, and most of its brightness arrives as resolved
    // stars. The diffuse term below is only the unresolved remainder.
    // how far below the suburban default this site sits: gates every
    // dark-sky-only term, so Bortle 6 and up stay exactly the sky this has
    // always drawn
    float deep = clamp((6.0 - u_sky.x) / 5.0, 0.0, 1.0);
    float mwBulge; float mwRift; float mwGlow; float mwBase;
#ifdef FEAT_DARKSKY
    float mwHere = milkyWayBand(rd, u_sky.y, mwBulge, mwRift, mwGlow, mwBase);
#else
    float mwHere = 0.0;
    mwBulge = 0.0; mwRift = 0.0; mwGlow = 0.0; mwBase = 0.0;
#endif

    // Intrinsic brightness, power-law distributed: a handful of bright stars, a
    // great many faint ones. This is what carries the variation — deriving
    // brightness from distance above the visibility limit instead (as this did at
    // first) puts most of the visible population against the clamp at maximum
    // size, and every star ends up the same.
    float mag0 = pow(sr, 8.0);

    // The limit decides *whether* a star shows, not how bright it is. It falls as
    // the sky darkens, so dragging light pollution reveals fainter stars rather
    // than switching populations on and off.
    float cutoff = mix(0.002, 0.93, clamp((u_sky.x - 1.0) / 8.0, 0.0, 1.0));
    // The band is a star cloud first and a glow second, so it has to reach much
    // deeper into the field than it did — at 0.55 the density inside the band was
    // barely distinguishable from the sky beside it and the whole thing read as a
    // smooth smear. Squared so the dense core pulls far harder than the wings.
    // (floored: the bulge can push the band past 1, and a negative cutoff would
    // invert the renormalisation below)
    cutoff *= max(1.0 - 0.93 * mwHere * (0.45 + 0.55 * mwHere), 0.02);
    // dust extinction raises the limiting magnitude: inside the Rift the faint
    // stars vanish outright, not just dim — that is what makes it read as a
    // thing standing in front of the field
    cutoff = min(cutoff * (1.0 + 2.5 * mwRift), 0.93);
    float shows = smoothstep(cutoff * 0.75, cutoff * 1.9 + 0.004, mag0);

    // renormalised across the surviving population so the full range of sizes is
    // present at every Bortle. cutoff tops out at 0.93, so this cannot blow up
    float m = clamp((mag0 - cutoff) / max(1.0 - cutoff, 0.07), 0.0, 1.0);
    float radius = mix(0.030, 0.20, m * m);
    float amp = mix(0.05, 1.0, m * m * m);          // cubed: the bright ones carry
    float star = smoothstep(radius, 0.0, d) * amp * shows * (0.55 + 0.45 * darkness);
    // The band's extra depth cannot come through the cutoff at a dark site —
    // it is already saturated by Bortle 1 — so it arrives as amplitude, and
    // the Rift takes it back away: the dust is in front of these stars.
    star *= (1.0 + 1.0 * mwBase) * (1.0 - 0.70 * mwRift);
    float twinkle = 0.8 + 0.2 * sin(u_time * (1.0 + fract(sr * 13.0) * 2.0) + sr * 40.0);
    vec3 tint = L(mix(vec3(0.8, 0.88, 1.0), vec3(1.0, 0.93, 0.85), fract(sr * 71.0)));
    // at a dark site the top of the population splits into its two real color
    // classes — hot blue-white and cool amber — instead of a uniform grey
    tint = mix(tint, L(mix(vec3(0.60, 0.76, 1.00), vec3(1.00, 0.78, 0.55),
                           step(0.5, fract(sr * 71.0)))),
               deep * smoothstep(0.70, 0.92, m) * 0.85);
    // atmospheric extinction: near the skyline stars redden and dim rather
    // than switching off (the suburban horizon keeps its old hard fade)
    tint *= mix(vec3(1.0), vec3(0.95, 0.72, 0.52), deep * smoothstep(0.30, 0.02, h));
    // stars reach the skyline at a dark site; under light pollution the
    // horizon dome still swallows the lowest ones (0.16 is the old suburban
    // behavior, kept exactly)
    // the lower edge dips below the horizon at a dark site, so the grain meets
    // the skyline instead of stopping on a visible line just above it
    float horizonGate = smoothstep(mix(0.02, -0.02, deep), mix(0.16, 0.05, deep), h);
    float vis = star * twinkle * starF
              * horizonGate
              * clamp(1.0 - u_cover * 1.4, 0.0, 1.0) * (1.0 - gloom);
    sky += tint * vis * STAR_LUM;
    // a star's blue or amber is genuinely outside sRGB — the strongest claim here
    wide = max(wide, vis * 0.9);

    // the Milky Way shares the star field's occlusion exactly — same night, same
    // cloud, same gloom — so it is gated here rather than duplicating all of it
    float mwGate = starF * horizonGate
                 * clamp(1.0 - u_cover * 1.4, 0.0, 1.0) * (1.0 - gloom);
    float mw = mwHere * mwGate;

    // ── Second, finer star layer: the unresolved-into-resolved crowd ──
    // One star per cell tops out the density the main grid can reach, and a real
    // dark-sky band is grain, not a ceiling. A denser grid of small faint stars
    // fills in underneath: thickest inside the band, spreading over the whole
    // sky as the site darkens. Scaled by deep so it is *exactly* zero at Bortle
    // 6 and up — the default sky never pays for it or shows it — and fades in
    // continuously below.
#ifdef FEAT_DARKSKY
    if (deep > 0.0) {
      vec2 sg2 = starGrid(rd) * 158.0;
      vec2 cell2 = floor(sg2);
      float sr2 = hash12(cell2 + 19.19);
      vec2 off2 = (vec2(hash12(cell2 + 5.1), hash12(cell2 + 9.7)) - 0.5) * 0.88;
      float d2 = length(fract(sg2) - 0.5 - off2);
      float mag2 = pow(sr2, 6.0);
      // how far down the population this site+direction reaches: the band shows
      // most of it, the dark sky beside it a decent fraction
      // in-band reach tops out near half the cells: any denser and the grains
      // sit inside each other's contrast radius and fuse into a plateau
      // the band term starts a little above the profile's skirt, so the deep
      // wings do not smear the band's density gain over the whole sky
      float reach = deep * (0.16 + 0.46 * clamp(mwBase * 1.2 - 0.10, 0.0, 1.0))
                  * (1.0 - 0.60 * mwRift);
      float c2 = pow(1.0 - 0.88 * reach, 6.0);
      float shows2 = smoothstep(c2 * 0.6, c2 * 1.9 + 0.003, mag2);
      float m2 = clamp((mag2 - c2) / max(1.0 - c2, 0.2), 0.0, 1.0);
      // small and dim on purpose: these read as texture between the resolved
      // stars, not as a second population of discs
      // radius floor: cells are ~6px, so anything under ~0.12 cell radius
      // starts skipping pixel centers and the population thins out unseen
      float radius2 = mix(0.15, 0.26, m2);
      // brightened inside the band — the cutoff has no depth left to give at a
      // dark site, so the density contrast is carried by amplitude — and cut
      // by the Rift, which stands in front of these stars too. The boost is
      // moderate on purpose: pushed harder, the grains merge into a texture
      // and stop reading as stars at all
      float amp2 = mix(0.06, 0.42, m2 * m2) * deep
                 * (1.0 + 1.6 * clamp(mwBase - 0.08, 0.0, 1.2)) * (1.0 - 0.75 * mwRift);
      float star2 = smoothstep(radius2, 0.0, d2) * amp2 * shows2;
      vec3 tint2 = L(mix(vec3(0.84, 0.89, 1.0), vec3(1.0, 0.93, 0.87), fract(sr2 * 53.0)));
      sky += tint2 * star2 * mwGate * STAR_LUM;
      wide = max(wide, star2 * mwGate * 0.5);

      // Third grid, band-only: the near-continuous sand of the star clouds.
      // One dim, half-resolved star per finer cell; the sky outside the band
      // never evaluates it, and the default sky never reaches here at all
      float band3 = deep * clamp(mwBase * 1.1 - 0.12, 0.0, 1.0) * (1.0 - 0.85 * mwRift);
      if (band3 > 0.0) {
        vec2 sg3 = starGrid(rd) * 258.0;
        vec2 cell3 = floor(sg3);
        float sr3 = hash12(cell3 + 41.7);
        vec2 off3 = (vec2(hash12(cell3 + 13.1), hash12(cell3 + 27.9)) - 0.5) * 0.86;
        float d3 = length(fract(sg3) - 0.5 - off3);
        float mag3 = pow(sr3, 4.0);
        // visible fraction is 0.30*band3 exactly (the pow4 cancels against the
        // mag3 distribution): a third of the cells lit keeps the grains
        // separable — at 90% they fuse into a plateau and stop reading as stars
        float c3 = pow(1.0 - 0.40 * min(band3, 1.0), 4.0);
        float shows3 = smoothstep(c3 * 0.6, c3 * 1.9 + 0.003, mag3);
        float m3 = clamp((mag3 - c3) / max(1.0 - c3, 0.25), 0.0, 1.0);
        // radius floor matters: these cells are ~3.6px, so a disc under ~0.2
        // cell radius falls between pixel centers and never draws at all
        // deliberately just under the eye's "one star" threshold: this layer is
        // the sand between the countable stars, not a third countable class
        float star3 = smoothstep(mix(0.22, 0.36, m3), 0.0, d3)
                    * mix(0.10, 0.25, m3 * m3) * band3 * shows3
                    * (1.0 - 0.78 * mwRift);
        vec3 tint3 = L(mix(vec3(0.86, 0.90, 1.0), vec3(1.0, 0.94, 0.88), fract(sr3 * 37.0)));
        sky += tint3 * star3 * mwGate * STAR_LUM;
        wide = max(wide, star3 * mwGate * 0.4);
      }
    }
#endif

#ifdef FEAT_DARKSKY
    if (mw > 0.0001) {
      // Colour follows the band's own structure: lavender through the body of
      // the band, pink-magenta where the bulge swells (reddened by its own
      // dust), blue out along the thin reaches — the hue map of a long-exposure
      // photograph, carried well below photographic saturation. Light pollution
      // then does what it does to everything — washes the colour out and pulls
      // it toward the sky glow — so the same slider that thins the stars also
      // drains the band.
      vec3 core = vec3(1.00, 0.62, 0.80);        // the bulge, reddened by its own dust
      vec3 body = vec3(0.63, 0.54, 0.94);        // the band's lavender midriff
      vec3 edge = vec3(0.38, 0.52, 1.00);        // hot young stars out along the arms
      float dens = clamp(mwHere / max(u_sky.y, 1e-4), 0.0, 1.0);
      vec3 mwCol = mix(edge, body, smoothstep(0.03, 0.40, dens));
      mwCol = mix(mwCol, core, mwBulge * smoothstep(0.20, 0.75, dens));
      float wash = clamp((u_sky.x - 2.0) / 5.0, 0.0, 1.0);
      mwCol = mix(mwCol, vec3(0.74, 0.75, 0.70), wash * 0.8);
      // Only the unresolved remainder — the stars carry the rest. Kept low, and
      // weighted toward the dense parts, so it does not flatten into fog.
      sky += L(mwCol) * mw * (0.30 + 0.70 * dens) * 0.050;
      // the bulge carried as luminance too, so the swelling reads as light and
      // not only as width (rift-cut inside milkyWayBand)
      sky += L(mix(core, vec3(0.74, 0.75, 0.70), wash * 0.8)) * mwGlow * mwGate * 0.047;
      wide = max(wide, mw * 0.22);
    }
#endif

#ifdef FEAT_AURORA
    // ── Aurora ──
    // Light in the upper air, so it shares the stars' night and cloud — and
    // is drawn after them: the curtains hang in front of the star field
    if (u_aurora > 0.001) {
      vec3 au = aurora(rd, u_aurora) * mwGate * AURORA_LUM;
      sky += au;
      // its green and its red are both well outside sRGB
      wide = max(wide, min(max(max(au.r, au.g), au.b), 1.0) * 0.8);
    }
#endif
  }

  // ── Moon ──
  // Where the ephemeris puts it, lit by the sun from where the sun actually
  // is: the disc is drawn as a sphere, so the terminator's curve and which
  // limb is bright follow from the two positions — a thin crescent with its
  // horns away from the sun, a gibbous moon, a full one. Up by day as well,
  // where the lit face still shows against the blue and the dark face does
  // not. Every contribution below carries vis, so a zero vis is an exact no-op
  vec3 moonDir = dirFromAngles(u_moon.x, u_moon.y);
  float moonUp = smoothstep(-0.03, 0.03, moonDir.y);
  float moonVis = moonUp * clamp(1.0 - u_cover * 0.9 - gloom, 0.0, 1.0);
  // how much moonlight there is for the clouds and the night: a full moon
  // high up gives all of it, a crescent a sliver, a set moon none — with a
  // floor for the starlight and airglow a night keeps regardless
  float nightM = nightF * mix(0.3, 1.0, moonUp * u_moon.z);
  float moonAng = acos(clamp(dot(rd, moonDir), -1.0, 1.0));
  if (moonVis > 0.0 && skyLight) {
    float ang = moonAng;
    float moon = smoothstep(0.048, 0.043, ang);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), moonDir) + vec3(1e-6, 0.0, 0.0));
    vec3 up = cross(moonDir, right);
    float vis = moonVis;

    // Moon-fixed frame: the ray projected onto the disc plane, in units of the
    // disc radius, x toward the right of the sky and y up. The face is drawn
    // in this frame, so it stays glued to the surface however the camera
    // swings (and turns with the moon's position the way the real face does
    // against the horizon).
    vec2 muv = vec2(dot(rd, right), dot(rd, up)) / 0.048;
    // the surface under this ray, the disc being the near face of a sphere:
    // its normal, the cosine of the sun's incidence on it and of our view of it
    float rr = min(dot(muv, muv), 1.0);
    float mu = sqrt(1.0 - rr);
    vec3 nrm = right * muv.x + up * muv.y - moonDir * mu;
    float mu0 = dot(nrm, sunDir);
    // Lunar regolith reflects by Lommel-Seeliger, not Lambert: 2·μ0/(μ0+μ),
    // which is flat across a full moon (no limb darkening — the full moon is a
    // flat disc, famously) and falls to nothing at the terminator with the
    // slow gradient a crescent shows. The surge near full is the opposition
    // effect, what makes a full moon so much brighter than two half moons
    float ls = max(mu0, 0.0) * 2.0 / max(mu0 + mu, 1e-3);
    ls *= 1.0 + 0.5 * smoothstep(0.7, 1.0, u_moon.z);
    float lit = moon * ls;

    // ── the face ──
    // The near side's maria, where they are: the large dark basins as
    // ellipses with noise-torn edges, over a fine grain of highland. Read
    // only through the disc, so off it none of this runs
    float albedo = 1.0;
    if (moon > 0.0) {
      vec2 q = muv + (fbm4(muv * 2.6 + 3.0) - 0.5) * 0.18;   // torn edges
      float m = 0.0;
      #define MARE(cx, cy, rx, ry, k) { vec2 e = (q - vec2(cx, cy)) / vec2(rx, ry); m += k * smoothstep(1.25, 0.75, dot(e, e)); }
      MARE(-0.55,  0.12, 0.34, 0.44, 0.55)   // Oceanus Procellarum
      MARE(-0.24,  0.48, 0.30, 0.22, 0.62)   // Imbrium
      MARE( 0.22,  0.42, 0.18, 0.17, 0.62)   // Serenitatis
      MARE( 0.42,  0.12, 0.22, 0.20, 0.58)   // Tranquillitatis
      MARE( 0.62, -0.22, 0.14, 0.21, 0.52)   // Fecunditatis
      MARE( 0.45, -0.37, 0.11, 0.11, 0.50)   // Nectaris
      MARE(-0.30, -0.32, 0.21, 0.15, 0.52)   // Nubium
      MARE(-0.52, -0.44, 0.10, 0.10, 0.50)   // Humorum
      MARE( 0.76,  0.30, 0.10, 0.13, 0.62)   // Crisium
      MARE(-0.10,  0.78, 0.45, 0.07, 0.42)   // Frigoris
      #undef MARE
      m = min(m, 1.0);
      // the highlands: bright, cratered — a grain, and a few bright ray craters
      float grain = fbm4(muv * 9.0 + 17.0) - 0.5;
      float tycho = exp(-dot(muv - vec2(-0.16, -0.72), muv - vec2(-0.16, -0.72)) / 0.0025) * 0.35
                  + exp(-dot(muv - vec2(0.36, -0.08), muv - vec2(0.36, -0.08)) / 0.0012) * 0.2;
      albedo = mix(1.0, 0.52, m) * (1.0 + grain * 0.22) + tycho;
      // shadows lengthen toward the terminator and the relief comes out
      albedo *= 1.0 + (fbm(muv * 14.0 + 41.0) - 0.5) * 0.5 * smoothstep(0.5, 0.0, mu0);
    }

    // Earthshine. The shadowed disc is rock, not glass: it occludes the stars
    // behind it (a replace, not an add) and holds a faint blue-grey glow of
    // sunlight bounced off the Earth, far under the lit face, strongest when
    // the Earth is fullest from there — at a thin crescent. The occlusion
    // saturates early so a clear-night vis of 0.9 does not leak 10% of every
    // star through the rock, yet it still follows vis down under cloud so a
    // heavy overcast dims the disc away instead of punching a dark hole in
    // the cloud glow. By day the sky in front of it outshines it and the dark
    // face is not there at all.
    vec3 shine = L(vec3(0.62, 0.68, 0.78)) * albedo * 0.012 * (1.4 - u_moon.z) * MOON_LUM;
    sky = mix(sky, shine, moon * smoothstep(0.0, 0.55, vis) * nightF);

    // The lit face. Held just over the tone curve's knee, not blown out: a
    // moon that saturates to paper white loses its seas and reads as a disc
    // of paper, which is exactly what it did. By day the daylit sky in front
    // takes the edge off it — a white about a cloud's
    float face = 0.42 * mix(0.55, 1.0, nightF);
    sky += L(vec3(1.0, 0.97, 0.90)) * albedo * lit * vis * MOON_LUM * face;

    // Bloom: a little scatter around the lit limb, warm like the light that
    // causes it, growing with the phase. Kept small — a wide halo is what a
    // camera sees, not an eye, and it swallowed the disc
    vec2 litDir = normalize(vec2(dot(sunDir, right), dot(sunDir, up)) + vec2(1e-5, 0.0));
    float sideW = 0.5 + 0.5 * dot(muv, litDir) / max(length(muv), 1e-3);
    sideW = 0.12 + 0.88 * sideW;
    float rim = exp(-max(ang - 0.045, 0.0) * 55.0) * (1.0 - moon) * (0.1 + 0.9 * u_moon.z);
    sky += L(vec3(1.0, 0.95, 0.87)) * rim * sideW * 0.10 * vis * nightF;
    // a whisper of scattered moonlight haze just past the limb, all around
    sky += L(vec3(0.45, 0.55, 0.75)) * exp(-max(ang - 0.045, 0.0) * 11.0)
         * (1.0 - moon) * 0.025 * vis * u_moon.z * nightF;
    wide = max(wide, max(lit * 0.5, rim * sideW * 0.10) * vis * 0.7);
  }

  // ── Meteors ──
  float meteorVis = starF * clamp(1.0 - u_cover * 1.2, 0.0, 1.0) * (1.0 - gloom);
  if (meteorVis > 0.0 && skyLight) {
    vec3 m = meteorStreak(rd, u_time, u_sky.z, u_sky.w, u_radiant);
    float mi = max(max(m.r, m.g), m.b);
    if (mi > 0.0001) {
      float vis = meteorVis;
      // burns hot enough to claim gamut like the other light sources
      sky += L(m) * vis * STAR_LUM * 0.85;
      wide = max(wide, mi * vis * 0.85);
    }
  }

  // ── Sun (an overexposed blowout. The core saturates flat, the edge falls off steeply) ──
  float sunVis = smoothstep(-0.06, 0.06, sunEl)
               * clamp(1.0 - u_cover * 0.75 - gloom * 0.95, 0.0, 1.0);
  float sunAng = acos(clamp(dot(rd, sunDir), -1.0, 1.0));
  if (sunVis > 0.0) {
    vec3 sunCol = L(mix(vec3(1.0, 0.98, 0.92), vec3(1.05, 0.6, 0.3), sunsetF));
    // gain the core and clamp → produces a flat, saturated white patch at the center
    float core = clamp(exp(-sunAng * sunAng * 900.0) * 2.2, 0.0, 1.0);
    // At the horizon the disc itself is dimmed and reddened by the air it
    // comes through — an orange you can look at, not a white you cannot.
    // The blowout is kept for a sun with any height
    float low = smoothstep(0.14, -0.02, sunEl);
    vec3 disc = mix(vec3(SUN_LUM), L(vec3(1.0, 0.42, 0.16)) * SUN_LUM * 0.12, low);
    sky = mix(sky, disc, core * sunVis);
    // keep the surrounding bleed subtle (a scattering halo)
    float halo = exp(-sunAng * 4.0);
    sky += sunCol * halo * 0.22 * sunVis * HALO_LUM;
    // no sunsetF gate: at midday sunCol is near-white and the widening is
    // self-cancelling, so this only bites once the halo has turned orange.
    // halo carries the same 0.22 as its bleed — see the invariant above
    wide = max(wide, max(core, halo * 0.22) * sunVis * 0.6);
  }

  // night city lights (a warm glow along the horizon — a Tokyo-like sky)
  // 0.4 at Bortle 6, which is what this has always drawn; nothing at Bortle 1
  sky += L(vec3(0.26, 0.16, 0.09)) * exp(-h * 8.0) * starF
       * (0.4 * (u_sky.x - 1.0) / 5.0) * (1.0 - gloom * 0.6);

  // airglow: at a truly dark site the horizon carries a faint green-grey rim of
  // atmospheric chemiluminescence instead of city light. A thin rim — a fat
  // scale height reads as haze and swallows the lowest stars. Shares the second
  // star layer's gate, so it is exactly absent at Bortle 6 and up.
  float agDeep = clamp((6.0 - u_sky.x) / 5.0, 0.0, 1.0);
#ifdef FEAT_DARKSKY
  if (agDeep * starF > 0.0 && skyLight) {
    // rippled around the compass — real airglow hangs in uneven waves, and a
    // uniform rim reads as a printed strip. Seeded off the horizontal ray
    // components, so it is seamless in azimuth and pinned as the view swings
    float agN = fbm2(vec2(rd.x, rd.z) * 2.5 + 31.0);
    sky += L(vec3(0.30, 0.52, 0.38)) * exp(-h * (9.0 + 7.0 * agN)) * starF
         * (0.07 * (0.55 + 0.90 * agN) * agDeep)
         * clamp(1.0 - u_cover * 1.2, 0.0, 1.0) * (1.0 - gloom);

    // ── Zodiacal light ──
    // Sunlight off the dust that lies in the plane of the planets: at a dark
    // site, once twilight has gone, a faint cone leans up from where the sun
    // went down (and, before dawn, from where it will rise), along the
    // ecliptic. The ecliptic is taken as the sun's own path across the sky —
    // its daily arc about the pole — which is what sets the cone's lean.
    // Gone again once the sun is far enough down that the dust near it has set
    float zl = smoothstep(-0.16, -0.28, sunEl) * smoothstep(-0.60, -0.40, sunEl);
    if (zl > 0.0) {
      const vec3 POLE = vec3(0.0, 0.695, 0.719);     // a mid-northern latitude's celestial pole
      vec3 along = normalize(cross(sunDir, POLE) + vec3(1e-6));
      if (along.y < 0.0) along = -along;              // the branch that rises
      vec3 off = normalize(cross(sunDir, along));
      float u = atan(dot(rd, along), dot(rd, sunDir));   // up the ecliptic from the sun
      float v = dot(rd, off);                            // off the plane
      float halfW = 0.40 * (1.0 - clamp(u, 0.0, 1.4) / 1.8);
      float cone = exp(-max(u, 0.0) * 1.4) * exp(-v * v / (halfW * halfW)) * smoothstep(0.0, 0.15, u);
      sky += L(vec3(0.72, 0.75, 0.86)) * cone * 0.075 * zl * agDeep * starF
           * smoothstep(0.0, 0.03, h) * clamp(1.0 - u_cover * 1.2, 0.0, 1.0) * (1.0 - gloom);
    }
  }
#endif

  // ── Lightning (computed before the clouds so it lights them too) ──
  float flash = 0.0;
  // the slot and its phase are read again after the clouds, for the bolt
  float ltCell = floor(u_time * 0.55);
  float ltPh = fract(u_time * 0.55);
  {
    float p1 = hash11(ltCell);
    float thresh = mix(1.05, 0.55, u_thunder);   // never fires when thunder=0
    if (p1 > thresh) {
      flash = exp(-ltPh * 9.0) * (0.65 + 0.35 * sin(ltPh * 70.0 + p1 * 30.0));
    }
  }

  // ── Clouds, precipitation: back to display space ──
  // From here to the snow, every step is an overlay() — a wash authored as a
  // display-space blend — save the one halo marked below. overlay() pays an
  // encode and a decode (six pow()s) per call, per pixel, and back to back the
  // decode of one only feeds the encode of the next. So this whole stretch
  // stays encoded as disp and pays the pair once. That is exact, not an
  // approximation: encodeSrgb(L(x)) is x for any x >= 0, and a mix() of
  // non-negative colors with a weight in 0..1 cannot leave that range — every
  // alpha below is within 0..1 and every color non-negative.
  disp = encodeSrgb(sky);

  // ── Shared setup for the cloud layers (intersection of view ray × cloud plane) ──
  float rdY = max(rd.y, 0.03);
  float horizonFade = smoothstep(0.0, 0.24, rd.y);
  float az = atan(rd.x, rd.z);
  // the cloud plane's coordinate system is world xz; fold the sun direction onto the same plane
  vec2 ldir = normalize(sunDir.xz + vec2(1e-4, 1e-4));
  // display-encoded: this tints the cloud palette, which is authored there
  vec3 cloudSun = mix(vec3(1.05, 1.0, 0.95), vec3(1.15, 0.50, 0.22), sunsetF * min(u_sunset.x, 1.0));
  cloudSun = mix(cloudSun, cloudSun * vec3(1.0, 0.78, 0.62), sunsetF * clamp(u_sunset.x - 1.0, 0.0, 1.0) * 0.6);
  // and redder still once the sun is under: what still reaches the high clouds has come the long way
  cloudSun *= mix(vec3(1.0), vec3(1.0, 0.72, 0.58), smoothstep(0.02, -0.06, sunEl));

  // the cloud plane's projection scale (= altitude). Higher layers are larger, so the same lump looks smaller
  const float ALT_HIGH = 3.2;
  const float ALT_MID = 1.8;
  const float ALT_LOW = 0.95;
  // a cloud genus with amount 0 is skipped entirely — a clear sky costs almost nothing.
  // So is every plane layer below the horizon: each one's alpha carries
  // horizonFade, which is exactly zero there (half of every skybox bake)
  bool above = horizonFade > 0.0;
  float ramp = 0.08 + 0.14 * (1.0 - rdY);   // widen near the horizon to suppress aliasing

  // In the split variant the stack accumulates as one wash (see OVER). Mode 0
  // evaluates it here and applies it below; mode 1 evaluates it and stops
  // there, writing it out for a later composite; mode 2 skips it and reads
  // that composite instead — which is why every layer's gate carries stack.
#ifdef CLOUD_SPLIT
  vec3 cC = vec3(0.0);
  float cT = 1.0;
#endif
  bool stack = CLOUD_STACK;

  // ── High layer, 5000–13000m ─────────────────────────
  // Cirrus Ci (mare's tail) — the first to blush pink at magic hour
  if (u_high.x > 0.001 && above && stack) {
    // the extra x-crawl rides u_windOff too (see cloudField): 0.14 matches
    // the old u_time × 0.004 at light wind, and speeds up when it blows
    float f = filament(planeUV(rd, rdY, ALT_HIGH, u_windOff * 0.3) + vec2(u_windOff * 0.14, 0.0));
    vec3 col = mix(vec3(1.0), vec3(1.05, 0.62, 0.55), sunsetF);
    col = mix(vec3(0.25, 0.30, 0.45), col, max(dayF, sunsetF));
    OVER(col, f * u_high.x * 0.72 * horizonFade * (1.0 - gloom * 0.8));
  }
#ifdef FEAT_CONTRAILS
  // ── Contrails ──
  // A jet's trail: a line drawn across the high sky from a point, lengthening
  // at the plane's speed — thin and sharp just behind it, spreading into a
  // soft band and dissolving over the minutes after, uneven along its length
  // where the air was drier. One plane per slot of the clock, on a heading of
  // its own, as often as the amount asks
  if (u_contrails > 0.001 && above && stack) {
    const float SLOT = 240.0;
    const float SPEED = 0.06;                       // sky-plane units per second
    // no wind in the projection: the trail is a placed thing, not a texture,
    // and the wind's offset would carry its start off the sky
    vec2 uv = rd.xz / rdY * (ALT_HIGH * 1.1);
    vec3 col = mix(vec3(1.0), vec3(1.05, 0.62, 0.55), sunsetF);
    col = mix(vec3(0.25, 0.30, 0.45), col, max(dayF, sunsetF));
    // two planes on clocks half a slot apart, so at full there is always a
    // trail in some state across the sky, and the sky is never bare between
    for (int k = 0; k < 2; k++) {
      float tk = u_time + float(k) * SLOT * 0.5;
      float slot = floor(tk / SLOT) + float(k) * 977.0;
      if (hash11(slot * 3.7) >= u_contrails) continue;
      // the plane has been flying for a minute already when its slot opens,
      // with that much trail behind it, so a first frame is not an empty sky
      float age = fract(tk / SLOT) * SLOT + 60.0;
      float th = hash11(slot * 5.3) * 6.2831853;
      vec2 dir = vec2(cos(th), sin(th));
      vec2 rel = uv - (vec2(hash11(slot * 7.9), hash11(slot * 9.1)) - 0.5) * 5.0;
      float s = dot(rel, dir) + 2.5;                // along the trail, from where it began
      float n = dot(rel, vec2(-dir.y, dir.x));      // across it
      float head = age * SPEED;                     // where the plane is now
      if (s > 0.0 && s < head) {
        float since = (head - s) / SPEED;           // seconds since the plane was here
        float w = 0.012 + since * 0.0004;           // the ice drifts apart
        float body = exp(-n * n / (w * w)) * exp(-since / 150.0);
        body *= 0.55 + 0.45 * vnoise(vec2(s * 6.0, slot));
        OVER(col, body * 0.75 * horizonFade * (1.0 - gloom * 0.8));
      }
    }
  }
#endif
  // Cirrostratus Cs (veil cloud) — a thin veil across the whole sky. Haloes the sun
  if (u_high.y > 0.001 && stack) {
    // the halo below is sky-side and still shows under the horizon; the veil does not
    if (above) {
      vec2 s = stratiform(planeUV(rd, rdY, ALT_HIGH * 0.5, u_windOff * 0.3), 0.35, 0.0);
      vec3 col = mix(vec3(0.86, 0.89, 0.95), vec3(1.02, 0.80, 0.72), sunsetF);
      col = mix(vec3(0.22, 0.26, 0.38), col, max(dayF, sunsetF * 0.8));
      OVER(col, s.x * u_high.y * 0.45 * horizonFade);
    }
    // the 22° halo (refraction through ice crystals). Added light, so it is the
    // one term in this stretch that has to leave display space — and only on
    // the ring itself, where there is something to add
#ifdef FEAT_HALOS
    vec3 halo = iceHalo(rd, el, sunDir, sunAng, sunVis, moonDir, moonAng, moonVis, nightF);
#else
    vec3 halo = vec3(0.0);
#endif
    float haloAmt = halo.r + halo.g + halo.b;
#ifdef CLOUD_SPLIT
    // Mode 0 only: it sits between layers, so the washes so far are applied
    // first and the stack starts over above it. Mode 1 cannot draw it (it has
    // no sky to add to); mode 2 lays it under the whole stack instead
    if (haloAmt > 0.0 && u_cloudMode < 0.5) {
      disp = disp * cT + cC;
      cC = vec3(0.0);
      cT = 1.0;
      disp = encodeSrgb(L(disp) + halo);
    }
#else
    if (haloAmt > 0.0) disp = encodeSrgb(L(disp) + halo);
#endif
  }
  // Cirrocumulus Cc (mackerel sky) — fine grains packed densely up high
  if (u_high.z > 0.001 && above && stack) {
    vec2 g = granular(planeUV(rd, rdY, ALT_HIGH * 5.5, u_windOff * 0.3), 0.55, 1.0, 0.25, ldir);
    vec3 col = cloudColor(g.x, g.y * 0.8, 0.16, dayF, nightM, sunsetF, flash, gloom, 0.5, cloudSun, 1.0);
    OVER(col, g.x * u_high.z * 0.85 * horizonFade);
  }

  // ── Mid layer, 2000–7000m ───────────────────────────
  // Altostratus As (grey veil) — a translucent sheet.
  // Not one uniform film but "torn membranes overlapping in patches", with
  // the sun showing through broadly, outline-less, as if through frosted
  // glass. These two things are altostratus's face.
  if (u_mid.x > 0.001 && above && stack) {
    vec2 uv = planeUV(rd, rdY, ALT_MID * 0.55, u_windOff * 0.6);
    vec2 s = stratiform(uv, 0.50, 0.35);
    // mottling from overlapping membranes. Stretched along the flow, it lines up into bands converging on the horizon
    float fleck = smoothstep(0.40, 0.74, fbm4(uv * vec2(2.4, 4.8) + 41.0));
    float thick = clamp(s.y * 0.62 + fleck * 0.38, 0.0, 1.0);

    vec3 shade  = mix(vec3(0.055, 0.062, 0.078), vec3(0.40, 0.43, 0.51), dayF);
    vec3 bright = mix(vec3(0.10, 0.11, 0.14), vec3(0.90, 0.91, 0.92), dayF);
    bright = mix(bright, bright * vec3(1.12, 0.92, 0.76), sunsetF * 0.8);
    vec3 col = mix(bright, shade, thick);

    // the sun through frosted glass: light wraps around more the closer to
    // the sun's direction and the thinner the membrane. The sun's disc is
    // hidden by the membrane, leaving only a broad, outline-less bloom
    float through = exp(-sunAng * 1.7) * max(dayF, sunsetF * 0.6);
    col += mix(vec3(1.0, 0.98, 0.92), vec3(1.05, 0.72, 0.45), sunsetF)
         * through * (1.0 - thick * 0.75) * 0.85;
    col += flash * vec3(0.75, 0.80, 1.0) * 0.5;

    OVER(col, s.x * u_mid.x * 0.95 * horizonFade);
  }
  // Altocumulus Ac (sheep cloud) — larger than cirrocumulus, with grains shaded individually
  if (u_mid.y > 0.001 && above && stack) {
    vec2 g = granular(planeUV(rd, rdY, ALT_MID * 2.2, u_windOff * 0.6), 0.80, 0.85, 0.35, ldir);
    vec3 col = cloudColor(g.x, g.y, 0.30, dayF, nightM, sunsetF, flash, gloom, 0.9, cloudSun, 0.5);
    OVER(col, g.x * u_mid.y * 0.95 * horizonFade);
  }
  // Nimbostratus Ns (rain cloud) — the rain-bearing cloud. Its undulating base's thickness variation becomes the light/dark directly
  if (u_mid.z > 0.001 && above && stack) {
    vec2 s = stratiform(planeUV(rd, rdY, ALT_MID * 0.30, u_windOff * 0.6), 0.10, 1.0);
    // no direct sunlight reaches it at all, so color can be one-dimensional: "thickness → shade".
    // cloudColor's shadow blending caps at 0.85 and never sinks to the photo's charcoal
    vec3 lit = mix(vec3(0.050, 0.055, 0.068), vec3(0.74, 0.75, 0.76), dayF);
    lit += vec3(0.12, 0.06, 0.03) * sunsetF;
    // real rain clouds sit between "charcoal and mid-grey", never pure black or white.
    // the thicker the cloud, the lower the dark end sinks
    vec3 col = lit * mix(0.74, mix(0.40, 0.20, u_mid.z), s.y);
    col += flash * vec3(0.75, 0.80, 1.0) * 0.6;
    OVER(col, s.x * u_mid.z * 0.99 * horizonFade);
  }

  // ── Cumulonimbus Cb (thunderhead) ──
  //
  // "Pick one height per azimuth, fill below it" — a 1D height profile — can
  // only ever produce a triangular hill. It can't give cauliflower-shaped
  // round bulges, or lateral overhang. Solve it as a 2D field over azimuth
  // and elevation instead.
  //
  // To connect around the full azimuth loop, embed a cylindrical surface
  // ("radius = height") as a 2D noise field. Higher up, the circumference is
  // longer so the mass also spreads wider — which happens to match how a
  // real tower actually spreads.
  float cbAmt = u_low.w * (1.0 - gloom * 0.6);
  // how much of this pixel the tower covers — later layers use it to avoid
  // dragging their translucent fringes across the bright mass
  float cbMask = 0.0;
  if (cbAmt > 0.001 && stack) {
    float azw = az + u_windOff * 0.15;
    vec2 dirc = vec2(sin(azw), cos(azw));
    // "2–3 towers across the whole sky" is a fine distribution. A large
    // radius adds features along the circumference and produces a forest of
    // small towers, so pull this one at a deliberately low frequency only.
    // this also sets a tower's width-to-height proportion: at 1.4 the towers
    // come out as narrow totem-pole pillars — a real cumulonimbus is a
    // mountain about as wide as it is tall
    vec2 acir = dirc * 0.85;
    // the noise must advance the same amount vertically as horizontally *on
    // screen*, or every stroke of texture stretches vertically. Per screen
    // radian, azimuth advances the noise by r/cosθ but elevation only by
    // r'·cosθ (rd.y = sinθ) — so isotropy needs r'/r = 1/cos²θ = 1/(1−rd.y²),
    // whose solution is r = r0·√((1+y)/(1−y)). Anything less (linear,
    // exponential) leaves a residual 1/cos²θ vertical smear that reads as
    // the cloud being painted with a vertical brush
    vec2 cyl = dirc * (2.6 * sqrt((1.0 + rd.y) / max(1.0 - rd.y, 0.045)));

    // which azimuth a tower stands at. Keep the cutoff high for a "stands
    // here and there" distribution (too low connects into a band along the horizon).
    // growth/decay rides on the integrated offset u_evo, not u_time —
    // that lets growth speed be set externally (via StateAnimator's evo
    // speed), and keeps the phase from jumping when the weather changes
    float mass = fbm4(acir + vec2(0.0, u_evo * 0.12));
    // fbm maxima are sometimes knife-ridges crossing the azimuth circle at a
    // steep angle. Raised to a height they become tall needle towers — the
    // most common failure shape. Erode narrow peaks morphologically: clamp
    // to the taller of the two neighbors, which shaves any peak thinner
    // than ~2×0.08 rad and leaves broad mountains untouched
    //
    // Erosion only ever lowers massE, and nothing downstream can tell apart two
    // values at or under 0.42 — the thrust is zero for both, and the veil's
    // spread only starts at 0.50 — so a ring is only sampled while the mass is
    // still standing above that line.
    float massE = mass;
    if (massE > 0.42) {
      float massL = fbm4(vec2(sin(azw - 0.08), cos(azw - 0.08)) * 0.85 + vec2(0.0, u_evo * 0.12));
      float massR = fbm4(vec2(sin(azw + 0.08), cos(azw + 0.08)) * 0.85 + vec2(0.0, u_evo * 0.12));
      massE = min(massE, max(massL, massR));
    }
    // a second, wider erosion ring: a knife-ridge longer than the first
    // ring slips through it and still stands as a needle. The small
    // allowance lets a broad dome rise a little above its shoulders
    if (massE > 0.42) {
      float massL2 = fbm4(vec2(sin(azw - 0.13), cos(azw - 0.13)) * 0.85 + vec2(0.0, u_evo * 0.12));
      float massR2 = fbm4(vec2(sin(azw + 0.13), cos(azw + 0.13)) * 0.85 + vec2(0.0, u_evo * 0.12));
      massE = min(massE, max(massL2, massR2) + 0.06);
    }
    // the tower's thrust. Whether this is peaked or not decides how boxy it looks.
    // left as a gentle hill, a wide range of azimuths reach the same height
    // and the top becomes a flat slab.
    // peaking it makes height drop off sharply across azimuth, so it can
    // stay tall while still narrowing upward
    float env = pow(max(massE - 0.42, 0.0) * 4.6, 1.5);
    // the tropopause. Give it a slight undulation across azimuth (perfectly
    // flat reads as a slab cutting across the sky).
    // if a tower grows past this, its top gets sliced perfectly flat and
    // reads as a slab. Leave the roundness to the tower's own tapering, and
    // place the tropopause at the height "only the tallest tower's tip reaches"
    float anvilTop = 0.62 + 0.16 * cbAmt + (fbm4(acir * 1.6 + 11.0) - 0.5) * 0.10;

    // The silhouette is decided by one formula: "thrust − height".
    //
    // Multiplying a cut by azimuth (a vertical flank) with a cut by height
    // (a flat ceiling) produces a mesa no matter what noise rides on top. If
    // thrust is a gentle hill across azimuth, subtracting height alone
    // naturally narrows it upward, with the top becoming a parabola — a
    // round head. Making the height term quadratic accelerates the tapering
    // higher up, giving a cumulonimbus with a wide base and a round top.
    float rise = env * (1.05 + 1.35 * cbAmt);
    // how far this azimuth's tower reaches (solving rise − (y + 0.8y²) − 1 = 0
    // for y, with hgt = y + 0.6y^2). Used for shading and the companion forms' attachment height
    float towerTop = (sqrt(1.0 + 2.4 * max(rise - 1.0, 0.0)) - 1.0) / 1.2;

    // An azimuth with no thrust at all carries no tower, and the mass below is
    // provably empty there: with rise, near and towerTop all zero the field
    // tops out at 1/2.4 - 1 (the lowest hgt can go, minus one) — nowhere near
    // the -0.11 the edge starts at — and the anvil's flare is gated on
    // towerTop. So the whole lobe stack, the costliest thing in the shader, is
    // skipped for those columns. It is a function of azimuth alone, so the
    // branch splits the frame into clean vertical bands rather than diverging.
    if (env > 0.0) {
      // the mass itself. A domain-warped 2D field does double duty as both
      // silhouette bumpiness and internal grain.
      // warping is meant to break up the overall shape. Applying the same
      // amount at every scale stretches even fine lumps in the same direction,
      // reading as a diagonal smear.
      // weaken the distortion the finer the scale, to keep it round
      vec2 warp = vec2(fbm4(cyl * 1.5 + u_evo * 0.30),
                       fbm4(cyl * 1.5 + 31.0 - u_evo * 0.25));
      vec2 w  = cyl + 0.42 * warp;   // coarse scale
      vec2 wf = cyl + 0.14 * warp;   // fine scale
      // the silhouette is cut from a sum of spheres (round lobes). But spheres
      // have zero high-frequency content, so alone the silhouette becomes an
      // endlessly smooth blob and detail disappears.
      // layer high-frequency noise at small amplitude to fray the edge while keeping the lobes round.
      // the two just handle different sizes — neither can be dropped.
      // lobes need at least 3 scales. With only 2, zooming in reveals no new
      // structure, just a stretched-out smear.
      // cauliflower looking "still cauliflower no matter how close you get" is
      // because the same shape repeats in a nested way.
      // kept separate per scale since shading shifts each one differently
      float bCoarse = blobs(w * 0.62, 0.82);
      float bMid    = blobs(w * 1.55 + 13.0, 0.78);
      float bFine   = blobs(wf * 3.60 + 41.0, 0.74);
      // a fourth octave: real cauliflower is bumps-on-bumps down past what the
      // eye can separate — stopping at three reads as sculpted foam. Each
      // octave roughly halves the size and the weight
      float bMicro  = blobs(wf * 7.60 + 97.0, 0.72);
      // match each scale's contribution between silhouette and shading. If
      // shading alone is strong, it reads as surface blotches/spots rather than lobes.
      // the micro octave joins mean-neutrally: folding it in raw deepens the
      // noise floor, and the deeper valleys punch holes through the mass
      float shape = bCoarse + 0.42 * bMid + 0.34 * bFine + 0.20 * (bMicro - 0.50);
      float fine = fbm(wf * 5.5);

      // the linear term is height, the quadratic term is the "narrowing
      // upward" roundness. The -1.0 bias decides how wide the base is.
      // to stretch height alone, lower the linear term (raising the gain fattens the base too).
      // only let the sphere term act where there's thrust. Otherwise a single
      // sphere clears the threshold even in open sky away from any tower, and
      // a white bubble floats there on its own.
      // but the factor applied must be "smooth" — a sharp mask turns the edge into a straight line
      float near = smoothstep(0.0, 1.2, rise);
      // a very fine fray at the edge. Riding this inside the blurred alpha
      // band gives a "blurry, yet detailed" edge. Cheap: just two vnoise calls
      float wisp = vnoise(wf * 13.0) * 0.62 + vnoise(wf * 27.0 + 7.0) * 0.38;
      // quadratic-in-height taper: the linear term is height, the quadratic
      // term rounds the top. Too strong a quadratic pinches the upper half
      // into a needle — a real tower's head is still ~half the base's width
      float hgt = rd.y + rd.y * rd.y * 0.6;
      float noiseSum = (shape - 0.86) * 1.5 + (fine - 0.47) * 0.72
                     + (wisp - 0.50) * 0.22;
      // negative noise may carve the silhouette at full strength, but keep
      // positive noise weaker: a blob spike reaching far above the envelope
      // becomes a turret floating in open sky, detached from the tower that
      // spawned it. (gating the positive side by height instead smooths the
      // flanks into a bald cone — the bumps live above the local envelope too)
      float field = rise - hgt - 1.0
                  + (min(noiseSum, 0.0) + max(noiseSum, 0.0) * 0.60) * near;
      // and cap how far above the envelope's top any bump may reach: a blob
      // cluster hanging higher than that has open sky under it — it reads as
      // a chunk torn off the tower, not a turret growing out of it
      field -= smoothstep(towerTop + 0.10, towerTop + 0.35, rd.y) * 3.0;
      // well below this azimuth's own top, the mass must stay solid: a lobe
      // valley deep enough to cut the tower in two leaves its head floating in
      // open sky, and sky showing through the middle reads as moth-eaten holes
      // (the real thing is kilometers thick; only its rim is translucent).
      // fades out toward the top so the head keeps its ragged noise silhouette
      field += smoothstep(1.0, 0.60, rd.y / max(towerTop, 1e-3)) * 1.15 * near;
      // ── Anvil cloud (incus) ──
      // A tower with nowhere left to go at the tropopause flares sideways into
      // a mushroom cap. Drawing this as a separate elevation band breaks down —
      // away from the tower the band floats alone in open sky, and near the
      // zenith the cylindrical projection smears it into diagonal streaks.
      // Widening the tower's own silhouette just under the cap inherits the
      // mass's texture, shading and edge treatment, so nothing can detach.
      if (u_cbFeat.x > 0.001) {
        // resample the tower's thrust slightly upwind and fold it in, so the
        // cap spreads asymmetrically, downwind of the tower
        vec2 dircU = vec2(sin(azw + 0.55), cos(azw + 0.55));
        float massU = fbm4(dircU * 0.85 + vec2(0.0, u_evo * 0.12));
        float riseU = pow(max(massU - 0.42, 0.0) * 4.6, 1.5) * (1.05 + 1.35 * cbAmt);
        float reach = max(towerTop, max(riseU - 1.0, 0.0) * 0.47 * 0.85);
        // only azimuths whose tower (or upwind neighbor) got near the
        // tropopause flare out; the elevation window hugs the cap's underside.
        // the upwind term alone must never create mass: over an azimuth whose
        // own tower is stubby it would hang a cap in open sky with nothing
        // beneath it — demand the local tower carries at least half the height
        float flare = smoothstep(anvilTop * 0.50, anvilTop * 0.95, reach)
                    * smoothstep(anvilTop * 0.30, anvilTop * 0.60, towerTop)
                    * smoothstep(anvilTop - 0.26, anvilTop - 0.06, rd.y)
                    * smoothstep(anvilTop + 0.10, anvilTop - 0.02, rd.y)
                    * u_cbFeat.x;
        field += flare * 0.85;
      }
      // carve away only what's above the tropopause. Using min() to cap it
      // gives a perfectly flat ceiling
      field -= smoothstep(anvilTop - 0.06, anvilTop + 0.14, rd.y) * 2.2;
      // the edge should fade thin, not cut sharp — a sharp cut reads as a
      // pasted-on cutout. But too wide a band wraps the whole mass in fog and
      // the cloud never reads as a solid object: photos show a sunlit head
      // whose boundary is crisp with only a thin frayed fringe. Keep the band
      // narrow, and let wisp/fine (already folded into field) supply the fraying
      float m = smoothstep(-0.11, 0.24, field);

      if (m > 0.001) {
        // use the difference against a resample shifted toward the sun as surface orientation.
        // in cylindrical coordinates, dirc is "up"; its perpendicular is "sideways along azimuth"
        vec2 tangent = vec2(dirc.y, -dirc.x) * sin(u_sun.y - azw);
        vec2 lightOff = normalize(tangent + dirc * 0.9 + vec2(1e-4));

        // ── the shift distance must match "that mass's own size" ──
        // shifting less than a lobe's radius leaves both sample points near
        // the same hilltop inside the lobe, and the difference goes to zero.
        // that means a large face's interior has no shading at all — only the
        // rim around it shades, leaving a solid-white interior.
        // shift a coarse lobe by about one lobe's worth, a fine lump by its own size.
        float formBig   = (bCoarse - blobs((w + lightOff * 1.30) * 0.62, 0.82)) * 0.80;
        float formSmall = (bMid    - blobs((w + lightOff * 0.42) * 1.55 + 13.0, 0.78)) * 0.75;
        // shade the finest scale from spheres too. Substituting noise here
        // makes the skin read as swirling fibers instead of a cluster of round lumps
        float formFine = (bFine - blobs((wf + lightOff * 0.164) * 3.60 + 41.0, 0.74)) * 0.70;
        float formMicro = (bMicro - blobs((wf + lightOff * 0.078) * 7.60 + 97.0, 0.72)) * 0.65;
        // let noise handle only the very finest fraying
        float micro = (fine - fbm((wf + lightOff * 0.035) * 5.5)) * 1.6;

        // ── two octaves above the lobes ──
        // per-lobe shading alone caps the light/shadow structure at one lobe's
        // size: any face wider than that averages out to an even speckle and
        // reads as flat. Clusters of lobes must shade together...
        float bHuge = blobs(w * 0.30 + 71.0, 0.85);
        float formHuge = (bHuge - blobs((w + lightOff * 2.60) * 0.30 + 71.0, 0.85)) * 0.85;
        // ...and the mountain as a whole needs a sun side and a shade side:
        // resample the thrust with the azimuth nudged toward the sun — if the
        // mass grows in that direction this flank faces away from the sun
        float shiftA = 0.35 * sin(u_sun.y - azw);
        float massS = fbm4(vec2(sin(azw + shiftA), cos(azw + shiftA)) * 0.85
                           + vec2(0.0, u_evo * 0.12));
        // on a narrow tower the azimuth gradient is steep and this term slams
        // to its clamp, painting the whole spire near-black — fade it out as
        // the local mass thins
        float flank = clamp((mass - massS) * 3.0, -0.55, 0.55)
                    * smoothstep(0.25, 0.85, env);

        // less light reaches lower down the tower. Reference the slowly-varying
        // cap height, not this azimuth's towerTop — that changes abruptly at a
        // spire's flank and paints vertical light/dark seams down the mass
        float depth = 1.0 - smoothstep(0.0, max(anvilTop * 0.8, 0.3), rd.y);

        // walk across three points — white, mid, shadow — keeping the value continuous.
        //
        // The three are the plane layers' own light (cloudLight), so the tower
        // is lit by exactly what lights the cotton beside it: the same cool
        // ambient under the same warm sun by day, the same pink afterglow, the
        // same silver at night, the same diffuse grey under an overcast. It
        // used to carry a palette of its own, with its own sunset tint and its
        // own overcast pull, and the two never agreed on the color of the
        // light: a cream tower in a mauve sky at magic hour, a blue-grey one
        // among white cotton at noon.
        //
        // The luminance is the tower's, not the cotton's. A plane layer's lit
        // face runs well past 1.0 by day and the tone shoulder flattens it to
        // white — that is where its cotton look comes from — but a mass this
        // size needs its lobes modelled, and measured against real photos a
        // sunlit head sits near 0.92 with the shade sinking to about 0.55. So
        // the tower takes the cotton's color at its own authored level: the
        // gain brings a face lit at the cotton's typical lit-ness down to that
        // head, and is 1 at night, where nothing is overexposed.
        vec3 ambient, glow, sunL, shade, moon, leaden;
        float diffuse;
        cloudLight(dayF, nightM, sunsetF, cloudSun, 0.3, ambient, glow, sunL, shade, moon, leaden, diffuse);
        float gain = mix(1.0, 0.82, dayF);
        vec3 face = ambient + glow + sunL * 0.42;
        vec3 hi = (face + moon * 0.7) * gain;
        // the shade is the cotton's thickest shadow — and, as there, an
        // overcast's diffuse light fills it in part way
        vec3 lo = (mix(face, shade, 0.85 * (1.0 - diffuse * 0.45)) + moon * 0.3) * gain;
        // the middle sits toward the light: a lobe's flank is mostly lit, and
        // only its valley reaches the shade
        vec3 mid = mix(lo, hi, 0.70);

        // weight the scales so the coarse lobes carry the shading — letting
        // the fine scales compete washes the big forms out into an even
        // speckle, and the mass reads as porridge instead of cauliflower
        float ndl = flank * 0.75 + formHuge * 0.85 + formBig * 1.10
                  + formSmall * 0.48 + formFine * 0.28 + formMicro * 0.18;
        // clouds are brighter where thicker, from multiple scattering — that's
        // why the edge drops slightly toward grey.
        // this splits a lobe's core into white and its valley into grey, so
        // shading stays tied to lobe shape
        float core = clamp((shape - 0.60) * 0.50, -0.34, 0.36);

        // ── don't make the tone mapping asymmetric ──
        // stacking smoothstep compresses only the bright end toward its
        // ceiling, leaving only the shadows with any gradation. Shadows then
        // read as "holes punched in a white mass" rather than "the shaded side
        // of a lobe". A lobe always has both a lit and a shaded face, so leave
        // equal headroom on both sides
        // diffuse light also flattens the lit/shadow modelling, same as cloudColor.
        // the gain here is the lobes' light/shadow swing: measured on photos a
        // lobe's lit face vs its valley spans ~0.35 in luma — at half that the
        // mass reads as flat fog no matter how good the silhouette is
        float t = clamp((ndl * 0.80 + core) * (1.0 - diffuse * 0.55) + 0.58, 0.0, 1.0);
        vec3 tcol = t < 0.5 ? mix(lo, mid, t * 2.0) : mix(mid, hi, (t - 0.5) * 2.0);
        // apply grain by **multiplication**, last. Adding it into the tonal
        // values instead saturates and disappears in the bright areas;
        // multiplying leaves skin even on a face right at the edge of blowout.
        // multiplicative grain acts at the same ratio whether bright or dark,
        // so it adds "skin" without raising overall contrast
        tcol *= 1.0 + micro * 0.13 + (wisp - 0.5) * 0.09;
        // sink continuously toward the cloud base (never in discrete steps).
        // The base is in the tower's own shadow: no sun reaches it, and no
        // afterglow either — that comes from the sun's side of the sky — so
        // it is lit by the sky's own light alone, halfway into the shade. A
        // replace, not a tint: multiplying the sunlit face down by a cool
        // factor cancels pink against blue and lands on a mud grey, which is
        // exactly what the base turned into at magic hour. The sky-lit color
        // stays clean — blue-grey by day, lavender under the afterglow. Most
        // of the way, not all: the base still catches some light off the
        // ground and the clouds around it
        vec3 base = (mix(ambient, shade, 0.5) + moon * 0.3) * gain;
        tcol = mix(tcol, base, depth * depth * 0.8);
        // the edge is thin, so light passes through it (silver lining — only with direct sun)
        tcol += cloudSun * m * (1.0 - m) * 4.0 * 0.22
              * max(t - 0.45, 0.0) * max(dayF, sunsetF * 0.6) * (1.0 - diffuse);
        // in severe weather the cumulonimbus itself sits inside the storm.
        // leaving it bright here makes a pure-white cloud float in a leaden
        // sky. Pull it toward the same leaden grey as the other layers.
        tcol = mix(tcol, leaden, gloom * 0.85);
        tcol += flash * vec3(0.75, 0.80, 1.0) * 0.55;

        // ── Aerial perspective ──
        // The base of a tower stands tens of kilometres off, behind that much
        // air, and the air scatters the sky's light into the line of sight:
        // the base loses contrast and takes on the horizon's color, while the
        // head, seen through thinner air, stays crisp. That is what lets a
        // real cumulonimbus sit *in* its sky rather than in front of it.
        // Against a backdrop that is the sky, mixing toward the backdrop is
        // the same as letting it through — so this is a cut in the alpha,
        // which the split variant can carry without knowing the sky's color.
        // The path length grows as 1/sin(elevation); haze thickens it only a
        // little, since the haze wash at the end already paints the air's own
        // color over everything.
        float air = 1.0 - exp(-(0.35 + 0.40 * u_haze) * 0.06 / max(rd.y, 0.02));
        // cumulonimbus isn't a cloud-plane projection, so high frequency
        // doesn't blow up near the horizon. Applying the same strong fade as
        // the other layers would dissolve the cloud base into haze and make it vanish.
        float cbFade = smoothstep(-0.02, 0.06, rd.y);
        cbMask = clamp(m, 0.0, 1.0) * 0.97 * cbFade * (1.0 - air);
        OVER(tcol, cbMask);
      }
    }

    // ── Veil cloud (velum) ──
    // A thin, flat cap draped like white cloth over the tower's head.
    //
    // Building this from an elevation band like "|rd.y - constant| < width"
    // makes it structurally a line no matter how frayed the edge gets — it
    // can never have thickness or skin. Use the same sphere field as the
    // tower, but heavily flattened vertically per cylindrical coordinate.
    // Round lobes stretch horizontally and overlap into a "flat mass",
    // giving it thickness variation and skin naturally.
    if (u_cbFeat.y > 0.001) {
      // veil forms as a horizontal sheet at a stable layer, so its height
      // stays roughly constant regardless of azimuth. Scaling it with tower
      // height turns the veil into a zigzag tracing the ridgeline.
      // **what ties it to the tower is presence, not height** — only show it
      // around a tower that actually reaches that high
      float velumY = 0.30 + 0.18 * cbAmt + (fbm4(dirc * 2.2 + 29.0) - 0.47) * 0.05;
      // the reach gate must stay strict: relaxed, the veil stretches into
      // long horizontal streaks across azimuths that hold no real tower
      float reach = smoothstep(velumY * 0.85, velumY * 1.25, towerTop);
      float spread = clamp(max(massE - 0.50, 0.0) * 6.0, 0.0, 1.0) * reach;
      if (spread > 0.02) {
        float dY = rd.y - velumY;
        // cylindrical coordinates flattened vertically by 26×. This multiplier decides how thin the cap is
        vec2 vcyl = dirc * 2.4 + vec2(0.0, dY * 26.0);
        float vb = blobs(vcyl * 0.9 + 61.0, 0.86);
        // the sphere field gives thickness variation; a vertical falloff keeps it from spilling outside the cap
        float vfield = (vb - 0.58) * 1.4 + (spread - 0.42) * 1.7 - abs(dY) * 21.0;
        // a thin veil, so the edge dissolves broadly into the sky
        float v = smoothstep(-0.16, 0.40, vfield) * u_cbFeat.y;
        if (v > 0.001) {
          // lean the same slightly-blue white as the tower's daytime hi —
          // a neutral-warm white here reads as cream against the other layers
          vec3 vcol = mix(vec3(0.11, 0.12, 0.15), vec3(0.935, 0.950, 0.970), dayF);
          vcol = mix(vcol, vcol * vec3(1.10, 0.88, 0.72), sunsetF * 0.8);
          vcol = mix(vcol, vec3(0.21, 0.22, 0.25) * (0.25 + 0.75 * dayF), gloom * 0.85);
          // the underside sinks into shadow, the top face catches the sun
          vcol *= mix(0.80, 1.05, smoothstep(-0.030, 0.024, dY));
          // skin. Multiplicative so it adds texture without changing overall brightness
          float vFray = vnoise(vcyl * 4.2 + 3.0) * 0.6 + vnoise(vcyl * 9.5 + 11.0) * 0.4 - 0.5;
          vcol *= 1.0 + vFray * 0.22;
          OVER(vcol, v * 0.70 * horizonFade);
        }
      }
    }
  }

  // ── Low layer, under 2000m ──────────────────────────
  // Stratocumulus Sc (roll cloud) — large mottled masses, arranged as rolls
  if (u_low.y > 0.001 && above && stack) {
    vec2 g = granular(planeUV(rd, rdY, ALT_LOW * 1.9, u_windOff * 1.2), 1.22, 0.5, 0.78, ldir);
    vec3 col = cloudColor(g.x, g.y, 0.48, dayF, nightM, sunsetF, flash, gloom, 1.05, cloudSun, 0.0);
    OVER(col, g.x * u_low.y * 0.95 * horizonFade);
  }
  // Cumulus Cu (cotton cloud) — dome-shaped billowing lumps. The heaviest layer, so skip it at tiny amounts
  if (u_low.z > 0.02 && above && stack) {
    // ── Cumulus as a slab: a top and a base ──
    // A cumulus is a column standing on a flat base, and seen from below it
    // is two things: a dark flat underside, and a sunlit crown that shows
    // past it. One plane cannot be both. So the same field is read on two
    // planes — the base, and a plane a third higher where only the denser
    // cores still reach — and the two are composited top first, base last
    // (the base is the nearer). Overhead the two project to the same place
    // and the dark base covers the crown but for a lit rim; toward the
    // horizon the crown projects above the base and stands clear of it, a
    // white top over a grey bottom, which is the cumulus of a photograph.
    // The parallax between the planes is what gives the lump its side.
    //
    // during high wind the whole sky wobbles slightly.
    // driven by u_windOff (which only advances in wind) so the phase is
    // continuous across u_time's wrap; at full gust its rate matches the
    // old u_time * 2.3 / 1.7 frequencies
    vec2 wob = u_wind * 0.01 * vec2(
      sin(u_windOff * 10.0 + rd.y * 8.0),
      cos(u_windOff * 7.4 + rd.x * 6.0)
    );
    // the smaller the amount, the higher the threshold — sparse clouds only sprout here and there
    float edge = 0.88 - u_low.z * 0.52;
    // Locality: a real sky's clouds gather — a flock here, a bare stretch
    // there, a street downwind — where a noise field cut at one threshold
    // is evenly peppered everywhere. A much coarser field moves the
    // threshold around the sky, denser in some quarters and sparser in
    // others; it fades out as the cover closes, since a full deck is a deck
    {
      vec2 puv = planeUV(rd, rdY, ALT_LOW * 2.5, u_windOff * 0.7);
      float patch = fbm2(puv * 0.045 + 61.0) - 0.5;
      edge += patch * 0.34 * (1.0 - smoothstep(0.55, 0.9, u_low.z));
    }

    // the crown: the plane above, a narrower threshold so the lumps taper
    // into domes, lit from above and shaded shallowly
    {
      vec2 tuv = planeUV(rd, rdY, ALT_LOW * 2.5 * 1.32, u_windOff) + wob;
      float tedge = edge + 0.07;
      vec3 tl = cloudField(tuv, churn, ldir, tedge, ramp, tedge - 0.01);
      float talpha = tl.x * u_low.z * horizonFade;
      talpha *= 1.0 - cbMask * (1.0 - smoothstep(0.60, 0.97, tl.x)) * 0.92;
      float tthick = smoothstep(tedge, tedge + 0.35, tl.z);
      vec3 tc = cloudColor(tl.x, tl.y + 0.35, tthick * 0.45, dayF, nightM, sunsetF, flash, gloom, 0.7, cloudSun, 0.0);
      OVER(tc, talpha * 0.97);
    }

    // the base: the whole footprint, flat, in the lump's own shadow and lit
    // by the sky — and from the side, by a sun low enough to get under it
    vec2 cuv = planeUV(rd, rdY, ALT_LOW * 2.5, u_windOff) + wob;
    // the veil's skirt reaches lower than the density's, so it sets the floor
    vec3 dl = cloudField(cuv, churn, ldir, edge, ramp, edge - 0.26);
    // a thin, translucent veil cloud: give the density threshold a wide skirt below it
    // (it drifts as a bright haze around the lumps, and in places that never formed one)
    // must scale with the amount, or a residual haze is all that's left in an otherwise cloudless sky
    float veil = smoothstep(edge - 0.26, edge + 0.02, dl.z) * 0.42 * u_low.z;
    float alpha = max(dl.x, veil) * u_low.z * horizonFade;
    // over a cumulonimbus tower, a translucent fringe reads as a dirty
    // smudge stamped onto the bright mass — let only near-opaque cores
    // cross it (a half-dense patch is the worst case: neither cloud nor sky)
    alpha *= 1.0 - cbMask * (1.0 - smoothstep(0.60, 0.97, dl.x)) * 0.92;
    // shade from continuous thickness across the wide ramp, not from the saturated density (den)
    float thick = smoothstep(edge, edge + 0.35, dl.z);
    // the underside takes the sun only when the sun is low enough to reach
    // under it; the rest of the day it is the shade, darkest at the core
    // the rest of the day it is the shade — a soft grey, not a dark one: a
    // cumulus base is lit by the whole sky and by the ground, and photographs
    // of one read as white with grey beneath, not grey with white above
    float under = smoothstep(0.30, 0.02, sunEl);
    float baseLit = mix(-0.30, dl.y, under);
    vec3 c = cloudColor(dl.x, baseLit, max(thick * 0.9, 0.30 * dl.x), dayF, nightM, sunsetF, flash, gloom, 1.0, cloudSun, 0.0);
    OVER(c, alpha * 0.97);

    // fast-moving ragged clouds nearby (fragments of cumulus)
    vec2 fuv = planeUV(rd, rdY, ALT_LOW * 1.2, u_windOff * 1.9) + 51.7;
    float fedge = 0.94 - u_low.z * 0.42;
    vec3 fl = cloudField(fuv, churn * 1.2, ldir, fedge, ramp, fedge - 0.01);
    float falpha = fl.x * u_low.z * horizonFade * (1.0 - cbMask * 0.6);
    float fthick = smoothstep(fedge, fedge + 0.35, fl.z);
    vec3 fc = cloudColor(fl.x, fl.y, fthick, dayF, nightM, sunsetF, flash, gloom, 1.25, cloudSun, 0.0);
    OVER(fc, falpha * 0.95);
  }
  // Stratus St (fog cloud) — hangs low. Denser toward the horizon
  if (u_low.x > 0.001 && above && stack) {
    vec2 s = stratiform(planeUV(rd, rdY, ALT_LOW * 0.5, u_windOff * 1.2), 0.45, 0.45);
    vec3 col = cloudColor(0.95, -0.25, 0.60,
                          dayF, nightM, sunsetF, flash, gloom, 1.2, cloudSun, 0.0) * 0.86;
    float lowBias = mix(1.0, 0.40, smoothstep(0.05, 0.55, rd.y));
    OVER(col, s.x * u_low.x * lowBias * 0.95 * horizonFade);
  }

  // ── Light leaking in under the cloud base ──
  // Even under a thick deck covering the whole sky, right along the horizon
  // distant light having passed beneath the clouds breaks through and
  // brightens things. This single band is usually what sells a rain-cloud sky.
  float deck = max(u_mid.z, max(u_mid.x, u_low.x));
  if (deck > 0.01 && stack) {
    vec3 leak = mix(vec3(0.055, 0.058, 0.066), vec3(0.70, 0.70, 0.63), dayF);
    leak = mix(leak, vec3(0.86, 0.60, 0.40), sunsetF * 0.7);
    float band = smoothstep(0.22, 0.005, rd.y) * smoothstep(-0.02, 0.02, rd.y);
    OVER(leak, band * deck * 0.88);
  }

  // ── Pannus (ragged scud beneath rain clouds) ──
  // Dark fragments racing fast beneath the cloud base. Layering dark shapes
  // over the bright leaking horizon reads as "there's another layer beneath
  // the thick deck", adding depth.
  // Near the horizon the cloud plane's projection diverges and high
  // frequency breaks down, so squeeze this into a band and stretch the
  // threshold's ramp wide to dissolve it into an outline-less haze instead.
  float fband = smoothstep(0.015, 0.075, rd.y) * smoothstep(0.42, 0.10, rd.y);
  if (u_mid.z > 0.02 && fband > 0.001 && stack) {
    vec2 fuv = planeUV(rd, rdY, ALT_LOW * 0.42, u_windOff * 2.4) + 77.0;
    float pedge = 0.90 - u_mid.z * 0.22;
    vec3 fr = cloudField(fuv, churn + 0.45, ldir, pedge, ramp * 2.2, pedge - 0.01);
    vec3 fcol = mix(vec3(0.030, 0.033, 0.040), vec3(0.26, 0.27, 0.29), dayF);
    OVER(fcol, fr.x * u_mid.z * fband * 0.80);
  }

  // ── Applying the stack (the split variant) ──
#ifdef CLOUD_SPLIT
  if (u_cloudMode > 1.5) {
    // Composite: the stack was drawn at its own resolution in mode 1. The 22°
    // halo goes beneath all of it here rather than between the cirrostratus
    // and the layers above — the one place the split departs from one pass
#ifdef FEAT_HALOS
    vec3 halo = iceHalo(rd, el, sunDir, sunAng, sunVis, moonDir, moonAng, moonVis, nightF);
    if (halo.r + halo.g + halo.b > 0.0) disp = encodeSrgb(L(disp) + halo);
#endif
    // sampled where this pixel's ray was cast — after any lens droplet bent
    // it — since mode 1 drew the stack for the undistorted rays over the same
    // 0..1 frame
    vec4 ct = CLOUD_FETCH(p);
    cC = ct.rgb;
    cT = ct.a;
  } else if (u_cloudMode > 0.5) {
    gl_FragColor = vec4(cC, cT);
    return;
  }
  disp = disp * cT + cC;

#ifdef FEAT_RAYS
  // ── Crepuscular rays ──
  // Sunlight through the gaps in a cloud deck lights the air it crosses, and
  // the lit air between the shadows reads as shafts fanning out from the
  // sun. The cloud stack's alpha is the deck's transmittance, pixel by pixel,
  // so a march along the line toward the sun's place on screen, summing what
  // gets through, is how much sunlit air stands between this pixel and the
  // sun — the shadow-volume integral in screen space. Only here, in the
  // composite, where that stack exists to be read; jittered per pixel so the
  // march's steps do not band
  if (u_cloudMode > 1.5 && u_rays > 0.001 && sunVis > 0.0) {
    vec3 proj = projectDir(sunDir, u_cam.x, u_cam.y, u_cam.z, aspect);
    float near = proj.z > 0.0 ? smoothstep(2.4, 1.2, max(abs(proj.x), abs(proj.y))) : 0.0;
    if (near > 0.0) {
      vec2 sunPos = proj.xy * 0.5 + 0.5;
      vec2 dp = sunPos - p;
      const int N = 24;
      float jitter = fract(52.9829189 * fract(0.06711056 * gl_FragCoord.x + 0.00583715 * gl_FragCoord.y));
      float lit = 0.0, wsum = 0.0;
      for (int i = 0; i < N; i++) {
        float f = (float(i) + jitter) / float(N);
        vec2 q = clamp(p + dp * f, 0.0, 1.0);
        float wgt = 1.0 - f * 0.5;
        lit += CLOUD_FETCH(q).a * wgt;
        wsum += wgt;
      }
      // squared: a line half in cloud is a shadow, not half a shaft
      float shaft = lit / wsum;
      shaft *= shaft;
      // the shafts show against the sky near the sun, and most when the sun
      // is low and the air it crosses is long
      float glow = exp(-sunAng * 1.5) * near * sunVis * u_rays
                 * (0.35 + 0.65 * smoothstep(0.6, 0.05, sunDir.y));
      vec3 shaftCol = L(mix(vec3(1.0, 0.95, 0.85), vec3(1.05, 0.62, 0.35), sunsetF));
      disp = encodeSrgb(L(disp) + shaftCol * shaft * glow * 1.2);
    }
  }
#endif
#endif

  // ── Below the horizon ──
  // Out of frame with the default framing; there when looking down and for the
  // skybox's lower hemisphere. A plate of ground, or — u_sea — open water.
  {
    vec3 ground = mix(vec3(0.020, 0.022, 0.028), vec3(0.17, 0.165, 0.150), dayF);
    ground = mix(ground, ground * 0.6, gloom * 0.5);
    ground += vec3(0.06, 0.03, 0.015) * sunsetF * 0.5;
    disp = mix(disp, ground, smoothstep(0.0, -0.05, rd.y) * (1.0 - u_sea.x));
  }

#ifdef FEAT_SEA
  // ── Sea ──
  // Water is a mirror laid flat. What reaches the eye off it is mostly the
  // sky, reflected — nearly all of it at a grazing look, next to none looking
  // straight down (Fresnel), where the water's own dark green-blue shows
  // instead. So the sea takes the color of its hour exactly, and the sun and
  // the moon lay a path across it: their reflection, scattered along the wind
  // by the slopes of the waves. The horizon is a hard line, unlike the
  // ground's — a sea meets the sky at an edge.
  //
  // Only the sky's own color is mirrored (skyBase, skyWeather) plus the sun,
  // the moon and the city glow — not the clouds. At the grazing angles where
  // the mirror is strong the sky it mirrors is the near-horizon sky, where
  // the clouds have already faded; where the clouds would show, the mirror
  // has gone weak. The gate is on the ray alone, so above the horizon this
  // costs nothing.
  if (u_sea.x > 0.001 && rd.y < 0.0) {
    // where the ray meets the water, with the eye one unit above it. The
    // intersection runs off to infinity at the horizon, so each wave's slope
    // is faded out before its length on screen falls under a pixel
    float dist = 1.0 / max(-rd.y, 1e-3);
    vec2 wp = rd.xz * dist;
    // the wind's heading on the water, the one the clouds take
    vec2 wdir = normalize(vec2(1.0, 0.15));
    vec2 wperp = vec2(-wdir.y, wdir.x);
    // ── slopes ──
    // Every temporal frequency below is a whole number of cycles per wrap of
    // u_time (2π·n / 4096), so the sea does not jump when the clock wraps —
    // and each is deep-water dispersion's for its length, with the eye 1.6 m
    // up, so long waves roll and short ones flicker in proportion
    float t = u_time;
    vec2 slope = vec2(0.0);
    // swell: three long waves near the wind's heading, at different lengths
    // so they beat against each other instead of marching in step
    float sw = u_sea.y * (1.0 - smoothstep(200.0, 600.0, dist));
    if (sw > 0.001) {
      slope += waveSlope(wp, (wdir) * 0.157, 0.60 * sw, 0.9802, t);
      slope += waveSlope(wp, (wdir * 0.94 + wperp * 0.34) * 0.233, 0.30 * sw, 1.1996, t);
      slope += waveSlope(wp, (wdir * 0.88 - wperp * 0.48) * 0.105, 0.50 * sw, 0.8008, t);
    }
    // chop: short waves the wind raises, spread wide across its heading. These
    // are what break the sun's image into a path: their slopes reach several
    // degrees even in a light air, where the swell's are long and shallow
    float ch = (0.35 + 0.65 * u_wind) * (1.0 - smoothstep(20.0, 60.0, dist));
    if (ch > 0.001) {
      slope += waveSlope(wp, (wdir * 0.62 + wperp * 0.78) * 2.09, 0.030 * ch, 3.580, t);
      slope += waveSlope(wp, (wdir * 0.71 - wperp * 0.71) * 3.14, 0.018 * ch, 4.390, t);
      slope += waveSlope(wp, (wdir * 0.97 + wperp * 0.26) * 1.40, 0.045 * ch, 2.930, t);
    }
    vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
    vec3 r = reflect(rd, n);
    // a slope steep enough to mirror the water itself is a slope the sea
    // never shows at these amplitudes; keep the mirror pointed at the sky
    r.y = max(r.y, 0.01);

    // ── the far water ──
    // The last kilometres before the horizon sit behind a long reach of air,
    // which scatters the horizon's own light into the line of sight: the
    // water there takes the horizon sky's color and the sea meets the sky
    // through a soft band rather than along a drawn line — the clouds and
    // towers the sky carries above that line are not in the mirror, and a
    // hard line made that plain. A little of it even on the clearest day,
    // and a lot in haze, where a sea horizon goes altogether. Folded into
    // the mirror's direction, bent toward the horizon by that much, so the
    // sky is asked only once; the sun, the moon and the water's own color
    // fade by the same amount below
    float seaFog = 1.0 - exp(-dist * (0.0035 + 0.045 * u_haze));
    vec3 rm = normalize(mix(r, vec3(rd.x, 0.0, rd.z), seaFog));
    rm.y = max(rm.y, 0.005);
    float rel = asin(clamp(rm.y, -1.0, 1.0));
    float rh = clamp(rel / (PI * 0.5), 0.0, 1.0);

    // ── what the mirror shows ──
    float wideSea = 0.0;
    vec3 mir = L(skyWeather(skyBase(rm, rel, rh, sunDir, sunEl, dayF, sunsetF, wideSea), dayF, gloom));
    float clear = 1.0 - seaFog;
    // the sun's path: its disc and halo, as the sky draws them, in the
    // mirrored direction — the waves' slopes are what spread it into a path.
    // The disc is drawn a little wider than in the sky: the water's finest
    // ripples, under the pixels, scatter it that much
    if (sunVis > 0.0) {
      float ang = acos(clamp(dot(r, sunDir), -1.0, 1.0));
      vec3 sunCol = L(mix(vec3(1.0, 0.98, 0.92), vec3(1.05, 0.6, 0.3), sunsetF));
      float core = clamp(exp(-ang * ang * 400.0) * 2.2, 0.0, 1.0);
      mir = mix(mir, vec3(SUN_LUM), core * sunVis * clear);
      mir += sunCol * exp(-ang * 4.0) * 0.22 * sunVis * HALO_LUM * clear;
    }
    // the moon's, at night
    if (moonVis > 0.0) {
      float ang = acos(clamp(dot(r, moonDir), -1.0, 1.0));
      mir += L(vec3(1.0, 0.96, 0.88)) * (smoothstep(0.075, 0.035, ang) * 0.55 + exp(-ang * 18.0) * 0.12)
           * moonVis * u_moon.z * MOON_LUM * clear;
    }
    // the city's glow along the horizon, as the sky carries it
    mir += L(vec3(0.26, 0.16, 0.09)) * exp(-rh * 8.0) * starF
         * (0.4 * (u_sky.x - 1.0) / 5.0) * (1.0 - gloom * 0.6);
#ifdef FEAT_AURORA
    // the aurora, under the same night and cloud as in the sky
    if (u_aurora > 0.001) {
      mir += aurora(r, u_aurora) * AURORA_LUM * clear * starF
           * clamp(1.0 - u_cover * 1.4, 0.0, 1.0) * (1.0 - gloom);
    }
#endif

    // ── the water itself ──
    // Fresnel: how much of the mirror is seen, against how much of the water
    float cosT = clamp(dot(-rd, n), 0.0, 1.0);
    float f1 = 1.0 - cosT;
    float f2 = f1 * f1;
    float fres = 0.02 + 0.98 * f2 * f2 * f1;
    // light off water is polarized — wholly so at Brewster's angle, 37° down —
    // with its e-vector flat along the horizon, which is what a polarizer
    // turned to darken the sky cuts. Cutting the glare off water is the other
    // half of why one is carried
    float brewster = 1.0 - clamp(abs(cosT - 0.60) / 0.60, 0.0, 1.0);
#ifdef FEAT_POLARIZER
    if (u_pol.x > 0.001) mir *= polarizerTransmission(brewster * 0.9, 0.0, polAim);
#endif
    // the body of the water: dark, green-blue, lit by the day; grey under an
    // overcast, murkier in a storm
    vec3 deep = L(mix(vec3(0.010, 0.016, 0.022), vec3(0.030, 0.105, 0.145), dayF));
    deep = mix(deep, L(mix(vec3(0.012, 0.014, 0.017), vec3(0.085, 0.095, 0.105), dayF)),
               smoothstep(0.5, 0.95, u_cover) * 0.8);
    deep = mix(deep, deep * vec3(0.9, 0.85, 0.8), gloom * 0.5);
    // the far water is all air: the water's own color goes with the fog too
    vec3 seaLin = mix(deep, mir, fres + (1.0 - fres) * seaFog);
    //
    disp = mix(disp, encodeSrgb(seaLin), smoothstep(0.0, -0.012, rd.y) * u_sea.x);
  }
#endif

  // ── Rain (thin threads slanting with the wind) ──
  // Laid out along the view ray, not the screen: columns stand at fixed
  // azimuths and the drops run down in elevation, so turning the camera
  // carries the rain with the sky instead of leaving it pasted on the glass.
  // A column of constant azimuth is exactly how a vertical line projects, so
  // looking up, the streaks converge on the zenith the way real rain does.
  //
  // The scales are the old screen-space ones re-expressed per radian — the
  // default framing shows about FALL_REF radians top to bottom — so the rain
  // looks as it did at that framing, and zooming in magnifies it with the sky.
  if (u_rain * u_fall > 0.001) {
    // az (the clouds' azimuth, above) runs -PI..PI, growing to the right on screen
    float cosEl = sqrt(max(0.0, 1.0 - rd.y * rd.y));
    // ordinary rain falls nearly vertical; only high wind slants it strongly
    float slant = mix(0.06, 0.8, smoothstep(0.3, 1.0, u_wind));
    float rain = 0.0;
    for (int i = 0; i < 2; i++) {
      float fi = float(i);
      // a whole number of columns around the horizon, so there is no seam where
      // az wraps. That is due south — the middle of the default framing — and
      // with a whole number the wrap shifts gx by exactly cols, which the mod
      // below folds back onto the same column
      float cols = floor(6.2831853 / FALL_REF * mix(220.0, 380.0, fi));
      float gx = (az - el * slant) / 6.2831853 * cols;
      float gy = el / FALL_REF * mix(2.6, 4.2, fi);
      float colId = mod(floor(gx), cols) + fi * 57.0;
      float drop = fract(gy + u_time * mix(5.5, 8.5, fi) * (0.6 + 0.4 * u_wind) + hash11(colId) * 13.0);
      float active = step(mix(0.9, 0.72, u_rain), hash11(colId * 1.37 + fi * 91.0));
      // columns crowd together by 1/cos(elevation) on screen as they converge
      // upward; keep that fraction of them so the density on screen holds
      active *= step(hash11(colId * 2.71 + fi * 7.0), cosEl);
      // draw only the thin thread down the column's center, at a steady width
      // on screen however narrow the column has become
      float line = smoothstep(0.16, 0.05, abs(fract(gx) - 0.5) * max(cosEl, 0.3));
      rain += active * line * smoothstep(0.24, 0.03, drop) * smoothstep(0.0, 0.015, drop);
    }
    disp = mix(disp, disp * 0.92 + vec3(0.5, 0.55, 0.63) * 0.35,
      clamp(rain, 0.0, 1.0) * u_rain * 0.32 * u_fall);
  }

  // ── Snow ──
  // What actually reads in real snowfall isn't "flakes of one size falling
  // at even spacing". From large, blurred flakes up close to fine ones far
  // away, both size and density scatter continuously with depth. Uniform
  // flake size, or a visible grid, reads as artificial on its own.
  //
  // And another thing: the strongest impression in heavy snow isn't the
  // flakes themselves, but **visibility being whited out**. Drawing flakes
  // alone reads as "white dots floating in a clear sky".
  //
  // The flakes live in a lattice of view directions — the ray scaled out to a
  // sphere and cut into cubic cells — rather than on the screen, so they turn
  // with the sky and there is no pole or seam anywhere to look at. They fall
  // in world y: across the view near the horizon, and straight at the camera
  // looking up. The layer scales are the old screen-space ones per radian (see
  // FALL_REF at the rain), so the default framing looks as it did.
  if (u_snow > 0.001) {
    float flakes = 0.0;
    if (u_fall > 0.001) {
      for (int i = 0; i < 5; i++) {
        float fi = float(i);
        float k = fi * 0.25;                    // 0=near, 1=far
        // apply with a square so it gets rapidly finer with distance (linear reads as uniform size)
        float sc = mix(8.0, 160.0, k * k);
        float fall = u_time * mix(0.30, 0.035, k);

        // a per-layer offset keeps the five lattices from lining up
        vec3 g = rd * (sc / FALL_REF) + fi * vec3(0.37, 0.61, 0.23);
        g.y += fall * sc;
        // drift with the wind, and tumble side to side while falling
        g.x += (u_wind * fall * 2.6 + sin(g.y * 0.22 + fi * 2.7) * 0.35) * sc * 0.06;
        // shift each horizontal slab of cells. Without this the lattice
        // shows straight through as "flakes falling at even spacing"
        g.x += hash11(floor(g.y) * 1.37 + fi * 13.0) * 4.0;
        g.z += hash11(floor(g.y) * 2.71 + fi * 7.0) * 4.0;

        vec3 cell = floor(g);
        vec2 ch = cell.xz + cell.y * vec2(37.1, 91.7);
        float r = hash12(ch + fi * 37.0);
        // only flakes near the sphere are drawn (see the gate below), so
        // more cells are switched on to keep the old density on screen
        float active = step(1.0 - min(1.0, (1.0 - mix(0.94, 0.40, u_snow)) * 2.4), r);
        // scatter position across the whole cell (centering it makes the grid stand out)
        vec3 off = vec3(hash12(ch + 5.1), hash12(ch + 9.7), hash12(ch + 13.3)) * 0.9 + 0.05;
        vec3 dv = fract(g) - off;
        // Size is the distance across the view alone. How far the flake sits
        // off the sphere along the ray instead decides whether it is drawn:
        // a flake far off it belongs to a cell the sphere only grazes, and
        // would show as the cell's cut edge — a shard — rather than a disc.
        // Heavy snow has every cell on already, so there the gate widens to
        // keep the density, at the price of a few shards in the whiteout
        float dr = dot(dv, rd);
        float d = length(dv - rd * dr);
        float gate = smoothstep(0.30, 0.15, abs(dr) / mix(1.0, 1.6, smoothstep(0.7, 1.0, u_snow)));
        // bigger, blurrier-edged and fainter up close (out of focus)
        float rad = mix(0.40, 0.10, k);
        float edge = mix(0.10, 0.72, k);
        flakes += active * gate * smoothstep(rad, rad * edge, d) * mix(0.55, 1.0, k);
      }
    }
    disp = mix(disp, vec3(0.95, 0.96, 1.0), clamp(flakes, 0.0, 1.0) * u_snow * 0.85 * u_fall);

    // the snowfall itself whites out visibility — flakes alone don't sell the impression of heavy snow.
    // a snowy sky is bright grey, unlike a rain cloud, so lift it here
    vec3 whiteout = mix(vec3(0.28, 0.30, 0.34), vec3(0.92, 0.93, 0.95), dayF);
    disp = mix(disp, whiteout, u_snow * 0.55);
  }

  // back to linear light for the flash, which adds
  sky = L(disp);

  // lightning's glow reflected across the whole sky
  sky += flash * L(vec3(0.85, 0.9, 1.1)) * (0.18 + 0.3 * (1.0 - h)) * FLASH_LUM;
  // the blue-white of a flash already runs past 1.0 and gets clipped; in P3 more
  // of it survives. Claimed at the glow's own weight, so it covers the whole sky
  // during a flash and nothing between flashes
  wide = max(wide, clamp(flash * (0.18 + 0.3 * (1.0 - h)), 0.0, 1.0) * 0.7);

#ifdef FEAT_BOLT
  // ── The bolt ──
  // The flash lights the clouds from inside; now and then the channel itself
  // shows beneath the base — a crooked line down to the horizon with a fork
  // off it, there for a few frames and gone, a white-violet core in a blue
  // glow, flickering as the return strokes follow. Drawn in ray space at a
  // fixed azimuth, so it stands in the sky as the view swings, and after the
  // clouds, which it hangs below. Every other slot or so; the rest are the
  // sheet lightning the flash alone is
  if (flash > 0.0 && ltPh < 0.10 && hash11(ltCell * 3.3) > 0.4) {
    float azB = hash11(ltCell * 5.9) * 6.2831853;           // where it strikes
    float top = 0.18 + hash11(ltCell * 7.1) * 0.25;         // the base it comes out of
    float dAz = az - azB;
    dAz -= 6.2831853 * floor(dAz / 6.2831853 + 0.5);        // the short way round
    // the channel wanders as it comes down: three octaves along the elevation
    float wob = (vnoise(vec2(el * 9.0, ltCell)) - 0.5) * 0.12
              + (vnoise(vec2(el * 31.0, ltCell + 7.0)) - 0.5) * 0.04
              + (vnoise(vec2(el * 90.0, ltCell + 13.0)) - 0.5) * 0.015;
    float dx = (dAz - wob) * sqrt(max(1.0 - rd.y * rd.y, 0.0));   // across it, in sky radians
    float span = smoothstep(top + 0.02, top - 0.04, el) * smoothstep(-0.01, 0.02, el);
    float core = exp(-dx * dx / 0.000004) * span;
    float glow = exp(-abs(dx) * 60.0) * span;
    // a fork leaving the channel partway down, leaning off to one side
    float forkAt = top * (0.35 + 0.4 * hash11(ltCell * 11.3));
    float lean = (hash11(ltCell * 2.7) - 0.5) * 2.0;
    float fdx = dx - (forkAt - el) * lean;
    float below = step(el, forkAt);
    float fork = (exp(-fdx * fdx / 0.000003) * 0.8 + exp(-abs(fdx) * 90.0) * 0.5)
               * smoothstep(forkAt - 0.14, forkAt - 0.02, el) * below * span;
    float strobe = 0.55 + 0.45 * step(0.5, fract(ltPh * 60.0 + ltCell));
    vec3 bolt = (L(vec3(0.95, 0.90, 1.0)) * (core + fork)
               + L(vec3(0.55, 0.60, 1.0)) * glow * 0.25) * strobe * FLASH_LUM * 1.5;
    sky += bolt;
    wide = max(wide, min(core + fork, 1.0) * 0.5);
  }
#endif

#ifdef FEAT_RAINBOW
  // ── Rainbow ──
  // Sunlight sent back by the raindrops: a ring 42° from the point opposite
  // the sun, red on the outside, and a fainter second ring outside it with
  // the colors reversed; between the two the air sends back less and the
  // sky is a shade darker — Alexander's band. Needs the rain and the sun at
  // once, so a downpour under a full deck shows none; a shower with the sun
  // out behind the camera is the sky it was made for. Drawn after the
  // clouds: the rain falls beneath them
  if (u_rain > 0.01 && sunVis > 0.0) {
    float ang = acos(clamp(-dot(rd, sunDir), -1.0, 1.0));
    // a light shower is bow enough; what the gloom took from the sun's disc
    // it takes from the bow only in part — a bow stands against dark rain
    float amt = smoothstep(0.03, 0.25, u_rain) * sqrt(sunVis) * smoothstep(-0.02, 0.06, rd.y);
    float t1 = (ang - 0.7086) / 0.0297;                // 40.6°..42.3°, violet to red
    float t2 = 1.0 - (ang - 0.878) / 0.056;             // 50.3°..53.5°, red to violet
    float bow1 = smoothstep(-0.2, 0.15, t1) * smoothstep(1.25, 0.95, t1);
    float bow2 = smoothstep(-0.2, 0.15, t2) * smoothstep(1.25, 0.95, t2);
    vec3 bows = spectrum(clamp(t1, 0.0, 1.0)) * bow1 + spectrum(clamp(t2, 0.0, 1.0)) * bow2 * 0.35;
    float dark = smoothstep(0.73, 0.76, ang) * smoothstep(0.90, 0.87, ang);
    sky *= 1.0 - dark * amt * 0.12;
    sky += L(bows) * amt * 0.55;
    wide = max(wide, min(bow1 + bow2, 1.0) * amt * 0.6);
  }
#endif

  // ── Haze/mist (the shorter the visibility, the further out — toward the horizon — it crushes white) ──
  if (u_haze > 0.001) {
    vec3 hazeCol = mix(vec3(0.10, 0.11, 0.13), vec3(0.78, 0.80, 0.83), dayF);
    hazeCol = mix(hazeCol, hazeCol * vec3(1.10, 0.98, 0.90), sunsetF * 0.7);
    hazeCol = mix(hazeCol, hazeCol * vec3(0.38, 0.40, 0.45), gloom);
    // thin haze only crushes the horizon; the thicker it gets, the higher it climbs toward the zenith, covering the whole sky
    float reach = mix(0.22, 1.0, u_haze * u_haze);
    // measured from the horizon either way: the ground and the water close
    // below the eye sit behind as little air as the sky high above it
    float hh = clamp(abs(el) / (PI * 0.5), 0.0, 1.0);
    float hz = u_haze * mix(1.0, reach, smoothstep(0.0, 0.45, hh));
    // cutting haze is half the reason to carry the filter — by as much as
    // the filter actually took from this pixel's sky, so a ring turned to
    // brighten the band leaves the haze alone
    hz *= 1.0 - max(polCut, 0.0) * 0.6;
    sky = overlay(sky, hazeCol, clamp(hz, 0.0, 0.96));
  }

  // ── Lens flare (only while the sun is on screen. An artifact inside the lens, so screen space) ──
  if (sunVis * u_lensFx > 0.001) {
    vec3 proj = projectDir(sunDir, u_cam.x, u_cam.y, u_cam.z, aspect);
    if (proj.z > 0.0) {
      vec2 sunPos = proj.xy * 0.5 + 0.5;
      vec2 axis = vec2(0.5, 0.5) - sunPos;   // the optical axis from the sun to screen center
      // weaken the further it strays off-screen
      float onScreen = smoothstep(1.6, 0.9, max(abs(proj.x), abs(proj.y)));
      float fl = sunVis * smoothstep(0.02, 0.18, sunEl) * onScreen;
      vec3 flare = vec3(0.0);
      // ghosts lined up along the optical axis (each a different color, from chromatic aberration)
      flare += L(vec3(1.0, 0.75, 0.45)) * 0.055 * ghost(p, sunPos + axis * 0.45, 0.030, aspect);
      flare += L(vec3(0.45, 1.0, 0.60)) * 0.045 * ghost(p, sunPos + axis * 0.75, 0.018, aspect);
      flare += L(vec3(0.55, 0.65, 1.0)) * 0.050 * ghost(p, sunPos + axis * 1.35, 0.055, aspect);
      flare += L(vec3(1.0, 0.55, 0.75)) * 0.035 * ghost(p, sunPos + axis * 1.80, 0.095, aspect);
      // a large, faint colored ring
      float rg = length((p - (sunPos + axis * 1.1)) * vec2(aspect, 1.0));
      flare += L(vec3(0.9, 0.75, 1.0)) * 0.030 * smoothstep(0.012, 0.0, abs(rg - 0.16));
      // an anamorphic-ish horizontal streak
      vec2 dsun = (p - sunPos) * vec2(aspect, 1.0);
      flare += L(vec3(0.8, 0.85, 1.0)) * 0.10 * exp(-abs(dsun.y) * 60.0) * exp(-abs(dsun.x) * 4.0);
      sky += flare * fl;
    }
  }

  // the droplet rim and the vignette are both display-space, so they share one encode
  disp = encodeSrgb(sky);

  // the rim of a lens droplet: bleeds slightly dark
  if (dropMask > 0.0) {
    disp = mix(disp, disp * 0.88 + vec3(0.03), clamp(dropMask, 0.0, 1.0) * 0.55);
  }

  // ── Vignette ──
  // Display-referred, unlike the polarizer above. A polarizer is a real
  // transmission and belongs in linear light; a vignette is a chosen falloff that
  // was dialled in on encoded values, and multiplying linear light by the same
  // factor lands visibly weaker (0.5 goes to 0.48 instead of 0.45).
  sky = L(disp * (1.0 - 0.22 * u_lensFx * length(p - vec2(0.5, 0.45))));

  // ── Linear light → display ──
  // Everything above this line is linear scene light and may run far past 1.0
  // (the sun's core, a lightning flash). Everything below is display-referred:
  // the film grade, the gamut conversion and the dither all keep their original
  // meaning only in encoded values, so they stay on this side of the encode.
  sky = encodeSrgb(tonemap(max(sky, 0.0)));

  // ── Color filter ──
  if (u_filtAmt > 0.001) {
    float lum = dot(sky, vec3(0.2126, 0.7152, 0.0722));
    vec3 g = mix(vec3(lum), sky, u_filtSat) * u_filtTint;
    g = g * (1.0 - u_filtLift) + u_filtLift;   // lift only the blacks (whites don't move)
    sky = mix(sky, g, clamp(u_filtAmt, 0.0, 1.0));
  }

  // ── Wide gamut ──
  if (u_p3 > 0.5) {
    // Reading the untransformed values as P3 numbers gives "the same nominal
    // color, at the highest purity P3 can express" — so reaching past sRGB is
    // exactly undoing part of the conversion. wide=0 is appearance-preserving,
    // wide=1 degenerates to the naive over-saturated flip; nothing in between
    // can blow up, and no new color literal is needed.
    sky = mix(srgbToDisplayP3(sky), sky, clamp(wide, 0.0, 1.0) * ${GAMUT_REACH.toFixed(4)});
  }

  // dither (to prevent banding). Last, so it lands in whatever space the 8-bit
  // drawing buffer actually quantizes
  sky += (hash12(gl_FragCoord.xy + fract(u_time)) - 0.5) * (2.0 / 255.0);

  gl_FragColor = vec4(sky, 1.0);
}
`;

/**
 * How `vnoise` reads the lattice, decided per context.
 *
 * `texture2D` in a fragment shader carries an implicit derivative — it has to
 * pick a mip level, even for a texture that has none — and a derivative is
 * undefined inside non-uniform control flow. So D3D will not let one sit in a
 * branch, and ANGLE resolves that by flattening: every `if (u_high.x > 0.001)`
 * in this shader stops being a skip, and a clear sky starts paying for all ten
 * cloud genera. Measured on a Radeon 780M at 880x495: 1.14 ms for a clear sky
 * became 4.57 ms, exactly the cost of an overcast one.
 *
 * Naming the level instead asks for no derivative, and the branches go back to
 * branching. Where the extension is missing the plain fetch still draws the
 * right picture — it just pays the flattened cost, the way it would have with
 * the arithmetic hash this replaced.
 */
function fragSource(explicitLod: boolean, split: boolean, key: number): string {
  let defines = '';
  for (const [bit, name] of FEATURE_DEFINES) if (key & bit) defines += `#define ${name}\n`;
  // an #extension directive has to precede every non-preprocessor token
  return (explicitLod
    ? '#extension GL_EXT_shader_texture_lod : enable\n'
      + '#define NOISE_FETCH(uv) texture2DLodEXT(u_noise, (uv), 0.0)\n'
    : '#define NOISE_FETCH(uv) texture2D(u_noise, (uv))\n'
  ) + (explicitLod
    // the composite's read of the cloud stack sits in a branch too; same reason
    ? '#define CLOUD_FETCH(uv) texture2DLodEXT(u_clouds, (uv), 0.0)\n'
    : '#define CLOUD_FETCH(uv) texture2D(u_clouds, (uv))\n'
  ) + (split ? '#define CLOUD_SPLIT\n' : '') + defines + FRAG;
}

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
} as const;

const FEATURE_DEFINES: [number, string][] = [
  [FEATURE.SEA, 'FEAT_SEA'],
  [FEATURE.AURORA, 'FEAT_AURORA'],
  [FEATURE.CONTRAILS, 'FEAT_CONTRAILS'],
  [FEATURE.RAYS, 'FEAT_RAYS'],
  [FEATURE.HALOS, 'FEAT_HALOS'],
  [FEATURE.RAINBOW, 'FEAT_RAINBOW'],
  [FEATURE.BOLT, 'FEAT_BOLT'],
  [FEATURE.DARKSKY, 'FEAT_DARKSKY'],
  [FEATURE.POLARIZER, 'FEAT_POLARIZER'],
];

/** every feature compiled in: the one program the renderer used to be */
export const ALL_FEATURES = 511;

/**
 * Which features a state needs drawn — the key of the shader variant that
 * draws it. Each test is the same threshold the shader's own gate uses, so a
 * feature is compiled in exactly when it would be drawn.
 */
export function featureKey(s: AtmosphereState, rays = 0): number {
  let k = 0;
  if (s.ground.sea > 0.001) k |= FEATURE.SEA;
  if (s.celestial.aurora > 0.001) k |= FEATURE.AURORA;
  if (s.particles.contrails > 0.001) k |= FEATURE.CONTRAILS;
  if (rays > 0) k |= FEATURE.RAYS;
  if (s.clouds.cirrostratus > 0.001) k |= FEATURE.HALOS;
  if (s.rain > 0.01) k |= FEATURE.RAINBOW;
  if (s.thunder > 0.001) k |= FEATURE.BOLT;
  if (s.celestial.bortle < 6 || s.celestial.milkyWay > 0.001) k |= FEATURE.DARKSKY;
  if (s.polarizer.strength > 0.001) k |= FEATURE.POLARIZER;
  return k;
}

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

type Uniforms = Record<string, WebGLUniformLocation | null>;

const UNIFORM_NAMES = [
  'u_noise',
  'u_frame', 'u_aspect', 'u_time', 'u_cam', 'u_sun', 'u_moon',
  'u_cover', 'u_high', 'u_mid', 'u_low',
  'u_rain', 'u_snow', 'u_wind', 'u_thunder', 'u_haze', 'u_cbFeat',
  'u_windOff', 'u_evo',
  'u_filtAmt', 'u_filtTint', 'u_filtSat', 'u_filtLift',
  'u_p3', 'u_headroom', 'u_tone', 'u_pol', 'u_sky', 'u_radiant', 'u_lensDrops', 'u_lensFx', 'u_fall',
  'u_sea', 'u_aurora', 'u_contrails', 'u_rays', 'u_sunset',
  'u_cloudMode', 'u_clouds',
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
   * Giving it at all — 1 included — compiles a variant of the shader that can
   * split, and only that makes it changeable at run time through that
   * setter. Left out, the shader is the one-pass one, untouched: the split
   * variant costs that pass 6-16% just by carrying the code.
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
  // whether the first drawable variant has been reported through onReady
  private reported = false;
  private parallel: { COMPLETION_STATUS_KHR: number } | null = null;
  private explicitLod = false;
  private buffer: WebGLBuffer | null = null;
  private noise: WebGLTexture | null = null;
  // the light probe's offscreen target, made on first use and resized to the layout
  private probeFbo: WebGLFramebuffer | null = null;
  private probeTex: WebGLTexture | null = null;
  private probeSize: [number, number] = [0, 0];
  private probePixels: Uint8Array | null = null;
  // the cloud stack's own target, when cloudScale < 1 (see RendererOptions.cloudScale)
  private cloudScaleWanted: number;
  private raysWanted: number;
  // whether the program is the split variant: decided once, at construction
  private readonly split: boolean;
  private cloudSupport: boolean | null = null;   // null = not asked yet on this context
  private cloudFbo: WebGLFramebuffer | null = null;
  private cloudTex: WebGLTexture | null = null;
  private cloudSize: [number, number] = [0, 0];
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
    this.split = options.cloudScale !== undefined;
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
    return !!this.variants.get(this.wanted)?.linked || this.current !== null;
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
   * takes effect on the next frame — but only on a renderer constructed with
   * {@link RendererOptions.cloudScale} (any value, 1 included), which is what
   * compiles the split variant of the shader. Without it this stays 1.
   */
  get cloudScale(): number {
    return !this.split || this.cloudSupport === false ? 1 : clampCloudScale(this.cloudScaleWanted);
  }
  set cloudScale(v: number) { this.cloudScaleWanted = v; }

  /**
   * The crepuscular rays' strength in effect — see {@link RendererOptions.rays}.
   * 0 on a renderer built without `cloudScale`, whatever was asked for.
   */
  get rays(): number {
    return !this.split || this.cloudSupport === false ? 0 : Math.min(1, Math.max(0, this.raysWanted));
  }
  set rays(v: number) { this.raysWanted = v; }

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
    // On Windows, linkProgram is where ANGLE hands the whole shader to the
    // D3D compiler, and reading LINK_STATUS is what waits for it. Asking the
    // driver whether it's finished instead keeps the page alive through it.
    this.parallel = this.opts.compile === 'sync'
      ? null
      : gl.getExtension('KHR_parallel_shader_compile');

    this.noise = this.createNoise(gl);

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
      this.wanted = ALL_FEATURES;
      this.ensure(ALL_FEATURES);
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
    const key = this.opts.variants === false ? ALL_FEATURES : featureKey(s, this.rays);
    if (this.current === null) this.wanted = key;
    this.ensure(key);
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
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('atmosphere shader compile error:', gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, fragSource(this.explicitLod, this.split, key));
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
    let best: Variant | null = null;
    for (const v of this.variants.values()) {
      if (v.linked && (v.key & key) === key && (!best || popcount(v.key) < popcount(best.key))) best = v;
    }
    return best ?? (this.current?.linked ? this.current : null);
  }

  /** drop the least recently drawn variants past the cap, never the one in use */
  private evict(): void {
    const gl = this.gl;
    if (!gl) return;
    while (this.variants.size > MAX_VARIANTS) {
      let victim: Variant | null = null;
      for (const v of this.variants.values()) {
        if (v === this.current || v.key === this.wanted || !(v.linked || v.failed)) continue;
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
      let pending = false;
      for (const v of this.variants.values()) {
        if (v.linked || v.failed) continue;
        if (gl.getProgramParameter(v.program, parallel.COMPLETION_STATUS_KHR)) this.finishLink(v);
        else pending = true;
      }
      if (pending) this.poll = setTimeout(step, POLL_MS);
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
    v.linked = true;
    if (!this.reported && v.key === this.wanted) {
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
    }
    this.variants = new Map();
    this.current = null;
    this.noise = null;
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
    this.canvas.width = width;
    this.canvas.height = height;
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
    const gl = this.bind(timeSec, s, windOff, evo);
    if (!gl) return;
    const u = this.u;
    const w = this.canvas.width, h = this.canvas.height;
    const query = this.beginTiming(w * h);
    gl.uniform1f(u.u_aspect, w / Math.max(1, h));
    gl.uniform3f(u.u_cam, camera.yaw, camera.pitch, camera.fov);

    // the cloud stack on its own, at its own resolution (mode 1), then the
    // frame with that stack laid in (mode 2) — or the frame in one pass (mode
    // 0), which is also what a cloudless frame takes: the same picture, and
    // none of the split's two extra steps
    let mode = 0;
    const scale = this.cloudScale;
    // the rays are read off the cloud stack's target, so they too want the split
    if ((scale < 1 || this.rays > 0) && hasCloudStack(s.clouds)) {
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
    gl.uniform1f(u.u_lensFx, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (query) this.timer!.endQueryEXT(this.timer!.TIME_ELAPSED_EXT);
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
    const gl = this.bind(timeSec, s, windOff, evo);
    if (!gl || !this.probeTarget(gl, layout)) return null;
    const u = this.u;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.probeFbo);
    // sRGB regardless of the canvas: these numbers leave the GPU for someone
    // else's pipeline, and sRGB is the one every consumer assumes
    gl.uniform1f(u.u_p3, 0);

    const fw = layout.cols * PROBE_SUB, fh = layout.frameHeight;
    gl.viewport(0, 0, fw, fh);
    gl.uniform4f(u.u_frame, 0, 0, fw, fh);
    gl.uniform1f(u.u_aspect, this.canvas.width / Math.max(1, this.canvas.height));
    gl.uniform3f(u.u_cam, camera.yaw, camera.pitch, camera.fov);
    gl.uniform1f(u.u_lensDrops, s.lens.droplets);
    gl.uniform1f(u.u_lensFx, 1);
    // one pass: at a few dozen pixels there is nothing to save by splitting
    gl.uniform1f(u.u_cloudMode, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (layout.environment) {
      gl.uniform1f(u.u_aspect, 1);
      gl.uniform1f(u.u_lensDrops, 0);
      gl.uniform1f(u.u_lensFx, 0);
      CUBE_FACE_CAMERAS.forEach((face, i) => {
        gl.viewport(i * PROBE_FACE, fh, PROBE_FACE, PROBE_FACE);
        gl.uniform4f(u.u_frame, i * PROBE_FACE, fh, PROBE_FACE, PROBE_FACE);
        gl.uniform3f(u.u_cam, face.yaw, face.pitch, face.fov);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      });
    }

    const px = this.probePixels!;
    gl.readPixels(0, 0, layout.width, layout.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    return summarizeProbe(px, layout);
  }

  /**
   * Make the program current and upload everything that follows the state —
   * the part render() and probe() share. Returns null when there is nothing to
   * draw with yet.
   */
  private bind(timeSec: number, s: AtmosphereState, windOff: number, evo: number): WebGLRenderingContext | null {
    const gl = this.gl;
    if (!gl || this.lost) return null;
    const v = this.pick(this.opts.variants === false ? ALL_FEATURES : featureKey(s, this.rays));
    if (!v) return null;
    this.current = v;
    v.used = ++this.frame;
    this.u = v.u;
    // bind every frame rather than only at init: another renderer sharing this
    // canvas (or anything else touching the context) may have swapped programs
    gl.useProgram(v.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.noise);
    const u = this.u;
    gl.uniform1f(u.u_time, timeSec % TIME_WRAP_SEC);
    gl.uniform2f(u.u_sun, s.sunElevation, s.sunAzimuth);
    gl.uniform3f(u.u_moon, s.moonElevation, s.moonAzimuth, s.moonPhase);
    const c = s.clouds;
    gl.uniform1f(u.u_cover, s.cloudCover);
    gl.uniform3f(u.u_high, c.cirrus, c.cirrostratus, c.cirrocumulus);
    gl.uniform3f(u.u_mid, c.altostratus, c.altocumulus, c.nimbostratus);
    gl.uniform4f(u.u_low, c.stratus, c.stratocumulus, c.cumulus, c.cumulonimbus);
    gl.uniform1f(u.u_rain, s.rain);
    gl.uniform1f(u.u_snow, s.snow);
    gl.uniform1f(u.u_fall, s.particles.precipitation);
    gl.uniform2f(u.u_sea, s.ground.sea, s.ground.swell);
    gl.uniform2f(u.u_sunset, s.sunset.warmth, s.sunset.glow);
    gl.uniform1f(u.u_wind, s.wind);
    gl.uniform1f(u.u_thunder, s.thunder);
    gl.uniform1f(u.u_haze, s.haze);
    gl.uniform2f(u.u_cbFeat, s.features.anvil, s.features.velum);
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
    return gl;
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
      this.freeProbe(gl);
      this.freeClouds(gl);
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
  }
}
