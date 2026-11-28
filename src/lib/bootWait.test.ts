// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncidentMeta } from './api/incidents'

// The launch's network path in FAKE milliseconds (performance sweep 26.11.2026, finding 27): the
// real list call, WorkspaceSync and IncidentSelection, the real fetch wrapper with its 20 s bound
// and its session renewal, over fake-indexeddb. `boot` is App's boot effect reduced to its
// network steps (bootList → bootPlan → open). Red on the boot before (dead link, stored copy):
// 40,010 ms to the workspace on screen.

type Link = 'normal' | 'slow' | 'dead' | 'offline'
const net = {
  link: 'normal' as Link,
  requests: [] as string[],
  list: [] as IncidentMeta[],
  rev: 5,
  status: {} as Record<string, number>,
  /** paths that never answer, whatever the link */
  stall: [] as string[],
}
const RTT: Record<Link, number> = { normal: 300, slow: 6_000, dead: 0, offline: 0 }
const SERVER = { from: 'server' }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function fakeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const path = new URL(input, 'http://kp.test').pathname
  net.requests.push(path)
  if (net.link === 'offline') return Promise.reject(new TypeError('Failed to fetch'))
  return new Promise((resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
    if (net.link === 'dead' || net.stall.includes(path)) return
    setTimeout(() => {
      const status = net.status[path] ?? 200
      if (status !== 200) resolve(json(status, { detail: 'nein' }))
      else if (path === '/api/incidents') resolve(json(200, net.list))
      else resolve(json(200, { workspace: SERVER, workspace_rev: net.rev }))
    }, RTT[net.link])
  })
}

const { __resetIdbForTests, idbSet } = await import('./idb')
const { ApiError, SESSION_EXPIRED_EVENT } = await import('./api')
const { setWorkspaceCacheOwner, storedCopy } = await import('./api/workspaceSync')
const { IncidentSelection } = await import('./incidentSelection')
const { bootPlan } = await import('./karte/home')
const { bootList, offlineLine, offlineLineUntimed, BOOT_STORED_WAIT_MS } = await import('./bootWait')

const meta = (id: string, over: Partial<IncidentMeta> = {}) =>
  ({ id, title: id, source: 'manual', started_at: '2026-11-27T05:00:00Z', is_archived: false, ...over }) as IncidentMeta

const STORED = { from: 'cache' }

/** App's boot, network steps only. `ms`: fake ms until the workspace is on screen. What the
 *  mounted view's follow does after that: bootWait.follow.test.ts. */
async function boot(prefs: { incidentId?: string }, path = '/') {
  const start = Date.now()
  const selection = new IncidentSelection()
  selections.push(selection)
  const out = { ms: 0, opened: null as Awaited<ReturnType<InstanceType<typeof IncidentSelection>['open']>>, kind: '', selection }
  const booted = await bootList(path, prefs, { now: Date.now() })
  out.kind = booted.kind
  if (booted.kind === 'stored') {
    out.opened = await selection.open(booted.incident.id, booted.incident, { storedFirst: true })
  } else {
    const plan = bootPlan(path, booted.list, prefs, { now: Date.now(), crash: null })
    if (plan.kind === 'open') out.opened = await selection.open(plan.incident.id, plan.incident, {})
  }
  out.ms = Date.now() - start
  return out
}

/** Run `task` to its end under the fake clock, letting fake-indexeddb's real-time tasks run
 *  between 10 ms steps; then `after` fake ms more, for the answers that land later. */
async function drive<T>(task: Promise<T>, after = 0): Promise<T> {
  let done = false
  void task.finally(() => { done = true }).catch(() => undefined)
  const step = async () => {
    for (let k = 0; k < 5; k++) await new Promise((r) => setImmediate(r))
    vi.advanceTimersByTime(10)
  }
  for (let i = 0; i < 10_000 && !done; i++) await step()
  for (let i = 0; i < after / 10; i++) await step()
  return task
}

