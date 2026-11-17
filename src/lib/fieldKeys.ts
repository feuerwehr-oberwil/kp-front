/*
 * **The keys of a text field, everywhere** (duck sweep 17.11.2026, owner: ELEM.8 + GESTURES.11).
 *
 * - **Return in a ONE-LINE field = done**: it commits and puts the keyboard down – by leaving the
 *   field, because every one-liner in the app commits on blur. Its key says so (`enterKeyHint`
 *   «done» – the iOS «Fertig»); a field whose return does something else (send, search, next)
 *   names that instead and handles it itself.
 * - **Esc = keep what was typed and leave the field** – one-liner and textarea alike, like tapping
 *   away. Nothing reverts: a typo is fixed with ↶ (the commit on blur is one undo step). Only a
 *   field that is a visible DRAFT with its own «Abbrechen» beside it (a Verlauf correction) may
 *   throw the text away – and then through that button, never through Esc.
 * - In a textarea Return stays a new line (the Tafel's cells and the composer's ⌘↵ are their own).
 *
 * Spread `ONE_LINE` on an `<input>` that has no keys of its own; call `leaveOnEnter` /
 * `leaveOnEscape` from a field's own onKeyDown before its other keys.
 */

import type { KeyboardEvent } from 'react'

type FieldKey = KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>

/** Esc: keep the text, leave the field (its blur commits). true = the key was taken. */
export function leaveOnEscape(e: FieldKey): boolean {
  if (e.key !== 'Escape') return false
  e.preventDefault()
  e.currentTarget.blur()
  return true
}

/** Return (not mid-composition) or Esc in a one-line field: leave it, which commits. true = taken. */
export function leaveOnEnter(e: FieldKey): boolean {
  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
    e.preventDefault()
    e.currentTarget.blur()
    return true
  }
  return leaveOnEscape(e)
}

/** The props of a one-line field with no keys of its own: «Fertig» on the keyboard, and it acts. */
export const ONE_LINE = { enterKeyHint: 'done', onKeyDown: (e: FieldKey) => { leaveOnEnter(e) } } as const
