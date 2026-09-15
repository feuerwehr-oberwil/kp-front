// Hose line ↔ Atemschutz-Trupp — the pure resolution shared by the Lage map, the Plan
// whiteboard and the printed Kroki, so one Leitung reads the same wherever it is drawn.
//
// Doctrine (decided 2026-08-05): the drawing NEVER sources the safety clock. Nothing in here is
// read by the Atemschutzüberwachung — deleting, renumbering or detaching a hose changes the
// picture, never a Trupp's contact/pressure record.
//
// A Leitung is identified by its NUMBER (`lineNo`), not by a drawing id: the same «Ltg 1» on the
// Lage and on a floor plan is one hose drawn twice, and both carry the tag. An explicit link
// additionally stores an ANCHOR on both sides (Trupp.lineId ⇄ line.truppId). Either one alone
// renders the tag, which is what makes the link survive both an undo of the stamped number
// (drawings are undoable, trupps are not) and a merge that keeps only one side.
//
// Since 15.09.2026 the link is made THROUGH THE PICTURE rather than in a tap mode: the armed
// «Leitung wählen» is gone, and a hose end snapped onto a Trupp's marker — or a Trupp's marker
// dropped on a hose's free end — IS the pick (`truppIdForAttachment` below, useTruppActions ·
// linkLineToAttachedTrupp). Letting go of the coupling again does NOT unlink: the drawing never
// touches the Trupp record, so a hose pulled off a symbol changes the picture and nothing else.

import type { LineAttachment, Trupp } from '../types'
import { abbreviateName } from './personnel'

/** As much of a drawn line as the link cares about — the shape the Lage `Drawing` and the Plan
 *  `BoardAnno` already share. */
export interface LinkableLine {
  id: string
  lineNo?: number
  truppId?: string
}

/** A placed Trupp marker as the automatic join reads it — the Karte's team `Entity` and a Plan's
 *  `resource` `BoardAnno` are the same two fields here: the object's id, and the Trupp standing
 *  on it (absent while the marker belongs to nobody). */
export interface TruppMarker {
  id: string
  truppId?: string
}

/**
 * The Trupp a hose end just joined by being attached — the automatic half of the link.
 *
 * An end only ever docks onto ONE thing, so this is the whole question: did it dock onto an
 * object, and is that object a marker somebody is standing on? Anything else — another line's
 * end, a Fahrzeug, a symbol, a marker nobody is bound to — answers `undefined` and nothing is
 * linked. `markers` may span both surfaces: an attachment legitimately names an object in the
 * other document (AGENTS.md · «An attachment may name an object in the other document»).
 */
export function truppIdForAttachment(a: LineAttachment | undefined, markers: TruppMarker[]): string | undefined {
  const target = a?.target
  if (target?.kind !== 'object') return undefined
  return markers.find((m) => m.id === target.id)?.truppId
}

/** How a linked line is drawn. `idle` = someone is on it and fine; `warn` = Kontakt fällig or
 *  Alarmdruck reached; `crit` = überfällig; `muted` = the Trupp is out (the tag stays as the
 *  record of who worked this Leitung until the next Trupp takes it). */
export type LineTone = 'idle' | 'warn' | 'crit' | 'muted'

/** The Leitung number a Trupp works on. Prefers the numeric field; falls back to the deprecated
 *  free text so incidents recorded before 2026-08-05 still match («1», «01», «Ltg 2»). Text that
 *  names no number («Res», «A») matches nothing — those Trupps use the explicit pick. */
