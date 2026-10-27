import { useEffect, useState } from 'react'
import { TAP_GAP_MS } from './tapDragZoom'

/**
 * The index of a point that was JUST added to a path, for one tap gap (TAP_GAP_MS) — else null.
 *
 * Messen (sweep 27.10.2026 #8): a tap places a measuring point exactly under the finger, so the
 * second press of tap-and-drag landed on that point's own handle and dragged it instead of
 * zooming. The surfaces render the fresh handle click-through (`pointer-events: none`) for this
 * window, so the press reaches the map (MapLibre's tap-and-drag) or the Plan's ink (lib/tapDragZoom ·
 * oneFingerZoom); after it, the handle is an ordinary drag/hold target again. Used by MapView
 * (Lage and Karte) and the Plan's measure nodes (usePlanMeasure).
 *
 * Only GROWTH counts: a deleted or dragged point is not new, and a reset clears it.
 */
export function useFreshPoint(count: number): number | null {
  const [seen, setSeen] = useState(count)
  const [fresh, setFresh] = useState<number | null>(null)
  // adjusting state while rendering (React's own pattern for «derive from a changed prop»)
  if (count !== seen) {
    setSeen(count)
    setFresh(count > seen ? count - 1 : null)
  }
  useEffect(() => {
    if (fresh == null) return
    const t = setTimeout(() => setFresh(null), TAP_GAP_MS)
    return () => clearTimeout(t)
  }, [fresh, seen])
  return fresh
}
