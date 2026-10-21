import { describe, expect, it } from 'vitest';
import { NOISE_SIZE, noiseLattice, noiseQuads } from '../src/noise.js';

describe('noiseQuads', () => {
  it("holds each texel's square of four, wrapping as the lattice tiles", () => {
    const l = noiseLattice(), q = noiseQuads();
    const n = NOISE_SIZE;
    const at = (x: number, y: number) => l[((y + n) % n) * n + ((x + n) % n)];
    expect(q.length).toBe(n * n * 4);
    for (const [x, y] of [[0, 0], [17, 3], [n - 1, 5], [9, n - 1], [n - 1, n - 1]]) {
      const o = (y * n + x) * 4;
      expect([q[o], q[o + 1], q[o + 2], q[o + 3]])
        .toEqual([at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)]);
    }
  });
});
