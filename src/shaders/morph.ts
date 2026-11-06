// morph.ts — the sky cache's morph shader
//
// Stripped as it is bundled, like the sky's (scripts/strip-glsl.mjs).

/**
 * The sky cache's morph: how the stack reshapes between two keyframes in
 * place, past the drift its motion target already moves it by.
 *
 * Moved by the wind, the two keyframes either side of a frame line up for
 * every cloud the wind carries — but much of what a cloud does is not to
 * be carried. Its outline crumbles and swells on the evolution clock (a
 * tower climbs, a lobe buds, a cumulus's warp drifts), and between two
 * keyframes all of that could only dissolve: a tower's flank that grew by
 * a few texels sat still and faded to its new place, a step each keyframe
 * up its outline. That reshaping is no sum of velocities the layers know,
 * but it can be seen: between the earlier keyframe (moved on by the wind
 * run between them) and the later, each patch of the stack has moved by
 * some small offset. This finds it — Lucas–Kanade: the offset that best
 * takes the earlier's patch onto the later's, over a 5×5 grid of reads 1.5
 * texels apart, refined once — for every 4×4 texels of the later keyframe,
 * in the earlier's angles. It reads the whole stack, so where layers
 * cross it follows whichever carries the texture. Where the window holds
 * none to tell by (a clear sky, a flat deck) it finds nothing and leaves
 * the dissolve; a move over three texels is not believed (an outline in
 * the way, or something new) and is held to that. The composite moves each
 * keyframe along it by its share of the interval, as it does along the drift.
 *
 * A program of its own, not the sky's: some 120 reads a texel at a
 * sixteenth of a keyframe's texels, found column by column as the
 * keyframe's columns are built
 */
export const MORPH_FRAG = `
precision highp float;
uniform sampler2D u_ka;     // the earlier keyframe
uniform sampler2D u_kb;     // the later
uniform sampler2D u_fa;     // their motion targets (see the composite's cacheFetch)
uniform sampler2D u_fb;
uniform vec4 u_mapA;        // their maps (see u_map0)
uniform vec4 u_mapB;
uniform vec4 u_boxA;        // the texels the earlier holds, as directions (see u_box0)
uniform vec4 u_boxB;        // the texels the later holds, as its uv: low and high across, then up
uniform vec2 u_texels;      // a keyframe's size in texels
uniform vec2 u_out;         // this target's
uniform float u_dw;         // the wind run from the earlier keyframe to the later

const int K = 3;
const int G = 7;
const float SP = 1.5;

vec3 dirOn(vec4 map, vec2 uv) {
  float el = map.y + uv.y * map.w, az = map.x + (uv.x - 0.5) * map.z;
  float ce = cos(el);
  return vec3(ce * sin(az), sin(el), ce * cos(az));
}
vec2 anglesOn(vec4 map, vec3 d) {
  float a = atan(d.x, d.z) - map.x;
  a -= 6.2831853 * floor(a / 6.2831853 + 0.5);
  return vec2(a, asin(clamp(d.y, -1.0, 1.0)));
}
vec2 uvOn(vec4 map, vec2 ae) {
  return vec2(0.5 + ae.x / map.z, (ae.y - map.y) / map.w);
}
// (the composite's cacheShift)
vec3 shift(vec3 d, vec2 v, float dw) {
  vec2 X = d.xz / max(d.y, 0.03) + v * dw;
  if (d.y > 0.03) return normalize(vec3(X.x, 1.0, X.y));
  vec2 h = normalize(X) * length(d.xz);
  return vec3(h.x, d.y, h.y);
}
// what the offset is matched on: the stack's light and its cover together
float sig(vec4 c) {
  return dot(c.rgb, vec3(0.30, 0.55, 0.15)) + 0.5 * (1.0 - c.a);
}

void main() {
  vec2 uv0 = gl_FragCoord.xy / u_out;
  vec2 px = 1.0 / u_texels;
  // radians a texel, across and up
  vec2 tex = vec2(u_mapB.z, u_mapB.w) / u_texels;
  // the drift here, as the composite blends it
  vec3 d0 = dirOn(u_mapB, uv0);
  vec4 f0 = texture2D(u_fa, uvOn(u_mapA, anglesOn(u_mapA, d0))), f1 = texture2D(u_fb, uv0);
  vec2 v = (f0.xy + f1.xy) / max(f0.z + f1.z, 1e-3);
  // the later keyframe over the window, and the earlier where the wind
  // carried each of its texels from
  float b[49];
  float a[49];
  vec2 ae[49];
  for (int j = 0; j < G; j++) {
    for (int i = 0; i < G; i++) {
      vec2 uv = clamp(uv0 + vec2(float(i - K), float(j - K)) * SP * px, u_boxB.xz, u_boxB.yw);
      b[j * G + i] = sig(texture2D(u_kb, uv));
      ae[j * G + i] = clamp(anglesOn(u_mapA, shift(dirOn(u_mapB, uv), v, u_dw)), u_boxA.xz, u_boxA.yw);
      a[j * G + i] = sig(texture2D(u_ka, uvOn(u_mapA, ae[j * G + i])));
    }
  }
  // the inner 5×5, its gradients from the samples either side; the
  // earlier's patch moved by r matches the later's: g·r = b - a
  float m00 = 0.0, m01 = 0.0, m11 = 0.0;
  vec2 rhs = vec2(0.0);
  for (int j = 1; j < G - 1; j++) {
    for (int i = 1; i < G - 1; i++) {
      vec2 g = vec2(b[j * G + i + 1] - b[j * G + i - 1], b[j * G + i + G] - b[j * G + i - G]) / (2.0 * SP);
      m00 += g.x * g.x; m01 += g.x * g.y; m11 += g.y * g.y;
      rhs += g * (b[j * G + i] - a[j * G + i]);
    }
  }
  float det = m00 * m11 - m01 * m01;
  float tr = m00 + m11;
  // the window's weaker direction of texture: nothing to tell by, no move
  float lmin = 0.5 * (tr - sqrt(max(tr * tr - 4.0 * det, 0.0)));
  float trust = smoothstep(1e-4, 1e-3, lmin);
  vec2 r = vec2(0.0);
  if (trust > 0.0) {
    mat2 inv = mat2(m11, -m01, -m01, m00) / det;
    r = inv * rhs;
    r *= min(1.0, 3.0 / max(length(r), 1e-6));
    // refined once: the earlier read again where r puts it
    vec2 rhs2 = vec2(0.0);
    for (int j = 1; j < G - 1; j++) {
      for (int i = 1; i < G - 1; i++) {
        vec2 g = vec2(b[j * G + i + 1] - b[j * G + i - 1], b[j * G + i + G] - b[j * G + i - G]) / (2.0 * SP);
        vec2 q = clamp(ae[j * G + i] + r * tex, u_boxA.xz, u_boxA.yw);
        rhs2 += g * (b[j * G + i] - sig(texture2D(u_ka, uvOn(u_mapA, q))));
      }
    }
    r += inv * rhs2;
    r *= min(1.0, 3.0 / max(length(r), 1e-6)) * trust;
  }
  gl_FragColor = vec4(r * tex, trust, 1.0);
}
`;
