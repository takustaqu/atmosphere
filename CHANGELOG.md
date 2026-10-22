# Changelog

## Unreleased

### Added

- **A softer thunderhead: `features.softness`.** The volumetric tower's
  surface was drawn as a skin, every lobe a hard-edged lump lit as a solid —
  the outline a clean line, every fold a crease, every floret a bump. It now
  has a shell its outline fades across, the sky showing a little through its
  outer part and fine tufts of smooth noise thinning it in place; the face
  turns more with the body than with each lobe, the light wraps further round
  and diffuses deeper into the folds, the florets dapple rather than bump, and
  the shell's outer part is lit through as lining against the sun. 0 is the
  old cauliflower, 1 toward cotton candy; the default 0.6 is a little of the
  way. The 2D tower ignores it; the controller has a Softness slider. It costs
  about 3–5% more GPU time on a frame with the volumetric tower.
  Where one turret stands in front of another, its edge now fades over the
  face behind as a soft cloud's would, the light read on both and blended:
  before, the light was read in the air between them, and every seam was
  drawn in a thin dark or light line — and a crease of sky between two
  turrets was lit as the shell's thin edge, a jagged sky-blue streak down the
  tower. Nor is the tower ruled with faint vertical lines any more where the
  turrets the light reads changed from one column of pixels to the next.
  Another 3–4% on the tower's frame.
