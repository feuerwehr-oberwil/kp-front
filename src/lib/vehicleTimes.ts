import { appConfig } from '../config/appConfig'
import { fahrzeugRows } from './alarmzeiten'
import type { FleetVehicle } from './deploymentConfig'
import { formatTime } from './format'
import type { FahrzeugZeit } from './workspace'

/**
 * A vehicle's Einsatz clocks as read-only rows of its detail sheet (owner, batch-3 round #5,
 * 25.11.2026: «put it in the details modal (as new automatic attribute)», «Sheet only»): all four
 * walkers asked «which vehicles are vor Ort?» and found the answer only in the Verlauf, while the
 * GPS sheet said the tracker's «Online». The source is the Rapport's vehicle times
 * (`reportMeta.fahrzeuge`, the same rows as «Ausrückzeiten der Fahrzeuge»: alarm milestones,
 * the GPS geofence, a hand edit) – nothing new is stored, and nothing on the map changes.
 *
 * Shown on a GPS vehicle (matched by its Traccar device, else its name) and on a placed Fahrzeug
 * whose Bezeichnung names a fleet vehicle (label or id, case and spaces ignored). Only the
 * stages that happened; one that left and is not yet there says «Vor Ort: noch nicht».
 */
export function vehicleTimeRows(
  who: { name?: string; device?: number },
  fleet: readonly FleetVehicle[],
  fahrzeuge: FahrzeugZeit[] | undefined,
): { label: string; value: string }[] {
  const name = norm(who.name)
  if (!name && who.device == null) return []
  const row = fahrzeugRows([...fleet], fahrzeuge).find(({ config, value }) =>
    (who.device != null && value?.gps?.device === who.device) || (!!name && (norm(config.label) === name || norm(config.id) === name)))
  const v = row?.value
  if (!v) return []
  const L = appConfig.copy.contextPanel.vehicleTimes
  const clock = (iso: string) => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : formatTime(d)
  }
  return [
    v.ausgerueckt ? { label: L.ausgerueckt, value: clock(v.ausgerueckt) } : null,
    v.vorOrt ? { label: L.vorOrt, value: clock(v.vorOrt) }
      : v.ausgerueckt && !v.zurueck ? { label: L.vorOrt, value: L.notYet } : null,
    v.zurueck ? { label: L.zurueck, value: clock(v.zurueck) } : null,
  ].filter((r) => r !== null)
}

/** A GPS vehicle's Traccar device id, read off its entity id (useVehiclePositions · toEntity). */
export function gpsDeviceOf(entityId: string): number | undefined {
  const m = /^gps-(\d+)$/.exec(entityId)
  return m ? Number(m[1]) : undefined
}

const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, '').toLowerCase()
