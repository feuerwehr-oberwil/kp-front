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
import { HubretterBoom, TacticalSymbol } from '../lib/symbolRender'
import { useRef } from 'react'
import { DRAG_DEADZONE_PX } from '../lib/useHoldToDrag'
import type { SymbolProps } from '../types'
import s from './GeorefTwins.module.css'

/**
 * The one mark, positioned by its caller.
 *
 * The same symbol renderer carries the source's caption decision across — and its storey badge,
 * its Entwicklung spread arrows and a Hubretter's boom too, drawn exactly as the source draws
 * them (doctrine 30.08.: presentation-equivalent, never re-aimed through the fit). The boom's
 * LENGTH is resolved by each renderer in its own surface's units — metres on the Karte, a sheet
 * fraction on the Plan — because that is the one thing the two frames cannot share.
 */
export function TwinMark({ svg, sizePx, rotation, count, floor, floorFrom, floorTo, spread, overlay, boom, caption, title, onOpen, onMove, onGesture, gestureMovable = false, interactive = true, selected = false, style, className, children }: {
  svg: string
  sizePx: number
  rotation: number
  count?: number
  /** the source's signed storey badge (Entity.floor / BoardAnno.storey — never the tile index) */
  floor?: number
  floorFrom?: number
  floorTo?: number
  /** the source's Entwicklung arrows, exactly as the source draws them */
  spread?: SymbolProps['spread']
  /** a composite's fan/ladder over the base body, already aimed by the caller (lib/twinGlyph ·
   *  overlayFor) — without it a mirrored Grosslüfter was just a bare vehicle body */
  overlay?: { svg: string; rotation?: number; scale?: number }
  /** a Hubretter's articulated boom over the base body, already aimed and sized by the caller
   *  (lib/twinGlyph · boomFor) — without it a mirrored Hubretter was a bare Fahrzeug */
  boom?: { lengthPx: number; deg: number }
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
   * The SURROUNDING surface owns the whole gesture — used on the Karte, where the press is fed
   * to the shared hold-to-drag (lib/mapTwinDrag) so a projection behaves exactly like the native
   * marker beside it: mouse press-drags at once, touch arms only after a still 180 ms hold plus
   * its buzz, and anything shorter stays a map pan.
   *
   * ⚠️ The map half must NOT run the `onMove` gesture below, and must NOT be a react-map-gl
   * `draggable` Marker either: that claims the pointer on pointerdown and suppresses the map's
   * pan, so every pan starting on a twin dragged the twin (the exact failure `useHoldToDrag` was
   * written to avoid). With the press delegated, the tap arrives through the hold's own onTap —
   * this element's click then only serves the keyboard (detail 0).
   */
  onGesture?: (ev: React.PointerEvent<HTMLButtonElement>) => void
  /** with `onGesture`: whether that gesture may actually move the object — the grab cursor is
   *  the hand's answer to «kann ich das anfassen» and must not promise a move the surface refuses */
  gestureMovable?: boolean
  /** the surface is in its resting state and the tap may open the details. False ⇒ inert (see
   *  .inert): a tool is armed, or the pairing mode is running, and the tap belongs to that. */
  interactive?: boolean
  /** The projection whose shared detail panel is open gets the same selection halo as its
   *  source object. Movement is available immediately, matching each source surface's direct
   *  drag grammar; selection changes only the visual state. */
  selected?: boolean
  style?: React.CSSProperties
  className?: string
  /** surface-owned chrome drawn INSIDE the mark — currently only the fan's hairline home
   *  (GeorefTwinsMap), which has to sit in the mark's own stacking box to point back at the
   *  true position. */
  children?: React.ReactNode
}) {
  // The live gesture. A ref, not state: it is written on every pointer sample, and nothing about
  // the mark's appearance depends on it — the position it produces arrives back as a new `pt`.
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null)
  // survives past pointerup so the click that follows can tell a drag from a tap
  const dragged = useRef(false)
  const draggable = interactive && !!onMove && !onGesture
  // the cursor answers «kann ich das anfassen», which is true in BOTH modes — whether this
  // component runs the gesture or the surrounding surface does is an implementation detail the
  // hand cannot see
  const movable = interactive && (!!onMove || gestureMovable)

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    // delegated mode: the surface's shared hold gesture takes the press whole, deliberately
    // WITHOUT stopping it — a pan that starts on a twin has to reach the map, or the projection
    // steals it (D-03)
    if (onGesture) { if (interactive) onGesture(e); return }
    // the surrounding surface must not ALSO start a pan under the finger — the same reason the
    // plan's capture layer stops this event (components/GeorefMode · own).
    e.stopPropagation()
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
      // the SHARED deadzone every drag on both surfaces uses (useHoldToDrag) — this layer had
      // its own 4 px, so two twins standing next to each other answered a nudge differently
      if (Math.hypot(dx, dy) < DRAG_DEADZONE_PX) return
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
      // The marker the surfaces' outside-tap dismissal keys off: a press that STARTS here must
      // not be read as «tapped elsewhere, close the twin panel» — the surrounding canvas sees
      // every pointerdown in the CAPTURE phase, before this component can stop anything, and
      // deselecting at that moment is what killed the drag on the very object wearing the halo.
      data-twin=""
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
      // carried by this flag rather than read back off the gesture. In delegated mode the tap
      // comes from the hold gesture instead, so only the KEYBOARD's click (detail 0) opens here.
      onClick={(e) => {
        e.stopPropagation()
        if (onGesture) { if (e.detail === 0) onOpen(); return }
        if (!dragged.current) onOpen()
        dragged.current = false
      }}
    >
      {children}
      {selected && <span className="sel-halo" aria-hidden />}
      <TacticalSymbol svg={svg} sizePx={sizePx} rotation={rotation} count={count}
        floor={floor} floorFrom={floorFrom} floorTo={floorTo}
        spread={spread} overlay={overlay} caption={caption} />
      {/* boom AFTER the body → paints on top, the way both source surfaces mount it */}
      {boom && <HubretterBoom lengthPx={boom.lengthPx} deg={boom.deg} />}
    </button>
  )
}
