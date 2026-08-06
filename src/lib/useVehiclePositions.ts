import { useEffect, useMemo, useRef, useState } from 'react'
import type { Entity, VehiclePosition } from '../types'
import { appConfig } from '../config/appConfig'
import { formatTime } from './format'

const cfg = appConfig.gps

const xmlEscape = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/**
 * Generic vehicle tactical glyph (the VKF "Fahrzeug" outline) with the vehicle
 * name baked into the body — same look as the TLF symbol, but for any name, so
 * each vehicle is identifiable on the map without clicking it. The body holds
 * ~1.46 units of width; font-size shrinks for longer names so they stay inside.
 *
 * `rotationDeg` rotates only the vehicle body (so the cab/front points the right
 * way) while the name label stays upright and readable. The glyph's neutral
 * front (rotation 0) points to the right; see `autoRotation` for the mapping
 * from a GPS compass heading. `directed` draws the front chevron (▷|) that marks
 * the travel direction — omitted for a stationary vehicle, which has no heading,
 * so a parked truck doesn't falsely point somewhere.
 */
export function vehicleSymbolSvg(name: string, rotationDeg = 0, directed = true): string {
  const label = xmlEscape(name.toUpperCase())
  const fontSize = Math.min(0.66, 1.9 / Math.max(label.length, 1)).toFixed(3)
  const r = (((rotationDeg % 360) + 360) % 360).toFixed(1)
  const c = '#00a0ff'
  const front = directed
    ? `<path d="M 0.46,-0.4 L 0.46,0.4" stroke="${c}" fill="none" stroke-width="0.07" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M 0.46,-0.4 L 1,0 L 0.46,0.4" stroke="${c}" fill="none" stroke-width="0.07" stroke-linecap="round" stroke-linejoin="round"/>`
    : ''
  return (
    `<svg viewBox="-1.3 -1.3 2.6 2.6" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">` +
    `<g transform="rotate(${r})">` +
    `<path d="M -1,0.4 L -1,-0.4 L 1,-0.4 L 1,0.4 L -1,0.4" stroke="${c}" fill="none" stroke-width="0.1" stroke-linecap="round" stroke-linejoin="round"/>` +
    front +
    `</g>` +
    `<text x="0" y="0" dy="0.35em" font-size="${fontSize}" fill="${c}" text-anchor="middle" font-family="Arial,sans-serif" font-weight="bold">${label}</text>` +
    `</svg>`
  )
}

/** GPS course (0° = north, clockwise) → glyph rotation (0° = front points right/east). */
export function autoRotation(course: number | null | undefined): number {
  return course == null ? 0 : course - 90
}

/** A vehicle is "moving" (and thus has a meaningful heading) if it reports speed above a small
 *  threshold; with no speed reported, fall back to whether a course is present. */
const MOVING_KMH = 2
export function isMoving(speed: number | null | undefined, course: number | null | undefined): boolean {
  return speed == null ? course != null : speed >= MOVING_KMH
}

/** Map a Traccar position into a read-only map entity on the Fahrzeuge layer. `heading` is the
 *  course to orient by: the live course while moving, else the last direction it moved in (so a
 *  parked vehicle keeps its heading). null only for a vehicle that has never moved → neutral body. */
function toEntity(p: VehiclePosition, heading: number | null): Entity {
  const status = cfg.status[p.status] ?? p.status
  const fields: Record<string, string> = { 'Status': status }
  if (p.speed != null) fields['Geschwindigkeit'] = `${Math.round(p.speed)} km/h`
  if (p.course != null) fields['Kurs'] = `${Math.round(p.course)}°`
  if (p.address) fields['Standort'] = p.address
  const last = new Date(p.last_update)
  if (!Number.isNaN(last.getTime())) fields['Letzte GPS-Pos.'] = formatTime(last, true)

  // orient by the heading (live while moving, else last-known) so a parked vehicle keeps pointing
  // the way it last drove; only a never-moved vehicle shows a neutral body. App overrides on top.
  const directed = heading != null
  const rotation = directed ? autoRotation(heading) : 0
  return {
    id: `gps-${p.device_id}`,
    kind: 'vehicle',
    layer: cfg.layerId,
    coord: [p.longitude, p.latitude],
    symbolSvg: vehicleSymbolSvg(p.device_name, rotation, directed),
    rotation,
    directed,
    label: p.device_name,
    subtitle: `GPS · ${status}`,
    live: true,
    fields,
  }
}

