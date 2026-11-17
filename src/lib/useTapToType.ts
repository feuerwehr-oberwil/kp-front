import { useState } from 'react'
import { leaveOnEnter } from './fieldKeys'

/**
 * Tap-the-value-to-type for any ±stepper: tapping the numeric display swaps it for a small
 * numeric <input> that commits on blur, on Enter and on Escape (clamped to [min,max]) – Esc keeps
 * what was typed and leaves the field like every text field (lib/fieldKeys, owner 17.11.2026; it
 * used to cancel). Leaving it EMPTY commits nothing. Mirrors the canonical Stepper's logic so every
 * stepper in the app behaves the same.
 *
 * Returns `editing` + a `draft`-bound `inputProps` to spread onto the <input>, and `start()`
 * to enter edit mode (seed it with the current value). `onCommit` always receives a clamped
 * integer; supply `clamp` for a non-[min,max] grid (e.g. snap-to-step).
 */
export function useTapToType(opts: {
  min: number
  max: number
  onCommit: (v: number) => void
  /** override clamping (e.g. snap to a step grid); defaults to clamp into [min,max] */
  clamp?: (v: number) => number
}) {
  const clamp = opts.clamp ?? ((v: number) => Math.max(opts.min, Math.min(opts.max, v)))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const start = (current: number) => { setDraft(String(current)); setEditing(true) }
  const commit = () => {
    setEditing(false)
    const n = parseInt(draft, 10)
    if (!Number.isNaN(n)) opts.onCommit(clamp(n))
  }

  const inputProps = {
    autoFocus: true,
    value: draft,
    inputMode: 'numeric' as const,
    type: 'text' as const,
    // The seeded value arrives SELECTED, so typing replaces it — nobody deletes «300» digit by
    // digit to enter a Druck (parity with the canonical Stepper). Backing out stays safe: a field
    // left empty commits nothing and the previous value stands; a typo is fixed with ↶.
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => e.currentTarget.select(),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
    onBlur: commit,
    enterKeyHint: 'done' as const,
    // Return and Esc both leave the field, and the blur commits (lib/fieldKeys)
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => { leaveOnEnter(e) },
  }

  return { editing, start, inputProps }
}
