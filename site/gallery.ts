// gallery.ts — the weather presets and the night skies, side by side
//
// Eighteen live canvases would mean eighteen WebGL contexts on top of the hero's.
// Browsers cap how many can exist at once (and evict the oldest, which would
// kill the hero), so instead one renderer draws them all in turn, each frame
// is copied into a plain 2D canvas, and the context is released. The tiles
// are still frames — the moving sky is the hero's job — and the page holds a
// single context no matter how far you scroll.

import {
  AtmosphereRenderer, DEFAULT_CAMERA, resolveConditions, weatherLabel,
  type Camera, type Conditions, type Locale, type WeatherId,
} from '../src/index.js';

interface Tile {
  conditions: Conditions;
  /** preset tiles take their caption from weatherLabel; night tiles bring their own */
  label: WeatherId | { ja: string; en: string };
  /** where to look, for a sky whose subject is not to the south */
  camera?: Partial<Camera>;
  /** seconds into the sky's own clock, for something that has to have happened by then */
  t?: number;
}

// azimuths for camera.yaw: north 0, east π/2
const EAST = Math.PI / 2, WEST = Math.PI * 1.5;

// Without a date the moon is a full one, opposite the sun — up all night, and
// in the frame. A night that is about the stars gets a real one with no moon:
// the new moon of 12 August 2026, which is also the Perseids' peak
const NEW_MOON = {
  time: new Date('2026-08-12T22:30:00+09:00'),
  location: { latitude: 35.68, longitude: 139.77 },
};

/** the point opposite the sun, where a rainbow is centred */
const antisolar = (c: Conditions): number => resolveConditions(c).sunAzimuth + Math.PI;
const SHOWER: Conditions = {
  time: 16.6,
  weather: { cloudCover: 0.25, precipitation: 6, visibility: 25 },
};

/** each preset at the hour it reads best */
const preset = (id: WeatherId, time: number): Tile =>
  ({ conditions: { time, weather: id }, label: id });

const TILES: readonly Tile[] = [
  preset('clear', 10),
  preset('fair', 14),
  preset('summer', 13),
  preset('overcast', 12),
  preset('fog', 9),
  preset('rain', 15),
  preset('thunderstorm', 17),
  preset('snow', 14),
  preset('typhoon', 12),
  // the celestial axis, shown across its range: the darkest sky there is,
  // a moonlit one, and the city sky most visitors actually live under
  {
    conditions: { ...NEW_MOON, weather: 'clear', celestial: { bortle: 1, milkyWay: 1 } },
    label: { ja: '星空', en: 'Dark sky' },
  },
  {
    // 1am puts the full-moon position inside the default framing
    conditions: { time: 1, weather: 'clear', celestial: { bortle: 3 } },
    label: { ja: '月夜', en: 'Moonlit' },
  },
  {
    conditions: { ...NEW_MOON, weather: 'clear', celestial: 'city' },
    label: { ja: '街明かり', en: 'City lights' },
  },
  // the phenomena: each one framed where it stands in the sky
  {
    // the sun low over the water, its road of light broken by the swell
    conditions: { time: 17.75, weather: 'fair', ground: 'sea' },
    camera: { yaw: WEST - 0.35, pitch: 0.2 },
    label: { ja: '海に沈む夕日', en: 'Sunset at sea' },
  },
  {
    // the dark segment rising in the east with the pink band above it
    conditions: { time: 18.3, weather: 'clear' },
    camera: { yaw: EAST, pitch: 0.16 },
    label: { ja: '地球の影とビーナスの帯', en: "Earth's shadow, Belt of Venus" },
  },
  {
    // a shower with the late sun behind the camera, and a lens wide enough
    // for the whole 42° arch
    conditions: SHOWER,
    camera: { yaw: antisolar(SHOWER), pitch: 0.32, fov: 1.25 },
    label: { ja: '虹', en: 'Rainbow' },
  },
  {
    // a veil of cirrostratus, the sun in the middle of its ring
    conditions: { time: 11, weather: { clouds: { cirrostratus: 0.75, cumulus: 0.08 } } },
    camera: { yaw: Math.PI - 0.25, pitch: 0.75 },
    label: { ja: '日暈', en: 'Halo' },
  },
  {
    conditions: {
      time: 9.5,
      weather: { cloudCover: 0.08, visibility: 40 },
      particles: { contrails: 1 },
    },
    camera: { pitch: 0.7 },
    t: 240,
    label: { ja: '飛行機雲', en: 'Contrails' },
  },
  {
    // the curtains stand to the north
    // opened up a stop, the way it would be photographed
    conditions: {
      ...NEW_MOON, weather: 'clear',
      celestial: { bortle: 2, milkyWay: 0.5, aurora: 1 }, tone: { exposure: 1 },
    },
    camera: { yaw: 0, pitch: 0.3 },
    label: { ja: 'オーロラ', en: 'Aurora' },
  },
];

const captions: { el: HTMLElement; label: Tile['label'] }[] = [];

const captionText = (label: Tile['label'], lang: Locale): string =>
  typeof label === 'string' ? weatherLabel(label, lang) : label[lang];

/** Re-label the tiles when the page language changes */
export function relabelGallery(lang: Locale): void {
  for (const c of captions) c.el.textContent = captionText(c.label, lang);
}

/**
 * Fill `#gallery`. The section removes itself if WebGL is unavailable or the
 * shader never compiles, so it stays absent rather than showing eighteen black
 * rectangles.
 *
 * The shader compiles off the main thread, so this can't draw the moment the
 * renderer exists — the figures go into the DOM up front (holding the layout)
 * and the tiles fill in when the compile lands, usually behind a warm shader
 * cache and imperceptible.
 */
export function buildGallery(lang: Locale): void {
  const host = document.querySelector<HTMLElement>('#gallery');
  if (!host) return;

  // tiles are ~270px wide; draw at 2x for retina and let CSS scale down
  const w = 540, h = 338;

  const outputs = TILES.map((tile) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const caption = document.createElement('figcaption');
    caption.textContent = captionText(tile.label, lang);
    captions.push({ el: caption, label: tile.label });

    const figure = document.createElement('figure');
    figure.append(canvas, caption);
    host.append(figure);
    return canvas;
  });

  const source = document.createElement('canvas');
  // null rather than declared-later: a compile failure calls back
  // synchronously, before the assignment below has happened
  let renderer: AtmosphereRenderer | null = null;
  renderer = new AtmosphereRenderer(source, {
    // one program with every feature: the tiles are each drawn once, so a
    // variant per tile would be a dozen compiles for a dozen frames
    variants: false,
    onReady: (ok) => {
      if (!ok || !renderer) {
        renderer?.dispose({ loseContext: true });
        host.closest('section')?.remove();
        return;
      }
      renderer.resize(w, h);
      try {
        TILES.forEach((tile, i) => {
          // vary the evolution offset per tile so the skies aren't eighteen
          // shots of one cloud field — the same weather, different afternoons
          renderer!.render(tile.t ?? 0, resolveConditions(tile.conditions),
            { ...DEFAULT_CAMERA, ...tile.camera }, 41.7 + i * 5.7, 7.3 + i * 3.1);
          // copy synchronously: the drawing buffer is cleared once we yield.
          // Match the renderer's space or the wide-gamut pixels clip here
          outputs[i].getContext('2d', { colorSpace: renderer!.colorSpace })
            ?.drawImage(source, 0, 0);
        });
      } finally {
        // hand the context straight back — see the note at the top
        renderer.dispose({ loseContext: true });
      }
    },
  });
}
