// «Do this once the device has nothing better to do» — for work that must not compete with
// first paint or a gesture but should be done before anyone asks for it: prefetching a lazy
// surface's chunk, parsing a reference dataset (perf sweep 23.09.2026).
//
// `requestIdleCallback` where the browser has it, with a `timeout` so a device that is never
// idle (a busy map, a 1 Hz Atemschutz clock) still gets there; a plain timer where it does not
// (WebKit has long lacked it, and the fleet's iPads are WebKit whatever the browser's name).

type IdleWindow = {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

/** Run `task` when the main thread is idle, at the latest after `timeoutMs`. Returns a cancel. */
export function whenIdle(task: () => void, timeoutMs = 2_000): () => void {
  const w = (typeof window === 'undefined' ? {} : window) as IdleWindow
  if (w.requestIdleCallback && w.cancelIdleCallback) {
    const handle = w.requestIdleCallback(task, { timeout: timeoutMs })
    return () => w.cancelIdleCallback?.(handle)
  }
  // No rIC: a short timer still lets the current frame (and the one after it) paint first.
  const timer = setTimeout(task, Math.min(timeoutMs, 600))
  return () => clearTimeout(timer)
}
