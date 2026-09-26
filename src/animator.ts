// animator.ts — following a target state, and integrating wind / cloud shape evolution
//
// Independent of the renderer (no DOM dependency), so it can be used from any
// custom render loop.

import { CLOUD_GENERA_IDS } from './clouds.js';
import type { AtmosphereState } from './state.js';

export interface AnimatorOptions {
  /** time constant of the following, in seconds. Larger = weather changes arrive more slowly */
  tau?: number;
  /** wind's base speed, and its acceleration from strong wind */
  windBase?: number;
  windGust?: number;
  /** cloud shape evolution's base speed, and its acceleration from strong wind */
  evoBase?: number;
  evoGust?: number;
  /** wind/evolution offset added per hour that the time of day advances */
  windPerHour?: number;
  evoPerHour?: number;
}

const DEFAULTS: Required<AnimatorOptions> = {
  tau: 2.2,
  // keep translation subtle; let shape change in place (evo) carry the motion
  windBase: 0.006,
  windGust: 0.22,
  evoBase: 0.07,
  evoGust: 0.09,
  windPerHour: 0.25,
  evoPerHour: 0.06,
};

const TAU_2PI = Math.PI * 2;

/**
 * Deep-copy the state's nested parts (including `filter.tint`, which is an
 * array). `current` is mutated in place every frame, so sharing any of these
 * with the caller's target would make the target drift along with it.
 */
function copyNested(s: AtmosphereState): Pick<AtmosphereState, 'filter' | 'tone' | 'polarizer' | 'celestial' | 'lens' | 'particles' | 'clouds' | 'features'> {
  return {
    filter: { ...s.filter, tint: [s.filter.tint[0], s.filter.tint[1], s.filter.tint[2]] },
    tone: { ...s.tone },
    polarizer: { ...s.polarizer },
    celestial: { ...s.celestial, radiant: s.celestial.radiant ? [s.celestial.radiant[0], s.celestial.radiant[1]] : null },
    lens: { ...s.lens },
    particles: { ...s.particles },
    clouds: { ...s.clouds },
    features: { ...s.features },
  };
}

/** Interpolate a circular quantity along its shorter arc (so 23:00→01:00 doesn't wrap the long way) */
export function lerpWrapped(from: number, to: number, k: number, period: number): number {
  const half = period / 2;
  const d = ((to - from + period * 1.5) % period) - half;
  return (from + d * k + period) % period;
}

export class StateAnimator {
  /** the current (interpolated) state. Pass this to renderer.render every frame */
  readonly current: AtmosphereState;

  /**
   * Wind and shape evolution advance by integrating "speed × dt".
   * That keeps the integrated offset continuous even when the weather
   * changes and the speed changes with it, so the clouds never jump.
   */
  private windOff = 41.7;   // arbitrary seed, just to avoid starting at the origin
  private evoOff = 7.3;
  private readonly opts: Required<AnimatorOptions>;

  constructor(initial: AtmosphereState, options: AnimatorOptions = {}) {
    this.current = { ...initial, ...copyNested(initial) };
    this.opts = { ...DEFAULTS, ...options };
  }

  get wind(): number { return this.windOff; }
  get evolution(): number { return this.evoOff; }

  /** Jump straight to the target, with no transition */
  jump(target: AtmosphereState): void {
    Object.assign(this.current, target, copyNested(target));
  }

  /** Advance one frame. `dt` is in seconds */
  step(target: AtmosphereState, dt: number): void {
    const o = this.opts;
    const c = this.current;
    const k = 1 - Math.exp(-dt / o.tau);

    const beforeTod = c.timeOfDay;
    c.timeOfDay = lerpWrapped(c.timeOfDay, target.timeOfDay, k, 24);
    // how far the time of day advanced this frame (hours) — used to drive cloud drift
    const todStep = ((c.timeOfDay - beforeTod + 36) % 24) - 12;

    c.sunElevation += (target.sunElevation - c.sunElevation) * k;
    c.sunAzimuth = lerpWrapped(c.sunAzimuth, target.sunAzimuth, k, TAU_2PI);

    c.cloudCover += (target.cloudCover - c.cloudCover) * k;
    // follow each cloud genus independently, so a cumulus sky settling into a
    // stratocumulus sky reads as "the billowing lumps flattening out"
    for (const g of CLOUD_GENERA_IDS) {
      c.clouds[g] += (target.clouds[g] - c.clouds[g]) * k;
    }
    c.features.anvil += (target.features.anvil - c.features.anvil) * k;
    c.features.velum += (target.features.velum - c.features.velum) * k;
    c.rain += (target.rain - c.rain) * k;
    c.snow += (target.snow - c.snow) * k;
    c.wind += (target.wind - c.wind) * k;
    c.thunder += (target.thunder - c.thunder) * k;
    c.haze += (target.haze - c.haze) * k;

    // transition the filter too (colors blend, so sepia → cyanotype connects smoothly)
    const f = c.filter, tf = target.filter;
    f.amount += (tf.amount - f.amount) * k;
    f.saturation += (tf.saturation - f.saturation) * k;
    f.lift += (tf.lift - f.lift) * k;
    f.tint = [
      f.tint[0] + (tf.tint[0] - f.tint[0]) * k,
      f.tint[1] + (tf.tint[1] - f.tint[1]) * k,
      f.tint[2] + (tf.tint[2] - f.tint[2]) * k,
    ];

    // the tone curve transitions too, so a scene cut can ride an exposure ramp
    const tn = c.tone, tt = target.tone;
    tn.exposure += (tt.exposure - tn.exposure) * k;
    tn.contrast += (tt.contrast - tn.contrast) * k;
    tn.knee += (tt.knee - tn.knee) * k;
    tn.bleach += (tt.bleach - tn.bleach) * k;

    const pz = c.polarizer, pt = target.polarizer;
    pz.strength += (pt.strength - pz.strength) * k;
    pz.saturation += (pt.saturation - pz.saturation) * k;
    pz.stopLoss += (pt.stopLoss - pz.stopLoss) * k;
    // a polarizer repeats every 180°, so rotate along the shorter arc over PI —
    // otherwise turning past the axis unwinds the long way round
    pz.angle = lerpWrapped(pz.angle, pt.angle, k, Math.PI);

    const ce = c.celestial, ct = target.celestial;
    ce.bortle += (ct.bortle - ce.bortle) * k;
    ce.milkyWay += (ct.milkyWay - ce.milkyWay) * k;
    ce.meteors += (ct.meteors - ce.meteors) * k;
    // the radiant is a place, not a quantity — sliding it would drag every
    // meteor's origin across the sky mid-shower. Cut to the new one instead
    ce.radiant = ct.radiant ? [ct.radiant[0], ct.radiant[1]] : null;

    // switching the droplets off lets the ones already on the glass dry away
    // rather than vanish between two frames
    c.lens.droplets += (target.lens.droplets - c.lens.droplets) * k;
    // and the rain or snow thins out rather than stopping dead
    c.particles.precipitation += (target.particles.precipitation - c.particles.precipitation) * k;

    // real elapsed time, plus however much the time of day moved
    // (clouds should have drifted by however much time passed)
    this.windOff += (o.windBase + c.wind * o.windGust) * dt
                  + Math.abs(todStep) * o.windPerHour;
    this.evoOff += (o.evoBase + c.wind * o.evoGust) * dt
                 + Math.abs(todStep) * o.evoPerHour;
  }
}
