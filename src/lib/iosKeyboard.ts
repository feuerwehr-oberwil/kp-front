/*
 * **Typing on an iPhone without the page moving** (review round 3, 17.10.2026 — owner on a real
 * iPhone: «the background remains scrollable, and the whole thing is quite a mess» / «the UN
 * number entry thingy still doesn't work properly»).
 *
 * Why round 2 (#375) could not have worked on the phone, although a simulated keyboard in
 * Chromium looked right: it placed the Gefahrgut card and the search list from `--vv-pan` /
 * `--vv-foot` (lib/useViewportPan), i.e. it trusted iOS to report its pan as
 * `visualViewport.offsetTop` and then counter-placed the box that holds the caret. On the owner's
 * iPhone the page moved ~ the whole keyboard (the layout's foot stood on the keys) while the top
 * bar — translated by `--vv-pan` — never came back on screen: the shift did not arrive as
 * `offsetTop`. iOS moves a focused page by SCROLLING it (the keyboard makes even a fixed,
 * non-scrolling document scrollable by its own height), `position: fixed` stays where it was
 * laid out, and a finger dragging anything that does not scroll moves that page again. A
 * simulation that only shrinks/pans `visualViewport` models none of that.
 *
 * So this file does not rely on one fragile measurement. Three independent guards:
 *   1. NO PAN TO BEGIN WITH — a field is focused with `focusWithoutPan` (Safari decides whether to
 *      scroll at the moment of focus; for that moment the field stands far above the screen,
 *      where there is nothing to scroll to — the react-aria `usePreventScroll` technique), and the
 *      sheet that holds it stands on the keyboard's top edge (`keySheetBox`), so the caret is in
 *      sight and iOS has no reason to move anything later either.
 *   2. UNDO ANY PAN THAT HAPPENS ANYWAY — `useTypingLock` answers a window scroll or a visual
 *      viewport offset with `window.scrollTo(0, 0)`: this page never scrolls (02-base · fixed
 *      body), so any scroll is iOS's. Rate-limited (`mayCorrect`), so a field that really is
 *      under the keys can never start a scroll / unscroll loop. The sheet's placement does not
 *      depend on it: it is measured from the full height and the visual viewport (`keyboardTop`),
 *      so a pan iOS keeps — the installed app's collapse, review round 9 — leaves it on the keys.
 *      The installed app's collapse comes in STEPS while the finger is down (review round 10:
 *      innerHeight 793 → 711 → 785 …, each step scrolling the window by `793 − innerHeight`), so
 *      the undo runs IN the event, not a frame later, and a scroll that is exactly the collapse
 *      is always undone (`isCollapseScroll`) — six steps used up `mayCorrect` and the app rode
 *      up for the rest of the touch. And the root is never taller than the live window
 *      (`--live-h`, 02-base.css · html[data-typing-lock]), so a document scroll has no room.
 *   3. NOTHING TO DRAG — while a field has the caret, a touchmove that no scroller under the finger
 *      can take is cancelled (`touchMayScroll`, overlays/useMobileScrollLock): the list in the
 *      sheet scrolls, the bar and the sheet's head do not move the page.
 *
 * A DRAG ON THE LIST CLOSES THE KEYBOARD (owner's pick, review round 11, after six rounds of
 * fighting the installed app: iOS pans the VISUAL viewport under a drag with the keys up — not
 * undoable from script — and the list never got the touch). Like iOS Mail's search: a vertical
 * drag that starts on a sheet's list (`[data-drag-closes-keys]`) blurs the field once it has
 * travelled `DRAG_SLOP_PX` (`useDragClosesKeyboard`); the keyboard goes, the sheet drops to its
 * normal place, and the list scrolls without keys. Guard 3 leaves such a list alone — nothing
 * there is ever cancelled — and a tap (less travel) still opens a row with the keys up.
 */

import { useEffect, type RefObject } from 'react'
import { isTypingTarget } from './hotkeys'
import { touchGate } from './overlays/useMobileScrollLock'

/** Below this many px between the layout's foot and the visible band's foot it is not a keyboard
 *  (the address bar, a rounding step, the home indicator). */
export const MIN_KEYBOARD_PX = 80

