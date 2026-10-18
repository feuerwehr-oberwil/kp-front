// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// TWO DEVICES, ONE LOGIN, ONE EINSATZ — the live follow after a save (18.10.2026).
//
// Every save woke every follower, the SAVING device's own long poll too, which then downloaded
// the whole blob it had just sent and threw it away. The fix: the saves carry the engine's
// writer id, the follow asks with it, and the server answers a range of revisions that is only
// that engine's saves with a bodyless 304 + X-Workspace-Rev (backend live_wait · only_own_writes,
// pinned by backend/tests/test_long_poll.py).
//
// The same loop is the critical path: it carries every OTHER device's change — the Funkkontakt,
// the Atemschutznotfall — so this file holds the other half. Two REAL engines (WorkspaceSync)
// under their REAL live follow (useIncidentSync's loop, lib/pollBackoff) over the REAL fetch
// wrapper (lib/api), against ONE in-memory server that implements the backend's contract: the
// conditional save (409 on a stale base), the long poll (parks until a save, 20 s), and the
// writer rule. On fake timers, so «promptly» is a number of milliseconds, not a hope.

type Trupp = { id: string; name: string; lastContactTime: string; notfallAt?: string }
type Ws = { trupps: Trupp[] } & Record<string, unknown>

const server = vi.hoisted(() => ({
  ws: {} as Record<string, unknown>,
  rev: 1,
  /** who saved each revision — the backend's live_wait record (null: no writer id) */
  writers: new Map<number, string | null>(),
  /** the parked long polls, woken by the next save */
  parked: [] as (() => void)[],
  /** blob downloads on the live follow, by the asking writer */
  downloads: new Map<string, number>(),
  /** writers whose requests do not get through (that device is offline) */
  offline: new Set<string>(),
  /** held before a save commits — the save «in flight» on the wire */
  holdSave: null as null | Promise<void>,
  /** the save commits, and the answer is lost on the way back */
  loseAnswer: new Set<string>(),
}))

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'X-Incident-Open': '1', ...headers } })

function wake() {
  const parked = server.parked.splice(0)
  for (const resolve of parked) resolve()
}

async function fakeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input, 'http://kp.test')
  const method = init.method ?? 'GET'
  const headers = (init.headers ?? {}) as Record<string, string>
  const writer = method === 'GET' ? url.searchParams.get('writer') : (headers['X-Workspace-Writer'] ?? null)
  if (writer && server.offline.has(writer)) throw new TypeError('Failed to fetch')
  const path = url.pathname.replace(/^\/api\/incidents\/[^/]+/, '')
  const body = init.body ? JSON.parse(String(init.body)) : undefined

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
    const revs = Array.from({ length: Math.max(0, server.rev - since) }, (_, i) => since + 1 + i)
    if (writer && revs.length && revs.every((r) => server.writers.get(r) === writer)) {
      return new Response(null, { status: 304, headers: { 'X-Incident-Open': '1', 'X-Workspace-Rev': String(server.rev) } })
    }
    const who = writer ?? 'unnamed'
    server.downloads.set(who, (server.downloads.get(who) ?? 0) + 1)
    return json(200, { workspace: structuredClone(server.ws), workspace_rev: server.rev })
  }
  if ((path === '/workspace' || path === '/workspace/trupps') && method === 'PUT') {
    if (server.holdSave) await server.holdSave
    if (body.base_rev !== server.rev) return json(409, { detail: { message: 'Workspace wurde zwischenzeitlich geändert', server_rev: server.rev } })
    server.ws = path === '/workspace' ? structuredClone(body.workspace) : { ...server.ws, trupps: structuredClone(body.trupps) }
    server.rev += 1
    server.writers.set(server.rev, writer)
    wake()
    if (writer && server.loseAnswer.delete(writer)) throw new TypeError('Failed to fetch')
    return json(200, { workspace: null, workspace_rev: server.rev })
  }
  return json(404, { detail: 'nicht hier' })
}

const { __resetIdbForTests } = await import('./idb')
const { WorkspaceSync } = await import('./api/workspaceSync')
const { useIncidentSync } = await import('./useIncidentSync')
const { appConfig } = await import('../config/appConfig')
const { LONG_POLL_SPACING_MS } = await import('./pollBackoff')