export interface VehiclePositionsApi {
  vehicles: Entity[]
  /** last fetch error message, if any (e.g. backend down, Traccar not configured) */
  error: string | null
  /**
   * True once the feed has been silent for longer than `GPS_STALE_AFTER_MS`.
   *
   * A vehicle is never removed from the map when the feed dies — that is deliberate and
   * right, absence would read as "it left" rather than "we lost the feed". But it means the
   * symbols keep sitting there looking exactly as authoritative as they did a minute ago,
   * and the FU makes positioning decisions off them. This is what lets the UI say the
   * picture is frozen while still showing it.
   */
  stale: boolean
  /** Age of the last SUCCESSFUL poll in ms; null before the first one lands. */
  ageMs: number | null
}

/**
 * Three missed polls (pollMs = 15s). Long enough that one dropped request on a flaky field
 * LTE link doesn't cry wolf, short enough that a dead feed is called out while the position
 * still resembles reality.
 */
export const GPS_STALE_AFTER_MS = 60_000

/**
 * A signature of only the map-relevant state of the fleet — id, position and rotation per vehicle.
 * Two polls with the same signature render identically, so we can skip the `setVehicles` (and the
 * full map/overlay re-render it triggers) between them. Deliberately excludes the detail-panel
 * fields (status text, "Letzte GPS-Pos." time) — a parked truck whose Traccar `last_update` keeps
 * ticking must NOT force a 15 s re-render of the whole map for a timestamp nobody is watching.
 */
export function vehiclesSignature(entities: Entity[]): string {
  return entities
    .map((e) => `${e.id}@${e.coord[0]},${e.coord[1]}#${e.rotation ?? 0}`)
    .join('|')
}

/**
 * Polls the backend's live Traccar feed and exposes the vehicles as map entities.
 * The list is fully derived from the backend each poll, so it is intentionally
 * NOT part of the editable/persisted document — vehicles can't be moved, edited
 * or deleted, and their positions update on their own.
 *
 * The request goes to `${baseUrl}${positionsPath}`. With baseUrl empty (the
 * default) the path is same-origin: our own backend serves it in production,
 * and the Vite proxy forwards it in dev (see vite.config.ts). VITE_KP_RUECK_URL
 * only exists to point a build at a different backend origin.
 */
