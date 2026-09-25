import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import type { IncidentMeta } from './api/incidents'
import { closedMetaFor, closedNoticeAt, isIncidentClosedRefusal, refusalClosedAt, type IncidentClosedSignal } from './incidentClosed'

// How a device decides that the Einsatz on its screen was closed ELSEWHERE (N3, 25.09.2026), and
// what it then shows. App acts on `closedMetaFor`'s answer and on nothing else.

const meta = (over: Partial<IncidentMeta> = {}): IncidentMeta => ({
  id: 'inc', divera_id: null, title: 'Brand', type: null, priority: null, address: null, lat: null, lng: null,
  status: 'offen', source: 'manual', source_ref: null, auto_opened: false, started_at: '2026-09-25T12:00:00Z',
  closed_at: null, is_archived: false, is_exercise: true, report_done_at: null, workspace_rev: 3,
  created_by: null, created_at: '2026-09-25T12:00:00Z', updated_at: '2026-09-25T12:00:00Z', ...over,
})
const sig = (source: IncidentClosedSignal['source'], over: Partial<IncidentClosedSignal> = {}): IncidentClosedSignal =>
  ({ incidentId: 'inc', source, closedAt: '2026-09-25T12:45:00Z', ...over })
const closedFresh = meta({ is_archived: true, closed_at: '2026-09-25T12:45:00Z', report_done_at: '2026-09-25T12:45:00Z' })

describe('closedMetaFor', () => {
  it('takes the server’s own meta when it can be read', () => {
    expect(closedMetaFor(meta(), sig('poll'), closedFresh, null)).toBe(closedFresh)
    expect(closedMetaFor(meta(), sig('list'), closedFresh, null)).toBe(closedFresh)
  })

  it('a signal the SERVER sent stands on its own when the read fails; the list’s absence does not', () => {
    expect(closedMetaFor(meta(), sig('refusal'), null, null)).toMatchObject({ id: 'inc', is_archived: true, closed_at: '2026-09-25T12:45:00Z' })
    expect(closedMetaFor(meta(), sig('poll'), null, null)?.is_archived).toBe(true)
    expect(closedMetaFor(meta(), sig('list'), null, null)).toBeNull()
  })

  it('does nothing when the server says it is running — reopened meanwhile, or a bounded list', () => {
    expect(closedMetaFor(meta(), sig('list'), meta(), null)).toBeNull()
    expect(closedMetaFor(meta(), sig('poll'), meta({ status: 'in_arbeit' }), null)).toBeNull()
  })

  it('never for another Einsatz, one already closed on screen, or the one this device is closing', () => {
    expect(closedMetaFor(meta(), sig('poll', { incidentId: 'other' }), closedFresh, null)).toBeNull()
    expect(closedMetaFor(meta({ is_archived: true }), sig('poll'), closedFresh, null)).toBeNull()
    expect(closedMetaFor(null, sig('poll'), closedFresh, null)).toBeNull()
    expect(closedMetaFor(meta(), sig('poll'), closedFresh, 'inc')).toBeNull()
  })
})

describe('the refusal', () => {
  it('is the 409 with the name — a plain 409 is the revision conflict', () => {
    const closed = new ApiError(409, 'Einsatz ist abgeschlossen – nicht mehr übernommen')
    closed.code = 'incident_closed'
    closed.data = { code: 'incident_closed', closed_at: '2026-09-25T12:45:00Z' }
    expect(isIncidentClosedRefusal(closed)).toBe(true)
    expect(refusalClosedAt(closed)).toBe('2026-09-25T12:45:00Z')
    expect(isIncidentClosedRefusal(new ApiError(409, 'Workspace wurde zwischenzeitlich geändert'))).toBe(false)
    const forbidden = new ApiError(403, 'x'); forbidden.code = 'incident_closed'
    expect(isIncidentClosedRefusal(forbidden)).toBe(false)
    expect(isIncidentClosedRefusal(new Error('x'))).toBe(false)
    expect(refusalClosedAt(new Error('x'))).toBeNull()
  })
})

describe('closedNoticeAt', () => {
  const saw = Date.parse('2026-09-25T12:30:00Z')
  const heard = Date.parse('2026-09-25T12:46:10Z')
  it('is the close itself when it happened while this device saw the Einsatz running', () => {
    expect(closedNoticeAt('2026-09-25T12:45:00Z', saw, heard)).toBe(Date.parse('2026-09-25T12:45:00Z'))
  })
  it('is the moment it was heard when `closed_at` is an OLDER close (kept across «Wieder öffnen»)', () => {
    expect(closedNoticeAt('2026-09-24T22:00:00Z', saw, heard)).toBe(heard)
    expect(closedNoticeAt(null, saw, heard)).toBe(heard)
  })
})
