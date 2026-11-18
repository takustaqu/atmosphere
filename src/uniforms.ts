// Uniform values belong to a linked program, not the current context binding.
// Keep the last values with each location so an unchanged sky only uploads
// its clocks. Every pass (including probes and composites) uses these setters:
// an override then becomes the value the next pass compares against.
export interface UniformSlot {
  location: WebGLUniformLocation;
  x?: number;
  y?: number;
  z?: number;
  w?: number;
}

export type Uniforms = Record<string, UniformSlot | null>;

export function uniformSlot(location: WebGLUniformLocation | null): UniformSlot | null {
  return location === null ? null : { location };
}

export function uniform1f(gl: WebGLRenderingContext, u: UniformSlot | null, x: number): void {
  if (!u || Object.is(u.x, x)) return;
  gl.uniform1f(u.location, x);
  u.x = x;
}

export function uniform2f(gl: WebGLRenderingContext, u: UniformSlot | null, x: number, y: number): void {
  if (!u || (Object.is(u.x, x) && Object.is(u.y, y))) return;
  gl.uniform2f(u.location, x, y);
  u.x = x; u.y = y;
}

export function uniform3f(gl: WebGLRenderingContext, u: UniformSlot | null, x: number, y: number, z: number): void {
  if (!u || (Object.is(u.x, x) && Object.is(u.y, y) && Object.is(u.z, z))) return;
  gl.uniform3f(u.location, x, y, z);
  u.x = x; u.y = y; u.z = z;
}

export function uniform4f(gl: WebGLRenderingContext, u: UniformSlot | null, x: number, y: number, z: number, w: number): void {
  if (!u || (Object.is(u.x, x) && Object.is(u.y, y) && Object.is(u.z, z) && Object.is(u.w, w))) return;
  gl.uniform4f(u.location, x, y, z, w);
  u.x = x; u.y = y; u.z = z; u.w = w;
}
