import type { AttendanceState, PresenceInterval, Shift } from '../types'
import { intervalsOf } from './attendanceIntervals'

/**
 * Schichtenplanung — who is available from when to when, on a Wer × Zeit grid (the BGV/KKO
 * «Zeitplan» Führungsformular).
 *
 * A shift is a PLAN and never touches the attendance record: the plan says what should happen,
 * `attendance` records what did. The two are shown on the same row so the drift between them is
 * visible — planned 14:00–22:00, actually gone at 20:00 — instead of quietly diverging. Executing
 * a shift is the ordinary Anwesenheit tick (lib/attendanceIntervals), which opens a real block at
 * the real clock; nothing here writes it.
 *
 * All maths is pure and lives here so the surface stays a renderer.
 */

const MIN = 60_000
const HOUR = 60 * MIN

/** Grid resolution: half-hour columns, a heavier rule every full hour (the BGV sheet's groups). */
export const SLOT_MIN = 30
export const SLOT_MS = SLOT_MIN * MIN
/** How much of the timeline is on screen before scrolling — a long night, not a whole deployment. */
export const WINDOW_HOURS = 12
/** How far back the axis reaches: enough to see the shift that is ending, no more. */
export const LOOKBACK_HOURS = 2
/** Hard ceiling on the axis — four days, the longest Zeitraum the control offers. */
export const MAX_SPAN_HOURS = 96

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const n = new Date(iso).getTime()
  return Number.isFinite(n) ? n : null
}

/** Round down / up to the slot grid, so a bar never starts on a half pixel. */
export const floorSlot = (t: number): number => Math.floor(t / SLOT_MS) * SLOT_MS
export const ceilSlot = (t: number): number => Math.ceil(t / SLOT_MS) * SLOT_MS

export interface Span { from: number; to: number }

/**
 * The window the grid covers — exactly `windowH` hours of it.
 *
 * The Zeitraum control sets the LENGTH of the axis, so 6 h means six hours end to end. It is not
 * a minimum that content then stretches: a plan reaching into tomorrow used to blow the axis out
 * to 30 h and squash tonight into a sliver, which is the opposite of what asking for a narrower
 * window means. A shift outside the window is reached by widening it, not by the axis deciding.
 *
 * The left edge is anchored near NOW rather than at the incident start: after two days of an
 * Elementarereignis the visible edge would otherwise be an empty yesterday. It reaches
 * `LOOKBACK_HOURS` back — enough to see the shift that is ending — while a young incident still
 * starts at its own beginning, because that is nearer than the look-back.
 */
export function timelineSpan(
  startedAt: string | null, _shifts: Shift[], _attendance: AttendanceState, nowMs: number,
  windowH: number = WINDOW_HOURS,
): Span {
  const startMs = ms(startedAt) ?? nowMs
  const hours = Math.min(MAX_SPAN_HOURS, Math.max(1, windowH))
  const start = floorSlot(Math.max(startMs, nowMs - LOOKBACK_HOURS * HOUR))
  return { from: start, to: ceilSlot(start + hours * HOUR) }
}

/** Where a block sits in the window, as fractions 0..1 — null when it lies entirely outside. */
export function barGeometry(from: number, to: number, span: Span): { left: number; width: number } | null {
  const total = span.to - span.from
  if (total <= 0) return null
  const a = Math.max(from, span.from)
  const b = Math.min(to, span.to)
  if (b <= a) return null
  return { left: (a - span.from) / total, width: (b - a) / total }
}

/** A planned shift as milliseconds; null when either end is unreadable. */
export function shiftSpan(s: Shift): Span | null {
  const from = ms(s.from)
  const to = ms(s.to)
  return from != null && to != null && to > from ? { from, to } : null
}

/** An executed block as milliseconds — an open one runs to `nowMs`, which is what makes the solid
 *  bar grow while somebody is on site. */
export function intervalSpan(iv: PresenceInterval, nowMs: number): Span | null {
  const from = ms(iv.from)
  if (from == null) return null
  const to = ms(iv.to) ?? nowMs
  return to > from ? { from, to } : { from, to: from }
}

/** Do two planned shifts of the same person overlap? Touching ends (14–18, 18–22) do not. */
export function overlaps(a: Shift, b: Shift): boolean {
  const x = shiftSpan(a)
  const y = shiftSpan(b)
  if (!x || !y) return false
  return x.from < y.to && y.from < x.to
}

