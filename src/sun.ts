// sun.ts — solar and lunar position
//
// The renderer takes the sun as a **world-space direction (azimuth, elevation)**,
// not a screen-space coordinate. That means computing the real solar position
// from latitude/longitude and date lets Wakkanai in June and Singapore in
// December actually look different.
//
// Coordinate system: azimuth is north=0, east=+π/2, south=π (radians).
// Elevation is horizon=0, zenith=π/2.

export interface GeoLocation {
  /** latitude in degrees, north positive */
  latitude: number;
  /** longitude in degrees, east positive */
  longitude: number;
}

export interface SolarPosition {
  /** elevation in radians. horizon=0, zenith=π/2, negative at night */
  elevation: number;
  /** azimuth in radians. north=0, east=π/2, south=π, west=3π/2 */
  azimuth: number;
}

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
/** obliquity of the ecliptic */
const OBLIQUITY = 23.4397 * RAD;

/**
 * Compute the sun's azimuth and elevation from a date and location
 * (NOAA's simplified formula). Accurate to roughly ±1 arcminute — plenty
 * for reproducing how the sky looks.
 */
export function solarPosition(date: Date, loc: GeoLocation): SolarPosition {
  const d = date.getTime() / DAY_MS - 0.5 + J1970 - J2000;   // days since J2000

  const M = RAD * (357.5291 + 0.98560028 * d);               // mean anomaly
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;                // ecliptic longitude of the sun

  const dec = Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));  // declination
  const ra = Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L));  // right ascension

  return toHorizontal(ra, dec, d, loc);
}

/** equatorial coordinates → azimuth and elevation at a site, at `d` days since J2000 */
function toHorizontal(ra: number, dec: number, d: number, loc: GeoLocation): SolarPosition {
  const lw = RAD * -loc.longitude;
  const phi = RAD * loc.latitude;
  const H = RAD * (280.16 + 360.9856235 * d) - lw - ra;      // hour angle

  const elevation = Math.asin(
    Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H),
  );
  // atan2 measures westward from south; rebase to north
  const azimuth = Math.atan2(
    Math.sin(H),
    Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi),
  ) + Math.PI;

  return { elevation, azimuth: ((azimuth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) };
}

/** days since J2000, the epoch both ephemerides count from */
function daysSinceJ2000(date: Date): number {
  return date.getTime() / DAY_MS - 0.5 + J1970 - J2000;
}

export interface LunarPosition extends SolarPosition {
  /**
   * the illuminated fraction of the disc, 0..1 — 0 at new moon, 1 at full.
   *
   * The phase as a shape (which limb is lit, how the terminator curves) is
   * not a number here: the renderer lights the disc as a sphere from the
   * sun's own direction, so it follows from the two positions.
   */
  phase: number;
}

/** Where the moon is against the stars, seen from the Earth's centre */
export interface LunarEcliptic {
  /** geocentric ecliptic longitude in radians, on the mean equinox of date */
  longitude: number;
  /** geocentric ecliptic latitude in radians */
  latitude: number;
  /** distance between the centres of the Earth and the moon, km */
  distance: number;
}

/** Where the sun is against the stars, seen from the Earth's centre */
export interface SolarEcliptic {
  /** apparent geocentric ecliptic longitude in radians (aberration in, nutation out) */
  longitude: number;
  /** distance in astronomical units */
  distance: number;
}

/**
 * Terrestrial time minus universal time, in seconds. The ephemerides run on
 * the even clock of the planets, Dates on the Earth's slowing spin; the gap
 * is about 69 s now and moves slowly, and the moon covers half an arcsecond
 * a second, so a rough figure is plenty: a line through the measured values
 * since 1950, held flat outside the years it was drawn through.
 */
function deltaT(date: Date): number {
  const y = Math.min(Math.max(date.getUTCFullYear(), 1950), 2050);
  return y < 2000 ? 29 + (y - 1950) * 0.68 : 64 + (y - 2000) * 0.2;
}

/** julian centuries since J2000, on terrestrial time */
function centuriesTT(date: Date): number {
  return (daysSinceJ2000(date) + deltaT(date) / 86400) / 36525;
}

const norm360 = (x: number) => ((x % 360) + 360) % 360;

// The main periodic terms of the moon's longitude and distance (Meeus,
// Astronomical Algorithms, table 47.A): multiples of D, M, M′, F, then the
// longitude in 1e-6 degrees and the distance in metres. The full table runs
// to sixty rows; the ones dropped here are each under a thousandth of a degree
const LR_TERMS: readonly (readonly number[])[] = [
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782],
  [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636],
  [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379],
  [1, 1, 0, 0, 4987, -16675],
  [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445],
  [4, 0, 0, 0, 3861, -11650],
  [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0],
  [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322],
  [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0],
  [2, -2, -1, 0, 2048, -4950],
  [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0],
  [4, -1, -1, 0, 1215, -3958],
  [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258],
  [2, 1, 1, 0, -810, 2616],
  [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117],
  [2, 2, -1, 0, -700, 2354],
  [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0],
  [4, 0, 1, 0, 549, -1423],
  [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571],
  [1, 0, -2, 0, -487, -1739],
  [2, 0, -1, -2, 0, 8752],
];

