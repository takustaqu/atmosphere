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
//
// And everything else about a turret is the same for every pixel of it as
// well: where in its cell it stands, how broad it is, the clock it grows and
// slumps to, and how high all that carries it — a power, a root, the crown's
// bend and a sine, read again for every turret near every pixel of the tower,
// a dozen or more of them, where a frame holds a few hundred turrets in all.
// So the table carries each turret whole (turretRow, cbTurret and the anvil
// look it up by id): its height, its center and its two hashes, worked out
// here once a frame in the shader's own arithmetic.

import { NOISE_SIZE, hash12, noiseLattice } from './noise.js';

/** rows of the table (see turretTable) */
export const TURRET_ROWS = 4;

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

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** The shader's cbReach: how high a thrust carries a tower, before anything shapes it */
export function cbReach(rise: number): number {
  return (Math.sqrt(1 + 2.4 * Math.max(rise - 1, 0)) - 1) / 1.2;
}

/** The shader's cbShape: the reach bent into a broad crown under the ceiling */
export function cbShape(y: number, ceil: number): number {
  const hs = ceil * 1.1;
  const x = y * 0.7;
  const u = 1 - Math.min(x / hs, 1);
  return hs * (1 - u * u) + 0.25 * Math.max(x - hs, 0);
}

/**
 * How big a storm the shader draws (its cbAmt inside the tower): the amount
 * of cumulonimbus, held at a third below that (the rest is how much of the
 * storm stands), less as the weather's gloom thickens
 */
export function stormAmount(cumulonimbus: number, rain: number, snow: number, wind: number): number {
  const gloom = Math.min(Math.max(Math.max(rain, Math.max(snow * 0.5, wind * 0.7)), 0), 1);
  return Math.max(cumulonimbus, 0.3) * (1 - gloom * 0.6);
}

/** a 0..1 value as two bytes, read back as hi + lo / 255 (the shader's turretThrust and rowTurret) */
function put(out: Uint8Array, o: number, v: number): void {
  const q = Math.round(Math.min(Math.max(v, 0), 1) * 65025);
  const hi = Math.floor(q / 255);
  out[o] = hi;
  out[o + 1] = q - hi * 255;
}

/**
 * The table for one frame: TURRET_SLOTS × TURRET_ROWS RGBA texels.
 *
 * Row 0 is the tower's row (seed 0): rg its thrust, the four-octave fbm4 the
 * shader raises into a turret's height; ba the same thrust as it stood
 * CB_LAG ago, over the coarse pair only — the anvil reads its past that
 * way, sharing the fine pair with the present, which barely moves over the
 * lag.
 *
 * Rows 1 and 2 are the turrets themselves, the tower's (seed 0) and the
 * congestus skirt's (seed 17): rg how high the turret stands, halved; ba
 * where its center is past the start of its cell, in cells. The tower's is
 * its thrust raised into a tower top (gain and ceiling from the storm's
 * size), the skirt's its two coarse octaves' say whether a tower is near
 * (times the skirt's height); each on a clock of its own, and the narrow
 * cell that closes the row (rowCell) sized down with it. Row 3 is each
 * turret's two hashes, for its breadth and its depth: rg the tower's, ba the
 * skirt's.
 *
 * @param distance the storm's distance (features.distance)
 * @param evo      shape evolution's integrated offset (u_evo)
 * @param amount   how big a storm (stormAmount)
 */
export function turretTable(distance: number, evo: number, amount = 0.3,
  out = new Uint8Array(TURRET_SLOTS * TURRET_ROWS * 4)): Uint8Array {
  const sc = cbScale(distance);
  const clock = cbClock(evo);
  const ox = 17.3, oy = 9.1;
  const gain = 1.05 + 1.35 * amount, ceil = 0.44 + 0.11 * amount;
  const skGain = 0.20 * (0.6 + 0.4 * amount) * smoothstep(0.02, 0.20, amount);
  const rows: [number, number][] = [[TOWER_TURRETS, 0], [SKIRT_TURRETS, 17]];
  rows.forEach(([n0, seed], row) => {
    const n = n0 * sc;
    const nI = Math.floor(n), nf = n - nI;
    // (the clock each turret grows and slumps to: turretRow's live)
    const live = evo * 0.35 * (row === 0 ? 1 : 1.3);
    const s2 = Math.fround(seed + 3.1), s3 = Math.fround(seed + 7.7), s5 = Math.fround(seed + 5.3);
    // every cell the shader can ask for, and the one past the last: a
    // division that rounds the wrong way can name it
    const count = Math.min(Math.ceil(n) + 1, TURRET_SLOTS);
    for (let id = 0; id < count; id++) {
      const ak = rowCenter(id, n, seed) * 2 * Math.PI / n;
      const qx = Math.sin(ak) * 0.85 * sc, qy = Math.cos(ak) * 0.85 * sc + clock;
      const x1 = qx * 2.03 + ox, y1 = qy * 2.03 + oy;
      const coarse = 0.5 * vnoise(qx, qy) + 0.25 * vnoise(x1, y1);
      let top: number;
      if (row === 0) {
        const o = id * 4;
        const x2 = x1 * 2.03 + ox, y2 = y1 * 2.03 + oy;
        const fine = 0.125 * vnoise(x2, y2) + 0.0625 * vnoise(x2 * 2.03 + ox, y2 * 2.03 + oy);
        const py = qy - CB_LAG, py1 = py * 2.03 + oy;
        const past = 0.5 * vnoise(qx, py) + 0.25 * vnoise(x1, py1);
        put(out, o, coarse + fine);
        put(out, o + 2, past + fine);
        const rk = Math.pow(Math.max(coarse + fine - 0.42, 0) * 4.6, 1.5) * gain + 0.25;
        top = cbShape(cbReach(rk), ceil);
      } else {
        top = smoothstep(0.35, 0.47, coarse + 0.094) * skGain;
      }
      // the turret: its hashes, the narrow cell's share of a turret, and
      // where in its cell it stands (rowCell)
      const h2 = hash12(id, s2), h3 = hash12(id, s3), h5 = hash12(id, s5);
      const part = id > nI - 0.5;
      const jit = (hash12(id, seed) - 0.5) * 0.4;
      const yk = top * (0.74 + 0.26 * (0.5 + 0.5 * Math.sin(live * (0.7 + 0.6 * h2) + h3 * 6.2831853)))
        * (part ? smoothstep(0, 0.6, nf) : 1);
      const o = ((row + 1) * TURRET_SLOTS + id) * 4;
      put(out, o, yk * 0.5);
      put(out, o + 2, part ? nf * (0.5 + jit) : 0.5 + jit);
      const oh = (3 * TURRET_SLOTS + id) * 4 + row * 2;
      out[oh] = Math.round(h2 * 255);
      out[oh + 1] = Math.round(h5 * 255);
    }
  });
  return out;
}
