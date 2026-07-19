// Attendance-divergence surfacing: the merge stays LWW, but a same-person both-sides
// change is reported (mergeWorkspace onAttendanceConflict) and turned into ONE Verlauf
// row per person, deduped by signature across sync cycles (attendanceConflictRows).

import { describe, expect, it } from 'vitest'
import { mergeWorkspace, type RecordConflict } from './mergeWorkspace'
import { attendanceConflictRows, conflictSignature } from './attendanceConflict'
import type { AttendanceEntry } from '../types'

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

  it('falls back to the person id when no snapshot name is present', () => {
    const anon: RecordConflict = { key: 'p9', mine: { status: 'left' }, theirs: { status: 'present' } }
    const rows = attendanceConflictRows([anon], new Set())
    expect(rows[0].text).toContain('p9')
  })
})