- **A volumetric thunderhead, drawn by default.** The tower is ray-marched
  through a 3D density built on the same turrets: real depth between them,
  with the 2D tower's skyline (each turret's head a dome two fifths of its
  height deep, so the turrets stand proud of the body instead of meeting in
  a mesa, and no ledge ruled along the skirt or the body's top), two scales
  of lobes as its surface — each a swelling of the surface under it, read
  along its turn, so no lobe stands clear of a narrow crown or rises off it
  as a finger — and the 2D tower's packed florets laid on its light and
  fraying its outline into cauliflower, lit by Beer–Lambert taps toward the
  sun and the sky. The edges between turrets fade over the same few pixels
  the outline does, so they glide rather than step as the storm drifts; the
  crease behind a turret's edge is lit as the faces either side; a tower at
  night or before dawn stands dark against the glow over the horizon as the
  2D one does; against a low sun only the flanks the light reaches past the
  other turrets take it gold. The cap draped over the heads (velum) takes
  the turrets' own light where it lies across them and shows as a collar
  only past their flanks, the anvil's plate passes behind the turrets'
  crowns, and the glow round a backlit rim follows the outline without
  being ruled off up the sky — before, a summer tower toward a high sun
  (the gallery's 夏空) had a grey, streaked, glassy band laid across its
  white turrets half way up, cutting each one off flat, a green one at
  dusk, and a pale panel by the sun. Every lobe keeps a lit cap and a dimmer flank,
  and the shade is the luminous blue-grey of light scattered through the
  cloud, as light under the heads as the 2D tower's. The new
  `cumulonimbus` option (and `sky.cumulonimbus`, live) picks the tower:
  `'auto'`, the default, draws this one, except for a storm close by with
  its base looming overhead (`features.distance` under 0.42), where the
  march's coarse lobes come out as smooth slabs and the 2D tower is drawn —
  the two crossfaded across 0.42–0.52, so a storm drawing nearer or
  receding never pops from one to the other. `'2d'` keeps the 2D tower at
  every distance, the lighter option, and `'volumetric'` this one. A frame
  with the volumetric tower costs about 1.10–1.19× the 2D tower's at 1080p
  (1.13× at the site's hero), a near storm what the 2D tower costs, and a
  frame inside the crossfade draws both (about 2.3×) while the distance
  passes through; each tower compiles as its own variant, only when a
  tower is up. As the storm drifts, pixels changing by 20 levels or more a
  frame are 1.2–1.4× the 2D tower's at 640×400 and some three times at
  1280×800. The controller's chips switch it, and `?cb=auto|2d|volumetric`
  opens on one.

### Changed

- **A trace of stratocumulus no longer streaks a thunderhead.** The layer
  crossed a tower at its own translucency — a few percent of cloud in every
  grain at the amounts a summer sky carries — and toward the horizon, where
  the towers stand, its rolls are drawn out flat: the mass came out ruled
  with faint pale and grey streaks, over either tower, the volumetric one's
  smooth faces most. Over a tower now only what is nearly opaque crosses
  it, in the tower's tone, as the cumulus's lumps already did.

- **Every turret worked out once a frame.** The turret table the shader
  looks the thunderhead's turrets up in now carries each turret whole — its
  height, where in its cell it stands and its hashes — rather than only its
  thrust, which every pixel near the tower raised into a height again for a
  dozen turrets or more. The same picture to within a few outline pixels,
  and about 3–5% off a frame with the 2D tower in it at 1080p.

- **The thunderhead is a cauliflower, not putty.** Its face was lit off
  the lobes read as a smooth sum, plus a coarser scale wider than a turret
  and soft pools of self-shadow: a few huge clay-like lumps under airbrushed
  gradients, nothing finer than about thirty pixels on a tower drawn large,
  and a uniform dull grey under a summer noon. The face is now lit off the
  same lobes read as a pack — at each point the lobe in front gives the
  normal, so where one meets the next the light turns over in a fold about
  a pixel wide, antialiased, the lower floret's lit top laid against the
  shaded underside of the one above. Below the finest lobes up to three more
  octaves of florets are added for as long as they stay a few pixels across,
  so a near or zoomed tower gets more detail, not bigger lumps. Each lobe
  and floret casts a shadow on its neighbours (a ray tried against the
  lobes as spheres), gaps and folds go to a cool blue-grey, the coarse
  scale and its shadow pools are gone, and the darkening toward the base
  covers its foot only rather than the lower 60% of the tower. Sunlit
  faces are whiter, and a tower with a high sun behind it — the hero's
  view toward the sun — glows a luminous blue-white with lit crowns instead
  of a flat grey. A lobe's outline was also cut off along a circle short of
  its widest swelling, which drew hard stair-stepped arcs inside the tower;
  that is fixed, and the middle lobes' folds and outline wander at floret
  scale instead of running in long smooth arcs. Outline, height, anvil, life,
  backlit lining and fade-out are unchanged. It costs 4–8% more GPU time at
  1080p on scenes with a tower (14% on a near storm); frame-to-frame changes
  stay as smooth, with slightly more small change as the finer texture
  drifts.

## 0.7.0 — 2026-10-21

The thunderhead, rebuilt. The cumulonimbus is a cluster of turrets on a flat
base, broad rather than pointed, lit as cloud with irregular lobes and a
mixed soft-and-crisp outline; it moves without stepping and sinks away as a
storm runs out. Lunar eclipses fall on their dates, and the sky gains rain
shafts, cloud iridescence, the circumzenithal arc, whitecaps, cloud shadows
on the sea and the rainbow's reflection.

### Changed

- **The cumulonimbus is rebuilt**, in six passes measured against
  photographs. It is still a 2D field over azimuth and elevation, but:
  - **Its flanks no longer streak.** The vertical slats were the noise
    texture's bilinear filter — the GPU keeps about 8 bits of position
    between texels, so a read along the azimuth rose in steps, and the
    steep power that turns thrust into height raised each step into a
    column. The azimuth-only reads now blend the lattice in float.
  - **Lobes are lit domes.** Each cauliflower lobe carries a normal and a
    height, so crowns catch the sun, the creases between lobes fall into
    shadow, lobes shade one another, and a high sun lights the tops where a
    low sun lights the sunward flanks. The tower as a whole has a lit side
    and a shaded side. No more grey blotches without form.
  - **A cluster of turrets on a flat base.** A tower is several turrets
    competing in height, each with a domed head, on a flat dark base with a
    skirt of towering cumulus at its foot; the body is solid to the base
    (aerial perspective now blends color and contrast instead of making the
    lower body see-through); nothing floats detached above the mass.
  - **Broad, not pointed.** The profile is full-bodied — steep, bulging
    flanks and a wide rounded crown — in place of a cone narrowing to a
    spire, and a grown tower tops out near 33° rather than 45–55°.
  - **The anvil is a thin plate**, spreading downwind from each turret that
    reaches the tropopause, fibrous and translucent at its reaches, lit as
    high cloud so it keeps the sun after the tower below has gone grey, and
    glowing rather than darkening against the sun. Mammatus hang from its
    underside on mature storms: round pouches, bright below, orange under a
    low sun.
  - **`features.distance`** (0..1, default 0.65): how far off the storm
    stands. 0 brings its base overhead with the anvil and mammatus right
    above; 1 puts a small hazy storm on the horizon. Towers, skirt, base,
    anvil and the rain shafts scale together.
  - **Every tower lives a life** on its own clock — congestus climbing,
    then the anvil spreading at the tropopause, then the tower sinking and
    the anvil lingering as a thin orphan sheet before it fades — so a sky
    holds towers at different stages at once. `features.anvil` and `velum`
    remain ceilings over it. A tower's life is a couple of minutes at the
    default evolution speed, and the storms drift at the rate they always
    did, so a sky is laid out as before at every clock.
  - Controller example: a "Distance" slider in the Cumulonimbus companion
    forms drawer.
- **A sky towards the sun or the moon** — the tower's backlight carries round
  to a low sun's side: a tower 25–45° off it has a gold sunward flank and a
  blue-violet body instead of a pale lavender wash; small clouds in front of
  a backlit tower take its tone with only a lit rim instead of reading as
  pasted-on chips; and an anvil seen side-on has a bright top, a darker
  underside and translucent, streaked margins.

- **The thunderhead moves smoothly, with a softer edge.** As it evolved it
  rattled: some reads moved slowly with the storm's clock through the noise
  texture's bilinear filter, which keeps only about 8 bits of position
  between texels, so they held still for a few frames and then jumped — the
  anvil plate spread in steps, each turret's head jumped as a whole every
  ten frames or so, and a sunset flank flickered column by column. Each
  turret's thrust is now computed once a frame on the CPU at full precision
  and handed over as a small table, and the per-azimuth thrust blends all its
  octaves in float. The edge fades over a couple of pixels rather than a
  fixed width of the field, so it no longer reads as a cut-out or crawls at
  a low resolution: tightest at the crown, wider down the flanks, wider again
  on far storms and dying towers. Frame-to-frame change in a tower is now
  steady (its variation 0.76 → 0.04), at no extra cost.

- **The thunderhead has relief, and leaves as the storm runs out.** Its
  lobes carried about 1% of the luminance, so under a high sun or with the
  sun behind the eye it read as a smooth grey mountain. Lobes now tilt
  further toward and away from the sun, the folds between them stay dark
  even in sunlight, crowns facing the sun catch more of it, and each floret
  is shaded as a small ball — about half again the local contrast. And as
  `cumulonimbus` eases toward 0 the towers sink into their base and thin
  out instead of standing full-size until the amount crosses 0.001 and
  vanishing in one frame: below 0.3 the storm keeps its size and its
  turrets sink, the anvil, veil and glow fade with it, and nothing is left
  by 0.03. Rising from 0, the towers grow in rather than popping in whole.

- **The thunderhead's outline is mixed, not one crisp line.** Every lobe
  used to end in the same one- or two-pixel cut, so the silhouette read as
  a cut-out. Now the crown of a young, growing tower stays crisp, while the
  edge goes soft lower down, on the skirt of towering cumulus, under the
  tropopause and all round a dying tower. A slow noise also varies it along
  the outline, so one lobe can be crisp and the next feathered. Where the
  edge is soft it fades over several pixels, frayed into strands, with the
  sky showing through it. It also takes on more of the air's color: paler
  in front light, glowing against the sun, and more so on a far storm. The
  silhouette itself does not move. It costs at most about 1% more GPU time,
  and the edge flickers less from frame to frame as the tower drifts.

- **The thunderhead is lit like cloud, not like a heap of balls.** Each
  lobe was shaded as a smooth sphere: a bright cap rolling down to a dark
  underside, the same on every lobe, with a thin dark arc wherever two met
  — glossy metaballs. The lobes now tilt the face by the slope of a smooth
  surface built from the same spheres, bumps on bumps with the florets
  tilting it as far as the lobes do, so the light models them softly and
  nothing turns in a pixel. Lit faces stay white across most of their lobes,
  shadows pool softly in the lee of each lobe instead of being cut out
  along its rim, the creases between lobes are only faintly darker, and
  the crowns no longer carry a highlight. A low sun's gold still lights a
  tower's sunward flank, without lighting lone lobes on its shaded side.
  The silhouette is unchanged, as are the cost and the frame-to-frame
  steadiness (a little steadier, if anything).

- **The thunderhead's lobes are no longer spheres pressed into one
  another.** Seen close, each lobe was still a perfect disc: a clean
  circular seam where it overlapped the lobe behind, often stair-stepped on
  the pixels, with a dark crescent along it and a smooth dome inside. Each
  lobe's outline now swells into two, three and five smaller bulges, no two
  lobes alike; its rim fades out over its margin instead of ending in a
  line; the largest lobes are drawn a little smaller so they too can swell;
  and the shadow a lobe casts on the one behind spreads over twice the
  depth, soft and irregular rather than a crescent. The tower's outline,
  height, anvil and life are unchanged — the lobes stand where they stood —
  and sunlit crowns are a little whiter again. It costs 3–8% more GPU time
  on a scene with a tower; frame-to-frame steadiness is unchanged.

### Performance

- **Compiled out where it cannot show.** The cumulonimbus and everything
  that serves it (`FEATURE.CB`), light from behind on cloud near the sun
  (`BACKLIT`), cloud iridescence (`IRIDESCENCE`) and moonlight carried
  through thin cloud (`MOONLIT`) are each their own shader feature, set only
  when their light can be above zero. A frame without them no longer pays
  for their presence in the program.
- **Fewer noise reads in the thunderhead.** A second noise texture holds
  each texel's 2×2 block, so the high-precision noise is one fetch instead of
  four; the turret rows and lobe stack are skipped where the ray is clear of
  any tower, anvil plates check their geometry before reading noise, and a
  few per-pixel reads are deferred to where they can act.
- At 1080p on an M2 Max, against 0.6.0 with the additions above: fair sky
  3.9 → 3.0 ms, overcast 5.2 → 4.0, thunderstorm 5.6 → 5.0, night with a moon
  halo 2.0 → 1.9, typhoon at sea 2.6 → 2.2 — faster than before. With a
  cumulonimbus in view the rebuild still costs more: a summer sky 5.5 → 8.8,
  towers at mid-distance 7.0 → 7.9, a sunset against a thunderhead 7.7 → 8.8.
  The output is unchanged by these within 1/255.

### Added

- **Lunar eclipses, on their dates.** The lunar ephemeris is now the
  abridged Meeus series (51 terms in longitude and distance, 30 in
  latitude, with the E factor and the planetary corrections) — good to
  about 0.001°, where the old series' degree could not place the moon in an
  umbra 0.7° across. With a location and a date, `lunarEclipse` gives the
  fraction of the disc in the Earth's umbra and penumbra (Chauvenet's shadow
  radii with the usual 1/50 enlargement, an exact two-circle overlap), and
  the state carries it as `moonEclipse`. The disc goes a dim copper red by
  that fraction, the shadow biting in from the limb it is moving toward and
  darker toward its centre, with the maria still faintly there; the moon's
  light on the clouds, its halo and its path on the sea fade with it, and
  `AtmosphereLight`'s moon dims and reddens. Greatest eclipse for
  2025-09-07, 2026-03-03 and 2026-08-28 lands within a minute of NASA's
  times, with the published umbral magnitudes to ±0.004.
- **Rain shafts.** Under a distant thunderhead, or a rain deck, a grey
  curtain hangs from the cloud base toward the ground: streaky, leaning
  downwind, densest just under the base — virga that runs out by mid-height
  when the rain is light, a curtain to the horizon when it is heavy. A low
  sun lights it from the side, orange at sunset; lightning flashes in it.
  Its own shader feature (`FEATURE.SHAFTS`), compiled in only when it rains
  or a thunderhead has thunder; a clear or fair frame is bit-identical.
  About 4% on a thunderstorm frame.
- **Cloud iridescence.** Thin water cloud within a few degrees of the sun
  takes on pastel pink, green and blue bands following its own edges — the
  same diffraction as the moon's corona, carried by the cloud's density
  rather than laid round the sun as rings. Strongest on altocumulus fringes;
  none on ice cloud; gone under a gloom.
- **The circumzenithal arc.** Through a cirrostratus veil with the sun
  below 32°, an upside-down rainbow stands round the zenith on the sun's
  side — placed by the plate-crystal relation rather than a fit, red on the
  lower edge and violet above, brightest with the sun near 22°, gone as it
  climbs. The most saturated member of the halo family, and brighter than
  the 22° ring.
- **The sea breaks into whitecaps.** Above about 7 m/s the crests foam,
  covering the share of the water Monahan's formula gives (1% at 10 m/s,
  7% at 18, two fifths in a typhoon), with a net of foam strands that
  stretch into streaks along the wind as it rises; white by day, grey under
  a storm, warm at sunset.
