import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// TWO DEVICES, ONE EINSATZ, CLOSED ON ONE OF THEM (N3, staging walk-through 25.09.2026).
//
// Phone A closes the Einsatz. Phone B was offline at that moment with a Kontakt queued — the
// Tafel save, its «team» row and its `atemschutz.contact` event — plus an ordinary Meldung. The
// REAL engines of phone B (WorkspaceSync, JournalStore, AuditEventStore) run over the REAL fetch
// wrapper (lib/api — so the `{code, message}` refusal is parsed exactly as in the field) against
// ONE in-memory server that implements the backend's contract (api/incidents · incident_closed):
// once closed, a live write is 409 `incident_closed`, a record write still lands, and every
// workspace read carries `X-Incident-Open`.
//
// What must hold when phone B comes back: it HEARS the close (from the poll and from its own
// refusals), nothing live reaches the closed record, the Meldung does, every refused write is
// still on the device and in the export, and no outbox is left red or retrying.

type Row = { id: string; kind?: string; [k: string]: unknown }
const server = vi.hoisted(() => ({
  open: true,
  closedAt: null as string | null,
  rev: 1,
  ws: {} as Record<string, unknown>,
  rows: [] as Row[],
  events: [] as { client_id: string; op_type: string }[],
  online: true,
}))
const RECORD_KEYS = ['attendance', 'shifts', 'bands', 'mittel', 'checklists', 'reportMeta', 'attachments']
const RECORD_EVENTS = ['attendance.', 'checklist.', 'mittel.', 'report.', 'journal.', 'reminder.', 'weather.', 'shift.']
const LIVE_KINDS = ['team', 'symbol', 'layer', 'vehicle']

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const lifecycle = (): Record<string, string> =>
  server.open ? { 'X-Incident-Open': '1' } : { 'X-Incident-Open': '0', 'X-Incident-Closed-At': server.closedAt ?? '' }
const refused = () => json(409, { detail: { code: 'incident_closed', message: 'Einsatz ist abgeschlossen – nicht mehr übernommen', closed_at: server.closedAt } })

async function fakeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (!server.online) throw new TypeError('Failed to fetch')
  const url = new URL(input, 'http://kp.test')
  const method = init.method ?? 'GET'
  const body = init.body ? JSON.parse(String(init.body)) : undefined
  const path = url.pathname.replace(/^\/api\/incidents\/[^/]+/, '')
  if (path === '/workspace' && method === 'GET') {
    const since = url.searchParams.get('since')
    if (since !== null && Number(since) === server.rev) return new Response(null, { status: 304, headers: lifecycle() })
    return json(200, { workspace: structuredClone(server.ws), workspace_rev: server.rev }, lifecycle())
  }
  if (path === '/workspace' && method === 'PUT') {
    if (body.base_rev !== server.rev) return json(409, { detail: { message: 'Workspace wurde zwischenzeitlich geändert', server_rev: server.rev } })
    if (!server.open) {
      const keys = new Set([...Object.keys(server.ws), ...Object.keys(body.workspace)])
      const changed = [...keys].filter((k) => !RECORD_KEYS.includes(k) && JSON.stringify(server.ws[k]) !== JSON.stringify(body.workspace[k]))
      if (changed.length) return refused()
    }
    server.ws = structuredClone(body.workspace)
    server.rev += 1
    return json(200, { workspace: null, workspace_rev: server.rev })
  }
  if (path === '/journal' && method === 'POST') {
    const entries = body.entries as Row[]
    if (!server.open && entries.some((e) => LIVE_KINDS.includes(e.kind ?? ''))) return refused()
    const have = new Set(server.rows.map((r) => r.id))
    const accepted = entries.filter((e) => !have.has(e.id))
    server.rows.push(...accepted)
    return json(201, { entries: accepted.map((row) => ({ seq: server.rows.indexOf(row) + 1, row })), latest_seq: server.rows.length })
  }
  if (path === '/journal' && method === 'GET') {
    const since = Number(url.searchParams.get('since_seq') ?? 0)
    return json(200, { entries: server.rows.slice(since).map((row, i) => ({ seq: since + i + 1, row })), latest_seq: server.rows.length })
  }
  if (path === '/events' && method === 'POST') {
    const events = body.events as { client_id: string; op_type: string }[]
    if (!server.open && events.some((e) => !RECORD_EVENTS.some((p) => e.op_type.startsWith(p)))) return refused()
    server.events.push(...events)
    return json(201, [])
  }
  if (path === '' && method === 'PATCH') {
    if (body.is_archived === true && server.open) { server.open = false; server.closedAt = '2026-09-25T12:45:00+00:00' }
    return json(200, { id: 'inc', is_archived: !server.open, status: 'offen', closed_at: server.closedAt })
  }
  return json(404, { detail: 'Einsatz nicht gefunden' })
}

