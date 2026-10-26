/**
 * One animation clock for the static boot cover and all pre-app React loading stages.
 * An automatic worker-update reload carries it through sessionStorage, written only as the
 * reload commits. index.html consumes that one-shot before paint and seeds this page's clock;
 * ordinary opens/reloads still show the entrance. Keep its key/shape in sync with that script.
 */
let startedAt: number | undefined

/** Preserve the visible launch through an automatic update, including its reload watchdog. */
export function rememberSnailLaunch() {
  try {
    const svg = document.querySelector('.boot-splash .firefighter-snail')
    if (startedAt === undefined && !svg) return
    const time = startedAt === undefined && svg ? elapsed(svg, false) : Math.max(0, performance.now() - (startedAt ?? 0))
    sessionStorage.setItem('kp-snail-resume', JSON.stringify({ at: Date.now(), elapsed: time }))
  } catch { /* storage unavailable — the update must still proceed */ }
}

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
    // The static cover may already be continuing a previous page's clock via negative CSS
    // delays. Its new animation.startTime alone would lose that offset and replay in React.
    const resumed = Number(svg.getAttribute('data-snail-offset'))
    const offset = Number.isFinite(resumed) ? Math.max(0, resumed) : 0
    const clock = launchClock(svg)
    // ⚠️ The animation's `startTime`, not `now - currentTime`: `currentTime` is the clock of the
    // LAST frame and stands still until the next one, so on a loaded device that placed the zero
    // too late by however long the frame was overdue and React rewound its copy of the entrance
    // (609 ms instead of ≥ 630 ms at the handover, 08.10.2026). `startTime` shares
    // `performance.now()`'s origin and stays fixed once the animation runs. Only a launch without
    // one (no animation API, or still pending before its first frame) falls back.
    if (typeof clock?.startTime === 'number') start = clock.startTime
    else start = performance.now() - (typeof clock?.currentTime === 'number' ? clock.currentTime : 0)
    start -= offset
    // A pending animation gets its start time with a coming frame: settle only when asked.
    if (settle || typeof clock?.startTime === 'number') startedAt = start
  }
  return Math.max(0, performance.now() - start)
}

/** How long the hold waits for the cover's first frame, the zero of the entrance's clock. A
 *  visible page renders long before this; it only bounds a renderer that sends no frames. */
export const FIRST_FRAME_MAX_MS = 1_000

/** The next frame, or `bound` ms, whichever comes first: a hidden document gets no rAF. */
function nextFrame(bound: number) {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, Math.max(0, bound))
    requestAnimationFrame(() => { clearTimeout(timer); resolve() })
  })
}

/** Keep the static cover until the entrance is visible in full, even on a cached launch.
 * Boot requests/chunks are already running; only React's replacement of the cover waits.
 * Reduced motion needs no hold, and missing/cancelled animations must never wedge startup. */
export async function waitForSnailArrival() {
  const svg = document.querySelector('.boot-splash .firefighter-snail')
  if (!svg || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  // ⚠️ The entrance starts with the cover's FIRST FRAME, not when this runs. WebKit can hold
  // that frame back well past the boot work: CI 09.10.2026 (run 37929169733) asked for a frame
  // at 145 ms and got it at 290-440 ms, and until then the SVG had no animation at all. The old
  // 50 ms wait then timed the hold from «now» and React took the cover over 12-170 ms before the
  // skid ended (clock 459-618 of 630 ms). So wait for the arrival's start time, frame by frame:
  // after a frame without an arrival there is none to wait for (no CSS), and a renderer that
  // sends no frames is bounded. A hidden document gets no frames, so it keeps the short wait.
  if (document.visibilityState === 'hidden') await nextFrame(50)
  else {
    const deadline = performance.now() + FIRST_FRAME_MAX_MS
    let frames = 0
    while (performance.now() < deadline) {
      const clock = arrival(svg)
      if (typeof clock?.startTime === 'number' || (frames > 0 && !clock)) break
      await nextFrame(deadline - performance.now())
      frames++
    }
  }
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
