import { useEffect, useRef } from 'react'

/**
 * The Gebäude's orientation slider (the popover the north dial and the rail's compass open).
 * While the thumb moves, the caller PREVIEWS the angle (the backdrop turns live); the release
 * commits it once — one `reorientTo`, one undo step, one `building.reorient` row.
 *
 * ⚠️ A gesture that never releases must not leave the preview standing (24.09.2026, Feueralarm
 * post-mortem «Symptom 3»). On iOS a touch that turns into a scroll ends in `pointercancel`, not
 * `pointerup`: the commit never came, and the backdrop stayed turned with nothing in the record
 * to say so — «the background turned while just scrolling». So a cancelled gesture, and the
 * popover closing with a preview still live, both ABANDON it (the caller drops the preview back
 * to the committed angle) rather than committing half a gesture.
 */
export function OrientSlider({ value, pending, label, onPreview, onCommit, onAbandon }: {
  /** the degrees the thumb shows: the live preview, else the committed angle */
  value: number
  /** a preview is live (not committed yet) */
  pending: boolean
  label: string
  onPreview: (deg: number) => void
  onCommit: (deg: number) => void
  onAbandon: () => void
}) {
  // the popover unmounts its contents on close — whatever preview is live then is abandoned.
  // Through a ref: the unmount must call the LATEST closure, not the one of the first render.
  const abandonRef = useRef(onAbandon)
  useEffect(() => { abandonRef.current = onAbandon })
  useEffect(() => () => abandonRef.current(), [])
  return (
    <input
      type="range" min={-180} max={180} step={1}
      value={value}
      aria-label={label}
      onChange={(e) => onPreview(Number(e.target.value))}
      onPointerUp={(e) => onCommit(Number(e.currentTarget.value))}
      onPointerCancel={() => onAbandon()}
      onKeyUp={(e) => { if (e.key.startsWith('Arrow')) onCommit(Number(e.currentTarget.value)) }}
      onBlur={(e) => { if (pending) onCommit(Number(e.target.value)) }}
    />
  )
}
