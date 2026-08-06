import { describe, expect, it } from 'vitest'
import { applyAction, autoOpenTarget, cycleAttendance } from './captureClient'
import type { AttendanceEntry } from '../types'
import type { Workspace } from './incidents'

const NOW = '2026-07-08T14:00:00.000Z'

describe('cycleAttendance', () => {
  it('defaults «von» to the alarm time, not the tap moment (retro capture)', () => {
    const p = cycleAttendance(undefined, 'Meier', '2026-07-08T21:36:00Z', '2026-07-08T20:15:00Z')
    expect(p?.checkedInAt).toBe('2026-07-08T20:15:00Z')
    // «bis» stays the tap moment
    const left = cycleAttendance(p, 'Meier', '2026-07-08T21:40:00Z', '2026-07-08T20:15:00Z')
    expect(left?.leftAt).toBe('2026-07-08T21:40:00Z')
  })

  it('frei → anwesend → gegangen → frei, stamping on entry', () => {
    const p1 = cycleAttendance(undefined, 'Meier', NOW)
    expect(p1).toMatchObject({ status: 'present', checkedInAt: NOW, displayNameSnapshot: 'Meier' })
    const p2 = cycleAttendance(p1 as AttendanceEntry, 'Meier', '2026-07-08T15:00:00Z')
    expect(p2).toMatchObject({ status: 'left', checkedInAt: NOW, leftAt: '2026-07-08T15:00:00Z' })
    expect(cycleAttendance(p2 as AttendanceEntry, 'Meier', NOW)).toBeUndefined()
  })
})

describe('applyAction', () => {
  it('touches only capture domains — foreign workspace keys pass through untouched', () => {
    const ws = { entities: [{ id: 'e1' }], drawings: [{ id: 'd1' }], attendance: {} }
    const next = applyAction(ws, { kind: 'cycleAttendance', personId: 'p1', name: 'Meier' }, NOW)
    expect(next.entities).toEqual([{ id: 'e1' }])
    expect(next.drawings).toEqual([{ id: 'd1' }])
    expect((next.attendance as Record<string, AttendanceEntry>).p1.status).toBe('present')
  })

  it('setMeta patches reportMeta fields, preserving the rest', () => {
    const ws = { reportMeta: { summary: 'BMA' } }
    const next = applyAction(ws, { kind: 'setMeta', patch: { endedAt: NOW, kontaktperson: 'Frau Muster' } }, NOW)
    expect(next.reportMeta).toEqual({ summary: 'BMA', endedAt: NOW, kontaktperson: 'Frau Muster' })
  })

  it('setTimes refines an existing entry and never creates one', () => {
    const ws = { attendance: { p1: { status: 'left', checkedInAt: NOW, leftAt: NOW, displayNameSnapshot: 'Meier' } } }
    const next = applyAction(ws, { kind: 'setTimes', personId: 'p1', to: '2026-07-08T15:30:00Z' }, NOW)
    const att = next.attendance as Record<string, AttendanceEntry>
    expect(att.p1.leftAt).toBe('2026-07-08T15:30:00Z')
    expect(att.p1.checkedInAt).toBe(NOW)
    const noop = applyAction({}, { kind: 'setTimes', personId: 'ghost', to: NOW }, NOW)
    expect(noop.attendance).toBeUndefined()
  })

  // a legacy entry (no `intervals`) must be correctable in place — the projection is written
  // back as a block, so the poster keeps working on data from before blocks existed
  it('setTimes upgrades a legacy pair into a block without moving the times', () => {
    const ws = { attendance: { p1: { status: 'left', checkedInAt: NOW, leftAt: NOW, displayNameSnapshot: 'Meier' } } }
    const next = applyAction(ws, { kind: 'setTimes', personId: 'p1', to: '2026-07-08T15:30:00Z' }, NOW)
    const att = next.attendance as Record<string, AttendanceEntry>
    expect(att.p1.intervals).toEqual([{ from: NOW, to: '2026-07-08T15:30:00Z' }])
  })

  it('setMittel appends a running total, no-ops on unchanged, keeps history', () => {
    let ws = applyAction(null, { kind: 'setMittel', label: 'Ölbinder', unit: 'Sack', menge: 2, by: 'Meier' }, NOW)
    expect((ws.mittel as unknown[]).length).toBe(1)
    // unchanged total → no new event
    const same = applyAction(ws, { kind: 'setMittel', label: 'Ölbinder', unit: 'Sack', menge: 2, by: 'Meier' }, '2026-07-08T14:05:00Z')
    expect((same.mittel as unknown[]).length).toBe(1)
    ws = applyAction(ws, { kind: 'setMittel', label: 'Ölbinder', unit: 'Sack', menge: 3, by: 'Huber' }, '2026-07-08T14:10:00Z')
    expect((ws.mittel as unknown[]).length).toBe(2)
  })

  it('setMittel with a source edits the SOURCED line, never the unsourced one (± stepper)', () => {
    // a KP-tablet line with a source and a capture line without one coexist per material
    let ws = applyAction(null, { kind: 'setMittel', materialId: 'luefter', label: 'Lüfter', unit: 'Stk', sourceId: 'tlf', sourceLabel: 'TLF', menge: 2, by: 'KP' }, NOW)
    ws = applyAction(ws, { kind: 'setMittel', materialId: 'luefter', label: 'Lüfter', unit: 'Stk', menge: 1, by: 'Meier' }, '2026-07-08T14:05:00Z')
    // stepping the sourced line down must key off material+unit+source
    ws = applyAction(ws, { kind: 'setMittel', materialId: 'luefter', label: 'Lüfter', unit: 'Stk', sourceId: 'tlf', sourceLabel: 'TLF', menge: 1, by: 'Meier' }, '2026-07-08T14:10:00Z')
    const entries = ws.mittel as { sourceId?: string; menge: number; at: string }[]
    expect(entries.length).toBe(3)
    const sourced = entries.filter((e) => e.sourceId === 'tlf').sort((a, b) => a.at.localeCompare(b.at))
    const latestSourced = sourced[sourced.length - 1]
    const unsourced = entries.find((e) => !e.sourceId)
    expect(latestSourced?.menge).toBe(1)
    expect(unsourced?.menge).toBe(1)
  })

  it('restoreAttendance puts a removed entry back verbatim, incl. its times', () => {
    const entry: AttendanceEntry = { status: 'left', checkedInAt: NOW, leftAt: '2026-07-08T15:00:00Z', displayNameSnapshot: 'Meier' }
    const ws = { attendance: { p1: entry }, entities: [{ id: 'e1' }] }
    // third tap removes the entry (the destructive step the undo toast reverses)
    const removed = applyAction(ws, { kind: 'cycleAttendance', personId: 'p1', name: 'Meier' }, NOW)
    expect((removed.attendance as Record<string, AttendanceEntry>).p1).toBeUndefined()
    const restored = applyAction(removed, { kind: 'restoreAttendance', personId: 'p1', entry }, '2026-07-08T16:00:00Z')
    expect((restored.attendance as Record<string, AttendanceEntry>).p1).toEqual(entry)
    expect(restored.entities).toEqual([{ id: 'e1' }])
  })
})

