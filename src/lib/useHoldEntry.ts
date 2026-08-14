import { useRef, useState } from 'react'

const HOLD_MS = 350 // hold longer than this starts a (latched) voice memo instead of opening the composer
const CUE_MS = 130 // delay the charging cue so a quick tap doesn't flash it

/** What a latched hold can be released onto. `audio` is also what a release that never moved
 *  resolves to — the gesture stays hold-and-talk. */
export type HoldTarget = 'audio' | 'photo'

/**
 * Shared tap / press-and-hold interaction for the journal "Eintrag" affordance, used by
 * both the TopBar button and the mobile FAB so they behave identically:
 *   • not recording — a quick tap fires onTap (open composer); holding past HOLD_MS starts
 *     a latched voice memo (onHoldStart) that keeps recording after release.
 *   • recording — a tap fires onHoldStop (stop + save).
 *
 * Once the hold latches, two targets appear beside the button (Sprachnotiz · Foto) and the
 * finger can SLIDE onto one before releasing — one gesture, no extra tap, so hold-and-talk is
 * exactly as fast as it was: release without moving and the memo simply keeps recording.
 * Releasing over «Foto» throws that already-running memo away (onHoldCancel) and opens the
 * camera instead. The hover target is hit-tested with elementFromPoint against
 * `[data-hold-target]`, because the button holds the pointer capture for the whole gesture and
 * no pointerenter ever reaches the targets themselves.
 */
export function useHoldEntry(opts: {
  recording: boolean
  onTap: () => void
  onHoldStart: () => void
  onHoldStop: () => void
  /** released over «Foto» — go straight to the camera. Omit to keep the old audio-only hold. */
  onHoldPhoto?: () => void
  /** discard the memo the hold had already started (only called when onHoldPhoto is) */
  onHoldCancel?: () => void
}) {
  const holdTimer = useRef<number | null>(null)
  const pressCue = useRef<number | null>(null)
  const holding = useRef(false)
  const recStarted = useRef(false)
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
    recStarted.current = false
    if (opts.recording) return // a press while recording just stops it on release
    pressCue.current = window.setTimeout(() => { if (holding.current) setPressing(true) }, CUE_MS)
    holdTimer.current = window.setTimeout(() => {
      if (!holding.current) return
      recStarted.current = true
      setPressing(false)
      if (targets) { setLatched(true); setHoverTarget('audio') }
      opts.onHoldStart()
    }, HOLD_MS)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!latched || !holding.current) return
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const t = el?.closest?.('[data-hold-target]')?.getAttribute('data-hold-target')
    // off both targets keeps the last choice rather than falling back to audio: the finger
    // travels through the gap between them, and a value that flickered mid-slide would decide
    // the gesture on where the finger happened to be at the instant it lifted.
    if (t === 'audio' || t === 'photo') setHoverTarget(t)
  }

  // iPadOS / some tablets deliver `pointercancel` instead of `pointerup` for a clean
  // tap (the OS speculatively claims the touch as a gesture). Treat that as a tap too,
  // unless a voice memo already latched — otherwise the short-press opens nothing.
  const onPointerCancel = () => end(!recStarted.current && !opts.recording)

  const end = (commit: boolean) => {
    if (!holding.current) return
    holding.current = false
    setPressing(false)
    if (pressCue.current) { clearTimeout(pressCue.current); pressCue.current = null }
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null }
    if (recStarted.current) {
      recStarted.current = false
      const pick = hoverRef.current
      setLatched(false); setHoverTarget(null)
      // «Foto» — the memo this hold already started is thrown away, not saved
      if (pick === 'photo' && opts.onHoldPhoto) { opts.onHoldCancel?.(); opts.onHoldPhoto() }
      return // audio: latched — keep recording
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
