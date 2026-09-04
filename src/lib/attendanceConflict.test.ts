// Attendance-divergence surfacing: the merge stays LWW, but a same-person both-sides
// change is reported (mergeWorkspace onAttendanceConflict) and turned into ONE Verlauf
// row per person, deduped by signature across sync cycles (attendanceConflictRows).

import { describe, expect, it } from 'vitest'
import { mergeWorkspace, type RecordConflict } from './mergeWorkspace'
import { attendanceConflictRows, conflictResolvedRow, conflictSignature, conflictWhat, openConflicts, sideLabel } from './attendanceConflict'
import type { AttendanceEntry, TimelineEvent } from '../types'

const entry = (status: AttendanceEntry['status'], name = 'Meier Anna', extra: Partial<AttendanceEntry> = {}): AttendanceEntry =>
  ({ status, displayNameSnapshot: name, ...extra })

const ws = (attendance: Record<string, AttendanceEntry>) => ({ attendance })

const collect = (base: object, mine: object, theirs: object): RecordConflict[] => {
  const out: RecordConflict[] = []
  mergeWorkspace(base as Record<string, unknown>, mine as Record<string, unknown>, theirs as Record<string, unknown>, (c) => out.push(c))
  return out
}

describe('mergeWorkspace — attendance conflict reporting', () => {
  it('reports a divergent same-person edit on both sides (LWW result unchanged)', () => {
    const base = ws({ p1: entry('present') })
    const mine = ws({ p1: entry('left', 'Meier Anna', { leftAt: '2026-07-18T20:00:00Z' }) })
    const theirs = ws({ p1: entry('present', 'Meier Anna', { checkedInAt: '2026-07-18T18:30:00Z' }) })
    const conflicts: RecordConflict[] = []
    const merged = mergeWorkspace(base, mine, theirs, (c) => conflicts.push(c)) as { attendance: Record<string, AttendanceEntry> }
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].key).toBe('p1')
    // last-writer-wins is kept — reporting never changes the merge result
    expect(merged.attendance.p1.status).toBe('left')
  })

  it('does NOT flag when only one side changed', () => {
    const base = ws({ p1: entry('present') })
    // only theirs moved p1; mine left it at the ancestor
    expect(collect(base, ws({ p1: entry('present') }), ws({ p1: entry('left') }))).toEqual([])
    // only mine moved p1; theirs untouched
    expect(collect(base, ws({ p1: entry('left') }), ws({ p1: entry('present') }))).toEqual([])
  })

  it('does NOT flag when both sides made the SAME change', () => {
    const base = ws({ p1: entry('present') })
    expect(collect(base, ws({ p1: entry('left') }), ws({ p1: entry('left') }))).toEqual([])
  })

  it('flags a both-sides ADD of divergent entries (person absent in base)', () => {
    const conflicts = collect({}, ws({ p1: entry('present') }), ws({ p1: entry('left') }))
    expect(conflicts.map((c) => c.key)).toEqual(['p1'])
  })

  it('does not flag other persons edited independently (different keys merge cleanly)', () => {
    const base = ws({ p1: entry('present'), p2: entry('present', 'Muster Beat') })
    const mine = ws({ p1: entry('left'), p2: entry('present', 'Muster Beat') })
    const theirs = ws({ p1: entry('present'), p2: entry('left', 'Muster Beat') })
    expect(collect(base, mine, theirs)).toEqual([])
  })

  it('a merge without a listener behaves exactly as before', () => {
    const base = ws({ p1: entry('present') })
    const merged = mergeWorkspace(base, ws({ p1: entry('left') }), ws({ p1: entry('present', 'Meier Anna', { checkedInAt: 'x' }) })) as {
      attendance: Record<string, AttendanceEntry>
    }
    expect(merged.attendance.p1.status).toBe('left')
  })
})

