import { useEffect, useLayoutEffect, useRef } from 'react'

/** Run `onResume` when the app comes back from the background – the page turning `visible` after
 *  it was `hidden` (a switch to another app, the phone in the pocket, the tablet's screen off).
 *
 *  The one rule for armed state (rare-user round 17.11.2026, C3 = A): whoever picks the device up
 *  again starts from Auswahl, not from the «Feuer» somebody armed an hour ago. The Lage, the Plan
 *  and the Karte each pass what «put down» means on their surface. No idle timer – only the return
 *  from the background. The latest `onResume` is used, so callers need not memoise it. */
export function useOnResume(onResume: () => void): void {
  const latest = useRef(onResume)
  useLayoutEffect(() => { latest.current = onResume })
  useEffect(() => {
    let wasHidden = document.visibilityState === 'hidden'
    const onChange = () => {
      if (document.visibilityState === 'hidden') { wasHidden = true; return }
      if (!wasHidden) return
      wasHidden = false
      latest.current()
    }
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
}
