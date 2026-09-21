import { useEffect, useRef, useState } from 'react'
import { buzz } from './haptics'

export const HOLD_MS = 350 // hold longer than this offers the choice instead of opening the composer — the charge ring (HoldChargeRing) fills over exactly this window
const CUE_MS = 130 // delay the charging cue so a quick tap doesn't flash it

/** What the chooser offers. Closing it is the BUTTON itself, which wears an ✕ while it is up —
 *  the most guessable way out there is, and it needs no extra target on screen. */
export type HoldTarget = 'audio' | 'photo'

/** Where the host button was when the hold latched — the portalled chooser anchors to it and the
 *  button freezes itself to `width` for the turn.
 *  ⚠️ `width` is offsetWidth, NOT the rect's: the phone FAB is `:active` for the whole press and
 *  carries a `scale(.95)`, which a bounding rect faithfully reports — freezing the button to that
 *  would visibly shrink it the moment it became an ✕. The edges stay rect-derived, since those
 *  should follow the button to where it actually appears. */
export type HoldAnchor = { top: number; right: number; bottom: number; width: number }

/** a click this soon after the hold's own release is that release, not a tap on the ✕ */
const RELEASE_CLICK_MS = 400

/**
 * Shared tap / press-and-hold interaction for the journal "Eintrag" affordance, used by both
 * the TopBar button and the mobile FAB so they behave identically:
 *   • not recording — a quick tap fires onTap (open composer); holding past HOLD_MS opens a small
 *     chooser (Sprachnotiz · Foto) that STAYS OPEN until one of them is tapped.
 *   • recording — a tap fires onHoldStop (stop + save).
 *
 * ⚠️ The hold OPENS, a tap CHOOSES (21.09.2026). Until then the finger slid from the button onto
 * an option and the release chose it – which cannot work for «Foto» on an iPhone: WebKit opens a
 * file picker only for a real TAP, a touch that held and slid is never one, and it refuses
 * silently (`navigator.userActivation.isActive` even reads true while it does). Two rounds of
 * detecting the refusal ended with «release, then tap once more» for Foto and «release» for the
 * Sprachnotiz – one chooser, two grammars. Now both are the same: hold, let go, tap. The button
 * itself is the ✕ while the chooser is up, and a press anywhere else closes it too; nothing
 * happens on release, so a hold you thought better of still leaves nothing behind.
 *
 * ⚠️ A plain TAP resolves on CLICK, not on pointerup. That split is not tidiness — iOS does not
 * reliably deliver the pointerup for a tap, so with the tap on pointerup every press on the
 * phone FAB fell through to the hold timer. See `onClick`, which is also why there is no
 * keydown handler.
 */
