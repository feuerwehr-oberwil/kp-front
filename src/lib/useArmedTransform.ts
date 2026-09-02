/**
 * ✥ / ⟳ as a MODE: tap the grip, then move or turn the selection by dragging anywhere on the
 * surface — the second half of the fixed selection bar (components/SelectionBar), shared by the
 * Karte and the Kroki so the gesture is one gesture on both.
 *
 * The bar is pinned bottom-centre, which is the right place for a control that must be findable
 * at 3am — and the wrong place to pull a grip DOWNWARD from: the finger is off the screen after
 * ~28px. Dragging the grip itself stays exactly as it was (small adjustments, no mode); a TAP on
 * it arms the same writers for the whole surface instead, where every direction has room.
 *
 * The listeners sit in the CAPTURE phase on the surface element, which is what makes an armed
 * drag beat the marquee, the pan, a placement and every marker below without any of them having
 * to know this mode exists. Two things it cannot stop that way, and both are handled:
 *   • MapLibre arms its DragPan on the separate NATIVE mousedown/touchstart, which no capture on
 *     pointerdown reaches — the surface's own pan guard (`onGrab`) holds it off for the drag,
 *     exactly as the bar's own drag already does.
 *   • the trailing click, which would otherwise land on the surface and deselect the very thing
 *     that was just moved — swallowed here for as long as the mode is armed, so a tap that never
 *     travelled is simply nothing (the selection stays put).
 */
import { useEffect, useRef, useState } from 'react'
import { DRAG_DEADZONE_PX } from './useHoldToDrag'
import { beginTransformChrome, endTransformChrome } from './transformChrome'

export type ArmMode = 'move' | 'rotate'
type Phase = 'start' | 'move' | 'end'

/** the anchor the mode never leaves: an element press-and-drag inside it stays its own gesture */
const EXEMPT = '[data-arm-exempt]'

interface ArmedTransformDeps {
  /** the bar is on this surface at all. False disarms — that is how read-only, a cleared
   *  selection and every tool change reach this mode without a rule of their own. */
  enabled: boolean
  /** the drawing surface the armed drag is taken on (the map container / the plan canvas),
   *  read at arm time rather than held, because both are created after the first render */
  surface: () => HTMLElement | null
  /** the selection's centre in CLIENT px — the pivot a direct rotation turns about. Read once,
   *  at the press, so the turn stays rigid while the picture moves under it. */
  centreClient: () => { x: number; y: number } | null
  /** the bar's own writers, unchanged: a client-px delta and a turn in degrees */
  onMove: (dx: number, dy: number, phase: Phase) => void
  onRotate?: (deg: number, phase: Phase) => void
  /** the surface's pan guard for the duration of one drag (SelectionBar · onGrab) */
  onGrab?: (grabbing: boolean) => void
  /** identity of what the bar is pointed at — a different selection disarms */
  resetKey: string
}

/** the idle guide's needle: long enough to read as a radius under a glove, short enough to stay
 *  inside a phone's map half; and the top-bar band it must not be drawn into */
const IDLE_ARM_PX = 96
const IDLE_ARM_MIN_Y = 120

/** clockwise degrees, wrapped into ±180 so a turn past half a circle keeps counting up */
const wrapDeg = (d: number) => ((d + 180) % 360 + 360) % 360 - 180

/** The live turn, in CLIENT px — what the on-surface guide is drawn from (components/SelectionTurn) */
export interface ArmedTurn {
  cx: number; cy: number
  /** where the finger is, so the guide can draw the radius the operator is swinging — while ⟳ is
   *  armed with no finger down it is the idle needle's tip (straight up from the pivot); absent
   *  only for the bar's own dial drag, whose pointer is on the button */
  px?: number; py?: number
  deg: number
}

