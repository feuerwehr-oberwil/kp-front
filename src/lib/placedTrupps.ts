import { appConfig } from '../config/appConfig'
import { floorLabel } from './whiteboard'
import { matchesQuery, type SearchQuery } from './search'
import type { TacticalObject } from './tacticalObjects'
import type { LngLat, PlanDocument, Trupp, TruppKind } from '../types'

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
 *
 * ⚠️ And WHICH surface it stands on is the object's ANCHOR, never which collection holds its id.
 * Those were the same question while an object lived in exactly one of them; they stopped being
 * the same the day the Karte started drawing plan-drawn objects itself (lib/tacticalObjects). A
 * plan chip then read as a map placement — it was listed as «Lage», its join wrote `entityId`
 * instead of `annoId`+`planId`, the Verlauf said «auf der Karte platziert», and the picker
 * offered the same chip twice under one React key.
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
  /** …and its number (types · Trupp.no), for the badge beside the name */
  no?: number
  status?: Trupp['status']
  /** the Trupp's Art, when this chip is bound to one (types · TruppKind). Read through
   *  `isAtemschutzTrupp` — absent on a chip that carries no Trupp at all, and absent ON a Trupp
   *  recorded before 03.09., which MEANS «unter Atemschutz». */
  kind?: TruppKind
  /** the people in it — shown under the name, and searched */
  members: string[]
  target:
    | { kind: 'map'; entityId: string; coord: LngLat }
    | { kind: 'plan'; planId: string; annoId: string; x: number; y: number; floor: number }
}

const truppOf = (trupps: Trupp[], id: string | undefined) => (id ? trupps.find((t) => t.id === id) : undefined)

/** The regex that reads a generic chip name — «Trupp 3» in the app's own wording. */
const teamNameRe = () => {
  const word = appConfig.copy.whiteboard.team
  return new RegExp(`^${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d+)$`, 'i')
}

/** The number a generic chip name carries — «Trupp 3» → 3; a renamed chip → undefined. */
export function teamNameNo(name: string | undefined): number | undefined {
  const m = name?.trim().match(teamNameRe())
  return m ? parseInt(m[1], 10) : undefined
}

/**
 * The next free Trupp number on this Einsatz — ONE counter across the Atemschutz board and every
 * unlinked chip on the Karte and the plans (docs/trupp-naming.md §1).
 *
 * A registered Trupp carries its number (`Trupp.no`, removed ones included — a number is never
 * reused); an unlinked chip IS its number, «Trupp N» in its label. Both count, so a «Trupp 2»
 * dropped on the Lage at 03:12 and the Atemschutz-Trupp registered at 03:14 cannot both be
 * called Trupp 2 — and when they turn out to be the same crew, linking relabels the chip.
 */
export function nextTruppNo(trupps: Iterable<{ no?: number }>, chipNames: Iterable<string | undefined>): number {
  let max = 0
  for (const t of trupps) if (typeof t.no === 'number' && Number.isFinite(t.no)) max = Math.max(max, t.no)
  for (const name of chipNames) max = Math.max(max, teamNameNo(name) ?? 0)
  return max + 1
}

/**
 * The next free generic chip name — «Trupp N» from the same counter the Atemschutz board numbers
 * from (`nextTruppNo`), so a chip and a registered Trupp never share a number.
 *
 * Each surface used to count only its own chips, so a linked Karte and Modul both started at
 * «Trupp 1» — and the mirror then showed the two same-named chips side by side as what read as
 * one duplicated Trupp. The caller passes the names of EVERY placed chip it can see (all plans
 * and the Karte) plus the registered Trupps.
 */
export function nextTeamName(taken: Iterable<string | undefined>, trupps: Iterable<{ no?: number }> = []): string {
  return `${appConfig.copy.whiteboard.team} ${nextTruppNo(trupps, taken)}`
}

/** Everyone in a Trupp, leader first — the order the card and the Kroki print. */
function membersOf(t: Trupp | undefined): string[] {
  if (!t) return []
  return [t.name, ...(t.members ?? [])].map((n) => (n ?? '').trim()).filter(Boolean)
}

