// cubemap.ts — baking the sky into skybox faces
//
// The renderer draws along view rays, so pointing a 90° fov camera down the
// 6 axis directions yields a cubemap directly. This is the thin utility that
// does exactly that — for full control (progressive baking, readPixels into a
// texture, a shared context), drive AtmosphereRenderer + CUBE_FACE_CAMERAS
// yourself; this file is barely more than that loop.

import { AtmosphereRenderer } from './renderer';
import { CUBE_FACE_CAMERAS, resolveConditions, type Conditions } from './state';

export interface CubeFacesOptions {
  /** face size in pixels (square). Defaults to 512 */
  size?: number;
  /** the moment for time-based phenomena (rain phase, twinkle). Defaults to 0 */
  timeSec?: number;
}

/**
 * Render the 6 skybox faces for a set of conditions.
 *
 * Returns 6 square canvases in `CUBE_FACE_CAMERAS` order (+X east, -X west,
 * +Y zenith, -Y nadir, +Z north, -Z south), each a plain 2D canvas ready for
 * `drawImage`, `toDataURL`, or uploading as a cube-map face.
 *
 * Creates and disposes its own throwaway WebGL context per call — fine for
 * baking a skybox on a scene change, not meant to be called every frame.
 *
 * @throws when WebGL isn't available
 */
export function renderCubeFaces(
  conditions: Conditions = {},
  options: CubeFacesOptions = {},
): HTMLCanvasElement[] {
  const size = options.size ?? 512;
  const source = document.createElement('canvas');
  const renderer = new AtmosphereRenderer(source);
  if (!renderer.available) {
    renderer.dispose({ loseContext: true });
    throw new Error('atmosphere: WebGL is not available');
  }

  const state = resolveConditions(conditions);
  renderer.resize(size, size);
  try {
    return CUBE_FACE_CAMERAS.map((camera) => {
      renderer.render(options.timeSec ?? 0, state, camera);
      const face = document.createElement('canvas');
      face.width = size;
      face.height = size;
      // copy synchronously, before the drawing buffer can be cleared by compositing
      face.getContext('2d')!.drawImage(source, 0, 0);
      return face;
    });
  } finally {
    // a throwaway context: release it for real, or repeated bakes evict the
    // page's live contexts (browsers cap how many can exist at once)
    renderer.dispose({ loseContext: true });
  }
}
