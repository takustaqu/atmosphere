// gallery.ts — the nine weather presets, side by side
//
// Nine live canvases would mean nine WebGL contexts on top of the hero's.
// Browsers cap how many can exist at once (and evict the oldest, which would
// kill the hero), so instead one renderer draws all nine in turn, each frame
// is copied into a plain 2D canvas, and the context is released. The tiles
// are still frames — the moving sky is the hero's job — and the page holds a
// single context no matter how far you scroll.

import {
  AtmosphereRenderer, resolveConditions, weatherLabel,
  type Locale, type WeatherId,
} from '../src/index.js';

/** Each preset shown at the hour it reads best */
const TILES: readonly { id: WeatherId; time: number }[] = [
  { id: 'clear', time: 10 },
  { id: 'fair', time: 14 },
  { id: 'summer', time: 13 },
  { id: 'overcast', time: 12 },
  { id: 'fog', time: 9 },
  { id: 'rain', time: 15 },
  { id: 'thunderstorm', time: 17 },
  { id: 'snow', time: 14 },
  { id: 'typhoon', time: 12 },
];

const captions: { el: HTMLElement; id: WeatherId }[] = [];

/** Re-label the tiles when the page language changes */
export function relabelGallery(lang: Locale): void {
  for (const c of captions) c.el.textContent = weatherLabel(c.id, lang);
}

/**
 * Fill `#gallery`. Returns without touching the DOM if WebGL is unavailable,
 * so the section simply stays empty rather than showing nine black rectangles.
 */
export function buildGallery(lang: Locale): void {
  const host = document.querySelector<HTMLElement>('#gallery');
  if (!host) return;

  const source = document.createElement('canvas');
  const renderer = new AtmosphereRenderer(source);
  if (!renderer.available) {
    renderer.dispose({ loseContext: true });
    host.closest('section')?.remove();
    return;
  }

  // tiles are ~270px wide; draw at 2x for retina and let CSS scale down
  const w = 540, h = 338;
  renderer.resize(w, h);

  try {
    TILES.forEach((tile, i) => {
      // vary the evolution offset per tile so the nine skies aren't nine
      // shots of one cloud field — the same weather, different afternoons
      renderer.render(0, resolveConditions({ time: tile.time, weather: tile.id }),
        undefined, 41.7 + i * 5.7, 7.3 + i * 3.1);

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      // copy synchronously: the drawing buffer is cleared once we yield
      canvas.getContext('2d')?.drawImage(source, 0, 0);

      const caption = document.createElement('figcaption');
      caption.textContent = weatherLabel(tile.id, lang);
      captions.push({ el: caption, id: tile.id });

      const figure = document.createElement('figure');
      figure.append(canvas, caption);
      host.append(figure);
    });
  } finally {
    // hand the context straight back — see the note at the top
    renderer.dispose({ loseContext: true });
  }
}
