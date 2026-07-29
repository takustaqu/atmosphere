// Weather controller — a sample for driving every atmosphere parameter by hand
//
//   pnpm playground  → http://localhost:8791/examples/controller/
//
// Drag the canvas to look around; scroll to change the field of view.
// Drawing is ray-basis, so sky, clouds, sun, moon and stars are all resolved
// as "what's visible in that direction". That means this isn't a flat
// background — it's the same as looking around the inside of a skybox
// draped over the scene. "Bake 6 faces" bakes that same sky into a cubemap.

import {
  Atmosphere, AtmosphereRenderer,
  CLOUD_GENERA, CLOUD_GENERA_IDS, CUBE_FACE_CAMERAS,
  FILTER_IDS, WEATHER_IDS, WEATHER_PRESETS,
  cloudGenusLabel, filterLabel, weatherLabel,
  formatTod, resolveConditions,
  type CloudMix, type Conditions,
  type FilterId, type GeoLocation, type Weather, type WeatherId,
} from '../../src';

const canvas = document.getElementById('sky') as HTMLCanvasElement;
const panel = document.getElementById('panel')!;

// ── Values driven by hand ──────────────────────────────
const CITIES: Record<string, GeoLocation | null> = {
  'None': null,
  'Wakkanai': { latitude: 45.42, longitude: 141.67 },
  'Tokyo': { latitude: 35.68, longitude: 139.77 },
  'Naha': { latitude: 26.21, longitude: 127.68 },
  'Reykjavik': { latitude: 64.15, longitude: -21.94 },
  'Sydney': { latitude: -33.87, longitude: 151.21 },
};

const ui = {
  timeOfDay: 14,
  dateISO: '2026-07-26',
  city: 'None',
  weather: {
    cloudCover: 0.38,
    precipitation: 0,
    precipitationType: 'rain' as 'rain' | 'snow',
    windSpeed: 3,
    thunder: 0,
    visibility: 25,
    convection: 0.7,
  },
  cloudMode: 'auto' as 'auto' | 'manual',
  clouds: Object.fromEntries(CLOUD_GENERA_IDS.map((g) => [g, 0])) as CloudMix,
  featureMode: 'auto' as 'auto' | 'manual',
  features: { anvil: 0, velum: 0 },
  filter: 'none' as FilterId,
};

// the camera (for looking around). Defaults to a background-friendly, south-facing framing
const cam = { yaw: Math.PI, pitch: 0.46, fov: 0.86 };

const sky = new Atmosphere(canvas, { time: ui.timeOfDay, weather: ui.weather, camera: cam });

/** build Conditions from the UI state and apply it */
function apply(): void {
  const loc = CITIES[ui.city];
  const conditions: Conditions = {
    // only pass a Date when a location is set (computing the real solar position needs a date)
    time: loc
      ? `${ui.dateISO}T${formatTod(ui.timeOfDay).padStart(5, '0')}`
      : ui.timeOfDay,
    location: loc,
    weather: {
      ...ui.weather,
      // leaving these undefined lets the cloud genus mix build automatically from cloud cover
      clouds: ui.cloudMode === 'manual' ? ui.clouds : undefined,
      features: ui.featureMode === 'manual' ? ui.features : undefined,
    } as Weather,
    filter: ui.filter,
  };
  sky.set(conditions);
  readout(conditions);
}

// ── Looking around ─────────────────────────────────────
// dragging feels like "grabbing the sky and pulling it". Scroll changes the field of view (zoom in to see cloud lobes)
let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
  canvas.classList.remove('dragging');
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  // dividing by fov over the canvas height keeps the feel consistent at any zoom level
  const k = cam.fov / canvas.clientHeight;
  cam.yaw -= (e.clientX - lastX) * k * 1.6;
  cam.pitch += (e.clientY - lastY) * k;
  cam.pitch = Math.max(-1.35, Math.min(1.45, cam.pitch));
  lastX = e.clientX; lastY = e.clientY;
  sky.set({ camera: cam });
  hud();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.fov = Math.max(0.22, Math.min(1.70, cam.fov * (1 + e.deltaY * 0.0012)));
  sky.set({ camera: cam });
  hud();
}, { passive: false });

const BEARINGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function hud(): void {
  const deg = ((cam.yaw * 180 / Math.PI) % 360 + 360) % 360;
  document.getElementById('bearing')!.textContent =
    `${BEARINGS[Math.round(deg / 45) % 8]} ${deg.toFixed(0)}°`;
  document.getElementById('angles')!.textContent =
    `elevation ${(cam.pitch * 180 / Math.PI).toFixed(0)}° / fov ${(cam.fov * 180 / Math.PI).toFixed(0)}°`;
}

// ── Panel building blocks ──────────────────────────────
function section(title: string): HTMLElement {
  const h = document.createElement('h2');
  h.textContent = title;
  panel.append(h);
  return h;
}

