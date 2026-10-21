// storm.ts — each cumulonimbus turret's thrust, read on the CPU
//
// A thunderhead's skyline is a row of turrets (turretRow in renderer.ts),
// and how high each may climb is the storm's thrust read once, at the
// turret's center — one number per turret, the same for every pixel of it.
// The shader used to read it per pixel all the same: three or four turrets
// for each of the tower's row, its skirt's and the flank's second look, and
// the anvil's plate read the same turrets again, five at a time — dozens of
// noise reads a pixel, every one of them landing on a value a turret's
// worth of pixels had already read.
//
// Worse, they read it through the texture filter. The thrust rides the
// storm's clock, and the filter carries a read's position between two
// lattice texels in a few bits: as the clock slid the read along, a turret's
// thrust stood still for several frames and then jumped a step, and its
// whole head jumped with it — the crown rattled up in steps as it grew, and
// the anvil it fed spread and shrank a turret at a time.
//
// So the turrets are read here instead, once a frame, from the same 8-bit
// lattice blended in full precision (vnoiseHQ's arithmetic), and handed to
// the shader as a small table it looks up by the turret's id. The numbers
// are the ones the shader read before, without the staircase.

import { NOISE_SIZE, hash12, noiseLattice } from './noise.js';

/**
 * Slots per row of the table: room for every turret round the sky at the
 * nearest a storm stands and more — a row holds 72·cbScale of them, 252 at a
 * distance of 1, and past 512 the far turrets wrap onto the near ones' slots.
 */
export const TURRET_SLOTS = 512;

/** turrets round the whole sky at the middle distance: the tower's row, and the congestus skirt's */
export const TOWER_TURRETS = 40;
export const SKIRT_TURRETS = 72;

/** how far back a turret's past is read (the shader's CB_LAG) */
const CB_LAG = 0.25;

/** The shader's cbScale: how much of the sky the storm takes, from its distance */
export function cbScale(d: number): number {
  return Math.exp(0.8515 * (Math.exp(2.585 * (d - 0.65)) - 1));
}

/** The shader's cbClock: how far the storm's thrust has drifted, from u_evo */
export function cbClock(evo: number): number {
  return evo * 0.12;
}

/** vnoiseHQ: the lattice's four corners round p, smoothstepped and blended in full precision */
function vnoise(x: number, y: number): number {
  const l = noiseLattice();
  const n = NOISE_SIZE;
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % n) + n) % n, y0 = ((iy % n) + n) % n;
  const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
  const a = l[y0 * n + x0] / 255, b = l[y0 * n + x1] / 255;
  const c = l[y1 * n + x0] / 255, d = l[y1 * n + x1] / 255;
  const lo = a + (b - a) * fx, hi = c + (d - c) * fx;
  return lo + (hi - lo) * fy;
}

/**
 * The center of cell id of a row of n round the sky, in the row's own count —
 * rowCell's arithmetic, for a cell counted from 0 without wrapping. n need not
 * be whole: the last cell takes what is left over.
 */
function rowCenter(id: number, n: number, seed: number): number {
  const nI = Math.floor(n), nf = n - nI;
  const jit = (hash12(id, seed) - 0.5) * 0.4;
  return id > nI - 0.5 ? nI + nf * (0.5 + jit) : id + 0.5 + jit;
}

/** a 0..1 value as two bytes, read back as hi + lo / 255 (the shader's turretThrust) */
function put(out: Uint8Array, o: number, v: number): void {
  const q = Math.round(Math.min(Math.max(v, 0), 1) * 65025);
  const hi = Math.floor(q / 255);
  out[o] = hi;
  out[o + 1] = q - hi * 255;
}

/**
 * The table for one frame: TURRET_SLOTS × 2 RGBA texels.
 *
 * Row 0 is the tower's row (seed 0): rg its thrust, the four-octave fbm4 the
 * shader raises into a turret's height; ba the same thrust as it stood
 * CB_LAG ago, over the coarse pair only — the anvil reads its past that
 * way, sharing the fine pair with the present, which barely moves over the
 * lag. Row 1 is the congestus skirt's (seed 17): rg the thrust's two coarse
 * octaves, which only have to say whether a tower is near.
 *
 * @param distance the storm's distance (features.distance)
 * @param evo      shape evolution's integrated offset (u_evo)
 */
export function turretTable(distance: number, evo: number, out = new Uint8Array(TURRET_SLOTS * 2 * 4)): Uint8Array {
  const sc = cbScale(distance);
  const clock = cbClock(evo);
  const ox = 17.3, oy = 9.1;
  const rows: [number, number][] = [[TOWER_TURRETS, 0], [SKIRT_TURRETS, 17]];
  rows.forEach(([n0, seed], row) => {
    const n = n0 * sc;
    // every cell the shader can ask for, and the one past the last: a
    // division that rounds the wrong way can name it
    const count = Math.min(Math.ceil(n) + 1, TURRET_SLOTS);
    for (let id = 0; id < count; id++) {
      const ak = rowCenter(id, n, seed) * 2 * Math.PI / n;
      const qx = Math.sin(ak) * 0.85 * sc, qy = Math.cos(ak) * 0.85 * sc + clock;
      const x1 = qx * 2.03 + ox, y1 = qy * 2.03 + oy;
      const coarse = 0.5 * vnoise(qx, qy) + 0.25 * vnoise(x1, y1);
      const o = (row * TURRET_SLOTS + id) * 4;
      if (row === 0) {
        const x2 = x1 * 2.03 + ox, y2 = y1 * 2.03 + oy;
        const fine = 0.125 * vnoise(x2, y2) + 0.0625 * vnoise(x2 * 2.03 + ox, y2 * 2.03 + oy);
        const py = qy - CB_LAG, py1 = py * 2.03 + oy;
        const past = 0.5 * vnoise(qx, py) + 0.25 * vnoise(x1, py1);
        put(out, o, coarse + fine);
        put(out, o + 2, past + fine);
      } else {
        put(out, o, coarse);
        out[o + 2] = 0;
        out[o + 3] = 0;
      }
    }
  });
  return out;
}
