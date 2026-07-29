// atmosphere — a renderer that reproduces the sky from time and weather
//
//   const sky = new Atmosphere(canvas, { time: new Date(), weather: 'rain' });
//
// No DOM/framework dependency. React bindings are the sample in examples/.

export { Atmosphere, type AtmosphereOptions } from './atmosphere.js';
export { AtmosphereRenderer } from './renderer.js';
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
