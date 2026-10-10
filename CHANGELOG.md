# Changelog

## Unreleased

### Added

- **The moon moves, and has a phase — and a face.** With a location and a
  date it stands where the lunar ephemeris puts it (the classic
  low-precision series, good to about a degree), and its disc is drawn as a
  sphere lit by the sun from where the sun actually is — so the phase, which
  limb is bright and how the horns tilt all follow from the date, a thin
  crescent through gibbous to full. It is up by day as well, where the lit
  face shows against the blue and the dark face does not. Its light on the
  clouds and the night grows with the phase and goes when it sets. Without a
  date it is a full moon opposite the sun: rising at sunset, high at
  midnight, gone by day — where it used to hang at a fixed 35° all night as
  a crescent. `lunarPosition()` is exported; `light.moon` follows the real
  position and phase.

  The disc's lit side is held just over the tone curve's knee rather than
  blown out — a moon that saturates to paper white loses its seas and reads
  as a disc of paper, which is what it did — and the surface reflects by
  Lommel-Seeliger, flat across a full moon and falling slowly to the
  terminator the way a crescent's does, with the opposition surge near full.
  The maria are where they are on the near side (Imbrium, Serenitatis,
  Tranquillitatis, Procellarum and the rest) with noise-torn edges over a
  grain of highland and a couple of bright ray craters; relief comes out
  toward the terminator. The bloom is a fraction of what it was.
- **Ice halos.** Where there is a cirrostratus, the sun gets the 22° halo it
  always had, now with a sharp red inner edge and a long fade outward, the
  parhelia — sun dogs — level with a low sun, red toward it and trailing a
  white tail away, and a pillar standing on a sun at the horizon. The moon
  gets its halo too. All of it is weighted by the veil's own density along
  the ray, so the ring is patchy and broken where the veil thins rather than
  a drawn circle.
- **Rainbows.** Rain with the sun out: a ring 42° from the point opposite
  the sun, red outside, a fainter second ring with the colors reversed, and
  Alexander's dark band between them. Drawn after the clouds, where the rain
  falls. A downpour under a full deck shows none — the sun has to be out.
- **The bolt.** Every other flash or so, the channel itself shows beneath
  the cloud base: a crooked line down to the horizon with a fork off it,
  flickering through the return strokes for a few frames, then gone. Drawn
  in ray space, so it stands in the sky as the view swings.
- **Fireballs.** One meteor in sixteen is far brighter and wider, burns
  longer, and leaves a train that lingers.
- **Zodiacal light.** At a dark site, once twilight has gone, a faint cone
  leans up from where the sun went down along the ecliptic, and before dawn
  from where it will rise.
- **`particles.contrails`** — jets drawing trails across the high sky: a
  thin sharp line lengthening behind the plane that spreads into a soft band
  and dissolves over the minutes after, uneven where the air was drier. A
  slider in the controller.
- **`rays`** — crepuscular rays: shafts of sunlit air fanning out from the
  sun through the gaps in a cloud deck, read off the split's cloud stack as
  the shadow-volume integral in screen space. Needs `cloudScale` given;
  with them on a cloudy frame always takes the split's two passes. A slider
  in the controller's Performance drawer; `rays` on the React sample.
- **`celestial.aurora`** — curtains of light standing toward the north,
  folding along wandering lines and shimmering in vertical rays, green at
  the foot with red tops and a purple fringe at high activity; they come
  overhead as the amount rises. A curtain is a vertical sheet between two
  altitudes, marched in six steps the way the cloud planes are projected, so
  a ray crosses it along some length of the sheet — edge-on a bright rib,
  face-on a faint veil, which is what the folds are. In front of the stars,
  under the same cloud, and mirrored by the sea. A preset, `aurora`, and a
  slider in the controller's Night sky drawer.
- **`ground: 'sea'`** — open water below the horizon. The sea is drawn as the
  mirror it is: each ray that meets the water is reflected and asked what the
  sky is in that direction, so it takes the color of its hour exactly, and
  the sun and the moon lay a path across it, their image scattered along the
  wind by the slopes of the waves — a swell you set (`swell`) and a chop the
  wind raises. Fresnel decides how much of the mirror is seen against the
  water's own dark green-blue; a polarizer cuts the glare off it, fully at
  Brewster's angle. The sky's gradient, magic hour and anti-twilight moved
  into a function of direction (`skyBase`) so the sea could ask for them; the
  sky above the horizon is bit-identical. The horizon is a hard line, and
  above it the sea costs nothing. Controller example: a Ground drawer.
