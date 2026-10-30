import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A save from an OLDER build than the one that wrote the stored blob (sweep 30.10.2026 #19): the
// server answers 409 `workspace_older_build` (backend workspace_kinds · refuse_older_build). The
// REAL WorkspaceSync over the REAL fetch wrapper against an in-memory server with that rule: the
// refused save is parked (never merged, never re-sent) and the server's blob goes to the view —
// whose load gate then turns an older build read-only (useWorkspaceBlob · olderBuild).

const server = vi.hoisted(() => ({ rev: 1, ws: {} as Record<string, unknown>, puts: [] as { path: string; body: Record<string, unknown> }[] }))
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const version = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback)

async function fakeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, 'http://kp.test')
  const method = init.method ?? 'GET'
  const body = init.body ? JSON.parse(String(init.body)) : undefined
  const path = url.pathname.replace(/^\/api\/incidents\/[^/]+/, '')
  if (path === '/workspace' && method === 'GET') return json(200, { workspace: structuredClone(server.ws), workspace_rev: server.rev })
  if (method === 'PUT') {
    server.puts.push({ path, body })
    if (body.base_rev !== server.rev) return json(409, { detail: { message: 'Workspace wurde zwischenzeitlich geändert', server_rev: server.rev } })
    const sent = path === '/workspace/trupps' ? version(body.schemaVersion, 3) : version(body.workspace?.schemaVersion, path === '/workspace' ? 1 : 3)
    const have = version(server.ws.schemaVersion, 1)
    if (sent < have) return json(409, { detail: { code: 'workspace_older_build', message: 'neuer', stored_version: have, your_version: sent } })
    server.ws = path === '/workspace/trupps' ? { ...server.ws, trupps: body.trupps } : structuredClone(body.workspace)
    server.rev += 1
    return json(200, { workspace: null, workspace_rev: server.rev })
  }
  return json(404, { detail: 'nicht gefunden' })
}

const { __resetIdbForTests } = await import('./idb')
const { WorkspaceSync } = await import('./api/workspaceSync')

const INC = 'inc'
const TRUPP = { id: 'tr1', name: 'Trupp 1', status: 'drin' }

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  Object.assign(server, { rev: 1, puts: [], ws: { schemaVersion: 4, trupps: [TRUPP], future: { kept: true } } })
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('a save refused as «older build»', () => {
  it('is parked once, never merged or re-sent, and the view gets the server’s blob', async () => {
    const sync = new WorkspaceSync(INC, { debounceMs: 60_000 })
    await sync.init()
    let shown: Record<string, unknown> | null = null
    sync.onApplyMerged = (ws) => { shown = ws }
    // what a v3 build saves: its gate never kept `future`
    sync.save({ schemaVersion: 3, trupps: [{ ...TRUPP, lastContactTime: '2026-10-30T12:10:00Z' }] })
    await sync.flush()
    expect(server.puts).toHaveLength(1)
    expect(server.ws).toEqual({ schemaVersion: 4, trupps: [TRUPP], future: { kept: true } })
    expect(sync.hasUnsynced).toBe(false)
    expect(sync.roleParkedCount).toBe(1) // «Einträge sichern» carries it
    expect(shown).toEqual(server.ws) // …and the newer blob is what the view now reads
    // no retry loop: nothing is owed
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(server.puts).toHaveLength(1)
  })

  it('a slice carries its blob’s version, so a current build’s Trupp save goes through', async () => {
    server.ws = { schemaVersion: 3, trupps: [TRUPP] }
    const sync = new WorkspaceSync(INC, { debounceMs: 60_000, slice: 'trupps' })
    await sync.init()
    sync.save({ schemaVersion: 3, trupps: [{ ...TRUPP, lastContactTime: '2026-10-30T12:10:00Z' }] })
    await sync.flush()
    expect(server.puts[server.puts.length - 1]).toMatchObject({ path: '/workspace/trupps', body: { schemaVersion: 3 } })
    expect(sync.hasUnsynced).toBe(false)
    expect(server.rev).toBe(2)
  })
})
