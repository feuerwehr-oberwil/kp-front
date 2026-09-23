import { useEffect, useRef } from 'react'

/**
 * The Gebäude's orientation slider (the popover the north dial and the rail's compass open).
 * While the thumb moves, the caller PREVIEWS the angle (the backdrop turns live); the release
 * commits it once — one `reorientTo`, one undo step, one `building.reorient` row.
 *
 * The commit is the input's NATIVE `change` event — the browser's own «the user let go» for a
 * range input, fired once on release in WebKit, Blink and Gecko, and once per step from the
 * keyboard. It is not React's `onChange` (which is `input`, every frame), and not `pointerup`,
 * which a touch the browser took over never delivers.
 *
 * ⚠️ A gesture that never releases must not leave the preview standing (24.09.2026, Feueralarm
 * post-mortem «Symptom 3»). On iOS a touch that turns into a scroll ends in `pointercancel`: the
 * commit never came, and the backdrop stayed turned with nothing in the record to say so — «the
 * background turned while just scrolling». So a cancelled gesture, and the popover closing with a
 * preview still live, both DROP it (the caller falls back to the committed angle). If a native
 * `change` still arrives after a cancel, the change wins: the browser did finish the drag, and
 * the last angle the thumb reached is committed.
 */
export function OrientSlider({ value, label, onPreview, onCommit, onAbandon }: {
  /** the degrees the thumb shows: the live preview, else the committed angle */
  value: number
  label: string
  onPreview: (deg: number) => void
  onCommit: (deg: number) => void
  onAbandon: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  /** the last angle this gesture moved the thumb to — null when nothing moved since the last
   *  commit. Kept through a cancel, so a `change` after it commits where the drag ended (the
   *  controlled input itself has been put back to the committed angle by then). */
  const moved = useRef<number | null>(null)
  // Through refs: the native listener and the unmount call the LATEST closures.
  const commitRef = useRef(onCommit)
  const abandonRef = useRef(onAbandon)
  useEffect(() => { commitRef.current = onCommit; abandonRef.current = onAbandon })
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const onNativeChange = (e: Event) => {
      // the release is ours alone: React must not read this same event as one more `input`
      // frame and re-open the preview the commit just closed
      e.stopPropagation()
      const deg = moved.current
      moved.current = null
      if (deg != null) commitRef.current(deg)
    }
    el.addEventListener('change', onNativeChange)
    return () => el.removeEventListener('change', onNativeChange)
  }, [])
  // the popover unmounts its contents on close — whatever preview is live then is dropped
  useEffect(() => () => abandonRef.current(), [])
  return (
    <input
      ref={inputRef}
      type="range" min={-180} max={180} step={1}
      value={value}
      aria-label={label}
      onPointerDown={() => { moved.current = null }}
      onChange={(e) => { const deg = Number(e.target.value); moved.current = deg; onPreview(deg) }}
      onPointerCancel={() => onAbandon()}
    />
  )
}
