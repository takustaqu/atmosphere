// main.ts — the landing page
//
// The hero is one Atmosphere instance. Each line of copy names a sky (see
// scenes.ts), and changing the line is just a `set()` — the transition you
// see is the library's own, not a crossfade between two images.

import { Atmosphere, DEFAULT_CAMERA, resolveConditions, type Conditions } from '../src/index.js';
import { buildGallery, relabelGallery } from './gallery.js';
import { SCENES, type Scene } from './scenes.js';

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
  labelIndex();
}

for (const b of document.querySelectorAll<HTMLButtonElement>('#lang button')) {
  b.addEventListener('click', () => setLang(b.dataset.setLang === 'en' ? 'en' : 'ja'));
}

// ── the sky ───────────────────────────────────────────────

let current: Scene | null = null;
// where in SCENES the rotation is; it starts somewhere different each visit
// and then goes round in order, which is what lets the index below mean anything
let at = Math.floor(Math.random() * SCENES.length);

const sky = new Atmosphere(canvas, {
  ...SCENES[at].conditions,
  // the hero fills the viewport, and fbm is the expensive part — render a
  // little smaller than the default and let CSS scale it up. The sky is soft
  // enough that the resample doesn't show
  resolutionScale: Math.min(devicePixelRatio || 1, 1.5) * 0.46,
  // and on a GPU that cannot hold that at 30 fps — a thunderhead's frame is
  // three to four times a clear sky's — lower it rather than drop frames
  // (where the GPU can say how long a frame takes: Chrome and Edge on the
  // desktop). Under its budget, which an M2 Max's hero frames are by four
  // times, nothing changes
  adaptiveResolution: true,
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
const HOLD_MS = 12000;
let timer = 0;

// set() merges into what is there, so what one scene brings in — a place
// and a date, the sea, a night sky — is cleared before the next, unless that
// one brings its own
const BLANK: Conditions = { location: undefined, ground: undefined, celestial: undefined };

/** move to scene i: the sky eases there, the camera turns to it, the line follows */
function goTo(i: number): void {
  stopRotation();
  at = (i + SCENES.length) % SCENES.length;
  const scene = SCENES[at];
  sky.set({ ...BLANK, ...scene.conditions });
  aimAt(scene);
  markIndex();
  lineEl.classList.remove('on');
  timer = window.setTimeout(() => {
    show(scene);
    timer = window.setTimeout(step, HOLD_MS);
  }, FADE_MS);
}

function step(): void {
  goTo(at + 1);
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
  const scene = SCENES[at];
  sky.jump(scene.conditions);
  aimAt(scene, true);
  markIndex();
  show(scene);
  timer = window.setTimeout(step, HOLD_MS);
}

// ── the index ─────────────────────────────────────────────
// One numbered button per scene: which one is showing, and a way to go to
// any of them. The one showing carries a bar that fills over its hold, so
// the rotation's pace can be read too.

const indexEl = document.querySelector<HTMLElement>('#scenes')!;
const indexButtons = SCENES.map((_, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = String(i + 1).padStart(2, '0');
  b.addEventListener('click', () => {
    hint?.classList.add('gone');
    goTo(i);
  });
  indexEl.append(b);
  return b;
});

function labelIndex(): void {
  const lang = getLang();
  indexButtons.forEach((b, i) => {
    b.setAttribute('aria-label', SCENES[i][lang]);
    b.title = SCENES[i][lang];
  });
}

function markIndex(): void {
  indexButtons.forEach((b, i) => {
    const on = i === at;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  });
  // restart the hold bar: drop the class, settle, put it back
  indexEl.style.setProperty('--hold', `${FADE_MS + HOLD_MS}ms`);
  indexEl.classList.remove('run');
  void indexEl.offsetWidth;
  if (timer || !drag) indexEl.classList.add('run');
}

labelIndex();

// ── the camera's own motion ───────────────────────────────
// Left alone, the view turns slowly along the horizon; at each new scene it
// turns to whatever lights that scene — the sun, or the moon when the sun is
// down — and frames it a little off centre, where the copy is not. Both are
// a target the camera eases after on a critically damped spring, so a turn
// starts gently and settles without overshoot; the drift moves the target,
// not the camera, so it never jerks against a turn still in progress.

const hint = document.querySelector<HTMLElement>('#hint');
const aim = { yaw: DEFAULT_CAMERA.yaw, pitch: DEFAULT_CAMERA.pitch };
const vel = { yaw: 0, pitch: 0 };
// rad/s; its sign is set per scene so the subject drifts toward the centre
let drift = 0.016;
const IDLE_AFTER_MS = 3500;
let idleFrom = 0;
// ω of the spring: about three seconds to settle a turn
const OMEGA = 1.5;
const calm = matchMedia('(prefers-reduced-motion: reduce)');

const wrapPi = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));

