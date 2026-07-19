import { useCallback, useEffect, useRef } from 'react'

/**
 * Press-and-hold a stepper button (+/−) to repeat the step at a steady, gently accelerating pace —
 * so adjusting Drehung / Stockwerk / Druck doesn't mean tapping dozens of times. A plain tap still
 * fires exactly once (the first step is immediate). Keyboard Enter/Space step once (and repeat via
 * the OS key-repeat).
 *
 * The stop listener is on `window`, so a hold is always released even if the button disables
 * mid-hold (e.g. the value hits its min/max and the button greys out) — no runaway timer.
 */
export function useHoldRepeat(
  step: () => void,
  opts?: { delayMs?: number; intervalMs?: number; minIntervalMs?: number },
) {
  const delay = opts?.delayMs ?? 350
  const interval = opts?.intervalMs ?? 110
  const minInterval = opts?.minIntervalMs ?? 45
  // keep the LATEST step closure: a relative stepper (floor/rotation/pressure) reads the current
  // value from its closure, so each repeat must call the freshest one or it wouldn't accumulate
  const stepRef = useRef(step)
  stepRef.current = step
  const timers = useRef<{ start: ReturnType<typeof setTimeout> | null; repeat: ReturnType<typeof setTimeout> | null }>({ start: null, repeat: null })

  const stop = useCallback(() => {
    if (timers.current.start) { clearTimeout(timers.current.start); timers.current.start = null }
    if (timers.current.repeat) { clearTimeout(timers.current.repeat); timers.current.repeat = null }
    window.removeEventListener('pointerup', stop)
    window.removeEventListener('pointercancel', stop)
  }, [])

  useEffect(() => stop, [stop]) // clear any pending timers on unmount

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button) return // primary button / touch / pen only
    stepRef.current() // immediate first step so a quick tap works without waiting
    let curr = interval
    const tick = () => {
      stepRef.current()
      curr = Math.max(minInterval, curr - 8) // gentle acceleration
      timers.current.repeat = setTimeout(tick, curr)
    }
    timers.current.start = setTimeout(tick, delay)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stepRef.current() }
  }

  return { onPointerDown, onKeyDown }
}