/** The app's FULL height in layout px — the frame `position: fixed` is laid out in — which a
 *  keyboard never shrinks: the larger of `innerHeight` and the root's client height (the initial
 *  containing block). Review round 9, the owner's readout in the INSTALLED app: once a finger
 *  touches the page with the keyboard up, iOS collapses `innerHeight` to the visual viewport
 *  (793 → 424) and scrolls the window by the rest (369), while the document and the fixed frame
 *  stay 793 tall (`documentElement.clientHeight` 793 throughout). A live `innerHeight` then reads
 *  «no keyboard». Not the largest `innerHeight` seen (state, to reset on every rotation) and not
 *  `screen.height` less the safe area (852 − 0 ≠ 793: under the opaque status bar the web view
 *  starts 59 px down, which no inset reports). */
export function fullViewHeight(): number {
  return Math.max(window.innerHeight, document.documentElement.clientHeight)
}

/** Where the keyboard's top edge is, in layout (`position: fixed`) px from the top — or null when
 *  no keyboard is up. Pure: the hook feeds it the readings.
 *  · `viewHeight`: the app's full height (`fullViewHeight`), never the live `innerHeight` alone —
 *    the installed app collapses that to the visual viewport (review round 9);
 *  · `vkHeight`: Android's VirtualKeyboard API (index.html asks for `overlays-content`, so there the
 *    visual viewport does not shrink and this is the only true number);
 *  · otherwise a keyboard is up when the visual viewport is at least `MIN_KEYBOARD_PX` shorter than
 *    the full height, and its top edge is the visual viewport's bottom, `offsetTop + height` — even
 *    when iOS's pan (or the installed app's window scroll) has swallowed the whole keyboard and that
 *    bottom is the frame's foot (round 9: 369 + 424 = 793 — the sheet stands at `bottom: 0`);
 *  · a pinch-zoomed page (`scale` ≠ 1) has no band in layout px worth placing a sheet on: null. */
export function keyboardTop(r: { viewHeight: number; vvHeight: number; vvOffsetTop: number; scale?: number; vkHeight?: number }): number | null {
  if (r.vkHeight && r.vkHeight > 0) {
    const top = r.viewHeight - r.vkHeight
    return r.vkHeight >= MIN_KEYBOARD_PX ? Math.max(0, Math.round(top)) : null
  }
  if (Math.abs((r.scale ?? 1) - 1) > 0.01) return null
  if (r.viewHeight - r.vvHeight < MIN_KEYBOARD_PX) return null
  return Math.round(Math.min(r.viewHeight, Math.max(0, r.vvOffsetTop + r.vvHeight)))
}

/** The bottom sheet that holds the field, with the keyboard up: its foot ON the keyboard's top
 *  edge (`bottom`, px from the foot of the full-height frame, `viewHeight`) and at most as tall as
 *  the room between the top bar (`barBottom`) and the keys, less a strip of map kept in sight above
 *  it (`strip`) — never less than `minHeight`, so the field and a row stay usable on the smallest phone. The sheet keeps its
 *  own (Ebenen) height when that is lower: the CSS takes `min(its cap, maxHeight)`.
 *
 *  `pan` is how far iOS has moved the page anyway (`visualViewport.offsetTop`, layout px). The
 *  foot follows the keys by itself (`kbTop` is in layout px, pan included), but the room above
 *  them is the VISIBLE band's: the top bar rides back down by the pan (useViewportPan · --vv-pan),
 *  and a cap measured from the layout's top left the sheet's top — the search field — standing
 *  where the layout put it, i.e. slid up under the bar by the whole pan (review round 5, owner:
 *  «the whole sheet moves instead of the list»). Less the pan, the field keeps its place on the
 *  screen whatever iOS does, and iOS sees the caret where it was. */
export function keySheetBox(r: { viewHeight: number; kbTop: number | null; barBottom: number; strip: number; minHeight: number; pan?: number }): { bottom: number; maxHeight: number } | null {
  if (r.kbTop == null) return null
  const bottom = Math.max(0, Math.round(r.viewHeight - r.kbTop))
  const maxHeight = Math.max(r.minHeight, Math.round(r.kbTop - Math.max(0, r.pan ?? 0) - r.barBottom - r.strip))
  return { bottom, maxHeight }
}

