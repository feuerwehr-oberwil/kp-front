import { describe, expect, it } from 'vitest'
import { switcherLists } from './switcherLists'
import type { IncidentMeta } from './incidents'

const inc = (over: Partial<IncidentMeta> & { id: string }): IncidentMeta => ({
  divera_id: null, title: `Einsatz ${over.id}`, type: null, priority: null, address: null,
  lat: null, lng: null, status: 'offen', source: 'manual', source_ref: null, auto_opened: false,
  started_at: '2026-08-20T10:00:00', closed_at: null, is_archived: false, is_exercise: false,
  report_done_at: null, workspace_rev: 1, created_by: null,
  created_at: '2026-08-20T10:00:00', updated_at: '2026-08-20T10:00:00', ...over,
})

describe('switcherLists', () => {
  it('sorts running Einsätze newest first and drops the active one', () => {
    const lists = switcherLists([
      inc({ id: 'a', started_at: '2026-08-25T08:00:00' }),
      inc({ id: 'b', started_at: '2026-08-25T12:00:00' }),
      inc({ id: 'me', started_at: '2026-08-25T14:00:00' }),
    ], [], 'me')
    expect(lists.running.map((i) => i.id)).toEqual(['b', 'a'])
    expect(lists.past).toEqual([])
  })

  it('puts archived and no-longer-running Einsätze into «Frühere», newest first', () => {
    const lists = switcherLists(
      [inc({ id: 'run' }), inc({ id: 'done', status: 'abgeschlossen', started_at: '2026-08-24T09:00:00' })],
      [inc({ id: 'old', is_archived: true, started_at: '2026-08-19T09:00:00' })],
      null,
    )
    expect(lists.running.map((i) => i.id)).toEqual(['run'])
    expect(lists.past.map((i) => i.id)).toEqual(['done', 'old'])
  })

  it('caps «Frühere» at four rows but still counts every Einsatz', () => {
    const archived = ['1', '2', '3', '4', '5', '6'].map((n) =>
      inc({ id: n, is_archived: true, started_at: `2026-08-0${n}T09:00:00` }))
    const lists = switcherLists([inc({ id: 'me' })], archived, 'me')
    expect(lists.past.map((i) => i.id)).toEqual(['6', '5', '4', '3'])
    expect(lists.total).toBe(7)
  })

  it('deduplicates an Einsatz that appears in both lists, keeping the open (fresher) copy', () => {
    const lists = switcherLists(
      [inc({ id: 'x', title: 'frisch' })],
      [inc({ id: 'x', title: 'aus dem Archiv', is_archived: true })],
      null,
    )
    expect(lists.total).toBe(1)
    expect(lists.running.map((i) => i.title)).toEqual(['frisch'])
    expect(lists.past).toEqual([])
  })
})
