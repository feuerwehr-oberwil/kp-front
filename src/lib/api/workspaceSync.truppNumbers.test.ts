import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The field scenario of 24.09.2026, below the browser: three REAL `WorkspaceSync` engines on one
// login, all online, each registering a Trupp and dropping a loose marker in the same instant —
// so each mints «Trupp 1» twice from its own view of the counter. One in-memory server with the
// backend's contract (a PUT at a stale base_rev is a 409, an accepted one bumps the rev by one).
//
// What must hold: the server ends with three Trupps and three markers under six different
// numbers; every device converges on that state; and the Verlauf rows the devices would write
// (`onTruppRenumbered` → lib/truppNumbers · renumberRow) are one per renumbering, whichever and
// however many devices noticed it.

type Tr = { id: string; no?: number; name: string; members: string[]; readings: { t: string; bar: number; kind: string }[] }
type Ws = { trupps?: Tr[]; objects?: { id: string; entity?: { label?: string } }[] }

const server = vi.hoisted(() => ({
  ws: {} as Record<string, unknown>,
  rev: 0,
  conflicts: 0,
  latency: (() => 0) as () => number,
}))

vi.mock('./workspace', async () => {
  const { ApiError } = await import('../api')
  const wait = () => new Promise((resolve) => setTimeout(resolve, server.latency()))
  return {
    getWorkspace: async () => {
      await wait()
      return { workspace: structuredClone(server.ws), workspace_rev: server.rev }
    },
    putWorkspace: async (_id: string, ws: Record<string, unknown>, baseRev: number) => {
      await wait()
      if (baseRev !== server.rev) { server.conflicts++; throw new ApiError(409, 'Workspace wurde zwischenzeitlich geändert') }
      server.rev += 1
      server.ws = structuredClone(ws)
      const rev = server.rev
      await wait()
      return { workspace: null, workspace_rev: rev }
    },
    putWorkspaceBeacon: () => {},
    putWorkspaceTrupps: () => { throw new Error('not in this test') },
    putWorkspaceTruppsBeacon: () => {},
    putWorkspaceRecord: () => { throw new Error('not in this test') },
    putWorkspaceRecordBeacon: () => {},
  }
})
vi.mock('../idb', () => ({
  idbGet: vi.fn(async () => null),
  idbRead: vi.fn(async () => ({ ok: true, value: null })),
  idbSet: vi.fn(async () => true),
  idbDel: vi.fn(async () => undefined),
}))
vi.mock('../tileEvict', () => ({ withTileEviction: (fn: () => Promise<boolean>) => fn() }))

const { getWorkspace } = await import('./workspace')
const { WorkspaceSync } = await import('./workspaceSync')
const { renumberRow } = await import('../truppNumbers')

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(server, { ws: {}, rev: 0, conflicts: 0 })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('WorkspaceSync · three online devices mint «Trupp 1» at once', () => {
  it.each([
    ['no latency', () => 0],
    ['uneven latency', (() => { let n = 0; return () => [40, 5, 90, 20, 60][n++ % 5] })()],
  ])('the server ends with distinct numbers, every device converges, one row per renumbering (%s)', async (_label, latency) => {
    server.latency = latency
    const devices = [0, 1, 2].map((d) => {
      const sync = new WorkspaceSync(`incident-dev${d}`, { debounceMs: 50 })
      const dev = { d, sync, local: {} as Ws, rows: [] as string[] }
      sync.onApplyMerged = (ws) => { dev.local = ws as Ws }
      sync.onTruppRenumbered = (changes) => { for (const c of changes) dev.rows.push(renumberRow(c, '2026-09-25T10:00:05Z').id) }
      return dev
    })
    const opened = Promise.all(devices.map((dev) => dev.sync.init()))
    await vi.advanceTimersByTimeAsync(200)
    await opened

    // the same instant on all three: a registered Trupp and a loose marker, both «1»
    for (const dev of devices) {
      const at = new Date(Date.UTC(2026, 8, 25, 10, 0, 0, 10 + dev.d)).toISOString()
      const id = `trupp175879440001${dev.d}-0${dev.d}ab`
      dev.local = {
        trupps: [{ id: `tr${dev.d}`, no: 1, name: `GF ${dev.d}`, members: [], readings: [{ t: at, bar: 300, kind: 'registered' }, { t: at, bar: 300, kind: 'crew' }] }],
        objects: [{ id, entity: { id, kind: 'team', layer: 'ops', coord: [8, 46], label: 'Trupp 1' } as { label?: string } }],
      }
      dev.sync.save(dev.local)
    }
    // run until nobody owes the server anything
    for (let i = 0; i < 400 && devices.some((dev) => dev.sync.hasUnsynced); i++) await vi.advanceTimersByTimeAsync(25)
    expect(devices.map((dev) => dev.sync.hasUnsynced)).toEqual([false, false, false])
    expect(server.conflicts).toBeGreaterThan(0) // the saves did meet

    // the live-follow poll: every clean device adopts the server's revision (useIncidentSync)
    for (const dev of devices) {
      const s = await (async () => { const p = getWorkspace('x'); await vi.advanceTimersByTimeAsync(200); return p })()
      if (s.workspace_rev > dev.sync.rev) { dev.sync.adoptServer(s.workspace ?? {}, s.workspace_rev); dev.local = (s.workspace ?? {}) as Ws }
    }

    const ws = server.ws as Ws
    const truppNos = (ws.trupps ?? []).map((t) => t.no)
    const markerNos = (ws.objects ?? []).map((o) => Number(/\d+$/.exec(o.entity?.label ?? '')?.[0]))
    expect(truppNos).toHaveLength(3)
    expect(markerNos).toHaveLength(3)
    // six things, six numbers, one counter
    expect(new Set([...truppNos, ...markerNos]).size).toBe(6)
    // the first registered Trupp keeps 1 — a registered Trupp outranks a loose marker
    expect(ws.trupps!.find((t) => t.id === 'tr0')!.no).toBe(1)
    // every device shows exactly the server's state
    for (const dev of devices) expect(dev.local).toEqual(ws)

    // every Trupp and marker that lost its «1» is said once, by whichever devices noticed it
    const rowIds = new Set(devices.flatMap((dev) => dev.rows))
    const lost = [
      ...ws.trupps!.filter((t) => t.no !== 1).map((t) => `trn-${t.id}-1-${t.no}`),
      ...ws.objects!.filter((o) => o.entity?.label !== 'Trupp 1').map((o) => `trn-${o.id}-1-${/\d+$/.exec(o.entity!.label!)![0]}`),
    ]
    expect([...rowIds].sort()).toEqual(lost.sort())
    // …and the device that minted each one is among those that noticed (it showed the «1»)
    for (const dev of devices) {
      for (const id of lost.filter((r) => r.startsWith(`trn-tr${dev.d}-`) || r.startsWith(`trn-trupp175879440001${dev.d}-`))) {
        expect(dev.rows).toContain(id)
      }
    }
    for (const dev of devices) dev.sync.dispose()
  }, 30_000)
})
