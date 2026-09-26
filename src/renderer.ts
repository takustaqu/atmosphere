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
 * Angle 0 is the crossed orientation, the one that kills the polarized component
 * and darkens the sky. Rotating by 90 degrees passes it instead and the same band
 * brightens, which is exactly what happens when you turn the ring on a real one.
 */
float polarizerTransmission(float dop, float ePhi) {
  float d = sin(ePhi - u_pol.y);
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
  float width = mix(0.0019, 0.0016, clamp(u, 0.0, 1.0));
  float core = exp(-(perp * perp) / (width * width));

  float u01 = clamp(u, 0.0, 1.0);
  float prof = smoothstep(0.0, 0.07, u01) * (1.0 - smoothstep(0.30, 1.0, u01));
  // decay on age, not position, so the tail is left behind rather than towed
  prof *= exp(-(back / max(span, 1e-4) * FLIGHT) * 3.2);

  // It burns out over a long, smooth ramp while still moving, so there is never a
  // frame where it is stationary and visible. Squared so the last of it goes
  // gently rather than stepping off.
  float burn = 1.0 - smoothstep(BURN_IN, BURN_OUT, travel);
  burn *= burn;
  float life = smoothstep(0.0, 0.035, ph) * burn;

  float hue = hash11(slot * 17.3);
  vec3 trailCol = hue < 0.38 ? vec3(0.62, 1.00, 0.70)
                : hue < 0.72 ? vec3(1.00, 0.88, 0.55)
                             : vec3(0.86, 0.92, 1.00);
  vec3 col = mix(trailCol, vec3(1.0), (1.0 - smoothstep(0.0, 0.30, u01)) * 0.7);

  return col * core * prof * life * (0.55 + 0.45 * hash11(slot * 13.9));
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
  return f * smoothstep(0.32, 0.62, fbm4(uv * 0.20 + 13.0));   // sparseness of the strands
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

// cloud color (lighting shared by every layer)
vec3 cloudColor(float den, float lit, float thick, float dayF, float nightF, float sunsetF,
                float flash, float gloom, float darkMul, vec3 cloudSun) {
  // under full overcast there's no direct sunlight, only diffuse light:
  // weaken the lit/shadow contrast, the base shadow, and the silver lining together
  float diffuse = smoothstep(0.55, 0.95, u_cover);
  float litE = lit * (1.0 - diffuse * 0.75);
  vec3 ambient = mix(vec3(0.035, 0.045, 0.07), vec3(0.68, 0.73, 0.82), dayF);
  // magic hour: the sky's afterglow tints clouds a faint pink even after sunset
  ambient += vec3(0.30, 0.17, 0.13) * sunsetF * (1.0 - dayF);
  // sunset colors linger on clouds right after sundown too
  float sunAmt = max(dayF, sunsetF * 0.55);
  // the lit face
  vec3 c = ambient + cloudSun * sunAmt * (0.42 + 0.45 * litE);
  // shadow from thickness: instead of a flat grey, sink smoothly into a
  // blue-tinted shadow color (ambient light from the sky) as thickness increases
  float sh = thick * (0.62 - diffuse * 0.28) * darkMul;
  sh *= 0.75 + 0.25 * (1.0 - litE);   // the sun-facing side has a shallower shadow
  vec3 shadowCol = ambient * vec3(0.50, 0.54, 0.64) + vec3(0.02, 0.03, 0.05);
  c = mix(c, shadowCol, clamp(sh, 0.0, 0.85));
  // night: a faint glow from moonlight
  c += vec3(0.10, 0.12, 0.18) * nightF * (0.3 + 0.4 * litE);
  // silver lining (the edge glows on the sun side — only with direct light)
  float rim = den * (1.0 - den) * 4.0 * max(litE, 0.0) * (1.0 - diffuse);
  c += cloudSun * rim * 0.35 * max(dayF, sunsetF * 0.5);
  // severe-weather clouds: a torn, leaden grey
  c = mix(c, vec3(0.09, 0.10, 0.12) + vec3(0.10) * dayF, gloom * 0.85);
  // lightning flickers inside the cloud
  c += flash * vec3(0.75, 0.8, 1.0) * (0.35 + den * 0.65);
  return c;
}

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
  float dayF = smoothstep(-0.12, 0.25, sunEl);
  float nightF = 1.0 - dayF;
  float sunsetF = smoothstep(0.35, 0.02, abs(sunEl));

  // ── Severity of the weather (rebuilt from rain/snow/wind instead of the old "storm") ──
  float gloom = clamp(max(u_rain, max(u_snow * 0.5, u_wind * 0.7)), 0.0, 1.0);
  float churn = clamp(u_wind * 0.9 + u_rain * 0.3, 0.0, 1.0);

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
  //
  // Held display-encoded as disp rather than decoded straight away: every
  // overlay() below would only re-encode it. See the note on disp at the clouds.
  vec3 disp = mix(hor, zen, 1.0 - exp(-max(el, 0.0) * 2.6));

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

  // magic hour: the horizon in the sun's direction turns amber, the sky above turns mauve
  // (since this looks at a compass direction, facing away shows an unlit sky)
  float towardSun = clamp(dot(normalize(vec3(rd.x, 0.0, rd.z) + 1e-5),
                              normalize(vec3(sunDir.x, 0.0, sunDir.z) + 1e-5)), -1.0, 1.0);
  float sunSide = 0.35 + 0.65 * smoothstep(-0.4, 1.0, towardSun);
  vec3 warm = vec3(1.0, 0.47, 0.22);
  vec3 mauve = vec3(0.45, 0.28, 0.45);
  disp = mix(disp, warm, sunsetF * smoothstep(0.55, 0.0, h) * 0.55 * sunSide);
  disp = mix(disp, mauve, sunsetF * smoothstep(0.10, 0.50, h) * 0.35);
  wide = max(wide, sunsetF * smoothstep(0.55, 0.0, h) * sunSide * 0.5);

  // ── Circular polarizer ──
  // Applied here on purpose: this is the scattered skylight, and it is the only
  // thing a CPL acts on. Everything composited after this point — clouds (Mie
  // scattering, essentially unpolarized), the sun, the moon, the stars — is
  // direct or depolarized light and passes through untouched. That ordering is
  // what makes the clouds "pop": the sky behind them drops and they do not.
  float dop = skyPolarization(rd, sunDir);
  if (u_pol.x > 0.001) {
    vec3 sky = L(disp);
    // The e-vector is perpendicular to the scattering plane, so it already lies
    // across the view ray; measure its angle in the frame's own basis, or the
    // filter would not track the camera as it swings.
    vec3 fwd = dirFromAngles(u_cam.y, u_cam.x);
    vec3 camRight = normalize(cross(vec3(0.0, 1.0, 0.0), fwd) + vec3(1e-6, 0.0, 0.0));
    vec3 camUp = cross(fwd, camRight);
    vec3 e = normalize(cross(rd, sunDir) + vec3(1e-6));
    float ePhi = atan(dot(e, camUp), dot(e, camRight));

    sky *= polarizerTransmission(dop, ePhi);

    // the veil a polarizer removes is multiply-scattered white light, so what
    // survives reads more saturated than the darkening alone would explain.
    // dot() against the Rec.709 coefficients is a real luminance here — in the
    // old gamma-encoded pipeline it never was
    if (u_pol.z > 0.001) {
      float lum = dot(sky, vec3(0.2126, 0.7152, 0.0722));
      sky = max(mix(vec3(lum), sky, 1.0 + u_pol.z * dop * u_pol.x), 0.0);
    }
    disp = encodeSrgb(sky);
  }

  // overcast: the sky's blue drains toward a bright grey (including the sky peeking through gaps)
  float overcastSky = smoothstep(0.5, 0.95, u_cover);
  disp = mix(disp, mix(vec3(0.050, 0.055, 0.070), vec3(0.70, 0.73, 0.76), dayF), overcastSky * 0.85);

  // severe weather: darken the whole sky to a leaden grey
  disp = mix(disp, vec3(0.16, 0.18, 0.21) * (0.25 + 0.75 * dayF), gloom * 0.75);

  // into linear light for the part of the sky that is added light
  vec3 sky = L(disp);

  // ── Stars (night, low cloud. Determined by direction, so they stay pinned to the celestial sphere as the view swings) ──
  // Every term in here is scaled by this product — the star field, all three
  // grids and the Milky Way — so where it is zero (all day, and under heavy
  // cloud or gloom at night) the block adds exactly nothing and is skipped.
  // It is uniform across the frame, so the branch never diverges.
  if (nightF * clamp(1.0 - u_cover * 1.4, 0.0, 1.0) * (1.0 - gloom) > 0.0) {
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
    float mwHere = milkyWayBand(rd, u_sky.y, mwBulge, mwRift, mwGlow, mwBase);

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
    float vis = star * twinkle * nightF
              * horizonGate
              * clamp(1.0 - u_cover * 1.4, 0.0, 1.0) * (1.0 - gloom);
    sky += tint * vis * STAR_LUM;
    // a star's blue or amber is genuinely outside sRGB — the strongest claim here
    wide = max(wide, vis * 0.9);

    // the Milky Way shares the star field's occlusion exactly — same night, same
    // cloud, same gloom — so it is gated here rather than duplicating all of it
    float mwGate = nightF * horizonGate
                 * clamp(1.0 - u_cover * 1.4, 0.0, 1.0) * (1.0 - gloom);
    float mw = mwHere * mwGate;

    // ── Second, finer star layer: the unresolved-into-resolved crowd ──
    // One star per cell tops out the density the main grid can reach, and a real
    // dark-sky band is grain, not a ceiling. A denser grid of small faint stars
    // fills in underneath: thickest inside the band, spreading over the whole
    // sky as the site darkens. Scaled by deep so it is *exactly* zero at Bortle
    // 6 and up — the default sky never pays for it or shows it — and fades in
    // continuously below.
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
  }

  // ── Moon (night. Placed opposite the sun — the full-moon relationship) ──
  // every contribution below carries vis, so a zero vis is an exact no-op
  float moonVis = nightF * clamp(1.0 - u_cover * 0.9 - gloom, 0.0, 1.0);
  if (moonVis > 0.0) {
    vec3 moonDir = dirFromAngles(0.62, u_sun.y + PI);
    float ang = acos(clamp(dot(rd, moonDir), -1.0, 1.0));
    float moon = smoothstep(0.048, 0.043, ang);
    // the crescent bite: carve it out with a circle offset slightly from the moon's center
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), moonDir));
    vec3 up = cross(moonDir, right);
    vec3 biteDir = normalize(moonDir - right * 0.013 + up * 0.013);
    float bite = smoothstep(0.054, 0.048, acos(clamp(dot(rd, biteDir), -1.0, 1.0)));
    float vis = moonVis;
    float cres = clamp(moon - bite, 0.0, 1.0);

    // Moon-fixed frame: the ray projected onto the disc plane, in units of the
    // disc radius. The mare pattern samples this, so it stays glued to the
    // surface however the camera swings.
    vec2 muv = vec2(dot(rd, right), dot(rd, up)) / 0.048;
    // only ever read through the disc's own coverage, so off the disc it is skipped
    float mare = 0.0;
    if (moon > 0.0) mare = smoothstep(0.42, 0.72, fbm(muv * 2.3 + vec2(4.7, 9.2)));

    // Earthshine. The shadowed disc is rock, not glass: it occludes the stars
    // behind it (a replace, not an add) and holds a faint blue-grey glow of
    // sunlight bounced off the Earth, an order of magnitude under the crescent.
    // The occlusion saturates early so a clear-night vis of 0.9 does not leak
    // 10% of every star through the rock, yet it still follows vis down under
    // cloud so a heavy overcast dims the disc away instead of punching a dark
    // hole in the cloud glow (and vis=0 keeps the mix an identity by day).
    vec3 shine = L(vec3(0.62, 0.68, 0.78)) * (1.0 - 0.5 * mare) * 0.016 * MOON_LUM;
    sky = mix(sky, shine, moon * smoothstep(0.0, 0.55, vis));

    // The lit crescent: overexposed warm white, linear-light emission
    sky += L(vec3(1.0, 0.96, 0.88)) * cres * vis * MOON_LUM;

    // Bloom leans toward the crescent (away from the bite offset), warm like
    // the light that causes it; the shadowed limb keeps only a trace. Kept
    // tight so it does not wash the Milky Way band nearby.
    vec2 biteOff = normalize(vec2(-0.013, 0.013));
    float sideW = 0.5 - 0.5 * dot(muv, biteOff) / max(length(muv), 1e-3);
    sideW = 0.12 + 0.88 * sideW;
    float rim = exp(-max(ang - 0.045, 0.0) * 30.0) * (1.0 - moon);
    // near-white with only a hint of warmth: a stronger yellow muddied to
    // brown against the lavender of the Milky Way band
    sky += L(vec3(1.0, 0.95, 0.87)) * rim * sideW * 0.30 * vis;
    // a whisper of scattered moonlight haze just past the limb, all around
    sky += L(vec3(0.45, 0.55, 0.75)) * exp(-max(ang - 0.045, 0.0) * 11.0)
         * (1.0 - moon) * 0.035 * vis;
    wide = max(wide, max(cres, rim * sideW * 0.30) * vis * 0.7);
  }

  // ── Meteors ──
  float meteorVis = nightF * clamp(1.0 - u_cover * 1.2, 0.0, 1.0) * (1.0 - gloom);
  if (meteorVis > 0.0) {
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
    sky = mix(sky, vec3(SUN_LUM), core * sunVis);
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
  sky += L(vec3(0.26, 0.16, 0.09)) * exp(-h * 8.0) * nightF
       * (0.4 * (u_sky.x - 1.0) / 5.0) * (1.0 - gloom * 0.6);

  // airglow: at a truly dark site the horizon carries a faint green-grey rim of
  // atmospheric chemiluminescence instead of city light. A thin rim — a fat
  // scale height reads as haze and swallows the lowest stars. Shares the second
  // star layer's gate, so it is exactly absent at Bortle 6 and up.
  float agDeep = clamp((6.0 - u_sky.x) / 5.0, 0.0, 1.0);
  if (agDeep * nightF > 0.0) {
    // rippled around the compass — real airglow hangs in uneven waves, and a
    // uniform rim reads as a printed strip. Seeded off the horizontal ray
    // components, so it is seamless in azimuth and pinned as the view swings
    float agN = fbm2(vec2(rd.x, rd.z) * 2.5 + 31.0);
    sky += L(vec3(0.30, 0.52, 0.38)) * exp(-h * (9.0 + 7.0 * agN)) * nightF
         * (0.07 * (0.55 + 0.90 * agN) * agDeep)
         * clamp(1.0 - u_cover * 1.2, 0.0, 1.0) * (1.0 - gloom);
  }

  // ── Lightning (computed before the clouds so it lights them too) ──
  float flash = 0.0;
  {
    float lt = u_time * 0.55;
    float cell = floor(lt);
    float p1 = hash11(cell);
    float thresh = mix(1.05, 0.55, u_thunder);   // never fires when thunder=0
    if (p1 > thresh) {
      float ph = fract(lt);
      flash = exp(-ph * 9.0) * (0.65 + 0.35 * sin(ph * 70.0 + p1 * 30.0));
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
  vec3 cloudSun = mix(vec3(1.05, 1.0, 0.95), vec3(1.1, 0.55, 0.3), sunsetF);

  // the cloud plane's projection scale (= altitude). Higher layers are larger, so the same lump looks smaller
  const float ALT_HIGH = 3.2;
  const float ALT_MID = 1.8;
  const float ALT_LOW = 0.95;
  // a cloud genus with amount 0 is skipped entirely — a clear sky costs almost nothing.
  // So is every plane layer below the horizon: each one's alpha carries
  // horizonFade, which is exactly zero there (half of every skybox bake)
  bool above = horizonFade > 0.0;
  float ramp = 0.08 + 0.14 * (1.0 - rdY);   // widen near the horizon to suppress aliasing

  // ── High layer, 5000–13000m ─────────────────────────
  // Cirrus Ci (mare's tail) — the first to blush pink at magic hour
  if (u_high.x > 0.001 && above) {
    // the extra x-crawl rides u_windOff too (see cloudField): 0.14 matches
    // the old u_time × 0.004 at light wind, and speeds up when it blows
    float f = filament(planeUV(rd, rdY, ALT_HIGH, u_windOff * 0.3) + vec2(u_windOff * 0.14, 0.0));
    vec3 col = mix(vec3(1.0), vec3(1.05, 0.62, 0.55), sunsetF);
    col = mix(vec3(0.25, 0.30, 0.45), col, max(dayF, sunsetF));
    disp = mix(disp, col, f * u_high.x * 0.62 * horizonFade * (1.0 - gloom * 0.8));
  }
  // Cirrostratus Cs (veil cloud) — a thin veil across the whole sky. Haloes the sun
  if (u_high.y > 0.001) {
    // the halo below is sky-side and still shows under the horizon; the veil does not
    if (above) {
      vec2 s = stratiform(planeUV(rd, rdY, ALT_HIGH * 0.5, u_windOff * 0.3), 0.35, 0.0);
      vec3 col = mix(vec3(0.86, 0.89, 0.95), vec3(1.02, 0.80, 0.72), sunsetF);
      col = mix(vec3(0.22, 0.26, 0.38), col, max(dayF, sunsetF * 0.8));
      disp = mix(disp, col, s.x * u_high.y * 0.45 * horizonFade);
    }
    // the 22° halo (refraction through ice crystals). Added light, so it is the
    // one term in this stretch that has to leave display space — and only on
    // the ring itself, where there is something to add
    float ring = smoothstep(0.028, 0.0, abs(sunAng - 0.384)) * u_high.y * sunVis;
    if (ring > 0.0) disp = encodeSrgb(L(disp) + L(vec3(1.0, 0.95, 0.85)) * ring * 0.30);
  }
  // Cirrocumulus Cc (mackerel sky) — fine grains packed densely up high
  if (u_high.z > 0.001 && above) {
    vec2 g = granular(planeUV(rd, rdY, ALT_HIGH * 5.5, u_windOff * 0.3), 0.55, 1.0, 0.25, ldir);
    vec3 col = cloudColor(g.x, g.y * 0.8, 0.16, dayF, nightF, sunsetF, flash, gloom, 0.5, cloudSun);
    disp = mix(disp, col, g.x * u_high.z * 0.85 * horizonFade);
  }

  // ── Mid layer, 2000–7000m ───────────────────────────
  // Altostratus As (grey veil) — a translucent sheet.
  // Not one uniform film but "torn membranes overlapping in patches", with
  // the sun showing through broadly, outline-less, as if through frosted
  // glass. These two things are altostratus's face.
  if (u_mid.x > 0.001 && above) {
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

    disp = mix(disp, col, s.x * u_mid.x * 0.95 * horizonFade);
  }
  // Altocumulus Ac (sheep cloud) — larger than cirrocumulus, with grains shaded individually
  if (u_mid.y > 0.001 && above) {
    vec2 g = granular(planeUV(rd, rdY, ALT_MID * 2.2, u_windOff * 0.6), 0.80, 0.85, 0.35, ldir);
    vec3 col = cloudColor(g.x, g.y, 0.30, dayF, nightF, sunsetF, flash, gloom, 0.9, cloudSun);
    disp = mix(disp, col, g.x * u_mid.y * 0.95 * horizonFade);
  }
  // Nimbostratus Ns (rain cloud) — the rain-bearing cloud. Its undulating base's thickness variation becomes the light/dark directly
  if (u_mid.z > 0.001 && above) {
    vec2 s = stratiform(planeUV(rd, rdY, ALT_MID * 0.30, u_windOff * 0.6), 0.10, 1.0);
    // no direct sunlight reaches it at all, so color can be one-dimensional: "thickness → shade".
    // cloudColor's shadow blending caps at 0.85 and never sinks to the photo's charcoal
    vec3 lit = mix(vec3(0.050, 0.055, 0.068), vec3(0.74, 0.75, 0.76), dayF);
    lit += vec3(0.12, 0.06, 0.03) * sunsetF;
    // real rain clouds sit between "charcoal and mid-grey", never pure black or white.
    // the thicker the cloud, the lower the dark end sinks
    vec3 col = lit * mix(0.74, mix(0.40, 0.20, u_mid.z), s.y);
    col += flash * vec3(0.75, 0.80, 1.0) * 0.6;
    disp = mix(disp, col, s.x * u_mid.z * 0.99 * horizonFade);
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
  if (cbAmt > 0.001) {
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
        // measured against real photos, a sunlit cumulus sits near 0.93, and
        // even its shadow only sinks to about 0.55.
        // placing hi at 1.0 leaves no room to lay grain on top and produces a solid-white patch
        // the shadow points sit clearly on the blue side: a cloud's shade is
        // lit by the sky, so letting it fall to a neutral grey reads as dirt
        // (measured on photos: shadow ≈ (0.55, 0.63, 0.75), never colorless)
        // the shade is lit almost entirely by the blue sky dome, so under a
        // clear sky it takes on a clear blue cast — deeper than a photo's
        // "neutral" reading suggests. The overcast pull below neutralizes it
        // again when there's no blue sky to reflect
        // daytime hi was authored warm of white (R > B) while every other
        // layer's lit face leans blue (cloudColor: cool ambient + cloudSun),
        // so the tower read as a cream mass in a neutral sky. Match the other
        // clouds' color temperature; sunset warmth is layered on below and
        // keeps its own tint
        vec3 hi  = mix(vec3(0.13, 0.14, 0.18), vec3(0.918, 0.948, 0.985), dayF);
        vec3 mid = mix(vec3(0.09, 0.10, 0.13), vec3(0.765, 0.825, 0.920), dayF);
        vec3 lo  = mix(vec3(0.05, 0.06, 0.08), vec3(0.415, 0.545, 0.775), dayF);
        hi  = mix(hi,  hi  * vec3(1.10, 0.84, 0.62), sunsetF * 0.85);
        mid = mix(mid, mid * vec3(1.06, 0.82, 0.66), sunsetF * 0.85);
        lo  = mix(lo,  lo  * vec3(0.96, 0.86, 0.86), sunsetF * 0.6);
        // under overcast the other layers drop to diffuse sky light (see
        // cloudColor); if the tower keeps its sunny warm-white palette it
        // floats above them as a cream-yellow mass. Pull it to the same
        // blue-grey ambient as the deck it's embedded in
        float diffuse = smoothstep(0.55, 0.95, u_cover);
        hi  = mix(hi,  mix(vec3(0.115, 0.125, 0.16), vec3(0.800, 0.835, 0.900), dayF), diffuse * 0.85);
        mid = mix(mid, mix(vec3(0.085, 0.095, 0.12), vec3(0.680, 0.720, 0.805), dayF), diffuse * 0.85);
        lo  = mix(lo,  mix(vec3(0.050, 0.058, 0.08), vec3(0.520, 0.570, 0.680), dayF), diffuse * 0.85);

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
        // the base is in the tower's own shadow but lit by the sky, so it
        // sinks toward blue-grey, not plain grey
        tcol *= mix(vec3(1.0), vec3(0.55, 0.645, 0.845), depth * depth);
        // the edge is thin, so light passes through it (silver lining — only with direct sun)
        tcol += cloudSun * m * (1.0 - m) * 4.0 * 0.22
              * max(t - 0.45, 0.0) * max(dayF, sunsetF * 0.6) * (1.0 - diffuse);
        // in severe weather the cumulonimbus itself sits inside the storm.
        // leaving it bright here makes a pure-white cloud float in a leaden
        // sky. Pull it toward the same leaden grey as the other layers.
        tcol = mix(tcol, vec3(0.19, 0.20, 0.23) * (0.25 + 0.75 * dayF), gloom * 0.85);
        tcol += flash * vec3(0.75, 0.80, 1.0) * 0.55;

        // cumulonimbus isn't a cloud-plane projection, so high frequency
        // doesn't blow up near the horizon. Applying the same strong fade as
        // the other layers would dissolve the cloud base into haze and make it vanish.
        float cbFade = smoothstep(-0.02, 0.06, rd.y);
        cbMask = clamp(m, 0.0, 1.0) * 0.97 * cbFade;
        disp = mix(disp, tcol, cbMask);
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
          disp = mix(disp, vcol, v * 0.70 * horizonFade);
        }
      }
    }
  }

  // ── Low layer, under 2000m ──────────────────────────
  // Stratocumulus Sc (roll cloud) — large mottled masses, arranged as rolls
  if (u_low.y > 0.001 && above) {
    vec2 g = granular(planeUV(rd, rdY, ALT_LOW * 1.9, u_windOff * 1.2), 1.22, 0.5, 0.78, ldir);
    vec3 col = cloudColor(g.x, g.y, 0.48, dayF, nightF, sunsetF, flash, gloom, 1.05, cloudSun);
    disp = mix(disp, col, g.x * u_low.y * 0.95 * horizonFade);
  }
  // Cumulus Cu (cotton cloud) — dome-shaped billowing lumps. The heaviest layer, so skip it at tiny amounts
  if (u_low.z > 0.02 && above) {
    vec2 cuv = planeUV(rd, rdY, ALT_LOW * 2.5, u_windOff);
    // during high wind the whole sky wobbles slightly.
    // driven by u_windOff (which only advances in wind) so the phase is
    // continuous across u_time's wrap; at full gust its rate matches the
    // old u_time * 2.3 / 1.7 frequencies
    cuv += u_wind * 0.01 * vec2(
      sin(u_windOff * 10.0 + rd.y * 8.0),
      cos(u_windOff * 7.4 + rd.x * 6.0)
    );
    // the smaller the amount, the higher the threshold — sparse clouds only sprout here and there
    float edge = 0.88 - u_low.z * 0.52;
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
    vec3 c = cloudColor(dl.x, dl.y, thick, dayF, nightF, sunsetF, flash, gloom, 1.0, cloudSun);
    disp = mix(disp, c, alpha * 0.97);

    // fast-moving ragged clouds nearby (fragments of cumulus)
    vec2 fuv = planeUV(rd, rdY, ALT_LOW * 1.2, u_windOff * 1.9) + 51.7;
    float fedge = 0.94 - u_low.z * 0.42;
    vec3 fl = cloudField(fuv, churn * 1.2, ldir, fedge, ramp, fedge - 0.01);
    float falpha = fl.x * u_low.z * horizonFade * (1.0 - cbMask * 0.6);
    float fthick = smoothstep(fedge, fedge + 0.35, fl.z);
    vec3 fc = cloudColor(fl.x, fl.y, fthick, dayF, nightF, sunsetF, flash, gloom, 1.25, cloudSun);
    disp = mix(disp, fc, falpha * 0.95);
  }
  // Stratus St (fog cloud) — hangs low. Denser toward the horizon
  if (u_low.x > 0.001 && above) {
    vec2 s = stratiform(planeUV(rd, rdY, ALT_LOW * 0.5, u_windOff * 1.2), 0.45, 0.45);
    vec3 col = cloudColor(0.95, -0.25, 0.60,
                          dayF, nightF, sunsetF, flash, gloom, 1.2, cloudSun) * 0.86;
    float lowBias = mix(1.0, 0.40, smoothstep(0.05, 0.55, rd.y));
    disp = mix(disp, col, s.x * u_low.x * lowBias * 0.95 * horizonFade);
  }

  // ── Light leaking in under the cloud base ──
  // Even under a thick deck covering the whole sky, right along the horizon
  // distant light having passed beneath the clouds breaks through and
  // brightens things. This single band is usually what sells a rain-cloud sky.
  float deck = max(u_mid.z, max(u_mid.x, u_low.x));
  if (deck > 0.01) {
    vec3 leak = mix(vec3(0.055, 0.058, 0.066), vec3(0.70, 0.70, 0.63), dayF);
    leak = mix(leak, vec3(0.86, 0.60, 0.40), sunsetF * 0.7);
    float band = smoothstep(0.22, 0.005, rd.y) * smoothstep(-0.02, 0.02, rd.y);
    disp = mix(disp, leak, band * deck * 0.88);
  }

  // ── Pannus (ragged scud beneath rain clouds) ──
  // Dark fragments racing fast beneath the cloud base. Layering dark shapes
  // over the bright leaking horizon reads as "there's another layer beneath
  // the thick deck", adding depth.
  // Near the horizon the cloud plane's projection diverges and high
  // frequency breaks down, so squeeze this into a band and stretch the
  // threshold's ramp wide to dissolve it into an outline-less haze instead.
  float fband = smoothstep(0.015, 0.075, rd.y) * smoothstep(0.42, 0.10, rd.y);
  if (u_mid.z > 0.02 && fband > 0.001) {
    vec2 fuv = planeUV(rd, rdY, ALT_LOW * 0.42, u_windOff * 2.4) + 77.0;
    float pedge = 0.90 - u_mid.z * 0.22;
    vec3 fr = cloudField(fuv, churn + 0.45, ldir, pedge, ramp * 2.2, pedge - 0.01);
    vec3 fcol = mix(vec3(0.030, 0.033, 0.040), vec3(0.26, 0.27, 0.29), dayF);
    disp = mix(disp, fcol, fr.x * u_mid.z * fband * 0.80);
  }

  // ── Below the horizon (out of frame with the default framing; used when looking down and for the skybox's lower hemisphere) ──
  {
    vec3 ground = mix(vec3(0.020, 0.022, 0.028), vec3(0.17, 0.165, 0.150), dayF);
    ground = mix(ground, ground * 0.6, gloom * 0.5);
    ground += vec3(0.06, 0.03, 0.015) * sunsetF * 0.5;
    disp = mix(disp, ground, smoothstep(0.0, -0.05, rd.y));
  }

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

  // ── Haze/mist (the shorter the visibility, the further out — toward the horizon — it crushes white) ──
  if (u_haze > 0.001) {
    vec3 hazeCol = mix(vec3(0.10, 0.11, 0.13), vec3(0.78, 0.80, 0.83), dayF);
    hazeCol = mix(hazeCol, hazeCol * vec3(1.10, 0.98, 0.90), sunsetF * 0.7);
    hazeCol = mix(hazeCol, hazeCol * vec3(0.38, 0.40, 0.45), gloom);
    // thin haze only crushes the horizon; the thicker it gets, the higher it climbs toward the zenith, covering the whole sky
    float reach = mix(0.22, 1.0, u_haze * u_haze);
    float hz = u_haze * mix(1.0, reach, smoothstep(0.0, 0.45, h));
    // cutting haze is half the reason to carry the filter
    hz *= 1.0 - u_pol.x * dop * 0.45;
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
function fragSource(explicitLod: boolean): string {
  // an #extension directive has to precede every non-preprocessor token
  return (explicitLod
    ? '#extension GL_EXT_shader_texture_lod : enable\n'
      + '#define NOISE_FETCH(uv) texture2DLodEXT(u_noise, (uv), 0.0)\n'
    : '#define NOISE_FETCH(uv) texture2D(u_noise, (uv))\n'
  ) + FRAG;
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
  'u_frame', 'u_aspect', 'u_time', 'u_cam', 'u_sun',
  'u_cover', 'u_high', 'u_mid', 'u_low',
  'u_rain', 'u_snow', 'u_wind', 'u_thunder', 'u_haze', 'u_cbFeat',
  'u_windOff', 'u_evo',
  'u_filtAmt', 'u_filtTint', 'u_filtSat', 'u_filtLift',
  'u_p3', 'u_headroom', 'u_tone', 'u_pol', 'u_sky', 'u_radiant', 'u_lensDrops', 'u_lensFx', 'u_fall',
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
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private noise: WebGLTexture | null = null;
  // the light probe's offscreen target, made on first use and resized to the layout
  private probeFbo: WebGLFramebuffer | null = null;
  private probeTex: WebGLTexture | null = null;
  private probeSize: [number, number] = [0, 0];
  private probePixels: Uint8Array | null = null;
  private u: Uniforms = {};
  private lost = false;
  private p3 = false;
  private linked = false;
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
   * true once the program is linked and `render()` will actually draw.
   *
   * Always true by the time the constructor returns under `compile: 'sync'`.
   */
  get ready(): boolean { return this.linked; }

  /**
   * The space actually being rendered into — `'display-p3'` only where the
   * browser supports it, whatever was requested.
   *
   * A 2D canvas that receives a `drawImage` of this one should be created with
   * the same `colorSpace`, or the wide-gamut pixels get clipped in the copy.
   */
  get colorSpace(): PredefinedColorSpace { return this.p3 ? 'display-p3' : 'srgb'; }

  private init(): void {
    this.linked = false;
    this.stopPolling();
    // handles from a lost context are dead; the probe target is rebuilt on demand
    this.probeFbo = null;
    this.probeTex = null;
    this.probeSize = [0, 0];
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
    const fs = compile(gl.FRAGMENT_SHADER,
      fragSource(gl.getExtension('EXT_shader_texture_lod') !== null));
    if (!vs || !fs) { this.gl = null; this.notifyReady(false); return; }

    const prog = gl.createProgram();
    if (!prog) { this.gl = null; this.notifyReady(false); return; }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = prog;

    this.noise = this.createNoise(gl);

    // On Windows, linkProgram is where ANGLE hands the whole shader to the
    // D3D compiler, and reading LINK_STATUS is what waits for it. Asking the
    // driver whether it's finished instead keeps the page alive through it.
    const parallel = this.opts.compile === 'sync'
      ? null
      : gl.getExtension('KHR_parallel_shader_compile');
    if (!parallel) { this.finishLink(); return; }

    const step = (): void => {
      this.poll = 0;
      const g = this.gl;
      if (!g || !this.program) return;
      if (!g.getProgramParameter(this.program, parallel.COMPLETION_STATUS_KHR)) {
        this.poll = setTimeout(step, POLL_MS);
        return;
      }
      this.finishLink();
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

  /** collect the link result and finish the one-time GL setup that depends on it */
  private finishLink(): void {
    const gl = this.gl;
    const prog = this.program;
    if (!gl || !prog) return;
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('atmosphere shader link error:', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      if (this.noise) gl.deleteTexture(this.noise);
      this.noise = null;
      this.program = null;
      this.gl = null;
      this.notifyReady(false);
      return;
    }
    gl.useProgram(prog);

    // a fullscreen triangle
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.u = {};
    for (const name of UNIFORM_NAMES) this.u[name] = gl.getUniformLocation(prog, name);
    // the sampler binding lives in the program, so once is enough; which
    // texture unit 0 holds is context state, and render() re-establishes that
    gl.uniform1i(this.u.u_noise, 0);

    this.linked = true;
    this.notifyReady(true);
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
    gl.uniform4f(u.u_frame, 0, 0, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.u_aspect, this.canvas.width / Math.max(1, this.canvas.height));
    gl.uniform3f(u.u_cam, camera.yaw, camera.pitch, camera.fov);
    gl.uniform1f(u.u_p3, this.p3 ? 1 : 0);
    gl.uniform1f(u.u_lensDrops, s.lens.droplets);
    gl.uniform1f(u.u_lensFx, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
    if (!gl || this.lost || !this.program || !this.linked) return null;
    // bind every frame rather than only at init: another renderer sharing this
    // canvas (or anything else touching the context) may have swapped programs
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.noise);
    const u = this.u;
    gl.uniform1f(u.u_time, timeSec % TIME_WRAP_SEC);
    gl.uniform2f(u.u_sun, s.sunElevation, s.sunAzimuth);
    const c = s.clouds;
    gl.uniform1f(u.u_cover, s.cloudCover);
    gl.uniform3f(u.u_high, c.cirrus, c.cirrostratus, c.cirrocumulus);
    gl.uniform3f(u.u_mid, c.altostratus, c.altocumulus, c.nimbostratus);
    gl.uniform4f(u.u_low, c.stratus, c.stratocumulus, c.cumulus, c.cumulonimbus);
    gl.uniform1f(u.u_rain, s.rain);
    gl.uniform1f(u.u_snow, s.snow);
    gl.uniform1f(u.u_fall, s.particles.precipitation);
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
      if (this.program) gl.deleteProgram(this.program);
      if (this.buffer) gl.deleteBuffer(this.buffer);
      if (this.noise) gl.deleteTexture(this.noise);
      this.freeProbe(gl);
      if (options.loseContext) {
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    }
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.noise = null;
    this.linked = false;
  }
}
