/*
 * **A phone bottom sheet is closed by pushing it down.** `overlays/swipeDismiss`, spread on the
 * popup by `Sheet` and `Overlay` (`swipeToClose`, on by default) — never a per-surface copy. It
 * measures that the popup IS a bottom sheet, leaves a scrolled body its own gesture, never starts
 * on a control. ONE grab bar (`overlays/SheetGrab` → `.ui-sheet-grab`, the same 40×5px pill as the
 * `.ctx` editors' `.sheet-grip`): `Sheet` draws it by default, a bespoke `Overlay` frame that IS
 * a bottom sheet on a phone opts in with `grab` (composer, Verlauf, PlanPicker, audio player, …
 * — never a frame that is full-screen or centred there, like the Trupp form on a tablet or the
 * handed-over Tafel; on the full app's PHONE board it IS a bottom sheet since 24.09.2026 and
 * wears the bar, see docs/atemschutz-board.md), and the one
 * hand-rolled sheet (`Palette`) borrows `SheetGrab` + `useSwipeDismiss` (20.09.2026), and so do
 * the NON-modal map sheet Ebenen (`LayerPanel`, 29.09.2026), whose `.lc-title` is a handle, and
 * the plan's NON-modal Passung dock (`GeorefDock`: Passung + «Karte verknüpfen» chooser; it
 * portals into `.app` on a phone to cover the bars). The map picker (`MapPicker`) is an
 * `Overlay grab` at the sheet cap: a map has no height to hug. The gesture needs the frame FLUSH with the bottom edge — which is why the phone
 * Verlauf is a real bottom sheet now and no longer a card floating 8px off it.
 */

import { useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

/**
 * Swipe a phone bottom sheet down to close it — as handlers the shared dialog primitives spread
 * on their popup, so EVERY non-fullscreen modal has the gesture and none of them implements it.
 *
 * On a phone `.ip-sheet` (and the bespoke frames `Overlay` paints) is a bottom sheet: it rises
 * from the bottom edge, keeps its top corners rounded and covers part of the screen. That shape
 * makes one promise on every phone anyone owns — push it back down and it goes away — and until
 * now the app only kept it on the `.ctx` editors (components/SheetGrip · useSheetDrag), which are
 * a different surface with a different job (resize half ⇄ full). Everything else could only be
 * dismissed by finding the ✕ at the top right or by hitting the sliver of backdrop above the
 * sheet, both of which are a stretch across the screen on the hand holding the device.
 *
 * Three rules keep it from fighting anything:
 *
 * 1. **It only exists on a bottom sheet.** Measured, not assumed (`isBottomSheet`): the popup has
 *    to sit ON the bottom edge and leave real screen above it. That excludes the centred dialogs
 *    (ConfirmCard, every sheet on a tablet) and the surfaces that are effectively full-screen, and
 *    it needs no media query in JS to agree with one in CSS — the layout has already decided.
 * 2. **Scrolled content wins.** A drag that starts over the sheet's scroller only dismisses while
 *    that scroller is at the very top, and only downwards; the moment the body has been scrolled
 *    the gesture is the scroller's. Dragging the HEADER (or the grab bar) always dismisses — the
 *    header is the part of a bottom sheet that is a handle everywhere else.
 * 3. **A control is a control.** A press that starts on a button/field/anything focusable is never
 *    a drag, the same guard `useSheetDrag` carries, so the ✕ in the header still closes on the
 *    first tap. A surface that owns the finger itself counts as one: a `canvas`, a MapLibre map
 *    (the PlanPicker's mini-map lives inside a bottom sheet, and a downward PAN of it would have
 *    thrown the sheet away), and anything that says so with `data-swipe-ignore` — the opt-out for
 *    a bespoke gesture surface that is neither.
 *
 * Nothing is captured and nothing is prevented until the finger has actually travelled past
 * `ENGAGE_PX` downwards — a still press, a tap and a horizontal swipe are all untouched.
 */

/** Travel before the sheet starts following the finger. Above the 8px pan/hold tolerance the
 *  rest of the app uses, because letting go of a sheet is a coarser gesture than aiming at one. */
const ENGAGE_PX = 10
/** Let go: pulled down this far, or flicked faster than `FLICK_VPX` after a shorter pull. */
const DISMISS_PX = 96
const FLICK_PX = 40
/** px per ms — an ordinary deliberate push lands well under this. */
const FLICK_VPX = 0.5
/** How much of the viewport a bottom sheet leaves above itself before this counts as a
 *  full-screen surface instead (where there is nothing to push down TO). */
const MIN_HEADROOM_PX = 24
/** The snap back when the pull was not enough. Short: leaving must never make anyone wait. */
const SNAP_MS = 180

type Drag = {
  id: number
  y0: number
  x0: number
  t0: number
  el: HTMLElement
  /** the scroller the gesture started over, if it was not the header */
  scroller: HTMLElement | null
  engaged: boolean
  dy: number
}

/** What never starts the gesture: a control (rule 3) and every surface that reads the finger
 *  itself — a canvas, a MapLibre map, anything marked `data-swipe-ignore`. */
const NO_DRAG_SEL = [
  'button', 'a', 'input', 'select', 'textarea', '[role="button"]', '[contenteditable]',
  'canvas', '.maplibregl-map', '.maplibregl-canvas-container', '[data-swipe-ignore]',
].join(', ')

/** Was this pull a «let go»? Far enough, or a flick after a shorter pull. Shared with the picture
 *  viewer's swipe-down (lib/ui · PhotoZoom), so both answer the same push the same way. */
export function isDismissPull(dy: number, ms: number): boolean {
  return dy > DISMISS_PX || (dy > FLICK_PX && dy / Math.max(1, ms) > FLICK_VPX)
}

/** Is this popup laid out as a bottom sheet right now? See rule 1. */
function isBottomSheet(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  const vh = window.visualViewport?.height ?? window.innerHeight
  return Math.abs(r.bottom - vh) <= 2 && r.top >= MIN_HEADROOM_PX
}

/** The scrolling ancestor between `from` and the popup — a sheet's `.ip-body`, a bespoke body. */
function scrollerWithin(from: Element | null, popup: HTMLElement): HTMLElement | null {
  let node: Element | null = from
  while (node && node !== popup) {
    if (node instanceof HTMLElement) {
      const oy = getComputedStyle(node).overflowY
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) return node
    }
    node = node.parentElement
  }
  return null
}