- The haze now measures its reach from the horizon in both directions: the
  ground and the water close below the eye sit behind as little air as the
  sky high above it, where before the whole lower hemisphere carried the
  horizon's full haze.

- **The Earth's shadow and the Belt of Venus.** Opposite a sun just under
  the horizon, the Earth's own shadow climbs the sky as a band of blue-grey,
  and above it the air still in sunlight sends back reddened light as a soft
  band of rose — the anti-twilight arch. The shadow's edge stands about as
  high as the sun is deep and arches down away from the antisolar point; the
  belt rides a few degrees above it, with a sharp foot and a long head that
  fades up into the blue. In by sundown, gone by civil dusk, and the same
  again before sunrise. The far horizon at magic hour used to be only the
  amber's leftover, a beige where the real sky goes cool.

### Changed

- **The shader is compiled per combination of features in use.** The sea,
  the aurora, the halos, the rainbow, the bolt, the contrails, the rays, the
  dark-sky grids and the polarizer are each a block the shader only runs
  when its state is on — and yet each cost every frame by being compiled in:
  a branch never taken still holds registers, and a bigger program runs
  fewer pixels at once. Measured against 0.3.2 with everything compiled in,
  a clear noon paid 10–30% for features it was not drawing. The renderer
  now compiles a variant per feature set a frame actually needs, on demand,
  draws with the last linked one while the next links (so a feature coming
  on is drawn from the frame its variant lands, a fraction of a second
  later, never a blank), keeps the eight most recently drawn, and `prepare()`
  starts the one a target will need as soon as `set()` is called. The bare
  sky is back to the program it was. `variants: false` compiles everything
  into one program, as before, for comparison; `featureKey()` and `FEATURE`
  are exported. `examples/bench/` measures the two against each other.
- **The polarizer's ring is aimed for you.** It was held at a fixed angle in
  the frame, and in whole ranges of framings — the sun mid-high and off to
  one side, the common case — that put it at 45° to the sky's polarization,
  where a filter passes exactly as much as none: facing east at two in the
  afternoon, `strong` darkened the sky by 3%. It is now turned the way a
  photographer turns it, so that the middle of the frame is darkened most
  whatever the framing and wherever the sun is, and `angle` is a turn from
  there; the same framing now drops by 40%. The haze cut and the saturation
  gain follow what the filter actually took from each pixel, so a ring turned
  to brighten the band no longer thins the haze or saturates. Toward the sun
  and straight away from it the sky is barely polarized, and there no turn of
  the ring does much — on this one or a real one.
- **The cumulonimbus is lit by the same light as every other cloud.** It
  carried a hand-authored palette of its own — its own white, its own shade,
  its own sunset tint and its own overcast pull — and no two of those agreed
  with `cloudColor`'s cool ambient under a warm sun. Side by side with the
  cotton, the tower read as a blue-grey mass at noon and a cream one at magic
  hour, with a base bluer than anything else in the sky. The light every
  layer is lit by now lives in one place (`cloudLight`: ambient, sun, shade,
  moonlight, storm grey and how diffuse the overcast has made it), and the
  tower's three tonal points are derived from it rather than written out.
  Its luminance is unchanged — a sunlit head still sits near 0.92, measured
  on photos, so the lobes stay modelled where a plane layer's face would
  blow out to white — but its *color* is the cotton's at that level, in
  every hour and every weather, by construction. Its base is lit by the
  sky's own light alone, halfway into the shade — no sun and no afterglow
  reach it — and is reached by a replace rather than a cool tint over the
  sunlit face, which cancelled pink against blue into a mud grey at magic
  hour; it is blue-grey by day and lavender under the afterglow now. The
  plane layers are bit-identical: the refactor only moves their arithmetic.
- **The tower melts into the sky toward its base.** Aerial perspective: the
  base of a cumulonimbus stands tens of kilometres off behind that much air,
  which scatters the sky's light into the line of sight, so the base loses
  contrast and takes the horizon's color while the head stays crisp. Drawn
  as a cut in the tower's alpha that grows as 1/sin(elevation), a little
  deeper in haze — against a backdrop that is the sky, letting it through is
  the same as mixing toward it, and the split variant can carry that without
  knowing the sky's color.