// and of its latitude (table 47.B), in 1e-6 degrees
const B_TERMS: readonly (readonly number[])[] = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200],
  [2, 1, 0, -1, -3359],
  [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065],
  [0, 1, -1, -1, -1870],
  [4, 0, -1, -1, 1828],
  [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749],
  [0, 1, -1, 1, -1565],
  [1, 0, 0, 1, -1491],
  [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410],
  [0, 1, 0, -1, -1344],
  [1, 0, 0, -1, -1335],
  [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021],
  [4, 0, -1, 1, 833],
];

/**
 * The moon against the stars from the Earth's centre: the abridged lunar
 * theory of Meeus (Astronomical Algorithms, ch. 47) — the fifty largest
 * terms in longitude and distance and thirty in latitude, good to some ten
 * arcseconds. That is what an eclipse of the moon asks for: the Earth's
 * shadow is only about 0.7° in radius, and a degree's error would put a
 * total eclipse on the wrong night, or nowhere.
 */
export function lunarEcliptic(date: Date): LunarEcliptic {
  const T = centuriesTT(date);
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  const Lp = RAD * norm360(218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000);
  const D = RAD * norm360(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000);
  const M = RAD * norm360(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000);
  const Mp = RAD * norm360(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000);
  const F = RAD * norm360(93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000);
  const A1 = RAD * norm360(119.75 + 131.849 * T);
  const A2 = RAD * norm360(53.09 + 479264.290 * T);
  const A3 = RAD * norm360(313.45 + 481266.484 * T);
  // the Earth's orbit is slowly rounding out, and the terms that ride on the
  // sun's anomaly shrink with it
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const eFactor = (m: number) => (m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E);

  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of LR_TERMS) {
    const arg = d * D + m * M + mp * Mp + f * F;
    const e = eFactor(m);
    sl += l * e * Math.sin(arg);
    sr += r * e * Math.cos(arg);
  }
  for (const [d, m, mp, f, b] of B_TERMS) {
    sb += b * eFactor(m) * Math.sin(d * D + m * M + mp * Mp + f * F);
  }
  // the pulls of Venus and Jupiter, and the Earth's flattening
  sl += 3958 * Math.sin(A1) + 1962 * Math.sin(Lp - F) + 318 * Math.sin(A2);
  sb += -2235 * Math.sin(Lp) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F)
      + 175 * Math.sin(A1 + F) + 127 * Math.sin(Lp - Mp) - 115 * Math.sin(Lp + Mp);

  return {
    longitude: RAD * norm360(Lp / RAD + sl / 1e6),
    latitude: RAD * (sb / 1e6),
    distance: 385000.56 + sr / 1000,
  };
}

/**
 * The sun against the stars from the Earth's centre (Meeus ch. 25, the low
 * accuracy one — a hundredth of a degree), with the aberration that shifts
 * where it appears. Nutation is left out, as it is from the moon's: it would
 * move both alike, and only the difference matters for an eclipse.
 */
export function solarEcliptic(date: Date): SolarEcliptic {
  const T = centuriesTT(date);
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = RAD * norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
          + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const e = 0.016708634 - 0.000042037 * T;
  const R = 1.000001018 * (1 - e * e) / (1 + e * Math.cos(M + RAD * C));
  // aberration: the sun shows where it was 8 minutes ago, 20.5″ behind
  return { longitude: RAD * norm360(L0 + C - 0.005691611 / R), distance: R };
}

/** the obliquity of the ecliptic on the date, for turning the moon's place onto the sky */
function obliquityOfDate(date: Date): number {
  return RAD * (23.4392911 - 0.0130042 * centuriesTT(date));
}

/**
 * The moon's azimuth and elevation from a date and location, and how much
 * of it is lit. Its place is {@link lunarEcliptic}'s — finer than the sky
 * alone would need, because its eclipses need it. Geocentric: the parallax
 * that would lower it up to a degree near the horizon is left out.
 */
export function lunarPosition(date: Date, loc: GeoLocation): LunarPosition {
  const d = daysSinceJ2000(date);
  const { longitude: l, latitude: b } = lunarEcliptic(date);
  const eps = obliquityOfDate(date);

  const dec = Math.asin(
    Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l),
  );
  const ra = Math.atan2(
    Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps),
    Math.cos(l),
  );

  const { elevation, azimuth } = toHorizontal(ra, dec, d, loc);
  const sun = solarPosition(date, loc);
  return { elevation, azimuth, phase: illuminatedFraction(sun, { elevation, azimuth }) };
}

