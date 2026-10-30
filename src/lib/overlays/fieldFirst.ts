/*
 * **The keyboard goes first.** While a text field inside a sheet has focus, the first close
 * intent — the sheet's ✕ or a tap outside it — only puts the keyboard away; the next one closes
 * (sweep 30.10.2026, owner: «the (x) of the card is an enticing place to close the keyboard»).
 * `Sheet` and `Overlay` carry it, so every modal sheet answers the same way; the sibling rule for a
 * dropdown over a sheet is `popoverGuard`. Swipe-down and Escape still close at once: both are
 * deliberate, and a hardware Escape has no on-screen keyboard to put away.
 */

import { useEffect, useRef, type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent } from 'react'

/** Input types that never raise the on-screen keyboard. */
const NO_KEYBOARD = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image', 'hidden'])

/** Does focusing `el` raise the on-screen keyboard? */
export function isTextField(el: Element | null): el is HTMLElement {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (el instanceof HTMLInputElement) return !NO_KEYBOARD.has(el.type) && !el.readOnly && !el.disabled
  return el instanceof HTMLElement && el.isContentEditable === true
}

/**
 * Wires one sheet frame: spread `onFocusCapture` and `onClickCapture` on the popup, and ask
 * `keyboardFirst` before an `outside-press` closes it (true = the press only blurred the field,
 * cancel the close). The frame is learnt from focus entering it — the only moment it matters —
 * so the popup's `ref` stays the caller's.
 *
 * ⚠️ The field is read at the press's `pointerdown`, not at its `click`: Chrome on Android moves
 * focus to a tapped button before the click, so by then the field has already let go — the
 * keyboard went down by itself and the sheet would close on the same tap, the very thing this
 * removes. A MOUSE press is let through: there is no on-screen keyboard to put away.
 *
 * ⚠️ The sheet's ✕ is the FIRST `.ip-x` in its frame (its head; docs/ui-conventions · Close).
 * A bespoke frame calls its own `onClose` from that button, so it is caught here, in capture,
 * before its handler runs. A later `.ip-x` (AudioPlayerSheet's per-row cancel) is a control
 * inside the sheet and works as before.
 */
export function useFieldFirst(open: boolean) {
  /** the popup frame, learnt from focus entering it */
  const frame = useRef<HTMLElement | null>(null)
  /** the field that held focus when the current press began, or null */
  const field = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const a = document.activeElement
      field.current = e.pointerType !== 'mouse' && isTextField(a) && !!frame.current?.contains(a) ? a : null
    }
    // a keyboard-activated ✕ (Enter, Space) is not the press that was recorded
    const onKey = () => { field.current = null }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      field.current = null
    }
  }, [open])

  /** Spend the recorded field: blur it if it still has focus. true = this press was the keyboard's. */
  const spend = () => {
    const f = field.current
    field.current = null
    if (!f) return false
    if (document.activeElement === f) f.blur()
    return true
  }

  return {
    keyboardFirst: (reason: string | undefined) => reason === 'outside-press' && spend(),
    onFocusCapture: (e: ReactFocusEvent<HTMLElement>) => { frame.current = e.currentTarget },
    onClickCapture: (e: ReactMouseEvent<HTMLElement>) => {
      const x = e.target instanceof Element ? e.target.closest('.ip-x') : null
      if (!x || x !== e.currentTarget.querySelector('.ip-x')) return
      if (spend()) { e.preventDefault(); e.stopPropagation() }
    },
  }
}
