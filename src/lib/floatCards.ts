// ONE card open at a time in the floating chip row (owner, staging 27.10.2026: the Gebäude card and
// the «Messungen» list stood open together, one over the other – «check why it … can be opened with
// other things»).
//
// The row's cards (BuildingFloat's Gebäude card, the Messungen list, …) are non-modal and each keeps
// its own `open` state, so nothing tied them together. Each one calls `useOnlyOpenCard(open, close)`:
// the moment it opens it says so here, and every other open card closes itself. A card that does not
// call it is not closed by the others and does not close them – joining is one line.

import { useEffect, useId, useRef } from 'react'

const listeners = new Set<(id: string) => void>()

/** `open` this card, `close` it (called when ANOTHER card of the row opens). */
export function useOnlyOpenCard(open: boolean, close: () => void) {
  const id = useId()
  const latest = useRef({ open, close })
  useEffect(() => { latest.current = { open, close } })
  useEffect(() => {
    // only an OPEN card closes: `close` may do more than hide (BuildingFloat marks the card read)
    const onOpen = (other: string) => { if (other !== id && latest.current.open) latest.current.close() }
    listeners.add(onOpen)
    return () => { listeners.delete(onOpen) }
  }, [id])
  useEffect(() => {
    if (open) for (const l of [...listeners]) l(id)
  }, [open, id])
}