describe('attendanceConflictRows — journal rows with signature dedupe', () => {
  const conflict: RecordConflict = {
    key: 'p1',
    mine: entry('left'),
    theirs: entry('present', 'Meier Anna', { checkedInAt: '2026-07-18T18:30:00Z' }),
  }

  it('produces one row per affected person, named from the entry snapshot', () => {
    const seen = new Set<string>()
    const rows = attendanceConflictRows([conflict], seen, new Date('2026-07-18T20:15:00'))
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toContain('Meier Anna')
    expect(rows[0].icon).toBe('warn')
    expect(rows[0].t).toBe('20:15')
    expect(rows[0].id.startsWith('ac')).toBe(true)
  })

  it('never appends the same divergence twice (repeat sync cycles / merge retries)', () => {
    const seen = new Set<string>()
    expect(attendanceConflictRows([conflict], seen)).toHaveLength(1)
    expect(attendanceConflictRows([conflict], seen)).toHaveLength(0)
    expect(attendanceConflictRows([conflict, conflict], seen)).toHaveLength(0)
  })

  it('a NEW divergence for the same person still appends (different values → new signature)', () => {
    const seen = new Set<string>()
    attendanceConflictRows([conflict], seen)
    const later: RecordConflict = { ...conflict, mine: entry('present', 'Meier Anna', { checkedInAt: 'later' }) }
    expect(conflictSignature(later)).not.toBe(conflictSignature(conflict))
    expect(attendanceConflictRows([later], seen)).toHaveLength(1)
  })

  // ⚠️ 03.09.: «Anwesenheit Probst Tristan: unterschiedliche Zeiten erfasst – bitte prüfen» twice,
  // eight seconds apart. Two tablets merged the same episode, and each of them saw it with the
  // halves swapped — «mine» is a point of view, not part of what happened.
  it('⚠️ gives one divergence ONE identity, whichever device is looking at it', () => {
    const mirrored: RecordConflict = { ...conflict, mine: conflict.theirs, theirs: conflict.mine }
    expect(conflictSignature(mirrored)).toBe(conflictSignature(conflict))
    // …and the row minted from it carries the same id, so the server keeps exactly one
    const a = attendanceConflictRows([conflict], new Set())
    const b = attendanceConflictRows([mirrored], new Set())
    expect(b[0].id).toBe(a[0].id)
  })

  it('⚠️ the row id comes from the divergence, not from the clock that happened to report it', () => {
    const early = attendanceConflictRows([conflict], new Set(), new Date('2026-09-03T08:15:02Z'))
    const late = attendanceConflictRows([conflict], new Set(), new Date('2026-09-03T08:15:10Z'))
    expect(late[0].id).toBe(early[0].id)
    // the timestamps still differ — the row says when THIS device noticed
    expect(late[0].at).not.toBe(early[0].at)
  })

  it('falls back to the person id when no snapshot name is present', () => {
    const anon: RecordConflict = { key: 'p9', mine: { status: 'left' }, theirs: { status: 'present' } }
    const rows = attendanceConflictRows([anon], new Set())
    expect(rows[0].text).toContain('p9')
  })
})


// The row's job is to hand the reader something to CHECK. «Abweichende Angaben wurden
// zusammengeführt» named nothing; the everyday case — a Funktion picked up at the QR sheet and
// another one at the KP — is a sentence.
describe('conflictWhat — what the row actually says', () => {
  const c = (mine: Partial<AttendanceEntry>, theirs: Partial<AttendanceEntry>): RecordConflict => ({
    key: 'p1',
    mine: entry('present', 'Martina Marco', mine),
    theirs: entry('present', 'Martina Marco', theirs),
  })

  // ⚠️ BOTH, side by side. Which one the merge kept is not the question — «welche stimmt» is,
  // and that cannot be answered from one of them.
  it('names both Funktionen, and calls neither of them discarded', () => {
    expect(conflictWhat(c({ note: 'Fahrer PIO' }, { note: 'AS' })))
      .toBe('zwei Funktionen erfasst – «Fahrer PIO» und «AS»')
  })

  it('does not claim two when only one side carried a Funktion', () => {
    expect(conflictWhat(c({ note: 'Fahrer PIO' }, {}))).toBe('Funktion «Fahrer PIO» nur auf einem Gerät erfasst')
    expect(conflictWhat(c({}, { note: 'AS' }))).toBe('Funktion «AS» nur auf einem Gerät erfasst')
  })

  it('names every field that diverged', () => {
    expect(conflictWhat({
      key: 'p1',
      mine: entry('present', 'Martina Marco', { ort: 'station' }),
      theirs: entry('left', 'Martina Marco', { leftAt: '2026-07-18T20:00:00Z' }),
    })).toBe('Anwesenheit abweichend erfasst · Standort abweichend erfasst · unterschiedliche Zeiten erfasst')
  })

  // an entry written before `ort` existed reads as 'scene' everywhere else — it must not report a
  // divergence against every entry written since
  it('treats a missing Ort as «am Einsatzort»', () => {
    expect(conflictWhat(c({ ort: 'scene', note: 'x' }, { note: 'x' }))).toBe('abweichende Angaben zusammengeführt')
  })
})

