import { useEffect, useState } from 'react'
import { appConfig } from '../config/appConfig'
import { getDeploymentConfig } from '../lib/deploymentConfig'
import { hhmm } from '../lib/format'
import { useFeedPoll } from '../lib/useFeedPoll'
import { TRACCAR_DEAD_STATUSES } from '../lib/useVehiclePositions'
import { FIX_STALE_MS, fixAgeText, vehicleTableRows } from '../lib/vehiclePresence'
import type { FahrzeugZeit } from '../lib/workspace'
import type { VehiclePosition } from '../types'
import s from './VehicleGpsTable.module.css'

const clock = (iso?: string) => {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? hhmm(d) : '–'
}

/**
 * «Fahrzeuge GPS · live» — what the SERVER observed from the fleet's GPS (24.09.2026, D2), shown
 * where the vehicle times already live: under the Rapport's Fahrzeugzeiten grid.
 *
 * DISPLAY ONLY. The server's sweep writes every value here (reportMeta.fahrzeuge[].gps, backend ·
 * app/vehicle_presence); this component reads it and the positions feed, and writes nothing.
 * «an» is the first arrival, «ab» the last departure — both GPS fix times, not the moment a
 * device noticed — and «Fahrten» counts the stays on scene, the shuttle trips the Verlauf leaves
 * out on purpose. «Pos.» says how old the tracker's latest fix is, and turns amber once it has
 * gone stale: the map keeps drawing a silent vehicle where it was last seen, and this is where
 * that is said out loud.
 *
 * Renders nothing until the server has observed at least one vehicle.
 */
export function VehicleGpsTable({ fahrzeuge }: { fahrzeuge: FahrzeugZeit[] | undefined }) {
  const P = appConfig.copy.preflight
  const observed = (fahrzeuge ?? []).some((f) => f.gps)
  const [fixes, setFixes] = useState<ReadonlyMap<number, string>>(new Map())
  const [now, setNow] = useState(() => Date.now())
  // Its own read of the feed (served from one cached Traccar answer for every device): the map's
  // vehicle entities keep a stale fix time on purpose — see lib/vehiclePresence · vehicleTableRows.
  useFeedPoll<VehiclePosition[]>({
    path: appConfig.gps.positionsPath,
    pollMs: appConfig.gps.pollMs,
    enabled: observed,
    deadStatuses: TRACCAR_DEAD_STATUSES,
    onData: (data) => {
      setFixes(new Map(data.map((p) => [p.device_id, p.last_update])))
      setNow(Date.now())
    },
  })
  // the age column counts on between two polls
  useEffect(() => {
    if (!observed) return
    const t = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(t)
  }, [observed])

  const rows = vehicleTableRows(getDeploymentConfig().fleet?.vehicles ?? [], fahrzeuge, fixes, now)
  if (!rows.length) return null
  return (
    <div className="ip-field" data-sync="fahrzeuge-gps">
      <span>{P.gpsTableTitle}</span>
      <table className={s.table}>
        <thead>
          <tr>
            <th scope="col">{P.gpsColFzg}</th>
            <th scope="col">{P.gpsColStatus}</th>
            <th scope="col" className={s.num}>{P.gpsColAn}</th>
            <th scope="col" className={s.num}>{P.gpsColAb}</th>
            <th scope="col" className={s.num}>{P.gpsColFahrten}</th>
            <th scope="col" className={s.num}>{P.gpsColPos}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const stale = r.fixAgeMs != null && r.fixAgeMs > FIX_STALE_MS
            return (
              <tr key={r.id}>
                <th scope="row" className={s.name}>{r.label}</th>
                <td className={r.zone === 'scene' ? s.scene : s.away}>
                  {r.zone === 'scene' ? P.gpsStatusScene : P.gpsStatusAway}
                </td>
                <td className={s.num}>{clock(r.an)}</td>
                <td className={s.num}>{clock(r.ab)}</td>
                <td className={s.num}>{r.fahrten || '–'}</td>
                <td className={`${s.num} ${stale ? s.stale : ''}`} title={stale ? P.gpsAgeStale : undefined}>
                  {r.fixAgeMs == null ? '–' : fixAgeText(r.fixAgeMs)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <small className={s.note}>{P.gpsTableNote}</small>
    </div>
  )
}