/** Whether a window scroll is the installed app's collapse (review round 10) rather than iOS
 *  bringing a field into sight: `innerHeight` has shrunk below the full height and the scroll is
 *  no more than that shrink (iOS scrolls by exactly `full − innerHeight`). Such a scroll is undone
 *  every time — it carries the whole app with it and says nothing about a hidden caret. */
export function isCollapseScroll(r: { full: number; inner: number; pan: number }): boolean {
  const shrink = r.full - r.inner
  return shrink >= 1 && r.pan >= 1 && r.pan <= shrink + 1
}

/** How often an iOS pan may be undone: at most `max` corrections inside `windowMs`. Past that the
 *  field must be under the keys for real (iOS re-pans as fast as it is undone) — stop fighting and
 *  let iOS show the caret. Pure: returns the kept history, the caller stores it. */
export function mayCorrect(history: readonly number[], now: number, max = 6, windowMs = 1000): { ok: boolean; history: number[] } {
  const recent = history.filter((t) => now - t < windowMs)
  if (recent.length >= max) return { ok: false, history: recent }
  return { ok: true, history: [...recent, now] }
}

/** Focus a field without letting Safari scroll the page to it. For the moment of focus the field
 *  stands 2000px above the screen (nothing to scroll up to), then it is back before the next
 *  paint; `preventScroll` says the same to every browser that honours it. Call it inside the tap
 *  (a click / touchend handler, or an effect React flushes inside it) — iOS raises the keyboard
 *  only for a focus made inside a user gesture. */
export function focusWithoutPan(el: HTMLElement | null) {
  if (!el) return
  // a second call inside the same frame (StrictMode's double effect, a re-render) must restore the
  // field's OWN transform, not the lift the first call put there
  const prev = lifted.get(el) ?? el.style.transform
  lifted.set(el, prev)
  el.style.transform = 'translateY(-2000px)'
  el.focus({ preventScroll: true })
  requestAnimationFrame(() => {
    if (!lifted.has(el)) return
    el.style.transform = lifted.get(el) ?? ''
    lifted.delete(el)
  })
}
const lifted = new WeakMap<HTMLElement, string>()

/** A tap on a field that does not have the caret yet: focused by us (`focusWithoutPan`) instead of
 *  by Safari, which would scroll the page to it first. The tap's own click is cancelled, so the
 *  caret lands at the end — right for the short fields this is for. */
export function noPanTouchEnd(e: React.TouchEvent<HTMLElement>) {
  const el = e.currentTarget
  if (document.activeElement === el || !e.cancelable) return
  e.preventDefault()
  focusWithoutPan(el)
}

/** Guards 2 and 3 (see the head of this file) for a whole surface while `enabled` (the Karte on a
 *  phone). Idle until a text field has the caret; never re-renders anything — the one write is the
 *  root's live height (`--live-h` + `data-typing-lock`, 02-base.css), which it takes back on exit. */
