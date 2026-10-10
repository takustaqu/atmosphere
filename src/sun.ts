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

/**
 * The moon's azimuth and elevation from a date and location, and how much
 * of it is lit. The classic low-precision series (a few terms of the lunar
 * longitude and latitude), good to about a degree — plenty for where it
 * stands in a sky and which way its horns point. Geocentric: the parallax
 * that would lower it up to a degree near the horizon is left out.
 */
export function lunarPosition(date: Date, loc: GeoLocation): LunarPosition {
  const d = daysSinceJ2000(date);

  const L = RAD * (218.316 + 13.176396 * d);               // mean longitude
  const M = RAD * (134.963 + 13.064993 * d);               // mean anomaly
  const F = RAD * (93.272 + 13.229350 * d);                // argument of latitude

  const l = L + RAD * 6.289 * Math.sin(M);                 // ecliptic longitude
  const b = RAD * 5.128 * Math.sin(F);                     // ecliptic latitude

  const dec = Math.asin(
    Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l),
  );
  const ra = Math.atan2(
    Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY),
    Math.cos(l),
  );

  const { elevation, azimuth } = toHorizontal(ra, dec, d, loc);
  const sun = solarPosition(date, loc);
  return { elevation, azimuth, phase: illuminatedFraction(sun, { elevation, azimuth }) };
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
