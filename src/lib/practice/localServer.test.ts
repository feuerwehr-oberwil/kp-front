import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { __resetIdbForTests, idbKeys } from '../idb'
import { answerPractice, ensurePracticeIncident, type PracticeContext } from './localServer'
import { practiceTarget } from './practiceMode'
import { siteScene } from '../ueben/site'
import type { IncidentFull } from '../api/incidents'

const ID = '11111111-2222-4333-8444-555555555555'
const OLD = '99999999-2222-4333-8444-555555555555'
const ctx: PracticeContext = { id: ID, retired: [OLD], userId: 'u1' }
const url = (path: string) => `http://localhost${path}`

const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  answerPractice(new Request(url(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), ctx)

const seed: IncidentFull = {
  id: ID, divera_id: null, title: 'Übungsplatz', type: null, priority: null, address: null, lat: 47.5, lng: 7.6,
  status: 'offen', source: 'practice', source_ref: null, auto_opened: false, started_at: '2026-11-19T10:00:00Z',
  closed_at: null, last_closed_at: null, is_archived: false, is_exercise: true, exercise_since_creation: true,
  report_done_at: null, editor_opened_at: null, capture_writes: 0, capture_last_at: null, workspace_rev: 0,
  created_by: null, created_at: '2026-11-19T10:00:00Z', updated_at: '2026-11-19T10:00:00Z', atemschutz_due: [],
  alarm_update: null, text: null, details_json: null, map_workspace_json: null,
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  await ensurePracticeIncident(seed, siteScene([7.6, 47.5]))
})

describe('practice local server', () => {
  it('routes only paths that name a practice id, media included', () => {
    expect(practiceTarget(`/api/incidents/${ID}/journal`, ctx)).toBe(ID)
    expect(practiceTarget(`/api/media/practice-${ID}-abc`, ctx)).toBe(ID)
    expect(practiceTarget(`/api/incidents/${OLD}/workspace`, ctx)).toBe(OLD)
    expect(practiceTarget('/api/incidents', ctx)).toBeNull()
    expect(practiceTarget('/api/incidents/other-id/workspace', ctx)).toBeNull()
  })

  it('starts a fresh practice Einsatz on the practice site, as rev 1', async () => {
    const first = await (await call('GET', `/api/incidents/${ID}/workspace`)).json()
    expect(first.workspace_rev).toBe(1)
    expect(first.workspace.entities.map((e: { id: string }) => e.id)).toEqual(['ueben-h1', 'ueben-w', 'ueben-eingang'])
    // …and only once: a second open keeps what was done there
    await call('PUT', `/api/incidents/${ID}/workspace`, { workspace: { entities: [] }, base_rev: 1 })
    await ensurePracticeIncident(seed, siteScene([7.6, 47.5]))
    expect((await (await call('GET', `/api/incidents/${ID}/workspace`)).json()).workspace).toEqual({ entities: [] })
  })

  it('accepts every save, bumps the rev, and answers its own saves with a bodyless 304', async () => {
    const a = await (await call('PUT', `/api/incidents/${ID}/workspace?slim=1`, { workspace: { entities: [1] }, base_rev: 0 }, { 'X-Workspace-Writer': 'me' })).json()
    // a stale base_rev is no race on one device: accepted
    const b = await (await call('PUT', `/api/incidents/${ID}/workspace/trupps`, { trupps: [{ id: 't1' }], base_rev: 0 }, { 'X-Workspace-Writer': 'me' })).json()
    expect([a.workspace_rev, b.workspace_rev]).toEqual([2, 3])
    const own = await call('GET', `/api/incidents/${ID}/workspace?since=1&writer=me`)
    expect(own.status).toBe(304)
    expect(own.headers.get('X-Workspace-Rev')).toBe('3')
    expect(own.headers.get('X-Incident-Open')).toBe('1')
    const other = await call('GET', `/api/incidents/${ID}/workspace?since=1&writer=someone-else`)
    expect(await other.json()).toEqual({ workspace: { entities: [1], trupps: [{ id: 't1' }] }, workspace_rev: 3 })
    expect((await call('GET', `/api/incidents/${ID}/workspace?since=3`)).status).toBe(304)
  })

  it('appends the Verlauf idempotently by row id, with ascending seqs', async () => {
    const first = await (await call('POST', `/api/incidents/${ID}/journal`, { entries: [{ id: 'r1', text: 'a' }, { id: 'r2', text: 'b' }] })).json()
    expect(first.entries.map((e: { seq: number }) => e.seq)).toEqual([1, 2])
    // a retry after a lost answer, with one new row
    const retry = await (await call('POST', `/api/incidents/${ID}/journal`, { entries: [{ id: 'r2', text: 'b' }, { id: 'r3', text: 'c', via: 'x' }] })).json()
    expect(retry).toEqual({ entries: [{ seq: 3, row: { id: 'r3', text: 'c' } }], latest_seq: 3 })
    const since = await (await call('GET', `/api/incidents/${ID}/journal?since_seq=1`)).json()
    expect(since.entries.map((e: { row: { id: string } }) => e.row.id)).toEqual(['r2', 'r3'])
  })

  it('closes on the Abschluss PATCH and says so on the follow', async () => {
    const meta = await (await call('PATCH', `/api/incidents/${ID}`, { is_archived: true, report_done_at: '2026-11-19T11:00:00Z' })).json()
    expect(meta).toMatchObject({ is_archived: true, status: 'abgeschlossen', report_done_at: '2026-11-19T11:00:00Z' })
    expect(meta.closed_at).toBeTruthy()
    const follow = await call('GET', `/api/incidents/${ID}/workspace?since=0`)
    expect(follow.headers.get('X-Incident-Open')).toBe('0')
  })

  it('chains the audit events and refuses what needs the real server', async () => {
    await call('POST', `/api/incidents/${ID}/events`, { events: [{ op_type: 'entity.add' }, { op_type: 'entity.move' }] })
    const events = await (await call('GET', `/api/incidents/${ID}/events`)).json()
    expect(events.map((e: { seq: number; prev_hash: string | null; user_id: string }) => [e.seq, e.prev_hash, e.user_id]))
      .toEqual([[1, null, 'u1'], [2, 'practice-1', 'u1']])
    expect((await call('POST', `/api/incidents/${ID}/report/pdf`, {})).status).toBe(501)
  })

  it('refuses a retired id without storing anything of it', async () => {
    const res = await call('PUT', `/api/incidents/${OLD}/workspace`, { workspace: { x: 1 }, base_rev: 0 })
    expect(res.status).toBe(410)
    const keys = await idbKeys(`kp-practice-${OLD}`)
    expect(keys).toEqual({ ok: true, value: [] })
  })
})
