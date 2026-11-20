// World-fixed accents in radians, using the camera's north/east convention.
export interface SkyPlacement {
  azimuth: number;
  elevation?: number;
  /** Angular radius in radians. */
  radius?: number;
  strength?: number;
}

export interface SceneryInput {
  /** A distant lighthouse. Elevation locates its lantern above the horizon. */
  lighthouse?: SkyPlacement;
  /** Up to two warm horizon lights, in stable slot order. */
  lights?: readonly SkyPlacement[];
  /** Up to two cloud banks with fixed centers and evolving edges. */
  clouds?: readonly SkyPlacement[];
}

type Placement = Required<SkyPlacement>;
export interface Scenery {
  lighthouse: Placement;
  lights: Placement[];
  clouds: Placement[];
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value!)) : fallback;
}

function placement(p: SkyPlacement | undefined, elevation: number, radius: number, maxRadius: number): Placement {
  return {
    azimuth: Number.isFinite(p?.azimuth) ? p!.azimuth % (2 * Math.PI) : 0,
    elevation: bounded(p?.elevation, elevation, 0, Math.PI / 2),
    radius: bounded(p?.radius, radius, 0.001, maxRadius),
    strength: p ? bounded(p.strength, 1, 0, 1) : 0,
  };
}

export function resolveScenery(input?: SceneryInput | null): Scenery | undefined {
  if (!input) return undefined;
  return {
    lighthouse: placement(input.lighthouse, 0.075, 0.005, 0.04),
    lights: [0, 1].map(i => placement(input.lights?.[i], 0.025, 0.008, 0.1)),
    clouds: [0, 1].map(i => placement(input.clouds?.[i], 0.25, 0.16, 1)),
  };
}

export function copyScenery(s?: Scenery): Scenery | undefined {
  return s && { lighthouse: { ...s.lighthouse }, lights: s.lights.map(p => ({ ...p })), clouds: s.clouds.map(p => ({ ...p })) };
}

function follow(p: Placement, target: Placement | undefined, k: number): boolean {
  if (target && target.strength > 0) {
    if (p.strength === 0) {
      Object.assign(p, target, { strength: 0 });
    } else {
      const delta = target.azimuth - p.azimuth;
      p.azimuth += Math.atan2(Math.sin(delta), Math.cos(delta)) * k;
      p.elevation += (target.elevation - p.elevation) * k;
      p.radius += (target.radius - p.radius) * k;
    }
  }
  p.strength += ((target?.strength ?? 0) - p.strength) * k;
  if (!target?.strength && p.strength < 0.001) p.strength = 0;
  return p.strength > 0;
}

export function followScenery(current: Scenery | undefined, target: Scenery | undefined, k: number): Scenery | undefined {
  if (!current && !target) return undefined;
  const s = current ?? resolveScenery({})!;
  let visible = follow(s.lighthouse, target?.lighthouse, k);
  for (let i = 0; i < 2; i++) {
    visible = follow(s.lights[i], target?.lights[i], k) || visible;
    visible = follow(s.clouds[i], target?.clouds[i], k) || visible;
  }
  return visible || target ? s : undefined;
}
