// playground — a contact sheet for lining conditions up side by side
//
//   pnpm playground   → http://localhost:8791/examples/playground/
//
// Switch which axis is laid out with ?sheet=time | weather | filter | location | camera.
// This is a Japanese-language internal QA tool (captions reference real
// weather photos and Japanese cloud vocabulary for benchmarking), so its
// data captions are intentionally left in Japanese even though the rest of
// the codebase is in English.

import {
  Atmosphere, WEATHER_IDS, WEATHER_PRESETS, FILTER_IDS, FILTER_PRESETS,
  CLOUD_GENERA, CLOUD_GENERA_IDS, CUBE_FACE_CAMERAS, formatTod,
  type AtmosphereOptions, type Conditions,
} from '../../src';

interface Tile {
  caption: string;
  conditions: Conditions;
  /** tuning for following / shape evolution */
  animator?: AtmosphereOptions['animator'];
  /** if given, calls this every frame instead of a still image */
  animate?: (sky: Atmosphere, seconds: number) => string | void;
}

const TOKYO = { latitude: 35.68, longitude: 139.77 };

/** for real-photo benchmarks. A framing that looks up at the sky (43° elevation, 66° fov) */
const PHOTO_CAMERA = { pitch: 0.75, fov: 1.15 };

const SHEETS: Record<string, () => Tile[]> = {
  // continuous change over time of day
  time: () => [4.5, 6, 7.5, 12, 16.5, 18, 19.5, 22].map((t) => ({
    caption: formatTod(t),
    conditions: { time: t, weather: 'summer' },
  })),

  // weather presets
  weather: () => WEATHER_IDS.map((id) => ({
    caption: `${WEATHER_PRESETS[id].label} (${id})`,
    conditions: { time: 14, weather: id },
  })),

  // real-photo benchmark. The reference photos look up at the sky, so match the camera to that
  // (the default framing sits near the horizon; using it as-is crushes the foreground and breaks the comparison)
  nimbostratus: () => [
    { c: { nimbostratus: 0.95 }, t: 13, cap: 'Ns 0.95 / 13時' },
    { c: { nimbostratus: 0.95 }, t: 10, cap: 'Ns 0.95 / 10時' },
    { c: { nimbostratus: 0.75, stratus: 0.3 }, t: 13, cap: 'Ns 0.75 + St 0.3' },
    { c: { nimbostratus: 1.0, altostratus: 0.5 }, t: 13, cap: 'Ns 1.0 + As 0.5' },
    { c: { nimbostratus: 0.95 }, t: 17, cap: 'Ns 0.95 / 17時' },
    { c: { nimbostratus: 0.6 }, t: 13, cap: 'Ns 0.6' },
  ].map((x) => ({
    caption: x.cap,
    conditions: {
      time: x.t,
      weather: { clouds: x.c, precipitation: 6, windSpeed: 8, visibility: 14 },
      camera: PHOTO_CAMERA,
    } as Conditions,
  })),

  // altostratus benchmark. Watch the sun show through as if through frosted glass
  altostratus: () => [
    { c: { altostratus: 0.9 }, t: 12, cap: 'As 0.9 / 12時' },
    { c: { altostratus: 0.9 }, t: 15, cap: 'As 0.9 / 15時' },
    { c: { altostratus: 0.7, altocumulus: 0.35 }, t: 12, cap: 'As 0.7 + Ac 0.35' },
    { c: { altostratus: 1.0 }, t: 12, cap: 'As 1.0' },
    { c: { altostratus: 0.9, cirrostratus: 0.4 }, t: 12, cap: 'As 0.9 + Cs 0.4' },
    { c: { altostratus: 0.9 }, t: 17.5, cap: 'As 0.9 / 17:30' },
  ].map((x) => ({
    caption: x.cap,
    conditions: {
      time: x.t,
      weather: { clouds: x.c, windSpeed: 5, visibility: 22 },
      camera: PHOTO_CAMERA,
    } as Conditions,
  })),

  // a rapidly developing cumulonimbus, cycling through growth, maturity and collapse.
  // development speed is set by StateAnimator's evo speed (not shader-internal time)
  grow: () => [
    { cap: '発達 → かなとこ → 崩壊', yaw: 1.1 },
    { cap: '同じ現象を別の方位から', yaw: 2.2 },
  ].map((x) => {
    const base = { windSpeed: 5, visibility: 35 };
    return {
      caption: x.cap,
      conditions: {
        time: 14,
        weather: { clouds: { cumulonimbus: 0.05, cumulus: 0.25 }, ...base },
        camera: { yaw: x.yaw, pitch: 0.52, fov: 1.05 },
      } as Conditions,
      // tighten tau to follow the target quickly, and speed up shape evolution itself too
      animator: { tau: 0.9, evoBase: 0.50, evoGust: 0.15, windBase: 0.02 },
      animate: (sky: Atmosphere, t: number) => {
        // one cycle every 40 seconds. Cumulonimbus rises fast and collapses slowly
        const c = (t % 40) / 40;
        const cb = c < 0.42
          ? Math.pow(c / 0.42, 0.7)
          : Math.pow(1 - (c - 0.42) / 0.58, 1.7);
        sky.set({ weather: { clouds: { cumulonimbus: cb, cumulus: 0.25 }, ...base } });
        const f = sky.state.features;
        return `${x.cap} — Cb ${cb.toFixed(2)}`
          + ` / velum ${f.velum.toFixed(2)} / anvil ${f.anvil.toFixed(2)}`;
      },
    };
  }),

  // the ten cloud genera one at a time, checking each shows up on its own
  genus: () => CLOUD_GENERA_IDS.map((id) => {
    const g = CLOUD_GENERA[id];
    return {
      caption: `${g.label}${g.alias ? ` (${g.alias})` : ''} ${g.abbr}`,
      conditions: {
        time: 14,
        weather: { clouds: { [id]: 0.85 }, windSpeed: 4, visibility: 30 },
        // cumulonimbus only "stands here and there", so it may not show up at the default bearing
        camera: id === 'cumulonimbus' ? { yaw: 1.1 } : undefined,
      } as Conditions,
    };
  }),

  // the low end of cloud cover: does cloudCover 0 really give a cloudless sky?
  sparse: () => [0, 0.03, 0.08, 0.15, 0.25, 0.4].map((c) => ({
    caption: `cloudCover ${c}`,
    conditions: { time: 14, weather: { cloudCover: c, windSpeed: 3, visibility: 35 } } as Conditions,
  })),

  // cumulonimbus benchmark, in a "one tower against blue sky" condition close to real photos.
  // sweeps a full loop of bearings to see how often a tower actually stands.
  // reference photos are telephoto with the cloud filling the frame, so tiles with a tighter fov are included for comparison
  cumulonimbus: () => [
    { cb: 0.9, y: 0.0, cap: '北 / 広角', cam: { pitch: 0.42, fov: 1.0 } },
    { cb: 0.9, y: 1.1, cap: '東北東 / 広角', cam: { pitch: 0.42, fov: 1.0 } },
    { cb: 0.9, y: 2.2, cap: '南東 / 広角', cam: { pitch: 0.42, fov: 1.0 } },
    { cb: 0.9, y: 1.1, cap: '望遠 / 東北東', cam: { pitch: 0.34, fov: 0.52 } },
    { cb: 0.9, y: 2.2, cap: '望遠 / 南東', cam: { pitch: 0.30, fov: 0.52 } },
    { cb: 0.9, y: 0.0, cap: '望遠 / 北', cam: { pitch: 0.32, fov: 0.52 } },
    { cb: 0.55, y: 2.2, cap: 'Cb 0.55（未発達）', cam: { pitch: 0.42, fov: 1.0 } },
    { cb: 1.0, y: 2.2, cap: 'Cb 1.0（かなとこ）', cam: { pitch: 0.42, fov: 1.0 } },
  ].map((x) => ({
    caption: x.cap,
    conditions: {
      time: 14,
      weather: { clouds: { cumulonimbus: x.cb, cumulus: 0.25 }, windSpeed: 4, visibility: 35 },
      camera: { yaw: x.y, ...x.cam },
    } as Conditions,
  })),

  // cumulonimbus companion forms. Compare anvil (ice crystal, silky streaks,
  // spreads downwind) against veil (water droplet, no fiber, drapes over the tower's flank)
  features: () => [
    { f: { anvil: 0, velum: 0 }, cb: 0.9, cap: '派生形なし' },
    { f: { anvil: 0, velum: 0.9 }, cb: 0.55, cap: 'ベール雲のみ / Cb 0.55' },
    { f: { anvil: 0, velum: 0.9 }, cb: 0.9, cap: 'ベール雲のみ / Cb 0.9' },
    { f: { anvil: 1, velum: 0 }, cb: 0.9, cap: 'かなとこ雲のみ' },
    { f: { anvil: 1, velum: 0.5 }, cb: 1.0, cap: 'かなとこ + ベール' },
    { f: undefined, cb: 0.9, cap: '自動（発達度から導出）' },
  ].map((x) => ({
    caption: x.cap,
    conditions: {
      time: 14,
      weather: {
        clouds: { cumulonimbus: x.cb, cumulus: 0.2 },
        features: x.f, windSpeed: 4, visibility: 35,
      },
      // anvils sit up at the tropopause, so a slight upward tilt is needed to keep them in frame
      camera: { yaw: 2.2, pitch: 0.58, fov: 1.05 },
    } as Conditions,
  })),

  // cumulonimbus development (towers stand on noise that connects around the azimuth loop)
  tower: () => [0, 0.35, 0.7, 1].flatMap((c) =>
    [Math.PI, Math.PI + 1.2].map((yaw) => ({
      caption: `convection ${c} / yaw ${yaw.toFixed(1)}`,
      conditions: {
        time: 15,
        weather: { cloudCover: 0.15, convection: c, windSpeed: 3, visibility: 30 },
        camera: { yaw },
      } as Conditions,
    }))),

  // the photo benchmark: the sixteen kinds of sky in pakutaso's 空・雲 category
  // (https://www.pakutaso.com/weather/sky/), each with the numbers of the
  // photos it stands for in that listing. The target is the photograph, not
  // the previous render: when a tile and its photos disagree, the tile is
  // what moves. Terrain, buildings and anything seen from above the clouds
  // are out of scope and left out
  pakutaso: () => {
    const S = Math.PI, E = Math.PI / 2, W = 3 * Math.PI / 2;
    const t = (cap: string, c: Conditions): Tile => ({ caption: cap, conditions: c });
    return [
      t('A1 夏空に浮かぶ白い雲・快晴 #1,7,8,21,24,26',
        { time: 13, weather: { cloudCover: 0.15, windSpeed: 2, visibility: 45 }, camera: { yaw: S, pitch: 0.65, fov: 1.0 } }),
      t('A2 真夏の積乱雲・入道雲 #4,6,15,25,37,40',
        { time: 14, weather: { clouds: { cumulonimbus: 0.95, cumulus: 0.35 }, windSpeed: 3, visibility: 35 }, camera: { yaw: 1.1, pitch: 0.42, fov: 1.0 } }),
      t('A3 見上げた積雲のグラデーション #5,10,12,31',
        { time: 14, weather: { cloudCover: 0.4, windSpeed: 3, visibility: 40 }, camera: { yaw: S, pitch: 0.95, fov: 1.15 } }),
      t('A4 薄雲に隠された太陽と筋状の雲 #11',
        { time: 15.5, weather: { clouds: { cirrostratus: 0.85, cirrus: 0.6 }, windSpeed: 4, visibility: 30 }, camera: { yaw: W - 0.5, pitch: 0.55, fov: 1.0 } }),
      t('A5 光芒と青空 #14,32 (needs ?cloudScale=1&rays=1)',
        { time: 16, weather: { cloudCover: 0.55, windSpeed: 3, visibility: 30 }, camera: { yaw: W - 0.5, pitch: 0.5, fov: 1.1 } }),
      t('A6 うろこ雲・ひつじ雲 #22,30,35',
        { time: 14, weather: { clouds: { cirrocumulus: 0.8, altocumulus: 0.25 }, windSpeed: 3, visibility: 40 }, camera: { yaw: S, pitch: 0.75, fov: 1.1 } }),
      t('A7 飛行機雲 #17,33,38',
        { time: 14, weather: { cloudCover: 0.08, visibility: 45 }, particles: { contrails: 1 }, camera: { yaw: S, pitch: 1.0, fov: 1.2 } }),
      t('A8 空を覆い隠そうとする雨雲 #41',
        { time: 14, weather: { clouds: { nimbostratus: 0.9, stratus: 0.4, stratocumulus: 0.5 }, precipitation: 1, windSpeed: 6, visibility: 10 }, camera: { yaw: S, pitch: 0.4, fov: 1.1 } }),
      t('B1 パステルの夕焼けと白い雲 #9,13',
        { time: 17.9, weather: { cloudCover: 0.3, windSpeed: 3, visibility: 30 }, camera: { yaw: W, pitch: 0.35, fov: 1.1 } }),
      t('B2 黒い雲から覗く青空と夕焼け #19',
        { time: 18.05, weather: { clouds: { stratocumulus: 0.75, cumulus: 0.3 }, windSpeed: 4, visibility: 25 }, camera: { yaw: W, pitch: 0.3, fov: 1.1 } }),
      t('B3 波模様の雲と夕焼け #20',
        { time: 17.95, weather: { clouds: { altocumulus: 0.85 }, windSpeed: 3, visibility: 30 }, camera: { yaw: W, pitch: 0.45, fov: 1.1 } }),
      t('B4 朝焼けのオレンジの雲 #23',
        { time: 5.9, weather: { cloudCover: 0.45, windSpeed: 3, visibility: 30 }, camera: { yaw: E, pitch: 0.3, fov: 1.1 } }),
      t('B5 夕日と青空の入り混じる空 #27',
        { time: 17.7, weather: { cloudCover: 0.3, windSpeed: 3, visibility: 30 }, camera: { yaw: W + 0.3, pitch: 0.12, fov: 1.1 } }),
      t('B6 ダイナミックな雲と焼ける地平線 #34',
        { time: 18.0, weather: { clouds: { altostratus: 0.45, cumulus: 0.55, cirrus: 0.3 }, windSpeed: 7, visibility: 25 }, camera: { yaw: W, pitch: 0.25, fov: 1.2 } }),
      t('B7 夕暮れと飛行機雲 #33,38',
        { time: 18.0, weather: { cloudCover: 0.1, visibility: 35 }, particles: { contrails: 1 }, camera: { yaw: W, pitch: 0.5, fov: 1.1 } }),
      t('B8 日没後の東の空 #2 の空の部分',
        { time: 18.2, weather: 'clear', ground: 'sea', camera: { yaw: E, pitch: 0.05, fov: 1.1 } }),
    ];
  },

  // color filters
  filter: () => FILTER_IDS.map((id) => ({
    caption: FILTER_PRESETS[id].label,
    conditions: { time: 17.5, weather: 'summer', filter: id },
  })),

  // latitude/longitude: the sun sits somewhere different even at the same instant
  location: () => [
    { name: '稚内 6/21',      loc: { latitude: 45.4, longitude: 141.7 },  iso: '2026-06-21T16:00' },
    { name: '東京 6/21',      loc: TOKYO,                                  iso: '2026-06-21T16:00' },
    { name: '那覇 6/21',      loc: { latitude: 26.2, longitude: 127.7 },  iso: '2026-06-21T16:00' },
    { name: 'シンガポール',   loc: { latitude: 1.35, longitude: 103.8 },  iso: '2026-06-21T16:00' },
    { name: '稚内 12/21',     loc: { latitude: 45.4, longitude: 141.7 },  iso: '2026-12-21T16:00' },
    { name: '東京 12/21',     loc: TOKYO,                                  iso: '2026-12-21T16:00' },
    { name: 'レイキャビク',   loc: { latitude: 64.1, longitude: -21.9 },  iso: '2026-12-21T16:00' },
    { name: 'シドニー 12/21', loc: { latitude: -33.9, longitude: 151.2 }, iso: '2026-12-21T16:00' },
  ].map((c) => ({
    caption: c.name,
    conditions: { time: c.iso, location: c.loc, weather: 'summer' } as Conditions,
  })),

  // the skybox's 6 faces (just point the camera around at fov=90°)
  camera: () => ['+X E', '-X W', '+Y up', '-Y down', '+Z N', '-Z S'].map((name, i) => ({
    caption: name,
    conditions: { time: 16.5, weather: 'summer', camera: CUBE_FACE_CAMERAS[i] },
  })),
};

