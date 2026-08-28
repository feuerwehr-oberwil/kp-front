// prefers-reduced-motion for the motions CSS can't guard: MapLibre camera flights and
// programmatic scrolls. Queried live per call — matchMedia is cheap at interaction
// frequency, and no listener/state means the OS toggle takes effect on the next gesture.

/** Animation duration honouring reduced motion: 0 (MapLibre = instant jump) when reduced, else ms. */
export function motionDuration(ms: number): number {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return ms
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms
}

/** Scroll behaviour honouring reduced motion: 'auto' when reduced, else 'smooth'. */
export function scrollBehavior(): ScrollBehavior {
  return !prefersReducedMotion() ? 'smooth' : 'auto'
}

/** For call sites whose normal-motion duration is MapLibre's own computed default: they can't
 *  pass motionDuration(ms) without changing that default, so they branch on this instead. */
export function prefersReducedMotion(): boolean {
  return motionDuration(1) === 0
}
