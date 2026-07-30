# Changelog

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
