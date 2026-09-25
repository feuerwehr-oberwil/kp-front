// «Trupp N» collisions between devices — found and settled by the merge (25.09.2026).
//
// ONE counter per Einsatz hands out the Trupp numbers (docs/trupp-naming.md §1), and it is not
// stored anywhere: every device derives the next number from what IT can see (placedTrupps ·
// nextTruppNo). Three devices on one login that tap «Neuer Trupp» inside the same second each
// see the same Einsatz, so each mints «Trupp 1» — and the three-way merge, which is per object,
// rightly keeps all three records. The field scenario of 24.09.2026 caught exactly that with all
// three devices online.
//
// Nothing short of a server round-trip can stop the mint, and a Trupp has to be registrable
// offline. So the collision is settled AFTER the fact, where every device already meets: in the
// merge. `resolveTruppNumbers` is a pure function of the merged Trupps and tactical objects, so
// the device that resolves a 409 and any device that re-merges the same state reach the same
// answer, and the result has no duplicate left for a later merge to act on — no ping-pong.
//
// A renumbering is a merge OUTCOME, not an act of the operator: it reaches the view through a
// hydrate (which drops the undo timeline, lib/undoTimeline) and is said ONCE in the Verlauf by
// `renumberRow`, under an id DERIVED from the change so every device that noticed it writes the
// same row and the journal keeps one (backend · journal.append_rows). Rows already written under
// the old number stay as they were written — the Verlauf is append-only — and the renumber row
// is what connects the two.

import { appConfig } from '../config/appConfig'
import { fillTemplate, formatTime } from './format'
import { truppLogName } from './atemschutz'
import { nextTruppNo, teamNameNo } from './placedTrupps'
import type { TacticalObject } from './tacticalObjects'
import type { TimelineEvent, Trupp } from '../types'

/** Something that carries a Trupp number: a registered Trupp (`Trupp.no`) or an unlinked
 *  «Trupp N» chip/marker (the number IS its label — placedTrupps · teamNameNo). */
interface Claimant {
  kind: 'trupp' | 'chip'
  id: string
  no: number
  /** how much record hangs off this number — the one with the most keeps it (see `rank`) */
  weight: number
  /** when it was minted (ms), the tie-break every device reads the same */
  created: number
}

/** The ms timestamp inside a minted id (`<prefix><ms>-…`, lib/ids · newId; older ids end in the
 *  ms). Only an ORDER key here, never shown — Infinity when the id carries none. */
function idMs(id: string): number {
  const m = /(\d{12,})/.exec(id)
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY
}

/** Did this Trupp ever go in? An Eintritt is the heaviest thing a number can carry: the
 *  Atemschutz-Journal of a crew under PA is printed under it. */
const wentIn = (t: Trupp) => !!t.entryTime || (t.readings ?? []).some((r) => r?.kind === 'entry')

/** When a Trupp was registered: its first log row (stamped on the deployment's clock,
 *  lib/serverClock), else the id's own timestamp. */
function registeredAt(t: Trupp): number {
  const first = (t.readings ?? []).reduce<number>((min, r) => {
    const ms = Date.parse(r?.t ?? '')
    return Number.isFinite(ms) ? Math.min(min, ms) : min
  }, Number.POSITIVE_INFINITY)
  return Number.isFinite(first) ? first : idMs(t.id)
}

/** The label an object shows, where the object is a Trupp chip/marker at all — the sheet's
 *  when it is sheet-anchored (that body is its truth), else the map's. */
function chipOf(o: TacticalObject): { label: string | undefined; truppId: string | undefined } | undefined {
  if (o.sheet) return o.sheet.anno.kind === 'resource' ? { label: o.sheet.anno.text, truppId: o.sheet.anno.truppId } : undefined
  return o.entity?.kind === 'team' ? { label: o.entity.label, truppId: o.entity.truppId } : undefined
}

/** The number an UNLINKED chip carries, or undefined. A chip bound to a Trupp is that Trupp's
 *  marker and wears its leader's name; its number is the Trupp's. */