export interface SwipeDismissOptions {
  onClose: () => void
  /** Off for a surface that owns the vertical gesture itself. Default on. */
  enabled?: boolean
}

export function useSwipeDismiss({ onClose, enabled = true }: SwipeDismissOptions) {
  const drag = useRef<Drag | null>(null)

  const settle = (el: HTMLElement, animate: boolean) => {
    el.style.transition = animate ? `transform ${SNAP_MS}ms var(--ease, ease)` : ''
    el.style.transform = ''
    if (animate) window.setTimeout(() => { el.style.transition = '' }, SNAP_MS)
  }

  const end = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (!d.engaged) return
    if (isDismissPull(d.dy, e.timeStamp - d.t0)) {
      // let the popup's own exit transition take it from where the finger left it
      settle(d.el, false)
      onClose()
      return
    }
    settle(d.el, true)
  }

  if (!enabled) return {}

  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      // mouse users have the ✕ and the backdrop and no muscle memory for this
      if (drag.current || (e.pointerType !== 'touch' && e.pointerType !== 'pen')) return
      const el = e.currentTarget
      if (!isBottomSheet(el)) return
      const target = e.target instanceof Element ? e.target : null
      // rule 3 — a control is a control, and so is a surface that pans under the finger
      if (target?.closest(NO_DRAG_SEL)) return
      // rule 2 — the header always drags; over a scroller only while it is at the very top
      // (`.lc-title`: the head of the phone's non-modal map sheets — Ebenen, the Suche card)
      const onHead = !!target?.closest('.ip-head, .ui-sheet-grab, .lc-title')
      const scroller = onHead ? null : scrollerWithin(target, el)
      if (!onHead && scroller && scroller.scrollTop > 0) return
      drag.current = {
        id: e.pointerId, y0: e.clientY, x0: e.clientX, t0: e.timeStamp,
        el, scroller, engaged: false, dy: 0,
      }
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current
      if (!d || d.id !== e.pointerId) return
      const dy = e.clientY - d.y0
      const dx = e.clientX - d.x0
      if (!d.engaged) {
        // upwards, or mostly sideways: this gesture belongs to the content, not to the sheet
        if (dy < -2 || Math.abs(dx) > Math.abs(dy)) { drag.current = null; return }
        if (dy < ENGAGE_PX) return
        // re-check at the moment of engaging: the scroller may have moved under the finger
        if (d.scroller && d.scroller.scrollTop > 0) { drag.current = null; return }
        d.engaged = true
        d.el.style.transition = ''
      }
      d.dy = Math.max(0, dy - ENGAGE_PX)
      d.el.style.transform = `translateY(${d.dy}px)`
    },
    onPointerUp: end,
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current
      if (!d || d.id !== e.pointerId) return
      drag.current = null
      if (d.engaged) settle(d.el, true)
    },
  }
}
