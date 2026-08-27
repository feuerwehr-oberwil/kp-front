import { describe, expect, it } from 'vitest'
import { runningOthers } from './switcherLists'
import type { IncidentMeta } from './incidents'

const inc = (over: Partial<IncidentMeta> & { id: string }): IncidentMeta => ({
  divera_id: null, title: `Einsatz ${over.id}`, type: null, priority: null, address: null,
  lat: null, lng: null, status: 'offen', source: 'manual', source_ref: null, auto_opened: false,
  started_at: '2026-08-20T10:00:00', closed_at: null, is_archived: false, is_exercise: false,
  report_done_at: null, workspace_rev: 1, created_by: null,
  created_at: '2026-08-20T10:00:00', updated_at: '2026-08-20T10:00:00', ...over,
})

describe('runningOthers', () => {
  it('sorts newest first and drops the active Einsatz', () => {
    const rows = runningOthers([
      inc({ id: 'a', started_at: '2026-08-25T08:00:00' }),
      inc({ id: 'b', started_at: '2026-08-25T12:00:00' }),
      inc({ id: 'me', started_at: '2026-08-25T14:00:00' }),
    ], 'me')
    expect(rows.map((i) => i.id)).toEqual(['b', 'a'])
  })

  it('leaves out everything that is no longer running', () => {
    const rows = runningOthers([
      inc({ id: 'run' }),
      inc({ id: 'done', status: 'abgeschlossen' }),
      inc({ id: 'arch', is_archived: true }),
    ], null)
    expect(rows.map((i) => i.id)).toEqual(['run'])
  })

  it('keeps «in Arbeit» — it is a running Einsatz somebody has taken on', () => {
    expect(runningOthers([inc({ id: 'x', status: 'in_arbeit' })], null)).toHaveLength(1)
  })

  it('lists a repeated id once, keeping the first (fresher) copy', () => {
    // the rows render key={i.id} — a duplicate id is a duplicate React key and loses a row
    const rows = runningOthers([
      inc({ id: 'x', title: 'frisch' }),
      inc({ id: 'x', title: 'aus einem zweiten Fetch' }),
    ], null)
    expect(rows.map((i) => i.title)).toEqual(['frisch'])
  })
})
