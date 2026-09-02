/** Tap-to-open + hold-to-drag for a projected object on the Lage map — the ONE gesture both twin
 *  layers run (GeorefTwinsMap for plan symbols, GeorefContentMap for everything else).
 *
 *  It is `useHoldToDrag` with the map's coordinate plumbing folded in, exactly as MapMarkers
 *  wires it for a native marker: mouse press-drags at once, touch needs a still hold plus its
 *  buzz, a quick flick stays a map pan, and every armed sample is re-anchored through the LIVE
 *  map transform so a pinch under the finger cannot teleport the mark.
 *
 *  ⚠️ A twin must never be a react-map-gl `draggable` Marker. That claims the pointer on
 *  pointerdown and suppresses the map's own pan, so any pan starting on a projection drags the
 *  projection instead of the map — the failure mode `useHoldToDrag`'s header describes, and the
 *  one the symbol twins actually shipped with until 01.09.
 */
import { useRef } from 'react'
import { useHoldToDrag } from './useHoldToDrag'
import type { LngLat } from '../types'

export interface MapTwinDragDeps<T> {
  /** the live map transform + pan switch (the same trio MapMarkers takes) */
  project?: (c: LngLat) => { x: number; y: number } | undefined
  unproject?: (p: { x: number; y: number }) => LngLat | undefined
  setDragPan?: (on: boolean) => void
  /** write the ground coordinate through to the ONE source object; omitted ⇒ tap-only */
  onMove?: (twin: T, coord: LngLat, phase: 'start' | 'move' | 'end') => void
}

export interface MapTwinGestureOpts {
  /** this particular mark may be moved (a locked source, an anchored endpoint or a read-only
   *  surface says no) — it gates the MOVE only, a tap still opens the editor */
  movable: boolean
  /** this mark is already SELECTED, so a touch drags on the first travel instead of waiting out
   *  the 180 ms hold — the native marker's own rule (MapMarkers · `mode`), and the twin has to
   *  answer alike or the mirror of a symbol you have just tapped refuses the drag its original
   *  accepts. The deliberate hold stays for an unselected mark, so a flick across one still pans. */
  instant?: boolean
  /** tap (a press that never became a drag). Reported by the hook rather than by the browser
   *  click, which a slightly-moved touch often never fires at all. */
  onTap?: () => void
}

export function useMapTwinDrag<T>({ project, unproject, setDragPan, onMove }: MapTwinDragDeps<T>) {
  const hold = useHoldToDrag()
  /** the live drag — re-anchored from the LAST written coord on every move. One ref for the whole
   *  layer: only one projection is ever dragged at a time. */
  const drag = useRef<{ lx: number; ly: number; last: LngLat } | null>(null)
  /** the surface handed over everything a drag needs — per-mark permission is `movable` */
  const canDrag = !!onMove && !!project && !!unproject

  const begin = (ev: React.PointerEvent, twin: T, anchor: LngLat, { movable, instant, onTap }: MapTwinGestureOpts) => {
    // React-level only, and that is the point: the map's DragPan listens NATIVELY on the
    // container, below React's delegated root, so this cannot take the pan away from it (a pan
    // starting on a twin still pans). What it does stop is a React parent reading the press as
    // «tapped elsewhere» — the pan itself is handed back by setDragPan once the drag arms.
    ev.stopPropagation()
    hold.begin({ clientX: ev.clientX, clientY: ev.clientY, pointerId: ev.pointerId, isPrimary: ev.isPrimary }, {
      onTap,
      onHoldStart: () => {
        setDragPan?.(false)
        drag.current = { lx: ev.clientX, ly: ev.clientY, last: anchor }
        onMove?.(twin, anchor, 'start')
      },
      onDragMove: (mx, my) => {
        const st = drag.current
        if (!st) return
        const base = project?.(st.last)
        if (!base) return
        const nc = unproject?.({ x: base.x + (mx - st.lx), y: base.y + (my - st.ly) })
        if (!nc) return
        st.lx = mx; st.ly = my; st.last = nc
        onMove?.(twin, nc, 'move')
      },
      onDragEnd: () => {
        const st = drag.current
        drag.current = null
        setDragPan?.(true)
        if (st) onMove?.(twin, st.last, 'end')
      },
    }, { mode: ev.pointerType === 'mouse' || instant ? 'mouse' : 'touch', canDrag: movable })
  }

  return { begin, canDrag, cancel: hold.cancel }
}
