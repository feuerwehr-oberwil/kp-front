import { describe, expect, it } from 'vitest'
import { freshAlarmCandidate, pickBootIncident, sameIncidentList } from './incidentAlerts'
import type { IncidentMeta } from './incidents'

const NOW = new Date('2026-07-08T12:00:00Z').getTime()

const inc = (over: Partial<IncidentMeta>): IncidentMeta => ({
  id: 'i1',
  divera_id: null,
  title: 'Einsatz',
  type: null,
  priority: null,
  address: null,
  lat: null,
  lng: null,
  status: 'offen',
  source: 'manual',
  source_ref: null,
  auto_opened: false,
  is_exercise: false,
  report_done_at: null,
  started_at: '2026-07-08T11:00:00Z',
  closed_at: null,
  is_archived: false,
  workspace_rev: 0,
  created_by: null,
  created_at: '2026-07-08T11:00:00Z',
  updated_at: '2026-07-08T11:00:00Z',
  ...over,
})

describe('pickBootIncident', () => {
  it('prefers the remembered incident when nothing newer arrived', () => {
    const saved = inc({ id: 'a', source: 'manual', started_at: '2026-07-08T10:00:00Z' })
    const olderAlarm = inc({ id: 'b', source: 'divera', started_at: '2026-07-08T09:00:00Z' })
    expect(pickBootIncident([saved, olderAlarm], 'a')?.id).toBe('a')
  })

  it('a NEWER alarm-created incident overrides the remembered one (killed-app reopen)', () => {
    const saved = inc({ id: 'a', started_at: '2026-07-08T09:00:00Z' })
    const alarm = inc({ id: 'b', source: 'divera', auto_opened: true, started_at: '2026-07-08T11:30:00Z' })
    expect(pickBootIncident([alarm, saved], 'a')?.id).toBe('b')
  })

  it('generic-intake sources count as alarm-created, manual does not', () => {
    const saved = inc({ id: 'a', started_at: '2026-07-08T09:00:00Z' })
    const webhook = inc({ id: 'b', source: 'leitstelle', started_at: '2026-07-08T11:30:00Z' })
    const manualNewer = inc({ id: 'c', source: 'manual', started_at: '2026-07-08T11:45:00Z' })
    expect(pickBootIncident([manualNewer, webhook, saved], 'a')?.id).toBe('b')
  })

  it('never picks archived incidents — all archived boots to the clean landing', () => {
    const arch = inc({ id: 'a', source: 'divera', is_archived: true })
    expect(pickBootIncident([arch], 'a')).toBeUndefined()
  })

  it('falls back to the first open incident without a remembered id', () => {
    const a = inc({ id: 'a', started_at: '2026-07-08T11:00:00Z' })
    const b = inc({ id: 'b', started_at: '2026-07-08T10:00:00Z' })
    expect(pickBootIncident([a, b], undefined)?.id).toBe('a')
  })
})

describe('freshAlarmCandidate', () => {
  const base = { activeId: null, baselineIds: new Set<string>(), dismissed: new Set<string>(), now: NOW }

  it('announces a fresh alarm-created arrival, newest first', () => {
    const older = inc({ id: 'a', source: 'divera', started_at: '2026-07-08T10:00:00Z' })
    const newer = inc({ id: 'b', source: 'leitstelle', started_at: '2026-07-08T11:30:00Z' })
    expect(freshAlarmCandidate([older, newer], base)?.id).toBe('b')
  })

  it('ignores manual incidents, the active one, baseline members, and dismissed ones', () => {
    const manual = inc({ id: 'm', source: 'manual' })
    const active = inc({ id: 'act', source: 'divera' })
    const known = inc({ id: 'k', source: 'divera' })
    const dismissed = inc({ id: 'd', source: 'divera' })
    const list = [manual, active, known, dismissed]
    expect(
      freshAlarmCandidate(list, { ...base, activeId: 'act', baselineIds: new Set(['k']), dismissed: new Set(['d']) }),
    ).toBeNull()
  })

  it('ignores stale alarms outside the 3 h window', () => {
    const stale = inc({ id: 's', source: 'divera', started_at: '2026-07-08T08:00:00Z' })
    expect(freshAlarmCandidate([stale], base)).toBeNull()
  })
})

describe('sameIncidentList', () => {
  it('detects unchanged lists and any id/updated_at drift', () => {
    const a = inc({ id: 'a' })
    expect(sameIncidentList([a], [inc({ id: 'a' })])).toBe(true)
    expect(sameIncidentList([a], [inc({ id: 'b' })])).toBe(false)
    expect(sameIncidentList([a], [inc({ id: 'a', updated_at: '2026-07-08T11:59:00Z' })])).toBe(false)
    expect(sameIncidentList(null, [a])).toBe(false)
    expect(sameIncidentList([], [])).toBe(true)
  })

  it('a QR capture write (counter only, pinned updated_at) still counts as a change', () => {
    const a = inc({ id: 'a' })
    expect(sameIncidentList([a], [inc({ id: 'a', capture_writes: 1 })])).toBe(false)
  })
})
