// The answer to a tap on a save that cannot save yet (UX sweep F2, 20.10.2026; the Trupp form's
// field feedback of 02.09. made general). A natively `disabled` button swallows the tap before any
// handler sees it, so it just sits there grey and the only hint is a «*». The pattern instead:
//
//   <button className="ip-btn primary" aria-disabled={!valid}
//     onClick={() => (valid ? submit() : pointAtField(titleRef.current, { focus: titleInputRef.current }))}>
//
// `aria-disabled` keeps the dimmed look (13-incident · `[aria-disabled='true']`) and leaves the
// button tappable; the tap rings the field that holds the save back — scrolled into view only when
// it is not already — and may put the caret in it. A press that is still IN FLIGHT (a «busy» save)
// stays natively disabled: there is nothing missing to point at.

import { scrollBehavior } from './reducedMotion'

/** The global two-beat ink ring (02-base · `.field-flash`, the `ui-flash-ring` keyframes). */
const FLASH_CLASS = 'field-flash'
const FLASH_MS = 1900

/**
 * Is `el` already fully visible inside the box that scrolls it?
 *
 * ⚠️ The point is what NOT to do: a smooth `scrollIntoView` on an element that is already in
 * view still starts an animation, and iOS spends the next tap on stopping it. Ringing a field
 * that never moved therefore cost the operator their first tap on the chip beside it.
 * Falls back to the viewport when nothing above the element scrolls; an element with no layout
 * (jsdom, a sheet that has not painted yet) counts as out of view, so the scroll still happens.
 */
export function inScrollPort(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return false
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight + 1) {
      const pr = p.getBoundingClientRect()
      return r.top >= pr.top && r.bottom <= pr.bottom
    }
  }
  return r.top >= 0 && r.bottom <= window.innerHeight
}

/**
 * Point at the field a blocked save is waiting for: scroll it into view when it is out of view,
 * ring it, and (optionally) focus `focus` — without scrolling a second time. A second blocked tap
 * rings again (remove → reflow → add). `className` swaps in a module's own ring where the global
 * one would be clipped; it must animate the same way.
 */
export function pointAtField(el: HTMLElement | null | undefined, opts: { focus?: HTMLElement | null; className?: string } = {}): void {
  if (!el) return
  const cls = opts.className ?? FLASH_CLASS
  if (!inScrollPort(el)) el.scrollIntoView?.({ behavior: scrollBehavior(), block: 'center' })
  el.classList.remove(cls)
  void el.offsetWidth
  el.classList.add(cls)
  window.setTimeout(() => el.classList.remove(cls), FLASH_MS)
  opts.focus?.focus({ preventScroll: true })
}
