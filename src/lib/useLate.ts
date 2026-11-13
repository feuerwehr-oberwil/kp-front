import { useEffect, useState } from 'react'

/**
 * `on`, but only once it has held for `ms` – a state that is normal for a moment and a problem
 * only when it lasts (the head's «Nicht synchronisiert», panels/IncidentSwitcher). Drops at once
 * when `on` does.
 */
export function useLate(on: boolean, ms: number): boolean {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!on) return
    const t = setTimeout(() => setLate(true), ms)
    // the spell's end resets it, so the next spell starts a new clock
    return () => { clearTimeout(t); setLate(false) }
  }, [on, ms])
  return on && late
}
