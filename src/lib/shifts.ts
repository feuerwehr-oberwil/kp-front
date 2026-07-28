import type { AttendanceState, PresenceInterval, Shift, ShiftBand } from '../types'
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
export function barGeometry(
  from: number, to: number, span: Span,
): { left: number; width: number; clipFrom: boolean; clipTo: boolean } | null {
  const total = span.to - span.from
  if (total <= 0) return null
  const a = Math.max(from, span.from)
  const b = Math.min(to, span.to)
  if (b <= a) return null
  // clipFrom/clipTo say the bar runs on past the edge of the window. Without them a shift that
  // began before the visible stretch drew a clean vertical end exactly on the border and read as
  // if it STARTED there — a 06:00–14:00 shift looked like it started at 08:00 on an 08:00 window.
  return {
    left: (a - span.from) / total,
    width: (b - a) / total,
    clipFrom: from < span.from,
    clipTo: to > span.to,
  }
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
 * Ids of shifts that genuinely collide — flagged, never refused: at 3am a double entry is a hint
 * to look, not a reason to block the plan.
 *
 * ONLY two CONFIRMED shifts count. An overlap between states is the form working as intended:
 * «verfügbar 17:30–21:00, eingeteilt 18:30–20:00» is one person offering a window and being put
 * on part of it, which is the very relationship the sheet exists to show. Testing raw time
 * overlap painted that everyday case red — and an auto-merge tried on 2026-07-27 was pulled the
 * same day for throwing exactly that pair away. Being assigned twice at once is the real fault,
 * and now it is the only one wearing the colour.
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
        if (list[i].confirmed && list[j].confirmed && overlaps(list[i], list[j])) {
          out.add(list[i].id); out.add(list[j].id)
        }
      }
    }
  }
  return out
}

/** One genuine double booking: this person, and the stretch the two assignments share. */
export interface ShiftConflict {
  personId: string
  ids: [string, string]
  /** the OVERLAP, not either shift — that is the stretch somebody has to resolve */
  from: number
  to: number
}

/**
 * The double bookings, spelled out — who, and for which stretch.
 *
 * `conflictingShiftIds` answers «is this bar red», which is all a bar needs. It is not enough to
 * SAY anything: a red outline and a hover title are not a sentence, and on a touch screen the
 * title never appears at all. This returns what a notice can read out loud, so the surface can
 * name the person and the hours instead of hoping somebody spots a 12px sign on a blue bar.
 */
export function shiftConflicts(shifts: Shift[]): ShiftConflict[] {
  const out: ShiftConflict[] = []
  const byPerson = new Map<string, Shift[]>()
  for (const s of shifts) {
    if (!s.confirmed) continue
    const list = byPerson.get(s.personId)
    if (list) list.push(s); else byPerson.set(s.personId, [s])
  }
  for (const [personId, list] of byPerson) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = shiftSpan(list[i])
        const b = shiftSpan(list[j])
        if (!a || !b) continue
        const from = Math.max(a.from, b.from)
        const to = Math.min(a.to, b.to)
        if (to > from) out.push({ personId, ids: [list[i].id, list[j].id], from, to })
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

// ---------------------------------------------------------------- Schichtbänder (the columns)

/**
 * The shift a person has stored INTO a band — the one that carries the assignment.
 *
 * `find`, not `filter`: one cell is one member. Two members on the same band for the same person
 * can only come from two devices tapping the same empty cell at the same moment; the earlier one
 * wins the cell and the other is left to the Zeitplan, where every shift is always visible.
 */
export function shiftInBand(shifts: Shift[], personId: string, bandId: string): Shift | undefined {
  return shifts.find((s) => s.personId === personId && s.bandId === bandId)
}

/** Milliseconds two windows share; 0 when they merely touch. */
function overlapMs(aFrom: number, aTo: number, bFrom: number, bTo: number): number {
  return Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom))
}

