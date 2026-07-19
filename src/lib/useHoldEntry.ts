import { useRef, useState } from 'react'

const HOLD_MS = 350 // hold longer than this starts a (latched) voice memo instead of opening the composer
const CUE_MS = 130 // delay the charging cue so a quick tap doesn't flash it

/**
 * Shared tap / press-and-hold interaction for the journal "Eintrag" affordance, used by
 * both the TopBar button and the mobile FAB so they behave identically:
 *   • not recording — a quick tap fires onTap (open composer); holding past HOLD_MS starts
 *     a latched voice memo (onHoldStart) that keeps recording after release.
 *   • recording — a tap fires onHoldStop (stop + save).
 */
export function useHoldEntry(opts: {
  recording: boolean
  onTap: () => void
  onHoldStart: () => void
  onHoldStop: () => void
}) {
  const holdTimer = useRef<number | null>(null)
  const pressCue = useRef<number | null>(null)
  const holding = useRef(false)
  const recStarted = useRef(false)
  const [pressing, setPressing] = useState(false)

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    holding.current = true
    recStarted.current = false
    if (opts.recording) return // a press while recording just stops it on release
    pressCue.current = window.setTimeout(() => { if (holding.current) setPressing(true) }, CUE_MS)
    holdTimer.current = window.setTimeout(() => {
      if (holding.current) { recStarted.current = true; setPressing(false); opts.onHoldStart() }
    }, HOLD_MS)
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
    if (recStarted.current) { recStarted.current = false; return } // latched — keep recording
    if (opts.recording) { if (commit) opts.onHoldStop(); return }   // tap while recording → stop
    if (commit) opts.onTap()                                        // quick tap → open composer
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.recording ? opts.onHoldStop() : opts.onTap() }
  }

  return {
    pressing,
    handlers: {
      onPointerDown,
      onPointerUp: () => end(true),
      onPointerCancel,
      onKeyDown,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
  }
}
