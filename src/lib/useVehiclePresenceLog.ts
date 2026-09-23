import { useEffect, useRef } from 'react'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import { haversineM } from './geo'
import { serverNow } from './serverClock'
import type { Entity, LngLat, TimelineEvent } from '../types'

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

/**
 * ⚠️ ONE ROW PER TRANSITION ACROSS THE WHOLE EINSATZ, not one per device (24.09.2026).
 *
 * Every editor device runs this hook against the same feed, and each minted its own row id —
 * so on 23.09.2026 «MAWA hat den Einsatzort verlassen» went into the record three times, at
 * 18:38:53, :58 and 18:39:04, one per tablet on the same login. Worse, a device that had been
 * asleep wrote the SAME transition again when it woke: TLF and PIO left at 20:30:01 on one
 * device and «left» again at 20:39:55 on another, MOWA and MAWA «arrived» twice ten minutes
 * apart. A time bucket cannot merge copies ten minutes apart; the journal can.
 *
 * So the row id is the vehicle's TRANSITION NUMBER in the shared Verlauf: `vp-<n>-<zone>-<id>`,
 * where n is one past the highest presence row for this vehicle any device has written. Two
 * devices settling on the same departure before either's row has synced mint the SAME id, and
 * the server keeps one (backend · journal.append_rows skips a known id); a device whose settle
 * finishes after the row arrived sees it and writes nothing. A vehicle that genuinely shuttles
 * (the MAWA made five Magazin runs that evening) gets n = 1, 2, 3 … — nothing merges that
 * happened twice.
 *
 * «Already written by someone» needs one more fact: that the row describes THIS departure and
 * not an earlier one. A row newer than the last time this device saw the vehicle in its old
 * zone can only be about the change since (`heldAt`); an older one means the vehicle came back
 * in between unrecorded, and the change is new.
 *
 * Rows written before this (random `e…` ids) are simply not presence rows to the chain; an
 * Einsatz running across the deploy keeps its per-device baseline behaviour for them.
 */
const PRESENCE_ID = /^vp-(\d+)-(scene|away)-(.+)$/

export const presenceRowId = (vehicleId: string, n: number, zone: Zone): string => `vp-${n}-${zone}-${vehicleId}`

/** The newest presence row this Verlauf holds for a vehicle, by transition number. */
export function lastPresence(rows: readonly TimelineEvent[], vehicleId: string): { n: number; zone: Zone; atMs: number } | null {
  let best: { n: number; zone: Zone; atMs: number } | null = null
  for (const r of rows) {
    const m = PRESENCE_ID.exec(r.id)
    if (!m || m[3] !== vehicleId) continue
    const n = Number(m[1])
    if (!best || n > best.n) best = { n, zone: m[2] as Zone, atMs: Date.parse(r.at ?? '') || 0 }
  }
  return best
}

/**
 * Which ring this reading is in, or `null` for the band between them — where the answer is
 * «unchanged», not a zone.
 *
 * ⚠️ `null` rather than a `prev ?? 'scene'` default (04.09.). A vehicle first seen INSIDE the
 * band has no history to hold, and defaulting it to «scene» asserted the one thing the band
 * exists to avoid asserting: on 03.09. the TLF and the PIO sat ~200 m out, and every time
 * their baseline was re-established they were booked as «vor Ort» and then, on the next scatter
 * past 300 m, wrote «hat den Einsatzort verlassen» again — three times each, at the identical
 * second, with no arrival in between, in an append-only record. The band now says nothing at
 * all, in both directions: it neither starts a state nor ends one.
 */
const zoneOf = (d: number): Zone | null => {
  if (d <= AT_SCENE_M) return 'scene'
  if (d >= LEFT_M) return 'away'
  return null
}

export function useVehiclePresenceLog({ vehicles, center, enabled, log, rows = [] }: {
  /** the RAW feed, not the overridden view: a vehicle held in place by hand (see
   *  «Festhalten») still really drives away, and that is the moment worth recording. */
  vehicles: Entity[]
  /** the Einsatzort the rings are measured from; null → nothing to measure against */
  center: LngLat | null
  /** off for a viewer, during replay, and on a closed Einsatz — the journal is append-only,
   *  and a replay must never write into the record it is replaying */
  enabled: boolean
  log: (icon: string, text: string, kind?: 'team' | 'symbol', surface?: undefined, entityId?: string, opts?: { rowId?: string }) => void
  /** the shared Verlauf (any order) — where another device's presence rows are read back */
  rows?: readonly TimelineEvent[]
}) {
  // per vehicle: the zone that has been WRITTEN, the zone it has been reading since when, and
  // the last (server-clock) moment it was read IN the written zone
  const state = useRef(new Map<string, { written?: Zone; pending?: Zone; since: number; heldAt: number }>())
  // `log` is re-created every render; the effect must not re-run for that
  const logRef = useRef(log)
  logRef.current = log
  // …nor for every new Verlauf row: the rows are consulted at the moment a settle completes
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  useEffect(() => {
    if (!enabled || !center) return
    const now = Date.now()
    const clock = serverNow()
    for (const v of vehicles) {
      if (!Array.isArray(v.coord)) continue
      const zone = zoneOf(haversineM(center, v.coord as LngLat))
      const cur = state.current.get(v.id)
      // in the band: no state starts, no state ends — that is what the band is for
      if (!zone) { if (cur) cur.pending = undefined; continue }
      if (!cur) {
        // FIRST sighting is never a line: the app may have been opened an hour into the
        // Einsatz, and «TLF vor Ort» stamped at the moment somebody unlocked the tablet is a
        // time that means nothing. The baseline is recorded silently and the CHANGE is what
        // gets written.
        state.current.set(v.id, { written: zone, since: now, heldAt: clock })
        continue
      }
      if (zone === cur.written) { cur.pending = undefined; cur.heldAt = clock; continue }
      if (cur.pending !== zone) { cur.pending = zone; cur.since = now; continue }
      if (now - cur.since < SETTLE_MS) continue
      state.current.set(v.id, { written: zone, since: now, heldAt: clock })
      const last = lastPresence(rowsRef.current, v.id)
      // another device has already written THIS change (see PRESENCE_ID) — adopt it silently
      if (last && last.zone === zone && last.atMs >= cur.heldAt) continue
      const C = appConfig.copy.contextPanel
      logRef.current(
        'truck',
        fillTemplate(zone === 'scene' ? C.logVehicleArrived : C.logVehicleLeft, { name: v.label ?? v.id }),
        'symbol', undefined, v.id, { rowId: presenceRowId(v.id, (last?.n ?? 0) + 1, zone) },
      )
    }
    // ⚠️ A vehicle that drops out of the feed KEEPS its state (04.09.). It is not «gone from the
    // Einsatzort» — the feed went quiet, the tablet lost the network, Traccar restarted, and
    // silence is not an event. That was always the rule; forgetting the vehicle broke it, because
    // the next sighting then re-baselined it and the arrival it had already been booked for was
    // swallowed as «first sighting». What the record showed for it was a second departure.
  }, [vehicles, center, enabled])
}