export function useHoldEntry(opts: {
  recording: boolean
  onTap: () => void
  onHoldStart: () => void
  onHoldStop: () => void
  /** «Foto» in the chooser — straight to the camera. Omit and a hold offers nothing. */
  onHoldPhoto?: () => void
}) {
  const holdTimer = useRef<number | null>(null)
  const pressCue = useRef<number | null>(null)
  const holding = useRef(false)
  /** the pointer phase already acted on this interaction — swallow the click that follows */
  const resolved = useRef(false)
  /** when the hold that opened the chooser was let go — see RELEASE_CLICK_MS */
  const releasedAt = useRef(0)
  /** the host button, measured when the hold latches so the chooser can anchor to it */
  const hostRef = useRef<HTMLElement | null>(null)
  const [anchor, setAnchor] = useState<HoldAnchor | null>(null)
  /** tears down the window-level release listeners (see onPointerDown) */
  const detach = useRef<(() => void) | null>(null)
  const [pressing, setPressing] = useState(false)
  /** press start stamp — the charge ring runs on THIS clock (useTimedProgress), so the fill and
   *  the latch cannot drift apart the way the old .22s CSS bar did against the 350ms timer */
  const [pressedSince, setPressedSince] = useState<number | null>(null)
  // the chooser is only offered where there is something in it to choose
  const targets = !!opts.onHoldPhoto
  /** the chooser is up — and stays up until it is answered or closed */
  const [latched, setLatched] = useState(false)
  const latchedRef = useRef(false)
  const close = () => { latchedRef.current = false; setLatched(false); setAnchor(null) }

  // a press anywhere but the chooser or its button closes it
  useEffect(() => {
    if (!latched) return
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (t?.closest?.('[data-hold-target]') || (hostRef.current && t && hostRef.current.contains?.(t))) return
      close()
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [latched])

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // the button is the ✕ of an open chooser: that press is a plain tap, settled in onClick
    if (latchedRef.current) return
    hostRef.current = e.currentTarget
    holding.current = true
    resolved.current = false

    // ⚠️ The release is heard on the WINDOW, not only on the button. The button's own
    // pointerup is not dependable — iOS drops it, and a dropped release meant the hold timer
    // fired on what was really a tap. A capture-phase window listener hears the finger lift
    // whatever the element does with the event; the button's own handlers still fire and `end`
    // no-ops the second call.
    detach.current?.()
    const up = () => end(false)
    const cancel = () => end(true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', cancel, true)
    window.addEventListener('touchend', up, true)
    detach.current = () => {
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', cancel, true)
      window.removeEventListener('touchend', up, true)
    }

    if (opts.recording) return // a press while recording just stops it on release
    setPressedSince(Date.now())
    pressCue.current = window.setTimeout(() => { if (holding.current) setPressing(true) }, CUE_MS)
    holdTimer.current = window.setTimeout(() => {
      if (!holding.current) return
      setPressing(false)
      if (!targets) return
      const el = hostRef.current
      const r = el?.getBoundingClientRect()
      setAnchor(el && r ? { top: r.top, right: r.right, bottom: r.bottom, width: el.offsetWidth } : null)
      latchedRef.current = true
      setLatched(true); buzz() // the hold just armed — the chooser is up
    }, HOLD_MS)
  }

  // iPadOS / some tablets deliver `pointercancel` instead of `pointerup` for a clean tap (the
  // OS speculatively claims the touch as a gesture). A cancel is a release by any other name —
  // the finger left the screen — so it resolves the gesture exactly as an up would, and it also
  // has to stand in for the CLICK that will never arrive after it.
  const onPointerCancel = () => end(true)
  const onPointerUp = () => end(false)

  /** `fromCancel` — no click is coming, so a plain tap has to be settled here. */
  const end = (fromCancel: boolean) => {
    if (!holding.current) return
    holding.current = false
    detach.current?.(); detach.current = null
    setPressing(false)
    setPressedSince(null)
    if (pressCue.current) { clearTimeout(pressCue.current); pressCue.current = null }
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null }
    if (latchedRef.current) {
      // letting go of the hold does NOTHING — the chooser is answered by a tap. The click this
      // release may still produce on the button is not a tap on its ✕ (RELEASE_CLICK_MS).
      resolved.current = true
      releasedAt.current = Date.now()
      return
    }
    if (opts.recording) { resolved.current = true; opts.onHoldStop(); return } // tap → stop
    if (fromCancel) { resolved.current = true; opts.onTap() }
    // …otherwise leave the plain tap to the click below.
  }

  /**
   * ⚠️ A plain TAP is settled here, not on pointerup. Two reasons, both of which bit:
   *
   * On iOS the pointer stream for a tap is not dependable — the up can go missing and only a
   * late cancel arrives, by which time the hold timer has fired. `click` is the one signal every
   * platform gets right, and it covers Enter/Space on a focused button for free (which is why
   * there is no keydown handler: that one fired onTap and then the browser's own click fired it
   * again).
   *
   * And it fixes the ghost click the other way round: the composer now mounts DURING this
   * click's dispatch rather than before it, so the same tap can no longer be re-delivered to
   * whatever appeared under the finger — which is how tapping «Eintrag» opened the camera.
   */
  const onClick = () => {
    if (latchedRef.current) {
      // the click that belongs to the hold's own release is swallowed; any later one is the ✕
      const own = resolved.current && Date.now() - releasedAt.current < RELEASE_CLICK_MS
      resolved.current = false
      if (!own) close()
      return
    }
    if (resolved.current) { resolved.current = false; return } // the pointer phase already acted
    if (opts.recording) { opts.onHoldStop(); return }
    opts.onTap()
  }

  return {
    pressing,
    /** when the current press began — drives the charge ring while `pressing` is true */
    pressedSince,
    /** the chooser is up — render the targets while this is true; the button is its ✕ */
    latched,
    /** the host button's rect at latch time — the portalled chooser anchors to it */
    anchor,
    /** a target was TAPPED. A real click, so «Foto» carries the activation a file picker needs. */
    pick: (t: HoldTarget) => {
      if (!latchedRef.current) return
      close()
      if (t === 'photo') opts.onHoldPhoto?.()
      else if (t === 'audio') opts.onHoldStart()
    },
    handlers: {
      onPointerDown,
      onPointerUp,
      onPointerCancel,
      onClick,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
      // holding IS this control's gesture — the global hold-tooltip (lib/holdTooltip) must
      // never claim it
      'data-holdaction': true as const,
    },
  }
}
