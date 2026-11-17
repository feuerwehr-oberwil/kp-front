/*
 * **The way out of a layer** (duck sweep 17.11.2026, owner calls 2 + 3) – ONE mechanism for every
 * container that opens over or beside the work:
 *
 * - **A tap beside it only closes it.** The whole gesture is swallowed – it never reaches the map,
 *   the board or a list underneath, so it cannot place, select or deselect anything (CONT.1). The
 *   Base UI `Menu` and `Popover` get the same from their modal backdrop; a hand-rolled container
 *   gets it here (`useLayer`).
 * - **One Esc closes one thing.** The key is taken in the CAPTURE phase on `window` and stopped, so
 *   no surface ladder (Lage, Plan, Karte) peels a second layer with the same press (CONT.2). A
 *   field keeps its own Esc (it leaves the field first), a dialog or menu with the focus keeps its.
 * - **The native back closes the top layer** (Android's back, the iOS edge swipe), one per press;
 *   with nothing open it does what it did before (CONT.4, `useBackLayer`). Every primitive – Sheet,
 *   Overlay, ConfirmCard, Menu, Popover – and every `useLayer` container registers.
 * - **Focus goes back to the opener** when a hand-rolled layer closes with the focus inside it, so
 *   the next key press after Esc lands somewhere (CONT.8).
 *
 * Only the TOPMOST hand-rolled layer answers a tap or a key – a second one open under it waits for
 * its own turn. A press on something that opened ABOVE it (a sheet, a confirm, a toast) is not
 * «outside»: that surface owns it.
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { isWalkPop, pushAppEntry, walkBack, whenSettled } from '../../objectVisits/route'
import { isTextField } from './fieldFirst'

// ── the native back (CONT.4) ────────────────────────────────────────────────────────────────────

/*
 * ⚠️ ONE history entry for however many layers are open, not one per layer. A layer closed by its
 * ✕ has to take its entry away again (`walkBack`, async), and a sheet that hands over to the next
 * one (close A, open B in the same tick) would otherwise race its own walk. So: the first layer to
 * open pushes the entry (counted – objectVisits/route · pushAppEntry, so `leaveAppEntries` walks
 * over it like any other), the back gesture that leaves it closes the TOP layer and pushes it again
 * while more stay open, and the last layer to close walks it back – a task later, once a hand-over
 * has had its chance to open the next.
 */
const ENTRY = 'kpLayer'
type BackLayer = { close: () => void }
const backStack: BackLayer[] = []
let entryPushed = false
let syncQueued = false

const onEntry = () => !!(window.history.state as Record<string, unknown> | null)?.[ENTRY]

function syncEntry(): void {
  whenSettled(() => {
    if (backStack.length && !entryPushed) {
      pushAppEntry(window.location.href, { [ENTRY]: true })
      entryPushed = true
    } else if (!backStack.length && entryPushed) {
      entryPushed = false
      // re-checked on landing: a layer that opened while the walk was under way needs an entry
      if (onEntry()) walkBack(1, scheduleSync)
    }
  })
}

function scheduleSync(): void {
  if (syncQueued) return
  syncQueued = true
  setTimeout(() => { syncQueued = false; syncEntry() }, 0)
}

function onPop(e: PopStateEvent): void {
  // a walk is someone leaving (or our own clean-up), not the user's back
  if (isWalkPop(e) || !entryPushed || onEntry()) return
  entryPushed = false
  backStack[backStack.length - 1]?.close()
  scheduleSync()
}
// after objectVisits/route's own listener (imported above), which turns a FORWARD step around first
if (typeof window !== 'undefined') window.addEventListener('popstate', onPop)

/** Test seam – the stack is module state. */
export function resetBackLayers(): void {
  backStack.length = 0
  entryPushed = false
  syncQueued = false
}

/**
 * The native back closes this layer while `open` – one layer per press, the newest first. Every
 * overlay primitive calls it; a hand-rolled container gets it through `useLayer`.
 */
export function useBackLayer(open: boolean, close: () => void): void {
  const latest = useRef(close)
  useEffect(() => { latest.current = close })
  useEffect(() => {
    if (!open) return
    const layer: BackLayer = { close: () => latest.current() }
    backStack.push(layer)
    scheduleSync()
    return () => {
      const i = backStack.indexOf(layer)
      if (i >= 0) backStack.splice(i, 1)
      scheduleSync()
    }
  }, [open])
}

// ── the outside tap (CONT.1) ────────────────────────────────────────────────────────────────────

