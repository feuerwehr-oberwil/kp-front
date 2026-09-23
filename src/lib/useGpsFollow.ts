import { useEffect } from 'react'
import { applyRouting, GPS_GUARD_METRES } from './lineAttachments'
import { haversineM } from './geo'
import type { ObjectStore } from './useObjectStore'
import type { Doc } from './workspace'
import type { Entity, LngLat } from '../types'

const samePoint = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1]
const sameCoords = (a: readonly (readonly number[])[], b: readonly (readonly number[])[]) =>
  a.length === b.length && a.every((p, i) => samePoint(p, b[i]))

/**
 * One pass of the live-GPS coupling: every Leitung end attached to a live vehicle follows it.
 *
 * External GPS movement is safety-guarded per connection. `guarded`: safe samples update only
 * the small `lastSafe` field, and a vehicle 20 m past where the operator confirmed it pauses the
 * coupling (the «Fahrzeug bewegt sich weg» banner). `continuous` (Spur): samples intentionally
 * edit and simplify the line geometry. `paused` and a vehicle missing from the feed: nothing — the
 * known position stays visible, with no prominent missing-signal alarm.
 *
 * ⚠️ IDEMPOTENT, and it has to be (24.09.2026): a sample that changes nothing BY VALUE returns
 * `cur` itself — not a copy, not a drawing with an equal-but-new `gps`. The pass runs on every
 * feed update and on every change of the device's write rights; before this it rebuilt every
 * guarded/continuous coupling on every run, and each rebuild was a store write, i.e. a render, i.e.
 * another run — the render storm and React #185 of the Übung on 23.09.2026, which also tore the
 * Karte down under a tapped Trupp. A machine writer that writes an unchanged value is a loop.
 */
export function followLiveVehicles(cur: Doc, liveVehicles: readonly Entity[]): Doc {
  let changed = false
  const next = cur.drawings.map((d) => {
    if (d.kind !== 'line') return d
    let drawing = d
    for (const endpoint of ['start', 'end'] as const) {
      const key = endpoint === 'start' ? 'startAttachment' : 'endAttachment'
      const a = drawing[key]
      if (a?.target.kind !== 'object' || !a.target.live || !a.gps) continue
      const target = liveVehicles.find((e) => e.id === a.target.id)
      if (!target || a.gps.state === 'paused') continue
      if (a.gps.state === 'guarded') {
        if (haversineM(a.gps.confirmedAt, target.coord) >= GPS_GUARD_METRES) {
          drawing = { ...drawing, [key]: { ...a, gps: { ...a.gps, state: 'paused' as const } } }
        } else if (!samePoint(a.gps.lastSafe, target.coord)) {
          drawing = { ...drawing, [key]: { ...a, gps: { ...a.gps, lastSafe: target.coord } } }
        } else continue
      } else {
        const routed = applyRouting(drawing.coords, endpoint, target.coord as LngLat, 'trace', 0.000008)
        const moved = !sameCoords(routed, drawing.coords)
        if (!moved && samePoint(a.gps.lastSafe, target.coord)) continue
        drawing = { ...drawing, ...(moved ? { coords: routed } : {}), [key]: { ...a, gps: { ...a.gps, lastSafe: target.coord } } }
      }
      changed = true
    }
    return drawing
  })
  return changed ? { ...cur, drawings: next } : cur
}

/**
 * Keep attached Leitung ends on their live vehicles (IncidentWorkspace, the Karte's store).
 *
 * `enabled` is the device's right to write the tactical document at all: a viewer, the `el` role,
 * an editor's Führungsansicht, an Einsatz- or Atemschutz-Link and a replay only READ the coupling —
 * the device that may write does the following, and the result reaches them through the sync.
 * No hover/sample audit spam: the operator's follow/pause choice is emitted by DrawEditor.
 */
export function useGpsFollow({ liveVehicles, enabled, setDocRaw }: {
  liveVehicles: readonly Entity[]
  enabled: boolean
  /** ⚠️ Must be referentially stable (useObjectStore guarantees it) — it is a dep below. */
  setDocRaw: ObjectStore['setDocRaw']
}) {
  useEffect(() => {
    if (!enabled || !liveVehicles.length) return
    // ⚠️ `gesture: false` — a poll is not a hand. This pass rewrites an attached Leitung's
    // geometry every few seconds, and read as a hand-placement it would tear a plan-drawn hose
    // off its sheet with nobody touching anything (lib/useObjectStore · setDocRaw).
    setDocRaw((cur) => followLiveVehicles(cur, liveVehicles), { gesture: false })
  }, [liveVehicles, enabled, setDocRaw])
}