const T0 = '2026-10-18T10:00:00.000Z'
const TRUPPS: Trupp[] = [
  { id: 'tr1', name: 'Trupp 1', lastContactTime: T0 },
  { id: 'tr2', name: 'Trupp 2', lastContactTime: T0 },
  { id: 'tr3', name: 'Trupp 3', lastContactTime: T0 },
]

/** One device: its engine, its live follow, and what its screen shows. */
async function openDevice() {
  const sync = new WorkspaceSync('inc', { debounceMs: 0 })
  const { workspace } = await sync.init()
  const device = { sync, shown: (workspace ?? {}) as Ws, writer: sync.writerId }
  // stable identities: the saves are driven by `tap`, never by the hook's persistence effect
  const buildPayload = () => device.shown as never
  const applyWorkspace = (ws: unknown) => { device.shown = ws as Ws }
  const noop = () => {}
  renderHook(() => useIncidentSync({ sync, readOnly: false, incidentId: 'inc', buildPayload, applyWorkspace, flushEvents: noop, flushEventsBeacon: noop }))
  return device
}
type Device = Awaited<ReturnType<typeof openDevice>>

const trupp = (d: Device, id: string) => d.shown.trupps.find((t) => t.id === id)!
const serverTrupp = (id: string) => (server.ws.trupps as Trupp[]).find((t) => t.id === id)!

/** a Funkkontakt (or a Notfall) tapped on `d`, saved through its engine as the app does */
function tap(d: Device, id: string, change: Partial<Trupp>) {
  const next = { ...d.shown, trupps: d.shown.trupps.map((t) => (t.id === id ? { ...t, ...change } : t)) }
  d.shown = next
  d.sync.save(next)
  return d.sync.flush()
}

/** let `ms` of the app's time pass — timers, the requests they start, and the answers (a Response
 *  body is read on real macrotasks, so each step also yields a few of those) */
const pass = (ms: number) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r))
    await vi.advanceTimersByTimeAsync(0)
  }
})
const downloads = (d: Device) => server.downloads.get(d.writer) ?? 0