function chipNo(o: TacticalObject): number | undefined {
  const c = chipOf(o)
  return c && !c.truppId ? teamNameNo(c.label) : undefined
}

/** Every label a chip carries — the counter's second input (placedTrupps · nextTruppNo). */
function chipLabels(objects: readonly TacticalObject[]): (string | undefined)[] {
  const out: (string | undefined)[] = []
  for (const o of objects) {
    if (o.sheet?.anno.kind === 'resource') out.push(o.sheet.anno.text)
    if (o.entity?.kind === 'team') out.push(o.entity.label)
  }
  return out
}

function claimantsOf(trupps: readonly Trupp[], objects: readonly TacticalObject[]): Claimant[] {
  const out: Claimant[] = []
  for (const t of trupps) {
    if (typeof t.no !== 'number' || !Number.isFinite(t.no)) continue
    out.push({ kind: 'trupp', id: t.id, no: t.no, weight: wentIn(t) ? 2 : 1, created: registeredAt(t) })
  }
  for (const o of objects) {
    const no = chipNo(o)
    if (no !== undefined) out.push({ kind: 'chip', id: o.id, no, weight: 0, created: idMs(o.id) })
  }
  return out
}

/**
 * Who KEEPS a contested number: the claimant with the most record behind it, then the one minted
 * first, then the id. Weight first, because a number is what the paper already says:
 *   2 · a Trupp that went in — its Eintritt, its Druckverlauf, its Rückzug are all printed under
 *       this number; renaming it would rename the one record that matters most;
 *   1 · a registered Trupp that has not gone in yet — its Anmeldung row is all there is;
 *   0 · a loose chip — a marker on the picture, with at most its «platziert» row.
 * Every input is part of the merged record, so every device sorts the same way.
 */
const rank = (a: Claimant, b: Claimant) =>
  b.weight - a.weight || a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The chip label for its new number, in the chip's own spelling («trupp 1» stays lower-case). */
const relabel = (label: string | undefined, no: number): string =>
  label && /\d+\s*$/.test(label) ? label.replace(/\d+(\s*)$/, `${no}$1`) : `${appConfig.copy.whiteboard.team} ${no}`

/**
 * Give every claimant of a contested «Trupp N» but one a fresh number.
 *
 * The keeper is chosen by `rank`; the others, in rank order, take the next numbers of the ONE
 * counter (`nextTruppNo` over the merged Trupps and every chip label — above everything anybody
 * holds, so a number is never reused), exactly as if they had been minted a moment later. Pure
 * and deterministic: the same merged state gives the same numbers on every device.
 *
 * Returns `null` when no number is contested (the everyday case — nothing is copied).
 */
export function resolveTruppNumbers(
  trupps: readonly Trupp[],
  objects: readonly TacticalObject[],
): { trupps: Trupp[]; objects: TacticalObject[] } | null {
  const byNo = new Map<number, Claimant[]>()
  for (const c of claimantsOf(trupps, objects)) {
    const list = byNo.get(c.no)
    if (list) list.push(c)
    else byNo.set(c.no, [c])
  }
  const losers: Claimant[] = []
  for (const no of [...byNo.keys()].sort((a, b) => a - b)) {
    const list = byNo.get(no)!
    if (list.length > 1) losers.push(...[...list].sort(rank).slice(1))
  }
  if (!losers.length) return null

  let next = nextTruppNo(trupps, chipLabels(objects))
  const truppNo = new Map<string, number>()
  const chipNoById = new Map<string, number>()
  for (const l of losers) (l.kind === 'trupp' ? truppNo : chipNoById).set(l.id, next++)

  return {
    trupps: trupps.map((t) => (truppNo.has(t.id) ? { ...t, no: truppNo.get(t.id) } : t)),
    objects: objects.map((o) => {
      const n = chipNoById.get(o.id)
      if (n === undefined) return o
      // both bodies, where both exist: a sheet chip's baked map body carries the same label
      const out: TacticalObject = { ...o }
      if (o.entity?.kind === 'team') out.entity = { ...o.entity, label: relabel(o.entity.label, n) }
      if (o.sheet?.anno.kind === 'resource') out.sheet = { ...o.sheet, anno: { ...o.sheet.anno, text: relabel(o.sheet.anno.text, n) } }
      return out
    }),
  }
}

