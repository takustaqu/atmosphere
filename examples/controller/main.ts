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
  CELESTIAL_IDS, CELESTIAL_PRESETS,
  POLARIZER_IDS, POLARIZER_PRESETS, TONE_IDS, TONE_PRESETS,
  CLOUD_GENERA, CLOUD_GENERA_IDS, CUBE_FACE_CAMERAS,
  FILTER_IDS, WEATHER_IDS, WEATHER_PRESETS,
  cloudGenusLabel, filterLabel, weatherLabel,
  formatTod, resolveConditions,
  type CloudMix, type Conditions,
  type CelestialId, type FilterId, type PolarizerId, type ToneId, type GeoLocation, type Weather, type WeatherId,
  type AtmosphereLight, type LightSample,
} from '../../src';
import { Figure } from './figure';

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
  tone: { ...TONE_PRESETS.neutral } as { exposure: number; contrast: number; knee: number; bleach: number },
  polarizer: { ...POLARIZER_PRESETS.none } as {
    strength: number; angle: number; saturation: number; stopLoss: number;
  },
  // starts on the default suburban sky, so the controller opens on exactly the
  // sky it has always shown
  celestial: { ...CELESTIAL_PRESETS.suburban } as {
    bortle: number; milkyWay: number; meteors: number;
    radiant: readonly [number, number] | null;
  },
  lens: { droplets: 1 },
};

// the camera (for looking around). Defaults to a background-friendly, south-facing framing
const cam = { yaw: Math.PI, pitch: 0.46, fov: 0.86 };

const figureEl = document.getElementById('figure') as HTMLCanvasElement;
const figure = new Figure(figureEl);
// lightProbe measures the sky ten times a second; onLight hands each result over
const sky = new Atmosphere(canvas, {
  time: ui.timeOfDay, weather: ui.weather, camera: cam,
  lightProbe: true,
  // the sky is the content here, not interface motion, so it keeps moving
  // under prefers-reduced-motion (Windows sets that whenever "Animation
  // effects" is off)
  respectReducedMotion: false,
  onLight: (light) => {
    // cam, not sky.camera: this can fire from inside the constructor (a still
    // frame on a synchronous compile), before sky is assigned
    if (figureEl.classList.contains('on')) figure.draw(light, cam, canvas);
    showLight(light);
  },
});
// expose for scripted QA, same as the playground's __skies (headless viewers
// report visibility=hidden so rAF never fires; a script can jump() to draw)
(globalThis as any).__sky = sky;

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
    celestial: ui.celestial,
    tone: ui.tone,
    polarizer: ui.polarizer,
    lens: ui.lens,
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
// Controls append to whichever drawer is currently open, not to the panel — so
// section() switches the target and every slider() / chips() / note() after it
// lands inside. The panel had grown past a screenful of flat rows.
let host: HTMLElement = panel;

function section(title: string, open = false): HTMLElement {
  const box = document.createElement('details');
  box.className = 'drawer';
  if (open) box.open = true;
  const head = document.createElement('summary');
  head.textContent = title;
  const body = document.createElement('div');
  body.className = 'drawer-body';
  box.append(head, body);
  panel.append(box);
  host = body;
  return head;
}

function note(text: string): void {
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = text;
  host.append(p);
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
  host.append(row);
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
  host.append(box);
  const sync = () => els.forEach(({ id, el }) => el.classList.toggle('on', isOn(id)));
  sync();
  return sync;
}

const syncers: (() => void)[] = [];
const refreshAll = () => syncers.forEach((f) => f());

// ── Assembling the panel ────────────────────────────────
section('Presets', true);
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

section('Tone curve');
note('Scene-referred: these act on linear light before it becomes display values, '
  + 'which is the only place they mean anything. The knee is the one to watch — '
  + 'below it the curve is exactly identity, so at 0.80 only blown highlights are '
  + 'shaped. Bring it down and it starts being a look.');
syncers.push(chips(
  TONE_IDS.map((id) => ({ id, label: TONE_PRESETS[id].label })),
  (id) => {
    const t = TONE_PRESETS[id as ToneId];
    return ui.tone.exposure === t.exposure && ui.tone.contrast === t.contrast
      && ui.tone.knee === t.knee && ui.tone.bleach === t.bleach;
  },
  (id) => { ui.tone = { ...TONE_PRESETS[id as ToneId] }; },
));
syncers.push(slider('Exposure (stops)', -2, 2, 0.05,
  () => ui.tone.exposure, (v) => { ui.tone.exposure = v; }, (v) => v.toFixed(2)));
syncers.push(slider('Contrast @18%', 0.5, 1.8, 0.01,
  () => ui.tone.contrast, (v) => { ui.tone.contrast = v; }, (v) => v.toFixed(2)));
syncers.push(slider('Shoulder knee', 0.05, 0.99, 0.01,
  () => ui.tone.knee, (v) => { ui.tone.knee = v; }, (v) => v.toFixed(2)));
syncers.push(slider('Highlight bleach', 0, 1, 0.01,
  () => ui.tone.bleach, (v) => { ui.tone.bleach = v; }, (v) => v.toFixed(2)));

section('Circular polarizer');
note('An optical filter, not a grade: it rejects light by polarization, so it '
  + 'darkens the sky 90 degrees from the sun and leaves the clouds — whose light '
  + 'is unpolarized — alone. Best seen on a clear or lightly clouded day with the '
  + 'sun off to one side. Turn the angle to sweep the effect.');
