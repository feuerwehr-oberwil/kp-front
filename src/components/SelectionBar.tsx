import { useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { DRAG_DEADZONE_PX } from '../lib/useHoldToDrag'

/** Streamed like every other direct-manipulation gesture in the app: 'start' snapshots for undo,
 *  'move' writes live, 'end' commits — so the whole drag folds into ONE undo step. */
export type TransformPhase = 'start' | 'move' | 'end'

/** Sideways travel per degree on the dial. 2px means a half-turn is a ~360px drag — reachable on
 *  a phone in one sweep, and slow enough that a gloved hand can settle on a bearing.
 *  ⚠️ No snapping raster (decided 01.09.): a Rettungsachse is aimed at a building, not at a
 *  multiple of 15°, and the raster fought every attempt to land between two of its steps. */
const PX_PER_DEG = 2

interface Props {
  /** ✥ — the pointer's travel in CLIENT px since the press. The surface turns px into its own
   *  units (the map into a lng/lat delta at the selection's centre, the plan into board
   *  fractions) and translates every selected object by it. */
  onMove: (dx: number, dy: number, phase: TransformPhase) => void
  /** ⟳ — accumulated degrees, clockwise-positive. Omitted when the selection has no angle to
   *  turn (an Absperrkreis, and anything else whose model carries none): the button is then
   *  absent rather than inert, because a dead control at 3am is a control you keep pressing. */
  onRotate?: (deg: number, phase: TransformPhase) => void
  onDelete: () => void
  /** A drag on ✥ / ⟳ has been taken (true) or released (false).
   *  ⚠️ The Lage needs this: MapLibre arms its DragPan on the separate NATIVE mousedown /
   *  touchstart, which no React stopPropagation can reach, so without holding it off for the
   *  gesture the whole map pans under the finger while the selection is being moved. */
  onGrab?: (grabbing: boolean) => void
}

const fmtDeg = (d: number) => {
  const n = Math.round(d)
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}°`
}

/**
 * The one fixed bar every selection is transformed from — bottom-centre of the Lage map and of
 * the Plan board, in the same spot for a single Linie, a Form, an Absperrkreis and a
 * Mehrfach-Gruppe alike (decided 01.09., mock «Feste Auswahl-Leiste»).
 *
 * It replaces the map's floating hub AND the group pill both surfaces used to grow at the
 * selection's centre: three grammars for one question, each of them parked on top of the ink and
 * of the vertex handles the operator was reaching for. On the object itself only GEOMETRY grips
 * remain — vertex, «+», Verlängern, Verbindung lösen, the radius ring. Body-drag on the object
 * stays as the tolerant shortcut.
 *
 * Presentational on purpose: it knows a pointer delta and nothing about lng/lat, board fractions,
 * undo or the journal. Each surface maps the delta onto its own writers, which is also what lets
 * a further selection source (a Georeferenz-Zwilling) be added later without touching this file.
 */
export function SelectionBar({ onMove, onRotate, onDelete, onGrab }: Props) {
  const drag = useRef<{ kind: 'move' | 'rotate'; x0: number; y0: number; live: boolean } | null>(null)
  // the live dial readout; null whenever no turn is in the hand
  const [deg, setDeg] = useState<number | null>(null)
  const C = appConfig.copy.drawingEditor

  const down = (kind: 'move' | 'rotate') => (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    drag.current = { kind, x0: e.clientX, y0: e.clientY, live: false }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    onGrab?.(true)
  }
  const move = (e: React.PointerEvent) => {
    const st = drag.current
    if (!st) return
    e.stopPropagation()
    const dx = e.clientX - st.x0, dy = e.clientY - st.y0
    if (!st.live) {
      // a plain tap on the bar must write nothing at all — no undo step, no Verlauf row for a
      // selection that never moved
      if (Math.hypot(dx, dy) < DRAG_DEADZONE_PX) return
      st.live = true
      if (st.kind === 'move') onMove(0, 0, 'start')
      else onRotate?.(0, 'start')
    }
    if (st.kind === 'move') { onMove(dx, dy, 'move'); return }
    const d = dx / PX_PER_DEG
    setDeg(d)
    onRotate?.(d, 'move')
  }
  const up = (e: React.PointerEvent) => {
    const st = drag.current
    drag.current = null
    setDeg(null)
    onGrab?.(false)
    if (!st?.live) return
    e.stopPropagation()
    const dx = e.clientX - st.x0, dy = e.clientY - st.y0
    if (st.kind === 'move') onMove(dx, dy, 'end')
    else onRotate?.(dx / PX_PER_DEG, 'end')
  }

  return (
    // pointerdown is swallowed here so a press on the bar never reaches the surface below and
    // deselects the very thing the bar is about to move
    <div className="sel-bar" role="toolbar" aria-label={C.selectionBar} onPointerDown={(e) => e.stopPropagation()}>
      <button className="sel-bar-act" title={C.move} aria-label={C.move} data-holdaction
        onPointerDown={down('move')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onClick={(e) => e.stopPropagation()}><Icon id="move" /></button>
      {onRotate && (
        <button className="sel-bar-act sel-bar-rot" title={appConfig.copy.shapes.rotate} aria-label={appConfig.copy.shapes.rotate} data-holdaction
          onPointerDown={down('rotate')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          onClick={(e) => e.stopPropagation()}>
          <Icon id="rotate" />
          {deg !== null && <span className="sel-bar-deg">{fmtDeg(deg)}</span>}
        </button>
      )}
      <button className="sel-bar-del" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDelete() }}>
        {appConfig.copy.delete}
      </button>
    </div>
  )
}