export interface LunarEclipse {
  /** the fraction of the moon's disc inside the Earth's umbra, 0..1 — 1 in totality */
  umbra: number;
  /** the fraction inside the penumbra (the umbra included), 0..1 */
  penumbra: number;
  /**
   * the umbral magnitude, the figure the almanacs list: how far into the
   * umbra the moon reaches, in moon diameters. Negative when it misses
   */
  magnitude: number;
}

/**
 * Whether the moon stands in the Earth's shadow, and how deep. Geocentric,
 * since an eclipse of the moon is the same for everyone who can see it.
 *
 * The shadow's centre is the point opposite the sun. Its radii at the moon's
 * distance follow from the parallaxes and the sun's size: the umbra is the
 * Earth's own width narrowed by the sun's, the penumbra widened by it — and
 * both enlarged by a fiftieth for the air the shadow passes through
 * (Chauvenet's rule). Then the overlap of two circles, the shadow and the disc.
 */
export function lunarEclipse(date: Date): LunarEclipse {
  const moon = lunarEcliptic(date);
  const sun = solarEcliptic(date);

  // how far the moon is from the shadow's centre, in degrees
  const cosSigma = Math.cos(moon.latitude) * Math.cos(moon.longitude - sun.longitude - Math.PI);
  const sigma = Math.acos(Math.min(Math.max(cosSigma, -1), 1)) / RAD;

  const parallax = Math.asin(6378.14 / moon.distance) / RAD;
  const sunRadius = 0.266563 / sun.distance;
  const sunParallax = 0.00244 / sun.distance;
  const moonRadius = 0.272481 * parallax;
  const umbraR = 1.02 * (0.99834 * parallax - sunRadius + sunParallax);
  const penumbraR = 1.02 * (0.99834 * parallax + sunRadius + sunParallax);

  return {
    umbra: discCovered(moonRadius, umbraR, sigma),
    penumbra: discCovered(moonRadius, penumbraR, sigma),
    magnitude: (umbraR + moonRadius - sigma) / (2 * moonRadius),
  };
}

/** the fraction of a disc of radius r covered by a circle of radius R whose centre is d away */
function discCovered(r: number, R: number, d: number): number {
  if (d >= r + R) return 0;
  if (d <= R - r) return 1;
  if (d <= r - R) return (R * R) / (r * r);
  // the lens where the two overlap
  const acos = (x: number) => Math.acos(Math.min(Math.max(x, -1), 1));
  const a = acos((d * d + r * r - R * R) / (2 * d * r));
  const b = acos((d * d + R * R - r * r) / (2 * d * R));
  const lens = r * r * a + R * R * b
    - 0.5 * Math.sqrt(Math.max((-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R), 0));
  return Math.min(Math.max(lens / (Math.PI * r * r), 0), 1);
}

/**
 * How much of the moon is lit, from where the sun and the moon stand in the
 * sky: a disc lit by a distant sun shows (1 − cos e) / 2 of its face, e being
 * the angle between the two. Opposite the sun it is full; beside it, new.
 */
export function illuminatedFraction(sun: SolarPosition, moon: SolarPosition): number {
  const a = toVec(sun), b = toVec(moon);
  const cosE = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return (1 - cosE) / 2;
}

function toVec(p: SolarPosition): [number, number, number] {
  const ce = Math.cos(p.elevation);
  return [ce * Math.sin(p.azimuth), Math.sin(p.elevation), ce * Math.cos(p.azimuth)];
}

/**
 * Solar position for when no location is given.
 * Rises in the east at 6:00, souths at 12:00, sets in the west at 18:00 —
 * "nowhere in particular, mid-northern latitude". Peak elevation is 46°,
 * chosen so the noon sun fits inside the default camera framing.
 */
export function nominalSolarPosition(timeOfDay: number): SolarPosition {
  const phase = (timeOfDay - 6) / 12;                        // 6:00=0, 18:00=1
  return {
    elevation: Math.asin(Math.sin(phase * Math.PI) * 0.72),
    azimuth: Math.PI / 2 + phase * Math.PI,                  // east → south → west
  };
}

/**
 * Lunar position for when no date is given: a full moon, which is the one
 * that stands opposite the sun — it rises at sunset, souths at midnight and
 * sets at sunrise, on the sun's own nominal path shifted by twelve hours.
 * Full because that is the moon the renderer has always drawn its nights by,
 * and because without a date there is no phase to be right about.
 */
export function nominalLunarPosition(timeOfDay: number): LunarPosition {
  return { ...nominalSolarPosition(timeOfDay + 12), phase: 1 };
}
