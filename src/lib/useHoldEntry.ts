import { useRef, useState } from 'react'

const HOLD_MS = 350 // hold longer than this offers the choice instead of opening the composer
const CUE_MS = 130 // delay the charging cue so a quick tap doesn't flash it

/** What a hold can be released onto. `audio` is the default — release without moving and you
 *  get the voice memo. */
export type HoldTarget = 'audio' | 'photo'

/**
 * Shared tap / press-and-hold interaction for the journal "Eintrag" affordance, used by both
 * the TopBar button and the mobile FAB so they behave identically:
 *   • not recording — a quick tap fires onTap (open composer); holding past HOLD_MS offers two
 *     targets (Sprachnotiz · Foto) and the finger can slide onto one before releasing.
 *   • recording — a tap fires onHoldStop (stop + save).
 *
 * ⚠️ NOTHING happens while the finger is still down. The hold used to latch a voice memo the
 * instant it passed HOLD_MS, so the button went red and the mic opened before the chooser had
 * been answered — and picking «Foto» then had to throw that recording away. The action fires on
 * RELEASE, from whichever target is selected: one gesture, one outcome, and no recording nobody
 * asked for. The cost is that the memo starts a few hundred ms later than it used to.
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
  const [pressing, setPressing] = useState(false)
  // the targets are only offered where there is somewhere to slide TO
  const targets = !!opts.onHoldPhoto
  const [latched, setLatched] = useState(false)
  const [hover, setHover] = useState<HoldTarget | null>(null)
  const hoverRef = useRef<HoldTarget | null>(null)
  const setHoverTarget = (t: HoldTarget | null) => { hoverRef.current = t; setHover(t) }

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    holding.current = true
    latchedRef.current = false
    resolved.current = false
    setHoverTarget(null) // never inherit a choice from the previous gesture
    if (opts.recording) return // a press while recording just stops it on release
    pressCue.current = window.setTimeout(() => { if (holding.current) setPressing(true) }, CUE_MS)
    holdTimer.current = window.setTimeout(() => {
      if (!holding.current) return
      latchedRef.current = true
      setPressing(false)
      if (targets) { setLatched(true); setHoverTarget('audio') }
    }, HOLD_MS)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!latchedRef.current || !holding.current) return
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const t = el?.closest?.('[data-hold-target]')?.getAttribute('data-hold-target')
    // off both targets keeps the last choice rather than falling back to audio: the finger
    // travels through the gap between them, and a value that flickered mid-slide would decide
    // the gesture on where the finger happened to be at the instant it lifted.
    if (t === 'audio' || t === 'photo') setHoverTarget(t)
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
    setPressing(false)
    if (pressCue.current) { clearTimeout(pressCue.current); pressCue.current = null }
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null }
    if (latchedRef.current) {
      latchedRef.current = false
      const pick = hoverRef.current
      setLatched(false); setHoverTarget(null)
      resolved.current = true
      // THIS is where a HOLD acts — one outcome, chosen by where the finger let go.
      if (pick === 'photo' && opts.onHoldPhoto) opts.onHoldPhoto()
      else opts.onHoldStart()
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
    if (resolved.current) { resolved.current = false; return } // the pointer phase already acted
    if (opts.recording) { opts.onHoldStop(); return }
    opts.onTap()
  }

  return {
    pressing,
    /** the hold has latched — render the two slide targets while this is true */
    latched,
    /** which target the finger is currently over (drives the highlight) */
    hover,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClick,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
  }
}
