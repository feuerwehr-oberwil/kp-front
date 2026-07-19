// Audio player (Durchhören) helpers. The recording
// is a window on the incident timeline (audioMeta.startedAt + duration), and markers are
// FULLY DERIVED: any Verlauf row whose `at` falls inside the window is a marker at
// offset = at − startedAt. No back-references, no extra data structure.

import type { TimelineEvent } from '../types'

export interface AudioWindow {
  startMs: number      // epoch ms of the recording start
  durationSec: number  // 0 = unknown until the <audio> element reports metadata
}

/** The recording's window on the incident timeline. audioMeta is authoritative; rows from
 *  before the metadata existed fall back to the row's own time (short clips start there). */
export function audioWindowOf(row: TimelineEvent): AudioWindow | null {
  const meta = row.audioMeta
  if (meta?.startedAt) {
    const t = Date.parse(meta.startedAt)
    if (!Number.isNaN(t)) return { startMs: t, durationSec: meta.durationSec ?? 0 }
  }
  if (row.at) {
    const t = Date.parse(row.at)
    if (!Number.isNaN(t)) return { startMs: t, durationSec: 0 }
  }
  return null
}

export type MarkerTone = 'entry' | 'reminder' | 'system'

/** Visual grouping of a marker: operator content (blue), reminders (amber), rest (grey). */
export function markerTone(kind?: TimelineEvent['kind']): MarkerTone {
  if (kind === 'reminder') return 'reminder'
  if (kind === 'journal' || kind === 'audio' || kind === 'photo' || kind === 'note') return 'entry'
  return 'system'
}

export interface AudioMarker {
  row: TimelineEvent
  offsetSec: number
  tone: MarkerTone
}

/** All Verlauf rows inside the window, as markers sorted by offset. The audio row itself
 *  and enrichment patch rows are excluded — they are carriers, not events. */
export function markersInWindow(events: TimelineEvent[], win: AudioWindow, ownId: string): AudioMarker[] {
  if (win.durationSec <= 0) return []
  const endMs = win.startMs + win.durationSec * 1000
  const out: AudioMarker[] = []
  for (const e of events) {
    if (e.id === ownId || e.patchOf || !e.at) continue
    const t = Date.parse(e.at)
    if (Number.isNaN(t) || t < win.startMs || t > endMs) continue
    out.push({ row: e, offsetSec: (t - win.startMs) / 1000, tone: markerTone(e.kind) })
  }
  return out.sort((a, b) => a.offsetSec - b.offsetSec)
}

/** Index of the marker the playback position has most recently passed, or -1. */
export function currentMarkerIndex(markers: AudioMarker[], posSec: number): number {
  let idx = -1
  for (let i = 0; i < markers.length; i++) { if (markers[i].offsetSec <= posSec) idx = i; else break }
  return idx
}

/** Elapsed time for the small readout: 47 → "0:47", 754 → "12:34", 8103 → "2:15:03". */
export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`
}

/** Wall-clock HH:MM at an offset into the recording (the operator thinks in Einsatzzeit). */
export function wallClockAt(win: AudioWindow, offsetSec: number): string {
  const d = new Date(win.startMs + offsetSec * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export interface ClockTick { p: number; label: string }

/** Wall-clock gridlines across the seek bar: ticks on round times (5 min … 2 h steps),
 *  choosing the step so a recording gets ~3–7 ticks regardless of length. */
export function clockTicks(win: AudioWindow): ClockTick[] {
  const dur = win.durationSec
  if (dur <= 0) return []
  const steps = [300, 600, 900, 1800, 3600, 7200]
  const step = steps.find((s) => dur / s <= 7) ?? steps[steps.length - 1]
  const ticks: ClockTick[] = []
  // first round wall-clock instant strictly inside the window
  const first = Math.ceil((win.startMs / 1000 + 1) / step) * step
  for (let t = first; t < win.startMs / 1000 + dur; t += step) {
    const offset = t - win.startMs / 1000
    if (offset / dur > 0.98) break // don't collide with the end label
    ticks.push({ p: offset / dur, label: wallClockAt(win, offset) })
  }
  return ticks
}