function note(text: string): void {
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = text;
  panel.append(p);
}

function slider(
  label: string, min: number, max: number, step: number,
  get: () => number, set: (v: number) => void, fmt: (v: number) => string,
): () => void {
  const row = document.createElement('div');
  row.className = 'row';
  const l = document.createElement('label');
  l.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step);
  const out = document.createElement('output');
  const sync = () => { input.value = String(get()); out.textContent = fmt(get()); };
  input.addEventListener('input', () => { set(Number(input.value)); out.textContent = fmt(get()); apply(); });
  row.append(l, input, out);
  panel.append(row);
  sync();
  return sync;
}

function chips(
  items: { id: string; label: string }[],
  isOn: (id: string) => boolean,
  pick: (id: string) => void,
): () => void {
  const box = document.createElement('div');
  box.className = 'chips';
  const els = items.map((it) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = it.label;
    b.addEventListener('click', () => { pick(it.id); apply(); refreshAll(); });
    box.append(b);
    return { id: it.id, el: b };
  });
  panel.append(box);
  const sync = () => els.forEach(({ id, el }) => el.classList.toggle('on', isOn(id)));
  sync();
  return sync;
}

const syncers: (() => void)[] = [];
const refreshAll = () => syncers.forEach((f) => f());

// ── Assembling the panel ────────────────────────────────
section('Presets');
note('Swap a full set of observation values in at once, then dial it in with the sliders below.');
syncers.push(chips(
  WEATHER_IDS.map((id) => ({ id, label: weatherLabel(id) })),
  () => false,
  (id) => {
    const p = WEATHER_PRESETS[id as WeatherId];
    ui.weather = {
      cloudCover: p.cloudCover ?? 0,
      precipitation: p.precipitation ?? 0,
      precipitationType: p.precipitationType ?? 'rain',
      windSpeed: p.windSpeed ?? 0,
      thunder: p.thunder ?? 0,
      visibility: p.visibility ?? 30,
      convection: p.convection ?? 0,
    };
    ui.cloudMode = 'auto';
    ui.featureMode = 'auto';
  },
));

section('Time and location');
syncers.push(slider('Time', 0, 24, 0.25,
  () => ui.timeOfDay, (v) => { ui.timeOfDay = v; }, (v) => formatTod(v)));
syncers.push(chips(
  Object.keys(CITIES).map((k) => ({ id: k, label: k })),
  (id) => ui.city === id,
  (id) => { ui.city = id; },
));
note('Pick a location and the real solar position (azimuth and elevation) is computed from the date and time.');

section('Weather (observation)');
syncers.push(slider('Cloud cover', 0, 1, 0.01,
  () => ui.weather.cloudCover, (v) => { ui.weather.cloudCover = v; }, (v) => v.toFixed(2)));
syncers.push(slider('Precipitation mm/h', 0, 50, 0.5,
  () => ui.weather.precipitation, (v) => { ui.weather.precipitation = v; }, (v) => v.toFixed(1)));
syncers.push(chips(
  [{ id: 'rain', label: 'Rain' }, { id: 'snow', label: 'Snow' }],
  (id) => ui.weather.precipitationType === id,
  (id) => { ui.weather.precipitationType = id as 'rain' | 'snow'; },
));
syncers.push(slider('Wind m/s', 0, 40, 0.5,
  () => ui.weather.windSpeed, (v) => { ui.weather.windSpeed = v; }, (v) => v.toFixed(1)));
syncers.push(slider('Thunder', 0, 1, 0.01,
  () => ui.weather.thunder, (v) => { ui.weather.thunder = v; }, (v) => v.toFixed(2)));
syncers.push(slider('Visibility km', 0.2, 45, 0.2,
  () => ui.weather.visibility, (v) => { ui.weather.visibility = v; }, (v) => v.toFixed(1)));
syncers.push(slider('Convection', 0, 1, 0.01,
  () => ui.weather.convection, (v) => { ui.weather.convection = v; }, (v) => v.toFixed(2)));

section('Cloud genera (the ten types)');
syncers.push(chips(
  [{ id: 'auto', label: 'From cloud cover' }, { id: 'manual', label: 'Set directly' }],
  (id) => ui.cloudMode === id,
  (id) => {
    // carry the current mix over when switching auto → manual, so it's a starting point to tweak from
    if (id === 'manual' && ui.cloudMode === 'auto') {
      for (const g of CLOUD_GENERA_IDS) ui.clouds[g] = sky.state.clouds[g];
    }
    ui.cloudMode = id as 'auto' | 'manual';
  },
));
const genusRows = CLOUD_GENERA_IDS.map((g) => {
  const info = CLOUD_GENERA[g];
  return slider(`${cloudGenusLabel(g).label} ${info.abbr}`, 0, 1, 0.01,
    () => ui.clouds[g], (v) => { ui.clouds[g] = v; ui.cloudMode = 'manual'; }, (v) => v.toFixed(2));
});
syncers.push(...genusRows);

