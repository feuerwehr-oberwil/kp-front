import { useEffect, useRef } from 'react'

/**
 * Calls `reset` when the window loses focus and when the caller unmounts – the two ways a
 * gesture's release never reaches its surface (an app switch or a system sheet mid-drag, the
 * surface closing under the finger), so no half-done gesture outlives them. Hand it the latest
 * closure on every render; it runs the last committed one (`admin/FloorPackEditor · FloorSheet`).
 */
export function useGestureReset(reset: () => void) {
  // latest-ref mirror, synced in an effect rather than during render (as useCommitDraftOnUnmount)
  const ref = useRef(reset)
  useEffect(() => { ref.current = reset })
  useEffect(() => {
    const run = () => ref.current()
    window.addEventListener('blur', run)
    return () => { window.removeEventListener('blur', run); run() }
  }, [])
}
