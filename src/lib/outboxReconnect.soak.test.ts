import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Soak for the outbox reconnect rule (24.09.2026, after #209): 1 000 randomised interleavings of
// edits, flush requests, the link dropping and returning, and in-flight requests settling in any
// order — for the workspace and for the audit-event outbox. Two properties, checked throughout:
//   · NOTHING IS ACKNOWLEDGED EARLY — the workspace is «clean» only while the server holds the
//     last saved blob; an audit event leaves `pending` only once the server has it.
//   · DELIVERY AFTER RECONNECT — once the link is back, ONE reconnect trigger (the `online`
//     event / the reach signal) delivers everything, even when it lands while an attempt sent
//     under the old conditions is still settling. Timers never advance here: no backoff helps.
// Plus the offline half: requests stay bounded by what was asked for — nothing loops by itself.

const net = vi.hoisted(() => ({
  online: true,
  /** bumped on every reconnect; a request sent in an older epoch was sent under old conditions */
  epoch: 0,
  inflight: [] as { epoch: number; settle: (outcome: 'ok' | 'lost' | 'fail') => void }[],
}))

const server = vi.hoisted(() => ({ ws: {} as Record<string, unknown>, rev: 1, events: new Set<string>() }))

vi.mock('./api/workspace', async () => {
  const { ApiError } = await import('./api')
  const put = (_id: string, ws: Record<string, unknown>) =>
    new Promise((resolve, reject) => {
      net.inflight.push({
        epoch: net.online ? net.epoch : -1, // sent offline: doomed whatever happens next
        settle: (outcome) => {
          if (outcome !== 'fail') { server.ws = structuredClone(ws); server.rev++ }
          if (outcome === 'ok') resolve({ workspace: null, workspace_rev: server.rev })
          else reject(new ApiError(0, 'offline'))
        },
      })
    })
  return {
    getWorkspace: vi.fn(async () => ({ workspace: structuredClone(server.ws), workspace_rev: server.rev })),
    putWorkspace: vi.fn(put),
    putWorkspaceBeacon: vi.fn(), putWorkspaceTrupps: vi.fn(), putWorkspaceTruppsBeacon: vi.fn(),
    putWorkspaceRecord: vi.fn(), putWorkspaceRecordBeacon: vi.fn(),
  }
})

vi.mock('./api/events', async () => {
  const { ApiError } = await import('./api')
  return {
    ingestEvents: vi.fn((_id: string, batch: { client_id: string }[]) =>
      new Promise<void>((resolve, reject) => {
        net.inflight.push({
          epoch: net.online ? net.epoch : -1,
          settle: (outcome) => {
            if (outcome !== 'fail') for (const e of batch) server.events.add(e.client_id) // idempotent by client_id
            if (outcome === 'ok') resolve()
            else reject(new ApiError(0, 'offline'))
          },
        })
      })),
    ingestEventsBeacon: vi.fn(),
  }
})

const disk = vi.hoisted(() => new Map<string, unknown>())
vi.mock('./idb', () => ({
  idbGet: vi.fn(async (k: string) => (disk.has(k) ? structuredClone(disk.get(k)) : null)),
  // the hydrate paths read through `idbRead` (#188); it answers from the same disk
  idbRead: vi.fn(async (k: string) => ({ ok: true, value: disk.has(k) ? structuredClone(disk.get(k)) : null })),
  idbSet: vi.fn(async (k: string, v: unknown) => { disk.set(k, structuredClone(v)); return true }),
  idbDel: vi.fn(async (k: string) => { disk.delete(k) }),
}))
vi.mock('./tileEvict', () => ({ withTileEviction: (fn: () => Promise<boolean>) => fn() }))

const { WorkspaceSync } = await import('./api/workspaceSync')
const { AuditEventStore } = await import('./auditEventStore')
const { putWorkspace } = vi.mocked(await import('./api/workspace'))
const { ingestEvents } = vi.mocked(await import('./api/events'))

/** mulberry32 — seeded, so a failing scenario is reproducible from its seed */
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

const settleMicrotasks = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }

/** Settle one in-flight request as the network would: a request sent offline, or sent before
 *  the latest reconnect, fails; one sent on the live link succeeds — while the link is flaky,
 *  sometimes with the response lost after the server accepted it. */
function settleOne(rand: () => number, pick = Math.floor(rand() * net.inflight.length), stable = false) {
  const [req] = net.inflight.splice(pick, 1)
  if (!net.online || req.epoch !== net.epoch) req.settle('fail')
  else req.settle(!stable && rand() < 0.15 ? 'lost' : 'ok')
}

