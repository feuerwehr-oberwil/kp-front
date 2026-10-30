// The line under the intake picker's fixed pin (components/MapPicker, sweep 30.10.2026 #5, mock
// 5A ★5y): the address the map centre would bring into an empty «Adresse» field, live as the map
// is moved. It is the SAME reverse lookup the wizard runs after «Standort übernehmen»
// (EinsatzWizard · applyPicked, lib/api/geo · geocodeReverse) and the same answer – its `label` –
// so what the line says is what lands in the field.
//
//   · asked only once the map has come to rest, and only after PICK_LOOKUP_MS of rest: a pan is
//     dozens of centres, the backend gets the one the operator stopped on;
//   · an answer for an older centre is never shown – the line says «suche» until THIS centre is
//     answered;
//   · offline, no address near, or the lookup failed → the centre's coordinates (fmtWGS): the
//     pick is the point, never nothing.
import { useEffect, useState } from 'react'
import { geocodeReverse } from './api/geo'
import { fmtWGS } from './geo'
import type { LngLat } from '../types'

export const PICK_LOOKUP_MS = 400

export type PickLine = { kind: 'looking' } | { kind: 'address' | 'coords'; text: string }

/** a centre's identity – the precision the lookup is asked at (~0.1 m) */
export const pickKey = ([lng, lat]: LngLat) => `${lng.toFixed(6)},${lat.toFixed(6)}`

/** What the line says for the centre `at` (null: the map is still moving), given the last answer. */
export function pickLine(at: LngLat | null, answer: { key: string; label: string | null } | null, online: boolean): PickLine {
  if (!at) return { kind: 'looking' }
  const coords = { kind: 'coords' as const, text: fmtWGS(at[0], at[1]) }
  if (!online) return coords
  if (!answer || answer.key !== pickKey(at)) return { kind: 'looking' }
  return answer.label ? { kind: 'address', text: answer.label } : coords
}

type Lookup = (lat: number, lng: number) => Promise<{ label: string } | null>

/** The line for the resting centre `at` (null while the map moves); `lookup` is a test seam. */
export function usePickAddress(at: LngLat | null, online: boolean, lookup: Lookup = geocodeReverse, delay = PICK_LOOKUP_MS): PickLine {
  const [answer, setAnswer] = useState<{ key: string; label: string | null } | null>(null)
  const lng = at?.[0]
  const lat = at?.[1]
  useEffect(() => {
    if (lng === undefined || lat === undefined || !online) return
    const key = pickKey([lng, lat])
    let alive = true
    const t = setTimeout(() => {
      lookup(lat, lng)
        .then((hit) => { if (alive) setAnswer({ key, label: hit?.label ?? null }) })
        .catch(() => { if (alive) setAnswer({ key, label: null }) })
    }, delay)
    return () => { alive = false; clearTimeout(t) }
  }, [lng, lat, online, lookup, delay])
  return pickLine(at, answer, online)
}
