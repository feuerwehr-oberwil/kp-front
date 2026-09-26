import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The field scenario of 24.09.2026, below the browser: REAL `WorkspaceSync` engines on one login,
// all online, minting «Trupp 1» at the same instant from their own view of the counter. One
// in-memory server with the backend's contract: a PUT at a stale base_rev is a 409, an accepted
// one bumps the rev by one; the two slice routes replace only their keys (backend ·
// put_workspace_trupps / put_workspace_record).
//
// What must hold: the server ends with distinct numbers; every device converges; and the Verlauf
// rows (`onTruppRenumbered` → lib/truppNumbers · renumberRow, one per derived id) say every
// renumbering once — including a Trupp registered while a merge was in flight, one whose device
// never looks again, and never a «1 → 2» a slice session cannot push followed by its «2 → 1».

type Tr = { id: string; no?: number; formerNos?: number[]; name: string; members: string[]; readings: { t: string; bar: number; kind: string }[] }
type Obj = { id: string; entity?: { id: string; kind: string; layer: string; coord: number[]; label?: string } }
type Ws = { trupps?: Tr[]; objects?: Obj[]; attendance?: Record<string, unknown> }

const server = vi.hoisted(() => ({
  ws: {} as Record<string, unknown>,
  rev: 0,
  conflicts: 0,
  latency: (() => 0) as () => number,
  /** called as a PUT arrives, before it is answered — a test's hook into «during the merge PUT» */
  onPut: undefined as (() => void) | undefined,
}))