- **Cloud shadows on the water.** By day the water under a low cloud loses
  the sun's glitter and goes darker and bluer: each sea point is traced
  toward the sun to the low cloud plane and read against the cumulus and
  stratocumulus fields there, with the clouds' own thresholds. At the eye's
  height a shadow is hundreds of metres across, so it reads as the glitter
  coming and going rather than as patches to match overhead.
- **The rainbow's reflection.** The sea mirrors the bow as well as the sky
  now: the lower part of a circle centred above the horizon, warped by the
  swell, with the same gating and unevenness as the bow in the sky.
- Controller example: "Iridescence", "Circumzenithal arc", "Rain shafts"
  and "Backlit thunderhead" buttons in the Sky phenomena drawer; the
  resolved-state readout shows the eclipse fraction.
- Site: gallery tiles for the backlit thunderhead, the circumzenithal arc,
  the total lunar eclipse of 3 March 2026 from Tokyo, and rain shafts.

### Changed

- **Clouds against the sun are backlit.** A cumulonimbus standing between
  the eye and the sun came out the same lavender-white as one across the
  sky, and read as a translucent veil for being too light to stand in front
  of anything — the overexposed disc even shone through its base. Against
  the sun the mass now goes dark, in the shade's color (blue-grey by day,
  violet-grey at dusk), darker with depth and in the lobes' cores; only
  the rim, where the silhouette thins, blazes in the sun's own color, gold
  at sunset, with a soft forward-scatter glow outside the edge. The veil
  cap darkens over the tower and glows where it hangs in open sky. Cumulus
  get the lighter version: thick cores a soft grey-blue, thin lumps and
  margins glowing; a lump in front of a tower that hides the sun takes the
  tower's shade instead. Away from the sun nothing changes.
