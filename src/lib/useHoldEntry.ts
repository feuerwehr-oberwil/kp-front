import { useEffect, useRef, useState } from 'react'
import { buzz } from './haptics'

export const HOLD_MS = 350 // hold longer than this offers the choice instead of opening the composer — the charge ring (HoldChargeRing) fills over exactly this window
const CUE_MS = 130 // delay the charging cue so a quick tap doesn't flash it

/** What a hold can be released onto. `cancel` is the BUTTON itself: while the chooser is up it
 *  turns into an ✕, so putting the finger back where it started undoes the whole gesture — the
 *  most guessable cancel there is, and it needs no extra target on screen. It is also where the
 *  finger already is when the hold latches, so nothing happens unless you deliberately move. */
export type HoldTarget = 'audio' | 'photo' | 'cancel'

/** Where the host button was when the hold latched — the portalled chooser anchors to it and the
 *  button freezes itself to `width` for the turn.
 *  ⚠️ `width` is offsetWidth, NOT the rect's: the phone FAB is `:active` for the whole press and
 *  carries a `scale(.95)`, which a bounding rect faithfully reports — freezing the button to that
 *  would visibly shrink it the moment it became an ✕. The edges stay rect-derived, since those
 *  should follow the button to where it actually appears. */
export type HoldAnchor = { top: number; right: number; bottom: number; width: number }

/** how long a «Foto» that could not open the camera waits for its confirming tap */
export const STICKY_MS = 6000
/** …and how long after `input.click()` the page is looked at to see whether a picker opened */
export const PICKER_CHECK_MS = 500

/**
 * May a file picker be opened RIGHT NOW? `input.click()` needs transient user activation, and a
 * browser that withholds it does so silently – no event, no error. WebKit grants a touch its
 * activation only when it was a potential TAP, and a hold that slid onto «Foto» is by definition
 * not one: on the iPhone the release opened nothing at all (field report 20.09.2026), while the
 * Sprachnotiz beside it worked, because a microphone asks a permission, not a gesture.
 * A browser that cannot say (no `navigator.userActivation`) is assumed willing, as before.
 */
