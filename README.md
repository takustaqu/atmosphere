English | [日本語](README.ja.md)

# Atmosphere - a sky simulator

**Pass in a time and a weather, and it roughly reproduces that sky.**
One WebGL fragment shader, no dependencies, no DOM or framework dependency.
See the samples in `examples/` to see it in action.

```ts
import { Atmosphere } from '@takustaqu/atmosphere';

const sky = new Atmosphere(canvas, {
  time: new Date(),
  location: { latitude: 35.68, longitude: 139.77 },
  weather: { cloudCover: 0.95, precipitation: 12, windSpeed: 18 },
});
```

This keeps drawing Tokyo's sky at that day and hour, with 95% cloud cover,
12mm/h of rain and 18m/s of wind. Calling `sky.set({ ... })` transitions
smoothly to a new weather over a few seconds.

It started as a side feature added while personally porting a certain game.
It isn't a physical weather simulation, so it isn't accurate — but it should
be an easy way to get a sky that keeps changing procedurally.

## What it draws

- **Time of day** — the sky's gradient, the sun (an outline-less blown-out glare),
  sunset/magic-hour mauve, stars, the moon, city lights at night
- **The ten cloud genera** — cirrus, cirrostratus, cirrocumulus, altostratus,
  altocumulus, nimbostratus, stratus, stratocumulus, cumulus, cumulonimbus.
  A perspective projection from the intersection of the view ray and each
  cloud plane gives depth by altitude
- **Cumulonimbus anvils** — a tower that reaches the tropopause spreads out horizontally
- **Cloud lighting** — pseudo shading toward the sun, silver lining,
  blue-grey shadow from continuous thickness, flattening to diffuse light under overcast
- **Cloud shape evolution** — the domain-warp field itself moves, so clouds billow and collapse in place
- **Precipitation** — rain (leaning with the wind), snow (tumbling on the wind), droplets on the lens
- **Severe weather** — lightning, cloud turbulence from high wind
- **Visibility** — haze/mist/fog. Thin haze only crushes the horizon; thick haze covers the whole sky
- **Lens flare** — ghosts along the optical axis, chromatic aberration, anamorphic-style streaks
- **Color filters** — sepia, monochrome, cyanotype, and more

## Setting the weather

Weather is accepted **in observation units, as-is**.
If you want to match a real condition, passing a weather report's numbers straight through can be fun too.

| property | unit | meaning |
|:---|:---|:---|
| `cloudCover` | 0..1 | total cloud cover (divide oktas by 8). 0 gives a clear sky |
| `clouds` | — | amount of each of the ten cloud genera. Overrides `cloudCover` when given |
| `precipitation` | mm/h | precipitation rate |
| `precipitationType` | `'rain'` \| `'snow'` | precipitation type |
| `windSpeed` | m/s | surface wind speed |
| `thunder` | 0..1 | lightning activity |
| `visibility` | km | visibility |
| `convection` | 0..1 | convective development (shorthand for `clouds.cumulonimbus`) |

The named presets are defined with the same observation values, so presets and raw observations are on a continuum.

| id | name | cloud cover | precipitation | wind | visibility | thunder |
|:---|:---|--:|--:|--:|--:|--:|
| `clear` | Clear | 0 | — | 2 | 45 | — |
| `fair` | Fair | 0.22 | — | 3 | 35 | — |
| `summer` | Summer sky | 0.38 | — | 3 | 25 | — |
| `overcast` | Overcast | 0.82 | — | 5 | 15 | — |
| `fog` | Fog | 0.75 | — | 1 | 0.6 | — |
| `rain` | Rain | 0.95 | 8 | 7 | 8 | 0.08 |
| `thunderstorm` | Thunderstorm | 0.97 | 25 | 12 | 5 | 1.0 |
| `snow` | Snow | 0.90 | 3 (snow) | 3 | 4 | — |
| `typhoon` | Typhoon | 1.0 | 40 | 30 | 6 | 0.5 |

```ts
sky.set({ weather: 'typhoon' });                          // preset
sky.set({ weather: { cloudCover: 0.4, windSpeed: 9 } });  // observation
```

## Passing clouds — the ten genera

Cloud cover alone doesn't decide what the clouds look like. At the same 80%
cloud cover, a sky full of altocumulus and a flat sheet of nimbostratus are
completely different. Since a sky can show several genera at once, instead of
picking one "lead" genus, **amounts 0..1 for each genus are layered together**.

```ts
sky.set({ weather: { clouds: { cirrus: 0.5, cumulus: 0.3 } } });  // cotton clouds under cirrus
sky.set({ weather: { clouds: ['altocumulus'] } });                // a sky of nothing but altocumulus
```

