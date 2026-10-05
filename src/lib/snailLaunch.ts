/** One animation clock for the static boot cover and all pre-app React loading stages. */
let startedAt: number | undefined

function arrival(svg: Element) {
  return svg.getAnimations?.().find(animation => (animation as CSSAnimation).animationName?.endsWith('-arrival'))
}

function duration(svg: Element) {
  // The bundled SVG owns this value, in milliseconds, along with the keyframes it times.
  return Number.parseFloat(getComputedStyle(svg).getPropertyValue('--snail-arrival-duration')) || 0
}

function elapsed(svg: Element) {
  if (startedAt === undefined) {
    // An ended one-shot's clock stops at 630 ms. The shell loop keeps the full launch
    // time, including its initial delay, so a slow boot must take its clock from there.
    const loop = svg.getAnimations?.({ subtree: true }).find(animation => (animation as CSSAnimation).animationName?.endsWith('-shell'))
    const time = (loop ?? arrival(svg))?.currentTime
    startedAt = performance.now() - (typeof time === 'number' ? time : 0)
  }
  return Math.max(0, performance.now() - startedAt)
}

/** Keep the static cover until the entrance is visible in full, even on a cached launch.
 * Boot requests/chunks are already running; only React's replacement of the cover waits.
 * Reduced motion needs no hold, and missing/cancelled animations must never wedge startup. */
export async function waitForSnailArrival() {
  const svg = document.querySelector('.boot-splash .firefighter-snail')
  if (!svg || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  // Let the browser establish the CSS animation's start time before reading its clock.
  // A hidden document may not receive rAF, so this first-frame wait is bounded too.
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 50)
    requestAnimationFrame(() => { clearTimeout(timer); resolve() })
  })
  const remaining = Math.max(0, duration(svg) - elapsed(svg))
  if (!remaining) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, remaining + 50)
    const done = () => { clearTimeout(timer); resolve() }
    arrival(svg)?.finished.then(done, done)
  })
}

/** Continue before paint so a remount cannot replay the entrance or reset the idle. */
export function continueSnailAnimation(svg: Element, idleOnly = false) {
  const time = idleOnly ? duration(svg) : elapsed(svg)
  svg.getAnimations?.({ subtree: true }).forEach(animation => { animation.currentTime = time })
}