export function placedTrupps(
  objects: TacticalObject[],
  planDocs: PlanDocument[],
  trupps: Trupp[],
): PlacedTrupp[] {
  const out: PlacedTrupp[] = []
  const A = appConfig.copy.atemschutz

  for (const o of objects) {
    if (o.sheet) {
      const a = o.sheet.anno
      if (a.kind !== 'resource') continue
      const doc = planDocs.find((p) => p.id === o.sheet!.planId)
      const t = truppOf(trupps, a.truppId)
      // a floor-stack chip says which storey; a flat plan has none to say
      const floor = a.floor ?? 0
      const stack = !!doc?.floorStack
      out.push({
        key: a.id,
        name: (a.text ?? '').trim() || A.truppFallbackName,
        color: a.color,
        where: [doc?.code ?? o.sheet.planId, stack ? floorLabel(floor) : ''].filter(Boolean).join(' · '),
        truppId: t?.id,
        no: t?.no,
        status: t?.status,
        kind: t?.kind,
        members: membersOf(t),
        target: { kind: 'plan', planId: o.sheet.planId, annoId: a.id, x: a.x ?? 0.5, y: a.y ?? 0.5, floor },
      })
      continue
    }
    // ⚠️ Live entities are never records, so they are never in the store: a Fahrzeug arriving
    // from the GPS feed is not a Trupp somebody placed, and it is already findable as the
    // vehicle it is.
    const e = o.entity
    if (e?.kind !== 'team') continue
    const t = truppOf(trupps, e.truppId)
    out.push({
      key: e.id,
      name: (e.label ?? '').trim() || A.truppFallbackName,
      color: e.color,
      where: appConfig.copy.modes.map,
      truppId: t?.id,
      no: t?.no,
      status: t?.status,
      kind: t?.kind,
      members: membersOf(t),
      target: { kind: 'map', entityId: e.id, coord: e.coord },
    })
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

/**
 * ─── Joining a placed marker to an Atemschutz-Trupp ─────────────────────────────────────────
 *
 * The mirror of the Leitung link (lib/truppLines): the marker and the Trupp find each other in
 * ANY order. A generic «Trupp 2» dropped on the Lage before anybody was registered can be joined
 * to its Trupp later, from either side — the marker's own panel, or the Trupp's card.
 *
 * Two differences to a Leitung, both because a marker is a PLACE and a hose is a thing:
 *   · there is no number to identify it, so the anchor (`Entity.truppId` / `BoardAnno.truppId`
 *     ⇄ `Trupp.entityId` / `annoId+planId`) is the whole link — no auto-match by name,
 *   · one Trupp stands at exactly ONE place (Trupp.annoId doc comment), so joining a second
 *     marker moves the Trupp rather than adding a copy.
 *
 * ⚠️ Joining and un-joining NEVER touch the safety clock. Same doctrine the hose link follows:
 * the picture says where a Trupp is, the Atemschutzüberwachung says how it is doing, and moving
 * a symbol is not a Funkkontakt.
 */

/** Which surface a placed marker lives on — what a join has to write on the Trupp. */
export type MarkerSite =
  | { kind: 'map'; entityId: string }
  | { kind: 'plan'; planId: string; annoId: string }

export interface MarkerJoin {
  site: MarkerSite
  /** the Trupp that stands here now — a takeover, and the one case that asks first */
  holder?: Trupp
  /** already this Trupp's marker: joining it again is a no-op, not a takeover of itself */
  own: boolean
}

/**
 * What joining `markerId` to `truppId` would mean. `undefined` = there is nothing to join: the
 * id names no marker at all, or it names something that is not a placed Trupp (a symbol, a
 * drawing, a Fahrzeug arriving live from the GPS feed — that one is the vehicle it is, not a
 * Trupp somebody put down).
 *
 * A `raus` holder counts like any other: its card still shows «auf der Lage zeigen», so taking
 * the marker away from it silently would leave that button pointing at somebody else's Trupp.
 */
export function resolveMarkerJoin(
  markerId: string, truppId: string, objects: TacticalObject[], trupps: Trupp[],
): MarkerJoin | undefined {
  const site = markerSite(markerId, objects)
  if (!site) return undefined
  const holder = trupps.find((t) => !t.removedAt && t.id !== truppId
    && (t.entityId === markerId || t.annoId === markerId))
  return { site, holder, own: trupps.some((t) => t.id === truppId && (t.entityId === markerId || t.annoId === markerId)) }
}

/** Where a placed marker stands, or undefined when the id names nothing joinable.
 *
 *  ⚠️ The ANCHOR decides, not which collection holds the id — see the note on `placedTrupps`.
 *  A plan chip is on a plan even though the Karte draws it too, and writing `entityId` for one
 *  would take its plan coordinates out of the Trupp's record. */
export function markerSite(markerId: string, objects: TacticalObject[]): MarkerSite | undefined {
  const o = objects.find((x) => x.id === markerId)
  if (!o) return undefined
  if (o.sheet) return o.sheet.anno.kind === 'resource' ? { kind: 'plan', planId: o.sheet.planId, annoId: markerId } : undefined
  return o.entity?.kind === 'team' ? { kind: 'map', entityId: markerId } : undefined
}

/** One placed marker offered on a Trupp card, the twin of truppLines · LeitungOption. */
export interface MarkerOption {
  key: string
  name: string
  /** said the way the operator would say it: «Lage» / «Gebäude · 2. OG» */
  where: string
  color?: string
  /** the Trupp standing here already — the option stays pickable, but says so */
  takenBy?: string
}

/**
 * The placed markers a Trupp card offers, free ones first: everything standing on the Lage or a
 * plan, minus the Trupp's OWN marker (picking that changes nothing, and offering a no-op reads
 * as a dead row). A marker somebody else holds is offered too — an Ablösung at the same spot is
 * the normal case, it just has to be said out loud (see useTruppActions · adoptTruppMarker).
 */
export function markerOptions(placed: PlacedTrupp[], trupps: Trupp[], exceptTruppId?: string): MarkerOption[] {
  const free: MarkerOption[] = []
  const taken: MarkerOption[] = []
  for (const p of placed) {
    if (p.truppId && p.truppId === exceptTruppId) continue
    // the HOLDER's name, not the marker's label: the two are kept in sync, but the card is
    // naming a Trupp here and must say what the Atemschutz board calls it
    const holder = p.truppId ? trupps.find((t) => t.id === p.truppId && !t.removedAt) : undefined
    const opt: MarkerOption = { key: p.key, name: p.name, where: p.where, color: p.color, takenBy: holder?.name }
    ;(opt.takenBy ? taken : free).push(opt)
  }
  return [...free, ...taken]
}
