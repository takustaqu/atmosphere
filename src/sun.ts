// sun.ts — solar position
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
