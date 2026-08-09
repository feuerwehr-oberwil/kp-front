import { useEffect, useRef } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { haversineM } from './geo'
import type { Entity, LngLat } from '../types'

/**
 * «Wann ist das TLF weggefahren?»
 *
 * The Fahrzeuge layer draws where the fleet is RIGHT NOW and keeps no history, so an hour after
 * the Retablierung nobody can say when anything left — the picture simply has one symbol fewer
 * than it used to. That is a question the Verlauf is for, and it is one nobody thinks to answer
 * by hand while it is happening.
 *
 * So the feed writes it: a vehicle that arrives at the Einsatzort gets a line, and so does one
 * that leaves. Nothing else — this is a RECORD of two moments, not a tracker. There are no
 * warnings, no «Fahrzeug entfernt sich» nudges and no distance readouts; a vehicle driving away
 * is usually the plan, and the same rule the crew-position feature already follows applies here
 * (see kp-front live-person-positions: information, never accusation).
 */

/** Inside this ring the vehicle is «vor Ort». Generous: an Einsatzort is a place, not a point,
 *  and a TLF parked one street back to keep the Zufahrt clear is still there. */
const AT_SCENE_M = 150
/**
 * …and it has to get this far out before it counts as gone.
 *
 * ⚠️ The gap between the two rings is the whole point. One threshold plus GPS scatter (a fix
 * jumping 30–40 m under a roof or between buildings) writes «vor Ort» and «hat den Einsatzort
 * verlassen» alternately, for a vehicle that never moved — and an append-only journal cannot
 * take those lines back. Hysteresis, not a filter.
 */
const LEFT_M = 300

/** How long a state has to hold before it is written. A vehicle that clips the ring at the end
 *  of the Zufahrt and comes straight back was manoeuvring, not leaving. */
const SETTLE_MS = 90_000

type Zone = 'scene' | 'away'

const zoneOf = (d: number, prev: Zone | undefined): Zone => {
  if (d <= AT_SCENE_M) return 'scene'
  if (d >= LEFT_M) return 'away'
  // in the band between the rings nothing changes — that is what the band is for
  return prev ?? 'scene'
}

export function useVehiclePresenceLog({ vehicles, center, enabled, log }: {
  /** the RAW feed, not the overridden view: a vehicle held in place by hand (see
   *  «Festhalten») still really drives away, and that is the moment worth recording. */
  vehicles: Entity[]
  /** the Einsatzort the rings are measured from; null → nothing to measure against */
  center: LngLat | null
  /** off for a viewer, during replay, and on a closed Einsatz — the journal is append-only,
   *  and a replay must never write into the record it is replaying */
  enabled: boolean
  log: (icon: string, text: string, kind?: 'team' | 'symbol', surface?: undefined, entityId?: string) => void
}) {
  // per vehicle: the zone that has been WRITTEN, and the zone it has been reading since when
  const state = useRef(new Map<string, { written?: Zone; pending?: Zone; since: number }>())
  // `log` is re-created every render; the effect must not re-run for that
  const logRef = useRef(log)
  logRef.current = log

  useEffect(() => {
    if (!enabled || !center) return
    const now = Date.now()
    const seen = new Set<string>()
    for (const v of vehicles) {
      if (!Array.isArray(v.coord)) continue
      seen.add(v.id)
      const zone = zoneOf(haversineM(center, v.coord as LngLat), state.current.get(v.id)?.written)
      const cur = state.current.get(v.id)
      if (!cur) {
        // FIRST sighting is never a line: the app may have been opened an hour into the
        // Einsatz, and «TLF vor Ort» stamped at the moment somebody unlocked the tablet is a
        // time that means nothing. The baseline is recorded silently and the CHANGE is what
        // gets written.
        state.current.set(v.id, { written: zone, since: now })
        continue
      }
      if (zone === cur.written) { cur.pending = undefined; continue }
      if (cur.pending !== zone) { cur.pending = zone; cur.since = now; continue }
      if (now - cur.since < SETTLE_MS) continue
      const C = appConfig.copy.contextPanel
      logRef.current(
        'truck',
        fillTemplate(zone === 'scene' ? C.logVehicleArrived : C.logVehicleLeft, { name: v.label ?? v.id }),
        'symbol', undefined, v.id,
      )
      state.current.set(v.id, { written: zone, since: now })
    }
    // a vehicle that drops out of the feed entirely is NOT «gone from the Einsatzort» — the
    // feed went quiet, the tablet lost the network, Traccar restarted. Silence is not an event.
    for (const id of [...state.current.keys()]) if (!seen.has(id)) state.current.delete(id)
  }, [vehicles, center, enabled])
}