/**
 * Fold a person's overlapping shifts into one span.
 *
 * Availability is a SET OF TIMES, not a list of claims: «17:30–21:00» plus «18:30–20:00» for the
 * same person is not two facts, it is one — they are there from 17:30 to 21:00. Two bars stacked
 * on the same minute made the lane unreadable and let the Deckung count one person twice, which
 * is the single number the whole surface exists to get right.
 *
 * Touching ends (14–18, 18–22) stay separate. Those are genuinely two shifts and the grid draws
 * them as such — same rule `overlaps` already uses.
 *
 * `confirmed` survives if ANY merged part carried it: eingeteilt implies verfügbar, so dropping
 * it would silently un-assign somebody. The merged block keeps the id of the EARLIEST part, so a
 * drag that swallows a neighbour still ends on the bar the finger is holding.
 *
 * Reversed blocks (to <= from) are left strictly alone — they render as nothing and are flagged
 * in the sheet; quietly folding them would hide a typo instead of showing it.
 */
export function mergeOverlappingShifts(shifts: Shift[]): Shift[] {
  const spans = new Map<string, Span>()
  for (const s of shifts) {
    const sp = shiftSpan(s)
    if (sp) spans.set(s.id, sp)
  }
  const byPerson = new Map<string, Shift[]>()
  for (const s of shifts) {
    if (!spans.has(s.id)) continue
    const list = byPerson.get(s.personId)
    if (list) list.push(s); else byPerson.set(s.personId, [s])
  }

  const absorbed = new Set<string>()
  const patched = new Map<string, Shift>()
  for (const list of byPerson.values()) {
    const sorted = [...list].sort((a, b) => spans.get(a.id)!.from - spans.get(b.id)!.from)
    let head: Shift | null = null
    let from = 0
    let to = 0
    let confirmed = false
    let grew = false
    const flush = () => {
      if (head && grew) {
        patched.set(head.id, {
          ...head, from: new Date(from).toISOString(), to: new Date(to).toISOString(),
          confirmed: confirmed || undefined,
        })
      }
    }
    for (const s of sorted) {
      const sp = spans.get(s.id)!
      if (head && sp.from < to) { // strict «<»: a shared edge is not an overlap
        to = Math.max(to, sp.to)
        confirmed = confirmed || !!s.confirmed
        absorbed.add(s.id)
        grew = true
        continue
      }
      flush()
      head = s; from = sp.from; to = sp.to; confirmed = !!s.confirmed; grew = false
    }
    flush()
  }

  if (!absorbed.size) return shifts // reference-stable in the common case: nothing overlapped
  return shifts.filter((s) => !absorbed.has(s.id)).map((s) => patched.get(s.id) ?? s)
}

/**
 * Ids of shifts that collide with another shift for the same person.
 *
 * Still needed even though `mergeOverlappingShifts` now prevents overlaps at the point of entry:
 * this workspace syncs per object with last-writer-wins, so two devices can each add a
 * non-overlapping shift and the MERGED result overlaps although neither device ever created it.
 * That one arrives as data, not as an edit, so it can only be flagged.
 */
export function conflictingShiftIds(shifts: Shift[]): Set<string> {
  const out = new Set<string>()
  const byPerson = new Map<string, Shift[]>()
  for (const s of shifts) {
    const list = byPerson.get(s.personId)
    if (list) list.push(s); else byPerson.set(s.personId, [s])
  }
  for (const list of byPerson.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (overlaps(list[i], list[j])) { out.add(list[i].id); out.add(list[j].id) }
      }
    }
  }
  return out
}

export interface CoverageSlot {
  at: number
  /** offered but not yet assigned */
  available: number
  /** assigned (a confirmed shift) */
  planned: number
  /** actually on site, per the attendance record; 0 in the future — nobody knows yet */
  actual: number
}

/**
 * How many people are planned — and how many are actually there — in each slot of the window.
 *
 * This is the point of the whole surface: a wall of bars does not show the hole at 02:00, a
 * coverage row does. `actual` counts open blocks up to `nowMs` only, so the future never pretends
 * to know who will be there.
 */
export function coverage(shifts: Shift[], attendance: AttendanceState, span: Span, nowMs: number): CoverageSlot[] {
  const slots: CoverageSlot[] = []
  const spanOf = (list: Shift[]) => list.map(shiftSpan).filter((s): s is Span => !!s)
  // the three states counted apart: «wie viele sind eingeteilt» and «wie viele haben sich
  // gemeldet» are different questions, and a strip that merged them answered neither
  const planned = spanOf(shifts.filter((x) => x.confirmed))
  const available = spanOf(shifts.filter((x) => !x.confirmed))
  const actual: Span[] = []
  for (const e of Object.values(attendance)) {
    for (const iv of intervalsOf(e)) {
      const s = intervalSpan(iv, nowMs)
      if (s) actual.push(s)
    }
  }
  for (let at = span.from; at < span.to; at += SLOT_MS) {
    const mid = at + SLOT_MS / 2
    const covering = (list: Span[]) => list.filter((s) => s.from <= mid && mid < s.to).length
    slots.push({
      at,
      available: covering(available),
      planned: covering(planned),
      actual: mid <= nowMs ? covering(actual) : 0,
    })
  }
  return slots
}