/** the device's list, and – unless `workspace: false` – a stored copy of `id` at rev 4 */
async function seedCache(id: string, { workspace = true, lastSyncedAt = 1 as number | null } = {}) {
  await idbSet('kp-front-incidents', net.list)
  if (workspace) await idbSet(`kp-front-ws-${id}`, { workspace: STORED, base: STORED, baseRev: 4, dirty: false, lastSyncedAt, owner: 'u1' })
}

const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')
const selections: InstanceType<typeof IncidentSelection>[] = []
const unhandled: unknown[] = []
const onUnhandled = (e: unknown) => { unhandled.push(e) }

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  setWorkspaceCacheOwner('reset')
  setWorkspaceCacheOwner('u1')
  Object.assign(net, { link: 'normal', requests: [], list: [meta('a')], rev: 5, status: {}, stall: [] })
  unhandled.length = 0
  process.on('unhandledRejection', onUnhandled)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  // api · timeoutSignal's own timer fallback, so the 20 s bound runs on the fake clock
  Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true })
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
})
afterEach(async () => {
  // land every engine's cache write in THIS test's store before the next one replaces it
  for (const s of selections.splice(0)) s.dispose()
  await new Promise((r) => setImmediate(r))
  vi.useRealTimers()
  vi.unstubAllGlobals()
  process.off('unhandledRejection', onUnhandled)
  if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor)
})

const ONE_LAUNCH = ['/api/incidents', '/api/incidents/a/workspace']

describe('with a stored copy, the start waits 5 s for the server', () => {
  it('(a) dead link: the stored copy is on screen after 5 s, not 40', async () => {
    net.link = 'dead'
    await seedCache('a')
    const { ms, opened, kind } = await drive(boot({ incidentId: 'a' }), 25_000)
    expect(kind).toBe('stored')
    expect(opened?.workspace).toEqual(STORED)
    expect(ms).toBeGreaterThanOrEqual(BOOT_STORED_WAIT_MS)
    expect(ms).toBeLessThan(BOOT_STORED_WAIT_MS + 100)
    // (e) the same two requests, each sent once – the late ones gave up at their own 20 s
    expect(net.requests).toEqual(ONE_LAUNCH)
    expect(unhandled).toEqual([])
  })

  // the server's state then follows within one round of the live follow (bootWait.follow.test.ts)
  it('(b) slow link: the stored copy at 5 s, the open’s own request still sent once', async () => {
    net.link = 'slow'
    await seedCache('a')
    const out = await drive(boot({ incidentId: 'a' }), 10_000)
    expect(out.opened?.workspace).toEqual(STORED)
    expect(out.ms).toBeLessThan(BOOT_STORED_WAIT_MS + 100)
    expect(net.requests).toEqual(ONE_LAUNCH)
    expect(unhandled).toEqual([])
  })

  it('(c) normal link: the list in time, the server’s state at once, as before', async () => {
    await seedCache('a')
    const out = await drive(boot({ incidentId: 'a' }))
    expect(out.kind).toBe('list')
    expect(out.opened?.workspace).toEqual(SERVER)
    expect(out.ms).toBeLessThan(2 * RTT.normal + 100)
    expect(net.requests).toEqual(ONE_LAUNCH)
  })

  it('(d) no stored copy, dead link: the waits of before', async () => {
    net.link = 'dead'
    await seedCache('a', { workspace: false })
    const error = await drive(boot({ incidentId: 'a' })).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(Date.now()).toBeGreaterThanOrEqual(40_000)
    expect(net.requests).toEqual(ONE_LAUNCH)
  })

  it('a first start, or a launch into /karte, waits for the list as before', async () => {
    net.link = 'dead'
    await seedCache('a')
    const first = await drive(boot({}))
    expect(first.kind).toBe('list')
    expect(first.ms).toBeGreaterThanOrEqual(20_000)
    const karte = await drive(boot({ incidentId: 'a' }, '/karte'))
    expect(karte.kind).toBe('list')
    expect(karte.ms).toBeGreaterThanOrEqual(20_000)
  })

  it('offline (the request fails at once): silence too – the stored copy at once', async () => {
    net.link = 'offline'
    await seedCache('a')
    const out = await drive(boot({ incidentId: 'a' }))
    expect(out.kind).toBe('stored')
    expect(out.opened?.workspace).toEqual(STORED)
    expect(out.ms).toBeLessThan(100)
  })

  it('a list that fails fast (503 → the device’s list) is silence: the stored copy, not a 20 s workspace wait', async () => {
    net.status = { '/api/incidents': 503 }
    net.stall = ['/api/incidents/a/workspace']
    await seedCache('a')
    const out = await drive(boot({ incidentId: 'a' }), 25_000)
    expect(out.kind).toBe('stored')
    expect(out.opened?.workspace).toEqual(STORED)
    expect(out.ms).toBeLessThan(2 * RTT.normal + 100)
    expect(unhandled).toEqual([])
  })
})

