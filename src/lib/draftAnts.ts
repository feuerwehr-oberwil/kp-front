// The open draft's marching dashes on the Lage (27.10.2026). MapLibre cannot animate a dash
// offset, so the dash pattern itself steps through one period — MapLibre's own «animate a line»
// recipe. Every step repaints the whole map (basemap, labels, every layer), which is why the
// march is as slow as it can be and stands still under a finger (perf sweep 09.11.2026). The Plan
// marches its dashes in CSS at the same cadence and stands still the same way (useDraftAntsHold,
// perf sweep 26.11.2026).
import { useEffect, type RefObject } from 'react'

/** One period of the march in half-unit steps: a dash of 3, a gap of 4. */
export const DRAFT_ANTS: number[][] = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5], [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0],
  [0, 0.5, 3, 3.5], [0, 1, 3, 3], [0, 1.5, 3, 2.5], [0, 2, 3, 2], [0, 2.5, 3, 1.5], [0, 3, 3, 1], [0, 3.5, 3, 0.5],
]
/** The cadence, and how many frames one tick advances. The pace is the original one (one frame
 *  per 60 ms); only the repaints are a third of what they were. */
export const DRAFT_ANTS_TICK_MS = 180
export const DRAFT_ANTS_STEP = 3

/**
 * Follow the pointers down inside `surface` and call `onChange` when the first goes down and when
 * the last comes up (or is cancelled) – anywhere, since a captured pointer ends outside it.
 * Capture phase: a marker or vertex that stops the event for its own drag still counts. Returns
 * the stop.
 */
export function watchPointerHold(surface: HTMLElement, onChange: (held: boolean) => void): () => void {
  const held = new Set<number>()
  const down = (e: PointerEvent) => {
    held.add(e.pointerId)
    if (held.size === 1) onChange(true)
  }
  const up = (e: PointerEvent) => {
    if (held.delete(e.pointerId) && held.size === 0) onChange(false)
  }
  surface.addEventListener('pointerdown', down, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', up, true)
  return () => {
    surface.removeEventListener('pointerdown', down, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', up, true)
  }
}

/**
 * March the dashes: hand `paint` the next pattern every DRAFT_ANTS_TICK_MS. While a pointer is
 * down inside `surface` (the map's container: a pan, a vertex in the hand, the stroke being
 * drawn) the march stands still, so the repaint does not compete with the gesture; it goes on
 * from where it stood once every pointer is up. Returns the stop.
 */
export function marchDraftAnts(surface: HTMLElement, paint: (dash: number[]) => void): () => void {
  let held = false
  const stopHold = watchPointerHold(surface, (h) => { held = h })
  let frame = 0
  const timer = window.setInterval(() => {
    if (held) return
    frame = (frame + DRAFT_ANTS_STEP) % DRAFT_ANTS.length
    paint(DRAFT_ANTS[frame])
  }, DRAFT_ANTS_TICK_MS)
  return () => {
    window.clearInterval(timer)
    stopHold()
  }
}

/**
 * The Plan's twin. Its dashes march in CSS (09-whiteboard · .wb-draft-open, the same cadence);
 * this marks the layer at `ref` `.held` while a pointer is down on its board (the closest
 * `.wb-canvas`), which pauses the march there. `:active` does not do it: under touch with
 * pointer capture it lets go mid-drag. Only while `marching`.
 */
export function useDraftAntsHold(ref: RefObject<Element | null>, marching: boolean) {
  useEffect(() => {
    const layer = ref.current
    const surface = layer?.closest<HTMLElement>('.wb-canvas')
    if (!marching || !layer || !surface) return
    const stop = watchPointerHold(surface, (held) => { layer.classList.toggle('held', held) })
    return () => {
      stop()
      layer.classList.remove('held')
    }
  }, [ref, marching])
}
