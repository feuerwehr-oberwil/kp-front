import { useEffect, useRef } from 'react'

/**
 * Calls `changed` when one of the elements `targets` names appears, goes or changes size — without
 * reading any layout itself. `targets` runs after every commit (keep it a selector match, no
 * geometry); a changed list gets a fresh ResizeObserver, whose first report for each element counts
 * as a change too (a piece that came). Without a ResizeObserver (old engines, jsdom) it does nothing.
 * Used by the Karte's label pass (components/useLabelPass) to re-read the chrome only when it moved.
 */
export function useSizeWatch(targets: () => readonly Element[], changed: () => void): void {
  const watched = useRef<{ els: readonly Element[]; ro: ResizeObserver | null; changed: () => void }>({ els: [], ro: null, changed })
  useEffect(() => {
    const w = watched.current
    w.changed = changed
    if (typeof ResizeObserver === 'undefined') return
    const els = targets()
    if (els.length === w.els.length && els.every((el, i) => el === w.els[i])) return
    w.els = els
    w.ro?.disconnect()
    w.ro = new ResizeObserver(() => w.changed())
    for (const el of els) w.ro.observe(el)
  })
  useEffect(() => {
    const w = watched.current
    return () => { w.ro?.disconnect(); w.ro = null; w.els = [] }
  }, [])
}
