// state.ts — from input (time, location, weather, filter) to renderer state
//
// This is effectively atmosphere's public interface:
//   Conditions (what a human specifies) → AtmosphereState (what the renderer interprets)

import { resolveCelestial, type Celestial, type CelestialInput } from './celestial.js';
import { resolveFilter, type ColorFilter, type FilterInput } from './filter.js';
import { resolvePolarizer, type Polarizer, type PolarizerInput } from './polarizer.js';
import { nominalSolarPosition, solarPosition, type GeoLocation } from './sun.js';
import { toDate, toTimeOfDay, type TimeInput } from './time.js';
import { resolveTone, type ToneCurve, type ToneInput } from './tone.js';
import { resolveWeather, type WeatherInput, type WeatherState } from './weather.js';

/**
 * The camera: where the sky is being viewed from.
 *
 * All drawing happens along view rays cast from this camera, so drawing the
 * 6 directions at fov=90° produces a cubemap (skybox) directly.
 */
export interface Camera {
  /** view azimuth in radians. north=0, east=π/2, south=π */
  yaw: number;
  /** view elevation in radians. positive is upward */
  pitch: number;
  /** vertical field of view in radians */
  fov: number;
}

/** A background-friendly framing where the horizon sits just below the frame (south-facing, 26° elevation, 49° fov) */
export const DEFAULT_CAMERA: Camera = {
  yaw: Math.PI,
  pitch: 0.46,
  fov: 0.86,
};

/** Cameras for the 6 skybox faces, in +X, -X, +Y, -Y, +Z, -Z order */
export const CUBE_FACE_CAMERAS: readonly Camera[] = [
  { yaw: Math.PI / 2, pitch: 0, fov: Math.PI / 2 },        // +X east
  { yaw: -Math.PI / 2, pitch: 0, fov: Math.PI / 2 },       // -X west
  { yaw: 0, pitch: Math.PI / 2, fov: Math.PI / 2 },        // +Y zenith
  { yaw: 0, pitch: -Math.PI / 2, fov: Math.PI / 2 },       // -Y nadir
  { yaw: 0, pitch: 0, fov: Math.PI / 2 },                  // +Z north
  { yaw: Math.PI, pitch: 0, fov: Math.PI / 2 },            // -Z south
];

/** What a human specifies. Everything is optional; omitted fields keep their current value */
export interface Conditions {
  /** time of day. a 0..24 number / Date / "14:30" / ISO string */
  time?: TimeInput;
  /** observation site. When given, the real solar position is computed from `time` (as a Date) */
  location?: GeoLocation | null;
  /** weather, either a preset name or raw observation values */
  weather?: WeatherInput;
  /** color filter — a display-referred grade (sepia, mono, …) */
  filter?: FilterInput;
  /** tone curve — scene-referred: exposure, contrast, highlight shoulder */
  tone?: ToneInput;
  /** circular polarizer. Darkens the sky 90° from the sun and leaves the clouds alone */
  polarizer?: PolarizerInput;
  /** what is behind the air: light pollution, the Milky Way, meteors */
  celestial?: CelestialInput;
  /** camera (partial is fine) */
  camera?: Partial<Camera>;
}

/** The state the renderer interprets. Every field is a number that can be interpolated */
export interface AtmosphereState extends WeatherState {
  /** 0..24, used for UI display and for how far clouds drift when time is moved */
  timeOfDay: number;
  /** solar elevation in radians. horizon=0 */
  sunElevation: number;
  /** solar azimuth in radians. north=0, east=π/2 */
  sunAzimuth: number;
  filter: ColorFilter;
  tone: ToneCurve;
  polarizer: Polarizer;
  celestial: Celestial;
}

export const DEFAULT_CONDITIONS: Required<Pick<Conditions, 'time' | 'weather'>> = {
  time: 12,
  weather: 'clear',
};

/** Resolve a specification into the state the renderer can be given */
export function resolveConditions(c: Conditions): AtmosphereState {
  const time = c.time ?? DEFAULT_CONDITIONS.time;
  const timeOfDay = toTimeOfDay(time);
  const date = toDate(time);

  // Use the real solar position only when both a location and a date are
  // available; otherwise fall back to "nowhere in particular, mid-northern latitude"
  const sun = c.location && date
    ? solarPosition(date, c.location)
    : nominalSolarPosition(timeOfDay);

  return {
    timeOfDay,
    sunElevation: sun.elevation,
    sunAzimuth: sun.azimuth,
    ...resolveWeather(c.weather ?? DEFAULT_CONDITIONS.weather),
    filter: resolveFilter(c.filter),
    tone: resolveTone(c.tone),
    polarizer: resolvePolarizer(c.polarizer),
    celestial: resolveCelestial(c.celestial),
  };
}

/** Fill in a partially-specified camera */
export function resolveCamera(c?: Partial<Camera> | null): Camera {
  return { ...DEFAULT_CAMERA, ...c };
}
