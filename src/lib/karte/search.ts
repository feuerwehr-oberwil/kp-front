// «Karte & Objekte» search, the station half (docs/karte-objekte.md · Search).
//
// The catalogue is ONE payload on the device (lib/api/stationReference), so objects are found
// client-side — offline too — by name, address and alias, the way the PlanPicker filters its list.
// Addresses come second, from the existing geocoder (`/api/geocode/search`), and only online.
//
// Ranking, best first (3am: the thing they typed the NAME of is the thing they mean):
//   1. the name starts with the query      «Schloss» → Schloss Musterdorf
//   2. a word of the name starts with it   «Musterdorf» → Schloss Musterdorf
//   3. an alias or the address starts with it, or one of their words does
//   4. it is somewhere in the name
//   5. it is somewhere in an alias or the address
// Every word of a multi-word query has to match somewhere («schloss 9»). Within a rank an object
// with plans comes before a plan-less one (objects first – «sie haben Pläne»),
// then the nearer one (when the map centre is known), then the name.
// Objects WITHOUT coordinates are found like every other one and flagged `approx` — their place
// on the map comes from the address and is only roughly right.

import type { LngLat } from '../../types'
import { haversineM } from '../geo'
import type { StationObject } from '../api/stationReference'

/** lower case, diacritics folded (ü → u, so «Schlussel» finds «Schlüssel»), spaces collapsed */
export function normText(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim()
}

const words = (s: string): string[] => s.split(/[\s,./()-]+/).filter(Boolean)

export interface ObjectHit {
  obj: StationObject
  /** 1 (best) … 5, see the header */
  rank: number
  /** metres from the map centre, when both are known */
  distanceM: number | null
  /** the catalogue has no coordinates for it — a place from the address is only approximate */
  approx: boolean
}

const KIND_ORDER: Record<StationObject['kind'], number> = { einsatzobjekt: 0, objekt: 1 }

function rankToken(tok: string, name: string, others: string[]): number | null {
  if (name.startsWith(tok)) return 1
  if (words(name).some((w) => w.startsWith(tok))) return 2
  if (others.some((o) => o.startsWith(tok) || words(o).some((w) => w.startsWith(tok)))) return 3
  if (name.includes(tok)) return 4
  if (others.some((o) => o.includes(tok))) return 5
  return null
}

/** The objects that match `query`, ranked (see the header). Empty for an empty query. */
export function searchObjects(objects: readonly StationObject[], query: string, center?: LngLat | null, limit = 8): ObjectHit[] {
  const q = normText(query)
  if (!q) return []
  const tokens = words(q)
  const hits: ObjectHit[] = []
  for (const obj of objects) {
    const name = normText(obj.name)
    const others = [obj.address, ...(obj.aliases ?? [])].map(normText).filter(Boolean)
    // the whole query as one phrase first («schloss mu»), then token by token
    let rank = rankToken(q, name, others)
    if (rank == null && tokens.length > 1) {
      const ranks = tokens.map((t) => rankToken(t, name, others))
      if (ranks.every((r) => r != null)) rank = Math.max(...(ranks as number[]))
    }
    if (rank == null) continue
    const at = coordOf(obj)
    hits.push({ obj, rank, approx: !at, distanceM: center && at ? haversineM(center, at) : null })
  }
  hits.sort((a, b) =>
    a.rank - b.rank
    || Number(b.obj.plans.length > 0) - Number(a.obj.plans.length > 0)
    || KIND_ORDER[a.obj.kind] - KIND_ORDER[b.obj.kind]
    || (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity)
    || a.obj.name.localeCompare(b.obj.name, 'de'))
  return hits.slice(0, limit)
}

/** The object's own coordinate, or null when the catalogue has none. */
export function coordOf(obj: Pick<StationObject, 'lat' | 'lng'>): LngLat | null {
  return obj.lat != null && obj.lng != null ? [obj.lng, obj.lat] : null
}

/** How many things the object has to open: its plans plus the Gebäude stack when it has floors —
 *  the number on its name tag and in the search result. */
export function openableCount(obj: Pick<StationObject, 'plans' | 'floors'>): number {
  return obj.plans.length + (obj.floors.length ? 1 : 0)
}
