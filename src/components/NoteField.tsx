import type { ComponentProps } from 'react'
import { useCommitDraftOnUnmount } from '../lib/useCommitDraftOnUnmount'

/**
 * A Notiz's text field on the canvas – the Lage map's (EntityMarker) and the Plan's (PlanAnno).
 * ✓, a tap elsewhere, another tool, a ↶ that takes the Notiz away and the surface closing all
 * remove it with no blur (the browser fires none for a removed node). So it ends its edit as it
 * goes: `onEnd`, the end its blur runs too – which is why that end must do nothing the second time.
 * Without it the typing stays open, and the next act's ↶ takes the Notiz text back with it.
 */
export function NoteField({ onEnd, ...field }: ComponentProps<'textarea'> & { onEnd: () => void }) {
  useCommitDraftOnUnmount(onEnd)
  // raw, not `ip-textarea`: it IS the Notiz drawn on the canvas (its pill's box, font and tint),
  // not a form field beside it – moved here from EntityMarker and PlanAnno, one count for both
  return <textarea {...field} />
}
