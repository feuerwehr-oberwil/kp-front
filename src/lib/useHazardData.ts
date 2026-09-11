// Re-render when the fetched hazard datasets land (lib/staticData: ADR table in
// lib/unHazard + ERG in lib/erg). The surfaces that resolve a UN number in render —
// ContextPanel's readout, the baked placard glyph on Karte/Plan, the ERG rings — mount
// before the boot prefetch resolves on a cold start; this hook is what repaints them the
// moment the data is there, instead of leaving a plate without its Kemler until the next
// unrelated render.

import { useSyncExternalStore } from 'react'
import { subscribeErg, ergVersion } from './erg'
import { subscribeUnHazard, unHazardVersion } from './unHazard'

function subscribe(cb: () => void): () => void {
  const offUn = subscribeUnHazard(cb)
  const offErg = subscribeErg(cb)
  return () => { offUn(); offErg() }
}

// Both versions only ever grow, so the sum is a valid monotone snapshot.
function snapshot(): number {
  return unHazardVersion() + ergVersion()
}

/** Current combined dataset version — subscribe a component that reads lookupUN/lookupErg
 *  (directly or via placardSvgForSymbol/ergRingOverlays) during render. The value is
 *  useful as a memo dependency; the re-render on data arrival is the point. */
export function useHazardData(): number {
  return useSyncExternalStore(subscribe, snapshot)
}