/** A window as milliseconds; null when either end is unreadable or the pair is inverted. */
function windowOf(from: string, to: string): Span | null {
  const f = Date.parse(from)
  const t = Date.parse(to)
  return Number.isFinite(f) && Number.isFinite(t) && t > f ? { from: f, to: t } : null
}

/**
 * How much of one shift falls inside a band, as 0..1 of the BAND's length.
 *
 * A shift sitting exactly on the band counts 1. A 09:00–14:00 offer against a 07:00–12:00 band
 * covers three of its five hours and counts 0.6. That is deliberate: the head numbers answer «how
 * many do I have in this window», not «how many ticks can I see» — and somebody there for three of
 * the five hours is not one whole shift's worth of cover.
 */
export function bandCoverFraction(sh: Shift, band: ShiftBand): number {
  const b = windowOf(band.from, band.to)
  const s = windowOf(sh.from, sh.to)
  if (!b || !s) return 0
  return Math.min(1, overlapMs(s.from, s.to, b.from, b.to) / (b.to - b.from))
}

/** What one cell shows.
 *  - `deviating` — one state, but only over part of the window; the cell names those hours.
 *  - `mixed` — BOTH states inside the same window (assigned for part of it, merely offered for
 *    another part). No single word is true of it, so the cell says «teilweise» and the strip under
 *    the text draws where each state actually lies. */
export type BandCellState = 'empty' | 'available' | 'confirmed' | 'deviating' | 'mixed'

/** One stretch of the band and what holds over it. Only covered stretches appear — a gap is drawn
 *  by the strip's own background, which is what «nobody at all» looks like. */
export interface BandCellSegment {
  from: number
  to: number
  state: 'available' | 'confirmed'
}

export interface BandCell {
  state: BandCellState
  /** the coverage over THIS band, clipped to it, confirmed winning wherever it reaches */
  segments: BandCellSegment[]
  /** the band is not covered end to end — what the head's «·» mark counts */
  partial: boolean
  /** the ONE shift the cell is about, when it is about one: a stored member first, else the
   *  strongest shift covering the window. The tap acts on this; a `mixed` cell has no single
   *  answer and asks instead. */
  shift?: Shift
  /** the shift is not a member of this band, it merely covers the window */
  derived: boolean
}

/** Merge overlapping/touching spans into the fewest that cover the same time. */
function mergeSpans(list: Span[]): Span[] {
  const out: Span[] = []
  for (const x of [...list].sort((a, b) => a.from - b.from)) {
    const last = out[out.length - 1]
    if (last && x.from <= last.to) last.to = Math.max(last.to, x.to)
    else out.push({ ...x })
  }
  return out
}

/** What is left of `spans` once every stretch of `minus` is taken out of them. */
function subtractSpans(spans: Span[], minus: Span[]): Span[] {
  let cur = spans
  for (const m of minus) {
    const next: Span[] = []
    for (const c of cur) {
      if (m.to <= c.from || m.from >= c.to) { next.push(c); continue }
      if (c.from < m.from) next.push({ from: c.from, to: m.from })
      if (m.to < c.to) next.push({ from: m.to, to: c.to })
    }
    cur = next
  }
  return cur
}

/**
 * How this person's time lies across THIS band, hour by hour.
 *
 * A cell is one box and a watch is five hours, so a single word is often a half-truth: somebody
 * offered 09:00–11:00 and assigned 10:00–20:00 is, inside a 07:00–12:00 watch, nothing until 09,
 * merely available until 10, and assigned from 10. «geplant» describes the last two hours of that
 * and quietly drops the rest.
 *
 * Assigned wins wherever it reaches — being put on a watch is the stronger fact, and time that is
 * both offered and assigned is simply assigned. What is left of the offers fills the gaps, and
 * whatever neither covers stays out of the list: that is the hole.
 */
