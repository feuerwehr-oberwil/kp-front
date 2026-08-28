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
  return motionDuration(1) === 0 ? 'auto' : 'smooth'
}
