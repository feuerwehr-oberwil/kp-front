import { useEffect } from 'react'

/**
 * «One Esc, one tap, one thing closes.»
 *
 * A dropdown opened INSIDE a non-fullscreen modal — the Material-Combo in «Material erfassen»
 * (MittelView), the Einsatzleiter picker, any `Menu` on a sheet — used to take the modal down with
 * it: the tap that dismissed the menu ALSO reached the dialog's backdrop, and one Escape closed
 * both. From the operator's side the sheet they were filling in simply vanished, with whatever was
 * typed in it, because they wanted to put a dropdown away.
 *
 * Neither half can fix that alone. The menu's own outside-click handler cannot swallow the event
 * for the dialog: `ComboMenu` listens on `document` in the same phase Base UI's dismissal does, so
 * which one runs first is registration order; and Base UI reads a `click`/`mousedown` that arrives
 * in a LATER task than the `pointerdown` the menu closed on, by which time React has re-rendered
 * and the menu is gone. There is nothing left to test for at the moment the question is asked.
 *
 * So the surfaces publish the fact instead: anything transient that opens over a dialog registers
 * here for as long as it is open, and `Sheet`/`Overlay` veto an outside-press or Escape dismissal
 * while the register is non-empty. The second Esc, and the second tap, land on an empty register
 * and close the dialog — which is exactly the behaviour every desktop menu has ever had.
 *
 * ⚠️ The register stays WARM for `TAIL_MS` after the last popover closes. The dismissing gesture is
 * not one event: `pointerdown` closes the menu, and the `mousedown`/`click` Base UI actually
 * dismisses on follows a task or more later (on iPadOS, the synthesized mouse events of a tap come
 * later still — the same physics `dismissGrace` documents). Without the tail the one gesture would
 * close the menu and then, a few milliseconds later, the sheet — the precise bug this file exists
 * to remove. The window only has to outlive one gesture's own echo, so it is short enough that a
 * deliberate second tap on the backdrop still closes the sheet.
 */

/** How long after the last popover closed its dismissing gesture may still be in flight. */
const TAIL_MS = 350

let openCount = 0
let closedAt = 0

/** Is a transient popover open over the dialogs right now (or has one just closed)? */
export function popoverOpen(): boolean {
  return openCount > 0 || Date.now() - closedAt < TAIL_MS
}

/** Test seam — the register is module state, so a test that opened one has to be able to reset. */
export function resetPopoverGuard() {
  openCount = 0
  closedAt = 0
}

/**
 * Register a popover/menu/dropdown as open for as long as `open` is true.
 *
 * Every transient surface that can sit over a `Sheet`/`Overlay` calls this — the shared `Menu` and
 * `Popover` wrappers do it for their callers, and the hand-rolled `ComboMenu` does it for the
 * pickers that wear it.
 */
export function usePopoverGuard(open: boolean) {
  useEffect(() => {
    if (!open) return
    openCount += 1
    return () => {
      openCount -= 1
      closedAt = Date.now()
    }
  }, [open])
}
