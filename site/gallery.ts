// gallery.ts — the weather presets and the night skies, side by side
//
// Twelve live canvases would mean twelve WebGL contexts on top of the hero's.
// Browsers cap how many can exist at once (and evict the oldest, which would
// kill the hero), so instead one renderer draws them all in turn, each frame
// is copied into a plain 2D canvas, and the context is released. The tiles
// are still frames — the moving sky is the hero's job — and the page holds a
// single context no matter how far you scroll.

import {
  AtmosphereRenderer, resolveConditions, weatherLabel,
  type Conditions, type Locale, type WeatherId,
} from '../src/index.js';

interface Tile {
  conditions: Conditions;
  /** preset tiles take their caption from weatherLabel; night tiles bring their own */
  label: WeatherId | { ja: string; en: string };
}

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
    conditions: { time: 22.5, weather: 'clear', celestial: { bortle: 1, milkyWay: 1 } },
    label: { ja: '星空', en: 'Dark sky' },
  },
  {
    // 1am puts the full-moon position inside the default framing
    conditions: { time: 1, weather: 'clear', celestial: { bortle: 3 } },
    label: { ja: '月夜', en: 'Moonlit' },
  },
  {
    conditions: { time: 22.5, weather: 'clear', celestial: 'city' },
    label: { ja: '街明かり', en: 'City lights' },
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
 * shader never compiles, so it stays absent rather than showing twelve black
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
    onReady: (ok) => {
      if (!ok || !renderer) {
        renderer?.dispose({ loseContext: true });
        host.closest('section')?.remove();
        return;
      }
      renderer.resize(w, h);
      try {
        TILES.forEach((tile, i) => {
          // vary the evolution offset per tile so the skies aren't twelve
          // shots of one cloud field — the same weather, different afternoons
          renderer!.render(0, resolveConditions(tile.conditions),
            undefined, 41.7 + i * 5.7, 7.3 + i * 3.1);
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
