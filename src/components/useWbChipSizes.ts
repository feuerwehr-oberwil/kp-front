/**
 * The RENDERED size of each Trupp chip on a Plan, for the line resolver (11.10.2026).
 *
 * A Leitung docked onto a chip ends at the chip's edge (Whiteboard · objectPoint), and that edge
 * used to be a guessed 76×44 box. The real chip is a strip whose width is its NAME (plus the
 * storey badge), and selecting it swaps in the two-row pill under a 1.12 scale — so an arrow
 * resolved against the guess ended on top of «Müller H.» (owner's screenshot, Gebäude view). The
 * chip now reports what it actually is: one ResizeObserver, one stable callback ref (the chip's
 * id rides on `data-chip-id`), and a state update only when a size really changed, so a quiet
 * board never re-renders for it.
 *
 * Sizes are LAYOUT px (`offsetWidth`/`offsetHeight`, which ignore transforms) — the same px the
 * board positions in, at every zoom, because zoom here is layout (09-whiteboard.css). The caller
 * applies the selected pill's scale itself (`CHIP_SEL_SCALE`).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** `.wb-anno.sel .wb-resource-pill { transform: scale(1.12) }` (09-whiteboard.css) — keep equal. */
export const CHIP_SEL_SCALE = 1.12

export type ChipSize = { w: number; h: number }

export function useWbChipSizes() {
  const [sizes, setSizes] = useState<Record<string, ChipSize>>({})
  const ro = useRef<ResizeObserver | null>(null)

  const read = useCallback((el: HTMLElement) => {
    const id = el.dataset.chipId, w = el.offsetWidth, h = el.offsetHeight
    if (!id || !w || !h) return
    setSizes((prev) => (prev[id]?.w === w && prev[id]?.h === h ? prev : { ...prev, [id]: { w, h } }))
  }, [])

  useEffect(() => () => ro.current?.disconnect(), [])

  /** The ref for a chip element that carries `data-chip-id` — stable, so React does not detach and
   *  re-observe every chip on every render. Returns its own cleanup (React 19 callback refs). */
  const chipRef = useCallback((el: HTMLElement | null) => {
    if (!el) return
    if (!ro.current && typeof ResizeObserver !== 'undefined') {
      ro.current = new ResizeObserver((entries) => { for (const e of entries) read(e.target as HTMLElement) })
    }
    ro.current?.observe(el)
    read(el)
    return () => ro.current?.unobserve(el)
  }, [read])

  return { chipSizes: sizes, chipRef }
}
