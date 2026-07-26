import { useEffect, useRef } from 'react'

/** How long after opening an outside-press is read as the opening gesture echoing back. */
const GRACE_MS = 400

/**
 * Guards a freshly opened surface against the touch echo that dismisses it with the very
 * gesture that opened it.
 *
 * iPadOS emits the compatibility mouse events of a tap (`mousedown`/`mouseup`/`click`) in a later
 * task, well AFTER `pointerup`. A surface opened from a pointerup handler — the «Eintrag» tap/hold
 * gesture in `useHoldEntry` is our only one — therefore mounts *before* that trailing `click`
 * arrives. Every sheet here renders a Backdrop, which puts Base UI's dismissal into `intentional`
 * mode (`dialog/root/useDialogRoot`), where a `click` is exactly what dismisses; and its
 * suppression path only covers a press that STARTED inside the popup, which by definition can't
 * hold when the popup did not yet exist. So the tap's own click landed as an outside press and
 * closed the surface instantly — on the tablet that read as «the Eintrag button does nothing».
 * A desktop mouse never showed it: there the click follows within the same task, before the
 * freshly mounted dialog has attached its listeners.
 *
 * So: veto an outside-press close that arrives within `GRACE_MS` of opening. Nobody opens a sheet
 * and deliberately taps it away inside four tenths of a second — every such close is the echo.
 * Escape, the close button and a later outside press are untouched.
 */
export function useDismissGrace(open: boolean) {
  const openedAt = useRef(0)
  // An effect is early enough: Base UI attaches its own dismissal listeners from an effect in the
  // same commit, so there is no window in which a press could be judged before this one has run.
  useEffect(() => { if (open) openedAt.current = Date.now() }, [open])
  return (reason: string | undefined) => reason === 'outside-press' && Date.now() - openedAt.current < GRACE_MS
}