const params = new URLSearchParams(location.search);
const sheet = params.get('sheet') ?? 'weather';
// ?cloudScale=0.5 and ?rays=1 put every tile on the split variant, for checking it
const cloudScale = params.has('cloudScale') ? Number(params.get('cloudScale')) : undefined;
const rays = params.has('rays') ? Number(params.get('rays')) : undefined;
const tiles = (SHEETS[sheet] ?? SHEETS.weather)();

const root = document.getElementById('sheet')!;
// expose instances for scripted QA (headless viewers report visibility=hidden,
// so rAF never fires there — a script can call resize()+jump() to force a draw)
const skies: Atmosphere[] = [];
(globalThis as any).__skies = skies;
document.getElementById('nav')!.innerHTML = Object.keys(SHEETS)
  .map((k) => `<a href="?sheet=${k}"${k === sheet ? ' class="on"' : ''}>${k}</a>`)
  .join('');

for (const tile of tiles) {
  const fig = document.createElement('figure');
  const canvas = document.createElement('canvas');
  const cap = document.createElement('figcaption');
  cap.textContent = tile.caption;
  fig.append(canvas, cap);
  root.append(fig);

  const sky = new Atmosphere(canvas, {
    ...tile.conditions, fps: tile.animate ? 30 : 24,
    resolutionScale: 0.7, animator: tile.animator,
    cloudScale, rays,
    // a QA sheet has to show the motion it is checking, reduced motion or not
    // (Windows sets prefers-reduced-motion whenever "Animation effects" is off)
    respectReducedMotion: false,
  });
  if (!sky.available) { cap.textContent += ' (no WebGL)'; continue; }
  skies.push(sky);

  const animate = tile.animate;
  if (animate) {
    const t0 = performance.now();
    const step = () => {
      const label = animate(sky, (performance.now() - t0) / 1000);
      if (label) cap.textContent = label;
      requestAnimationFrame(step);
    };
    step();
  } else {
    // a contact sheet is meant to show each condition's "finished form", so jump instead of transitioning
    sky.jump();
  }
}
