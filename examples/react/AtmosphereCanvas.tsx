// AtmosphereCanvas — a sample for mounting atmosphere from React
//
// It just does "put down a canvas, mount an Atmosphere, and pipe prop changes
// into set()". Every app has its own conventions (how it fades to black, how
// it layers the canvas), so if you don't like this one, copying the whole
// file and rewriting it is the fastest path.

import { useEffect, useRef, useState } from 'react';
import { Atmosphere, type AtmosphereOptions, type Conditions } from '../../src/index.js';

// value equality for condition props (plain data: primitives, Date, arrays,
// plain objects). Conditions are usually written as inline literals —
// `camera={{ yaw: Math.PI }}` — which are a fresh identity every render, so
// an identity-based effect would call set() each render for no change.
function conditionsEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((v, i) => conditionsEqual(v, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) =>
    conditionsEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** keep the previous reference as long as the value is unchanged */
function useStableValue<T>(value: T): T {
  const ref = useRef(value);
  if (!conditionsEqual(ref.current, value)) ref.current = value;
  return ref.current;
}

export interface AtmosphereCanvasProps extends Conditions {
  /**
   * pass false to fade to black (drawing also stops once the fade completes,
   * to let the GPU rest).
   *
   * The canvas also stays faded out until the shader has compiled, so `true`
   * means "as soon as there is a sky", not "now".
   */
  enabled?: boolean;
  /**
   * Frame rate cap.
   *
   * Read once, when the Atmosphere is constructed. Later changes are ignored —
   * rebuild the component with a `key` to apply a new value.
   */
  fps?: number;
  /**
   * Internal resolution multiplier.
   *
   * Init-only, like {@link AtmosphereCanvasProps.fps}.
   */
  resolutionScale?: number;
  /** length of the fade-to-black CSS transition, in ms. Drawing stops once this elapses */
  fadeMs?: number;
  /**
   * Tuning for following / wind / shape evolution.
   *
   * Init-only, like {@link AtmosphereCanvasProps.fps}. It is also compared by
   * identity nowhere at all, so an inline object literal is harmless here.
   */
  animator?: AtmosphereOptions['animator'];
  /**
   * Measure the sky's light for whatever is drawn in front of it.
   *
   * Init-only, like {@link AtmosphereCanvasProps.fps}.
   */
  lightProbe?: AtmosphereOptions['lightProbe'];
  /**
   * Receives each light measurement — see `Atmosphere.light`. The latest
   * function is always the one called, so an inline arrow is fine.
   */
  onLight?: AtmosphereOptions['onLight'];
  /** class name appended to the default "atmo-canvas" */
  className?: string;
}

export function AtmosphereCanvas({
  time: timeProp, location: locationProp, weather: weatherProp,
  filter: filterProp, lens: lensProp, particles: particlesProp, camera: cameraProp,
  enabled = true,
  fps = 30,
  resolutionScale,
  fadeMs = 1600,
  animator,
  lightProbe,
  onLight,
  className,
}: AtmosphereCanvasProps) {
  // compare conditions by value, so inline literals (`camera={{ ... }}`)
  // don't trigger a set() on every render
  const time = useStableValue(timeProp);
  const location = useStableValue(locationProp);
  const weather = useStableValue(weatherProp);
  const filter = useStableValue(filterProp);
  const lens = useStableValue(lensProp);
  const particles = useStableValue(particlesProp);
  const camera = useStableValue(cameraProp);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const skyRef = useRef<Atmosphere | null>(null);
  // The shader compiles off the main thread, so the canvas is blank for the
  // first moment — seconds of it, on a Windows machine's first ever visit.
  // Hold it behind the same fade `enabled` uses, and let whatever is behind it
  // show through until there is a sky to cross over to. Stays false for good
  // if the device could not compile the shader at all.
  const [ready, setReady] = useState(false);
  // read the initial values via a ref so they aren't re-read on remount
  const initRef = useRef({ time, location, weather, filter, lens, particles, camera, fps, resolutionScale, animator, lightProbe });
  // read through a ref, so a new callback each render never rebuilds the sky
  const onLightRef = useRef(onLight);
  onLightRef.current = onLight;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sky = new Atmosphere(canvas, {
      ...initRef.current,
      onReady: setReady,
      onLight: (light) => onLightRef.current?.(light),
    });
    skyRef.current = sky;
    // not resetting `ready` here on purpose: the canvas keeps its context
    // across a remount, so the program is still linked and the sky is still
    // there. Clearing it would fade the sky out and back in under StrictMode.
    return () => { skyRef.current = null; sky.dispose(); };
  }, []);

  useEffect(() => {
    skyRef.current?.set({ time, location, weather, filter, lens, particles, camera });
  }, [time, location, weather, filter, lens, particles, camera]);

  // leave the fade to CSS, and stop drawing once it's no longer visible
  useEffect(() => {
    const sky = skyRef.current;
    if (!sky) return;
    if (enabled) { sky.start(); return; }
    const id = setTimeout(() => sky.stop(), fadeMs);
    return () => clearTimeout(id);
  }, [enabled, fadeMs]);

  return (
    <canvas
      className={['atmo-canvas', enabled && ready ? null : 'atmo-off', className]
        .filter(Boolean).join(' ')}
      ref={canvasRef}
      aria-hidden="true"
    />
  );
}