section('Cumulonimbus companion forms');
syncers.push(chips(
  [{ id: 'auto', label: 'From development' }, { id: 'manual', label: 'Set directly' }],
  (id) => ui.featureMode === id,
  (id) => {
    if (id === 'manual' && ui.featureMode === 'auto') {
      ui.features = { ...sky.state.features };
    }
    ui.featureMode = id as 'auto' | 'manual';
  },
));
syncers.push(slider('Anvil', 0, 1, 0.01,
  () => ui.features.anvil, (v) => { ui.features.anvil = v; ui.featureMode = 'manual'; }, (v) => v.toFixed(2)));
syncers.push(slider('Veil', 0, 1, 0.01,
  () => ui.features.velum, (v) => { ui.features.velum = v; ui.featureMode = 'manual'; }, (v) => v.toFixed(2)));

section('Color filter');
syncers.push(chips(
  FILTER_IDS.map((id) => ({ id, label: filterLabel(id) })),
  (id) => ui.filter === id,
  (id) => { ui.filter = id as FilterId; },
));

section('Camera');
note('Drag the canvas to look around; scroll to change the field of view.');
syncers.push(slider('Field of view', 0.22, 1.70, 0.01,
  () => cam.fov, (v) => { cam.fov = v; sky.set({ camera: cam }); hud(); },
  (v) => `${(v * 180 / Math.PI).toFixed(0)}°`));
{
  const box = document.createElement('div');
  box.className = 'chips';
  const reset = document.createElement('button');
  reset.className = 'chip';
  reset.textContent = 'Reset framing';
  reset.addEventListener('click', () => {
    cam.yaw = Math.PI; cam.pitch = 0.46; cam.fov = 0.86;
    sky.set({ camera: cam }); hud(); refreshAll();
  });
  const bake = document.createElement('button');
  bake.className = 'chip';
  bake.textContent = 'Bake 6 faces';
  bake.addEventListener('click', bakeCubemap);
  box.append(reset, bake);
  panel.append(box);
}
const faces = document.createElement('div');
faces.id = 'faces';
panel.append(faces);

section('Resolved state');
note('How the observation values resolved into the renderer’s 0..1 parameters.');
const stateEl = document.createElement('div');
stateEl.id = 'state';
panel.append(stateEl);

function readout(c: Conditions): void {
  const s = resolveConditions(c);
  const pick = (o: Record<string, number>) => Object.entries(o)
    .filter(([, v]) => v > 0.005)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ') || '—';
  stateEl.textContent = [
    `sun       elevation ${(s.sunElevation * 180 / Math.PI).toFixed(1)}°  azimuth ${(s.sunAzimuth * 180 / Math.PI).toFixed(0)}°`,
    `cover     ${s.cloudCover.toFixed(2)}`,
    `rain ${s.rain.toFixed(2)}  snow ${s.snow.toFixed(2)}  wind ${s.wind.toFixed(2)}  thunder ${s.thunder.toFixed(2)}  haze ${s.haze.toFixed(2)}`,
    `clouds    ${pick(s.clouds as unknown as Record<string, number>)}`,
    `features  ${pick(s.features as unknown as Record<string, number>)}`,
  ].join('\n');
}

// ── Baking a cubemap ────────────────────────────────────
// Since drawing is ray-basis, all it takes is pointing the camera in 6
// directions at 90° fov. This button exists just to prove the sky can be
// exported as a skybox.
const FACE_NAMES = ['+X E', '-X W', '+Y up', '-Y down', '+Z N', '-Z S'];

function bakeCubemap(): void {
  const tmp = document.createElement('canvas');
  const renderer = new AtmosphereRenderer(tmp);
  if (!renderer.available) { renderer.dispose({ loseContext: true }); return; }
  renderer.resize(220, 220);
  const state = sky.state;
  faces.replaceChildren();
  CUBE_FACE_CAMERAS.forEach((face, i) => {
    renderer.render(performance.now() / 1000, state, face);
    // read it back within the same task, before the next draw overwrites the buffer
    const url = tmp.toDataURL();
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = url;
    const cap = document.createElement('figcaption');
    cap.textContent = FACE_NAMES[i];
    fig.append(img, cap);
    faces.append(fig);
  });
  // this canvas is thrown away, so hand the context back explicitly. Browsers
  // cap live WebGL contexts and evict the oldest, which would eventually be
  // the one drawing the sky behind this panel
  renderer.dispose({ loseContext: true });
}

document.getElementById('toggle')!.addEventListener('click', () => {
  panel.classList.toggle('hidden');
});

hud();
apply();
sky.jump();

// expose these for poking at from the console (this is a sample, after all)
(window as unknown as Record<string, unknown>).atmosphere = sky;
(window as unknown as Record<string, unknown>).atmosphereCamera = cam;
