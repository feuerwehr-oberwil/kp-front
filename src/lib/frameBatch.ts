/**
 * Runs `step` at most once per animation frame, however often `schedule` is called before it,
 * so the input events of one frame act as one – the two pointers' moves of one touch sample
 * (`admin/FloorPackEditor · usePan`). `flush` runs a waiting step at once, for when its inputs
 * are about to change (a pointer comes or goes). Create it once per gesture owner, not per render.
 */
export function frameBatch(step: () => void): { schedule: () => void; flush: () => void } {
  let frame = 0
  const run = () => { frame = 0; step() }
  return {
    schedule: () => { if (!frame) frame = requestAnimationFrame(run) },
    flush: () => { if (frame) { cancelAnimationFrame(frame); run() } },
  }
}
