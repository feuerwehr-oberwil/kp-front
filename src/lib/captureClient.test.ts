import { describe, expect, it } from 'vitest'
import {
  applyAction, attendanceForPickedName, autoOpenTarget, captureJournalRow, cycleAttendance,
  type CapturePerson,
} from './captureClient'
import type { AttendanceEntry } from '../types'
import type { Workspace } from './incidents'

const NOW = '2026-07-08T14:00:00.000Z'

describe('cycleAttendance', () => {
  it('defaults «von» to the alarm time, not the tap moment (retro capture)', () => {
    const p = cycleAttendance(undefined, 'Meier', '2026-07-08T21:36:00Z', '2026-07-08T20:15:00Z')
    expect(p?.checkedInAt).toBe('2026-07-08T20:15:00Z')
    // «bis» stays the tap moment — two taps on from here, since the first one only moves
    // them out of the Magazin
    const onScene = cycleAttendance(p, 'Meier', '2026-07-08T20:20:00Z', '2026-07-08T20:15:00Z')
    const left = cycleAttendance(onScene, 'Meier', '2026-07-08T21:40:00Z', '2026-07-08T20:15:00Z')
    expect(left?.leftAt).toBe('2026-07-08T21:40:00Z')
  })

  it('frei → Magazin → vor Ort → gegangen → frei, stamping on entry', () => {
    // the poster hangs in the Magazin, so that is the first state — see the four-state
    // describe block below for what each tap means
    const p1 = cycleAttendance(undefined, 'Meier', NOW)
    expect(p1).toMatchObject({ status: 'present', checkedInAt: NOW, ort: 'station', displayNameSnapshot: 'Meier' })
    const p2 = cycleAttendance(p1 as AttendanceEntry, 'Meier', '2026-07-08T14:55:00Z')
    expect(p2).toMatchObject({ status: 'present', checkedInAt: NOW, ort: 'scene' })
    const p3 = cycleAttendance(p2 as AttendanceEntry, 'Meier', '2026-07-08T15:00:00Z')
    expect(p3).toMatchObject({ status: 'left', checkedInAt: NOW, leftAt: '2026-07-08T15:00:00Z' })
    expect(cycleAttendance(p3 as AttendanceEntry, 'Meier', NOW)).toBeUndefined()
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

  // ⚠️ 04.09.: without a stamp, an entry from the Bogen is indistinguishable from one the
  // Kommandoposten wrote — and a divergence row then cannot name its two sides.
  it('⚠️ stamps every attendance entry it changed as «vom Erfassungsbogen»', () => {
    const ws = { attendance: {} }
    const next = applyAction(ws, { kind: 'cycleAttendance', personId: 'p1', name: 'Meier' }, NOW)
    expect((next.attendance as Record<string, AttendanceEntry>).p1.source).toBe('capture')
  })

  it('…and leaves an entry this action never touched alone — the stamp says who WROTE it', () => {
    const kp: AttendanceEntry = { status: 'present', displayNameSnapshot: 'Keller', source: 'kp' }
    const ws = { attendance: { p1: {}, p2: kp } as unknown as Record<string, AttendanceEntry> }
    const next = applyAction(ws, { kind: 'setAttendanceNote', personId: 'p1', note: 'Fahrer TLF' }, NOW)
    expect((next.attendance as Record<string, AttendanceEntry>).p2).toBe(kp)
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

// Picking somebody as Einsatzleiter / for the Rückmeldung also ticks them present — the same
// rule the Trupp form follows in the app. The pickers are free-text, so what a NAME resolves to
// is the whole question.
describe('attendanceForPickedName', () => {
  const ALARM = '2026-08-07T09:00:00.000Z'
  const roster: CapturePerson[] = [
    { id: 'p1', display_name: 'Meier Anna' },
    { id: 'p2', display_name: 'Studer Beat' },
  ]

  it('ticks a picked roster member present, «von» = Alarmzeit', () => {
    const [action, ...rest] = attendanceForPickedName('Meier Anna', roster, {}, { vonIso: ALARM })
    expect(action).toEqual({ kind: 'cycleAttendance', personId: 'p1', name: 'Meier Anna', vonIso: ALARM })
    expect(rest).toEqual([])
  })

  it('matches trimmed and case-insensitively — a Combo hands back whatever was typed', () => {
    expect(attendanceForPickedName('  meier anna ', roster, {})).toHaveLength(1)
  })

  it('does nothing for a name nobody on the roster carries', () => {
    // the guest case: Nachbarwehr, Polizei, Zivilist — no match is the CORRECT outcome
    expect(attendanceForPickedName('Wachtmeister Keller', roster, {})).toEqual([])
    expect(attendanceForPickedName('Meier', roster, {})).toEqual([]) // partial ≠ a person
    expect(attendanceForPickedName('', roster, {})).toEqual([])
  })

  it('does nothing when two members share the display name', () => {
    // which of the two was meant is not knowable here, and ticking the wrong one is worse
    const twins: CapturePerson[] = [{ id: 'p1', display_name: 'Meier Anna' }, { id: 'p9', display_name: 'Meier Anna' }]
    expect(attendanceForPickedName('Meier Anna', twins, {})).toEqual([])
  })

  it('never ticks somebody who is already present — that tap would close their block', () => {
    const att: Record<string, AttendanceEntry> = {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', intervals: [{ from: ALARM }] },
    }
    expect(attendanceForPickedName('Meier Anna', roster, att)).toEqual([])
  })

  it('leaves «gegangen» alone — a recorded departure was a decision', () => {
    const att: Record<string, AttendanceEntry> = {
      p1: {
        status: 'left', displayNameSnapshot: 'Meier Anna',
        intervals: [{ from: ALARM, to: '2026-08-07T10:00:00.000Z' }],
      },
    }
    expect(attendanceForPickedName('Meier Anna', roster, att, { note: 'Einsatzleiter' })).toEqual([])
  })

  it('writes the Einsatzleiter remark alongside the tick', () => {
    const actions = attendanceForPickedName('Studer Beat', roster, {}, { vonIso: ALARM, note: 'Einsatzleiter' })
    expect(actions.map((a) => a.kind)).toEqual(['cycleAttendance', 'setAttendanceNote'])
    expect(actions[1]).toEqual({ kind: 'setAttendanceNote', personId: 'p2', note: 'Einsatzleiter' })
  })

  it('remarks somebody who is already present without touching their presence', () => {
    const att: Record<string, AttendanceEntry> = {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', intervals: [{ from: ALARM }] },
    }
    expect(attendanceForPickedName('Meier Anna', roster, att, { note: 'Einsatzleiter' }))
      .toEqual([{ kind: 'setAttendanceNote', personId: 'p1', note: 'Einsatzleiter' }])
  })

  it('never overwrites a hand-written Bemerkung with a derived one', () => {
    const att: Record<string, AttendanceEntry> = {
      p1: { status: 'present', displayNameSnapshot: 'Meier Anna', note: 'Fahrer TLF', intervals: [{ from: ALARM }] },
    }
    expect(attendanceForPickedName('Meier Anna', roster, att, { note: 'Einsatzleiter' })).toEqual([])
  })

  it('ticks presence without a remark where none was asked for (Rückmeldung ELZ)', () => {
    const actions = attendanceForPickedName('Meier Anna', roster, {}, { vonIso: ALARM })
    expect(actions.map((a) => a.kind)).toEqual(['cycleAttendance'])
  })
})

describe('applyAction · Bemerkung', () => {
  const NOW = '2026-08-07T09:41:00.000Z'

  it('writes the remark and leaves the presence blocks untouched', () => {
    const ws = { attendance: { p1: { status: 'present', displayNameSnapshot: 'Meier Anna', intervals: [{ from: NOW }] } } } as unknown as Workspace
    const out = applyAction(ws, { kind: 'setAttendanceNote', personId: 'p1', note: 'Einsatzleiter' }, NOW)
    const att = out.attendance as Record<string, AttendanceEntry>
    expect(att.p1.note).toBe('Einsatzleiter')
    expect(att.p1.intervals).toEqual([{ from: NOW }])
  })

  it('never creates an entry — a Bemerkung only annotates one', () => {
    const out = applyAction({}, { kind: 'setAttendanceNote', personId: 'ghost', note: 'Einsatzleiter' }, NOW)
    expect(out.attendance).toBeUndefined()
  })
})

describe('captureJournalRow — the poster writes to the Verlauf too', () => {
  const NOW = '2026-08-07T09:41:00.000Z'

  it('names which way the attendance cycle went', () => {
    const a = { kind: 'cycleAttendance', personId: 'p1', name: 'Meier Anna' } as const
    expect(captureJournalRow(a, NOW, 0, { outcome: 'present' })?.text).toContain('anwesend')
    expect(captureJournalRow(a, NOW, 0, { outcome: 'left' })?.text).toContain('gegangen')
    expect(captureJournalRow(a, NOW, 0, { outcome: 'cleared' })?.text).toContain('entfernt')
    expect(captureJournalRow(a, NOW, 0, { outcome: 'present' })?.text).toContain('Meier Anna')
  })

  it('marks the row as coming from the QR surface', () => {
    // a row in a legal record has to say who wrote it; the poster has no signed-in person
    const row = captureJournalRow({ kind: 'addAttachment', id: 'a', url: '/api/media/x' }, NOW)
    expect(row?.text).toContain('QR')
  })

  it('says WHICH Rapportangaben changed, not just that some did', () => {
    const row = captureJournalRow({ kind: 'setMeta', patch: { einsatzleiter: 'X', endedAt: 'Y' } }, NOW)
    expect(row?.text).toContain('Einsatzleiter')
    expect(row?.text).toContain('Einsatzende')
  })

  it('stays silent for the Erfasser bookkeeping field', () => {
    // who tapped the poster is about the capture, not about the Einsatz
    expect(captureJournalRow({ kind: 'setMeta', patch: { erfasser: 'Meier' } }, NOW)).toBeNull()
  })

  it('carries the material and the amount', () => {
    const row = captureJournalRow(
      { kind: 'setMittel', label: 'Ölbindemittel', unit: 'Sack', menge: 3 }, NOW,
    )
    expect(row?.text).toContain('Ölbindemittel')
    expect(row?.text).toContain('3')
    // …and no author: the poster has none to name (see CaptureAction · setMittel)
    expect(row?.text).toContain('(QR)')
  })

  it('gives same-millisecond rows distinct ids', () => {
    // the server skips a duplicate id idempotently — two rows sharing one would lose the second
    const a = captureJournalRow({ kind: 'addAttachment', id: 'x', url: '/u' }, NOW, 0)
    const b = captureJournalRow({ kind: 'addAttachment', id: 'y', url: '/u' }, NOW, 1)
    expect(a?.id).not.toBe(b?.id)
  })

  it('logs a Bemerkung by name, in the same words the tablet uses', () => {
    const row = captureJournalRow(
      { kind: 'setAttendanceNote', personId: 'p1', note: 'Einsatzleiter' }, NOW, 0, { name: 'Meier Anna' },
    )
    expect(row?.text).toContain('Meier Anna')
    expect(row?.text).toContain('Einsatzleiter')
  })

  it('resolves a person id to a name where it has one', () => {
    const row = captureJournalRow({ kind: 'setTimes', personId: 'p1', from: NOW }, NOW, 0, { name: 'Meier Anna' })
    expect(row?.text).toContain('Meier Anna')
    expect(row?.text).not.toContain('p1')
  })
})

describe('cycleAttendance — four states on the poster', () => {
  const NOW2 = '2026-08-08T22:30:00Z'
  const VON = '2026-08-08T22:11:00Z'

  it('starts at the MAGAZIN — that is where the poster hangs', () => {
    const first = cycleAttendance(undefined, 'Meier Anna', NOW2, VON)!
    expect(first.status).toBe('present')
    expect(first.ort).toBe('station')
    expect(first.intervals?.[0].from).toBe(VON)
  })

  it('second tap moves them to the Einsatzort without touching the times', () => {
    const first = cycleAttendance(undefined, 'Meier Anna', NOW2, VON)!
    const second = cycleAttendance(first, 'Meier Anna', NOW2)!
    expect(second.ort).toBe('scene')
    expect(second.status).toBe('present')
    expect(second.intervals).toEqual(first.intervals)
  })

  it('third tap is «gegangen», fourth clears the entry', () => {
    let e = cycleAttendance(undefined, 'Meier Anna', NOW2, VON)
    e = cycleAttendance(e, 'Meier Anna', NOW2)
    const left = cycleAttendance(e, 'Meier Anna', NOW2)!
    expect(left.status).toBe('left')
    expect(left.leftAt).toBe(NOW2)
    expect(cycleAttendance(left, 'Meier Anna', NOW2)).toBeUndefined()
  })
})
