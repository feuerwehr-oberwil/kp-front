/*
 * **A phone bottom sheet is closed by pushing it down.** `overlays/swipeDismiss`, spread on the
 * popup by `Sheet` and `Overlay` (`swipeToClose`, on by default) — never a per-surface copy. It
 * measures that the popup IS a bottom sheet, leaves a scrolled body its own gesture, never starts
 * on a field or a slider (a row is a handle, sweep 28.10.2026). ONE grab bar (`overlays/SheetGrab` → `.ui-sheet-grab`, the same 40×5px pill as the
 * `.ctx` editors' `.sheet-grip`): `Sheet` draws it by default, a bespoke `Overlay` frame that IS
 * a bottom sheet on a phone opts in with `grab` (composer, Verlauf, PlanPicker, audio player, …
 * — never a frame that is full-screen or centred there, like the Trupp form on a tablet or the
 * handed-over Tafel; on the full app's PHONE board it IS a bottom sheet since 24.09.2026 and
 * wears the bar, see docs/atemschutz-board.md; the symbol `Palette` is one since 15.11.2026). The
 * hand-rolled sheets borrow `SheetGrab` + `useSwipeDismiss`: the NON-modal map sheet Ebenen (`LayerPanel`, 29.09.2026), whose `.lc-title` is a handle, and
 * the plan's NON-modal Passung dock (`GeorefDock`: Passung + «Karte verknüpfen» chooser; it
 * portals into `.app` on a phone to cover the bars). The map picker (`MapPicker`) is an
 * `Overlay grab` at the sheet cap: a map has no height to hug. The gesture needs the frame FLUSH with the bottom edge — which is why the phone
 * Verlauf is a real bottom sheet now and no longer a card floating 8px off it.
 */

