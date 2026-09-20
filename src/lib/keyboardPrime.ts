/**
 * Raise the on-screen keyboard for a field that does not exist yet.
 *
 * iOS shows the keyboard only for a `focus()` made INSIDE the tap that asked for it. A dialog
 * that mounts on that tap focuses its field an effect later – the field gets the caret, the
 * keyboard stays down, and the operator taps a second time into a field that already looks
 * focused (the phone's «+ Eintrag», 20.09.2026). Focusing a throwaway input inside the tap opens
 * the keyboard, and iOS keeps it up when the dialog's own initial focus then moves the caret on.
 *
 * Call it synchronously from the click handler, before the state change that mounts the dialog.
 * The input removes itself on blur (i.e. when the real field takes over) or after a moment.
 */
export function primeKeyboard() {
  if (typeof document === 'undefined') return
  const el = document.createElement('input')
  el.type = 'text'
  el.tabIndex = -1
  el.setAttribute('aria-hidden', 'true')
  // 16px: anything smaller makes iOS zoom the page to the focused field
  el.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;font-size:16px;pointer-events:none'
  document.body.appendChild(el)
  el.focus({ preventScroll: true })
  const done = () => el.remove()
  el.addEventListener('blur', done, { once: true })
  window.setTimeout(done, 1500)
}