export function useVehiclePositions(): VehiclePositionsApi {
  const [vehicles, setVehicles] = useState<Entity[]>([])
  const [error, setError] = useState<string | null>(null)
  // Timestamp of the last poll that actually returned data. A REF, not state, on purpose:
  // writing it on every successful poll would re-render the whole map overlay tree every
  // 15 s for a parked fleet — precisely what `vehiclesSignature` above exists to prevent.
  const lastOkRef = useRef<number | null>(null)
  // The staleness verdict is the only part that is state, and it is written so that a
  // healthy feed produces no state change at all (see the evaluator below).
  const [gpsAge, setGpsAge] = useState<{ stale: boolean; ageMs: number | null }>({
    stale: false,
    ageMs: null,
  })
  const timer = useRef<number | null>(null)
  // Last-known position per device, keyed by entity id. A vehicle is never
  // removed once seen — offline devices stay on the map at their latest position,
  // and a poll that happens to omit a device doesn't make it disappear.
  const known = useRef<Map<string, Entity>>(new Map())
  // last direction each device actually moved in (by device id), so a vehicle keeps its heading
  // after it stops instead of snapping to a neutral/east orientation
  const lastCourse = useRef<Map<string, number>>(new Map())
  // signature of the last vehicle list we pushed to state — lets us skip re-rendering when a poll
  // returns the same positions (a parked fleet), so an idle map stays genuinely idle between moves.
  const lastSig = useRef<string>('')

  useEffect(() => {
    let alive = true
    const url = `${cfg.baseUrl}${cfg.positionsPath}`
    const stop = () => {
      if (timer.current != null) {
        window.clearInterval(timer.current)
        timer.current = null
      }
    }

    const poll = async () => {
      try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } })
        // 503 = this deployment has no Traccar configured (404 = no backend at all): the layer
        // stays empty by design, so stop polling — an unconfigured deployment costs one request
        // per app load, not a 15 s heartbeat (the battery concern that motivated the old
        // build-time skip, which wrongly also disabled the same-origin prod path).
        if (res.status === 503 || res.status === 404) {
          stop()
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data: VehiclePosition[] = await res.json()
        if (!alive) return
        for (const p of data) {
          const id = String(p.device_id)
          // Seed from the reported course the first time we see a device: `lastCourse` is
          // per-session, so after an app reload — the normal case, the tablet is opened once the
          // vehicles are already parked at the incident — nothing has moved under our eyes and
          // every truck would point neutrally east. Traccar keeps the last fix's course on a
          // stopped device, so that value IS the direction it is standing in.
          if ((isMoving(p.speed, p.course) || !lastCourse.current.has(id)) && p.course != null) {
            lastCourse.current.set(id, p.course)
          }
          const heading = lastCourse.current.get(id) ?? null
          const e = toEntity(p, heading)
          known.current.set(e.id, e)
        }
        const list = Array.from(known.current.values())
        const sig = vehiclesSignature(list)
        // only re-render when something actually moved — a static fleet reports the same positions
        // every poll, and re-setting an identical array would churn the entire map overlay tree.
        if (sig !== lastSig.current) {
          lastSig.current = sig
          setVehicles(list)
        }
        setError(null)
        lastOkRef.current = Date.now()
      } catch (e) {
        if (!alive) return
        setError(e instanceof Error ? e.message : 'GPS nicht erreichbar')
      }
    }

    void poll()
    timer.current = window.setInterval(poll, cfg.pollMs)
    return () => {
      alive = false
      stop()
    }
  }, [])

  // Re-evaluate staleness on the poll cadence. A dead feed produces NO state changes on its
  // own — `setError` with an identical message re-renders nothing — so without this the map
  // would never notice it had frozen. Written to be a no-op while healthy: returning `prev`
  // unchanged makes React bail out, so an idle map stays genuinely idle.
  useEffect(() => {
    const evaluate = () => {
      const last = lastOkRef.current
      const ageMs = last == null ? null : Date.now() - last
      const stale = ageMs != null && ageMs > GPS_STALE_AFTER_MS
      setGpsAge((prev) => {
        if (!stale && !prev.stale) return prev // healthy: no state change, no re-render
        // While stale, only re-render when the displayed whole minute actually changes.
        if (stale && prev.stale && Math.floor((prev.ageMs ?? 0) / 60_000) === Math.floor((ageMs ?? 0) / 60_000)) return prev
        return { stale, ageMs }
      })
    }
    const id = window.setInterval(evaluate, cfg.pollMs)
    return () => window.clearInterval(id)
  }, [])

  return useMemo(() => {
    const { stale, ageMs } = gpsAge

    // Degrade the symbols in place rather than removing them. `live` deliberately stays
    // true: it means "externally sourced, not editable" and drives drag/rotate guards —
    // flipping it would quietly make frozen vehicles draggable, which is a worse bug than
    // the one being fixed. Only what the operator READS changes.
    const mins = Math.floor((ageMs ?? 0) / 60_000)
    const shown = stale
      ? vehicles.map((v) => ({
          ...v,
          subtitle: `GPS · veraltet (${mins} min)`,
          fields: { ...v.fields, 'GPS-Feed': `seit ${mins} min keine Daten` },
        }))
      : vehicles

    return { vehicles: shown, error, stale, ageMs }
  }, [vehicles, error, gpsAge])
}
