/**
 * The turn, drawn where the operator is looking.
 *
 * A selection is turned from the bar at the bottom of the surface, and the number used to live
 * there too — 25cm away from the object that was moving, on a tablet held at arm's length. This
 * is the same read-out on the surface itself: the PIVOT the turn happens about, the radius the
 * finger is swinging, and the degrees, hanging just off the fingertip the way a dragged node's
 * cumulative label already hangs off its vertex.
 *
 * Client coordinates and `position: fixed`, so one component serves both surfaces without
 * knowing anything about lng/lat or board fractions — and so it cannot be dragged out from under
 * itself by the map panning below.
 *
 * Pointer-inert throughout: it is drawn over a live gesture and must never take a sample from it.
 */
import { appConfig } from '../config/appConfig'

/** the degrees, in the same shape the bar's dial printed them */
const fmtDeg = (d: number) => {
  const n = Math.round(d)
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)}°`
}

export function SelectionTurn({ cx, cy, px, py, deg }: {
  /** the pivot, in client px */
  cx: number
  cy: number
  /** the fingertip, in client px. Absent for the bar's own dial drag, whose pointer is on the
   *  button rather than out on a radius — the pivot and the number still belong on the surface. */
  px?: number
  py?: number
  deg: number
}) {
  const hasArm = px !== undefined && py !== undefined
  // the label hangs off the fingertip (or, without one, just above the pivot) — never centred
  // under it, where the finger covers the number it is changing
  const lx = hasArm ? px : cx
  const ly = hasArm ? py : cy
  return (
    <div className="sel-turn" aria-hidden>
      {hasArm && (
        <svg className="sel-turn-arm">
          <line x1={cx} y1={cy} x2={px} y2={py} />
        </svg>
      )}
      <span className="sel-turn-pivot" style={{ left: cx, top: cy }} />
      <span className="sel-turn-deg" style={{ left: lx, top: ly }}>{fmtDeg(deg)}</span>
      {/* named for a screen reader that is following the same gesture on a keyboard-less tablet */}
      <span className="sr-only" role="status">{`${appConfig.copy.shapes.rotate} ${fmtDeg(deg)}`}</span>
    </div>
  )
}