export function bandCellSegments(shifts: Shift[], personId: string, band: ShiftBand): BandCellSegment[] {
  const b = windowOf(band.from, band.to)
  if (!b) return []
  const confirmed: Span[] = []
  const offered: Span[] = []
  for (const s of shifts) {
    if (s.personId !== personId) continue
    const w = windowOf(s.from, s.to)
    if (!w) continue
    const from = Math.max(w.from, b.from)
    const to = Math.min(w.to, b.to)
    if (to <= from) continue
    ;(s.confirmed ? confirmed : offered).push({ from, to })
  }
  const conf = mergeSpans(confirmed)
  return [
    ...conf.map((x) => ({ ...x, state: 'confirmed' as const })),
    ...subtractSpans(mergeSpans(offered), conf).map((x) => ({ ...x, state: 'available' as const })),
  ].sort((a, b2) => a.from - b2.from)
}

/**
 * What this person's cell in this band shows.
 *
 * Membership in a band is stored (`bandId`) and never guessed. What the cell READS off a shift —
 * its hours and its state — is read wherever that shift happens to lie, because those are facts
 * about the shift, not about the column.
 *
 * Somebody who drew 10:00–20:00 on the Zeitplan axis is available for a 12:00–17:00 watch, and if
 * they marked that stretch «geplant» then they are ASSIGNED across it. Making them say either
 * again, in a column, would be the surface asking a question it already has the answer to. So both
 * states are read from whichever shift of theirs reaches into the window.
 *
 * That is not the same as inventing an assignment out of matching clocks, which is what decision 5
 * of the plan forbids: nothing here writes a `confirmed` flag, and nothing files anybody into a
 * band. A cell dropping out when the band moves is correct — the shift genuinely no longer covers
 * the window — because no decision was stored against that band in the first place.
 *
 * Two preferences settle which shift a cell is about:
 *  - a stored MEMBER of this band always wins. Once somebody has been put into this column, that
 *    is what the column is about, even if another shift of theirs also overlaps.
 *  - failing that, an ASSIGNMENT beats a mere availability, and only then does the wider overlap
 *    win. «Verfügbar 09–11» and «geplant 10–20» cover a 07–12 watch equally; the one that says
 *    where the person is actually going is the one the column has to show.
 */
export function bandCell(shifts: Shift[], personId: string, band: ShiftBand): BandCell {
  const member = shiftInBand(shifts, personId, band.id)
  // …but only while it still TOUCHES the window. A member can end up entirely outside its own
  // band two ways — the band was re-timed and the answer was «nur die Schicht», or the bar was
  // dragged away on the Zeitplan axis — and it then printed hours that contradicted the column
  // heading above them: «20:30–21» sitting in a 12–17 watch, counted as one assigned person who
  // covers none of it. Membership says «in this window»; once the window has moved on, the cell
  // is empty. The `bandId` is left alone, so moving the band back restores the cell, and the row
  // still names those hours in its «eigene Zeiten» mark — nothing is hidden, it is just not
  // claiming to be part of a watch it does not overlap.
  const segments = bandCellSegments(shifts, personId, band)
  const b = windowOf(band.from, band.to)
  const covered = segments.reduce((n, x) => n + (x.to - x.from), 0)
  const partial = !!b && covered < b.to - b.from
  const both = segments.some((x) => x.state === 'confirmed') && segments.some((x) => x.state === 'available')
  /** what the WHOLE window looks like, once every shift of theirs has had its say */
  const overall = (single: BandCellState): BandCellState =>
    (both || segments.length > 1 ? 'mixed' : partial ? 'deviating' : single)

  if (member && bandCoverFraction(member, band) > 0) {
    const exact = member.from === band.from && member.to === band.to
    return {
      state: overall(exact ? (member.confirmed ? 'confirmed' : 'available') : 'deviating'),
      segments,
      partial,
      shift: member,
      derived: false,
    }
  }
  // no member — does any other shift of theirs reach into this window? An assignment outranks an
  // availability; between two of a kind, the wider overlap wins.
  let best: Shift | undefined
  let bestCover = 0
  let bestAssigned = false
  for (const s of shifts) {
    if (s.personId !== personId || s.bandId === band.id) continue
    const cover = bandCoverFraction(s, band)
    if (cover <= 0) continue
    const assigned = !!s.confirmed
    if (!best || (assigned && !bestAssigned) || (assigned === bestAssigned && cover > bestCover)) {
      best = s; bestCover = cover; bestAssigned = assigned
    }
  }
  if (!best) return { state: 'empty', segments: [], partial: true, derived: false }
  // covers the whole window → plainly «verfügbar»/«geplant»; covers part of it → hatched, with the
  // real hours; two states or two stretches inside one window → «teilweise», and the strip says
  // where each of them lies
  return {
    state: overall(bestCover >= 1 ? (best.confirmed ? 'confirmed' : 'available') : 'deviating'),
    segments,
    partial,
    shift: best,
    derived: true,
  }
}

