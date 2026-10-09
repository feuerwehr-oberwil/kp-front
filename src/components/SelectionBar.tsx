/*
 * **One selection bar, one edit-chrome vocabulary** (decided 01.09.). Moving, turning and
 * deleting a selection – a single Linie/Fläche/Absperrkreis, a Form, or a Mehrfach group – happen
 * on the fixed `SelectionBar` at the bottom of each surface, never on floating chrome grown at the
 * object's own centre. **✥ and ⟳ answer two gestures** (02.09.): a *drag on the grip* moves /
 * dials straight away, for the small adjustment; a *tap* arms that grip as a surface **mode**
 * (`lib/useArmedTransform`), and while it is on, a drag anywhere on the Karte or the Kroki moves
 * the selection by the drag delta or turns it about its centre, following the pointer's bearing.
 * The mode exists because of where the bar sits: pinned bottom-centre, pulling ✥ *downward* runs
 * the finger off the screen within ~28px. Only one of the two is ever armed; tapping it again,
 * Esc, a selection change and a tool change all disarm, and while armed the surface answers no
 * taps at all – a press that never travels is nothing, so nothing can be placed, selected or
 * deselected under the finger. **The bar has three slots and no fourth: ✥ · ⟳ · Fertig.** The
 * turn's degrees are read *on the surface*, beside the pivot and the radius the finger is
 * swinging (`components/SelectionTurn`), never off a button at the far edge of a tablet – so the
 * two grips are icon-only and never re-flow mid-gesture. «Fertig» ends the editing state
 * (disarm + clear the selection + close its sheets); **«Entfernen» is not on the bar** (it was
 * called «Löschen» until 25.09.2026) – an object is removed from its own editor sheet and with the
 * Delete key, which on both surfaces reaches a
 * Mehrfach group and a mirrored selection too. On the object itself only **geometry** grips live:
 * vertex, «+» midpoint, Verlängern, Verbindung lösen, the radius ring, and a shape's own
 * resize grips (its rotate knob left on 02.09.: the bar's ⟳ is the one way to turn a Form;
 * directional symbols and composites keep their rotor because they are not on the bar) – and all of them step aside for the length of a transform
 * (`lib/transformChrome`, a body class), because they answer «where exactly» and a whole-object
 * drag is asking «where to».
 * Colour is one family: a geometry point is white-filled with a `--blue` ring, an action grip that
 * transforms the whole object is solid `--blue`, `--amber` means the SECOND axis and nothing else,
 * `--red` means delete, and `--accent` stays alarm/relationship – never «selected». Node dots are
 * 24px on both surfaces. Every grip whose press-and-hold is its own gesture carries
 * `data-holdaction`, or the app-wide hold-tooltip eats its release.
 */

import { useRef, useState } from 'react'
import { Icon } from '../lib/icons'
import { appConfig } from '../config/appConfig'
import { Button } from './Button'
import { DRAG_DEADZONE_PX } from '../lib/useHoldToDrag'
import { beginTransformChrome, endTransformChrome } from '../lib/transformChrome'

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
  /** «Fertig» — the editing state ends: any armed mode is dropped, the selection is cleared and
   *  every sheet that was open FOR it closes. Deleting is not on this bar: it lives in the
   *  object's own editor sheet and on the Delete key, where it does for every other object. */
  onDone: () => void
  /** A drag on ✥ / ⟳ has been taken (true) or released (false).
   *  ⚠️ The Lage needs this: MapLibre arms its DragPan on the separate NATIVE mousedown /
   *  touchstart, which no React stopPropagation can reach, so without holding it off for the
   *  gesture the whole map pans under the finger while the selection is being moved. */
  onGrab?: (grabbing: boolean) => void
  /** ✥ / ⟳ armed as a SURFACE mode — the bar only paints the state; the drag itself is taken
   *  on the Karte / the Kroki (lib/useArmedTransform). */
  armed?: 'move' | 'rotate' | null
  /** a TAP on ✥ / ⟳ (a press that never became a drag): arm that mode, or disarm it again */
  onArm?: (kind: 'move' | 'rotate') => void
}

