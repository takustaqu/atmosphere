import { describe, expect, it } from 'vitest';
import {
  illuminatedFraction, lunarEcliptic, lunarEclipse, lunarPosition, nominalLunarPosition,
  nominalSolarPosition, solarEcliptic, solarPosition,
} from '../src/sun';

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

describe('lunarPosition', () => {
  it('is full on the night of a full moon, and new on a new moon', () => {
    // 2026-01-03 10:03 UTC and 2026-01-18 19:52 UTC, from the almanac
    expect(lunarPosition(new Date('2026-01-03T10:03Z'), TOKYO).phase).toBeGreaterThan(0.97);
    expect(lunarPosition(new Date('2026-01-18T19:52Z'), TOKYO).phase).toBeLessThan(0.03);
  });

  it('a January full moon stands high in the south of Tokyo around midnight', () => {
    // a January full moon rides the summer sun's path: it culminates near 78°,
    // where the azimuth swings through the south quickly, so only the height
    // is pinned down here
    const { elevation, azimuth } = lunarPosition(new Date('2026-01-03T23:30+09:00'), TOKYO);
    expect(elevation * DEG).toBeGreaterThan(70);
    expect(azimuth * DEG).toBeGreaterThan(90);
    expect(azimuth * DEG).toBeLessThan(270);
  });

  it('is half lit a week after new', () => {
    // first quarter 2026-01-26 04:48 UTC
    const { phase } = lunarPosition(new Date('2026-01-26T04:48Z'), TOKYO);
    expect(phase).toBeGreaterThan(0.42);
    expect(phase).toBeLessThan(0.58);
  });

  it('illuminatedFraction: opposite the sun is full, beside it is new', () => {
    const sun = { elevation: 0.3, azimuth: Math.PI };
    expect(illuminatedFraction(sun, { elevation: -0.3, azimuth: 0 })).toBeCloseTo(1, 6);
    expect(illuminatedFraction(sun, sun)).toBeCloseTo(0, 6);
  });
});

describe('nominalLunarPosition', () => {
  it('is a full moon opposite the nominal sun: rises at sunset, souths at midnight', () => {
    expect(nominalLunarPosition(0).phase).toBe(1);
    expect(nominalLunarPosition(0).elevation).toBeCloseTo(nominalSolarPosition(12).elevation, 9);
    expect(nominalLunarPosition(12).elevation).toBeLessThan(0);
    expect(nominalLunarPosition(18).elevation).toBeCloseTo(0, 6);
  });
});

describe('lunarEcliptic', () => {
  it('matches the worked example in Meeus (1992 April 12, 0h TD)', () => {
    // λ 133.162655°, β −3.229126°, Δ 368409.7 km; the Date is UT, so step
    // back by the ~58 s that TD ran ahead then
    const m = lunarEcliptic(new Date(Date.UTC(1992, 3, 12) - 57.6e3));
    expect(Math.abs(m.longitude * DEG - 133.162655)).toBeLessThan(0.005);
    expect(Math.abs(m.latitude * DEG + 3.229126)).toBeLessThan(0.005);
    expect(Math.abs(m.distance - 368409.7)).toBeLessThan(20);
  });

  it('solarEcliptic matches Meeus 25.a (1992 October 13) once nutation is taken back out', () => {
    // apparent λ 199.90895° with −0.00478°·sin Ω of nutation in it; Ω ≈ 264.65°
    const s = solarEcliptic(new Date(Date.UTC(1992, 9, 13) - 57.6e3));
    expect(Math.abs(s.longitude * DEG - (199.90895 + 0.00478 * Math.sin(264.65 / DEG)))).toBeLessThan(0.002);
    expect(s.distance).toBeCloseTo(0.99766, 4);
  });
});

describe('lunarEclipse', () => {
  // times of greatest eclipse and umbral magnitudes from NASA's catalogue.
  // The magnitudes there use Danjon's enlargement of the shadow, a shade
  // smaller than Chauvenet's fiftieth used here, hence the slack
  it('is total at the maximum of 2026-03-03', () => {
    const e = lunarEclipse(new Date('2026-03-03T11:33Z'));
    expect(e.umbra).toBe(1);
    expect(e.penumbra).toBe(1);
    expect(Math.abs(e.magnitude - 1.153)).toBeLessThan(0.02);
  });

  it('is total at the maximum of 2025-09-07', () => {
    const e = lunarEclipse(new Date('2025-09-07T18:11Z'));
    expect(e.umbra).toBe(1);
    expect(Math.abs(e.magnitude - 1.362)).toBeLessThan(0.02);
  });

  it('is a deep partial on 2026-08-28: most of the disc, not all of it', () => {
    const e = lunarEclipse(new Date('2026-08-28T04:13Z'));
    expect(e.umbra).toBeGreaterThan(0.85);
    expect(e.umbra).toBeLessThan(1);
    expect(e.penumbra).toBe(1);
    expect(Math.abs(e.magnitude - 0.930)).toBeLessThan(0.02);
  });

  it('has the moon only grazing the umbra on 2024-09-18', () => {
    const e = lunarEclipse(new Date('2024-09-18T02:44Z'));
    expect(e.umbra).toBeGreaterThan(0);
    expect(e.umbra).toBeLessThan(0.1);
    expect(Math.abs(e.magnitude - 0.085)).toBeLessThan(0.02);
  });

  it('a penumbral eclipse touches the penumbra and misses the umbra (2023-05-05)', () => {
    const e = lunarEclipse(new Date('2023-05-05T17:23Z'));
    expect(e.umbra).toBe(0);
    expect(e.penumbra).toBeGreaterThan(0.9);
  });

  it('a plain full moon passes beside the shadow', () => {
    const e = lunarEclipse(new Date('2026-04-02T02:12Z'));
    expect(e.umbra).toBe(0);
    expect(e.penumbra).toBe(0);
  });

  it('a day before the eclipse there is none', () => {
    const e = lunarEclipse(new Date('2026-03-02T11:33Z'));
    expect(e.umbra).toBe(0);
    expect(e.penumbra).toBe(0);
  });

  it('the shadow comes and goes over hours, not at once', () => {
    // totality of 2026-03-03 lasts about an hour around 11:34; the partial
    // phases run an hour either side of it
    const at = (t: string) => lunarEclipse(new Date(t)).umbra;
    expect(at('2026-03-03T09:30Z')).toBe(0);
    expect(at('2026-03-03T10:15Z')).toBeGreaterThan(0);
    expect(at('2026-03-03T10:15Z')).toBeLessThan(1);
    expect(at('2026-03-03T11:10Z')).toBe(1);
    expect(at('2026-03-03T12:00Z')).toBe(1);
    expect(at('2026-03-03T13:30Z')).toBe(0);
  });
});
