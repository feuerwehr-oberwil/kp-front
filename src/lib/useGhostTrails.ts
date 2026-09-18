/**
 * ─── The ghost-trail reconciliation, as the one hook every surface's removal runs through ────
 * (18.09.2026)
 *
 * A Trupp's «Spur» belongs to the incident, not to its marker (lib/truppTrails): a marker that
 * disappears leaves its recorded positions behind as a read-only ghost, and a marker that comes
 * back takes them home again. That is driven as a RECONCILIATION over the marker set rather than
 * as a write on each of the four removal paths — which is what keeps a removal's own ↶ ONE step.
 *
 * It lives here rather than inline in `IncidentWorkspace` because the arming of «Marker und Spur
 * löschen» and the pass that reads it are ONE mechanism: the surface arms `armTrailDrop(id, true)`
 * in the same breath as the removal, and the very next pass writes that marker's ghost already
 * `removedAt`-stamped instead of standing the searched area back up. Split across a component,
 * the two halves could drift apart (and did: an effect that no longer passed the set left the
 * trail on the picture while the Verlauf said «Spur gelöscht»). Here they cannot: the arm and the
 * pass come out of the same call.
 */
import { useEffect, useRef } from 'react'
import { reconcileGhostTrails, type TrailSource, type TruppTrail } from './truppTrails'
import { serverNowIso } from './serverClock'

export interface GhostTrailsApi {
  /** «Marker und Spur löschen»: the ghost of this marker is to be born already deleted. Armed
   *  immediately before the removal, and taken back (`on: false`) when the removal is called
   *  off — an intent left lying would eat the NEXT removal's trail. */
  armTrailDrop: (sourceId: string, on: boolean) => void
  /** A remote hydrate replaced the whole store: re-seed instead of reconciling, or every marker
   *  reads as «vanished» at once and the merge ghosts the entire picture. */
  reseed: () => void
}

export function useGhostTrails({ sources, setTrails, now = serverNowIso }: {
  /** every Trupp marker standing right now, with whatever trail it carries (trailSources) */
  sources: TrailSource[]
  setTrails: (update: (ts: TruppTrail[]) => TruppTrail[]) => void
  now?: () => string
}): GhostTrailsApi {
  const prev = useRef<TrailSource[] | null>(null)
  // a REF, not state: arming must not re-render, and the pass that consumes it is the removal's
  // own render — see the header
  const dropped = useRef(new Set<string>())
  useEffect(() => {
    const before = prev.current
    prev.current = sources
    // spent by every pass, whatever it decided: the intent describes the removal it was armed
    // for and nothing later
    const drop = dropped.current
    if (drop.size) dropped.current = new Set()
    if (!before) return // first pass / post-hydrate seed: nothing vanished, nothing to ghost
    setTrails((ts) => reconcileGhostTrails(ts, before, sources, now(), drop))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, setTrails])
  return {
    armTrailDrop: (sourceId, on) => {
      if (on) dropped.current.add(sourceId)
      else dropped.current.delete(sourceId)
    },
    reseed: () => { prev.current = null },
  }
}
