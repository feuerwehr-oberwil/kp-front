import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// LOAD: one editor login on three devices, the 23.09.2026 shape (post-mortem D4/D5) — 140 409s
// on PUT /workspace in ~40 minutes, every alarm event three times. Three REAL `WorkspaceSync`
// engines run against ONE in-memory server that implements the backend's contract (a PUT at a
// stale base_rev is a 409; an accepted one bumps the rev by exactly one; an audit event is
// idempotent on client_id and 409s on a different payload), with random latency, random edit
// timing and live-follow adoption, all interleaved on fake timers under a seeded PRNG.
//
// What must hold at the end: every device's every edit is on the server, the revs the server
// handed out are 1..N with no gap, no device ever exhausted its conflict budget (status
// 'error'), and the alarm every device observed is one event per alarm, not one per device.

// `cameraViews`: a plain per-id collection (mergeById) — `drawings` would be re-derived from the
// unified objects and a bare `{ id }` is no drawing
type Ws = { cameraViews?: { id: string }[] }

const server = vi.hoisted(() => ({
  ws: {} as Record<string, unknown>,
  rev: 0,
  revs: [] as number[],
  puts: 0,
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
      await wait() // the request travels…
      server.puts++
      if (baseRev !== server.rev) { server.conflicts++; throw new ApiError(409, 'Workspace wurde zwischenzeitlich geändert') }
      server.rev += 1
      server.revs.push(server.rev)
      server.ws = structuredClone(ws)
      const rev = server.rev
      await wait() // …and so does the answer
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
  // the hydrate paths read through `idbRead`: an empty slot, read fine
  idbRead: vi.fn(async () => ({ ok: true, value: null })),
  idbSet: vi.fn(async () => true),
  idbDel: vi.fn(async () => undefined),
}))
vi.mock('../tileEvict', () => ({ withTileEviction: (fn: () => Promise<boolean>) => fn() }))

const { getWorkspace } = await import('./workspace')
const { WorkspaceSync } = await import('./workspaceSync')
const { observedEventId } = await import('../eventScope')

/** mulberry32 — a seeded PRNG, so a failure reproduces */
function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(server, { ws: {}, rev: 0, revs: [], puts: 0, conflicts: 0 })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('WorkspaceSync · LOAD — three devices, one login, 200 edits each', () => {
  it.each([1, 2, 3])('every edit lands, revs are contiguous, no budget is exhausted, alarms land once (seed %i)', async (seed) => {
    const rand = prng(seed)
    vi.spyOn(Math, 'random').mockImplementation(rand) // the backoff jitter draws from it too
    server.latency = () => 5 + Math.floor(rand() * 75)
    const EDITS = Number(process.env.LOAD_EDITS ?? 200)
    const ACTOR = 'user-9ff239:login'

    // the audit log: idempotent on client_id, a different payload under a known id is the 409
    const events = new Map<string, string>()
    let eventConflicts = 0
    const ingest = (client_id: string, payload: unknown) => {
      const body = JSON.stringify(payload)
      const known = events.get(client_id)
      if (known === undefined) events.set(client_id, body)
      else if (known !== body) eventConflicts++
    }

    const devices = [0, 1, 2].map((d) => {
      // separate incident ids = separate offline-cache slots; the mocked API ignores the id,
      // so all three talk to the one server
      const sync = new WorkspaceSync(`incident-dev${d}`, { debounceMs: 300 })
      const dev = { d, sync, local: {} as Ws, made: 0, errors: 0, revs: [] as number[] }
      sync.onApplyMerged = (ws) => { dev.local = ws as Ws }
      sync.onStatus = (s) => { if (s === 'error') dev.errors++ }
      return dev
    })
    // the server's latency is a fake timer too — the opens need the clock running
    const opened = Promise.all(devices.map((dev) => dev.sync.init()))
    await vi.advanceTimersByTimeAsync(200)
    for (const [i, { workspace }] of (await opened).entries()) devices[i].local = (workspace ?? {}) as Ws
    for (const dev of devices) {
      const edit = () => {
        const k = dev.made++
        dev.local = { ...dev.local, cameraViews: [...(dev.local.cameraViews ?? []), { id: `d${dev.d}-${k}` }] }
        dev.sync.save(dev.local)
        // every 10th edit index is an Atemschutz alarm EVERY device observes (same Trupp,
        // same turnus) — the D5 duplicate, keyed the way useTruppActions keys it
        if (k % 10 === 0) ingest(observedEventId(`azal-T${k}-turnus${k}`, ACTOR), { id: `T${k}`, status: 'ueberfaellig' })
        if (dev.made < EDITS) setTimeout(edit, 60 + Math.floor(rand() * 500))
      }
      setTimeout(edit, Math.floor(rand() * 300))
      // the live-follow poll: a CLEAN device adopts the server's revision (useIncidentSync)
      const follow = async () => {
        if (!dev.sync.hasUnsynced) {
          const s = await getWorkspace('x')
          if (!dev.sync.hasUnsynced && s.workspace_rev > dev.sync.rev) {
            dev.sync.adoptServer(s.workspace ?? {}, s.workspace_rev)
            dev.local = (s.workspace ?? {}) as Ws
          }
        }
        if (dev.made < EDITS || dev.sync.hasUnsynced) setTimeout(() => void follow(), 1_000 + Math.floor(rand() * 2_000))
      }
      setTimeout(() => void follow(), 1_000)
    }

    const settled = () => devices.every((dev) => dev.made === EDITS && !dev.sync.hasUnsynced)
    let ticks = 0
    for (; ticks < 20_000 && !settled(); ticks++) await vi.advanceTimersByTimeAsync(50)
    if (process.env.LOAD_DEBUG) console.log(JSON.stringify({ ticks, puts: server.puts, conflicts: server.conflicts, rev: server.rev, made: devices.map((d) => d.made), dirty: devices.map((d) => d.sync.hasUnsynced), errors: devices.map((d) => d.errors) }))
    expect(settled()).toBe(true)

    // every edit of every device is on the server, once
    const ids = ((server.ws as Ws).cameraViews ?? []).map((x) => x.id)
    expect(ids).toHaveLength(3 * EDITS)
    expect(new Set(ids).size).toBe(3 * EDITS)
    for (const dev of devices) for (let k = 0; k < EDITS; k++) expect(ids).toContain(`d${dev.d}-${k}`)
    // revs contiguous: every accepted PUT advanced by exactly one
    expect(server.revs).toEqual(server.revs.map((_, i) => i + 1))
    // no device ran out of conflict retries (resolveConflict ends in 'error' only then)
    expect(devices.map((dev) => dev.errors)).toEqual([0, 0, 0])
    // the alarm every device observed: 20 alarms × 3 devices → 20 events, no id conflict
    expect(events.size).toBe(EDITS / 10)
    expect(eventConflicts).toBe(0)
    // the conflicts happened (this IS a load test) and were all merged
    expect(server.conflicts).toBeGreaterThan(0)
    for (const dev of devices) dev.sync.dispose()
  }, 60_000)
})