- **Cumulus have a lit flank and a shaded one.** The lit-ness read from the
  cloud field leaned bright inside every lump whatever the side, which is
  why they were white all round; the density gradient toward the sun now
  swings the crown's and base's lit-ness, widest with the sun to one side,
  for lumps low enough to show their flanks. Kept mild: a fair sky's cotton
  stays white.
- Measured at 1080p on an M2 Max, the backlighting and the flank shading
  cost about 0.5 ms on a fair frame, 1 ms on a thunderstorm, and 1.7 ms on
  a summer sky looked at toward the sun; iridescence a few tenths on a
  cloudy frame. A clear noon is 0.3 ms slower by their presence in the
  program alone.

## 0.6.0 — 2026-10-19

The moon as a light on the clouds. A moonlit cirrostratus glows round the
moon with a soft, faintly colored 22° halo, and a thin water cloud in front
of the moon is lit through, ringed by the corona.

### Changed

- **A moonlit veil glows, and its halo is soft.** At night the cirrostratus
  was one dark blue whatever the moon did, and the moon's 22° halo was a
  thin ring added on top — round a dark sky it read as a ring round a hole.
  The veil is now lit by the moon, a little everywhere and far more toward
  it (the crystals send its light on forward), with a glow round the moon
  itself; the ring is a soft band a shade brighter than the veil inside it,
  faintly colored as the sun's is — red on the inner edge, through yellow to
  white, and a trace of blue as it fades outward.