## 0.3.2 — 2026-10-01

Steadier animation on large canvases.

At 2160p a frame costs 17–19 ms on an M2 Max — just over a 60 fps deadline, so
some frames make it and some do not, and the motion judders. Over a whole
day's sweep the cost moves only ±10%; it is the margin, not the time of day.

### Added

- **`cloudScale`** — draw the clouds at a fraction of the resolution and lay
  them over a full-resolution sky. The cloud stack's washes compose to one
  affine map, so it is drawn on its own into a half-float target and applied
  in one step. 0.5 takes 0.49–0.62 of the one-pass time, 0.75 takes
  0.81–0.89 (2160p summer: 11.3 → 5.5 ms); cloud edges soften. A frame
  with no clouds is drawn in one pass regardless, where the split would only
  add a pass and a composite (1.25–1.45× a clear frame on a Radeon 8060S).
  Opt-in, and compiled as a separate variant of the shader: carrying the
  split costs the one pass 6–16% by its presence alone, so without the option
  the shader is bit-identical to before, and as fast.
- **`adaptiveResolution`** — hold each frame under a GPU time budget by
  lowering the resolution when a frame would overrun it, and raising it again
  in probing steps. Robust to a GPU that clocks down at light loads, which
  fools a plain per-pixel estimate into collapsing. 2160p summer at 60 fps
  settles at 0.78 and holds; with `cloudScale: 0.5` it stays at full size.
  `sky.resolution` reads the factor.
- `RendererOptions.timing` and `AtmosphereRenderer.takeGpuTimes()` —
  asynchronous GPU timer queries, never a stall — and `ResolutionGovernor`,
  for custom loops.
- Controller example: a Performance panel. React sample: `cloudScale` and
  `adaptiveResolution` props.

## 0.3.1 — 2026-09-27

Faster everywhere, the rain and snow turn with the camera, the lens droplets and the falling rain and snow can be switched off, and the sky hands its light to whatever stands in front of it.

### Changed

- **Every frame is cheaper — 1.4× to 3× — with the picture unchanged.** No
  shape, color or tuned value moved: each saving skips work whose result
  provably could not reach the pixel, and a readback diff against 0.3.0 stays
  within 2/255 (encode round-off and the dither) in every scene measured.
  GPU time per frame at 1600×900 on an Apple M2 Max (ANGLE / Metal):

  | scene | 0.3.0 | now | |
  | --- | --- | --- | --- |
  | clear noon | 1.68 ms | 0.89 ms | 1.9× |
  | fair | 3.59 ms | 2.23 ms | 1.6× |
  | summer (cumulus + a thunderhead) | 6.12 ms | 3.22 ms | 1.9× |
  | overcast | 5.25 ms | 3.10 ms | 1.7× |
  | rain | 3.52 ms | 2.12 ms | 1.7× |
  | thunderstorm | 5.27 ms | 2.63 ms | 2.0× |
  | snow | 4.08 ms | 2.51 ms | 1.6× |
  | dark-sky night | 2.41 ms | 1.78 ms | 1.4× |
  | overcast, looking below the horizon | 5.12 ms | 1.72 ms | 3.0× |

  The same scenes on Windows (Radeon 780M, ANGLE / Direct3D 11), against
  0.3.0 built from `main` in the same page, where the readback diff is
  within 1/255. Linking is unchanged there: 2.6 s uncached, off the main
  thread.

  | scene | 0.3.0 | now | |
  | --- | --- | --- | --- |
  | clear noon | 1.03 ms | 0.60 ms | 1.7× |
  | fair | 2.34 ms | 1.62 ms | 1.4× |
  | summer (cumulus + a thunderhead) | 4.65 ms | 2.77 ms | 1.7× |
  | overcast | 3.73 ms | 2.72 ms | 1.4× |
  | rain | 2.41 ms | 1.57 ms | 1.5× |
  | thunderstorm | 3.96 ms | 2.07 ms | 1.9× |
  | snow | 2.90 ms | 1.93 ms | 1.5× |
  | dark-sky night | 1.48 ms | 1.24 ms | 1.2× |
  | overcast, looking below the horizon | 3.77 ms | 1.09 ms | 3.5× |

  Where it came from:
  - consecutive display-space washes (`overlay()`) share one encode/decode
    instead of paying six `pow()`s each — a clear sky went from sixteen
    encode-or-decode steps per pixel to six
  - the stars, the Milky Way, the moon, meteors and the sun are skipped
    outright when their visibility is zero — all day for the night sky, all
    night for the sun — rather than drawn and multiplied by zero
  - cumulus, its ragged fragments and the pannus skip their detail octaves
    and their lighting resample wherever even the most the detail could add
    would not lift the density to the edge; the granular genera skip theirs
    between the grains
  - the cumulonimbus skips its whole lobe stack on azimuths that carry no
    tower, and its erosion rings on azimuths already below the thrust line
  - the plane cloud layers are skipped below the horizon, where their fade is
    exactly zero — half of every skybox bake