export function truppLineNo(t: Trupp): number | undefined {
  if (t.lineNo != null && Number.isFinite(t.lineNo)) return t.lineNo
  const m = t.lineNumber?.match(/\d+/)
  const n = m ? Number(m[0]) : NaN
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Is this Trupp still working? (`raus` = out; the tag then goes muted rather than disappearing) */
const isOut = (t: Trupp) => t.status === 'raus' || !!t.exitTime
/** The same question for the surfaces that draw a linked Trupp somewhere else (the line editor's
 *  «Gehört zu Trupp …»): out ⇒ named, but as the record of who WAS on this Leitung. */
export const truppIsOut = (t?: Trupp): boolean => !!t && isOut(t)

/**
 * The Trupp a drawn line belongs to — the anchor first, then the Leitung number.
 *
 * A Trupp still in the field beats one that is already out, so a Leitung taken over by the next
 * Trupp shows who is on it NOW; the relieved one is simply replaced. Ties (two active Trupps
 * claiming one number — a mis-entry) resolve to the one that entered last, so the tag names the
 * people currently inside.
 */
export function truppForLine(line: LinkableLine, trupps: Trupp[]): Trupp | undefined {
  const anchored = trupps.filter((t) => (line.truppId && t.id === line.truppId) || (t.lineId && t.lineId === line.id))
  const numbered = line.lineNo == null ? [] : trupps.filter((t) => truppLineNo(t) === line.lineNo)
  return best(anchored) ?? best(numbered)
}

function best(cands: Trupp[]): Trupp | undefined {
  if (!cands.length) return undefined
  return [...cands].sort((a, b) =>
    Number(isOut(a)) - Number(isOut(b))
    || (b.entryTime ?? '').localeCompare(a.entryTime ?? '')
    || a.id.localeCompare(b.id))[0]
}

// ── EINE Leitung, EIN Trupp (Bastian, 15.09.2026) ──────────────────────────────────────────
//
// «lines should only get one trupp per line (i.e not on both ends or similar)». A Leitung is
// worked by one crew: two Trupps on one hose makes the tag, the Atemschutz chip and the printed
// Kroki disagree about who is on it, and on the map it produced the exact picture Bastian saw —
// a Trupp hanging off each end of the same line.
//
// THE rule lives in the three functions below, and every join entry point reads them:
//   · the Karte's magnet — a taken Leitung offers no «Anschluss frei» ring at all (MapView ·
//     freeHoseEnds / trackTeamJoin), so its free end is simply a free end,
//   · the HOSE-END magnet, from the other side — a taken Leitung does not see another Trupp's
//     marker/chip as a target at all (MapView · candidatesAt, Whiteboard · planCandidatesAt):
//     no ring, no dwell, no attach, the end stays under the finger (`markerTakesLineEnd`),
//   · the automatic link (useTruppActions · linkLineToAttachedTrupp) and the marker drop
//     (IncidentWorkspace · finishEntityMove), which FAIL CLOSED behind all of that: the picture
//     never silently replaces a crew.
// The two LIST surfaces are the deliberate exception and keep their explicit replacement — the
// Trupp form's Ltg-Nr. quick-pick and the DrawEditor's «Gehört zu Trupp» ask first, then unlink
// the previous Trupp (AtemschutzView · the `clash` branch). A list is where a takeover is a
// choice somebody is making; a drag across a map is not.
//
// ⚠️ No migration. An incident recorded before today may carry two Trupps on one hose — an
// incident is a legal record and is never rewritten. It simply RENDERS as one: `lineTruppId`
// answers with `truppForLine`'s own winner (still-in before out, latest entry first), and the
// other claim is left exactly where it is.

/** The ONE Trupp a Leitung has, or undefined while nobody is on it. Legacy data with two claims
 *  answers with the first by `truppForLine`'s order — the others are left untouched. */
export function lineTruppId(line: LinkableLine, trupps: Trupp[]): string | undefined {
  return truppForLine(line, trupps)?.id
}

/** May this Leitung still take a Trupp? False the moment one is on it — including the Trupp
 *  doing the asking, which is what stops a hose from being joined to the same crew at both ends. */
export function lineTakesTrupp(line: LinkableLine, trupps: Trupp[]): boolean {
  return !lineTruppId(line, trupps)
}

/**
 * The same rule at the MAGNET, one target at a time: may this hose end snap onto this Trupp's
 * marker at all?
 *
 * Refusing the LINK but letting the end dock anyway was the half-measure Bastian sent back — the
 * picture then shows a hose ending at a second crew while the record says otherwise, which is
 * exactly the «Trupp an beiden Enden» he was looking at. So a taken Leitung does not see another
 * Trupp's marker as a target: no ring, no dwell, no attach, the end simply stays under the finger.
 * Symbols, Hydranten and Fahrzeuge are unaffected — they say nothing about who works the hose.
 *
 * Its OWN Trupp's markers stay targets, or a coupling pulled off could never be put back on; so
 * does a marker NOBODY stands on, which claims no crew and links nothing. Only a marker carrying
 * a DIFFERENT Trupp is refused.
 * `line` may be a DRAFT that is not committed yet — pass `{ id, truppId }` built from the claim
 * its first end already made (`truppIdForAttachment`), so the rule holds inside one stroke too.
 */
export function markerTakesLineEnd(line: LinkableLine | undefined, trupps: Trupp[], marker: TruppMarker): boolean {
  if (!line) return true
  const held = lineTruppId(line, trupps)
  return !held || !marker.truppId || marker.truppId === held
}

/** What the end tag says about the Trupp: the leader, ABBREVIATED («Meier A.»). The tag hangs off
 *  the end of a hose in the middle of the picture — next to a Leitung number, a device letter and
 *  a storey badge — so it is the one place the short form stays: a full name there grows sideways
 *  across whatever the line runs over. The Trupp SYMBOL is the opposite case and spells the name
 *  out (see useTruppActions · placeTruppOnMap/placeTruppOnPlan). */
export function truppTagText(t: Trupp): string {
  return abbreviateName(t.name)
}

// ── «Ein Etikett»: the Leitung is drawn INSIDE its Trupp's marker (Karte only, 15.09.2026) ──
//
// A joined Trupp used to stand twice in the picture: its own marker with the leader's name, and,
// a few pixels away, the hose's end tag repeating «1 · Frei N.». Two objects, two tap targets,
// two places to look for one fact. The Karte now merges them — the marker carries the Leitung's
// number in the hose's own ink, and that hose draws no end tag at all.
//
// ⚠️ Karte only. `EndTag` is shared with the Plan and with the printed Kroki (kroki.py joins the
// same parts with « · »), and both of those keep the tag exactly as it was: the sheet is read on
// paper, where a marker two streets away is not «next to» anything.

/** What a Trupp's marker says about the Leitung it works. */
export interface TeamLineBadge {
  lineId: string
  /** the Leitung's number, when it has one — a hose is often drawn before it is numbered */
  lineNo?: number
  /** the hose's own ink, so the number field and the coupling read as THAT Leitung */
  color: string
  /** how the Leitung is doing (`truppLineTone`). It rides along because the merge TAKES the end
   *  tag away, and a tag whose Trupp is due or overdue outranks almost every other label on the
   *  map — so the marker that swallowed it has to inherit that rank, or a merge would quietly
   *  drop the one label somebody's air depends on. */
  tone: LineTone
  /** the hose's end is actually docked ONTO this marker, so the picture really does show it
   *  arriving here and a coupling stub can be drawn. A Trupp linked only by NUMBER (typed on the
   *  Atemschutz board, hose drawn across the street) gets the number field and no stub: the
   *  label states the link, the picture does not claim a join nobody made. */
  coupled: boolean
}

/** One drawn line as the badge pass reads it. `truppId` is the Trupp already RESOLVED for it
 *  (`truppForLine` — the surface has done that work for its own tag), and `endObjects` are the
 *  object ids its two ends are docked onto, `undefined` where an end hangs free. */
export interface BadgedLine {
  id: string
  lineNo?: number
  color: string
  tone: LineTone
  truppId?: string
  endObjects?: readonly (string | undefined)[]
}

/**
 * Merge every Leitung into the marker of the Trupp working it.
 *
 * Both halves of the one decision come back together, so nothing can disagree about it:
 * `byMarker` is what each Trupp marker draws, and `merged` names the lines whose separate end tag
 * the Karte must not draw — neither as a marker NOR as a candidate in the label pass, since a
 * suppressed label that still books its box pushes real labels off the map.
 *
 * A Trupp with several markers: each of them carries the badge, and only the one the hose
 * actually ends at gets a coupling. A Trupp on several Leitungen (a mis-entry, or a takeover
 * caught mid-merge): the coupled one wins, then the lowest number — one marker states one
 * Leitung, and only THAT one loses its tag, so the other hose keeps saying who is on it.
 */
export function teamLineBadges(
  lines: readonly BadgedLine[], markers: readonly TruppMarker[],
): { byMarker: Map<string, TeamLineBadge>; merged: Set<string> } {
  const byMarker = new globalThis.Map<string, TeamLineBadge>()
  const merged = new Set<string>()
  for (const m of markers) {
    if (!m.truppId) continue
    const mine = lines
      .filter((l) => l.truppId === m.truppId)
      .map((l) => ({ l, coupled: !!l.endObjects?.includes(m.id) }))
      .sort((a, b) => Number(b.coupled) - Number(a.coupled)
        || (a.l.lineNo ?? Number.POSITIVE_INFINITY) - (b.l.lineNo ?? Number.POSITIVE_INFINITY)
        || a.l.id.localeCompare(b.l.id))
    const pick = mine[0]
    if (!pick) continue
    byMarker.set(m.id, { lineId: pick.l.id, lineNo: pick.l.lineNo, color: pick.l.color, tone: pick.l.tone, coupled: pick.coupled })
    merged.add(pick.l.id)
  }
  return { byMarker, merged }
}

/**
 * How to draw a line for its Trupp. `severity` is the fleet's per-Trupp alarm tier (see
 * atemschutz · truppSeverities) — passed IN rather than derived here, because the contact clock's
 * 1 Hz tick lives in the alarm host and must never reach the map (it re-renders the world once a
 * second; that was a measured battery drain).
 */
export function truppLineTone(t: Trupp, severity: 0 | 1 | 2 = 0): LineTone {
  if (isOut(t)) return 'muted'
  if (severity >= 2) return 'crit'
  if (severity >= 1) return 'warn'
  return 'idle'
}

/** Leitung numbers already taken on THIS surface (the DrawEditor warns before a second «1»:
 *  a duplicate makes the number ambiguous, and the number is what identifies the Leitung). */
export function usedLineNos(lines: LinkableLine[], exceptId?: string): Set<number> {
  return new Set(lines.filter((l) => l.id !== exceptId && l.lineNo != null).map((l) => l.lineNo!))
}

/** One Leitung that actually EXISTS on a surface, for the Trupp form's picker: which number, and
 *  who is already on it. Offering these is what stops the number from being a blind guess — a
 *  Leitung is drawn long before anyone types its number into a Trupp. */
export interface LeitungOption {
  no: number
  /** the Trupp already working it (still in) — the option stays pickable, but says so */
  takenBy?: string
  /** drawn on a Plan rather than on the Lage — worth saying, the operator drew it somewhere */
  onPlan: boolean
}

/**
 * The drawn Leitungen offered in the Trupp form, lowest number first: every numbered line on
 * either surface, with the Trupp on it (if any). `exceptTruppId` is the Trupp being edited, so
 * its own Leitung never reads as «taken» by itself.
 *
 * One entry per NUMBER, not per drawing: the same Leitung drawn on the Lage and on a floor plan
 * is one hose (see the module header), so it must not appear twice.
 */
export function leitungOptions(
  mapLines: LinkableLine[], planLines: LinkableLine[], trupps: Trupp[], exceptTruppId?: string,
): LeitungOption[] {
  const byNo = new globalThis.Map<number, LeitungOption>()
  const add = (l: LinkableLine, onPlan: boolean) => {
    if (l.lineNo == null) return
    const prev = byNo.get(l.lineNo)
    // a number drawn on both surfaces counts as the Lage one (that is where it reads as placed)
    byNo.set(l.lineNo, { no: l.lineNo, onPlan: prev ? prev.onPlan && onPlan : onPlan })
  }
  mapLines.forEach((l) => add(l, false))
  planLines.forEach((l) => add(l, true))
  for (const opt of byNo.values()) {
    const holder = trupps.find((t) => t.id !== exceptTruppId && !isOut(t) && truppLineNo(t) === opt.no)
    if (holder) opt.takenBy = holder.name
  }
  return [...byNo.values()].sort((a, b) => a.no - b.no)
}

/**
 * The number BOTH sides end up carrying when a Trupp is explicitly linked to a drawn line.
 *
 * An explicit link stamps the Trupp's Leitung number onto the hose, so the drawing ends up
 * numbered as a by-product of the work — and the auto-match keeps holding even if the anchor is
 * later lost. Three cases, all ending with one number on both sides:
 *   1. the Trupp's number is free on this surface (or is already this line's) → stamp it,
 *   2. it is taken by ANOTHER line here → the drawing wins (two lines cannot share a number;
 *      a duplicate is exactly the ambiguity the number exists to avoid), so the Trupp adopts
 *      the line's number — or the next free one if the line has none,
 *   3. the Trupp has no number → adopt the line's, else stamp the next free one.
 */
export function resolveLinkNumber(trupp: Trupp, line: LinkableLine, lines: LinkableLine[], trupps: Trupp[] = []): number | null {
  const want = truppLineNo(trupp)
  const taken = usedLineNos(lines, line.id)
  if (want != null && !taken.has(want)) return want
  return line.lineNo ?? nextFreeLineNo(lines, trupps)
}

/** The next unused Leitung number (1–99) on a surface — what an explicit link stamps on a line
 *  whose Trupp has no number yet. Null when all 99 are somehow taken. */
export function nextFreeLineNo(lines: LinkableLine[], trupps: Trupp[] = []): number | null {
  const used = usedLineNos(lines)
  for (const t of trupps) { const n = truppLineNo(t); if (n != null) used.add(n) }
  for (let n = 1; n <= 99; n++) if (!used.has(n)) return n
  return null
}