- **A cloud in front of the moon glows.** The moonlight on night clouds
  was one flat silver whatever the moon's direction. A thin cloud near the
  moon is now lit through from behind — bright at its thin edges while thick
  cores stand dark against it, so the moon reads as the lamp behind them —
  and a water cloud (not an ice one) carries the corona: a bluish-white
  aureole and a red-brown ring beyond the limb, then fainter blue-green and
  red. Measured from the limb, since the disc is drawn larger than life.
- Controller example: "Moon halo" and "Moon behind clouds" buttons in the
  Sky phenomena drawer.

## 0.5.0 — 2026-10-12

Clouds and a rainbow measured against photographs. Cumulus follows the
reported cloud cover, is white rather than a grey camouflage print, and has
soft edges; the rainbow is light added to the sky rather than three stripes.
The controller can call up a rainbow, a halo or the aurora by name.

### Changed

- **Cumulus edges are soft.** The edge ramp the other layers use cut each
  lump out of the blue like paper overhead, where it is narrowest; cumulus
  now ramps over about twice the width around the same threshold, so the
  lumps keep their size and lose the outline. Their crowns carry more of
  their own shading, too, rather than a flat white that read as hard
  contrast against the blue.
- **The rainbow is light, not three stripes.** Its colors were bands laid
  side by side, and read as red, green and blue lines. Each of seven
  wavelengths now has its own bow — a bright edge with a tail of light
  toward the inside, smeared by the sun's half-degree disc — and the bows
  overlap: a continuous run from red outside through yellow and green to
  violet, a whitish glow inside the primary where they add back up to
  sunlight, and a secondary turned the other way, wider and fainter.
  Measured against photographs, it is also fainter against the blue, a
  little wider and less saturated (drops span sizes), and uneven along its
  arc: a shower is never an even curtain, and the bow is most often
  strongest low down, fading as it climbs into drier air.