export function useTypingLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const vv = window.visualViewport
    const root = document.documentElement
    let history: number[] = []
    const typing = () => isTypingTarget(document.activeElement)
    const unpan = () => {
      const pan = Math.max(window.scrollY || 0, Math.round(vv?.offsetTop ?? 0))
      if (pan < 1) return
      // pinch-zoomed: the offset is the zoom's, not iOS's pan — leave it to the finger
      if (vv && Math.abs((vv.scale || 1) - 1) > 0.01) return
      if (isCollapseScroll({ full: fullViewHeight(), inner: window.innerHeight, pan })) { window.scrollTo(0, 0); return }
      const next = mayCorrect(history, Date.now())
      history = next.history
      if (next.ok) window.scrollTo(0, 0)
    }
    // the root as tall as the live window, written in the event that changed it (before iOS clamps
    // its scroll to the document) — the installed app's collapse leaves no room to scroll into
    let liveH = -1
    const live = () => {
      const h = window.innerHeight
      if (h === liveH) return
      liveH = h
      root.style.setProperty('--live-h', `${h}px`)
    }
    root.setAttribute('data-typing-lock', '')
    live()
    // a scroll or a viewport change: the root follows, and the pan is undone in the same event —
    // a frame later the phone has already painted the app ridden up (review round 10)
    const now = () => { live(); unpan() }
    let frame = 0
    const soon = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; unpan() }) }
    // a focus moves the page a beat later (the keyboard's animation), and a dismissal can leave it
    // moved with no event at all (iOS): look again after both — and after a touch with the caret
    // up: the installed app's collapse (review round 9, `fullViewHeight`) scrolls the window by
    // the keyboard during the touch, as fast as `mayCorrect` lets it be undone, then fires nothing
    let late: ReturnType<typeof setTimeout>[] = []
    const onFocus = () => { soon(); late.forEach(clearTimeout); late = [setTimeout(unpan, 250), setTimeout(unpan, 600)] }
    const lifted = () => { if (typing()) onFocus() }

    // the drag: a touch that nothing under the finger can scroll does not move the page — judged
    // over the touch's whole travel (overlays/useMobileScrollLock · touchGate, review round 5): a
    // first move a pixel sideways read as «sideways, nothing scrolls that way», was cancelled, and
    // on iOS a cancelled first touchmove kills the list's native scroll for the whole touch
    const gate = touchGate()
    const start = (e: TouchEvent) => {
      const target = e.target instanceof Element ? e.target : null
      // the map pans itself (MapLibre, touch-action: none), a field selects text, and a surface that
      // owns its gesture says so (overlays · data-swipe-ignore)
      // — and a list a drag on which closes the keyboard (useDragClosesKeyboard) is the list's alone
      const free = !!target?.closest('input, textarea, [contenteditable="true"], .maplibregl-canvas-container, [data-swipe-ignore], [data-drag-closes-keys]')
      gate.start(e, { ignored: free, inModal: true })
    }
    const move = (e: TouchEvent) => {
      if (!typing() || !e.cancelable) return
      if (gate.blocks(e)) e.preventDefault()
    }

    vv?.addEventListener('scroll', now)
    vv?.addEventListener('resize', now)
    window.addEventListener('resize', now)
    window.addEventListener('scroll', now, { passive: true })
    window.addEventListener('focusin', onFocus)
    window.addEventListener('focusout', onFocus)
    document.addEventListener('touchstart', start, { passive: true })
    document.addEventListener('touchmove', move, { passive: false })
    document.addEventListener('touchend', lifted, { passive: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      late.forEach(clearTimeout)
      vv?.removeEventListener('scroll', now)
      vv?.removeEventListener('resize', now)
      window.removeEventListener('resize', now)
      window.removeEventListener('scroll', now)
      root.removeAttribute('data-typing-lock')
      root.style.removeProperty('--live-h')
      window.removeEventListener('focusin', onFocus)
      window.removeEventListener('focusout', onFocus)
      document.removeEventListener('touchstart', start)
      document.removeEventListener('touchmove', move)
      document.removeEventListener('touchend', lifted)
    }
  }, [enabled])
}

/** The px the top bar takes from the layout's top (its own box, not where a transform shows it). */
function barBottomOf(sel: string): number {
  const bar = document.querySelector<HTMLElement>(sel)
  return bar ? bar.offsetTop + bar.offsetHeight : 0
}

/** Guard 1's placement: while a text field INSIDE `ref` has the caret and a keyboard is up, the
 *  element gets `data-kb` and `--ks-bottom` / `--ks-max` (keySheetBox) — written per frame on the
 *  element, never a React render. Off the keyboard both go, and the sheet is its normal self.
 *  The switch between the two placements is one movement (owner, review round 12: from typing to
 *  scrolling «isn't that abrupt»): for `KS_MOVE_MS` after `data-kb` comes or goes the element also
 *  wears `data-ks-move`, which the CSS animates (Karte.module.css · .keySheet[data-ks-move]). Only
 *  then — a re-placement ON the keys (iOS's pan, the installed app's collapse) stays instant. */
export const KS_MOVE_MS = 300

