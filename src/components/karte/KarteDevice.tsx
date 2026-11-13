// «Karte & Objekte» — the «Offline» part of «Dieses Gerät» on home (docs/karte-objekte.md ·
// Offline; SettingsSheet · `readiness`, a sheet of its own until 13.11.2026, M9): what this device
// really holds for the viewer. The sheet opens scrolled to it from the bar's «Offline» chip and
// from the «Keine Basiskarte» Meldung. Every row is PROBED when the sheet opens (lib/karte/availability) — the catalogue and
// the register answers in IndexedDB, the plan PDFs and the base map in the service worker's
// caches — and nothing reads «●» on a guess. No «ganze Station herunterladen»: that would be
// several GB (owner, 16.10.2026); deliberate downloads of objects or areas come later.

import { useEffect, useState } from 'react'
import { appConfig } from '../../config/appConfig'
import { cx } from '../../lib/cx'
import { fmtFileSize } from '../../lib/format'
import { fmtDay } from '../../lib/buildingCard'
import { isStandalone } from '../../lib/installPrompt'
import { estimateStorage } from '../../lib/storageBudget'
import { storedBuildingCount, storedStationObjects, type StationObject } from '../../lib/api/stationReference'
import { cacheProbeable, deviceRows, planKey, planLamp, type DeviceFacts, type Lamp } from '../../lib/karte/availability'
import { heldPlanPages } from './useKarteOffline'
import { ListCard, ListRow } from '../ListRow'
import s from './Karte.module.css'
import { useReportOfflineState } from '../panels/deviceState'

export function LampDot({ lamp, className }: { lamp: Lamp; className?: string }) {
  return <span className={cx(s.lamp, lamp === 'part' && s.lampPart, lamp === 'online' && s.lampOff, className)} aria-hidden />
}

/** Plans of the whole catalogue that open on this device — their PDF or their tiles
 *  (lib/karte/availability · planLamp; a tiled sheet opened online never stores its PDF). */
async function heldPlanCount(objects: readonly StationObject[]): Promise<{ held: number; total: number } | null> {
  const plans = objects.flatMap((o) => o.plans)
  if (!cacheProbeable()) return null
  const held = await heldPlanPages(plans)
  return { held: plans.filter((p) => planLamp({ ...held[planKey(p)], meta: null }) !== 'online').length, total: plans.length }
}

export function KarteDeviceRows({ offline, objects, map }: {
  offline: boolean
  /** the catalogue the viewer shows (for the plan count) */
  objects: readonly StationObject[]
  /** the base map of the current view, from the viewer's own coverage probe */
  map: DeviceFacts['map']
}) {
  const C = appConfig.copy.karte.device
  const [facts, setFacts] = useState<Omit<DeviceFacts, 'offline' | 'map'> | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      const [stored, buildings, plans, budget] = await Promise.all([
        storedStationObjects(), storedBuildingCount(), heldPlanCount(objects), estimateStorage(),
      ])
      if (!alive) return
      setFacts({
        catalogue: stored ? { count: stored.objects.length, generatedAt: stored.generatedAt ?? null } : null,
        buildings,
        plans,
        storageFree: budget?.free ?? null,
      })
    })()
    return () => { alive = false }
  }, [objects])
  const rows = facts ? deviceRows({ ...facts, offline, map }, C, { day: fmtDay, size: fmtFileSize }) : null
  // the Einstellungen' summary (panels/deviceState): no catalogue on the device = nothing to find
  // offline, the operator is needed; a browser tab or low storage is a hint
  useReportOfflineState(!rows ? null
    : rows.some((r) => r.key === 'catalogue' && r.lamp === 'online') ? 'red'
      : !isStandalone() || rows.some((r) => r.key === 'storage' && r.lamp === 'part') ? 'warn' : 'ok')
  return (
    <div className={s.deviceRows}>
      <p className={s.deviceLead}>{offline ? C.leadOffline : C.leadOnline}</p>
      {rows ? (
        <ListCard role="list">
          {rows.map((r) => (
            <ListRow key={r.key} role="listitem" data-lamp={r.lamp} lead={<LampDot lamp={r.lamp} />} title={r.title}
              sub={<>{r.sub}<span className="sr-only">{C.lampWord[r.lamp]}</span></>} />
          ))}
        </ListCard>
      ) : (
        <ListCard><ListRow title={<span className={s.skeleton} style={{ display: 'block', width: '60%' }} />} /></ListCard>
      )}
      {!isStandalone() && <div className={cx(s.note, s.amber)}><span>{C.browserTab}</span></div>}
      <div className={s.src}>{C.foot}</div>
    </div>
  )
}