- **Rain and snow turn with the camera.** They were drawn in screen space,
  so dragging the view slid the sky out from under rain and snow that stayed
  pasted on the glass. Both are laid out along the view ray now, like the
  clouds: the rain as columns at fixed azimuths running down in elevation
  (converging on the zenith when looking up, as real rain does), the snow in a
  lattice of view directions that falls in world y. At the default framing the
  density, speed and weight are unchanged — the ink the streaks and flakes put
  down stays within 7% of before across framings and snowfall strengths —
  and the cost is the same for rain and 0.15 ms more for snow at 1600×900 on
  a Radeon 780M. The light probe's cube faces get the same rain and snow as
  the frame, seam-free.

### Added

- **`particles`** — what is drawn falling through the air.
  **`particles: { precipitation }`** is a ceiling on the rain streaks and
  snowflakes: `false` (or `0`) turns them off, a number fades them, and the
  default keeps them on. Only the particles go; the weather stays, so a rain
  cloud is as dark and heavy snow whites out the view just the same. Eases like
  every other axis, and at zero the particle passes are skipped.
  `resolveParticles`, `DEFAULT_PARTICLES`, and the `Particles` /
  `ParticlesInput` types are exported.
- **`lens`** — what happens on the glass rather than in the sky. For now:
  **`lens: { droplets }`**, a ceiling on the raindrops that collect on the lens
  while it rains. `false` (or `0`) turns them off, a number fades them, and
  the default keeps them on exactly as before. Transitions like every other
  axis, so switching them off lets the drops dry away. At zero the droplet pass
  is skipped, not drawn invisibly. `resolveLens`, `DEFAULT_LENS`, and the
  `Lens` / `LensInput` types are exported.
- **`sky.light`** — the sky's light, handed to whatever is drawn in front of it
  (an avatar backlit by the sun, the background wrapping over its edges):
  - `sun` / `moon` / `key` as directional lights — world direction, direction
    in the camera's frame (`view[2] > 0` is backlight), screen position,
    linear color, visibility and intensity. Computed from the state with the
    shader's own formulas, so they are exact, free, and always present.
  - with the new **`lightProbe`** option, `frame` (the frame averaged, and as
    a coarse grid for light wrap) and `environment` (sky, ground, zenith,
    horizon, and six directions as an ambient cube), measured by drawing the
    real shader into a tiny offscreen buffer and reading it back — about 1 ms
    of GPU wait per measurement on an M2 Max, 3–5 ms on a Radeon 780M through
    Direct3D (the round trip to a GPU that went idle after the last frame;
    the draws are under 0.5 ms), taken 10 times a second and smoothed.
  - **`onLight`** fires with each measurement; **`measureLight()`** takes one
    on demand.
  - `AtmosphereRenderer.probe()` for custom loops, and the pieces behind it —
    `celestialLights`, `summarizeProbe`, `mixMeasurement`, `sampleLightGrid`,
    `sampleEnvironment`, `cameraForward` — exported with their types.
- Controller example: a Lens panel, a Falling rain and snow panel, and a **Foreground light** panel that
  lights a figure from `sky.light` alone (`examples/controller/figure.ts`).
  React sample: `AtmosphereCanvas` passes `lens` and `particles` through and takes
  `lightProbe` / `onLight`.

## 0.3.0 — 2026-09-10

Windows stopped freezing.

