// vert.ts — the vertex shader every program shares: a quad over the frame
//
// Stripped as it is bundled, like the fragment shaders (scripts/strip-glsl.mjs).

export const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;