let a: Device
let b: Device

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  Object.assign(server, { ws: { trupps: structuredClone(TRUPPS) }, rev: 1, writers: new Map(), parked: [], downloads: new Map(), offline: new Set(), holdSave: null, loseAnswer: new Set() })
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  // timers and the clock only: fake-indexeddb runs on setImmediate, which must stay real
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  a = await openDevice()
  b = await openDevice()
  await pass(appConfig.sync.livePollMs) // both follows armed and parked
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('the live follow after a save', () => {
  it('a device downloads none of its own saves, and the other device gets each one at once', async () => {
    for (const [i, id] of ['tr1', 'tr2', 'tr3'].entries()) {
      const at = `2026-10-18T10:0${i + 1}:00.000Z`
      await act(() => tap(a, id, { lastContactTime: at }))
      await pass(0) // the commit's wake, answered — nothing else
      expect(trupp(b, id).lastContactTime, `B did not get A's Kontakt ${i + 1} on the wake`).toBe(at)
      await pass(LONG_POLL_SPACING_MS) // both follows park again
    }
    expect(downloads(a), 'A downloaded its own saves').toBe(0)
    expect(downloads(b)).toBe(3)
    expect([...server.downloads.values()].reduce((n, x) => n + x, 0), 'blobs on the follow, all devices').toBe(3)
    expect(a.sync.rev).toBe(4)
  })

  it('another device\'s save that lands between this device\'s save and its re-arm arrives on the re-arm', async () => {
    await act(() => tap(a, 'tr1', { lastContactTime: '2026-10-18T10:01:00.000Z' }))
    await pass(0) // A's poll was told «only your own save» and waits the spacing before it re-arms
    // …and in exactly that gap the Atemschutz-Link raises a Notfall
    const notfall = '2026-10-18T10:01:01.000Z'
    await act(() => tap(b, 'tr3', { notfallAt: notfall }))
    expect(trupp(a, 'tr3').notfallAt).toBeUndefined()
    await pass(LONG_POLL_SPACING_MS) // A re-arms at its own revision: the server is past it → the blob
    expect(trupp(a, 'tr3').notfallAt, 'A missed the Notfall raised while it re-armed').toBe(notfall)
    expect(downloads(a)).toBe(1)
  })

  it('B saves while A\'s Kontakt is in flight: both land (one through the 409 merge), both devices show both', async () => {
    let release!: () => void
    server.holdSave = new Promise((r) => { release = r })
    const kontakt = '2026-10-18T10:02:00.000Z'
    const aSave = tap(a, 'tr1', { lastContactTime: kontakt }) // on the wire, not committed
    server.holdSave = null
    const notfall = '2026-10-18T10:02:00.500Z'
    await act(() => tap(b, 'tr3', { notfallAt: notfall })) // commits first
    await pass(0)
    release()
    await act(() => aSave) // A: 409 → merge (fetches B's Notfall) → saves the union
    await pass(0)
    expect(serverTrupp('tr1').lastContactTime).toBe(kontakt)
    expect(serverTrupp('tr3').notfallAt).toBe(notfall)
    expect(trupp(a, 'tr3').notfallAt, 'A lost B\'s Notfall made while its own save was in flight').toBe(notfall)
    expect(a.sync.syncStatus).toBe('synced')
    // B was told «only your own save» on its Notfall's wake and re-arms after the spacing, as after
    // any answer: A's merge, committed in that gap, is the blob on the re-arm
    await pass(LONG_POLL_SPACING_MS)
    expect(trupp(b, 'tr1').lastContactTime, 'B lost A\'s Kontakt merged after its own save').toBe(kontakt)
    expect(downloads(b), 'B\'s follow took A\'s merge for its own').toBe(1)
  })

  it('offline and back: what the other device saved meanwhile reaches the returning one, and its own edit the other', async () => {
    server.offline.add(a.writer)
    await pass(0)
    await act(() => tap(a, 'tr2', { lastContactTime: '2026-10-18T10:03:00.000Z' })) // queued: offline
    expect(a.sync.syncStatus).toBe('offline')
    const notfall = '2026-10-18T10:03:30.000Z'
    await act(() => tap(b, 'tr3', { notfallAt: notfall }))
    await pass(10_000)

    server.offline.delete(a.writer)
    await act(async () => { window.dispatchEvent(new Event('online')) }) // the hook flushes, the loop catches up
    await pass(LONG_POLL_SPACING_MS)
    await pass(LONG_POLL_SPACING_MS)
    expect(trupp(a, 'tr3').notfallAt, 'A came back without B\'s Notfall').toBe(notfall)
    expect(trupp(b, 'tr2').lastContactTime, 'B never got A\'s offline Kontakt').toBe('2026-10-18T10:03:00.000Z')
    expect(serverTrupp('tr3').notfallAt).toBe(notfall)
    expect(a.sync.syncStatus).toBe('synced')
  })

  it('a save whose answer is lost: the server vouches it is A\'s, A re-merges onto it, nothing is lost or fetched twice', async () => {
    server.loseAnswer.add(a.writer)
    const kontakt = '2026-10-18T10:04:00.000Z'
    await act(() => tap(a, 'tr1', { lastContactTime: kontakt })) // committed, but A heard a network error
    await pass(0)
    expect(trupp(b, 'tr1').lastContactTime).toBe(kontakt)
    // A's retry (the next answer from the server re-flushes it, else the backoff) is at its old
    // base: a 409, a merge onto its own save, and the union saved
    await act(() => a.sync.flush())
    await pass(LONG_POLL_SPACING_MS)
    expect(a.sync.syncStatus).toBe('synced')
    expect(serverTrupp('tr1').lastContactTime).toBe(kontakt)
    // …and a foreign save after all that still reaches A at once
    const notfall = '2026-10-18T10:04:30.000Z'
    await act(() => tap(b, 'tr2', { notfallAt: notfall }))
    await pass(0)
    expect(trupp(a, 'tr2').notfallAt).toBe(notfall)
  })
})