| id | name | nickname | altitude | form |
|:---|:---|:---|:---|:---|
| `cirrus` | Cirrus | Mare's tail | high | filament |
| `cirrostratus` | Cirrostratus | Veil cloud | high | stratiform (halos the sun) |
| `cirrocumulus` | Cirrocumulus | Mackerel sky | high | granular (fine) |
| `altostratus` | Altostratus | Grey veil | mid | stratiform |
| `altocumulus` | Altocumulus | Sheep cloud | mid | granular (medium) |
| `nimbostratus` | Nimbostratus | Rain cloud | mid | stratiform (dark grey, rain) |
| `stratus` | Stratus | Fog cloud | low | stratiform (hangs low) |
| `stratocumulus` | Stratocumulus | Roll cloud | low | granular (large, roll-shaped) |
| `cumulus` | Cumulus | Cotton cloud | low | convective |
| `cumulonimbus` | Cumulonimbus | Thunderhead | low | convective (with an anvil) |

When `clouds` isn't given, a plausible genus mix is built from cloud cover,
precipitation, convection, and visibility (`defaultCloudMix`). A weather API
returns cloud cover, not genera, so that pass-through path lands here. It
follows an ordinary sky's makeup: cotton clouds and cirrus when clouds are
sparse, stratocumulus and altostratus as they thicken, nimbostratus once it's raining.

## Time and location

`time` accepts a `0..24` number, a `Date`, `"14:30"`, or an ISO string.

Pass `location` (latitude/longitude) alongside it, and the **real solar
position** (azimuth and elevation) is computed from `time` (as a `Date`)
using NOAA's formula. Latitude changes the peak elevation; season changes day length.

```ts
sky.set({ time: '2026-12-21T16:00Z', location: { latitude: 64.1, longitude: -21.9 } });
// Reykjavik, winter solstice, 16:00 → already night
```

Without `location`, the sun rises in the east at 6:00, souths at 12:00, and
sets in the west at 18:00 — "nowhere in particular, mid-northern latitude" (peak elevation 46°).

### Time zones

There is no time zone parameter, and `location` is not one. Latitude and
longitude place the sun in the sky; they say nothing about which clock your
`time` is on.

A `Date` is an absolute instant, so the solar position derived from it is
correct wherever the code runs. Everything else resolves against the **host's**
local time zone: an ISO string with no offset (`'2026-07-26T14:30'`) is read as
the host's local time, not the site's, and the time of day is taken from the
host's clock.

So to render 14:30 *in Tokyo* from a machine in London, state the offset:

```ts
sky.set({ time: '2026-07-26T14:30+09:00', location: { latitude: 35.68, longitude: 139.77 } });
```

`new Date()` needs no special handling — the current instant is the current
instant everywhere.

## Color filters

A film-style grading: collapse to luminance, then re-tint any color.
Sepia is just one preset of this — not a special case.

| id | name | use |
|:---|:---|:---|
| `none` | None | |
| `sepia` | Sepia | flashback |
| `mono` | Monochrome | fully desaturated |
| `faded` | Faded | some saturation kept, lifted blacks, low contrast |
| `cyanotype` | Cyanotype | cool, blueprint-style monotone |
| `gold` | Gold | warm, golden tint |
| `ash` | Ash | slightly blue-tinted grey |

```ts
sky.set({ filter: 'cyanotype' });                     // full strength
sky.set({ filter: { id: 'sepia', amount: 0.6 } });    // dialed down
sky.set({ filter: { tint: [1.1, 0.9, 1.0], saturation: 0.2, lift: 0.05 } });  // custom color
```

Switching filters interpolates the color too, so sepia flows smoothly into cyanotype.

## Camera / skybox

All drawing happens along **view rays cast from the camera**. Sky color, clouds,
sun, moon, and stars are all resolved as "what's visible in that direction" —
the only things left in screen space are lens effects (droplets, flare, vignette).

```ts
sky.set({ camera: { yaw: Math.PI / 2 } });   // face east; sun position and cloud drift follow
```

`yaw` is azimuth (north=0, east=π/2), `pitch` is elevation, `fov` is vertical
field of view. The default is "facing south, 26° elevation, 49° fov" — a
background-friendly framing where the horizon sits just below the frame.

Set `fov` to 90° and draw the 6 directions, and you get a cubemap. Cameras
for those 6 faces live in `CUBE_FACE_CAMERAS`.

```ts
import { AtmosphereRenderer, CUBE_FACE_CAMERAS, resolveConditions } from '@takustaqu/atmosphere';

const renderer = new AtmosphereRenderer(canvas);   // a square canvas
const state = resolveConditions({ time: 16.5, weather: 'summer' });
renderer.resize(512, 512);
for (const face of CUBE_FACE_CAMERAS) {
  renderer.render(0, state, face);
  // bake it with gl.readPixels, toDataURL, or similar
}
```