- Controller example: a "Sky phenomena" drawer — rainbow, 22° halo and
  aurora buttons that set the weather each needs and turn the camera to it,
  and "face the sun" / "face away from the sun".

### Fixed

- After a dark-site sky, the dark-sky shader variant was kept for good: the
  light pollution eases back toward 6 and only ever approaches it, so a
  plain suburban sky went on paying for the Milky Way's grids.

- **A fair sky's cumulus is white again, not a camouflage print.** Since
  cumulus got a top and a base (0.4.0), its shaded base read the whole
  footprint — wider than the sunlit crown — and a skirt of translucent veil
  beyond that, and every lump's opacity was scaled by the amount of cumulus,
  so a fair sky's bases came out 60% opaque: muddy grey-blue patches among
  small white tops. The crown now takes the full footprint and the base
  only the denser cores inside it, the veil's skirt is short, the amount
  sets how much of the sky the lumps cover rather than how solid each is,
  and the base is a light grey only under a thick core.
- **Cloud cover means cover again for cumulus.** Derived from `cloudCover`,
  cumulus reached its ceiling by a cover of 0.35, and a full cumulus field
  covers about 80% of the sky: the `summer` preset, reported at 0.38, came
  out nine tenths cloud. Cumulus now follows the cover — a cumulus amount
  covers about itself less a fifth of the sky — so `fair` (0.22) is drawn
  about 23% cloudy and `summer` shows its blue between the lumps.

## 0.4.1 — 2026-10-11

A renderer used on its own draws again, and the snow falls.

### Fixed

