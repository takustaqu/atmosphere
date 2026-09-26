// main.ts — the landing page
//
// The hero is one Atmosphere instance. Each line of copy names a sky (see
// scenes.ts), and changing the line is just a `set()` — the transition you
// see is the library's own, not a crossfade between two images.

import { Atmosphere, DEFAULT_CAMERA } from '../src/index.js';
import { buildGallery, relabelGallery } from './gallery.js';
import { sceneCycle, SCENES, type Scene } from './scenes.js';

type Lang = 'ja' | 'en';

const root = document.documentElement;
const canvas = document.querySelector<HTMLCanvasElement>('#sky')!;
const lineEl = document.querySelector<HTMLParagraphElement>('#line')!;

// ── language ──────────────────────────────────────────────
// Static copy is duplicated in the markup and switched by CSS; only the
// hero line, which is generated, has to be re-rendered by hand.

const getLang = (): Lang => (root.dataset.lang === 'en' ? 'en' : 'ja');

function setLang(lang: Lang): void {
  root.dataset.lang = lang;
  root.lang = lang;
  try { localStorage.setItem('atmo-lang', lang); } catch { /* private mode */ }
  for (const b of document.querySelectorAll<HTMLButtonElement>('#lang button')) {
    b.setAttribute('aria-pressed', String(b.dataset.setLang === lang));
  }
  if (current) show(current);   // re-segment: the two languages break differently
  relabelGallery(lang);
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#lang button')) {
  b.addEventListener('click', () => setLang(b.dataset.setLang === 'en' ? 'en' : 'ja'));
}

// ── the sky ───────────────────────────────────────────────

const nextScene = sceneCycle();
let current: Scene | null = null;

const sky = new Atmosphere(canvas, {
  ...SCENES[0].conditions,
  // the hero fills the viewport, and fbm is the expensive part — render a
  // little smaller than the default and let CSS scale it up. The sky is soft
  // enough that the resample doesn't show
  resolutionScale: Math.min(devicePixelRatio || 1, 1.5) * 0.46,
  // the sky is the content here, not interface motion, so it keeps moving
  // under prefers-reduced-motion (Windows sets that whenever "Animation
  // effects" is off). The page's own UI transitions still honor it in CSS
  respectReducedMotion: false,
});

if (!sky.available) {
  // no WebGL: the CSS fallback gradient shows through instead of a black hole
  document.body.classList.add('no-webgl');
}

// ── setting a line ────────────────────────────────────────
// The copy arrives a word at a time rather than as a block. Japanese writes
// no spaces, so splitting on them would give one enormous "word" — Intl
// .Segmenter knows where the phrase boundaries actually are, in both
// languages. Whitespace is left as bare text: wrapped in an inline-block it
// would stop the line breaking there.

const SEG_STEP_MS = 72;

function segment(text: string, lang: Lang): string[] {
  const S = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (!S) return [...text];   // per character is a decent stand-in
  return [...new S(lang, { granularity: 'word' }).segment(text)].map((s) => s.segment);
}

function show(scene: Scene): void {
  current = scene;
  const lang = getLang();
  let i = 0;
  lineEl.replaceChildren(
    ...segment(scene[lang], lang).map((part) => {
      if (!part.trim()) return document.createTextNode(part);
      const span = document.createElement('span');
      span.className = 'seg';
      span.textContent = part;
      span.style.setProperty('--d', `${i++ * SEG_STEP_MS}ms`);
      return span;
    }),
  );
  // the spans are born without .on, so the browser has a "from" state to
  // animate out of — force the style to settle before flipping it
  void lineEl.offsetWidth;
  lineEl.classList.add('on');
}

// ── the rotation ──────────────────────────────────────────
// The sky starts moving as the old line fades out, so by the time the new
// line has faded in the sky is already most of the way there. Cutting both
// at the same instant reads as a slideshow; this reads as one continuous sky.

// long enough for the outgoing line to be gone (it leaves in 0.5s) before the
// next one starts arriving word by word
const FADE_MS = 640;
const HOLD_MS = 7800;
let timer = 0;