export interface BandCounts {
  /** offered into this window — stored into the band or simply covering it */
  available: number
  /** assigned (always stored) */
  confirmed: number
  /** at least one of the people counted above does NOT cover the window end to end. The head
   *  wears this as a «·»: «2» would say two people are on this watch, when at 07:00 there is one. */
  availablePartial: boolean
  confirmedPartial: boolean
}

/**
 * The two numbers in a column's head: HOW MANY PEOPLE, as whole people.
 *
 * They were counted pro rata once — somebody covering three of five hours counted 0.6 — on the
 * argument that the head should answer «how much cover do I have» rather than «how many ticks can
 * I see». In use that argument loses: a column head reading «0,8  0,8» is not a headcount, it is
 * an arithmetic puzzle at 3am, and nobody has 0.8 of a person.
 *
 * So one cell is one whole count, and the head is now exactly what you get by counting the cells
 * below it. That is the strongest property a number on a form can have — you can check it by
 * looking. The nuance did not disappear: a cell that covers only part of the window says so, in
 * its own hours, right there in the column.
 */
export function bandCounts(shifts: Shift[], band: ShiftBand): BandCounts {
  let available = 0
  let confirmed = 0
  let availablePartial = false
  let confirmedPartial = false
  for (const personId of new Set(shifts.map((s) => s.personId))) {
    const cell = bandCell(shifts, personId, band)
    if (!cell.shift) continue
    if (isAssignedCell(cell)) {
      confirmed++
      if (cell.partial) confirmedPartial = true
    } else {
      available++
      if (cell.partial) availablePartial = true
    }
  }
  return { available, confirmed, availablePartial, confirmedPartial }
}

/** Is this cell an ASSIGNMENT? Whether the shift is filed under this band or merely covers it,
 *  `confirmed` is the shift's own state: somebody geplant 10:00–20:00 is geplant for every watch
 *  those hours reach, and a column that called them «verfügbar» would be reading past the plan. */
export function isAssignedCell(cell: BandCell): boolean {
  return cell.segments.some((x) => x.state === 'confirmed')
}

/**
 * The hours a cell prints — CLAMPED to its own column.
 *
 * A cell is a statement about this window, so «verfügbar 05:00–08:00» in a watch that ends at
 * 06:00 is answering a question nobody asked: what matters here is the 05:00–06:00 of it. The full
 * stretch is on the Zeitplan axis, which is the surface that owns continuous time.
 *
 * Every cell overlaps its band by construction (`bandCell` drops a member that no longer does), so
 * there is always a slice to show; the fallbacks below are for unreadable stamps only.
 */
export function bandCellWindow(cell: BandCell, band: ShiftBand): { from: string; to: string } | null {
  if (!cell.shift) return null
  const b = windowOf(band.from, band.to)
  const s = windowOf(cell.shift.from, cell.shift.to)
  if (!b || !s) return { from: cell.shift.from, to: cell.shift.to }
  const from = Math.max(b.from, s.from)
  const to = Math.min(b.to, s.to)
  if (to <= from) return { from: cell.shift.from, to: cell.shift.to }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}

