/*
 * *One finger zooms the Plan like the Karte* (08.10.2026, `lib/tapDragZoom`): a **double tap**
 * zooms ×2 and **tap, then press-and-drag** zooms continuously (down = in, up = out, ×2 per
 * 128 px) — MapLibre's own gestures and numbers (500 ms / 30 px), except that the drag zooms
 * about the FIRST tap instead of the screen centre. One pure state machine serves the boards
 * (`useBoardGestures`: selection tool only, presses on empty board only — objects swallow their
 * own; the second press never pans or deselects) and the PDF reader (`PdfScroller`: its double
 * tap still toggles fit ↔ 2×). Touch and pen only: a mouse has the wheel, and a double CLICK on
 * the board opens editors. The draw tools keep pinch only — on `.wb-ink` a double tap FINISHES
 * a Linie / Fläche. A second finger cancels the gesture and the pinch takes over.
 */

import { DRAG_DEADZONE_PX } from './useHoldToDrag'

/**
 * The one-finger zoom gestures the Karte has natively (MapLibre's TapZoomHandler +
 * TapDragZoomHandler), for the surfaces that are not a MapLibre map: the Plan boards
 * (components/useBoardGestures) and the plain PDF reader (components/PdfScroller). 08.10.2026,
 * Lage ↔ Plan parity.
 *
 * - **Double tap** → one step in, about the tap.
 * - **Tap, then press again and drag** → continuous zoom: down = in, up = out, ×2 per
 *   `PX_PER_DOUBLING` px like MapLibre — but about the FIRST tap, not the screen centre, so the
 *   spot you tapped stays under your finger.
 *
 * Pure and clock-free: the caller feeds pointer samples (with their own timestamps) and acts on
 * what comes back, so the whole grammar is testable without a DOM. Touch and pen only — a mouse
 * has the wheel, and a double CLICK on the board already opens an editor.
 *
 * The numbers are MapLibre's (tap_recognizer.ts, 4.7), so the Plan answers a double tap exactly
 * like the Karte beside it: a tap is ≤ 500 ms and moves ≤ 30 px, the second press comes ≤ 500 ms
 * after the first one lifted and ≤ 30 px from it.
 */
export const TAP_MAX_MS = 500
export const TAP_GAP_MS = 500
export const TAP_MAX_DIST_PX = 30
/** The second press turns from «double tap» into «drag to zoom» past the shared drag deadzone —
 *  the same 8 px after which a chip starts to travel. */
export const TAP_DRAG_ENGAGE_PX = DRAG_DEADZONE_PX
/** MapLibre's TapDragZoomHandler: `zoomDelta = dy / 128`, i.e. ×2 per 128 px of drag. */
export const PX_PER_DOUBLING = 128

export interface TapSample {
  id: number
  x: number
  y: number
  /** ms, any monotonic clock (event.timeStamp, performance.now()) — only differences count */
  t: number
  /** 'mouse' is ignored; anything else (touch, pen, unknown) takes part */
  pointerType?: string
}
export interface Pt { x: number; y: number }

export type TapZoomAction =
  /** the second press was accepted: this pointer belongs to the zoom now — no pan, no select */
  | { kind: 'arm'; at: Pt }
  /** still ours, nothing to apply yet (the armed finger has not passed the engage threshold) */
  | { kind: 'hold' }
  /** continuous zoom: `factor` is relative to the scale when the drag ENGAGED, about `at` */
  | { kind: 'zoom'; factor: number; at: Pt }
  /** a double tap: one step in, about `at` */
  | { kind: 'zoomStep'; at: Pt }
  /** the gesture is over (released after a drag, held too long, or cancelled) */
  | { kind: 'end' }

type State =
  | { s: 'idle' }
  /** a first press that may still become a tap */
  | { s: 'down'; id: number; x: number; y: number; t: number }
  /** a tap has lifted at `t`; waiting for the second press */
  | { s: 'tapped'; x: number; y: number; t: number }
  /** the second press, not yet dragged */
  | { s: 'armed'; id: number; x: number; y: number; t: number; at: Pt }
  /** dragging: zoom follows the finger's vertical travel from `y0` */
  | { s: 'drag'; id: number; y0: number; at: Pt }

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

export interface TapDragZoom {
  down(p: TapSample): TapZoomAction | null
  move(p: TapSample): TapZoomAction | null
  up(p: TapSample): TapZoomAction | null
  /** a second finger, a pointercancel, the surface changing tool — forget everything. Returns
   *  `end` when the gesture owned a pointer, so the caller can tidy up. */
  cancel(): TapZoomAction | null
  /** does the gesture own this pointer (armed or dragging)? */
  owns(id: number): boolean
}

export function createTapDragZoom(): TapDragZoom {
  let st: State = { s: 'idle' }
  const owned = () => st.s === 'armed' || st.s === 'drag'
  const cancel = (): TapZoomAction | null => {
    const was = owned()
    st = { s: 'idle' }
    return was ? { kind: 'end' } : null
  }
  return {
    down(p) {
      if (p.pointerType === 'mouse') return cancel()
      // a finger is already down: this one makes it a two-finger gesture (the pinch's)
      if (st.s === 'down' || owned()) return cancel()
      if (st.s === 'tapped' && p.t - st.t <= TAP_GAP_MS && dist(p, st) <= TAP_MAX_DIST_PX) {
        const at = { x: st.x, y: st.y }
        st = { s: 'armed', id: p.id, x: p.x, y: p.y, t: p.t, at }
        return { kind: 'arm', at }
      }
      st = { s: 'down', id: p.id, x: p.x, y: p.y, t: p.t }
      return null
    },
    move(p) {
      if (st.s === 'down') {
        if (p.id === st.id && dist(p, st) > TAP_MAX_DIST_PX) st = { s: 'idle' } // a pan, not a tap
        return null
      }
      if (st.s === 'armed' && p.id === st.id) {
        if (dist(p, st) <= TAP_DRAG_ENGAGE_PX) return { kind: 'hold' }
        // engage where the finger crossed the threshold, so the zoom starts at ×1 — no jump
        st = { s: 'drag', id: p.id, y0: p.y, at: st.at }
        return { kind: 'zoom', factor: 1, at: st.at }
      }
      if (st.s === 'drag' && p.id === st.id) {
        return { kind: 'zoom', factor: 2 ** ((p.y - st.y0) / PX_PER_DOUBLING), at: st.at }
      }
      return null
    },
    up(p) {
      if (st.s === 'down' && p.id === st.id) {
        st = p.t - st.t <= TAP_MAX_MS && dist(p, st) <= TAP_MAX_DIST_PX
          ? { s: 'tapped', x: st.x, y: st.y, t: p.t }
          : { s: 'idle' }
        return null
      }
      if (st.s === 'armed' && p.id === st.id) {
        const quick = p.t - st.t <= TAP_MAX_MS, at = st.at
        st = { s: 'idle' }
        return quick ? { kind: 'zoomStep', at } : { kind: 'end' }
      }
      if (st.s === 'drag' && p.id === st.id) { st = { s: 'idle' }; return { kind: 'end' } }
      // a pointer we never saw go down lifted between the taps (a press on a chip, say) — the
      // next press is not the second half of a double tap any more
      if (st.s === 'tapped') st = { s: 'idle' }
      return null
    },
    cancel,
    owns: (id) => (st.s === 'armed' || st.s === 'drag') && st.id === id,
  }
}
