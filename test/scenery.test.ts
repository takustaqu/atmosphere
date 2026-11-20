import { expect, it } from 'vitest';
import { StateAnimator } from '../src/animator.js';
import { FEATURE, featureKey } from '../src/features.js';
import { resolveConditions } from '../src/state.js';

it('places a new light at its bearing, crosses north, then fades out its shader block', () => {
  const clear = resolveConditions({});
  const animator = new StateAnimator(clear, { tau: 1 });
  const lightAt = (azimuth: number) => resolveConditions({ scenery: { lights: [{ azimuth }] } });
  const first = lightAt(-0.1);
  animator.step(first, 0.5);
  expect(animator.current.scenery!.lights[0].azimuth).toBe(-0.1);
  expect(animator.current.scenery!.lights[0].strength).toBeLessThan(1);
  expect(first.scenery!.lights[0].strength).toBe(1);
  animator.step(lightAt(0.1), Math.log(2));
  expect(animator.current.scenery!.lights[0].azimuth).toBeCloseTo(0);
  animator.step(clear, 0.5);
  expect(featureKey(animator.current) & FEATURE.SCENERY).toBeTruthy();
  animator.step(clear, 10);
  expect(featureKey(animator.current) & FEATURE.SCENERY).toBe(0);
});
