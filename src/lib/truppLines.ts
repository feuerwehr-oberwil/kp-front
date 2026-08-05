// Hose line ↔ Atemschutz-Trupp — the pure resolution shared by the Lage map, the Plan
// whiteboard and the printed Kroki, so one Leitung reads the same wherever it is drawn.
//
// Doctrine (decided 2026-08-05): the drawing NEVER sources the safety clock. Nothing in here is
// read by the Atemschutzüberwachung — deleting, renumbering or detaching a hose changes the
// picture, never a Trupp's contact/pressure record.
//
// A Leitung is identified by its NUMBER (`lineNo`), not by a drawing id: the same «Ltg 1» on the
// Lage and on a floor plan is one hose drawn twice, and both carry the tag. The explicit pick
// («Leitung wählen») additionally stores an ANCHOR on both sides (Trupp.lineId ⇄ line.truppId).
// Either one alone renders the tag, which is what makes the link survive both an undo of the
// stamped number (drawings are undoable, trupps are not) and a merge that keeps only one side.

import type { Trupp } from '../types'
import { abbreviateName } from './personnel'

/** As much of a drawn line as the link cares about — the shape the Lage `Drawing` and the Plan
 *  `BoardAnno` already share. */
export interface LinkableLine {
  id: string
  lineNo?: number
  truppId?: string
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

/** What the end tag says about the Trupp: the leader, abbreviated exactly like the plan chip and
 *  the map marker, so the same Trupp reads the same on every surface. */
export function truppTagText(t: Trupp): string {
  return abbreviateName(t.name)
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
