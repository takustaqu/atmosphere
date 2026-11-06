// variants.ts — a variant's source: the sky's shader behind its defines
//
// A variant's key (features.ts) becomes the #extension and #define lines put
// in front of FRAG. Nothing else in the text differs from one variant to the
// next.

import { CACHE_BITS, CACHE_BUILD, FEATURE_DEFINES } from '../features.js';
import { FRAG } from './sky.js';

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
export function fragSource(explicitLod: boolean, split: boolean, key: number, motion = false): string {
  let defines = '';
  for (const [bit, name] of FEATURE_DEFINES) if (key & bit) defines += `#define ${name}\n`;
  // an #extension directive has to precede every non-preprocessor token
  return (explicitLod
    ? '#extension GL_EXT_shader_texture_lod : enable\n'
      + '#define NOISE_FETCH(uv) texture2DLodEXT(u_noise, (uv), 0.0)\n'
      + '#define NOISEQ_FETCH(uv) texture2DLodEXT(u_noiseQ, (uv), 0.0)\n'
      + '#define TURRET_FETCH(uv) texture2DLodEXT(u_turrets, (uv), 0.0)\n'
    : '#define NOISE_FETCH(uv) texture2D(u_noise, (uv))\n'
      + '#define NOISEQ_FETCH(uv) texture2D(u_noiseQ, (uv))\n'
      + '#define TURRET_FETCH(uv) texture2D(u_turrets, (uv))\n'
  ) + (explicitLod
    // the composite's read of the cloud stack sits in a branch too; same reason
    ? '#define CLOUD_FETCH(uv) texture2DLodEXT(u_clouds, (uv), 0.0)\n'
    : '#define CLOUD_FETCH(uv) texture2D(u_clouds, (uv))\n'
  ) + (split ? '#define CLOUD_SPLIT\n' : '') + cacheDefines(explicitLod, key, motion) + defines + FRAG;
}

/**
 * The sky cache's two programs (see CACHE_BUILD): the split's code with its
 * mode fixed, the build's or the composite's. Nothing for any other key, so
 * every other program's source is what it always was
 */
function cacheDefines(explicitLod: boolean, key: number, motion: boolean): string {
  // (every program writes its colour through FRAG_OUT: gl_FragColor, but in
  // a keyframe build with motion gl_FragData[0] — a shader that writes one
  // may not write the other, even on a line it never reaches)
  if (!(key & CACHE_BITS)) return '#define FRAG_OUT gl_FragColor\n';
  const build = (key & CACHE_BUILD) !== 0;
  // (the composite's code is still in the build's source, behind a branch
  // on the mode that folds away; it has to compile all the same)
  return (motion && build
    // the keyframe's motion is its second target (WEBGL_draw_buffers);
    // the directive has to come before every other token, as above
    ? '#extension GL_EXT_draw_buffers : require\n#define FRAG_OUT gl_FragData[0]\n'
    : '#define FRAG_OUT gl_FragColor\n')
    + (build
      ? '#define CLOUD_SPLIT\n#define CLOUD_CACHE 1.0\n#define CACHE_BUILD\n'
      : '#define CLOUD_SPLIT\n#define CLOUD_CACHE 2.0\n#define CACHE_COMP\n')
    + (motion ? '#define CACHE_MOTION\n' : '')
    + (explicitLod
      ? '#define CLOUD_FETCH2(uv) texture2DLodEXT(u_clouds2, (uv), 0.0)\n'
        + '#define MAP_FETCH(s, uv) texture2DLodEXT((s), (uv), 0.0)\n'
        + '#define FLOW_FETCH(uv) texture2DLodEXT(u_flow, (uv), 0.0)\n'
        + '#define FLOW_FETCH2(uv) texture2DLodEXT(u_flow2, (uv), 0.0)\n'
      : '#define CLOUD_FETCH2(uv) texture2D(u_clouds2, (uv))\n'
        + '#define MAP_FETCH(s, uv) texture2D((s), (uv))\n'
        + '#define FLOW_FETCH(uv) texture2D(u_flow, (uv))\n'
        + '#define FLOW_FETCH2(uv) texture2D(u_flow2, (uv))\n');
}