/** One renumbering, as a device that showed the old number sees it. */
export interface TruppRenumbering {
  kind: 'trupp' | 'chip'
  /** the Trupp id / the chip's object id */
  id: string
  from: number
  to: number
  /** the Trupp as it stands now — its crew names the row (truppLogName). Trupps only. */
  trupp?: Trupp
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

/**
 * What changed its number between two states of one workspace — `before` is what this device was
 * showing (and writing Verlauf rows under), `after` what it is about to show.
 *
 * A Trupp's `no` changes for one reason only (`resolveTruppNumbers`; registration sets it once,
 * the load normaliser only fills an ABSENT one), so any change is reported. A loose chip's label
 * can also be changed by hand (useTeamMarkerActions · renameTeam, the board's rename pen), and a
 * hand rename is quiet by design — so a chip is reported only when its old number is still held
 * by somebody else afterwards, which is what a lost collision looks like and a rename does not.
 */
export function truppRenumberings(before: Record<string, unknown>, after: Record<string, unknown>): TruppRenumbering[] {
  const out: TruppRenumbering[] = []
  const was = new Map(asArray<Trupp>(before.trupps).filter((t) => t && typeof t.id === 'string').map((t) => [t.id, t]))
  for (const t of asArray<Trupp>(after.trupps)) {
    const b = t && was.get(t.id)
    if (!b || typeof b.no !== 'number' || typeof t.no !== 'number' || b.no === t.no) continue
    out.push({ kind: 'trupp', id: t.id, from: b.no, to: t.no, trupp: t })
  }
  const afterObjects = asArray<TacticalObject>(after.objects).filter((o) => o && typeof o.id === 'string')
  const wasObj = new Map(asArray<TacticalObject>(before.objects).filter((o) => o && typeof o.id === 'string').map((o) => [o.id, o]))
  let held: Set<number> | undefined
  for (const o of afterObjects) {
    const b = wasObj.get(o.id)
    const from = b && chipNo(b), to = chipNo(o)
    if (from === undefined || to === undefined || from === to) continue
    held ??= new Set(claimantsOf(asArray<Trupp>(after.trupps), afterObjects).map((c) => c.no))
    // …by somebody ELSE: this chip now holds `to`, never `from`
    if (held.has(from)) out.push({ kind: 'chip', id: o.id, from, to })
  }
  return out
}

/**
 * The ONE Verlauf row a renumbering writes: «Trupp 1 (Meier Anna / Müller Hans) heisst jetzt
 * Trupp 3», named through `truppLogName` like every other Trupp row; a loose chip is «Trupp 1».
 *
 * ⚠️ The id is DERIVED from the change (Trupp or chip id + both numbers), never minted: every
 * device that was showing the old number notices the change on its own and writes this row, and
 * the journal keeps the first and drops the rest by id — the `azal-`/`vp-` rule (AGENTS.md ·
 * «What every device OBSERVES is recorded under a DERIVED id, once»). No device can tell which
 * of them minted the Trupp, so none is singled out to say it.
 */
export function renumberRow(r: TruppRenumbering, at: string): TimelineEvent {
  const name = r.trupp ? truppLogName({ ...r.trupp, no: r.from }) : String(r.from)
  return {
    id: `trn-${r.id}-${r.from}-${r.to}`,
    t: formatTime(new Date(at)),
    at,
    icon: 'pen',
    kind: 'team',
    text: fillTemplate(appConfig.copy.atemschutz.logRenumbered, { name, no: String(r.to) }),
    subjectId: r.id,
  }
}
