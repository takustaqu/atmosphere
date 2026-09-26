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
  sunset/magic-hour mauve, city lights at night
- **The night sky** — light pollution on the Bortle scale, a Milky Way made of
  resolved stars with its bulge and Great Rift, meteor showers at a ZHR
- **The moon** — a crescent with earthshine and maria on the dark side;
  the disc occludes the stars behind it
- **The ten cloud genera** — cirrus, cirrostratus, cirrocumulus, altostratus,
  altocumulus, nimbostratus, stratus, stratocumulus, cumulus, cumulonimbus.
  A perspective projection from the intersection of the view ray and each
  cloud plane gives depth by altitude
- **Cumulonimbus anvils** — a tower that reaches the tropopause spreads out horizontally
- **Cloud lighting** — pseudo shading toward the sun, silver lining,
  blue-grey shadow from continuous thickness, flattening to diffuse light under overcast
- **Cloud shape evolution** — the domain-warp field itself moves, so clouds billow and collapse in place
- **Precipitation** — rain (leaning with the wind), snow (tumbling on the wind), droplets on the lens
  (switchable — see [Lens](#lens))
- **Severe weather** — lightning, cloud turbulence from high wind
- **Visibility** — haze/mist/fog. Thin haze only crushes the horizon; thick haze covers the whole sky
- **Lens flare** — ghosts along the optical axis, chromatic aberration, anamorphic-style streaks
- **Color filters** — sepia, monochrome, cyanotype, and more
- **Photographic controls** — a tone curve over the linear-light composite,
  and a circular-polarizer emulation

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

## The night sky — light pollution, the Milky Way, meteors

The counterpart to `weather`. Weather is what the air is doing; `celestial` is
what is behind it. They are separate axes because they are independent — a meteor
shower is not a weather condition, and the same shower looks like nothing at all
under cloud.

```ts
sky.set({ celestial: 'perseids' });
sky.set({ celestial: { bortle: 3 } });                  // Milky Way follows from it
sky.set({ celestial: { bortle: 2, meteors: 40 } });
```

Units follow the same rule as weather: whatever the observation is actually
measured in.

| property | unit | meaning |
|:---|:---|:---|
| `bortle` | 1..9 | the **Bortle dark-sky scale**. Drives star density and the horizon glow of city light. Defaults to 6 — the bright suburban sky this has always drawn |
| `milkyWay` | 0..1 | visibility. Derived from `bortle` when not given: gone by Bortle 6, which is why the default sky has never shown one |
| `meteors` | /h | **ZHR** (zenithal hourly rate). ~5 is the sporadic background; the Perseids peak near 100, the Geminids near 150. Defaults to 0. **A ZHR counts the whole sky** and a frame covers under a fifth of it, so an honest 150 puts one in shot every few minutes — use values in the thousands if you want them watchable |
| `radiant` | `[elevation, azimuth]` | where a shower's meteors stream from. `null` gives sporadics, from anywhere |

Presets: `dark-sky` `rural` `suburban` `city` `perseids` `geminids`.

The default is a no-op — `celestial: 'suburban'` is pixel-identical to omitting it
entirely, so nothing about the existing sky changes until you ask for something.

Two things are worth knowing about how these are drawn:

**The Milky Way is made of stars.** The band raises the local star density rather
than painting a luminous stripe; the diffuse glow is only the unresolved
remainder. Drawn the other way it reads as an airbrushed diagonal, which is
exactly what it looked like before this was fixed. It is additive light in linear
space — a faint band over a near-black sky is precisely the case that goes wrong
in gamma-encoded compositing.

**Meteors are events, not objects.** They run on the same machinery as lightning:
chop the clock into slots, hash each one, fire if it clears the threshold. They
are drawn in ray space, so a meteor stays where it is in the sky as the view
swings rather than being glued to the frame.

> Under `prefers-reduced-motion: reduce` the `Atmosphere` loop draws a single
> still frame, so `meteors` is forced to 0 there — a streak caught mid-flight
> would sit on the sky as a scratch. Driving `AtmosphereRenderer` yourself, that
> is your call to make.

## Tone curve

Scene-referred, unlike the color filters below: these act on linear scene light
before it becomes display values, which is the only place they mean anything. A
multiply in linear light is an exposure; the same multiply on gamma-encoded values
is just an odd darkening.

```ts
sky.set({ tone: 'filmic' });
sky.set({ tone: { exposure: 0.4, contrast: 1.15 } });
sky.set({ tone: { id: 'punch', bleach: 0.3 } });
```

| field | what it does |
|:---|:---|
| `exposure` | stops. 0 unchanged, +1 is twice the light |
| `contrast` | pivoted on 18% grey. 1 unchanged |
| `knee` | where the highlight shoulder starts. **Identity below it**, so the default 0.8 shapes only blown highlights |
| `bleach` | 0..1 highlight desaturation toward white — what film does, and what stops a bright sky clipping into a muddy cast |

Presets: `neutral` `flat` `punch` `filmic` `blown`.

The knee is the important one. At 0.8 the published look is untouched; bring it
down to put the curve through the midtones, and that is where it becomes a look.
The same shoulder is what expands into `headroom` when there is HDR to expand
into, so a curve dialled in now stays the curve later.

## Circular polarizer

A CPL emulation — not a grade. It is an optical filter, so it is a transmission
multiply on scene light, applied to the sky gradient *before* the clouds, sun,
moon and stars composite over it.

```ts
sky.set({ polarizer: 'strong' });
sky.set({ polarizer: { strength: 0.6, angle: Math.PI / 4 } });
sky.set({ polarizer: true });    // shorthand for a light CPL
```

The physics it follows: Rayleigh-scattered skylight is partially polarized, most
strongly 90° from the sun (`sin²θ / (1 + cos²θ)`), while cloud light is Mie-scattered
off droplets and comes out essentially unpolarized — as does direct sunlight. So
the filter darkens the sky and leaves the clouds alone, which is the whole reason
to carry one. Measured on a clear noon sky facing away from the sun at
`strength: 0.9`:

| | luma vs unfiltered |
|:---|---:|
| clear sky, `angle: 0` | **62%** |
| clear sky, `angle: π/2` | **126%** |
| overcast (all cloud) | **99.8%** |

Clouds pop because the sky behind them dropped, not because they got brighter.
Rotating `angle` sweeps smoothly between those extremes with a period of 180°, and
because the polarization direction rotates across the frame, a wide shot picks up
an uneven band of darkening — a real artifact of the real filter, reproduced.

| field | what it does |
|:---|:---|
| `strength` | 0..1 how much of the polarized component is rejected |
| `angle` | rotation in radians. ~0 darkens, ~π/2 brightens |
| `saturation` | 0..1 extra saturation on what survives (the white veil goes with the polarized part) |
| `stopLoss` | 0..1 how much of the real ~1.3-stop loss to apply. Defaults to 0 — emulating the loss without the exposure compensation just makes the picture dark |

Presets: `none` `light` `strong` `crossed`.

## Lens

What happens on the glass rather than in the sky. For now that is the raindrops
that collect on the lens while it rains — they bead up, bend the sky behind
them, and dry off again. They are on by default; a sky behind a UI often wants
the rain without the water on an imaginary camera.

```ts
sky.set({ lens: { droplets: false } });   // rain through clean glass
sky.set({ lens: { droplets: 0.4 } });     // fainter droplets
sky.set({ lens: { droplets: true } });    // back to the default
```

| field | what it does |
|:---|:---|
| `droplets` | 0..1 (or a boolean) ceiling on the lens droplets. They still follow the rain, so a dry sky shows none at any value. Defaults to 1 |

Changing it eases over the same few seconds as everything else, so switching
them off lets the drops on the glass dry away instead of vanishing. At 0 the
droplet pass is skipped outright, not just drawn invisibly.

## Light for the foreground

Something usually stands in front of the sky — an avatar, a product shot, a
card — and it only belongs there if the same light falls on it: a rim from
behind when the sun is ahead of the camera, the background's colors wrapping
over its edges, fill from the dome above and the ground below. `sky.light`
hands those over as plain numbers for another renderer to light with.

```ts
const sky = new Atmosphere(canvas, {
  lightProbe: true,                       // measure the sky ~10×/s
  onLight: (light) => { /* push into your renderer */ },
});

const light = sky.light;                  // or read it whenever you draw
```

It comes in two halves, because they come from different places:

**The lights** — `light.sun`, `light.moon`, and `light.key` (whichever is
lighting the scene more, or `null`). Computed from the state with the shader's
own formulas: exact, free, and tracking the camera every frame, probe or no
probe.

| field | what it is |
|:---|:---|
| `direction` | unit vector toward it, world axes (x east, y up, z north) |
| `view` | the same in the camera's frame (x right, y up, z into the screen). **`view[2] > 0` is backlight** — it is behind the subject — and `(view[0], view[1])` is which way on screen the rim faces |
| `screen` | `{ x, y, inFront }`, 0..1 from the top-left; outside 0..1 when out of frame |
| `color` | linear RGB, brightest channel 1 — white at noon, orange at sunset |
| `visibility` | 0..1 how much gets through: horizon and cloud cover |
| `intensity` | `visibility` on one scale for both, a clear sun = 1 (the moon tops out at `MOON_RELATIVE`) |

**The measurement** — `light.frame` and `light.environment`, from drawing the
real shader into a tiny offscreen buffer and reading it back, so clouds, haze,
the filter and the tone curve are all in it. `null` until the first
measurement, and always with `lightProbe` off.

| field | what it is | use it for |
|:---|:---|:---|
| `frame.average` | the whole frame | overall exposure / tint of the foreground |
| `frame.grid` | the frame as `cols × rows` cells (default 8×6), top-left first | **light wrap**: `sampleLightGrid(grid, x, y)` at the subject's edges |
| `environment.sky` / `.ground` | the dome above / below the horizon | a hemisphere light's two colors |
| `environment.zenith` / `.horizon` | above 60° / 0–15° up | top light / grazing light |
| `environment.directions` | `east west up down north south` | an ambient cube: `sampleEnvironment(env, normal)` |

Every color is a `LightSample`: `srgb` (0..1, for CSS or a 2D canvas),
`linear` (for a lighting equation), and `luminance`. Averages are taken in
linear light and weighted by solid angle. The frame is measured as displayed,
lens effects included — light wrap wants what is actually behind the subject —
while the environment leaves the flare and vignette out.

Hooking it to three.js, for example:

```ts
const hemi = new THREE.HemisphereLight();
const rim = new THREE.DirectionalLight();

const sky = new Atmosphere(canvas, {
  lightProbe: true,
  onLight: (light) => {
    if (light.environment) {
      hemi.color.setRGB(...light.environment.sky.linear);
      hemi.groundColor.setRGB(...light.environment.ground.linear);
    }
    const key = light.key ? light[light.key] : null;
    rim.intensity = key ? key.intensity * 3 : 0;
    if (key) {
      rim.color.setRGB(...key.color);
      rim.position.set(...key.direction);   // same right-handed, y-up axes
    }
  },
});

// keep the two cameras pointing the same way: yaw 0 faces +z
const d = threeCamera.getWorldDirection(new THREE.Vector3());
sky.set({ camera: { yaw: Math.atan2(d.x, d.z), pitch: Math.asin(d.y), fov: THREE.MathUtils.degToRad(threeCamera.fov) } });
```

The weather controller's **Foreground light** panel draws a figure lit from
nothing but these numbers (`examples/controller/figure.ts`), fill, wrap and
rim — a working reference for a 2D compositor.

**Cost.** A measurement is a few thousand pixels of drawing, which is nothing,
plus a GPU readback, which is not: `readPixels` waits for the GPU. About 1 ms
of main-thread wait on an M2 Max; 3–5 ms on a Radeon 780M through ANGLE's
Direct3D backend, nearly all of it the round trip to a GPU that went idle
after the last frame (back to back, the same measurement takes 0.5 ms). So it
runs at `rate` (default 10/s), before the frame's own draw so it waits only on
itself, and eases each result in over `smoothing` seconds (default 0.3) — a few
dozen point samples of a moving sky shimmer otherwise. Lower `rate` where a
stall of that size matters, and on a canvas that is not being presented (hidden,
or drawn but never composited): the readback then also waits for every frame
queued since the last one. `smoothing: 0` passes lightning through at full
strength.
`sky.measureLight()` takes one right now, unsmoothed, probe option or not;
`AtmosphereRenderer.probe()` is the same thing for a custom loop.

## Display P3

Rendered in Display P3 where the browser supports it, sRGB otherwise. No setup
needed — `colorSpace` defaults to `'auto'`.

```ts
const sky = new Atmosphere(canvas, { colorSpace: 'srgb' });   // opt out
sky.colorSpace;   // 'display-p3' or 'srgb' — what's actually in use
```

The conversion is appearance-preserving: the palette is untouched, and the sky
looks the same on either display. What it buys is narrow but real — highlights
that run past 1.0 (the sun's core, a lightning flash) clip later in P3, so a
little more of the blowout survives.

It does **not** currently reach outside sRGB, and that's a property of the
palette, not an oversight. sRGB and Display P3 share the same blue primary, so
P3's extra room is entirely in red and green — and a sky is blue-dominated. The
one warm color, magic hour's amber, composites down to a desaturated salmon that
sits well inside sRGB. Measured with a two-space readback diff, deliberately
widening the light sources moves them under 1.5% past sRGB, and magic hour never
leaves sRGB at all. Getting a visible wide-gamut sky means re-tuning the ~60
color literals against P3 primaries; the machinery for that is in place
(`GAMUT_REACH` in `renderer.ts`), unused.

Baking wide-gamut faces needs the receiving 2D canvas to agree, or the copy
clips back to sRGB. `renderCubeFaces` handles this; a hand-rolled loop should
pass `renderer.colorSpace` through:

```ts
canvas.getContext('2d', { colorSpace: renderer.colorSpace }).drawImage(source, 0, 0);
```

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
| `resolveCelestial(c)` | resolving a night-sky specification |
| `resolveTone(t)` / `resolvePolarizer(p)` | resolving a tone curve / polarizer specification |
| `resolveLens(l)` | resolving a lens specification |
| `celestialLights(s, cam, aspect)` | the sun and moon as directional lights, without a probe |
| `sampleLightGrid(g, x, y)` / `sampleEnvironment(env, n)` | reading a light measurement at a screen point / for a surface normal |
| `srgbToDisplayP3(c)` / `displayP3ToSrgb(c)` | convert an encoded color between the two spaces |
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

## Waiting for the shader

The shader is compiled off the main thread, so nothing is drawn for the first
moment of a page's life. `render()` is a no-op until then, `ready` says whether
it has happened, and `onReady` fires when it does — with `false` if the device
could not compile the shader at all, which is the signal to keep your fallback
background for good.

```tsx
const [ready, setReady] = useState(false);
useEffect(() => {
  const sky = new Atmosphere(canvasRef.current!, { weather: 'summer', onReady: setReady });
  return () => sky.dispose();
}, []);
// <canvas style={{ opacity: ready ? 1 : 0, transition: 'opacity 600ms' }} />
```

How long that takes is a browser and driver question, not a scene one. On
Windows, WebGL runs through ANGLE's Direct3D backend, whose compiler inlines
and unrolls a shader this size into something very large; a first visit costs
a few seconds there, and near nothing on macOS. Every visit after that is
instant on any platform — browsers keep compiled shaders in an on-disk cache.

Pass `compile: 'sync'` to `AtmosphereRenderer` to block until the program is
linked instead. That is what `renderCubeFaces` does, because a bake has no
loop to come back on; do not do it for anything on screen.

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
- **Bake the value-noise lattice into a texture, and fetch it at an explicit
  LOD.** Every cloud here bottoms out in `fbm`, and `fbm` used to bottom out in
  twenty hash evaluations, inlined at every one of several dozen call sites.
  That is cheap to run and ruinous to compile: Windows hands the shader to
  Direct3D through ANGLE, which inlines and unrolls all of it. Reading the
  lattice from a small tiling texture and letting the sampler's own bilinear
  filter do the interpolation is the same arithmetic in one instruction. But
  ask for it with a plain `texture2D` and it gets *slower*: a fragment-shader
  fetch carries an implicit derivative, a derivative may not sit in non-uniform
  control flow, and the compiler resolves that by flattening — every "skip this
  genus" branch stops skipping. Naming the mip level asks for no derivative and
  the branches come back.

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

- Moon orbit and phase from the date (currently a crescent fixed opposite the sun at 35° elevation)
- Other variants (lenticular, fallstreak holes, mammatus, pileus, etc.)
- A physical atmospheric-scattering model (colors are hand-tuned, not Rayleigh/Mie)
- A path for temperature, humidity, and pressure themselves (visibility and cloud cover stand in for now)

## Distribution

The npm package ships **built ESM bundles with type declarations**
(`exports` points at `dist/`), with no dependencies — no bundler required.
The TypeScript source rides along in `src/` for reference; in the
repository, `pnpm typecheck` checks it and `pnpm build` produces `dist/`.

Release history lives in [CHANGELOG.md](CHANGELOG.md).

## License

MIT License.
 See [LICENSE](LICENSE).
