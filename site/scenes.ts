// scenes.ts — the hero's rotation
//
// Each line of copy is a memory of a sky, so each one names the sky it
// belongs to. The page doesn't cut between them: `Atmosphere.set()` eases
// from one to the next over a few seconds, which is the thing this library
// is actually for — a sky that keeps changing rather than a picture of one.
//
// Times are given without a location, so the nominal sun applies: it rises
// at 6:00, souths at 12:00 and sets at 18:00. That keeps each number
// readable as "roughly this hour of the day".

import type { Conditions } from '../src/index.js';

export interface Scene {
  ja: string;
  en: string;
  conditions: Conditions;
}

export const SCENES: readonly Scene[] = [
  {
    ja: '大きな音と光に怯えたあの時',
    en: 'When the noise and the light frightened you',
    // late afternoon, the storm already overhead
    conditions: { time: 17.2, weather: 'thunderstorm' },
  },
  {
    ja: '空の手を伸ばして、受け止めようとした時',
    en: 'When you reached out an empty hand to catch it',
    // flat grey afternoon, snow whiting out the distance
    conditions: { time: 15, weather: 'snow' },
  },
  {
    ja: 'セミの鳴き声を聴いたあの時',
    en: 'When the cicadas were singing',
    // High summer, early afternoon. The 'summer' preset puts cumulus at its
    // ceiling and leaves almost no blue, so cover is dialled back and the
    // convection kept high — scattered cotton clouds with a thunderhead
    // standing off in the distance is the sky this line is about
    conditions: {
      time: 13,
      weather: { cloudCover: 0.18, convection: 0.85, windSpeed: 3, visibility: 30 },
    },
  },
  {
    ja: 'ほんの一瞬、世界が輝く時',
    en: 'When the world shines, just for a moment',
    // magic hour: the sun a few degrees up, everything amber
    conditions: { time: 17.8, weather: 'fair' },
  },
  {
    ja: '世界が灰色に染まる時',
    en: 'When the world turns grey',
    conditions: { time: 12, weather: 'overcast' },
  },
  {
    ja: '雲の形の移り変わりに時を感じた時',
    en: 'When you felt time pass in the shifting of the clouds',
    // mid-morning cumulus — the shapes visibly crumble and reassemble
    conditions: { time: 10, weather: { cloudCover: 0.42, windSpeed: 4, visibility: 40 } },
  },
  {
    ja: '夜の空に、小さな輝きが広がる事を知った時',
    en: 'When you first saw the small lights spread across the night',
    conditions: { time: 22.5, weather: 'clear' },
  },
];

/**
 * Order the scenes so the same one never comes round twice in a row, and so
 * a visitor who stays a while doesn't see the same sequence repeat.
 * Fisher–Yates per cycle, re-shuffled when the deck runs out.
 */
export function sceneCycle(): () => Scene {
  let deck: Scene[] = [];
  let last: Scene | null = null;
  return () => {
    if (deck.length === 0) {
      deck = [...SCENES];
      for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      // a reshuffle can put the just-shown scene at the front again
      if (deck[0] === last && deck.length > 1) [deck[0], deck[1]] = [deck[1], deck[0]];
    }
    last = deck.shift()!;
    return last;
  };
}