`renderCubeFaces` is that loop in one call.

```ts
import { renderCubeFaces } from '@takustaqu/atmosphere';

const faces = renderCubeFaces({ time: 16.5, weather: 'summer' }, { size: 512 });
```

It returns 6 square 2D canvases in `CUBE_FACE_CAMERAS` order (+X east, -X west,
+Y zenith, -Y nadir, +Z north, -Z south), ready for `drawImage`, `toDataURL`, or
uploading as cube-map faces. It creates and disposes a throwaway WebGL context
per call, so it's for baking on a scene change, not for calling every frame
(it throws when WebGL isn't available).

## Reduced motion

A full-screen background in constant motion is hard on users with vestibular
disorders, so `prefers-reduced-motion: reduce` is honored by default: `start()`
draws a single still frame instead of looping, and `set()` applies the change as
a cut with no transition. Changes to the media query are followed live, so the
loop stops and resumes as the OS setting is flipped.

```ts
const sky = new Atmosphere(canvas, { respectReducedMotion: false });  // keep animating regardless
sky.reducedMotion;   // true while the sky is being held still
```

## API

| export | role |
|:---|:---|
| `Atmosphere` | canvas + renderer + render loop. `set()` / `jump()` / `start()` / `stop()` / `dispose()` |
| `AtmosphereRenderer` | one `render()` call draws one frame. For custom loops or offscreen rendering |
| `StateAnimator` | following a target, and integrating wind / shape evolution. No DOM dependency |
| `resolveConditions(c)` | `Conditions` → `AtmosphereState` |
| `resolveWeather(w)` | observation / preset → 0..1 parameters |
| `resolveClouds(c)` / `defaultCloudMix(...)` | resolving cloud genera, and auto-expanding from cloud cover |
| `CLOUD_GENERA` | metadata for the ten genera (name, nickname, altitude, form) |
| `resolveFilter(f)` | resolving a filter specification |
| `solarPosition(date, loc)` | solar azimuth/elevation from latitude/longitude and datetime |
| `WEATHER_PRESETS` / `FILTER_PRESETS` | presets |
| `DEFAULT_CAMERA` / `CUBE_FACE_CAMERAS` | cameras |
| `renderCubeFaces(c, opts)` | bake the 6 skybox faces in one call, as 2D canvases |
| `formatTod(tod)` | `14.5` → `"14:30"` |
| `weatherLabel(id, locale)` / `filterLabel(id, locale)` / `cloudGenusLabel(id, locale)` | localized labels (`'en'` / `'ja'`) |

To integrate with your own render loop instead of using `Atmosphere`:

```ts
const renderer = new AtmosphereRenderer(canvas);   // renderer.available === false if WebGL isn't supported
const anim = new StateAnimator(resolveConditions({ time: 14, weather: 'summer' }));

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.2, (now - last) / 1000); last = now;
  anim.step(resolveConditions({ time: 23, weather: 'typhoon' }), dt);   // pass the target every frame
  renderer.render(now / 1000, anim.current, DEFAULT_CAMERA, anim.wind, anim.evolution);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## Internationalization

The core's `label`/`alias` fields (`CLOUD_GENERA`, `WEATHER_PRESETS`,
`FILTER_PRESETS`) are English. Japanese labels are available through
`weatherLabel(id, 'ja')` / `filterLabel(id, 'ja')` / `cloudGenusLabel(id, 'ja')`
(`src/i18n.ts`).

```ts
import { weatherLabel, cloudGenusLabel } from '@takustaqu/atmosphere';

weatherLabel('typhoon', 'ja');           // '台風'
cloudGenusLabel('cumulonimbus', 'ja');   // { label: '積乱雲', alias: '入道雲' }
```

`examples/react/AtmosphereControls` switches between them via a `locale` prop (default `'en'`).

## Examples

`examples/` is usage examples for the renderer — it isn't part of atmosphere itself.
If you don't like how one looks, copying it and rewriting it is the fastest path.

### React

```tsx
import { AtmosphereCanvas } from '@takustaqu/atmosphere/react';
import '@takustaqu/atmosphere/react/styles.css';

<AtmosphereCanvas time={new Date()} weather="rain" filter="sepia" />
```

A settings panel for manual testing, `AtmosphereControls`, ships alongside it.

### Weather controller

```bash
pnpm playground   # → http://localhost:8791/examples/controller/
```

A sample for driving every parameter by hand. **Drag the canvas to look around; scroll to change the field of view.**
Because drawing is ray-basis, this isn't a flat background — it's the same as
looking around the inside of a skybox draped over the scene. Press "Bake 6 faces"
and that same sky gets baked into a cubemap on the spot.

It also shows how the observation values resolved into the renderer's 0..1
parameters at all times, so you can see exactly what `cloudCover` or
`visibility` actually does as you move the sliders.

### Playground

```bash
pnpm playground   # → http://localhost:8791/examples/playground/
```

A contact sheet of conditions laid out side by side. Switch which axis is laid
out with `?sheet=time | weather | genus | sparse | tower | filter | location | camera`;
`?sheet=grow` is an animated demo (a cumulonimbus grows, spreads an anvil, and
collapses over 40 seconds); `?sheet=nimbostratus | altostratus | cumulonimbus`
are benchmarks meant to be compared against real photos. This is the fastest
way to check for regressions after changing the look of something.

## Design notes

- **Hold the sun as a direction, and resolve everything in ray-basis.** The
  sun is handled as azimuth/elevation. That lets a real solar position from
  latitude/longitude be passed straight through, and lets the camera face any
  direction without breaking. Sky color is also a function of elevation along
  the view ray, so there's no need to assume "top of screen = zenith".
- **Advance wind and shape evolution by integration.** Computing position as
  "elapsed time × wind speed" makes the offset jump the instant the weather
  changes the speed, warping the clouds. Integrating `position += speed × dt`
  every frame keeps the offset continuous even as speed changes. Clouds only
  drift when time of day moves; a weather-only change mutates clouds in place.
- **Decompose severe weather into rain, snow, wind, and thunder.** Keeping
  them independent draws windless heavy rain, or a rainless gale. Overall sky
  darkness and cloud turbulence are derived from these.
- **Reduce the ten cloud genera to "4 forms × 3 altitudes".** What actually
  differs is one of four forms — filament, stratiform, granular, convective —
  and altitude (the cloud plane's projection scale).
- **Resolve the cumulonimbus silhouette as a 2D field with a single formula.**
  A 1D height profile — pick one height per azimuth and fill below it — can
  only ever produce a triangular hill. Making it a 2D field over azimuth and
  elevation, and cutting the threshold with a "thrust − height" formula, lets
  it taper naturally toward a round top. Sharpening the azimuthal profile lets
  a tower narrow upward while keeping its height.
- **Build round lobes from summed spheres, then layer high-frequency detail
  separately.** Thresholding noise always produces a fractal boundary at every
  scale, never a round lobe. Summed, jittered spheres give boundaries made of
  circular arcs instead. But a sum of spheres has no high-frequency content,
  so fine detail needs its own noise layered on top. Use at least 3 scales.
  Thin, flat companion forms (anvil, velum) should be built as a lobe field
  flattened vertically, not as an elevation band — a band is structurally a
  line no matter how frayed its edge gets.
- **Keep the shading signal unsaturated; build contrast in the color mapping.**
  Raising the gain and clamping to ±1 collapses surface orientation to two
  values, and the color built from it to two colors. Keep the signal
  continuous and small, and walk it across dark/mid/bright through a wide
  `smoothstep`. Pushing contrast toward photographic realism tends to look
  like a pasted-on cutout — for a background, favor the weaker choice when unsure.
- **Precipitation reads as lost visibility, not as particles.** Drawing only
  particles reads as "white dots floating in a clear sky". Particle size and
  spacing need to vary continuously with depth, or it reads as artificial.
  Skip cloud genera with amount 0 entirely, and default to a light footprint
  (30fps, ~0.55× resolution).

## Cumulonimbus companion forms

Anvil and veil clouds aren't among the ten genera — they're forms attached to
cumulonimbus, so they live in `features`. Omit it and they're derived
automatically from `cumulonimbus`'s development (veil accompanies a growing
tower; it fades once it matures and the anvil spreads).

```ts
sky.set({ weather: {
  clouds: { cumulonimbus: 0.9 },
  features: { anvil: 1, velum: 0.3 },   // explicit
}});
```

These two are built fundamentally differently. Anvil is **ice crystal**, so it
has no cauliflower texture — it becomes silky horizontal streaks that spread
far downwind. Veil is **water droplet**, so it has no fibers — it drapes as a
single, smooth white sheet over the tower's flank.

## Not implemented

- Moon phases and orbit (currently a full moon fixed opposite the sun at 35° elevation)
- Other variants (lenticular, fallstreak holes, mammatus, pileus, etc.)
- A physical atmospheric-scattering model (colors are hand-tuned, not Rayleigh/Mie)
- A path for temperature, humidity, and pressure themselves (visibility and cloud cover stand in for now)

## Distribution

This ships **TypeScript source as-is**, not a build artifact
(`exports` points at `src/*.ts`). It assumes a bundler like Vite.
`pnpm typecheck` checks types only.

## License

MIT License.
 See [LICENSE](LICENSE).