describe('a refusal is never answered with the stored copy', () => {
  it('within the wait: the list’s refusal is the boot’s, as before', async () => {
    net.status = { '/api/incidents': 403 }
    await seedCache('a')
    const error = await drive(boot({ incidentId: 'a' })).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as InstanceType<typeof ApiError>).status).toBe(403)
    expect(net.requests).toEqual(['/api/incidents'])
  })

  it('after it: a 401 on the late workspace answer closes the cached reads and says «abgelaufen»', async () => {
    net.link = 'slow'
    net.status = { '/api/incidents/a/workspace': 401, '/api/auth/refresh': 401 }
    await seedCache('a')
    let expired = 0
    const onExpired = () => { expired++ }
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    const out = await drive(boot({ incidentId: 'a' }), 20_000)
    window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
    expect(out.opened?.workspace).toEqual(STORED)
    expect(expired).toBe(1)
    expect(await storedCopy('a')).toBeNull()
    expect(unhandled).toEqual([])
  })
})

describe('offlineLine', () => {
  it('names the stored copy’s time, with the day when it is another one', () => {
    vi.setSystemTime(new Date(2026, 10, 27, 15, 0))
    expect(offlineLine(new Date(2026, 10, 27, 14, 5).getTime())).toBe('Offline – gespeicherte Daten von 14:05 werden angezeigt.')
    expect(offlineLine(new Date(2026, 10, 26, 23, 50).getTime())).toBe('Offline – gespeicherte Daten von 26.11. 23:50 werden angezeigt.')
    expect(offlineLine(null)).toBe('Offline – gespeicherte Daten werden angezeigt.')
  })

  it('loses the time when another Einsatz is on screen, and leaves any other note alone', () => {
    vi.setSystemTime(new Date(2026, 10, 27, 15, 0))
    const shown = offlineLine(new Date(2026, 10, 27, 14, 5).getTime())
    expect(offlineLineUntimed(shown, shown)).toBe('Offline – gespeicherte Daten werden angezeigt.')
    expect(offlineLineUntimed('Liste konnte nicht geladen werden', shown)).toBe('Liste konnte nicht geladen werden')
    expect(offlineLineUntimed(null, shown)).toBeNull()
  })

  it('loses the time across midnight too, when the same time would now read with its day', () => {
    vi.setSystemTime(new Date(2026, 10, 26, 23, 55))
    const at = new Date(2026, 10, 26, 23, 50).getTime()
    const shown = offlineLine(at) // «… von 23:50 …»
    vi.setSystemTime(new Date(2026, 10, 27, 0, 5))
    expect(offlineLine(at)).not.toBe(shown) // formatted now, it carries the day
    expect(offlineLineUntimed(shown, shown)).toBe('Offline – gespeicherte Daten werden angezeigt.')
  })
})