/**
 * The window a tap on this cell should assign — everything of this watch the person has covered.
 *
 * For an empty cell that is the whole band. For a derived one it is the cell's own COVERED stretch:
 * confirming somebody who offered 10:00–20:00 into a 07:00–12:00 watch assigns 10:00–12:00, not
 * the full window they never offered.
 *
 * The stretch, not one shift's share of it. Reading a single shift meant that «verfügbar 09–12»,
 * made of a 09–11 and a 10–20 offer, assigned 09–11 and left 11–12 merely offered — so a tap on a
 * settled cell put it straight back to «teilweise», and the surface looked like it was arguing
 * with itself. A cell showing one stretch is one thing; tapping it acts on that one thing.
 *
 * Only ever called for a single-segment cell: coverage in two pieces is `mixed`, and mixed asks
 * rather than cycling — so these bounds never span a gap the person did not offer.
 */
export function bandAssignWindow(cell: BandCell, band: ShiftBand): { from: string; to: string } {
  const seg = cell.derived ? cell.segments[0] : undefined
  if (!seg || cell.segments.length !== 1) return { from: band.from, to: band.to }
  return { from: new Date(seg.from).toISOString(), to: new Date(seg.to).toISOString() }
}

/**
 * One person's shifts that belong to NO band, earliest first.
 *
 * The Schichten grid can only show band membership, so somebody who drew 09:00–14:00 freihändig on
 * the axis sits empty in every column — indistinguishable from somebody who has offered nothing at
 * all. Their row carries these times as a mark instead, so the grid never claims they are free.
 */
export function freehandShifts(shifts: Shift[], personId: string): Shift[] {
  return shiftsFor(shifts, personId).filter((s) => !s.bandId)
}

/**
 * One person's shifts that NO column of this grid is showing — what the «eigene Zeiten» mark is for.
 *
 * Wider than «has no bandId»: a shift can also fall out of every column by drifting clear of the
 * band it belongs to. Asking which shifts the cells actually display, rather than which ones look
 * band-less, keeps the mark exactly as honest as the grid beside it — and keeps it quiet the
 * moment a column picks those hours up.
 */
export function unshownShifts(shifts: Shift[], personId: string, bands: ShiftBand[]): Shift[] {
  const shown = new Set<string>()
  for (const band of bands) {
    const cell = bandCell(shifts, personId, band)
    if (cell.shift) shown.add(cell.shift.id)
  }
  return shiftsFor(shifts, personId).filter((s) => !shown.has(s.id))
}

/** Bands in the order the grid puts them up: by start, then by end, then by creation. Stable, so
 *  a column never swaps places under a finger that is halfway down it. */
export function sortBands(bands: ShiftBand[]): ShiftBand[] {
  return [...bands].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.id.localeCompare(b.id))
}

/**
 * The times a new band's sheet opens on.
 *
 * The SECOND band starts where the last one ended and runs just as long, because that is the
 * sentence this surface exists for: «wir fahren 07–12 und 12–17». Typing 12:00 again to say
 * «and then the next one» is the sort of re-entry the whole grid was built to remove. The FIRST
 * band has nothing to follow, so it anchors like a drafted shift does — the next half-hour
 * boundary, or the incident start while that is still ahead.
 */
export function draftBand(bands: ShiftBand[], nowMs: number, startedAt: string | null, hours: number): { from: string; to: string } {
  const sorted = sortBands(bands)
  const last = sorted[sorted.length - 1]
  if (last) {
    const from = Date.parse(last.from)
    const to = Date.parse(last.to)
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
      return { from: last.to, to: new Date(to + (to - from)).toISOString() }
    }
  }
  const startMs = ms(startedAt)
  const base = ceilSlot(startMs != null && startMs > nowMs ? startMs : nowMs)
  return { from: new Date(base).toISOString(), to: new Date(base + hours * HOUR).toISOString() }
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
