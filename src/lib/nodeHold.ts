import { useEffect, useRef, useState } from 'react'

/**
 * Hold-to-delete for the node handles of a line, an area, a measurement or a draft — the ONE
 * gesture that removes geometry, on both surfaces.
 *
 * Why a hold and not a tap or a double-tap: a node sits in the busiest place on the picture
 * (the incident point, where symbols, the Leitung tag and the Trupp chip already pile up), the
 * finger wears a glove, and deleting is the only action here that takes something away. A tap
 * is what a mis-grab looks like; iOS double-tap is unreliable (see usePlanMeasure · MapMarkers);
 * and dragging a node onto its neighbour to merge — tried in the 19.08. mockups — deletes any
 * node that already sits close to its neighbour on a plain tap, which is exactly the dense case.
 *
 * The shape of the gesture:
 * - `ARM_MS` of stillness before ANYTHING appears. Somebody who only wants to move the node must
 *   never see a red mark flash under their finger.
 * - then the chip (components/NodeDeleteChip — the app's own detach chip) fades in beside the
 *   node with a ring that fills until `FIRE_MS`. The fill IS the promise: let go early and
 *   nothing happened.
 * - any movement past `MOVE_PX` turns the gesture into a drag and cancels the hold silently.
 *
 * Movement + release are tracked on `window` in the capture phase, because on the map the
 * handle lives inside a react-map-gl Marker that takes pointer capture the instant a drag
 * starts — the element's own pointer events would stop arriving (same reason as useLongPress).
 */

export const NODE_HOLD_ARM_MS = 250
/** 900 → 825 (26.08. field test): the ring read as slow with a glove on, and the whole gesture is
 *  performed a dozen times while a hose is being reshaped. The ring is painted from the SAME two
 *  numbers (`progress` below), so shortening the hold shortens the fill — the promise the ring
 *  makes and the moment the node goes cannot drift apart. */
export const NODE_HOLD_FIRE_MS = 825
export const NODE_HOLD_MOVE_PX = 10
/** ~30 Hz — enough for a ring that fills over half a second, cheap enough for a marker layer */
const TICK_MS = 33

export interface NodeHoldArmed {
  /** which handle is being held — the caller's own key (`draw:<id>:3`, `measure:7`, …) */
  key: string
  /** 0…1 between arming and firing; the ring's fill */
  progress: number
}

export function useNodeHold() {
  const [armed, setArmed] = useState<NodeHoldArmed | null>(null)
  const st = useRef<{
    key: string
    t0: number
    sx: number
    sy: number
    cb: () => void
    timer: ReturnType<typeof setInterval>
    onMove: (e: PointerEvent) => void
    onUp: () => void
  } | null>(null)

  const cancel = () => {
    const s = st.current
    if (!s) return
    clearInterval(s.timer)
    window.removeEventListener('pointermove', s.onMove, true)
    window.removeEventListener('pointerup', s.onUp, true)
    window.removeEventListener('pointercancel', s.onUp, true)
    st.current = null
    setArmed(null)
  }

  useEffect(() => cancel, [])

  /**
   * Spread the result on a handle's `onPointerDown`. One hook instance serves a whole list of
   * handles — only one hold is ever live. `enabled: false` (a line already at its minimum) keeps
   * the handle draggable and simply never arms: the shape's floor is not a thing to explain
   * mid-gesture, it is a thing not to offer.
   */
  const press = (key: string, fn: () => void, enabled = true) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (!enabled) return
      cancel()
      const sx = e.clientX
      const sy = e.clientY
      const t0 = Date.now()
      const onMove = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > NODE_HOLD_MOVE_PX) cancel()
      }
      const onUp = () => cancel()
      const timer = setInterval(() => {
        const s = st.current
        if (!s) return
        const held = Date.now() - s.t0
        if (held < NODE_HOLD_ARM_MS) return
        if (held >= NODE_HOLD_FIRE_MS) {
          const cb = s.cb
          cancel()
          cb()
          return
        }
        setArmed({ key: s.key, progress: (held - NODE_HOLD_ARM_MS) / (NODE_HOLD_FIRE_MS - NODE_HOLD_ARM_MS) })
      }, TICK_MS)
      st.current = { key, t0, sx, sy, cb: fn, timer, onMove, onUp }
      window.addEventListener('pointermove', onMove, true)
      window.addEventListener('pointerup', onUp, true)
      window.addEventListener('pointercancel', onUp, true)
    },
  })

  return { press, cancel, armed }
}
