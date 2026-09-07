import { useEffect, useRef } from 'react'

/**
 * Commits a draft field when its surface unmounts mid-edit. Closing a sheet must never eat
 * typed text — and a swipe-dismiss (SheetGrip), a slot swap (Ebenen/Verlauf opening over the
 * editor) and a remote deselect all unmount a focused field WITHOUT a blur (the browser fires
 * none for a removed node), so an onBlur-only commit silently dropped the draft (Feldtest
 * 07.09.: a Notiz typed into the Feuer details was gone with the sheet).
 *
 * Hand it the SAME function the field's onBlur runs — it is called once, on unmount, with the
 * latest render's closure. The commit must be idempotent against an already-committed value
 * (guard on a last-committed ref, not on possibly-stale props), because a normal close runs
 * blur first and this second.
 */
export function useCommitDraftOnUnmount(commit: () => void) {
  // latest-ref mirror, synced in an effect rather than during render (same rule the gesture
  // hooks follow) — the unmount cleanup then runs the last committed render's closure
  const ref = useRef(commit)
  useEffect(() => { ref.current = commit })
  useEffect(() => () => { ref.current() }, [])
}