const { __resetIdbForTests } = await import('./idb')
const { WorkspaceSync } = await import('./api/workspaceSync')
const { pollWorkspaceSince } = await import('./api/workspace')
const { archiveIncident } = await import('./api/incidents')
const { JournalStore } = await import('./journalStore')
const { AuditEventStore } = await import('./auditEventStore')
const { onIncidentClosed } = await import('./incidentClosed')

const INC = 'inc'
const TRUPP = { id: 'tr2', name: 'Trupp 2', status: 'drin', lastContactTime: '2026-09-25T12:40:00Z' }

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  Object.assign(server, {
    open: true, closedAt: null, rev: 1, rows: [], events: [], online: true,
    ws: { trupps: [TRUPP], reportMeta: { kurzbericht: 'Brand gelöscht' }, entities: [] },
  })
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('a close on phone A reaches phone B, and B’s late Tafel writes are refused and kept', () => {
  it('B hears it, nothing live lands in the record, the Meldung does, everything refused is kept', async () => {
    const heard: { source: string; closedAt?: string | null }[] = []
    const off = onIncidentClosed((s) => { if (s.incidentId === INC) heard.push(s) })

    // phone B opens the running Einsatz
    const sync = new WorkspaceSync(INC, { debounceMs: 60_000 })
    const { workspace, rev } = await sync.init()
    expect(rev).toBe(1)
    const journal = new JournalStore(INC, false)
    await journal.init([])
    const audit = new AuditEventStore(INC, 'user-b:login', false)
    audit.start()
    let shown: Record<string, unknown> = workspace ?? {}
    sync.onApplyMerged = (ws) => { shown = ws }

    // …loses the network and taps «Kontakt» on Trupp 2, then writes a Meldung
    server.online = false
    const kontakt = { ...TRUPP, lastContactTime: '2026-09-25T12:46:00Z' }
    sync.save({ ...shown, trupps: [kontakt] })
    journal.append({ id: 'r-kontakt', t: '14:46', at: '2026-09-25T12:46:00Z', icon: 'radio', text: 'Trupp 2 – Kontakt bestätigt', kind: 'team' })
    journal.append({ id: 'r-meldung', t: '14:47', at: '2026-09-25T12:47:00Z', icon: 'type', text: 'Hauswart informiert', kind: 'journal' })
    audit.append({ client_id: 'ev-kontakt', op_type: 'atemschutz.contact', payload: { id: 'tr2' }, occurred_at: '2026-09-25T12:46:00Z' })
    await sync.flush()
    await journal.flush()
    await audit.flush()
    expect(sync.hasUnsynced).toBe(true)
    expect(journal.pendingCount).toBe(2)

    // phone A closes the Einsatz (App · completeRapport's archive, over the same wrapper)
    server.online = true
    await archiveIncident(INC)
    expect(server.open).toBe(false)

    // phone B is back: its live poll answers with the lifecycle — the 304 included
    expect(await pollWorkspaceSince(INC, sync.rev)).toBeNull()
    expect(heard.some((s) => s.source === 'poll')).toBe(true)

    // …and its outboxes deliver what they queued
    await sync.flush()
    for (let i = 0; i < 4; i++) await journal.flush()
    await audit.flush()
    await new Promise((r) => setTimeout(r, 0))

    // nothing live reached the closed record; the Meldung did
    expect((server.ws.trupps as typeof TRUPP[])[0].lastContactTime).toBe('2026-09-25T12:40:00Z')
    expect(server.rev).toBe(1)
    expect(server.rows.map((r) => r.id)).toEqual(['r-meldung'])
    expect(server.events).toEqual([])
    expect(heard.filter((s) => s.source === 'refusal').length).toBeGreaterThanOrEqual(3)
    expect(heard.find((s) => s.source === 'refusal')?.closedAt).toBe('2026-09-25T12:45:00+00:00')

    // every refused write is still on the device, in the export, and not owed
    expect(sync.refusedCount).toBe(1)
    expect(sync.refusedRecoveryData()[0].workspace.trupps).toEqual([kontakt])
    expect(journal.refusedCount).toBe(1)
    expect(journal.recoveryData().refused.map((r) => r.id)).toEqual(['r-kontakt'])
    expect(audit.refusedCount).toBe(1)
    expect(audit.getRecoveryData().refused?.map((e) => e.client_id)).toEqual(['ev-kontakt'])
    expect(sync.syncStatus).toBe('synced')
    expect(journal.syncStatus).toBe('synced')
    expect(audit.status).toBe('synced')
    expect(sync.hasUnsynced).toBe(false)

    // the screen shows the RECORD again, not the Kontakt that never reached it
    expect((shown.trupps as typeof TRUPP[])[0].lastContactTime).toBe('2026-09-25T12:40:00Z')

    // …and a reload of phone B still holds the refused Tafel save
    sync.dispose()
    const reopened = new WorkspaceSync(INC)
    await reopened.init()
    await reopened.loadRefused()
    expect(reopened.refusedCount).toBe(1)
    expect(reopened.hasUnsynced).toBe(false)
    reopened.dispose()

    audit.stop()
    journal.dispose()
    off()
  })
})

