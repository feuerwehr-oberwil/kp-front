// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// After the boot opened the stored copy (lib/bootWait, finding 27): the server's state reaches it
// the way it does after any reconnect – no path of its own. A REAL engine opened `storedFirst`
// under its REAL live follow and push (useIncidentSync) over the REAL fetch wrapper, against one
// in-memory server with the backend's contract (409 on a stale base, the long poll), on fake timers.

type Trupp = { id: string; lastContactTime: string; notfallAt?: string }
type Ws = { trupps: Trupp[] } & Record<string, unknown>

const server = vi.hoisted(() => ({ ws: {} as Record<string, unknown>, rev: 1, parked: [] as (() => void)[], latency: 0 }))

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'X-Incident-Open': '1' } })

async function fakeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, 'http://kp.test')
  const method = init.method ?? 'GET'
  const path = url.pathname.replace(/^\/api\/incidents\/[^/]+/, '')
  if (server.latency) await new Promise((r) => setTimeout(r, server.latency))
  if (path === '/workspace' && method === 'GET') {
    if (!url.searchParams.has('since')) return json(200, { workspace: structuredClone(server.ws), workspace_rev: server.rev })
    const since = Number(url.searchParams.get('since'))
    if (since === server.rev && url.searchParams.get('wait') === '1') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 20_000)
        server.parked.push(() => { clearTimeout(timer); resolve() })
        init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')) })
      })
    }
    if (since === server.rev) return new Response(null, { status: 304, headers: { 'X-Incident-Open': '1' } })
    return json(200, { workspace: structuredClone(server.ws), workspace_rev: server.rev })
  }
  if ((path === '/workspace' || path === '/workspace/trupps') && method === 'PUT') {
    const body = JSON.parse(String(init.body))
    if (body.base_rev !== server.rev) return json(409, { detail: { message: 'geändert', server_rev: server.rev } })
    server.ws = path === '/workspace' ? structuredClone(body.workspace) : { ...server.ws, trupps: structuredClone(body.trupps) }
    server.rev += 1
    for (const wake of server.parked.splice(0)) wake()
    return json(200, { workspace: null, workspace_rev: server.rev })
  }
  return json(404, { detail: 'nicht hier' })
}

const { __resetIdbForTests, idbSet } = await import('./idb')
const { WorkspaceSync, setWorkspaceCacheOwner } = await import('./api/workspaceSync')
const { useIncidentSync } = await import('./useIncidentSync')

const T0 = '2026-11-27T05:00:00.000Z'
const AT_BASE: Ws = { trupps: [{ id: 'tr1', lastContactTime: T0 }, { id: 'tr3', lastContactTime: T0 }] }
const NOTFALL = '2026-11-27T05:10:00.000Z'
const KONTAKT = '2026-11-27T05:09:00.000Z'

/** the stored copy at rev 1; `dirty` with this device's offline Kontakt on tr1 */
async function storeCopy(dirty: boolean) {
  const workspace = dirty ? { trupps: AT_BASE.trupps.map((t) => (t.id === 'tr1' ? { ...t, lastContactTime: KONTAKT } : t)) } : AT_BASE
  await idbSet('kp-front-ws-inc', { workspace, base: AT_BASE, baseRev: 1, dirty, lastSyncedAt: 1, owner: 'u1' })
}

/** the boot's stored-first open, then the mounted view's follow and push */
async function openStored(readOnly = false) {
  const sync = new WorkspaceSync('inc', { debounceMs: 0, storedFirst: true })
  const { workspace } = await sync.init()
  const device = { sync, shown: workspace as Ws }
  const buildPayload = () => device.shown as never
  const applyWorkspace = (ws: unknown) => { device.shown = ws as Ws }
  const noop = () => {}
  renderHook(() => useIncidentSync({ sync, readOnly, incidentId: 'inc', buildPayload, applyWorkspace, echoOfPull: () => false, flushEvents: noop, flushEventsBeacon: noop, lockHeldAtOpen: true }))
  return device
}

const pass = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r))
    await vi.advanceTimersByTimeAsync(0)
  }
})
const notfallOn = (ws: Ws) => ws.trupps.find((t) => t.id === 'tr3')?.notfallAt

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  setWorkspaceCacheOwner('reset')
  setWorkspaceCacheOwner('u1')
  // a colleague raised a Notfall on tr3 while this device was away: the server is at rev 2
  Object.assign(server, { ws: { trupps: AT_BASE.trupps.map((t) => (t.id === 'tr3' ? { ...t, notfallAt: NOTFALL } : t)) }, rev: 2, parked: [], latency: 0 })
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('the stored copy on screen, the server reached later', () => {
  it.each([false, true])('a clean copy takes the server’s state on the first follow round (read-only %s)', async (readOnly) => {
    await storeCopy(false)
    const d = await openStored(readOnly)
    expect(notfallOn(d.shown)).toBeUndefined()
    await pass(5_000)
    expect(notfallOn(d.shown)).toBe(NOTFALL)
    if (!readOnly) expect(d.sync.rev).toBe(2)
    // the adopted state is not saved back
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PUT')).toEqual([])
  })

  // 5 s of boot wait + one spacing and one 6 s round trip of the follow ≈ 13 s (before: ≈ 12 s,
  // with nothing on screen until then)
  it('(b) slow link (6 s per request): the server’s state follows the stored copy within one follow round', async () => {
    server.latency = 6_000
    await storeCopy(false)
    // the boot waited BOOT_STORED_WAIT_MS for the list, then opened the copy
    const d = await openStored()
    const opened = Date.now()
    for (let t = 0; t < 30 && notfallOn(d.shown) === undefined; t++) await pass(500)
    expect(notfallOn(d.shown)).toBe(NOTFALL)
    expect(Date.now() - opened).toBeLessThanOrEqual(8_500)
  })

  it('a dirty copy is three-way merged by its push: the offline Kontakt and the colleague’s Notfall both stay', async () => {
    await storeCopy(true)
    const d = await openStored()
    await pass(10_000)
    const tr1 = (server.ws as Ws).trupps.find((t) => t.id === 'tr1')
    expect(tr1?.lastContactTime).toBe(KONTAKT)
    expect(notfallOn(server.ws as Ws)).toBe(NOTFALL)
    expect(notfallOn(d.shown)).toBe(NOTFALL)
    expect(d.shown.trupps.find((t) => t.id === 'tr1')?.lastContactTime).toBe(KONTAKT)
    expect(d.sync.hasUnsynced).toBe(false)
  })
})
