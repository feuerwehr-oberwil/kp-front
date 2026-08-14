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
  const [pressing, setPressing] = useState(false)
  // the targets are only offered where there is somewhere to slide TO
  const targets = !!opts.onHoldPhoto
  const [latched, setLatched] = useState(false)
  const [hover, setHover] = useState<HoldTarget | null>(null)
  const hoverRef = useRef<HoldTarget | null>(null)
  const setHoverTarget = (t: HoldTarget | null) => { hoverRef.current = t; setHover(t) }

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // ⚠️ preventDefault kills the COMPATIBILITY CLICK the browser would fire after this touch.
    // Without it, the tap that opens the composer is re-dispatched onto whatever has just
    // mounted under the finger — on a phone that is the composer's own «Foto» button, so
    // tapping «Eintrag» opened the camera. We drive everything from pointerup ourselves.
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    holding.current = true
    latchedRef.current = false
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

  // iPadOS / some tablets deliver `pointercancel` instead of `pointerup` for a clean
  // tap (the OS speculatively claims the touch as a gesture). Treat that as a tap too,
  // unless the hold already latched — otherwise the short-press opens nothing.
  const onPointerCancel = () => end(!latchedRef.current && !opts.recording)

  const end = (commit: boolean) => {
    if (!holding.current) return
    holding.current = false
    setPressing(false)
    if (pressCue.current) { clearTimeout(pressCue.current); pressCue.current = null }
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null }
    if (latchedRef.current) {
      latchedRef.current = false
      const pick = hoverRef.current
      setLatched(false); setHoverTarget(null)
      // THIS is where the gesture acts — one outcome, chosen by where the finger let go.
      if (pick === 'photo' && opts.onHoldPhoto) opts.onHoldPhoto()
      else opts.onHoldStart()
      return
    }
    if (opts.recording) { if (commit) opts.onHoldStop(); return } // tap while recording → stop
    if (commit) opts.onTap()                                      // quick tap → open composer
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.recording ? opts.onHoldStop() : opts.onTap() }
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
      onPointerUp: () => end(true),
      onPointerCancel,
      onKeyDown,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
  }
}