describe('autoOpenTarget', () => {
  const now = Date.parse('2026-07-11T08:00:00Z')
  const inc = (id: string, startedAgoH: number) =>
    ({ id, started_at: new Date(now - startedAgoH * 3_600_000).toISOString() }) as unknown as import('./incidents').IncidentMeta

  it('a single listed incident opens directly, whatever its age', () => {
    expect(autoOpenTarget([inc('a', 72)], now)?.id).toBe('a')
  })
  it('one fresh incident above stale backlog rows still auto-opens', () => {
    expect(autoOpenTarget([inc('fresh', 1), inc('old1', 40), inc('old2', 90)], now)?.id).toBe('fresh')
  })
  it('two fresh incidents → ambiguous, show the picker', () => {
    expect(autoOpenTarget([inc('a', 1), inc('b', 2), inc('old', 40)], now)).toBeNull()
  })
  it('only stale backlog (nothing fresh, several rows) → show the picker', () => {
    expect(autoOpenTarget([inc('old1', 40), inc('old2', 90)], now)).toBeNull()
  })
  it('empty list → nothing to open', () => {
    expect(autoOpenTarget([], now)).toBeNull()
  })
})

// Rapport-Beilagen from the poster: the photo bytes go through the capture media route, this
// only records the row. The reducer has to be idempotent — `saveAction` re-applies the action
// after a 409, and a Beilage added twice would print twice.
describe('applyAction · Beilagen', () => {
  const NOW = '2026-08-06T20:00:00.000Z'

  it('records a Beilage without touching the rest of the blob', () => {
    const ws = { attendance: { p1: {} }, entities: [{ id: 'e1' }] } as unknown as Workspace
    const out = applyAction(ws, { kind: 'addAttachment', id: 'a1', url: '/api/media/1', caption: 'Ausweis' }, NOW)
    expect(out.attachments).toEqual([{ id: 'a1', url: '/api/media/1', caption: 'Ausweis', at: NOW }])
    expect((out as Record<string, unknown>).entities).toEqual([{ id: 'e1' }]) // tactical keys pass through
    expect((out as Record<string, unknown>).attendance).toEqual({ p1: {} })
  })

  it('is idempotent — a retried save (409 → re-read → re-apply) adds it once', () => {
    const first = applyAction(null, { kind: 'addAttachment', id: 'a1', url: '/api/media/1' }, NOW)
    const again = applyAction(first, { kind: 'addAttachment', id: 'a1', url: '/api/media/1' }, NOW)
    expect(again.attachments).toHaveLength(1)
  })

  it('re-adding with a caption edits the row rather than duplicating it', () => {
    const first = applyAction(null, { kind: 'addAttachment', id: 'a1', url: '/api/media/1' }, NOW)
    const named = applyAction(first, { kind: 'addAttachment', id: 'a1', url: '/api/media/1', caption: 'Ausweis Lenker' }, NOW)
    expect(named.attachments).toEqual([{ id: 'a1', url: '/api/media/1', caption: 'Ausweis Lenker', at: NOW }])
  })

  it('removes one by id and leaves the others', () => {
    let ws = applyAction(null, { kind: 'addAttachment', id: 'a1', url: '/api/media/1' }, NOW)
    ws = applyAction(ws, { kind: 'addAttachment', id: 'a2', url: '/api/media/2' }, NOW)
    const out = applyAction(ws, { kind: 'removeAttachment', id: 'a1' }, NOW)
    expect((out.attachments as { id: string }[]).map((a) => a.id)).toEqual(['a2'])
  })
})
