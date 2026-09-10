# Changelog

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