/** Reconnect, fire ONE flush (what the `online` handler / reach signal does), then let the now
 *  stable network answer until nothing is in flight. No timer is advanced. */
async function reconnectAndDrain(flush: () => Promise<void>, rand: () => number) {
  if (!net.online) { net.online = true; net.epoch++ } else net.epoch++ // the old attempt was sent «before»
  void flush()
  for (let quiet = 0, guard = 0; quiet < 3 && guard < 200; guard++) {
    await settleMicrotasks()
    if (net.inflight.length) { quiet = 0; settleOne(rand, 0, true) } else quiet++
  }
}

const SCENARIOS = 1_000

beforeEach(() => {
  vi.useFakeTimers()
  net.online = true; net.epoch = 0; net.inflight = []
  server.ws = {}; server.rev = 1; server.events = new Set()
  disk.clear()
  putWorkspace.mockClear(); ingestEvents.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('outbox reconnect soak', () => {
  it(`workspace: ${SCENARIOS} interleavings — never clean early, always delivered after reconnect`, async () => {
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const rand = prng(seed)
      net.online = true; net.epoch = 0; net.inflight = []
      server.ws = {}; server.rev = 1
      disk.clear()
      putWorkspace.mockClear()
      const sync = new WorkspaceSync(`i${seed}`, { debounceMs: 1e9 })
      await sync.init()
      const items: number[] = []
      let flushes = 0
      const steps = 10 + Math.floor(rand() * 30)
      for (let s = 0; s < steps; s++) {
        const r = rand()
        if (r < 0.3) { items.push(s); sync.save({ items: [...items] }) }
        else if (r < 0.55) { flushes++; void sync.flush() }
        else if (r < 0.85) { if (net.inflight.length) settleOne(rand) }
        else { net.online = !net.online; if (net.online) net.epoch++ }
        await settleMicrotasks()
        // nothing is acknowledged that the server did not accept
        if (!sync.hasUnsynced) expect(server.ws, `seed ${seed} step ${s}`).toEqual(items.length ? { items } : {})
        // bounded by what was asked for — an offline device does not loop
        expect(putWorkspace.mock.calls.length, `seed ${seed}`).toBeLessThanOrEqual(flushes + items.length)
      }
      if (!items.length) { sync.dispose(); continue }
      await reconnectAndDrain(() => sync.flush(), rand)
      expect(sync.hasUnsynced, `seed ${seed}: delivered after reconnect`).toBe(false)
      expect(server.ws, `seed ${seed}`).toEqual({ items })
      expect(sync.syncStatus, `seed ${seed}`).toBe('synced')
      sync.dispose()
    }
  })

  it(`audit events: ${SCENARIOS} interleavings — never dropped early, always delivered after reconnect`, async () => {
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const rand = prng(seed * 7919)
      net.online = true; net.epoch = 0; net.inflight = []
      server.events = new Set()
      disk.clear()
      ingestEvents.mockClear()
      const store = new AuditEventStore(`i${seed}`, 'editor', false)
      store.start()
      await settleMicrotasks()
      const appended: string[] = []
      let flushes = 0
      const steps = 10 + Math.floor(rand() * 30)
      for (let s = 0; s < steps; s++) {
        const r = rand()
        if (r < 0.3) {
          const id = `e${seed}-${s}`
          appended.push(id)
          store.append({ client_id: id, op_type: 'draw.add', payload: { s }, occurred_at: '2026-09-24T00:00:00Z' })
        } else if (r < 0.55) { flushes++; void store.flush() }
        else if (r < 0.85) { if (net.inflight.length) settleOne(rand) }
        else { net.online = !net.online; if (net.online) net.epoch++ }
        await settleMicrotasks()
        // an event leaves the outbox only once the server has it
        const pending = new Set(store.getRecoveryData().pending.map((e) => e.client_id))
        for (const id of appended) {
          if (!pending.has(id)) expect(server.events.has(id), `seed ${seed} step ${s}: ${id} acknowledged early`).toBe(true)
        }
        expect(ingestEvents.mock.calls.length, `seed ${seed}`).toBeLessThanOrEqual(flushes + appended.length + 1)
      }
      if (!appended.length) { store.stop(); continue }
      await reconnectAndDrain(() => store.flush(), rand)
      expect(store.pendingCount, `seed ${seed}: delivered after reconnect`).toBe(0)
      for (const id of appended) expect(server.events.has(id), `seed ${seed}: ${id}`).toBe(true)
      expect(store.status, `seed ${seed}`).toBe('synced')
      store.stop()
    }
  })
})
