import { appConfig } from '../config/appConfig'
import { floorLabel } from './whiteboard'
import { matchesQuery, type SearchQuery } from './search'
import type { BoardAnno, BoardDoc, Entity, LngLat, PlanDocument, Trupp } from '../types'

/**
 * Every Trupp that is standing somewhere on this Einsatz — the Lage map AND the plan boards,
 * Atemschutz or not.
 *
 * A Trupp marker is placed once and then looked for again and again: «wo ist Trupp 2» is asked
 * at the map, and the answer used to require remembering which surface it was put on and then
 * finding a chip among the symbols. The Atemschutz board could jump to its own Trupps
 * (useTruppActions · focusTruppOnPlan), but only to those — a team marker dropped straight onto
 * the Lage, or onto a Gebäude storey, was reachable only by looking for it.
 *
 * ⚠️ The MARKER is the source of truth here, not the Atemschutz Trupp: what «placed» means is
 * that something is drawn somewhere. A marker that happens to carry `truppId` additionally
 * borrows that Trupp's members and status, which is what makes searching for an AdF's name find
 * the Trupp they are in.
 */
export interface PlacedTrupp {
  /** stable per marker — the entity / anno id, so two chips of the same name stay two rows */
  key: string
  name: string
  color?: string
  /** where it stands, said the way the operator would say it: «Lage» / «Gebäude · 2. OG» */
  where: string
  /** the Atemschutz Trupp behind this chip, when there is one */
  truppId?: string
  status?: Trupp['status']
  /** the people in it — shown under the name, and searched */
  members: string[]
  target:
    | { kind: 'map'; entityId: string; coord: LngLat }
    | { kind: 'plan'; planId: string; annoId: string; x: number; y: number; floor: number }
}

const truppOf = (trupps: Trupp[], id: string | undefined) => (id ? trupps.find((t) => t.id === id) : undefined)

/** Everyone in a Trupp, leader first — the order the card and the Kroki print. */
function membersOf(t: Trupp | undefined): string[] {
  if (!t) return []
  return [t.name, ...(t.members ?? [])].map((n) => (n ?? '').trim()).filter(Boolean)
}

export function placedTrupps(
  entities: Entity[],
  board: BoardDoc,
  planDocs: PlanDocument[],
  trupps: Trupp[],
): PlacedTrupp[] {
  const out: PlacedTrupp[] = []
  const A = appConfig.copy.atemschutz

  for (const e of entities) {
    // ⚠️ Live entities are excluded: a Fahrzeug arriving from the GPS feed is not a Trupp
    // somebody placed, and it is already findable as the vehicle it is.
    if (e.kind !== 'team' || e.live) continue
    const t = truppOf(trupps, e.truppId)
    out.push({
      key: e.id,
      name: (e.label ?? '').trim() || A.truppFallbackName,
      color: e.color,
      where: appConfig.copy.modes.map,
      truppId: t?.id,
      status: t?.status,
      members: membersOf(t),
      target: { kind: 'map', entityId: e.id, coord: e.coord },
    })
  }

  for (const [planId, annos] of Object.entries(board)) {
    const doc = planDocs.find((p) => p.id === planId)
    for (const a of annos as BoardAnno[]) {
      if (a.kind !== 'resource') continue
      const t = truppOf(trupps, a.truppId)
      // a floor-stack chip says which storey; a flat plan has none to say
      const floor = a.floor ?? 0
      const stack = !!doc?.floorStack
      out.push({
        key: a.id,
        name: (a.text ?? '').trim() || A.truppFallbackName,
        color: a.color,
        where: [doc?.code ?? planId, stack ? floorLabel(floor) : ''].filter(Boolean).join(' · '),
        truppId: t?.id,
        status: t?.status,
        members: membersOf(t),
        target: { kind: 'plan', planId, annoId: a.id, x: a.x ?? 0.5, y: a.y ?? 0.5, floor },
      })
    }
  }

  // Placed order is arrival order and means nothing to somebody looking for a name. Sorted the
  // way the eye scans a list of Trupps: still working first, then by name (numeric-aware, so
  // «Trupp 10» sits after «Trupp 9» rather than after «Trupp 1»).
  return out.sort((a, b) =>
    Number(a.status === 'raus') - Number(b.status === 'raus')
    || a.name.localeCompare(b.name, 'de', { numeric: true }))
}

/** Name first, then the people in it — so «Müller» finds the Trupp Müller is in. */
export function truppMatches(p: PlacedTrupp, q: SearchQuery): boolean {
  return matchesQuery(q, p.name) || p.members.some((m) => matchesQuery(q, m))
}