function step(): void {
  const scene = nextScene();
  sky.set(scene.conditions);
  lineEl.classList.remove('on');
  timer = window.setTimeout(() => {
    show(scene);
    timer = window.setTimeout(step, HOLD_MS);
  }, FADE_MS);
}

function stopRotation(): void {
  clearTimeout(timer);
  timer = 0;
}

// The scenes rotate whatever prefers-reduced-motion says, for the same reason
// the sky keeps moving: the rotation is the sky's content. How each line
// arrives is UI, and the CSS calms that down under reduced motion
function begin(): void {
  stopRotation();
  const scene = nextScene();
  sky.jump(scene.conditions);
  show(scene);
  timer = window.setTimeout(step, HOLD_MS);
}

begin();

// ── looking around ────────────────────────────────────────
// Everything is drawn along view rays, so the hero is a skybox rather than a
// backdrop: swinging the camera shows what is actually in that direction —
// the sun stays where the sun is, the clouds keep their places.

const hint = document.querySelector<HTMLElement>('#hint');
let yaw = DEFAULT_CAMERA.yaw;
let pitch = DEFAULT_CAMERA.pitch;
let drag: { id: number; x: number; y: number; touch: boolean } | null = null;

canvas.addEventListener('pointerdown', (e) => {
  drag = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch' };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
  hint?.classList.add('gone');
  // don't yank the sky out from under someone who is exploring it
  stopRotation();
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;

  // one screen width should sweep about one horizontal field of view, so the
  // sky tracks the cursor instead of sliding out from under it
  const fov = DEFAULT_CAMERA.fov;
  yaw -= dx * (fov * (canvas.clientWidth / canvas.clientHeight)) / canvas.clientWidth;
  // touch keeps vertical for page scroll (see #sky's touch-action)
  if (!drag.touch) {
    // stop short of straight up and of burying the view in the ground
    pitch = Math.max(-0.30, Math.min(1.30, pitch - dy * fov / canvas.clientHeight));
  }
  sky.set({ camera: { yaw, pitch } });
});

for (const type of ['pointerup', 'pointercancel'] as const) {
  canvas.addEventListener(type, (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    canvas.classList.remove('dragging');
    // pick the rotation back up, but give the view a moment to be looked at
    if (!timer && visible) timer = window.setTimeout(step, HOLD_MS);
  });
}

// ── don't render what nobody is looking at ────────────────
// A full-screen shader running behind the rest of the page is pure waste,
// and on a laptop it is audible.

const hero = document.querySelector<HTMLElement>('#hero')!;
const bar = document.querySelector<HTMLElement>('#bar')!;
let visible = true;

new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting === visible) continue;
    visible = e.isIntersecting;
    if (visible) {
      sky.start();
      if (!timer) timer = window.setTimeout(step, HOLD_MS);
    } else {
      sky.stop();
      stopRotation();
    }
  }
}, { threshold: 0.05 }).observe(hero);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { sky.stop(); stopRotation(); }
  else if (visible) { sky.start(); if (!timer) timer = window.setTimeout(step, HOLD_MS); }
});

// ── things that depend on how far down the page is ────────
// Driven by scroll rather than another IntersectionObserver: the cue needs a
// position, not a boolean, so the listener exists either way — and one place
// deciding both keeps them from disagreeing mid-scroll.

const cue = document.querySelector<HTMLElement>('#cue');

function onScroll(): void {
  // the bar picks the wordmark up only once the hero's own has gone
  bar.classList.toggle('past-hero', scrollY > hero.offsetHeight - 56);
  // the cue is only honest while there is something below the fold
  if (cue) cue.style.opacity = scrollY > 40 ? '0' : '0.42';
}

addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll);
onScroll();   // reloading part-way down the page must not start out wrong

// The preset tiles borrow a second WebGL context for as long as it takes to
// draw nine frames. Do it after the hero has its own, so if a browser is at
// its context limit the one that matters is the one that survives.
buildGallery(getLang());

// expose for headless checks (the Browser pane never fires rAF)
(globalThis as unknown as { __sky: Atmosphere }).__sky = sky;