- **`AtmosphereRenderer` used on its own got to `onReady` again.** Since
  0.4.0 the shader is compiled per combination of features, and nothing is
  compiled until a frame or `prepare()` says which one — so a renderer that
  waited for `onReady` before its first `render()` waited for good. If a turn
  passes with no word, it now compiles the program with every feature, which
  can draw any state. Until a frame's own variant is linked, a renderer that
  has drawn nothing yet also draws with any linked variant that covers it,
  instead of nothing. The site's gallery was blank because of this.
- **Snow falls instead of blinking.** The flakes are drawn from a thin shell
  of a 3D lattice around the eye, and falling straight down while the view
  looked up carried them through it: the fine snow lived for a fifth of a
  second and twinkled. They now fall square to the view across the middle
  of the frame (integrated on the CPU, so turning the camera never jumps
  them), and a far layer crosses the view at a speed that goes with its
  size — parallax — rather than outrunning it. Measured as how much of the
  snowfall is still there, moved, a tenth of a second later: 0.09–0.43
  before, 0.45–0.54 now.
- **Snowflakes are round.** A flake wider than its lattice cell was cut off
  square where the cell ended. The near layers now search the 2×2×2 block of
  cells around each pixel (skipping the ones too far to hold a flake it
  could draw) and take bigger cells, so a flake is whole at the same size.
  A snowy 1080p frame costs about 2 ms more on an M2 Max.

## 0.4.0 — 2026-10-11

The rest of the sky. The moon stands where it is and shows its phase; the sea
can lie below the horizon; aurora, halos, rainbows, the bolt, fireballs, the
zodiacal light, contrails and crepuscular rays join the weather. Measured
against photographs, the sunset gets its gradient and a dial for how hard it
burns, cumulus gets a top and a base, and the shader is compiled per
combination of features in use, so a clear noon costs less than before.

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
- **`sunset`** — how hard the sky burns: `warmth` for the band on the
  sun's side (its strength, its red, how high it climbs, and the color of
  the sun's light on the clouds) and `glow` for what the rest of the sky
  takes at magic hour (the pink of the far side and the lavender above the
  band). Both 0..2, both 1 by default. Sliders in the controller.
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

- **The sunset has its gradient.** Measured against photographs of real
  skies, every sunset came out the same salmon: daylight was a quarter of noon by the time the
  sun touched the horizon, one orange was laid over the whole lower sky, the
  far side included, with a mauve over the rest, and the clouds took one
  pink. Now daylight falls away slowly through twilight (three fifths at
  sunset, a fifth at civil dusk, gone by nautical, with the stars keeping to
  a deeper night of their own); toward the sun the horizon goes red, orange,
  yellow up into a zenith that stays blue, the band climbing as the sun
  sinks and collapsing to a rim once it is well under, while the far side
  stays cool for the Earth's shadow; the clouds lose their direct sun layer
  by layer — the low deck going grey while the high clouds still burn — and
  what sun still reaches them is redder; and the disc at the horizon is an
  orange you can look at rather than a white you cannot. Every hour from
  golden hour to dusk moved; noon is untouched.
- **Cumulus has a top and a base.** A cumulus is a column on a flat base,
  and seen from below it is two things: a dark flat underside and a sunlit
  crown showing past it. One plane could not be both, and the layer read as
  a textured sheet. The same field is read on two planes now — the base,
  and a plane a third higher where only the denser cores reach — and
  composited top first, base last. Overhead the base covers the crown but
  for a lit rim; toward the horizon the crown stands clear above a grey
  bottom. The parallax between the planes is what gives a lump its side.
  Costs the cumulus layer about two thirds more.
- **Clouds gather.** A noise field cut at one threshold peppers the sky
  evenly; a real sky's clouds come in flocks, with bare stretches between.
  A much coarser field now moves the cumulus threshold around the sky,
  denser in some quarters and sparser in others, fading out as the cover
  closes into a deck.
- **Cirrus comes in tufts.** Mare's tails: dense heads where the ice forms,
  with fibrous tails streaming downwind from them, in place of strands all
  of one weight.
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