/** Shifts of one person, earliest first — the row's own bars. */
export function shiftsFor(shifts: Shift[], personId: string): Shift[] {
  return shifts.filter((s) => s.personId === personId).sort((a, b) => a.from.localeCompare(b.from))
}

/** How many people carry at least one planned shift — the surface's summary line. */
export function plannedPersonCount(shifts: Shift[]): number {
  return new Set(shifts.map((s) => s.personId)).size
}

/**
 * A fresh shift for a person: it starts at the next slot boundary from `nowMs` (or the incident
 * start while that is still ahead) and runs one default watch, so the chips open on something
 * plausible rather than on 00:00–00:00.
 */
export function draftShift(personId: string, nowMs: number, startedAt: string | null, hours: number): Shift {
  const startMs = ms(startedAt)
  const base = ceilSlot(startMs != null && startMs > nowMs ? startMs : nowMs)
  return {
    id: `sh${Date.now()}`,
    personId,
    from: new Date(base).toISOString(),
    to: new Date(base + hours * HOUR).toISOString(),
  }
}

// ---------------------------------------------------------------- direct manipulation on the grid

/** Wall-clock time under a pointer, snapped to the half-hour grid and clamped to the window.
 *  A non-finite fraction — a lane measured at zero width mid-layout, a pointer event that carries
 *  no usable coordinate — resolves to the window start rather than poisoning a shift with NaN. */
export function timeAtFraction(fraction: number, span: Span): number {
  // clamp first so ±Infinity lands on an edge; only a genuine NaN falls back to the start
  const clamped = Math.max(0, Math.min(1, fraction))
  const f = Number.isFinite(clamped) ? clamped : 0
  const raw = span.from + f * (span.to - span.from)
  return Math.max(span.from, Math.min(span.to, Math.round(raw / SLOT_MS) * SLOT_MS))
}

/** A shift begun by tapping empty lane at `at` — one default watch, clipped to the window's end. */
export function shiftAt(personId: string, at: number, hours: number, span: Span): Shift {
  const want = Number.isFinite(at) ? at : span.from
  const from = Math.max(span.from, Math.min(want, span.to - SLOT_MS))
  const to = Math.min(from + (Number.isFinite(hours) ? hours : 1) * HOUR, span.to)
  return {
    id: `sh${Date.now()}`,
    personId,
    from: new Date(from).toISOString(),
    to: new Date(Math.max(to, from + SLOT_MS)).toISOString(),
  }
}

export type DragEdge = 'move' | 'from' | 'to'

/**
 * A bar under the finger: dragged whole, or by one end. Everything snaps to the half-hour grid and
 * never inverts — a shift always keeps at least one slot.
 *
 * The window deliberately does NOT clamp the result. It is a viewport, not a constraint on the
 * data, and clamping to it corrupted shifts: for a shift LONGER than the visible window,
 * `span.to - len` falls below `span.from`, so every move — even a one-pixel slip — snapped it to
 * the window start. A 10:00–22:00 shift became 14:00–02:00 on a 6 h horizon, four hours adrift,
 * with no undo. A drag can only ever move a bar by the window's own width anyway, so nothing runs
 * away; `barGeometry` clips whatever ends up off-screen.
 */
export function dragShift(sh: Shift, edge: DragEdge, deltaMs: number, _span: Span): Shift {
  const from = Date.parse(sh.from)
  const to = Date.parse(sh.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(deltaMs)) return sh
  const snap = (t: number) => Math.round(t / SLOT_MS) * SLOT_MS

  if (edge === 'move') {
    const len = to - from
    const nf = snap(from + deltaMs)
    return { ...sh, from: new Date(nf).toISOString(), to: new Date(nf + len).toISOString() }
  }
  if (edge === 'from') {
    const nf = Math.min(snap(from + deltaMs), to - SLOT_MS)
    return { ...sh, from: new Date(nf).toISOString() }
  }
  const nt = Math.max(snap(to + deltaMs), from + SLOT_MS)
  return { ...sh, to: new Date(nt).toISOString() }
}