export function useKeySheet(ref: RefObject<HTMLElement | null>, { bar = '.topbar', strip = 24, minHeight = 132 } = {}) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const vv = window.visualViewport
    const vk = (navigator as Navigator & { virtualKeyboard?: EventTarget & { boundingRect?: DOMRectReadOnly } }).virtualKeyboard
    let frame = 0
    let last = ''
    let first = true
    let move: ReturnType<typeof setTimeout> | undefined
    const measure = () => {
      frame = 0
      const focused = el.contains(document.activeElement) && isTypingTarget(document.activeElement)
      const viewHeight = fullViewHeight()
      const kbTop = !focused ? null : keyboardTop({
        viewHeight, vvHeight: vv?.height ?? viewHeight, vvOffsetTop: vv?.offsetTop ?? 0,
        scale: vv?.scale ?? 1, vkHeight: vk?.boundingRect?.height ?? 0,
      })
      // Android (VirtualKeyboard) does not pan under `overlays-content`; iOS's pan is the offset
      const pan = vk?.boundingRect?.height ? 0 : (vv?.offsetTop ?? 0)
      const box = keySheetBox({ viewHeight, kbTop, barBottom: barBottomOf(bar), strip, minHeight, pan })
      const key = box ? `${box.bottom}|${box.maxHeight}` : ''
      const wasFirst = first
      first = false
      if (key === last) return
      // the keys came or went (not the sheet's first frame: its entrance is its own)
      if (!wasFirst && !last !== !key) {
        el.setAttribute('data-ks-move', '')
        clearTimeout(move)
        move = setTimeout(() => el.removeAttribute('data-ks-move'), KS_MOVE_MS)
      }
      last = key
      if (box) {
        el.style.setProperty('--ks-bottom', `${box.bottom}px`)
        el.style.setProperty('--ks-max', `${box.maxHeight}px`)
        el.setAttribute('data-kb', '')
      } else {
        el.style.removeProperty('--ks-bottom')
        el.style.removeProperty('--ks-max')
        el.removeAttribute('data-kb')
      }
    }
    const update = () => { if (!frame) frame = requestAnimationFrame(measure) }
    let late: ReturnType<typeof setTimeout>[] = []
    const onFocus = () => { update(); late.forEach(clearTimeout); late = [setTimeout(update, 250), setTimeout(update, 700)] }
    vv?.addEventListener('resize', update)
    vv?.addEventListener('scroll', update)
    vk?.addEventListener('geometrychange', update)
    window.addEventListener('resize', update)
    window.addEventListener('focusin', onFocus)
    window.addEventListener('focusout', onFocus)
    update()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      late.forEach(clearTimeout)
      clearTimeout(move)
      vv?.removeEventListener('resize', update)
      vv?.removeEventListener('scroll', update)
      vk?.removeEventListener('geometrychange', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('focusin', onFocus)
      window.removeEventListener('focusout', onFocus)
    }
  }, [ref, bar, strip, minHeight])
}

/** Travel (px) after which a touch on a sheet's list is a drag, not a tap: the keyboard closes.
 *  Above iOS's own tap wobble, so a row still opens with the keys up. */
export const DRAG_SLOP_PX = 8

/** Is a touch's travel since touchstart (`dx`/`dy`, px, either sign) a vertical drag — the one that
 *  closes the keyboard? A tap's wobble and a sideways swipe are not. Pure. */
export function isListDrag(dx: number, dy: number, slop = DRAG_SLOP_PX): boolean {
  return Math.abs(dy) >= slop && Math.abs(dy) > Math.abs(dx)
}

/** The owner's pick (head of this file): a vertical drag that starts on `body` (a selector inside
 *  `ref`, marked `data-drag-closes-keys` so guard 3 leaves it alone) blurs the field inside `ref`
 *  that has the caret — once per touch, as soon as `isListDrag` says so. Passive: the touch is never
 *  cancelled, so iOS may go on scrolling the list with it. Used by components/karte/KarteKeySheet. */
export function useDragClosesKeyboard(ref: RefObject<HTMLElement | null>, body: string) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let from: { x: number; y: number } | null = null
    const start = (e: TouchEvent) => {
      const t = e.touches[0]
      const target = e.target instanceof Element ? e.target : null
      from = t && e.touches.length === 1 && target?.closest(body) ? { x: t.clientX, y: t.clientY } : null
    }
    const move = (e: TouchEvent) => {
      const t = e.touches[0]
      if (!from || !t || !isListDrag(t.clientX - from.x, t.clientY - from.y)) return
      from = null
      const caret = document.activeElement
      if (caret instanceof HTMLElement && el.contains(caret) && isTypingTarget(caret)) caret.blur()
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: true })
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
    }
  }, [ref, body])
}