/**
 * The one fixed bar every selection is transformed from — bottom-centre of the Lage map and of
 * the Plan board, in the same spot for a single Linie, a Form, an Absperrkreis and a
 * Mehrfach-Gruppe alike (decided 01.09., mock «Feste Auswahl-Leiste»).
 *
 * It replaces the map's floating hub AND the group pill both surfaces used to grow at the
 * selection's centre: three grammars for one question, each of them parked on top of the ink and
 * of the vertex handles the operator was reaching for. On the object itself only GEOMETRY grips
 * remain — vertex, «+», Verlängern, Verbindung lösen, the radius ring — and even those step
 * aside for the length of a transform (lib/transformChrome), so the object reads as one thing
 * while it moves. Body-drag on the object stays as the tolerant shortcut.
 *
 * Three slots, and no fourth: ✥ · ⟳ · Fertig. The turn's degrees are read ON THE SURFACE, beside
 * the pivot (components/SelectionTurn), not off a button at the far edge of the screen; and
 * «Löschen» is not here at all — an object is deleted from its own editor sheet and with the
 * Delete key, where every other change to it is made.
 *
 * ✥ and ⟳ answer TWO gestures, and the second one exists because of where the bar sits. A DRAG
 * on the grip moves/turns straight away, for the small adjustment. A TAP arms that grip as a
 * surface MODE (`armed`/`onArm`, driven by lib/useArmedTransform): while it is on, a drag
 * anywhere on the Karte or the Kroki does the same thing with the whole surface to work in —
 * because the bar is pinned bottom-centre, and pulling ✥ downward from there runs the finger off
 * the screen within ~28px.
 *
 * Presentational on purpose: it knows a pointer delta and nothing about lng/lat, board fractions,
 * undo or the journal. Each surface maps the delta onto its own writers, which is also what lets
 * a further selection source (a Georeferenz-Zwilling) be added later without touching this file.
 */
export function SelectionBar({ onMove, onRotate, onDone, onGrab, armed = null, onArm }: Props) {
  const drag = useRef<{ kind: 'move' | 'rotate'; x0: number; y0: number; live: boolean } | null>(null)
  // «the drag is on the bar itself» — the ONE thing the stylesheet cannot work out on its own.
  // On a phone the bar follows the peeking detail sheet down for the length of a transform
  // (15-mobile.css · body.sheet-peek), which is right for the armed mode's drags on the Karte /
  // the Kroki, and wrong for a drag on this bar's own grip: the finger is on the button, and a
  // control that travels 300px away from the hand holding it is not a control.
  const [grabbing, setGrabbing] = useState(false)
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
      setGrabbing(true)
      // the selection's own geometry grips step aside for the gesture (lib/transformChrome)
      beginTransformChrome()
      if (st.kind === 'move') onMove(0, 0, 'start')
      else onRotate?.(0, 'start')
    }
    if (st.kind === 'move') { onMove(dx, dy, 'move'); return }
    onRotate?.(dx / PX_PER_DEG, 'move')
  }
  const up = (e: React.PointerEvent) => {
    const st = drag.current
    drag.current = null
    setGrabbing(false)
    endTransformChrome()
    onGrab?.(false)
    if (!st?.live) {
      // a press that never travelled is a TAP, and a tap arms the same writers for the whole
      // surface — the bar sits bottom-centre, so pulling ✥ downward has nowhere to go
      if (st) onArm?.(st.kind)
      return
    }
    e.stopPropagation()
    const dx = e.clientX - st.x0, dy = e.clientY - st.y0
    if (st.kind === 'move') onMove(dx, dy, 'end')
    else onRotate?.(dx / PX_PER_DEG, 'end')
  }

  return (
    // pointerdown is swallowed here so a press on the bar never reaches the surface below and
    // deselects the very thing the bar is about to move
    // `data-arm-exempt`: the armed mode owns every press on the surface EXCEPT the ones on this
    // bar, which is how ✥ keeps its own drag and how the mode can be tapped off again
    <div className={`sel-bar${grabbing ? ' grabbing' : ''}`} role="toolbar" aria-label={C.selectionBar} data-arm-exempt
      onPointerDown={(e) => e.stopPropagation()}>
      <button className={`sel-bar-act${armed === 'move' ? ' on' : ''}`} aria-pressed={armed === 'move'}
        title={armed === 'move' ? C.moveArmed : C.move} aria-label={armed === 'move' ? C.moveArmed : C.move} data-holdaction
        onPointerDown={down('move')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onClick={(e) => e.stopPropagation()}><Icon id="move" /></button>
      {onRotate && (() => {
        const label = armed === 'rotate' ? C.rotateArmed : appConfig.copy.shapes.rotate
        return (
          <button className={`sel-bar-act${armed === 'rotate' ? ' on' : ''}`} aria-pressed={armed === 'rotate'}
            title={label} aria-label={label} data-holdaction
            onPointerDown={down('rotate')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
            onClick={(e) => e.stopPropagation()}>
            <Icon id="rotate" />
          </button>
        )
      })()}
      {/* the bar's one word, and the way out of the editing state. NOT «Löschen»: deleting an
          object belongs in that object's own editor sheet (and on the Delete key), next to
          everything else that changes it — a destructive button on a chrome bar two taps from
          every grip is the near-miss the map's old hub ✕ was removed for. */}
      <Button className="sel-bar-done" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onDone() }}>
        {appConfig.copy.done}
      </Button>
    </div>
  )
}
