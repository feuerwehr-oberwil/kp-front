/** The one «Zwilling» mark — the look both surfaces share.
 *
 *  Two renderers sit on top of it (GeorefTwinsMap, GeorefTwinsBoard), because the surfaces
 *  position differently (a MapLibre `<Marker>` at a lng/lat vs. an absolutely positioned child of
 *  `.wb-board` at a normalized point) but must LOOK identical: the same source glyph and caption.
 *  A twin that looked different on each side would be two features instead of one idea.
 *
 *  ⚠️ ONE mark per mirrored object, and the mark is the SYMBOL ITSELF. It used to stack a dashed
 *  ring, a ⇄ badge and an extra name plaque around that glyph. Half a dozen of them near each
 *  other read as a field of blue furniture instead of as the handful of source objects they are.
 *
 *  ⚠️ The mark lives in its own module so the PLAN surface never has to import MapLibre for it —
 *  the Whiteboard pulls in the board renderer alone, and react-map-gl comes nowhere near it.
 *
 *  The derivation (which points cross over, and the clip that keeps a vehicle two kilometres
 *  away off the sheet) is lib/georefTwins. This file only draws.
 *
 *  ⚠️ BOUNDARIES, and they are the whole design:
 *   • A twin is never a second object. A tap opens the shared editor wired to the ONE source;
 *     dragging the twin likewise repositions that source through the georeference.
 *   • Nothing here writes directly: no workspace document, Verlauf row, clock or placement.
 *   • Nothing here prints. The Kroki payload and the plan pages are built from `entities` /
 *     `board` (lib/krokiPayload, backend kroki.py), and twins exist only in this render tree —
 *     there is no path by which one could reach a page.
 *   • Twins are not shown during replay: the georeference is station data that was never part
 *     of the recorded incident, and the vehicle feed is the present tense. The caller gates it
 *     (IncidentWorkspace passes empty lists while `replayActive`).
 */
import { TacticalSymbol } from '../lib/symbolRender'
import { useRef } from 'react'
import s from './GeorefTwins.module.css'

/**
 * The one mark, positioned by its caller.
 *
 * The same symbol renderer carries the source's caption decision across. Spread arrows, storey
 * badges and the Hubretter boom remain source-only details; the aerial boom in particular is
 * metre-scaled geometry that the projection has no honest length for.
 */
/** Pointer travel that turns a tap into a drag. Small — the operator is aiming at a symbol they
 *  can already see, so the gesture is deliberate from the first millimetre — but not zero, or a
 *  fingertip's own wobble on a glove would move the object on every tap. */
const DRAG_SLOP_PX = 4

export function TwinMark({ svg, sizePx, rotation, count, caption, title, onOpen, onMove, nativeDrag = false, interactive = true, selected = false, style, className }: {
  svg: string
  sizePx: number
  rotation: number
  count?: number
  /** Exactly the caption the source surface gives this symbol. Null means neither source nor
   *  projection invents a name plaque merely because it crossed the georeference. */
  caption?: string | null
  title: string
  /** tap: open the source details/editor while keeping this surface in place */
  onOpen: () => void
  /**
   * Drag, in CLIENT pixels relative to where the gesture started — the mark has no idea what
   * surface it is on, so each container converts the delta into its own space (a plan's
   * normalized point, a map's lngLat) and writes the ONE source object through the fit.
   *
   * Omitted ⇒ tap-only, which is what a projection was until 27.08.: the surrounding surface
   * kept every movement gesture, and the operator had to jump to the original to move anything.
   */
  onMove?: (phase: 'start' | 'move' | 'end', dx: number, dy: number) => void
  /**
   * The SURROUNDING surface owns the drag — used on the Karte, where a MapLibre `Marker` is
   * `draggable` and runs the gesture itself.
   *
   * ⚠️ It exists because the usual `stopPropagation()` cannot do the job there. MapLibre listens
   * on the map container, which is an ANCESTOR of this element, while React delegates from the
   * app root ABOVE that — so by the time this component's handler runs and stops the event, the
   * map has already begun a drag-pan and the twin would slide with the whole map under it. A
   * Marker that owns the gesture suppresses the pan itself, which is what it is for.
   */
  nativeDrag?: boolean
  /** the surface is in its resting state and the tap may open the details. False ⇒ inert (see
   *  .inert): a tool is armed, or the pairing mode is running, and the tap belongs to that. */
  interactive?: boolean
  /** The projection whose shared detail panel is open gets the same selection halo as its
   *  source object. Its container also uses this selection to enable movement; an unselected
   *  projection remains tap-only, matching the source surfaces' pick-then-drag rule. */
  selected?: boolean
  style?: React.CSSProperties
  className?: string
}) {
  // The live gesture. A ref, not state: it is written on every pointer sample, and nothing about
  // the mark's appearance depends on it — the position it produces arrives back as a new `pt`.
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null)
  // survives past pointerup so the click that follows can tell a drag from a tap
  const dragged = useRef(false)
  const draggable = interactive && !!onMove && !nativeDrag
  // the cursor answers «kann ich das anfassen», which is true in BOTH modes — whether this
  // component runs the gesture or the surrounding Marker does is an implementation detail the
  // hand cannot see
  const movable = interactive && (!!onMove || nativeDrag)

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    // the surrounding surface must not ALSO start a pan under the finger — the same reason the
    // plan's capture layer stops this event (components/GeorefMode · own). NOT in `nativeDrag`
    // mode, where the surface is deliberately the one running the gesture.
    if (!nativeDrag) e.stopPropagation()
    if (!draggable) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false }
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x, dy = e.clientY - d.y
    // …the first sample past the slop opens the drag, so a tap that never travels stays a tap
    if (!d.moved) {
      if (Math.hypot(dx, dy) < DRAG_SLOP_PX) return
      d.moved = true
      onMove?.('start', 0, 0)
    }
    onMove?.('move', dx, dy)
  }
  const up = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    dragged.current = d.moved
    if (d.moved) onMove?.('end', e.clientX - d.x, e.clientY - d.y)
  }
  return (
    <button
      type="button"
      className={`${s.twin} ${interactive ? '' : s.inert} ${movable ? s.grab : ''} ${className ?? ''}`}
      style={{ width: sizePx, height: sizePx, '--hbox': `${sizePx}px`, ...style } as React.CSSProperties}
      title={title}
      aria-label={title}
      tabIndex={interactive ? 0 : -1}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      // ⚠️ A drag must not also open the panel. The click fires after pointerup on the same
      // element, and `drag.current` is already cleared by then, so the "did it travel" answer is
      // carried by this flag rather than read back off the gesture.
      onClick={(e) => { e.stopPropagation(); if (!dragged.current) onOpen(); dragged.current = false }}
    >
      {selected && <span className="sel-halo" aria-hidden />}
      <TacticalSymbol svg={svg} sizePx={sizePx} rotation={rotation} count={count} caption={caption} />
    </button>
  )
}
