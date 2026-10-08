/** One animation clock for the static boot cover and all pre-app React loading stages. */
let startedAt: number | undefined

function arrival(svg: Element) {
  return svg.getAnimations?.().find(animation => (animation as CSSAnimation).animationName?.endsWith('-arrival'))
}

function duration(svg: Element) {
  // The bundled SVG owns this value, in milliseconds, along with the keyframes it times.
  return Number.parseFloat(getComputedStyle(svg).getPropertyValue('--snail-arrival-duration')) || 0
}

/** The launch clock: the shell loop keeps the full launch time, including its initial delay,
 * while an ended one-shot's clock stops at 630 ms, so a slow boot must read the loop. */
function launchClock(svg: Element) {
  return svg.getAnimations?.({ subtree: true }).find(animation => (animation as CSSAnimation).animationName?.endsWith('-shell')) ?? arrival(svg)
}

/** Time since the launch clock's zero. `settle` fixes that zero for every later loader. */
function elapsed(svg: Element, settle = true) {
  let start = startedAt
  if (start === undefined) {
    const clock = launchClock(svg)
    // ⚠️ The animation's `startTime`, not `now - currentTime`: `currentTime` is the clock of the
    // LAST frame and stands still until the next one, so on a loaded device that placed the zero
    // too late by however long the frame was overdue and React rewound its copy of the entrance
    // (609 ms instead of ≥ 630 ms at the handover, 08.10.2026). `startTime` shares
    // `performance.now()`'s origin and stays fixed once the animation runs. Only a launch without
    // one (no animation API, or still pending before its first frame) falls back.
    if (typeof clock?.startTime === 'number') start = clock.startTime
    else start = performance.now() - (typeof clock?.currentTime === 'number' ? clock.currentTime : 0)
    // A pending animation gets its start time with a coming frame: settle only when asked.
    if (settle || typeof clock?.startTime === 'number') startedAt = start
  }
  return Math.max(0, performance.now() - start)
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
  const remaining = Math.max(0, duration(svg) - elapsed(svg, false))
  if (!remaining) return void elapsed(svg)
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, remaining + 50)
    const done = () => { clearTimeout(timer); resolve() }
    arrival(svg)?.finished.then(done, done)
  })
  // Fix the launch clock while the cover still exists: React's copy continues it.
  elapsed(svg)
}

/** Continue before paint so a remount cannot replay the entrance or reset the idle. */
export function continueSnailAnimation(svg: Element, idleOnly = false) {
  const time = idleOnly ? duration(svg) : elapsed(svg)
  svg.getAnimations?.({ subtree: true }).forEach(animation => { animation.currentTime = time })
}