vi.mock('./workspace', async () => {
  const { ApiError } = await import('../api')
  const wait = () => new Promise((resolve) => setTimeout(resolve, server.latency()))
  const put = async (next: (stored: Record<string, unknown>) => Record<string, unknown>, baseRev: number) => {
    server.onPut?.()
    await wait()
    if (baseRev !== server.rev) { server.conflicts++; throw new ApiError(409, 'Workspace wurde zwischenzeitlich geändert') }
    server.rev += 1
    server.ws = structuredClone(next(server.ws))
    const rev = server.rev
    await wait()
    return { workspace: null, workspace_rev: rev }
  }
  return {
    getWorkspace: async () => {
      await wait()
      return { workspace: structuredClone(server.ws), workspace_rev: server.rev }
    },
    putWorkspace: (_id: string, ws: Record<string, unknown>, baseRev: number) => put(() => ws, baseRev),
    putWorkspaceBeacon: () => {},
    putWorkspaceTrupps: (_id: string, trupps: unknown[], baseRev: number) => put((s) => ({ ...s, trupps }), baseRev),
    putWorkspaceTruppsBeacon: () => {},
    putWorkspaceRecord: (_id: string, ws: Record<string, unknown>, baseRev: number) => put((s) => ({ ...s, ...ws }), baseRev),
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
  Object.assign(server, { ws: {}, rev: 0, conflicts: 0, latency: () => 0, onPut: undefined })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

/** a Trupp as useTruppActions · createTrupp registers it, `ms` after 10:00:00 */
const reg = (id: string, no: number, ms: number): Tr => {
  const t = new Date(Date.UTC(2026, 8, 25, 10, 0, 0, ms)).toISOString()
  return { id, no, name: `GF ${id}`, members: [], readings: [{ t, bar: 300, kind: 'registered' }, { t, bar: 300, kind: 'crew' }] }
}
const chip = (id: string, label: string): Obj => ({ id, entity: { id, kind: 'team', layer: 'ops', coord: [8, 46], label } })

type Slice = 'trupps' | 'record' | undefined
async function device(name: string, slice?: Slice) {
  const sync = new WorkspaceSync(`incident-${name}`, { debounceMs: 50, ...(slice ? { slice } : {}) })
  const dev = { sync, local: {} as Ws, rows: [] as string[] }
  sync.onApplyMerged = (ws) => { dev.local = ws as Ws }
  sync.onTruppRenumbered = (changes) => { for (const c of changes) dev.rows.push(renumberRow(c, '2026-09-25T10:00:05Z').id) }
  const opened = sync.init()
  await vi.advanceTimersByTimeAsync(200)
  dev.local = ((await opened).workspace ?? {}) as Ws
  return dev
}
type Dev = Awaited<ReturnType<typeof device>>
const settle = async (devs: Dev[]) => {
  for (let i = 0; i < 400 && devs.some((d) => d.sync.hasUnsynced); i++) await vi.advanceTimersByTimeAsync(25)
  expect(devs.map((d) => d.sync.hasUnsynced)).toEqual(devs.map(() => false))
}
/** the live-follow poll: a clean device adopts the server's revision (useIncidentSync) */
const follow = async (dev: Dev) => {
  const p = getWorkspace('x')
  await vi.advanceTimersByTimeAsync(200)
  const s = await p
  if (s.workspace_rev > dev.sync.rev) { dev.sync.adoptServer(s.workspace ?? {}, s.workspace_rev); dev.local = (s.workspace ?? {}) as Ws }
}
const numbers = (ws: Ws) => Object.fromEntries((ws.trupps ?? []).map((t) => [t.id, t.no]))

describe('WorkspaceSync · three online devices mint «Trupp 1» at once', () => {
  it.each([
    ['no latency', () => 0],
    ['uneven latency', (() => { let n = 0; return () => [40, 5, 90, 20, 60][n++ % 5] })()],
  ])('the server ends with distinct numbers, every device converges, one row per renumbering (%s)', async (_label, latency) => {
    server.latency = latency
    const devices = [await device('d0'), await device('d1'), await device('d2')]

    // the same instant on all three: a registered Trupp and a loose marker, both «1»
    devices.forEach((dev, d) => {
      const id = `trupp175879440001${d}-0${d}ab`
      dev.local = { trupps: [reg(`tr${d}`, 1, 10 + d)], objects: [chip(id, 'Trupp 1')] }
      dev.sync.save(dev.local)
    })
    await settle(devices)
    expect(server.conflicts).toBeGreaterThan(0) // the saves did meet
    for (const dev of devices) await follow(dev)

    const ws = server.ws as Ws
    const truppNos = (ws.trupps ?? []).map((t) => t.no)
    const markerNos = (ws.objects ?? []).map((o) => Number(/\d+$/.exec(o.entity?.label ?? '')?.[0]))
    expect(truppNos).toHaveLength(3)
    expect(markerNos).toHaveLength(3)
    expect(new Set([...truppNos, ...markerNos]).size).toBe(6) // six things, six numbers, one counter
    expect(ws.trupps!.find((t) => t.id === 'tr0')!.no).toBe(1) // the first registered keeps 1
    for (const dev of devices) expect(dev.local).toEqual(ws) // every device shows the server's state

    // every Trupp and marker that lost its «1» is said, by whichever devices noticed it
    const rowIds = new Set(devices.flatMap((dev) => dev.rows))
    const lost = [
      ...ws.trupps!.filter((t) => t.no !== 1).map((t) => `trn-${t.id}-1-${t.no}`),
      ...ws.objects!.filter((o) => o.entity?.label !== 'Trupp 1').map((o) => `trn-${o.id}-1-${/\d+$/.exec(o.entity!.label!)![0]}`),
    ]
    expect([...rowIds].sort()).toEqual(lost.sort())
    // …and the device that minted each one is among those that noticed (it showed the «1»)
    devices.forEach((dev, d) => {
      for (const id of lost.filter((r) => r.startsWith(`trn-tr${d}-`) || r.startsWith(`trn-trupp175879440001${d}-`))) expect(dev.rows).toContain(id)
    })
    for (const dev of devices) dev.sync.dispose()
  }, 30_000)
})

describe('WorkspaceSync · the renumbering row is never lost (review of #228)', () => {
  it('a Trupp registered WHILE the merge PUT is in flight is renumbered and said', async () => {
    server.latency = () => 30
    const a = await device('a')
    const b = await device('b')
    a.local = { trupps: [reg('X', 1, 10)] }
    a.sync.save(a.local)
    await settle([a])

    // B registered «Trupp 1» a moment later from its own (stale) view: its save 409s and merges
    b.local = { trupps: [reg('Y', 1, 20)] }
    let puts = 0
    server.onPut = () => {
      // B's SECOND put is the merge PUT: while it is in flight, B registers «Trupp 2» — its view
      // still shows only Y (as 1), so it mints 2, which the merge is handing Y at this very moment
      if (++puts === 2) {
        b.local = { trupps: [...b.local.trupps!, reg('Z', 2, 500)] }
        b.sync.save(b.local)
      }
    }
    b.sync.save(b.local)
    await settle([b])
    server.onPut = undefined

    expect(numbers(server.ws as Ws)).toEqual({ X: 1, Y: 2, Z: 3 })
    expect(b.rows).toContain('trn-Y-1-2')
    // the one the content that 409'd never held — said against what the view last SAVED
    expect(b.rows).toContain('trn-Z-2-3')
    for (const d of [a, b]) d.sync.dispose()
  })

  it('the RESOLVING device says what it renumbered of the server\'s copy — the losing device may never look again', async () => {
    const a = await device('a')
    // A registers its Trupp, pushes, and is closed (a Link that went away, a tablet that will
    // reopen later from a clean cache and simply adopt the server copy with nothing to compare)
    a.local = { trupps: [reg('X', 1, 50)] }
    a.sync.save(a.local)
    await settle([a])
    a.sync.dispose()

    // B's Trupp went in before B saved: it outranks X, and its merge takes 1 from X, which is on
    // the server — the one case a landed number moves (a crew inside keeps its number)
    const b = await device('b')
    const y = reg('Y', 1, 10)
    b.local = { trupps: [{ ...y, readings: [...y.readings, { t: '2026-09-25T10:00:30.000Z', bar: 300, kind: 'entry' }] }] }
    // B's view is stale: it had opened before A's save landed
    const bs = b.sync as unknown as { entry: { base: Ws; baseRev: number; workspace: Ws } }
    bs.entry = { ...bs.entry, base: {}, baseRev: 0 }
    b.sync.save(b.local)
    await settle([b])

    expect(numbers(server.ws as Ws)).toEqual({ X: 2, Y: 1 })
    expect(b.rows).toEqual(['trn-X-1-2']) // B never showed X — it says it because its merge did it
    b.sync.dispose()
  })
})

describe('WorkspaceSync · slice sessions settle only what they can push', () => {
  it('the el role (record slice) settles nothing, and says only what an adopted revision shows', async () => {
    // a duplicate already on the server (two Trupps «1»), and an el device opening onto it
    server.ws = { trupps: [reg('P', 1, 10), reg('Q', 1, 20)], attendance: {} }
    server.rev = 1
    const el = await device('el', 'record')
    // an editor changes something meanwhile, so the el's Anwesenheit save 409s and merges
    server.ws = { ...server.ws, attendance: { p0: { present: true } } }
    server.rev = 2
    el.local = { ...el.local, attendance: { p1: { present: true } } }
    el.sync.save(el.local)
    await settle([el])
    // it merged — and left the numbers alone: it could not have pushed a new one
    expect(numbers(el.local)).toEqual({ P: 1, Q: 1 })
    expect(el.rows).toEqual([])

    // an editor's merge settles it; the el adopts that revision and says it, once
    server.ws = { ...server.ws, trupps: [reg('P', 1, 10), { ...reg('Q', 3, 20), formerNos: [1] }] }
    server.rev += 1
    await follow(el)
    await follow(el)
    expect(el.rows).toEqual(['trn-Q-1-3'])
    el.sync.dispose()
  })

  it('the Atemschutz-Link settles Trupps (its push carries them) but not chips — and never says «2 → 1»', async () => {
    // an editor's Trupp «1» and two loose chips «Trupp 5» nobody has settled yet
    server.ws = { trupps: [reg('E', 1, 10)], objects: [chip('trupp1758794400000-00a', 'Trupp 5'), chip('trupp1758794400001-00b', 'Trupp 5')] }
    server.rev = 1
    const link = await device('link', 'trupps')
    // the Link had registered its own «Trupp 1» against a view from before the editor's
    const ls = link.sync as unknown as { entry: { base: Ws; baseRev: number } }
    ls.entry = { ...ls.entry, base: {}, baseRev: 0 }
    link.local = { trupps: [reg('L', 1, 20)] }
    link.sync.save(link.local)
    await settle([link])

    const ws = server.ws as Ws
    expect(numbers(ws)).toEqual({ E: 1, L: 6 }) // above the chips' 5: the counter still reads them
    expect(ws.objects!.map((o) => o.entity!.label)).toEqual(['Trupp 5', 'Trupp 5']) // not its to push
    await follow(link)
    await follow(link)
    // one row id (the journal keeps one row per id), and nothing about the chips either way
    expect([...new Set(link.rows)]).toEqual(['trn-L-1-6'])
    link.sync.dispose()
  })
})

describe('WorkspaceSync · a session nobody listens to', () => {
  it('holds each renumbering once, however often it is seen', async () => {
    server.ws = { trupps: [reg('P', 1, 10)] }
    server.rev = 1
    const sync = new WorkspaceSync('incident-quiet', { debounceMs: 50 })
    const opened = sync.init()
    await vi.advanceTimersByTimeAsync(200)
    await opened
    const s1 = { trupps: [{ ...reg('P', 2, 10), formerNos: [1] }] }
    sync.adoptServer(s1, 2)
    sync.adoptServer({ trupps: [reg('P', 1, 10)] }, 3)
    sync.adoptServer(s1, 4)
    expect(sync.drainTruppRenumbered().map((c) => `${c.id}:${c.from}->${c.to}`)).toEqual(['P:1->2', 'P:2->1'])
    sync.dispose()
  })
})

// Staging walk-through, 25.09.2026 (N16): a Trupp «1» stands, and three devices register at the
// same moment, each minting «2». Two of the merges ran against the same server copy and both
// handed out 3; the second one to land then moved the other Trupp again, 3 → 4, and the paper
// said two crews «were» Trupp 3. A Trupp moves at most ONCE per collision, straight from the
// number its device showed to the one it keeps, and a number nothing was written under never
// enters `formerNos`.
describe('WorkspaceSync · three devices, one collision, one move each (N16)', () => {
  const orders = [[0, 1, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0], [0, 2, 1], [1, 0, 2]]
  const patterns: [string, () => () => number][] = [
    ['no latency', () => () => 0],
    ['even latency', () => () => 40],
    ['uneven latency', () => { let n = 0; return () => [40, 5, 90, 20, 60, 15, 75][n++ % 7] }],
  ]
  for (const [label, latency] of patterns) {
    it.each(orders)(`save order %i-%i-%i, ${label}`, async (...order: number[]) => {
      server.ws = { trupps: [reg('K', 1, 0)] }
      server.rev = 1
      server.latency = latency()
      const devices = [await device('n0'), await device('n1'), await device('n2')]
      // all three mint «2» from the same view — the saves go out in `order`, a few ms apart
      for (const d of order) {
        devices[d].local = { trupps: [...(devices[d].local.trupps ?? []), reg(`T${d}`, 2, 100 + d)] }
        devices[d].sync.save(devices[d].local)
        await vi.advanceTimersByTimeAsync(3)
      }
      await settle(devices)
      for (const dev of devices) await follow(dev)
      for (const dev of devices) await follow(dev)

      const ws = server.ws as Ws
      const trupps = ws.trupps!
      expect(new Set(trupps.map((t) => t.no)).size).toBe(4) // four crews, four numbers
      expect(trupps.find((t) => t.id === 'K')!.no).toBe(1)
      for (const t of trupps.filter((x) => x.id !== 'K')) {
        // at most one move, and only ever away from the number it was minted under
        expect(t.formerNos ?? []).toEqual(t.no === 2 ? [] : [2])
      }
      // no number is one crew's now and another crew's before
      const now = new Set(trupps.map((t) => t.no))
      for (const t of trupps) for (const n of t.formerNos ?? []) expect(now.has(n) && n !== 2).toBe(false)
      // the rows: one per moved Trupp, straight from 2 to where it ended — never a chain
      const rows = [...new Set(devices.flatMap((dev) => dev.rows))].sort()
      const moved = trupps.filter((t) => t.formerNos?.length).map((t) => `trn-${t.id}-2-${t.no}`).sort()
      expect(rows).toEqual(moved)
      for (const dev of devices) expect(dev.local).toEqual(ws)
      for (const dev of devices) dev.sync.dispose()
    })
  }
})
