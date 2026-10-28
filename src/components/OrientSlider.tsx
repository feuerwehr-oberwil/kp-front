import { useEffect, useRef } from 'react'
import { Slider } from './Slider'

/**
 * The Gebäude's orientation slider (the popover the north dial opens). While the thumb moves,
 * the caller PREVIEWS the angle (the backdrop and everything drawn on it turn live –
 * lib/reorientAnnos, 28.10.2026); the release commits it once – one `reorientTo`, one undo step,
 * one `building.reorient` row. From the keyboard every step is a release of its own.
 *
 * It is the app's own `Slider` (20.10.2026, UX sweep M3 – it was the native range input, whose
 * release had to be read off the browser's own `change` event). The Slider's `onCommit` is that
 * release now, on every engine alike.
 *
 * ⚠️ A gesture that never releases must not leave the preview standing (24.09.2026, Feueralarm
 * post-mortem «Symptom 3»): on iOS a touch the browser takes over ends in `pointercancel`, the
 * commit never comes, and the backdrop stayed turned with nothing in the record to say so. So a
 * cancelled gesture (the Slider's `onCancel`), and the popover closing with a preview still
 * live, both DROP it – the caller falls back to the committed angle.
 */
export function OrientSlider({ value, label, onPreview, onCommit, onAbandon }: {
  /** the degrees the thumb shows: the live preview, else the committed angle */
  value: number
  label: string
  onPreview: (deg: number) => void
  onCommit: (deg: number) => void
  onAbandon: () => void
}) {
  // through a ref: the unmount calls the LATEST closure
  const abandonRef = useRef(onAbandon)
  useEffect(() => { abandonRef.current = onAbandon })
  // the popover unmounts its contents on close – whatever preview is live then is dropped
  useEffect(() => () => abandonRef.current(), [])
  return (
    <Slider
      value={value} min={-180} max={180} step={1}
      ariaLabel={label} valueText={`${value}°`}
      onChange={onPreview} onCommit={onCommit} onCancel={onAbandon}
    />
  )
}
