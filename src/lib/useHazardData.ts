// Load the hazard datasets when something on screen needs them, and re-render when they land
// (lib/staticData: ADR table in lib/unHazard + ERG in lib/erg). The surfaces that resolve a UN
// number in render — ContextPanel's readout, the baked placard glyph on Karte/Plan, the ERG
// rings — say which table they need right now; nothing loads them on launch (perf sweep
// 26.11.2026: 663 KB fetched and parsed per launch, mostly for an Einsatz without a placard).
// Both files are precached, so a placard typed offline still finds them.

import { useEffect, useSyncExternalStore } from 'react'
import { ensureErg, subscribeErg, ergVersion } from './erg'
import { ensureUnHazard, subscribeUnHazard, unHazardVersion } from './unHazard'

function subscribe(cb: () => void): () => void {
  const offUn = subscribeUnHazard(cb)
  const offErg = subscribeErg(cb)
  return () => { offUn(); offErg() }
}

// Both versions only ever grow, so the sum is a valid monotone snapshot.
function snapshot(): number {
  return unHazardVersion() + ergVersion()
}

/** Current combined dataset version — called by a component that reads lookupUN/lookupErg
 *  (directly or via placardSvgForSymbol/ergRingOverlays) during render. `need` names the tables
 *  it has something to look up in right now (`un`: the ADR table, `erg`: the ERG table); each
 *  starts loading the moment it is needed. The value is useful as a memo dependency; the
 *  re-render on data arrival is the point. */
export function useHazardData(need: { un?: boolean; erg?: boolean }): number {
  const { un = false, erg = false } = need
  useEffect(() => { if (un) void ensureUnHazard() }, [un])
  useEffect(() => { if (erg) void ensureErg() }, [erg])
  return useSyncExternalStore(subscribe, snapshot)
}