/** The events of one gesture after its `pointerdown`. All of them stop at `window` until it ends. */
const TAIL_EVENTS = ['pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'touchcancel'] as const
/** No click follows a drag; the gesture counts as over this long after the finger lifted. */
const TAIL_MS = 400
/** the swallow under way, so the next gesture can end it */
let endSwallow: (() => void) | null = null

/**
 * Swallow the rest of the gesture whose `pointerdown` is `down`: the finger that closed a layer
 * neither pans, nor taps, nor holds whatever lay under it. `touchstart` is cancelled too – that is
 * what keeps a touch from synthesising the mouse events and the click a map listens to. A click is
 * the gesture's only once its finger has lifted, and the next `pointerdown` is a new gesture.
 */
export function swallowGesture(down: PointerEvent): void {
  endSwallow?.()
  down.preventDefault()
  down.stopPropagation()
  let lifted = false
  let timer = 0
  const stop = (e: Event) => {
    if ((e.type === 'click' || e.type === 'dblclick') && !lifted) return
    e.stopPropagation()
    if (e.cancelable) e.preventDefault()
    if (e.type === 'pointerup' || e.type === 'pointercancel' || e.type === 'touchend' || e.type === 'touchcancel') {
      lifted = true
      clearTimeout(timer)
      timer = window.setTimeout(end, TAIL_MS)
    }
    if (e.type === 'click') end()
  }
  const end = () => {
    clearTimeout(timer)
    for (const t of TAIL_EVENTS) window.removeEventListener(t, stop, true)
    window.removeEventListener('pointerdown', end, true)
    if (endSwallow === end) endSwallow = null
  }
  for (const t of TAIL_EVENTS) window.addEventListener(t, stop, { capture: true, passive: false })
  window.addEventListener('pointerdown', end, true)
  endSwallow = end
  // a gesture whose end never arrives (the element under it went away) still lets go
  timer = window.setTimeout(end, 3000)
}

// ── the hand-rolled layer ───────────────────────────────────────────────────────────────────────

/** Surfaces that open ABOVE a hand-rolled layer and own their presses: a press there is not «outside».
 *  `[data-base-ui-inert]` is the invisible backdrop of a Base UI menu / popover – it takes that tap. */
const ABOVE = '[role="dialog"], [role="alertdialog"], [role="menu"], [data-base-ui-inert], .ui-backdrop, .help-scrim, .confirm-backdrop, .toaster'
/** Where the focus says somebody else owns Escape: a dialog, a menu. */
const KEY_OWNER = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'

type HandLayer = { inside: (t: Node) => boolean }
const handStack: HandLayer[] = []

/** inside ANY open hand-rolled layer – that one is not «above», it is the next layer down */
const inHandLayer = (t: Node) => handStack.some((l) => l.inside(t))

export interface LayerOptions {
  open: boolean
  onClose: () => void
  /** What counts as inside: the container and the control that toggles it (a press there is its own). */
  inside: ReadonlyArray<RefObject<Element | null>>
  /** Focus goes back here when the layer closes with the focus inside it. Default: whatever had the
   *  focus when the layer opened (the opener), if anything did. */
  returnFocus?: RefObject<HTMLElement | null>
  /** A sheet opened FROM this layer holds the screen: the layer waits under it, deaf to taps and Esc. */
  suspended?: boolean
  /** `false`: the container answers Escape itself (ComboMenu: Esc in its search row closes the
   *  list, it does not merely leave the field). It still counts as the top layer for the others. */
  escape?: boolean
  /** `false`: no outside-tap rule (a mode, not a container – the armed ✥ ⟳, a fanned pile). */
  outside?: boolean
  /** `false`: the native back leaves it alone (a mode is not a layer the back gesture closes). */
  back?: boolean
}

/**
 * Give a hand-rolled container (a menu, a floating card, a dock) the app's one way out – see the
 * file header: a tap beside it only closes it, one Esc closes it alone, the native back closes it,
 * focus returns to its opener.
 *
 *   const card = useRef<HTMLDivElement>(null), chip = useRef<HTMLButtonElement>(null)
 *   useLayer({ open, onClose: close, inside: [card, chip], returnFocus: chip })
 *
 * A transient MODE on a surface (the armed ✥ ⟳, a fanned pile) joins the same Esc stack with
 * `{ inside: [], outside: false, back: false }`: its Esc is taken first and alone, the selection
 * under it stays.
 */
export function useLayer({ open, onClose, inside, returnFocus, suspended = false, escape = true, outside = true, back = true }: LayerOptions): void {
  const latest = useRef({ onClose, inside, returnFocus })
  useEffect(() => { latest.current = { onClose, inside, returnFocus } })
  useBackLayer(open && back, onClose)
  useEffect(() => {
    if (!open || suspended) return
    const layer: HandLayer = { inside: (t) => latest.current.inside.some((r) => !!r.current?.contains(t)) }
    handStack.push(layer)
    const top = () => handStack[handStack.length - 1] === layer
    const onDown = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null
      if (!outside || !t || !top() || layer.inside(t)) return
      // a surface above us owns its press – unless it is the sheet this layer itself sits IN (a
      // ComboMenu's own sheet: a tap on the next field there is «beside» the list)
      const host = t.closest(ABOVE)
      if (host && !inHandLayer(t) && !latest.current.inside.some((r) => !!r.current && host.contains(r.current))) return
      swallowGesture(e)
      latest.current.onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (!escape || e.key !== 'Escape' || !top() || e.defaultPrevented) return
      const t = e.target instanceof Element ? e.target : null
      // a field leaves itself first (its own Esc keeps what was typed and blurs)
      if (t && isTextField(t)) return
      // a dialog or a menu with the focus owns the key – unless it is this very layer
      if (t?.closest(KEY_OWNER) && !inHandLayer(t)) return
      if (document.querySelector('.confirm-card')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      latest.current.onClose()
    }
    window.addEventListener('pointerdown', onDown, { capture: true, passive: false })
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      const i = handStack.indexOf(layer)
      if (i >= 0) handStack.splice(i, 1)
    }
  }, [open, suspended, escape, outside])
  // closing – or unmounting – with the focus inside (or already dropped to <body>): back to the
  // opener. A LAYOUT effect, so the opener is read before a layer's own effect moves the focus in
  // (Ebenen focuses its first row).
  useLayoutEffect(() => {
    if (!open) return
    const a = document.activeElement
    const opener = a instanceof HTMLElement && a !== document.body ? a : null
    return () => {
      const to = latest.current.returnFocus?.current ?? opener
      const now = document.activeElement
      if (to && to.isConnected && (!now || now === document.body || latest.current.inside.some((r) => r.current?.contains(now)))) to.focus({ preventScroll: true })
    }
  }, [open])
}

/** Test seam – the stacks are module state. */
export function resetLayers(): void {
  endSwallow?.()
  handStack.length = 0
  resetBackLayers()
}