A first visit on Windows locked the page for **19 seconds** before the sky
appeared. WebGL there runs through ANGLE's Direct3D backend, and its compiler
inlines and unrolls everything it is given: `fbm` expanded to five `vnoise`,
each to four `hash12`, at every one of several dozen call sites. Nothing was
slow at run time — the whole cost was in `linkProgram`. Measured on a Radeon
780M, worst single unresponsive stretch:

| | first visit | longest freeze |
| --- | --- | --- |
| 0.2.0 | 19.5 s | 19.5 s |
| this release | 3.5 s | 0.19 s |

Later visits were already instant and still are — browsers cache compiled
shaders on disk.

### Changed

- **The value-noise lattice is a baked texture now**, read with an explicit
  mip level so the "skip this genus" branches keep skipping. Linking drops
  from 19.5 s to 3.1 s, and drawing gets *faster* too: a full storm at
  1600×900 goes 9.60 → 6.46 ms per frame, a clear sky 2.93 → 2.81 ms.
- **The shader compiles off the main thread** where the browser offers
  `KHR_parallel_shader_compile`, which is what turns the remaining seconds
  from a freeze into a wait. **`render()` draws nothing until it lands** —
  see `ready` and `onReady` below.
- **Cloud shapes have moved.** The baked lattice repeats every 256 units where
  the old hash never did, so the fine octaves — which run past that — draw a
  different, statistically identical field. The coarse structure, the density,
  the lighting and every tuned parameter are untouched: a cumulus sky is the
  same cumulus sky with its details redealt. Measured against 0.2.0, the 8-bit
  texels contribute a mean of under 0.6/255 and the periodicity carries all the
  rest.

### Added

- **`onReady(available)`** on both `Atmosphere` and `AtmosphereRenderer`, and a
  **`ready`** getter — for cross-fading the canvas in, and for telling a device
  that cannot compile the shader at all from one that has not finished yet.
- **`compile: 'sync'`** on `AtmosphereRenderer`, to block until linked.
  `renderCubeFaces` uses it: a bake has no render loop to come back on.

### Fixed

- A renderer built in a hidden tab, or on a canvas nothing paints, now reports
  itself ready — the compile is polled on a timer rather than on
  `requestAnimationFrame`, which stops in both cases.

## 0.2.0 — 2026-07-31

The compositing rework, and the night sky.

### Changed

- **Compositing now happens in linear light.** The palette is decoded once,
  light adds linearly, and a rational-shoulder tone map brings it back to the
  display — which is what lets the sun, moon, stars and lightning carry real
  emission instead of clipping at white. The ~60 hand-tuned palette values
  were re-anchored so the default sky is bit-identical to 0.1.0.
- **The moon is a crescent now**: earthshine on the dark side with the maria
  faintly visible, a warm blown-out crescent with its glow biased to the lit
  side — and the disc occludes the stars and the Milky Way behind it.
- Cumulonimbus no longer runs cream against the other clouds in daylight;
  its lit end sits in the same cool range, while sunset still turns it gold.

### Added

- **`celestial`** — the third axis, alongside weather and filters: light
  pollution on the Bortle scale, the Milky Way drawn as resolved stars with
  its bulge and Great Rift, and meteor showers at a ZHR. Presets from
  `dark-sky` to `city`, plus `perseids` and `geminids` with real radiants.
  The default (`suburban`) is a pixel-exact no-op.
- **`tone`** — exposure, contrast around middle grey, shoulder knee, and
  highlight bleach, with `neutral` / `flat` / `punch` / `filmic` / `blown`
  presets.
- **`polarizer`** — a circular-polarizer emulation: Rayleigh degree of
  polarization across the sky dome, Malus's law through the filter angle,
  clouds left unpolarized. `strength`, `angle`, `saturation`, `stopLoss`.
- **`colorSpace`** option (`'auto' | 'srgb' | 'display-p3'`) — renders into
  Display P3 where the browser supports it; identical output elsewhere.
- Controller example: collapsible sections, and panels for the night sky,
  tone curve and polarizer.
- Site: a night row in the gallery (dark sky / moonlit / city lights), and a
  Bortle 1 Milky Way behind the hero's night line.

## 0.1.0 — 2026-07-29

Initial release: the sky from time and weather in one WebGL1 fragment
shader — the ten cloud genera, precipitation, severe weather, visibility,
lens artifacts, color filters, a solar position from date and location, and
a skybox baker. No dependencies.
