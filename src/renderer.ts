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

import { DEFAULT_CAMERA, type AtmosphereState, type Camera } from './state';

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
// highp is optional for fragment shaders in WebGL1. Without this guard the
// shader fails to compile outright on older mobile GPUs, and the sky silently
// disappears (available === false). Banding gets worse at mediump, but a
// degraded sky beats no sky.
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2  u_res;
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

const float PI = 3.14159265;

float hash11(float n) { return fract(sin(n) * 43758.5453123); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
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

// ── Clouds ──────────────────────────────────────────────
// cloud field density and lit-ness (x=density 0..1, y=lit-ness -1..1, z=raw density value)
// the difference against a resample shifted slightly toward the sun becomes lit/shadowed
vec3 cloudField(vec2 cuv, float churn, vec2 ldir, float edge, float ramp) {
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
  float detail = fbm(q * 3.3 + 17.0 + drift);
  float dcomb = (base * 0.72 + detail * 0.28 - 0.5) * 2.2 + 0.5;
  float den = smoothstep(edge - 0.01, edge + ramp, dcomb);
  vec2 ql = q + ldir * 0.16;
  float dl = fbm(ql) * 0.72 + fbm(ql * 3.3 + 17.0 + drift) * 0.28;
  // ×4 saturates immediately into flat blocks of light and dark, so keep it gentle
  float lit = clamp((dcomb - dl) * 2.5, -1.0, 1.0);
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
  // grains gather sparsely into "flocks". Filling uniformly gives the whole
  // sky the same face everywhere. Raising patch merges the flocks into one
  // mottled sheet covering the sky (stratocumulus)
  float f = fbm4(uv * 0.16 + 21.0);
  cell *= smoothstep(mix(0.34, 0.02, patch), mix(0.68, 0.38, patch), f);

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
  vec2 p = gl_FragCoord.xy / u_res;          // 0..1 (y is up)
  float aspect = u_res.x / u_res.y;

  // ── Lens droplets (rain only. Refract the UV before deciding the view direction, distorting the image itself) ──
  float dropAmt = smoothstep(0.05, 0.5, u_rain);
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
  vec3 sky = mix(hor, zen, 1.0 - exp(-max(el, 0.0) * 2.6));

  // magic hour: the horizon in the sun's direction turns amber, the sky above turns mauve
  // (since this looks at a compass direction, facing away shows an unlit sky)
  float towardSun = clamp(dot(normalize(vec3(rd.x, 0.0, rd.z) + 1e-5),
                              normalize(vec3(sunDir.x, 0.0, sunDir.z) + 1e-5)), -1.0, 1.0);
  float sunSide = 0.35 + 0.65 * smoothstep(-0.4, 1.0, towardSun);
  vec3 warm = vec3(1.0, 0.47, 0.22);
  vec3 mauve = vec3(0.45, 0.28, 0.45);
  sky = mix(sky, warm, sunsetF * smoothstep(0.55, 0.0, h) * 0.55 * sunSide);
  sky = mix(sky, mauve, sunsetF * smoothstep(0.10, 0.50, h) * 0.35);

  // overcast: the sky's blue drains toward a bright grey (including the sky peeking through gaps)
  float overcastSky = smoothstep(0.5, 0.95, u_cover);
  sky = mix(sky, mix(vec3(0.050, 0.055, 0.070), vec3(0.70, 0.73, 0.76), dayF), overcastSky * 0.85);

  // severe weather: darken the whole sky to a leaden grey
  sky = mix(sky, vec3(0.16, 0.18, 0.21) * (0.25 + 0.75 * dayF), gloom * 0.75);

  // ── Stars (night, low cloud. Determined by direction, so they stay pinned to the celestial sphere as the view swings) ──
  {
    // fold the view direction onto a cubemap-like 2D grid.
    // pulling from a 3D grid leaves most lattice points off the sphere the
    // view ray actually passes through, so almost no stars show up
    vec2 sg = starGrid(rd) * 62.0;
    vec2 cell = floor(sg);
    float sr = hash12(cell);
    vec2 off = vec2(hash12(cell + 7.7), hash12(cell + 3.3)) - 0.5;
    float d = length(fract(sg) - 0.5 - off * 0.5);
    // a few bright stars + faint stars (kept subtle)
    float bright = step(0.99, sr);
    float faint = step(0.96, sr) - bright;
    float star = bright * smoothstep(0.20, 0.0, d) * 0.9
               + faint * smoothstep(0.11, 0.0, d) * 0.35;
    float twinkle = 0.8 + 0.2 * sin(u_time * (1.0 + fract(sr * 13.0) * 2.0) + sr * 40.0);
    vec3 tint = mix(vec3(0.8, 0.88, 1.0), vec3(1.0, 0.93, 0.85), fract(sr * 71.0));
    sky += tint * star * twinkle * nightF
         * smoothstep(0.02, 0.16, h)
         * clamp(1.0 - u_cover * 1.4, 0.0, 1.0) * (1.0 - gloom);
  }

  // ── Moon (night. Placed opposite the sun — the full-moon relationship) ──
  {
    vec3 moonDir = dirFromAngles(0.62, u_sun.y + PI);
    float ang = acos(clamp(dot(rd, moonDir), -1.0, 1.0));
    float moon = smoothstep(0.048, 0.043, ang);
    // the crescent bite: carve it out with a circle offset slightly from the moon's center
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), moonDir));
    vec3 up = cross(moonDir, right);
    vec3 biteDir = normalize(moonDir + right * 0.016 + up * 0.008);
    float bite = smoothstep(0.051, 0.045, acos(clamp(dot(rd, biteDir), -1.0, 1.0)));
    float vis = nightF * clamp(1.0 - u_cover * 0.9 - gloom, 0.0, 1.0);
    sky += vec3(0.93, 0.95, 1.0) * clamp(moon - bite * 0.92, 0.0, 1.0) * vis;
    sky += vec3(0.4, 0.5, 0.7) * exp(-ang * 14.0) * 0.22 * vis;
  }

  // ── Sun (an overexposed blowout. The core saturates flat, the edge falls off steeply) ──
  float sunVis = smoothstep(-0.06, 0.06, sunEl)
               * clamp(1.0 - u_cover * 0.75 - gloom * 0.95, 0.0, 1.0);
  float sunAng = acos(clamp(dot(rd, sunDir), -1.0, 1.0));
  {
    vec3 sunCol = mix(vec3(1.0, 0.98, 0.92), vec3(1.05, 0.6, 0.3), sunsetF);
    // gain the core and clamp → produces a flat, saturated white patch at the center
    float core = clamp(exp(-sunAng * sunAng * 900.0) * 2.2, 0.0, 1.0);
    sky = mix(sky, vec3(1.0), core * sunVis);
    // keep the surrounding bleed subtle (a scattering halo)
    sky += sunCol * exp(-sunAng * 4.0) * 0.22 * sunVis;
  }

  // night city lights (a warm glow along the horizon — a Tokyo-like sky)
  sky += vec3(0.26, 0.16, 0.09) * exp(-h * 8.0) * nightF * 0.4 * (1.0 - gloom * 0.6);

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

  // ── Shared setup for the cloud layers (intersection of view ray × cloud plane) ──
  float rdY = max(rd.y, 0.03);
  float horizonFade = smoothstep(0.0, 0.24, rd.y);
  float az = atan(rd.x, rd.z);
  // the cloud plane's coordinate system is world xz; fold the sun direction onto the same plane
  vec2 ldir = normalize(sunDir.xz + vec2(1e-4, 1e-4));
  vec3 cloudSun = mix(vec3(1.05, 1.0, 0.95), vec3(1.1, 0.55, 0.3), sunsetF);

  // the cloud plane's projection scale (= altitude). Higher layers are larger, so the same lump looks smaller
  const float ALT_HIGH = 3.2;
  const float ALT_MID = 1.8;
  const float ALT_LOW = 0.95;
  // a cloud genus with amount 0 is skipped entirely — a clear sky costs almost nothing
  float ramp = 0.08 + 0.14 * (1.0 - rdY);   // widen near the horizon to suppress aliasing

  // ── High layer, 5000–13000m ─────────────────────────
  // Cirrus Ci (mare's tail) — the first to blush pink at magic hour
  if (u_high.x > 0.001) {
    // the extra x-crawl rides u_windOff too (see cloudField): 0.14 matches
    // the old u_time × 0.004 at light wind, and speeds up when it blows
    float f = filament(planeUV(rd, rdY, ALT_HIGH, u_windOff * 0.3) + vec2(u_windOff * 0.14, 0.0));
    vec3 col = mix(vec3(1.0), vec3(1.05, 0.62, 0.55), sunsetF);
    col = mix(vec3(0.25, 0.30, 0.45), col, max(dayF, sunsetF));
    sky = mix(sky, col, f * u_high.x * 0.62 * horizonFade * (1.0 - gloom * 0.8));
  }
  // Cirrostratus Cs (veil cloud) — a thin veil across the whole sky. Haloes the sun
  if (u_high.y > 0.001) {
    vec2 s = stratiform(planeUV(rd, rdY, ALT_HIGH * 0.5, u_windOff * 0.3), 0.35, 0.0);
    vec3 col = mix(vec3(0.86, 0.89, 0.95), vec3(1.02, 0.80, 0.72), sunsetF);
    col = mix(vec3(0.22, 0.26, 0.38), col, max(dayF, sunsetF * 0.8));
    sky = mix(sky, col, s.x * u_high.y * 0.45 * horizonFade);
    // the 22° halo (refraction through ice crystals)
    sky += vec3(1.0, 0.95, 0.85) * smoothstep(0.028, 0.0, abs(sunAng - 0.384))
         * u_high.y * sunVis * 0.30;
  }
  // Cirrocumulus Cc (mackerel sky) — fine grains packed densely up high
  if (u_high.z > 0.001) {
    vec2 g = granular(planeUV(rd, rdY, ALT_HIGH * 5.5, u_windOff * 0.3), 0.55, 1.0, 0.25, ldir);
    vec3 col = cloudColor(g.x, g.y * 0.8, 0.16, dayF, nightF, sunsetF, flash, gloom, 0.5, cloudSun);
    sky = mix(sky, col, g.x * u_high.z * 0.85 * horizonFade);
  }

  // ── Mid layer, 2000–7000m ───────────────────────────
  // Altostratus As (grey veil) — a translucent sheet.
  // Not one uniform film but "torn membranes overlapping in patches", with
  // the sun showing through broadly, outline-less, as if through frosted
  // glass. These two things are altostratus's face.
  if (u_mid.x > 0.001) {
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

    sky = mix(sky, col, s.x * u_mid.x * 0.95 * horizonFade);
  }
  // Altocumulus Ac (sheep cloud) — larger than cirrocumulus, with grains shaded individually
  if (u_mid.y > 0.001) {
    vec2 g = granular(planeUV(rd, rdY, ALT_MID * 2.2, u_windOff * 0.6), 0.80, 0.85, 0.35, ldir);
    vec3 col = cloudColor(g.x, g.y, 0.30, dayF, nightF, sunsetF, flash, gloom, 0.9, cloudSun);
    sky = mix(sky, col, g.x * u_mid.y * 0.95 * horizonFade);
  }
  // Nimbostratus Ns (rain cloud) — the rain-bearing cloud. Its undulating base's thickness variation becomes the light/dark directly
  if (u_mid.z > 0.001) {
    vec2 s = stratiform(planeUV(rd, rdY, ALT_MID * 0.30, u_windOff * 0.6), 0.10, 1.0);
    // no direct sunlight reaches it at all, so color can be one-dimensional: "thickness → shade".
    // cloudColor's shadow blending caps at 0.85 and never sinks to the photo's charcoal
    vec3 lit = mix(vec3(0.050, 0.055, 0.068), vec3(0.74, 0.75, 0.76), dayF);
    lit += vec3(0.12, 0.06, 0.03) * sunsetF;
    // real rain clouds sit between "charcoal and mid-grey", never pure black or white.
    // the thicker the cloud, the lower the dark end sinks
    vec3 col = lit * mix(0.74, mix(0.40, 0.20, u_mid.z), s.y);
    col += flash * vec3(0.75, 0.80, 1.0) * 0.6;
    sky = mix(sky, col, s.x * u_mid.z * 0.99 * horizonFade);
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
    float massL = fbm4(vec2(sin(azw - 0.08), cos(azw - 0.08)) * 0.85 + vec2(0.0, u_evo * 0.12));
    float massR = fbm4(vec2(sin(azw + 0.08), cos(azw + 0.08)) * 0.85 + vec2(0.0, u_evo * 0.12));
    float massE = min(mass, max(massL, massR));
    // a second, wider erosion ring: a knife-ridge longer than the first
    // ring slips through it and still stands as a needle. The small
    // allowance lets a broad dome rise a little above its shoulders
    float massL2 = fbm4(vec2(sin(azw - 0.13), cos(azw - 0.13)) * 0.85 + vec2(0.0, u_evo * 0.12));
    float massR2 = fbm4(vec2(sin(azw + 0.13), cos(azw + 0.13)) * 0.85 + vec2(0.0, u_evo * 0.12));
    massE = min(massE, max(massL2, massR2) + 0.06);
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

    // The silhouette is decided by one formula: "thrust − height".
    //
    // Multiplying a cut by azimuth (a vertical flank) with a cut by height
    // (a flat ceiling) produces a mesa no matter what noise rides on top. If
    // thrust is a gentle hill across azimuth, subtracting height alone
    // naturally narrows it upward, with the top becoming a parabola — a
    // round head. Making the height term quadratic accelerates the tapering
    // higher up, giving a cumulonimbus with a wide base and a round top.
    float rise = env * (1.05 + 1.35 * cbAmt);
    // the linear term is height, the quadratic term is the "narrowing
    // upward" roundness. The -1.0 bias decides how wide the base is.
    // to stretch height alone, lower the linear term (raising the gain fattens the base too).
    // only let the sphere term act where there's thrust. Otherwise a single
    // sphere clears the threshold even in open sky away from any tower, and
    // a white bubble floats there on its own.
    // but the factor applied must be "smooth" — a sharp mask turns the edge into a straight line
    float near = smoothstep(0.0, 1.2, rise);
    // how far this azimuth's tower reaches (solving rise − (y + 0.8y²) − 1 = 0
    // for y, with hgt = y + 0.6y^2). Used for shading and the companion forms' attachment height
    float towerTop = (sqrt(1.0 + 2.4 * max(rise - 1.0, 0.0)) - 1.0) / 1.2;
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
      vec3 hi  = mix(vec3(0.13, 0.14, 0.18), vec3(0.985, 0.985, 0.970), dayF);
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
      sky = mix(sky, tcol, cbMask);
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
          vec3 vcol = mix(vec3(0.11, 0.12, 0.15), vec3(0.96, 0.96, 0.97), dayF);
          vcol = mix(vcol, vcol * vec3(1.10, 0.88, 0.72), sunsetF * 0.8);
          vcol = mix(vcol, vec3(0.21, 0.22, 0.25) * (0.25 + 0.75 * dayF), gloom * 0.85);
          // the underside sinks into shadow, the top face catches the sun
          vcol *= mix(0.80, 1.05, smoothstep(-0.030, 0.024, dY));
          // skin. Multiplicative so it adds texture without changing overall brightness
          float vFray = vnoise(vcyl * 4.2 + 3.0) * 0.6 + vnoise(vcyl * 9.5 + 11.0) * 0.4 - 0.5;
          vcol *= 1.0 + vFray * 0.22;
          sky = mix(sky, vcol, v * 0.70 * horizonFade);
        }
      }
    }
  }

  // ── Low layer, under 2000m ──────────────────────────
  // Stratocumulus Sc (roll cloud) — large mottled masses, arranged as rolls
  if (u_low.y > 0.001) {
    vec2 g = granular(planeUV(rd, rdY, ALT_LOW * 1.9, u_windOff * 1.2), 1.22, 0.5, 0.78, ldir);
    vec3 col = cloudColor(g.x, g.y, 0.48, dayF, nightF, sunsetF, flash, gloom, 1.05, cloudSun);
    sky = mix(sky, col, g.x * u_low.y * 0.95 * horizonFade);
  }
  // Cumulus Cu (cotton cloud) — dome-shaped billowing lumps. The heaviest layer, so skip it at tiny amounts
  if (u_low.z > 0.02) {
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
    vec3 dl = cloudField(cuv, churn, ldir, edge, ramp);
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
    sky = mix(sky, c, alpha * 0.97);

    // fast-moving ragged clouds nearby (fragments of cumulus)
    vec2 fuv = planeUV(rd, rdY, ALT_LOW * 1.2, u_windOff * 1.9) + 51.7;
    float fedge = 0.94 - u_low.z * 0.42;
    vec3 fl = cloudField(fuv, churn * 1.2, ldir, fedge, ramp);
    float falpha = fl.x * u_low.z * horizonFade * (1.0 - cbMask * 0.6);
    float fthick = smoothstep(fedge, fedge + 0.35, fl.z);
    vec3 fc = cloudColor(fl.x, fl.y, fthick, dayF, nightF, sunsetF, flash, gloom, 1.25, cloudSun);
    sky = mix(sky, fc, falpha * 0.95);
  }
  // Stratus St (fog cloud) — hangs low. Denser toward the horizon
  if (u_low.x > 0.001) {
    vec2 s = stratiform(planeUV(rd, rdY, ALT_LOW * 0.5, u_windOff * 1.2), 0.45, 0.45);
    vec3 col = cloudColor(0.95, -0.25, 0.60,
                          dayF, nightF, sunsetF, flash, gloom, 1.2, cloudSun) * 0.86;
    float lowBias = mix(1.0, 0.40, smoothstep(0.05, 0.55, rd.y));
    sky = mix(sky, col, s.x * u_low.x * lowBias * 0.95 * horizonFade);
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
    sky = mix(sky, leak, band * deck * 0.88);
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
    vec3 fr = cloudField(fuv, churn + 0.45, ldir, 0.90 - u_mid.z * 0.22, ramp * 2.2);
    vec3 fcol = mix(vec3(0.030, 0.033, 0.040), vec3(0.26, 0.27, 0.29), dayF);
    sky = mix(sky, fcol, fr.x * u_mid.z * fband * 0.80);
  }

  // ── Below the horizon (out of frame with the default framing; used when looking down and for the skybox's lower hemisphere) ──
  {
    vec3 ground = mix(vec3(0.020, 0.022, 0.028), vec3(0.17, 0.165, 0.150), dayF);
    ground = mix(ground, ground * 0.6, gloom * 0.5);
    ground += vec3(0.06, 0.03, 0.015) * sunsetF * 0.5;
    sky = mix(sky, ground, smoothstep(0.0, -0.05, rd.y));
  }

  // ── Rain (thin threads slanting with the wind. A lens-face phenomenon, so screen space) ──
  if (u_rain > 0.001) {
    vec2 rp = vec2(p.x * aspect, p.y);
    // ordinary rain falls nearly vertical; only high wind slants it strongly
    rp.x -= rp.y * mix(0.06, 0.8, smoothstep(0.3, 1.0, u_wind));
    float rain = 0.0;
    for (int i = 0; i < 2; i++) {
      float fi = float(i);
      vec2 g = rp * vec2(mix(220.0, 380.0, fi), mix(2.6, 4.2, fi));
      float colId = floor(g.x) + fi * 57.0;
      float drop = fract(g.y + u_time * mix(5.5, 8.5, fi) * (0.6 + 0.4 * u_wind) + hash11(colId) * 13.0);
      float active = step(mix(0.9, 0.72, u_rain), hash11(colId * 1.37 + fi * 91.0));
      // draw only the thin thread down the column's center
      float line = smoothstep(0.16, 0.05, abs(fract(g.x) - 0.5));
      rain += active * line * smoothstep(0.24, 0.03, drop) * smoothstep(0.0, 0.015, drop);
    }
    sky = mix(sky, sky * 0.92 + vec3(0.5, 0.55, 0.63) * 0.35, clamp(rain, 0.0, 1.0) * u_rain * 0.32);
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
  if (u_snow > 0.001) {
    vec2 sp = vec2(p.x * aspect, p.y);
    float flakes = 0.0;
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float k = fi * 0.25;                    // 0=near, 1=far
      // apply with a square so it gets rapidly finer with distance (linear reads as uniform size)
      float sc = mix(8.0, 160.0, k * k);
      float fall = u_time * mix(0.30, 0.035, k);

      vec2 g = sp * vec2(sc * (0.82 + 0.36 * hash11(fi * 5.3)), sc);
      g.y += fall * sc;
      // drift sideways with the wind, and tumble left and right while falling
      g.x += (u_wind * fall * 2.6 + sin(g.y * 0.22 + fi * 2.7) * 0.35) * sc * 0.06;
      // shift sideways per row. Without this the square grid's lattice
      // shows straight through as "flakes falling at even spacing"
      g.x += hash11(floor(g.y) * 1.37 + fi * 13.0) * 4.0;

      vec2 cell = floor(g);
      float r = hash12(cell + fi * 37.0);
      float active = step(mix(0.94, 0.40, u_snow), r);
      // scatter position across the whole cell (centering it makes the grid stand out)
      vec2 off = vec2(hash12(cell + 5.1), hash12(cell + 9.7)) * 0.9 + 0.05;
      float d = length(fract(g) - off);
      // bigger, blurrier-edged and fainter up close (out of focus)
      float rad = mix(0.40, 0.10, k);
      float edge = mix(0.10, 0.72, k);
      flakes += active * smoothstep(rad, rad * edge, d) * mix(0.55, 1.0, k);
    }
    sky = mix(sky, vec3(0.95, 0.96, 1.0), clamp(flakes, 0.0, 1.0) * u_snow * 0.85);

    // the snowfall itself whites out visibility — flakes alone don't sell the impression of heavy snow.
    // a snowy sky is bright grey, unlike a rain cloud, so lift it here
    vec3 whiteout = mix(vec3(0.28, 0.30, 0.34), vec3(0.92, 0.93, 0.95), dayF);
    sky = mix(sky, whiteout, u_snow * 0.55);
  }

  // lightning's glow reflected across the whole sky
  sky += flash * vec3(0.85, 0.9, 1.1) * (0.18 + 0.3 * (1.0 - h));

  // ── Haze/mist (the shorter the visibility, the further out — toward the horizon — it crushes white) ──
  if (u_haze > 0.001) {
    vec3 hazeCol = mix(vec3(0.10, 0.11, 0.13), vec3(0.78, 0.80, 0.83), dayF);
    hazeCol = mix(hazeCol, hazeCol * vec3(1.10, 0.98, 0.90), sunsetF * 0.7);
    hazeCol = mix(hazeCol, hazeCol * vec3(0.38, 0.40, 0.45), gloom);
    // thin haze only crushes the horizon; the thicker it gets, the higher it climbs toward the zenith, covering the whole sky
    float reach = mix(0.22, 1.0, u_haze * u_haze);
    float hz = u_haze * mix(1.0, reach, smoothstep(0.0, 0.45, h));
    sky = mix(sky, hazeCol, clamp(hz, 0.0, 0.96));
  }

  // ── Lens flare (only while the sun is on screen. An artifact inside the lens, so screen space) ──
  if (sunVis > 0.001) {
    vec3 proj = projectDir(sunDir, u_cam.x, u_cam.y, u_cam.z, aspect);
    if (proj.z > 0.0) {
      vec2 sunPos = proj.xy * 0.5 + 0.5;
      vec2 axis = vec2(0.5, 0.5) - sunPos;   // the optical axis from the sun to screen center
      // weaken the further it strays off-screen
      float onScreen = smoothstep(1.6, 0.9, max(abs(proj.x), abs(proj.y)));
      float fl = sunVis * smoothstep(0.02, 0.18, sunEl) * onScreen;
      vec3 flare = vec3(0.0);
      // ghosts lined up along the optical axis (each a different color, from chromatic aberration)
      flare += vec3(1.0, 0.75, 0.45) * 0.055 * ghost(p, sunPos + axis * 0.45, 0.030, aspect);
      flare += vec3(0.45, 1.0, 0.60) * 0.045 * ghost(p, sunPos + axis * 0.75, 0.018, aspect);
      flare += vec3(0.55, 0.65, 1.0) * 0.050 * ghost(p, sunPos + axis * 1.35, 0.055, aspect);
      flare += vec3(1.0, 0.55, 0.75) * 0.035 * ghost(p, sunPos + axis * 1.80, 0.095, aspect);
      // a large, faint colored ring
      float rg = length((p - (sunPos + axis * 1.1)) * vec2(aspect, 1.0));
      flare += vec3(0.9, 0.75, 1.0) * 0.030 * smoothstep(0.012, 0.0, abs(rg - 0.16));
      // an anamorphic-ish horizontal streak
      vec2 dsun = (p - sunPos) * vec2(aspect, 1.0);
      flare += vec3(0.8, 0.85, 1.0) * 0.10 * exp(-abs(dsun.y) * 60.0) * exp(-abs(dsun.x) * 4.0);
      sky += flare * fl;
    }
  }

  // the rim of a lens droplet: bleeds slightly dark
  sky = mix(sky, sky * 0.88 + vec3(0.03), clamp(dropMask, 0.0, 1.0) * 0.55);

  // ── Vignette ──
  sky *= 1.0 - 0.22 * length(p - vec2(0.5, 0.45));

  // ── Color filter ──
  if (u_filtAmt > 0.001) {
    float lum = dot(sky, vec3(0.2126, 0.7152, 0.0722));
    vec3 g = mix(vec3(lum), sky, u_filtSat) * u_filtTint;
    g = g * (1.0 - u_filtLift) + u_filtLift;   // lift only the blacks (whites don't move)
    sky = mix(sky, g, clamp(u_filtAmt, 0.0, 1.0));
  }

  // dither (to prevent banding)
  sky += (hash12(gl_FragCoord.xy + fract(u_time)) - 0.5) * (2.0 / 255.0);

  gl_FragColor = vec4(sky, 1.0);
}
`;

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

type Uniforms = Record<string, WebGLUniformLocation | null>;

const UNIFORM_NAMES = [
  'u_res', 'u_time', 'u_cam', 'u_sun',
  'u_cover', 'u_high', 'u_mid', 'u_low',
  'u_rain', 'u_snow', 'u_wind', 'u_thunder', 'u_haze', 'u_cbFeat',
  'u_windOff', 'u_evo',
  'u_filtAmt', 'u_filtTint', 'u_filtSat', 'u_filtLift',
] as const;

/**
 * The atmosphere renderer. One `render()` call is one frame (one image seen from one camera).
 *
 * To bake a cubemap, pass each face of `CUBE_FACE_CAMERAS` in turn and draw 6 times.
 */
export class AtmosphereRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private u: Uniforms = {};
  private lost = false;
  // kept so dispose() can detach them. A disposed renderer that still listens
  // would re-init on a context restore and steal the live renderer's program
  private readonly onLost = (e: Event) => { e.preventDefault(); this.lost = true; };
  private readonly onRestored = () => { this.lost = false; this.init(); };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.init();
  }

  /** false in environments where WebGL isn't available (the caller should keep its fallback background) */
  get available(): boolean { return this.gl !== null; }

  private init(): void {
    const gl = this.canvas.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'low-power',
    });
    if (!gl) { this.gl = null; return; }
    this.gl = gl;

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
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { this.gl = null; return; }

    const prog = gl.createProgram();
    if (!prog) { this.gl = null; return; }
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('atmosphere shader link error:', gl.getProgramInfoLog(prog));
      this.gl = null;
      return;
    }
    this.program = prog;
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
    const gl = this.gl;
    if (!gl || this.lost || !this.program) return;
    // bind every frame rather than only at init: another renderer sharing this
    // canvas (or anything else touching the context) may have swapped programs
    gl.useProgram(this.program);
    const u = this.u;
    gl.uniform2f(u.u_res, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.u_time, timeSec % TIME_WRAP_SEC);
    gl.uniform3f(u.u_cam, camera.yaw, camera.pitch, camera.fov);
    gl.uniform2f(u.u_sun, s.sunElevation, s.sunAzimuth);
    const c = s.clouds;
    gl.uniform1f(u.u_cover, s.cloudCover);
    gl.uniform3f(u.u_high, c.cirrus, c.cirrostratus, c.cirrocumulus);
    gl.uniform3f(u.u_mid, c.altostratus, c.altocumulus, c.nimbostratus);
    gl.uniform4f(u.u_low, c.stratus, c.stratocumulus, c.cumulus, c.cumulonimbus);
    gl.uniform1f(u.u_rain, s.rain);
    gl.uniform1f(u.u_snow, s.snow);
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
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (gl) {
      if (this.program) gl.deleteProgram(this.program);
      if (this.buffer) gl.deleteBuffer(this.buffer);
      if (options.loseContext) {
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    }
    this.gl = null;
    this.program = null;
    this.buffer = null;
  }
}
