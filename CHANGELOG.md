# Changelog

## Unreleased

### Added

- **`noiseLod`: filter the grain that crawls along the horizon.** Opt-in, and
  off is the picture as it was, pixel for pixel (the tests hold the
  preprocessed shader to the previous release's text; a readback diff on an
  M2 Max is zero in every scene measured). On, cumulus, fractus and pannus read
  their noise through the lattice texture's mipmaps at the level each octave's
  footprint calls for, and widen their density ramps by the variance averaged
  away. Only the band below about 15° changes; against a 4×-supersampled
  reference, error drops 3–9% below 10° and frame-to-frame flicker 11–26%
  below 8°. It costs about 6% of the frame on an M2 Max (ANGLE / Metal) —
  cloudless skies included — so it is for the picture, not for speed.
  `noiseLodBias` changes the filter width at run time, and `renderCubeFaces`
  takes the same option. See "Horizon noise LOD".

### Changed

- The cumulonimbus's tropopause height (`anvilTop`) is computed only in the
  azimuths that carry a tower, and the veil's height only where the mass
  stands above 0.50 — the only places either is read. The picture is
  unchanged (readback diff zero).

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