// ⚠️ 1.6, 03.09.: the Rapport was closed at 11:41 with three «bitte prüfen» lines standing, and
// nothing in the record could say whether anybody had looked. A divergence is now settled by an
// APPENDED row — the warning stays where it is.
describe('openConflicts + conflictResolvedRow — the divergence gets an answer', () => {
  const raised = (sig: string, over: Partial<TimelineEvent> = {}): TimelineEvent => ({
    id: `ac${sig}`, t: '08:15', at: '2026-09-03T06:15:02Z', icon: 'warn',
    text: 'Anwesenheit Probst Tristan: unterschiedliche Zeiten erfasst – bitte prüfen.',
    conflict: {
      op: 'raised', sig, key: 'p1',
      sides: [
        { source: 'kp', entry: entry('present', 'Probst Tristan', { checkedInAt: '2026-09-03T04:12:00Z' }) },
        { source: 'capture', entry: entry('left', 'Probst Tristan', { checkedInAt: '2026-09-03T04:12:00Z', leftAt: '2026-09-03T06:15:00Z' }) },
      ],
    },
    ...over,
  })

  it('an open divergence is one that has no resolved row yet', () => {
    expect(openConflicts([raised('a')])).toHaveLength(1)
    const resolved = conflictResolvedRow(openConflicts([raised('a')])[0], 0, 'Hauptmann Paul')
    // newest-first, the way the Verlauf is held
    expect(openConflicts([resolved, raised('a')])).toHaveLength(0)
  })

  it('⚠️ never returns a row raised before the payload existed — nobody could ever close it', () => {
    const legacy: TimelineEvent = { id: 'acold', t: '08:15', at: '2026-09-03T06:15:02Z', icon: 'warn', text: 'Anwesenheit …' }
    expect(openConflicts([legacy])).toHaveLength(0)
  })

  it('names the side it took, and who took it', () => {
    const open = openConflicts([raised('a')])[0]
    expect(conflictResolvedRow(open, 0, 'Hauptmann Paul').text)
      .toBe('Abweichung Probst Tristan geprüft – Angabe vom Kommandoposten, Hauptmann Paul')
    expect(conflictResolvedRow(open, 1, 'Hauptmann Paul').text)
      .toContain('Angabe vom Erfassungsbogen')
    expect(conflictResolvedRow(open, 'both', 'Hauptmann Paul').text)
      .toContain('beide Angaben stimmen so')
  })

  it('⚠️ falls back to the VALUE where the entry carries no source — every row before 04.09.', () => {
    const old = raised('b')
    old.conflict!.sides = old.conflict!.sides!.map((sd) => ({ entry: sd.entry }))
    const open = openConflicts([old])[0]
    // the times themselves are the label, which is the actual decision being made anyway
    expect(sideLabel(open.sides[0])).toMatch(/\d\d:\d\d/)
  })

  it('the resolved row is idempotent across devices, like the raised one', () => {
    const open = openConflicts([raised('a')])[0]
    expect(conflictResolvedRow(open, 0, 'A').id).toBe(conflictResolvedRow(open, 'both', 'B').id)
  })
})