export function useArmedTransform({ enabled, surface, centreClient, onMove, onRotate, onGrab, resetKey }: ArmedTransformDeps) {
  // The mode is stamped with WHAT it was armed on, and read back only while that still stands —
  // so «a different selection disarms», «a tool change disarms» and «read-only cannot arm» are
  // one derivation rather than three effects racing the render that caused them.
  const armKey = `${enabled ? 'on' : 'off'}|${resetKey}`
  const [arm, setArm] = useState<{ mode: ArmMode; key: string } | null>(null)
  const armed = enabled && arm?.key === armKey ? arm.mode : null
  /** the live turn, for the on-surface guide; null whenever no turn is in the hand */
  const [turn, setTurn] = useState<ArmedTurn | null>(null)
  const live = useRef<{
    pid: number
    x0: number; y0: number
    /** last sample, so a disarm mid-drag can still close the write */
    lx: number; ly: number
    on: boolean
    centre: { x: number; y: number } | null
    /** last raw pointer bearing (deg) and the accumulated turn */
    prev: number; acc: number
  } | null>(null)
  // latest-ref mirrors, synced in an effect rather than during render: the gesture listeners are
  // bound for the whole armed period, so they must read fresh callbacks without rebinding
  // mid-drag (the same rule useMapCanvasGestures documents).
  const cb = useRef({ surface, centreClient, onMove, onRotate, onGrab })
  useEffect(() => { cb.current = { surface, centreClient, onMove, onRotate, onGrab } })

  // Armed is a MODE, and it shows: the selection's geometry grips step aside for as long as it
  // lasts (nothing on the surface can be grabbed but the selection itself), and the surface wears
  // the mode's cursor — `data-sel-arm` on <body>, read by 11-measure.css.
  useEffect(() => {
    if (!armed) return
    beginTransformChrome('armed')
    document.body.dataset.selArm = armed
    return () => { endTransformChrome('armed'); delete document.body.dataset.selArm }
  }, [armed])

  useEffect(() => {
    if (!armed) return
    const el = cb.current.surface()
    if (!el) return
    const exempt = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.(EXEMPT)
    /** close the write the gesture opened, whatever ends it (release, cancel, disarm) */
    /** the guide with no finger on it: the pivot and 0°, shown for as long as ⟳ is armed — a tap
     *  on the grip used to change nothing on the surface until a drag began, so nothing said
     *  where the turn would happen or that the mode was on at all (field report 02.09.) */
    const idle = () => {
      if (armed !== 'rotate') { setTurn(null); return }
      const c = cb.current.centreClient()
      if (!c) { setTurn(null); return }
      // the WHOLE guide, not just the dot: a needle standing at twelve o'clock, 0° at its tip, so
      // the tap shows the pivot, the radius and the number the drag is about to move — the finger
      // takes the needle over from wherever it lands. Points down when the pivot sits under the
      // top bar, so the number is never drawn off the screen.
      const up = c.y - IDLE_ARM_PX >= IDLE_ARM_MIN_Y
      setTurn({ cx: c.x, cy: c.y, px: c.x, py: c.y + (up ? -IDLE_ARM_PX : IDLE_ARM_PX), deg: 0 })
    }
    idle()
    const close = () => {
      const st = live.current
      live.current = null
      idle()
      cb.current.onGrab?.(false)
      if (!st?.on) return
      if (armed === 'move') cb.current.onMove(st.lx - st.x0, st.ly - st.y0, 'end')
      else cb.current.onRotate?.(st.acc, 'end')
    }
    const down = (e: PointerEvent) => {
      if (live.current || e.isPrimary === false || exempt(e.target)) return
      e.stopPropagation()
      const c = cb.current.centreClient()
      live.current = {
        pid: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, on: false, centre: c,
        prev: c ? (Math.atan2(e.clientY - c.y, e.clientX - c.x) * 180) / Math.PI : 0, acc: 0,
      }
      cb.current.onGrab?.(true)
    }
    const move = (e: PointerEvent) => {
      const st = live.current
      if (!st || e.pointerId !== st.pid) return
      e.stopPropagation()
      st.lx = e.clientX; st.ly = e.clientY
      const dx = e.clientX - st.x0, dy = e.clientY - st.y0
      if (!st.on) {
        // a press that never travels writes nothing at all — no undo step, no Verlauf row
        if (Math.hypot(dx, dy) < DRAG_DEADZONE_PX) return
        st.on = true
        if (armed === 'move') cb.current.onMove(0, 0, 'start')
        else cb.current.onRotate?.(0, 'start')
      }
      if (armed === 'move') { cb.current.onMove(dx, dy, 'move'); return }
      if (st.centre) {
        const raw = (Math.atan2(e.clientY - st.centre.y, e.clientX - st.centre.x) * 180) / Math.PI
        st.acc += wrapDeg(raw - st.prev)
        st.prev = raw
        setTurn({ cx: st.centre.x, cy: st.centre.y, px: e.clientX, py: e.clientY, deg: st.acc })
      }
      cb.current.onRotate?.(st.acc, 'move')
    }
    const up = (e: PointerEvent) => {
      const st = live.current
      if (!st || e.pointerId !== st.pid) return
      if (st.on) e.stopPropagation()
      close()
    }
    // …and the click the release drags behind it, drag or not: while the mode is armed the
    // surface answers no taps, so nothing can be placed, selected or deselected under the finger
    const click = (e: MouseEvent) => { if (exempt(e.target)) return; e.stopPropagation(); e.preventDefault() }
    // ⚠️ MapLibre's own gestures (DragPan, and the freehand/marquee/Absperrkreis handlers that
    // hang off `map.on('mousedown'|'touchstart')`) arm on those NATIVE events, not on
    // pointerdown — stopping one says nothing about the other. Capturing them on the surface is
    // what actually keeps the map still under an armed drag; `onGrab` stays as the second lock.
    const native = (e: Event) => { if (!exempt(e.target)) e.stopPropagation() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setArm(null) }
    el.addEventListener('pointerdown', down, true)
    el.addEventListener('mousedown', native, true)
    el.addEventListener('touchstart', native, true)
    el.addEventListener('click', click, true)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    window.addEventListener('keydown', key)
    return () => {
      el.removeEventListener('pointerdown', down, true)
      el.removeEventListener('mousedown', native, true)
      el.removeEventListener('touchstart', native, true)
      el.removeEventListener('click', click, true)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
      window.removeEventListener('keydown', key)
      close()
      setTurn(null) // the mode is over — `close` alone would re-seat the pivot for it
    }
  }, [armed])

  return {
    armed,
    /** the live turn, for the on-surface guide — the pivot alone while ⟳ is armed, pivot + arm +
     *  degrees while it is being dragged, null otherwise */
    turn,
    /** a tap on ✥ / ⟳ — the same grip disarms, the other one takes the mode over */
    toggle: (mode: ArmMode) => setArm((cur) =>
      (!enabled || (cur?.key === armKey && cur.mode === mode) ? null : { mode, key: armKey })),
  }
}
