// atmosphere — a renderer that reproduces the sky from time and weather
//
//   const sky = new Atmosphere(canvas, { time: new Date(), weather: 'rain' });
//
// No DOM/framework dependency. React bindings are the sample in examples/.

export { Atmosphere, type AtmosphereOptions } from './atmosphere';
export { AtmosphereRenderer } from './renderer';
export { StateAnimator, lerpWrapped, type AnimatorOptions } from './animator';
export { renderCubeFaces, type CubeFacesOptions } from './cubemap';

export {
  resolveConditions,
  resolveCamera,
  DEFAULT_CAMERA,
  CUBE_FACE_CAMERAS,
  type Conditions,
  type AtmosphereState,
  type Camera,
} from './state';

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
} from './clouds';

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
} from './weather';

export {
  FILTER_PRESETS,
  FILTER_IDS,
  isFilterId,
  resolveFilter,
  type ColorFilter,
  type FilterId,
  type FilterInput,
  type FilterPreset,
} from './filter';

export {
  solarPosition,
  nominalSolarPosition,
  type GeoLocation,
  type SolarPosition,
} from './sun';

export { formatTod, toTimeOfDay, toDate, type TimeInput } from './time';

export {
  weatherLabel,
  filterLabel,
  cloudGenusLabel,
  WEATHER_LABELS,
  FILTER_LABELS,
  CLOUD_LABELS,
  type Locale,
  type CloudGenusLabel,
} from './i18n';
