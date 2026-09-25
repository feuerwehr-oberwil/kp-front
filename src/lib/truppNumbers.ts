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
// ⚠️ Only a collision between DEVICES is settled here. A duplicate one device could have seen
// coming (⌘D on a loose chip, a hand rename to a number somebody holds, a Spur revived under a
// number that was handed out since) is refused or re-minted where it happens — see
// placedTrupps · freshTeamLabel / teamNoTaken — and never waits for an unrelated 409.
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
import { ghostCounterNames, type TruppTrail } from './truppTrails'
import type { TacticalObject } from './tacticalObjects'
import type { TimelineEvent, Trupp, TruppReading } from '../types'

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

/** A Trupp's log as the merge may hand it over: anything that is not a list reads as empty. The
 *  blob comes off the server and an old cache (mergeWorkspace · asList), and a `.some` on a
 *  malformed `readings` would throw out of the merge and wedge sync. */
const readingsOf = (t: Trupp): TruppReading[] =>
  (Array.isArray(t.readings) ? t.readings : []).filter((r): r is TruppReading => !!r && typeof r === 'object')

/** Did this Trupp ever go in? An Eintritt is the heaviest thing a number can carry: the
 *  Atemschutz-Journal of a crew under PA is printed under it. */
const wentIn = (t: Trupp) => !!t.entryTime || readingsOf(t).some((r) => r.kind === 'entry')

/** When a Trupp was registered: its first log row (stamped on the deployment's clock,
 *  lib/serverClock), else the id's own timestamp. */
function registeredAt(t: Trupp): number {
  const first = readingsOf(t).reduce<number>((min, r) => {
    const ms = Date.parse(typeof r.t === 'string' ? r.t : '')
    return Number.isFinite(ms) ? Math.min(min, ms) : min
  }, Number.POSITIVE_INFINITY)
  return Number.isFinite(first) ? first : idMs(t.id)
}

/** How much record hangs off a Trupp's number — see `rank`. */
const truppWeight = (t: Trupp) => (t.removedAt ? 0 : 2) + (wentIn(t) ? 2 : 1)

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

/** Every name the counter reads besides the Trupps' own numbers (placedTrupps · nextTruppNo):
 *  each chip's label, and each ghost trail's — a deleted chip that left a Spur still used its
 *  number, and a number is never handed out twice. */
function counterNames(objects: readonly TacticalObject[], trails: readonly TruppTrail[]): (string | undefined)[] {
  const out: (string | undefined)[] = []
  for (const o of objects) {
    if (o.sheet?.anno.kind === 'resource') out.push(o.sheet.anno.text)
    if (o.entity?.kind === 'team') out.push(o.entity.label)
  }
  return [...out, ...ghostCounterNames(trails)]
}

function claimantsOf(trupps: readonly Trupp[], objects: readonly TacticalObject[]): Claimant[] {
  const out: Claimant[] = []
  for (const t of trupps) {
    if (!t || typeof t.id !== 'string' || typeof t.no !== 'number' || !Number.isFinite(t.no)) continue
    out.push({ kind: 'trupp', id: t.id, no: t.no, weight: truppWeight(t), created: registeredAt(t) })
  }
  for (const o of objects) {
    const no = chipNo(o)
    if (no !== undefined) out.push({ kind: 'chip', id: o.id, no, weight: 0, created: idMs(o.id) })
  }
  return out
}

/**
 * Who KEEPS a contested number: the claimant with the most record behind it, then the one minted
 * first, then the id. Weight first, because a number is what the paper and the radio already say:
 *   4 · a Trupp on the board that went in — its Eintritt, its Druckverlauf, its Rückzug are all
 *       printed under this number; renaming it would rename the one record that matters most;
 *   3 · a Trupp on the board that has not gone in yet — its Anmeldung row is all there is;
 *   2 / 1 · the same two, taken OFF the board (`removedAt`). A removed Trupp still prints on the
 *       Rapport, but nobody calls it any more, and the live crew's number is the one in use;
 *   0 · a loose chip — a marker on the picture, with at most its «platziert» row.
 * Every input is part of the merged record, so every device that merges the SAME inputs sorts
 * the same way. Two merges of DIFFERENT inputs (one had seen an Eintritt the other had not) can
 * pick different keepers — whichever result lands first settles it, and it leaves nothing for a
 * later merge to settle again.
 */
const rank = (a: Claimant, b: Claimant) =>
  b.weight - a.weight || a.created - b.created || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** The chip label for its new number, in the chip's own spelling («trupp 1» stays lower-case). */
const relabel = (label: string | undefined, no: number): string =>
  label && /\d+\s*$/.test(label) ? label.replace(/\d+(\s*)$/, `${no}$1`) : `${appConfig.copy.whiteboard.team} ${no}`

