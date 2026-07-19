import { useState } from 'react'

/**
 * Tap-the-value-to-type for any ±stepper: tapping the numeric display swaps it for a small
 * numeric <input> that commits on blur and on Enter (clamped to [min,max]), and cancels on
 * Escape. Mirrors the canonical Stepper's logic so every stepper in the app behaves the same.
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
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      else if (e.key === 'Escape') setEditing(false)
    },
  }

  return { editing, start, inputProps }
}