const canOpenPicker = () => (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? true

/**
 * Shared tap / press-and-hold interaction for the journal "Eintrag" affordance, used by both
 * the TopBar button and the mobile FAB so they behave identically:
 *   • not recording — a quick tap fires onTap (open composer); holding past HOLD_MS offers two
 *     targets (Sprachnotiz · Foto) and the finger can slide onto one before releasing.
 *   • recording — a tap fires onHoldStop (stop + save).
 *
 * ⚠️ NOTHING happens while the finger is still down, and nothing happens unless the finger
 * MOVES. The hold used to latch a voice memo the instant it passed HOLD_MS, so the button went
 * red and the mic opened before the chooser had been answered. Now the hold only offers the
 * choice: the options stack away from the button in one direction (up from the phone FAB, down
 * from the TopBar) and the button itself becomes ✕, so releasing where you started cancels.
 * One gesture, one outcome, and a hold you thought better of leaves nothing behind.
 *
 * ⚠️ A HOLD resolves on pointerup/pointercancel; a plain TAP resolves on CLICK. That split is
 * not tidiness — iOS does not reliably deliver the pointerup for a tap, so with the tap on
 * pointerup every press on the phone FAB fell through to the hold timer and started recording.
 * See `onClick`, which is also why there is no keydown handler.
 */
export function useHoldEntry(opts: {
  recording: boolean
  onTap: () => void
  onHoldStart: () => void
  onHoldStop: () => void
  /** released over «Foto» — go straight to the camera. Omit to keep the hold audio-only. */
  onHoldPhoto?: () => void
}) {
  const holdTimer = useRef<number | null>(null)
  const pressCue = useRef<number | null>(null)
  const holding = useRef(false)
  const latchedRef = useRef(false)
  /** the pointer phase already acted on this interaction — swallow the click that follows */
  const resolved = useRef(false)
  /** the host button, measured when the hold latches so the chooser can anchor to it */
  const hostRef = useRef<HTMLElement | null>(null)
  const [anchor, setAnchor] = useState<HoldAnchor | null>(null)
  /** tears down the window-level release listeners (see onPointerDown) */
  const detach = useRef<(() => void) | null>(null)
  const [pressing, setPressing] = useState(false)
  /** press start stamp — the charge ring runs on THIS clock (useTimedProgress), so the fill and
   *  the latch cannot drift apart the way the old .22s CSS bar did against the 350ms timer */
  const [pressedSince, setPressedSince] = useState<number | null>(null)
  // the targets are only offered where there is somewhere to slide TO
  const targets = !!opts.onHoldPhoto
  const [latched, setLatched] = useState(false)
  const [hover, setHover] = useState<HoldTarget | null>(null)
  const hoverRef = useRef<HoldTarget | null>(null)
  const setHoverTarget = (t: HoldTarget | null) => { hoverRef.current = t; setHover(t) }
  /** «Foto» was chosen but the release carried no activation: the chooser STAYS, lit on Foto, and
   *  the next real tap on it opens the camera (see canOpenPicker). Anything else lets it go. */
  const [sticky, setSticky] = useState(false)
  const stickyTimer = useRef<number | null>(null)
  const unstick = () => {
    if (stickyTimer.current) { clearTimeout(stickyTimer.current); stickyTimer.current = null }
    setSticky(false); setLatched(false); setHoverTarget(null); setAnchor(null)
  }
  const stick = () => {
    setSticky(true); setLatched(true); setHoverTarget('photo')
    if (stickyTimer.current) clearTimeout(stickyTimer.current)
    stickyTimer.current = window.setTimeout(unstick, STICKY_MS)
  }
  // a press anywhere but the chooser or its button lets a waiting «Foto» go
  useEffect(() => {
    if (!sticky) return
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (t?.closest?.('[data-hold-target]') || (hostRef.current && t && hostRef.current.contains(t))) return
      unstick()
    }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sticky])
  useEffect(() => () => { if (stickyTimer.current) clearTimeout(stickyTimer.current) }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // the button is the ✕ of a waiting «Foto»: that press is a plain tap, settled in onClick
    if (sticky) return
    hostRef.current = e.currentTarget
    e.currentTarget.setPointerCapture?.(e.pointerId)
    holding.current = true
    latchedRef.current = false
    resolved.current = false
    setHoverTarget(null) // never inherit a choice from the previous gesture

    // ⚠️ The release is heard on the WINDOW, not only on the button. The button's own
    // pointerup is not dependable — iOS drops it, and a dropped release meant the hold timer
    // fired on what was really a tap, so every press on the phone FAB resolved as a hold and
    // started recording. A capture-phase window listener hears the finger lift whatever the
    // element does with the event; the button's own handlers still fire and `end` no-ops the
    // second call.
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
      latchedRef.current = true
      setPressing(false)
      if (targets) {
        const el = hostRef.current
        const r = el?.getBoundingClientRect()
        setAnchor(el && r ? { top: r.top, right: r.right, bottom: r.bottom, width: el.offsetWidth } : null)
        setLatched(true); setHoverTarget('cancel'); buzz() // the finger is on the button, i.e. on ✕ — and the hold just armed
      }
    }, HOLD_MS)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!latchedRef.current || !holding.current) return
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const t = el?.closest?.('[data-hold-target]')?.getAttribute('data-hold-target')
    // Only a real zone changes the selection. The finger travels through a few px of gap
    // between the stacked options, and a value that flickered to «nothing» mid-slide would
    // decide the gesture on wherever it happened to be at the instant it lifted. The BUTTON is
    // a zone too — sliding back onto it re-arms the cancel.
    if (t === 'audio' || t === 'photo' || t === 'cancel') setHoverTarget(t)
  }

  // iPadOS / some tablets deliver `pointercancel` instead of `pointerup` for a clean tap (the
  // OS speculatively claims the touch as a gesture). A cancel is a release by any other name —
  // the finger left the screen — so it resolves the gesture exactly as an up would, and it also
  // has to stand in for the CLICK that will never arrive after it.
  const onPointerCancel = () => end(true)
  const onPointerUp = () => end(false)

  /**
   * Release over «Foto». ⚠️ Whether the camera may open cannot be ASKED, only observed: on the
   * iPhone `navigator.userActivation.isActive` is true at this point and `input.click()` is
   * refused all the same (field report 20.09.2026, after the first fix trusted the flag) – WebKit
   * wants a TAP for a file picker, and a slid touch is not one. So the camera is tried, and then
   * the page is looked at: a picker that opened takes the focus or hides the document; a page
   * still standing there untouched means nothing opened, and the chooser stays lit on «Foto» for
   * the confirming tap. The chooser is left up for that beat either way, so nothing flickers.
   * A browser that says outright it will refuse is not even tried.
   */
  const releasePhoto = () => {
    const fire = opts.onHoldPhoto
    if (!fire) return
    if (!canOpenPicker()) { stick(); return }
    fire()
    window.setTimeout(() => {
      if (document.hasFocus() && document.visibilityState === 'visible') stick()
      else unstick()
    }, PICKER_CHECK_MS)
  }

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
      latchedRef.current = false
      const pick = hoverRef.current
      const photo = pick === 'photo' && !!opts.onHoldPhoto
      // a «Foto» keeps the chooser up until it is known whether the camera opened (releasePhoto)
      if (!photo) { setLatched(false); setHoverTarget(null); setAnchor(null) }
      resolved.current = true
      // THIS is where a HOLD acts — one outcome, chosen by where the finger let go. Anything
      // that is not one of the two options (the ✕, the gap, off-screen) does NOTHING: a hold
      // you thought better of has to be abandonable without leaving a recording behind.
      if (photo) releasePhoto()
      else if (pick === 'audio') opts.onHoldStart()
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
   * late cancel arrives, by which time the hold timer has fired, so EVERY tap on the phone FAB
   * resolved as a hold and started recording. `click` is the one signal every platform gets
   * right, and it covers Enter/Space on a focused button for free (which is why there is no
   * keydown handler: that one fired onTap and then the browser's own click fired it again).
   *
   * And it fixes the ghost click the other way round: the composer now mounts DURING this
   * click's dispatch rather than before it, so the same tap can no longer be re-delivered to
   * whatever appeared under the finger — which is how tapping «Eintrag» opened the camera.
   */
  const onClick = () => {
    if (sticky) { resolved.current = false; unstick(); return } // the button is the ✕ of a waiting «Foto»
    if (resolved.current) { resolved.current = false; return } // the pointer phase already acted
    if (opts.recording) { opts.onHoldStop(); return }
    opts.onTap()
  }

  return {
    pressing,
    /** when the current press began — drives the charge ring while `pressing` is true */
    pressedSince,
    /** the hold has latched — render the two slide targets while this is true */
    latched,
    /** which target the finger is currently over (drives the highlight) */
    hover,
    /** the host button's rect at latch time — the portalled chooser anchors to it */
    anchor,
    /** a released «Foto» is waiting for its confirming TAP — the targets answer taps while true */
    sticky,
    /** that tap. A real click, so it carries the activation the release did not. */
    pickSticky: (t: HoldTarget) => {
      if (!sticky) return
      unstick()
      if (t === 'photo') opts.onHoldPhoto?.()
    },
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClick,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
      // holding IS this control's gesture (slide to Sprachnotiz/Foto) — the global hold-tooltip
      // (lib/holdTooltip) must never claim it
      'data-holdaction': true as const,
    },
  }
}