syncers.push(chips(
  POLARIZER_IDS.map((id) => ({ id, label: POLARIZER_PRESETS[id].label })),
  (id) => {
    const p = POLARIZER_PRESETS[id as PolarizerId];
    return ui.polarizer.strength === p.strength && ui.polarizer.angle === p.angle;
  },
  (id) => { ui.polarizer = { ...POLARIZER_PRESETS[id as PolarizerId] }; },
));
syncers.push(slider('Strength', 0, 1, 0.01,
  () => ui.polarizer.strength, (v) => { ui.polarizer.strength = v; }, (v) => v.toFixed(2)));
syncers.push(slider('Filter angle', 0, 180, 1,
  () => (ui.polarizer.angle * 180) / Math.PI,
  (v) => { ui.polarizer.angle = (v * Math.PI) / 180; }, (v) => `${v.toFixed(0)}deg`));
syncers.push(slider('Saturation gain', 0, 1, 0.01,
  () => ui.polarizer.saturation, (v) => { ui.polarizer.saturation = v; }, (v) => v.toFixed(2)));
syncers.push(slider('Real stop loss', 0, 1, 0.01,
  () => ui.polarizer.stopLoss, (v) => { ui.polarizer.stopLoss = v; }, (v) => v.toFixed(2)));

section('Night sky');
note('Only visible after dark — wind Time past sunset to see any of it.');
syncers.push(chips(
  CELESTIAL_IDS.map((id) => ({ id, label: CELESTIAL_PRESETS[id].label })),
  (id) => {
    const p = CELESTIAL_PRESETS[id as CelestialId];
    return ui.celestial.bortle === p.bortle && ui.celestial.milkyWay === p.milkyWay
      && ui.celestial.meteors === p.meteors;
  },
  (id) => { ui.celestial = { ...CELESTIAL_PRESETS[id as CelestialId] }; },
));
syncers.push(slider('Light pollution (Bortle)', 1, 9, 1,
  () => ui.celestial.bortle, (v) => { ui.celestial.bortle = v; }, (v) => String(v)));
syncers.push(slider('Milky Way', 0, 1, 0.01,
  () => ui.celestial.milkyWay, (v) => { ui.celestial.milkyWay = v; }, (v) => v.toFixed(2)));
syncers.push(slider('Meteors ZHR/h', 0, 3000, 25,
  () => ui.celestial.meteors, (v) => { ui.celestial.meteors = v; }, (v) => String(v)));
note('ZHR counts what an observer watching the WHOLE sky would see in an hour, and '
  + 'this frame covers under a fifth of it — so an honest ZHR 150 (the Geminids at '
  + 'their peak) puts roughly one meteor in shot every few minutes. Real, and far '
  + 'too rare to look at. Past ~150 you have left reality; around 1500 they arrive '
  + 'every few seconds.');

section('Lens');
note('Raindrops sitting on the lens — they collect only while it rains, and '
  + 'bend the sky behind them. Switch them off for rain seen through clean glass.');
syncers.push(chips(
  [{ id: 'on', label: 'Droplets on' }, { id: 'off', label: 'Off' }],
  (id) => (id === 'on') === (ui.lens.droplets > 0),
  (id) => { ui.lens.droplets = id === 'on' ? 1 : 0; },
));
syncers.push(slider('Droplets', 0, 1, 0.01,
  () => ui.lens.droplets, (v) => { ui.lens.droplets = v; }, (v) => v.toFixed(2)));

section('Foreground light');
note('What sky.light hands to a renderer drawing in front of the sky. The figure '
  + 'is lit from these numbers alone: fill from the dome behind the camera, the '
  + 'frame grid bled over its edges, and a rim from the sun or moon when it is '
  + 'ahead of the camera. Turn toward the sun at a low angle to see the rim.');
syncers.push(chips(
  [{ id: 'on', label: 'Show figure' }, { id: 'off', label: 'Hide' }],
  (id) => (id === 'on') === figureEl.classList.contains('on'),
  (id) => { figureEl.classList.toggle('on', id === 'on'); },
));
const swatches = document.createElement('div');
swatches.className = 'swatches';
host.append(swatches);

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

function showLight(l: AtmosphereLight): void {
  const hex = (s: LightSample) => `rgb(${s.srgb.map((v) => Math.round(v * 255)).join(',')})`;
  const rows: [string, string, string][] = [];
  const add = (name: string, s: LightSample | undefined) => {
    if (s) rows.push([hex(s), name, `Y ${s.luminance.toFixed(3)}`]);
  };
  add('frame average', l.frame?.average);
  add('sky dome', l.environment?.sky);
  add('horizon', l.environment?.horizon);
  add('ground', l.environment?.ground);
  const key = l.key ? l[l.key] : null;
  if (key) {
    const lin = key.color.map((c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
    rows.push([`rgb(${lin.map((v) => Math.round(v * 255)).join(',')})`,
      `key: ${l.key}`,
      `× ${key.intensity.toFixed(2)}  ${key.view[2] > 0 ? 'ahead (backlight)' : 'behind (front light)'}`]);
  }
  swatches.replaceChildren(...rows.flatMap(([bg, name, v]) => {
    const i = document.createElement('i');
    i.style.background = bg;
    const t = document.createElement('span');
    t.textContent = `${name} — ${v}`;
    return [i, t];
  }));
}

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
  // sync: the six faces are drawn and read back within this call, so there is
  // no later frame for an asynchronous compile to land on. By the time the
  // button exists the live sky has compiled the same shader, so this hits the
  // browser's shader cache and links in milliseconds
  const renderer = new AtmosphereRenderer(tmp, { compile: 'sync' });
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