import { useEffect, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { motionDuration } from '../reducedMotion'

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
 * 2. **Scrolled content wins.** A drag that starts over the sheet's body only dismisses while
 *    EVERY scroller between the finger and the popup (the popup included) is at its very top, and
 *    only downwards; the moment any of them has been scrolled the gesture is the content's — a
 *    list at its top inside a scrolled-down form scrolls the form back up (15.11.2026). Dragging the HEADER (or the grab bar) always dismisses — the
 *    header is the part of a bottom sheet that is a handle everywhere else.
 * 3. **A field is a field, a row is a handle.** (sweep 28.10.2026 #1, owner: «Ebenen just continues
 *    scrolling the content instead of closing it» — its body is nearly all rows and sliders, and
 *    every press on a row used to be dropped.) A press on a BUTTON or a row starts the pull like
 *    any other point of the body: a tap stays a tap (nothing happens before `ENGAGE_PX`), and the
 *    click a real pull ends in is swallowed. What never starts it (`NO_DRAG_SEL`): a field, a
 *    slider (`role="slider"` — its drag is the value), a `canvas`, a MapLibre map (the PlanPicker's
 *    mini-map — a downward PAN of it would have thrown the sheet away), a sideways scroller with
 *    room (a chip row's swipe), and anything that says so with `data-swipe-ignore` — the opt-out
 *    for a bespoke gesture surface that is none of these.
 *
 * ⚠️ The pull CLAIMS the touch from the browser. While it is armed, a downward touchmove is
 * cancelled (a document `touchmove` listener, non-passive, for the length of the press): left to
 * itself iOS rubber-bands the body at its top and answers with `pointercancel`, and the sheet never
 * moved — on the non-modal sheets (Ebenen, the Karte's object sheet, the `.ctx` editors) nothing
 * else cancelled it, which is the «continues scrolling» the owner saw. It is the FIRST touchmove
 * iOS keys its native pan on, so the claim is decided there: down at the top of the body is the
 * sheet's, up or sideways is the content's (the pull is dropped and nothing is cancelled).
 *
 * Nothing is captured until the finger has travelled past `ENGAGE_PX` downwards, and nothing but a
 * downward touchmove is ever prevented — a still press, a tap and a horizontal swipe are untouched.
 *
 * How it lets go (design pass 18.11.2026 – three of Base UI Drawer's ideas, kept on our own rules):
 * the scrim fades with the pull (`backdrop`); the release speed is the last ~80ms of the press
 * (`releaseVelocity`), not an average from the press; a dismissed sheet leaves DOWNWARDS from
 * where the finger let go (`slideOut`), and the ✕ / backdrop / Esc closes of `Sheet` and `Overlay`
 * take the same way out (`leaveBottomSheet`). Pulled up past its place it rubber-bands, and a
 * press during the snap back (or the rise, 15-mobile.css) takes the sheet where it stands.
 */

/** Travel before the sheet starts following the finger. Above the 8px pan/hold tolerance the
 *  rest of the app uses, because letting go of a sheet is a coarser gesture than aiming at one. */
const ENGAGE_PX = 10
/** Let go: pulled down this far, or flicked faster than `FLICK_VPX` after a shorter pull. */
const DISMISS_PX = 96
const FLICK_PX = 40
/** px per ms — an ordinary deliberate push lands well under this. */
const FLICK_VPX = 0.5
/** The release speed is the finger's over this last stretch of the press (`releaseVelocity`). */
const VELOCITY_WINDOW_MS = 80
/** How much of the viewport a bottom sheet leaves above itself before this counts as a
 *  full-screen surface instead (where there is nothing to push down TO). */
const MIN_HEADROOM_PX = 24
/** The snap back when the pull was not enough. Short: leaving must never make anyone wait. */
const SNAP_MS = 180
/** The way out: down off the bottom edge on the iOS sheet curve (steep start, soft landing — most
 *  of the travel is done in the first ~100ms, so the 280 never reads as a wait). */
const LEAVE_MS = 280
const LEAVE_EASE = 'cubic-bezier(.32, .72, 0, 1)'
/** How long after `onClose` a sheet that is still on the page counts as «not closed after all»
 *  (a parent that asks first): it comes back up instead of hanging off-screen. */
const STAYED_MS = 60

type Sample = { t: number; y: number }

type Drag = {
  id: number
  /** the document touchmove listener that claims the pull (rule 3's ⚠️); removed with the drag */
  claim: (e: TouchEvent) => void
  y0: number
  x0: number
  el: HTMLElement
  /** every scroller the gesture started inside (none on the header) */
  scrollers: HTMLElement[]
  engaged: boolean
  /** where the sheet stood when the finger took it — not 0 when it was caught mid-snap or mid-rise */
  base: number
  /** the sheet's offset under the finger: + down, − up (before the rubber band) */
  dy: number
  /** the recent moves, for the release speed */
  samples: Sample[]
  /** the modal's scrim, faded with the pull (none on the non-modal sheets) */
  scrim: HTMLElement | null
}

/** What never starts the gesture (rule 3): a field, a slider, and every surface that reads the
 *  finger itself — a canvas, a MapLibre map, anything marked `data-swipe-ignore`. A button or a
 *  link is NOT here: a press on a row starts the pull like any other point of the body. */
const NO_DRAG_SEL = [
  'input', 'select', 'textarea', '[contenteditable]', '[role="slider"]',
  'canvas', '.maplibregl-map', '.maplibregl-canvas-container', '[data-swipe-ignore]',
].join(', ')

/** A press inside a sideways scroller with room (a chip row) is that row's swipe: its first move
 *  is often a pixel down, and claiming it would kill the row's pan for the whole touch. */
function inSidewaysScroller(from: Element | null, popup: HTMLElement): boolean {
  for (let node = from; node && node !== popup; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue
    const ox = getComputedStyle(node).overflowX
    if ((ox === 'auto' || ox === 'scroll') && node.scrollWidth > node.clientWidth) return true
  }
  return false
}

/** After a pull that engaged, the click the press ends in (on the row it started on) is not a
 *  tap: swallow it once, in the capture phase, before the row hears it. Only a click inside the
 *  sheet, and only until the next press — a deliberate tap right after a snap-back is a tap. */
function swallowNextClick(sheet: HTMLElement) {
  const swallow = (e: MouseEvent) => {
    if (!(e.target instanceof Node) || !sheet.contains(e.target)) return
    e.preventDefault(); e.stopPropagation(); done()
  }
  const done = () => {
    window.removeEventListener('click', swallow, true)
    window.removeEventListener('pointerdown', done, true)
    window.clearTimeout(timer)
  }
  const timer = window.setTimeout(done, 400)
  window.addEventListener('click', swallow, true)
  window.addEventListener('pointerdown', done, true)
}

/**
 * Does a release at `dy` px down, moving at `v` px/ms (+ down), close the sheet? Far enough, or a
 * flick after a shorter pull — and never while the finger is already pushing it back UP: a sheet
 * caught and reversed past the line is a sheet somebody decided to keep.
 */
export function isDismissPull(dy: number, v: number): boolean {
  if (v < -FLICK_VPX) return false
  return dy > DISMISS_PX || (dy > FLICK_PX && v > FLICK_VPX)
}

/**
 * The finger's speed at the release, px/ms (+ down): over the last `VELOCITY_WINDOW_MS` of moves
 * — measured from the newest sample back to the first one at the window's edge — never averaged
 * from the press. A slow pull that ends in a flick is a flick.
 */
export function releaseVelocity(samples: readonly Sample[]): number {
  const last = samples[samples.length - 1]
  if (!last) return 0
  let first = last
  for (let i = samples.length - 2; i >= 0; i--) {
    const s = samples[i]
    if (!s) break
    first = s
    if (last.t - first.t >= VELOCITY_WINDOW_MS) break
  }
  const dt = last.t - first.t
  return dt > 0 ? (last.y - first.y) / dt : 0
}

/** Pulled UP past where it stands, the sheet follows less and less (Apple's rubber band): it
 *  answers the finger, and says there is nothing more above. `over` ≥ 0, `size` the sheet's height. */
export function rubberBand(over: number, size: number): number {
  const c = 0.55
  return (over * size * c) / (size + c * over)
}

/** The sheet's own vertical offset right now — its transform mid-flight (a snap back, a rise),
 *  read from the computed matrix so it is the value on screen, not the one it is heading for. */
function liveOffsetY(el: HTMLElement): number {
  const m = /^matrix(3d)?\((.+)\)$/.exec(getComputedStyle(el).transform)
  if (!m) return 0
  const v = (m[2] ?? '').split(',').map(Number)
  return (m[1] ? v[13] : v[5]) || 0
}

/** Is this popup laid out as a bottom sheet right now? See rule 1. Measured WITHOUT its own
 *  transform, so a sheet still snapping back or rising in is the bottom sheet it is landing as. */
function isBottomSheet(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  const off = liveOffsetY(el)
  const vh = window.visualViewport?.height ?? window.innerHeight
  return Math.abs(r.bottom - off - vh) <= 2 && r.top - off >= MIN_HEADROOM_PX
}

/** The popups on their way out — a second close (✕ during the slide, the back gesture) is the same exit. */
const leaving = new WeakSet<HTMLElement>()

/**
 * Take a bottom sheet out DOWNWARDS from wherever it stands (the finger's last position after a
 * pull, its resting place after a ✕), its scrim fading on the same curve, then `onGone` — the
 * caller's close. The parents unmount their sheets on close, so the exit has to run BEFORE it.
 * ⚠️ The first press or key anywhere during the slide closes at once: the operator's next tap must
 * land on a screen whose state already says «closed» (a tap that opens the next sheet must not be
 * closed by this one's late `onGone`). Nothing moves under reduced motion: `onGone` at once.
 */
function slideOut(el: HTMLElement, backdrop: HTMLElement | null, onGone: () => void) {
  const ms = motionDuration(LEAVE_MS)
  if (!ms) { onGone(); return }
  if (leaving.has(el)) return
  leaving.add(el)
  // a snap back still running must not clear this exit's transitions half-way
  window.clearTimeout(settling.get(el))
  el.style.transition = `transform ${ms}ms ${LEAVE_EASE}`
  el.style.transform = 'translateY(100%)'
  el.style.pointerEvents = 'none'
  if (backdrop) {
    backdrop.style.transition = `opacity ${ms}ms ${LEAVE_EASE}`
    backdrop.style.opacity = '0'
    backdrop.style.pointerEvents = 'none'
  }
  // still ours to close? Not once someone else closed it during the slide (unmounted, or Base UI
  // already ending it): that close has run, and a late one here would hit whatever shows by now
  const owns = () => el.isConnected && !el.hasAttribute('data-ending-style')
  // the Escape that ends the slide IS this close – claimed the way overlays/layer claims a layer's
  // Esc, so no later handler closes a second thing with it. A key after someone else's close
  // passes untouched: it belongs to whatever is on screen now.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && owns()) { e.preventDefault(); e.stopImmediatePropagation() }
    gone()
  }
  const gone = () => {
    window.clearTimeout(timer)
    window.removeEventListener('pointerdown', gone, true)
    window.removeEventListener('keydown', onKey, true)
    if (owns()) onGone()
    // a parent that did not close (it asks first) gets its sheet back where it was
    window.setTimeout(() => {
      leaving.delete(el)
      if (!el.isConnected || el.hasAttribute('data-ending-style')) return
      el.style.pointerEvents = ''
      settleTo(el, backdrop, SNAP_MS)
    }, STAYED_MS)
  }
  const timer = window.setTimeout(gone, ms)
  window.addEventListener('pointerdown', gone, true)
  window.addEventListener('keydown', onKey, true)
}

/** The running snap back's clean-up, per sheet — a new snap or a new pull replaces it. */
const settling = new WeakMap<HTMLElement, number>()

/** Back to rest over `ms` (0: at once), sheet and scrim together. */
function settleTo(el: HTMLElement, backdrop: HTMLElement | null, ms: number) {
  window.clearTimeout(settling.get(el))
  el.style.transition = ms ? `transform ${ms}ms var(--ease, ease)` : ''
  el.style.transform = ''
  if (backdrop) {
    backdrop.style.transition = ms ? `opacity ${ms}ms var(--ease, ease)` : ''
    backdrop.style.opacity = ''
    backdrop.style.pointerEvents = ''
  }
  if (ms) settling.set(el, window.setTimeout(() => {
    el.style.transition = ''
    if (backdrop) backdrop.style.transition = ''
  }, ms))
}

/**
 * Close a phone bottom sheet the way it opened — down off the bottom edge — for the closes that
 * are not a pull (the ✕, the backdrop, Esc, the back gesture): `Sheet` and `Overlay` route every
 * close through it. Anything that is not a bottom sheet right now (a centred dialog on a tablet, a
 * full-screen frame) closes at once, as before.
 */
export function leaveBottomSheet(el: HTMLElement | null, backdrop: HTMLElement | null, onGone: () => void) {
  if (el && isBottomSheet(el)) slideOut(el, backdrop, onGone)
  else onGone()
}

/** Every vertical scroller from `from` up to AND including the popup — a list nested in a sheet's
 *  `.ip-body`, the body itself, a frame that scrolls itself (15.11.2026: checking the innermost one
 *  only let a list at its top close a sheet whose body was scrolled down). */
function scrollersWithin(from: Element | null, popup: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  for (let node = from; node; node = node.parentElement) {
    if (node instanceof HTMLElement) {
      const oy = getComputedStyle(node).overflowY
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) out.push(node)
    }
    if (node === popup) break
  }
  return out
}

const anyScrolled = (scrollers: HTMLElement[]) => scrollers.some((s) => s.scrollTop > 0)

export interface SwipeDismissOptions {
  onClose: () => void
  /** Off for a surface that owns the vertical gesture itself. Default on. */
  enabled?: boolean
  /** Only the head (and the grab bar) drags the sheet — never its body, not even at the top of
   *  its scroller. For a sheet whose body is a RESULT LIST under a field (the Karte's search and
   *  Gefahrgut, components/karte/KarteKeySheet — owner, review round 4: «ensure it only scrolls the
   *  listed objects»): a drag over the list is the list's, whichever way and wherever it stands. */
  headOnly?: boolean
  /** The modal's scrim: it fades with the pull (fully pulled down = gone) and comes back with a
   *  snap back — one value drives both, so they never drift apart. `Sheet` and `Overlay` pass it. */
  backdrop?: RefObject<HTMLElement | null>
}

export function useSwipeDismiss({ onClose, enabled = true, headOnly = false, backdrop }: SwipeDismissOptions) {
  const drag = useRef<Drag | null>(null)

  /** forget the press — and its claim on the touch with it */
  const drop = () => {
    const d = drag.current
    if (d) document.removeEventListener('touchmove', d.claim)
    drag.current = null
    return d
  }

  const end = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.id !== e.pointerId) return
    const d = drop()
    if (!d?.engaged) return
    swallowNextClick(d.el)
    const v = releaseVelocity([...d.samples, { t: e.timeStamp, y: e.clientY }])
    // leaves DOWNWARDS from where the finger let go — the exit starts at this transform
    if (isDismissPull(d.dy, v)) slideOut(d.el, d.scrim, onClose)
    else settleTo(d.el, d.scrim, SNAP_MS)
  }

  // a sheet unmounted mid-press (an alarm takes the screen) never hears its pointerup
  useEffect(() => () => { drop() }, [])

  if (!enabled) return {}

  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      // mouse users have the ✕ and the backdrop and no muscle memory for this
      if (drag.current || (e.pointerType !== 'touch' && e.pointerType !== 'pen')) return
      const el = e.currentTarget
      // (measured without its transform: a press during the snap back or the rise takes the sheet)
      if (!isBottomSheet(el)) return
      const target = e.target instanceof Element ? e.target : null
      // rule 3 — a field is a field, and so is a surface that pans under the finger
      if (target?.closest(NO_DRAG_SEL)) return
      // rule 2 — the header always drags; over a scroller only while it is at the very top
      // (`.lc-title`: the head of the phone's non-modal map sheets — Ebenen, the Suche card;
      // `[data-sheet-head]`: a head of another shape, the Karte's field line)
      const onHead = !!target?.closest('.ip-head, .ui-sheet-grab, .lc-title, [data-sheet-head]')
      if (headOnly && !onHead) return
      const scrollers = onHead ? [] : scrollersWithin(target, el)
      if (anyScrolled(scrollers)) return
      if (!onHead && inSidewaysScroller(target, el)) return
      const y0 = e.clientY, x0 = e.clientX
      // rule 3's ⚠️ — pointer events arrive before their touch events, so by the time a touchmove
      // is judged here the pointermove has already dropped a pull that went up or sideways
      const claim = (t: TouchEvent) => {
        const p = t.touches[0]
        if (!drag.current || !t.cancelable || t.touches.length !== 1 || !p) return
        const dy = p.clientY - y0
        if (drag.current.engaged || (dy > 0 && dy >= Math.abs(p.clientX - x0))) t.preventDefault()
      }
      document.addEventListener('touchmove', claim, { passive: false })
      drag.current = {
        id: e.pointerId, claim, y0, x0,
        el, scrollers, engaged: false, base: 0, dy: 0, samples: [{ t: e.timeStamp, y: y0 }],
        scrim: backdrop?.current ?? null,
      }
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current
      if (!d || d.id !== e.pointerId) return
      const dy = e.clientY - d.y0
      const dx = e.clientX - d.x0
      d.samples.push({ t: e.timeStamp, y: e.clientY })
      // keep the window (and the one sample at its edge) — the press may be long
      while (d.samples.length > 2 && e.timeStamp - (d.samples[1]?.t ?? e.timeStamp) >= VELOCITY_WINDOW_MS) d.samples.shift()
      if (!d.engaged) {
        // upwards, or mostly sideways: this gesture belongs to the content, not to the sheet
        if (dy < -2 || Math.abs(dx) > Math.abs(dy)) { drop(); return }
        if (dy < ENGAGE_PX) return
        // re-check at the moment of engaging: a scroller may have moved under the finger
        if (anyScrolled(d.scrollers)) { drop(); return }
        d.engaged = true
        // caught mid-flight (a snap back, the rise): it stays where it is, under the finger
        window.clearTimeout(settling.get(d.el))
        d.base = liveOffsetY(d.el)
        // 1:1 from here — no transition of the sheet's own (its rise) may lag the finger
        d.el.style.transition = 'none'
        if (d.scrim) d.scrim.style.transition = 'none'
      }
      d.dy = d.base + dy - ENGAGE_PX
      const h = d.el.offsetHeight || 1
      d.el.style.transform = `translateY(${d.dy >= 0 ? d.dy : -rubberBand(-d.dy, h)}px)`
      if (d.scrim) d.scrim.style.opacity = String(Math.max(0, 1 - Math.max(0, d.dy) / h))
    },
    onPointerUp: end,
    // the browser took the touch (a scroll, a system gesture): never a decision — back it goes
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => {
      if (drag.current?.id !== e.pointerId) return
      const d = drop()
      if (d?.engaged) settleTo(d.el, d.scrim, SNAP_MS)
    },
  }
}
