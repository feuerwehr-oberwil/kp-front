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
/** Hard ceiling on the axis, so one shift planned days out can't squash today into a sliver. */
export const MAX_SPAN_HOURS = 48

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
 * The window the grid covers.
 *
 * Anchored near NOW, not at the incident start: after two days of an Elementarereignis the axis
 * would otherwise span 50 hours, and the visible left edge would show an empty yesterday while
 * the shift you are planning sits far off to the right. A Zeitplan is about the coming hours, so
 * it reaches `LOOKBACK_HOURS` back — enough to see the shift that is ending — and forward far
 * enough to hold every planned block, capped at `MAX_SPAN_HOURS`. A young incident still starts
 * at its own beginning, because that is nearer than the look-back.
 */
export function timelineSpan(startedAt: string | null, shifts: Shift[], attendance: AttendanceState, nowMs: number, windowH: number = WINDOW_HOURS): Span {
  const startMs = ms(startedAt) ?? nowMs
  const start = floorSlot(Math.max(startMs, nowMs - LOOKBACK_HOURS * HOUR))
  let end = start + windowH * HOUR
  const bump = (t: number | null) => { if (t != null && t > end) end = t }
  for (const s of shifts) { bump(ms(s.to)); bump(ms(s.from)) }
  for (const e of Object.values(attendance)) {
    for (const iv of intervalsOf(e)) { bump(ms(iv.to)); bump(ms(iv.from)) }
  }
  bump(nowMs + HOUR) // always a little room to plan ahead of the clock
  return { from: start, to: ceilSlot(Math.min(end, start + MAX_SPAN_HOURS * HOUR)) }
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

/** Ids of shifts that collide with another shift for the same person — flagged, never refused:
 *  at 3am a double entry is a hint to look, not a reason to block the plan. */
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

export interface CoverageSlot { at: number; planned: number; actual: number }

/**
 * How many people are planned — and how many are actually there — in each slot of the window.
 *
 * This is the point of the whole surface: a wall of bars does not show the hole at 02:00, a
 * coverage row does. `actual` counts open blocks up to `nowMs` only, so the future never pretends
 * to know who will be there.
 */
export function coverage(shifts: Shift[], attendance: AttendanceState, span: Span, nowMs: number): CoverageSlot[] {
  const slots: CoverageSlot[] = []
  const planned = shifts.map(shiftSpan).filter((s): s is Span => !!s)
  const actual: Span[] = []
  for (const e of Object.values(attendance)) {
    for (const iv of intervalsOf(e)) {
      const s = intervalSpan(iv, nowMs)
      if (s) actual.push(s)
    }
  }
  for (let at = span.from; at < span.to; at += SLOT_MS) {
    const mid = at + SLOT_MS / 2
    slots.push({
      at,
      planned: planned.filter((s) => s.from <= mid && mid < s.to).length,
      actual: mid <= nowMs ? actual.filter((s) => s.from <= mid && mid < s.to).length : 0,
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
 * A bar under the finger: dragged whole, or by one end. Everything snaps to the half-hour grid,
 * never inverts (a shift always keeps at least one slot), and stays inside the window — at 3am a
 * bar that silently flipped or slid off the axis is worse than one that refuses to.
 */
export function dragShift(sh: Shift, edge: DragEdge, deltaMs: number, span: Span): Shift {
  const from = Date.parse(sh.from)
  const to = Date.parse(sh.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(deltaMs)) return sh
  const snap = (t: number) => Math.round(t / SLOT_MS) * SLOT_MS

  if (edge === 'move') {
    const len = to - from
    let nf = snap(from + deltaMs)
    nf = Math.max(span.from, Math.min(nf, span.to - len))
    return { ...sh, from: new Date(nf).toISOString(), to: new Date(nf + len).toISOString() }
  }
  if (edge === 'from') {
    const nf = Math.max(span.from, Math.min(snap(from + deltaMs), to - SLOT_MS))
    return { ...sh, from: new Date(nf).toISOString() }
  }
  const nt = Math.min(span.to, Math.max(snap(to + deltaMs), from + SLOT_MS))
  return { ...sh, to: new Date(nt).toISOString() }
}