/** What a merge may settle.
 *  - `all` — Trupps and loose chips: a full editor session, which pushes the whole blob.
 *  - `trupps` — Trupps among themselves only: the Atemschutz-Link, whose one write is the
 *    `trupps` slice (backend · put_workspace_trupps). A chip it relabelled would never reach the
 *    server, and the next poll would hand the old label back — a «1 → 2» row followed by
 *    «2 → 1». Its Trupps it CAN push, so it settles those.
 *  - `off` — nothing: the `el` role's `record` slice pushes no Trupp and no chip at all. */
export type NumberScope = 'all' | 'trupps' | 'off'

/**
 * Give every claimant of a contested «Trupp N» but one a fresh number.
 *
 * The keeper is chosen by `rank`; the others, in rank order, take the next numbers of the ONE
 * counter (`nextTruppNo` over the merged Trupps, every chip label and every ghost trail — above
 * everything anybody holds or held, so a number is never reused), exactly as if they had been
 * minted a moment later. A renumbered Trupp keeps the number it lost in `formerNos`, which is
 * what the Rapport's heading says it was first called. Pure and deterministic: the same merged
 * state gives the same numbers on every device.
 *
 * Returns `null` when no number is contested (the everyday case — nothing is copied).
 */
export function resolveTruppNumbers(
  trupps: readonly Trupp[],
  objects: readonly TacticalObject[],
  trails: readonly TruppTrail[] = [],
  scope: NumberScope = 'all',
): { trupps: Trupp[]; objects: TacticalObject[] } | null {
  if (scope === 'off') return null
  const byNo = new Map<number, Claimant[]>()
  for (const c of claimantsOf(trupps, scope === 'all' ? objects : [])) {
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

  let next = nextTruppNo(trupps, counterNames(objects, trails))
  const truppNo = new Map<string, number>()
  const chipNoById = new Map<string, number>()
  for (const l of losers) (l.kind === 'trupp' ? truppNo : chipNoById).set(l.id, next++)

  const renumber = (t: Trupp): Trupp => {
    const from = t.no as number
    const former = Array.isArray(t.formerNos) ? t.formerNos.filter((n): n is number => typeof n === 'number') : []
    return { ...t, no: truppNo.get(t.id), formerNos: former.includes(from) ? former : [...former, from] }
  }
  return {
    trupps: trupps.map((t) => (t && truppNo.has(t.id) ? renumber(t) : t)),
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
  /** a chip's label before and after, as the picture showed it («Trupp 1» → «Trupp 4»). Chips only. */
  fromLabel?: string
  toLabel?: string
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

/**
 * What changed its number between two states of one workspace — `before` is what was shown (or
 * what the server held), `after` what it is now.
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
    if (!b || from === undefined || to === undefined || from === to) continue
    held ??= new Set(claimantsOf(asArray<Trupp>(after.trupps), afterObjects).map((c) => c.no))
    // …by somebody ELSE: this chip now holds `to`, never `from`
    if (held.has(from)) {
      out.push({ kind: 'chip', id: o.id, from, to, fromLabel: chipOf(b)?.label?.trim(), toLabel: chipOf(o)?.label?.trim() })
    }
  }
  return out
}

/**
 * The ONE Verlauf row a renumbering writes: «Trupp 1 (Meier Anna / Müller Hans) heisst jetzt
 * Trupp 3», named through `truppLogName` like every other Trupp row; a loose chip by the labels
 * it wore («Trupp 1 heisst jetzt Trupp 4», in the chip's own spelling).
 *
 * ⚠️ The id is DERIVED from the change (Trupp or chip id + both numbers), never minted: every
 * device that was showing the old number notices the change on its own and writes this row, and
 * so does the device whose merge made it, and the journal keeps the first and drops the rest by
 * id — the `azal-`/`vp-` rule (AGENTS.md · «What every device OBSERVES is recorded under a
 * DERIVED id, once»). No device can tell which of them minted the Trupp, so none is singled out.
 */
export function renumberRow(r: TruppRenumbering, at: string): TimelineEvent {
  const A = appConfig.copy.atemschutz
  const team = appConfig.copy.whiteboard.team
  const text = r.trupp
    ? fillTemplate(A.logRenumbered, { name: truppLogName({ ...r.trupp, no: r.from }), no: String(r.to) })
    : fillTemplate(A.logRenumberedChip, { from: r.fromLabel || `${team} ${r.from}`, to: r.toLabel || `${team} ${r.to}` })
  return {
    id: `trn-${r.id}-${r.from}-${r.to}`,
    t: formatTime(new Date(at)),
    at,
    icon: 'pen',
    kind: 'team',
    text,
    subjectId: r.id,
  }
}
