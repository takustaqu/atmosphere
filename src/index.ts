// atmosphere — a renderer that reproduces the sky from time and weather
//
//   const sky = new Atmosphere(canvas, { time: new Date(), weather: 'rain' });
//
// No DOM/framework dependency. React bindings are the sample in examples/.

export { Atmosphere, type AtmosphereOptions, type LightProbeOptions } from './atmosphere.js';
export { AtmosphereRenderer, type RendererOptions, type ProbeOptions, type GpuTime } from './renderer.js';
export { ResolutionGovernor, type GovernorOptions } from './governor.js';
export { StateAnimator, lerpWrapped, type AnimatorOptions } from './animator.js';
export { renderCubeFaces, type CubeFacesOptions } from './cubemap.js';

export {
  resolveConditions,
  resolveCamera,
  DEFAULT_CAMERA,
  CUBE_FACE_CAMERAS,
  type Conditions,
  type AtmosphereState,
  type Camera,
} from './state.js';

export {
  CLOUD_GENERA,
  CLOUD_GENERA_IDS,
  NO_CLOUDS,
  NO_FEATURES,
  resolveClouds,
  defaultCloudMix,
  defaultCloudFeatures,
  aggregateCover,
  type CloudGenus,
  type CloudGenusInfo,
  type CloudLevel,
  type CloudForm,
  type CloudMix,
  type CloudsInput,
  type CloudFeatures,
} from './clouds.js';

export {
  WEATHER_PRESETS,
  WEATHER_IDS,
  isWeatherId,
  resolveWeather,
  type Weather,
  type WeatherId,
  type WeatherInput,
  type WeatherPreset,
  type WeatherState,
  type PrecipitationType,
} from './weather.js';

export {
  FILTER_PRESETS,
  FILTER_IDS,
  isFilterId,
  resolveFilter,
  type ColorFilter,
  type FilterId,
  type FilterInput,
  type FilterPreset,
} from './filter.js';

export {
  CELESTIAL_PRESETS,
  CELESTIAL_IDS,
  isCelestialId,
  resolveCelestial,
  milkyWayFromBortle,
  DEFAULT_CELESTIAL,
  type Celestial,
  type CelestialId,
  type CelestialInput,
  type CelestialPreset,
} from './celestial.js';

export {
  TONE_PRESETS,
  TONE_IDS,
  isToneId,
  resolveTone,
  NEUTRAL_TONE,
  type ToneCurve,
  type ToneId,
  type ToneInput,
  type TonePreset,
} from './tone.js';

export {
  POLARIZER_PRESETS,
  POLARIZER_IDS,
  isPolarizerId,
  resolvePolarizer,
  NO_POLARIZER,
  type Polarizer,
  type PolarizerId,
  type PolarizerInput,
  type PolarizerPreset,
} from './polarizer.js';

export {
  celestialLights,
  summarizeProbe,
  mixMeasurement,
  sampleLightGrid,
  sampleEnvironment,
  sampleFromLinear,
  cameraForward,
  probeLayout,
  MOON_RELATIVE,
  type AtmosphereLight,
  type CelestialLight,
  type EnvironmentLight,
  type FrameLight,
  type LightGrid,
  type LightMeasurement,
  type LightSample,
  type ProbeLayout,
  type Vec3,
} from './light.js';

export {
  resolveLens,
  DEFAULT_LENS,
  type Lens,
  type LensInput,
} from './lens.js';

export {
  resolveParticles,
  DEFAULT_PARTICLES,
  type Particles,
  type ParticlesInput,
} from './particles.js';

export {
  srgbToDisplayP3,
  displayP3ToSrgb,
  SRGB_TO_DISPLAY_P3,
  DISPLAY_P3_TO_SRGB,
  type ColorSpaceOption,
} from './gamut.js';

export {
  solarPosition,
  nominalSolarPosition,
  type GeoLocation,
  type SolarPosition,
} from './sun.js';

export { formatTod, toTimeOfDay, toDate, type TimeInput } from './time.js';

export {
  weatherLabel,
  filterLabel,
  cloudGenusLabel,
  WEATHER_LABELS,
  FILTER_LABELS,
  CLOUD_LABELS,
  type Locale,
  type CloudGenusLabel,
} from './i18n.js';