describe('the refused slot is never overwritten blind', () => {
  // CodeRabbit on #235: a failed read of the refused slot was taken for an empty one, and the next
  // park wrote over what an earlier session had parked there. A failed IndexedDB read is not a miss.
  it('a park after a failed read goes to its own slot, and the earlier saves stay', async () => {
    const idb = await import('./idb')
    const KEY = `kp-front-ws-${INC}::__refused__`
    const earlier = [{ workspace: { trupps: [TRUPP] }, baseRev: 1, refusedAt: 1 }]
    await idb.idbSet(KEY, earlier)
    const realRead = idb.idbRead
    const read = vi.spyOn(idb, 'idbRead').mockImplementation(((key: string) =>
      key === KEY ? Promise.resolve({ ok: false, error: new Error('io') }) : realRead(key)) as typeof idb.idbRead)
    try {
      server.open = false
      server.closedAt = '2026-09-25T12:45:00+00:00'
      const write = vi.spyOn(idb, 'idbSet')
      const sync = new WorkspaceSync(INC, { debounceMs: 60_000 })
      await sync.init()
      sync.save({ ...server.ws, trupps: [{ ...TRUPP, lastContactTime: '2026-09-25T12:50:00Z' }] })
      await sync.flush()
      expect(sync.hasUnsynced).toBe(false)
      read.mockRestore()
      expect(await idb.idbGet(KEY)).toEqual(earlier) // untouched
      const parkedTo = write.mock.calls.map((c) => c[0]).filter((k) => k.startsWith(KEY))
      expect(parkedTo).toHaveLength(1)
      expect(parkedTo[0]).toMatch(new RegExp(`^${KEY}:\\d+$`))
      expect(sync.refusedCount).toBe(1)
      write.mockRestore()
      sync.dispose()
    } finally { read.mockRestore() }
  })
})