/** the half-width of the view in radians, for framing at this aspect */
function halfWidth(): number {
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  return Math.atan(Math.tan(DEFAULT_CAMERA.fov / 2) * aspect);
}

let side = 1;
function aimAt(scene: Scene, cut = false): void {
  const s = resolveConditions(scene.conditions);
  // the sun while it is up or its glow is still on the sky; else the moon, if up
  const lit = s.sunElevation > -0.06 ? { az: s.sunAzimuth, el: s.sunElevation }
    : s.moonElevation > 0.04 ? { az: s.moonAzimuth, el: s.moonElevation }
    : null;
  let yawTo: number, pitchTo: number;
  if (lit) {
    // off to one side, alternately, so the light is not behind the copy
    side = -side;
    yawTo = lit.az + side * halfWidth() * 0.55;
    // high up, look up with it but keep it in frame; low, keep it and the
    // horizon in without the ground filling the bottom third
    pitchTo = Math.min(0.9, Math.max(0.24, lit.el * 0.72));
    // a camera turned past the light (yaw beyond its azimuth) has it to the
    // left, and turning back brings it across: drift back toward it
    drift = -Math.abs(drift) * side;
  } else {
    // a moonless night: the default framing, toward the Milky Way's south
    yawTo = DEFAULT_CAMERA.yaw;
    pitchTo = DEFAULT_CAMERA.pitch;
  }
  // the nearer way round
  aim.yaw = yaw + wrapPi(yawTo - yaw);
  aim.pitch = pitchTo;
  idleFrom = performance.now() + 2500;
  if (cut || calm.matches) {
    yaw = aim.yaw; pitch = aim.pitch; vel.yaw = 0; vel.pitch = 0;
    sky.set({ camera: { yaw, pitch } });
  }
}

let raf = 0;
let last = 0;
function frame(now: number): void {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
  last = now;
  if (drag || dt <= 0) return;
  if (!calm.matches && now > idleFrom) aim.yaw += drift * dt;
  // critically damped: x'' = ω²(target − x) − 2ω x'
  const k = OMEGA * OMEGA, c = 2 * OMEGA;
  vel.yaw += (k * (aim.yaw - yaw) - c * vel.yaw) * dt;
  vel.pitch += (k * (aim.pitch - pitch) - c * vel.pitch) * dt;
  const dy = vel.yaw * dt, dp = vel.pitch * dt;
  if (Math.abs(dy) + Math.abs(dp) < 1e-6) return;
  yaw += dy; pitch += dp;
  sky.set({ camera: { yaw, pitch } });
}

function startCamera(): void {
  if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
}
function stopCamera(): void {
  cancelAnimationFrame(raf);
  raf = 0;
}

// ── looking around ────────────────────────────────────────
// Everything is drawn along view rays, so the hero is a skybox rather than a
// backdrop: swinging the camera shows what is actually in that direction —
// the sun stays where the sun is, the clouds keep their places.

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
  indexEl.classList.remove('run');
  // nor turn the camera while they hold it
  aim.yaw = yaw; aim.pitch = pitch; vel.yaw = 0; vel.pitch = 0;
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
    // the sky is grabbed, as it is sideways and in the controller: drag down
    // and it comes down with the cursor, so the view tilts up. Stop short of
    // straight up and of burying the view in the ground
    pitch = Math.max(-0.30, Math.min(1.30, pitch + dy * fov / canvas.clientHeight));
  }
  aim.yaw = yaw; aim.pitch = pitch;
  sky.set({ camera: { yaw, pitch } });
});

for (const type of ['pointerup', 'pointercancel'] as const) {
  canvas.addEventListener(type, (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    canvas.classList.remove('dragging');
    // the drift picks up again only after the view has been left alone a while
    idleFrom = performance.now() + IDLE_AFTER_MS;
    // pick the rotation back up, but give the view a moment to be looked at
    if (!timer && visible) {
      timer = window.setTimeout(step, HOLD_MS);
      markIndex();
    }
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
      startCamera();
      if (!timer) { timer = window.setTimeout(step, HOLD_MS); markIndex(); }
    } else {
      sky.stop();
      stopCamera();
      stopRotation();
    }
  }
}, { threshold: 0.05 }).observe(hero);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { sky.stop(); stopCamera(); stopRotation(); }
  else if (visible) {
    sky.start();
    startCamera();
    if (!timer) { timer = window.setTimeout(step, HOLD_MS); markIndex(); }
  }
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

begin();
startCamera();

// The preset tiles borrow a second WebGL context for as long as it takes to
// draw nine frames. Do it after the hero has its own, so if a browser is at
// its context limit the one that matters is the one that survives.
buildGallery(getLang());

// expose for headless checks (the Browser pane never fires rAF)
(globalThis as unknown as { __sky: Atmosphere }).__sky = sky;
