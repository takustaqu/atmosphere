import { describe, expect, it } from 'vitest';
import { nominalSolarPosition, solarPosition } from '../src/sun';

const DEG = 180 / Math.PI;
const TOKYO = { latitude: 35.68, longitude: 139.77 };

describe('solarPosition', () => {
  it('Tokyo summer solstice culmination is ≈78° high, due south', () => {
    // solar noon in Tokyo is ~11:43 JST; the theoretical max elevation is
    // 90 − 35.68 + 23.44 ≈ 77.8°
    const { elevation, azimuth } = solarPosition(new Date('2026-06-21T11:43+09:00'), TOKYO);
    expect(elevation * DEG).toBeGreaterThan(77);
    expect(elevation * DEG).toBeLessThan(78.6);
    expect(azimuth * DEG).toBeGreaterThan(170);
    expect(azimuth * DEG).toBeLessThan(190);
  });

  it('Tokyo winter solstice culmination is ≈31° high', () => {
    // 90 − 35.68 − 23.44 ≈ 30.9°
    const { elevation } = solarPosition(new Date('2026-12-22T11:45+09:00'), TOKYO);
    expect(elevation * DEG).toBeGreaterThan(30);
    expect(elevation * DEG).toBeLessThan(32);
  });

  it('is below the horizon at midnight', () => {
    const { elevation } = solarPosition(new Date('2026-06-21T00:00+09:00'), TOKYO);
    expect(elevation).toBeLessThan(0);
  });

  it('rises in the east', () => {
    // Tokyo sunrise on the equinox is ~5:40 JST; azimuth should be near 90°
    const { elevation, azimuth } = solarPosition(new Date('2026-03-20T05:45+09:00'), TOKYO);
    expect(Math.abs(elevation * DEG)).toBeLessThan(3);
    expect(azimuth * DEG).toBeGreaterThan(80);
    expect(azimuth * DEG).toBeLessThan(100);
  });

  it('a Date is an absolute instant: the same moment gives the same sun regardless of offset notation', () => {
    const a = solarPosition(new Date('2026-06-21T11:43+09:00'), TOKYO);
    const b = solarPosition(new Date('2026-06-21T02:43Z'), TOKYO);
    expect(a.elevation).toBeCloseTo(b.elevation, 10);
    expect(a.azimuth).toBeCloseTo(b.azimuth, 10);
  });

  it('southern hemisphere: the noon sun is to the north', () => {
    const sydney = { latitude: -33.87, longitude: 151.21 };
    const { azimuth } = solarPosition(new Date('2026-06-21T12:00+10:00'), sydney);
    // north = 0 (or 2π)
    const fromNorth = Math.min(azimuth, 2 * Math.PI - azimuth);
    expect(fromNorth * DEG).toBeLessThan(30);
  });
});

describe('nominalSolarPosition', () => {
  it('noon: 46° elevation, due south', () => {
    const { elevation, azimuth } = nominalSolarPosition(12);
    expect(elevation).toBeCloseTo(Math.asin(0.72), 6);
    expect(azimuth).toBeCloseTo(Math.PI, 6);
  });

  it('6:00 rises in the east, 18:00 sets in the west', () => {
    expect(nominalSolarPosition(6).elevation).toBeCloseTo(0, 6);
    expect(nominalSolarPosition(6).azimuth).toBeCloseTo(Math.PI / 2, 6);
    expect(nominalSolarPosition(18).elevation).toBeCloseTo(0, 6);
    expect(nominalSolarPosition(18).azimuth).toBeCloseTo(Math.PI * 1.5, 6);
  });

  it('night: negative elevation', () => {
    expect(nominalSolarPosition(0).elevation).toBeLessThan(0);
  });
});
