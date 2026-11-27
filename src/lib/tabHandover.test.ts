// Two tabs of one browser on one Einsatz (docs/sync-and-offline.md › Two tabs): a tab that does not
// hold the edit lock writes nothing, a tab that takes the lock over starts from the cache as the
// holder left it, and a tab that loses it drops what it still had waiting. Each «tab» is its own
// IncidentSelection, TabLockAnswers and IncidentTabLock over one shared cache and one Web Locks
// double; the test plays App's part (the lock starts once the Einsatz is open, a takeover opens
// it afresh – App · the reopen effect) and the view's (it edits only while the tab may).
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Workspace } from './api/workspace'

const store = vi.hoisted(() => new Map<string, unknown>())
const get = vi.hoisted(() => vi.fn())
const put = vi.hoisted(() => vi.fn())
const putTrupps = vi.hoisted(() => vi.fn())
const truppsBeacon = vi.hoisted(() => vi.fn())
vi.mock('./api/workspace', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api/workspace')>(),
  getWorkspace: get, putWorkspace: put, putWorkspaceTrupps: putTrupps,
  putWorkspaceRecord: vi.fn(), putWorkspaceRecordBeacon: vi.fn(), putWorkspaceTruppsBeacon: truppsBeacon,
}))
vi.mock('./idb', () => ({
  idbGet: async (key: string) => structuredClone(store.get(key) ?? null),
  idbRead: async (key: string) => ({ ok: true, value: structuredClone(store.get(key) ?? null) }),
  idbSet: async (key: string, value: unknown) => { store.set(key, structuredClone(value)); return true },
  idbUpdate: async (key: string, update: (current: unknown) => unknown) => {
    const next = update(structuredClone(store.get(key) ?? null))
    if (next != null) store.set(key, structuredClone(next))
    return true
  },
  idbDel: async (key: string) => { store.delete(key) },
  idbKeys: async (prefix: string) => ({ ok: true, value: [...store.keys()].filter((k) => k.startsWith(prefix)) }),
}))
vi.mock('./tileEvict', () => ({ withTileEviction: (write: () => Promise<boolean>) => write() }))
import { ApiError } from './api'
import type { IncidentMeta } from './api/incidents'
import { CACHE_DEBOUNCE_MS, setWorkspaceCacheOwner, type WorkspaceSync, type WorkspaceSyncOptions } from './api/workspaceSync'
import { IncidentSelection } from './incidentSelection'
import { IncidentTabLock, incidentLockName, TAB_LOCK_ANSWER_MS, TabLockAnswers } from './tabLock'
import { FakeLocks } from './webLocks.test-utils'

const ID = 'e1'
const meta = { id: ID } as IncidentMeta
const offline = new ApiError(0, 'offline')
type Stored = { workspace: Workspace; dirty: boolean }
const slot = () => store.get(`kp-front-ws-${ID}`) as Stored | undefined
const settle = () => vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS + 50)
const tabs: Tab[] = []

interface Tab { selection: IncidentSelection; lock: IncidentTabLock | null; held: boolean }
const engine = (t: Tab) => t.selection.current as WorkspaceSync

/** One tab with the Einsatz open; its lock starts `lockAfterMs` after the open (App's first render). */
async function tab({ lockAfterMs = 0, options = {} }: { lockAfterMs?: number; options?: WorkspaceSyncOptions } = {}): Promise<Tab> {
  const answers = new TabLockAnswers()
  const opts = { debounceMs: 1_000, ...options, tabLock: answers }
  const t: Tab = { selection: new IncidentSelection(), lock: null, held: true }
  tabs.push(t)
  await t.selection.open(ID, meta, opts)
  const start = () => {
    t.lock = new IncidentTabLock(incidentLockName(ID), (held) => {
      t.held = held
      if (held && t.selection.current?.lockLost) void t.selection.open(ID, meta, opts)
    }, undefined, answers)
    t.lock.start()
  }
  if (lockAfterMs) setTimeout(start, lockAfterMs)
  else start()
  await vi.advanceTimersByTimeAsync(0)
  return t
}
/** The view's edit: what the screen shows plus one change – only where the tab may edit. */
function edit(t: Tab, reportMeta: Record<string, string>) {
  if (!t.held || engine(t).lockLost) throw new Error('read-only tab edited')
  const shown = engine(t).workspace
  engine(t).save({ ...shown, reportMeta: { ...(shown.reportMeta as object), ...reportMeta } })
}
/** The tab goes away: its page-hide flush, then the browser releases its lock. */
function close(t: Tab) {
  engine(t).flushKeepalive()
  t.lock?.stop()
  t.selection.dispose()
}
const editable = (t: Tab) => vi.waitFor(() => expect(t.held && !engine(t).lockLost).toBe(true))
const putsBy = (e: WorkspaceSync) => [...put.mock.calls, ...putTrupps.mock.calls].filter((c) => c.includes(e.writerId)).length

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(globalThis.navigator, 'locks', { value: new FakeLocks(), configurable: true })
  store.clear()
  setWorkspaceCacheOwner('anna')
  get.mockReset().mockResolvedValue({ workspace: {}, workspace_rev: 1 })
  put.mockReset().mockRejectedValue(offline)
  putTrupps.mockReset().mockRejectedValue(offline)
  truppsBeacon.mockReset()
})
afterEach(() => {
  for (const t of tabs.splice(0)) { t.lock?.stop(); t.selection.dispose() }
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis.navigator, 'locks')
  setWorkspaceCacheOwner(null)
})

it('offline-sync F1: the tab that takes over after a close keeps the closed tab’s saved edit', async () => {
  const a = await tab()
  const b = await tab()
  expect([a.held, b.held]).toEqual([true, false])
  get.mockRejectedValue(offline)
  edit(a, { remarks: 'from A' })
  await settle()
  expect(slot()).toMatchObject({ dirty: true, workspace: { reportMeta: { remarks: 'from A' } } })
  close(a)
  await editable(b)
  edit(b, { summary: 'from B' })
  await settle()
  expect(slot()?.workspace.reportMeta).toEqual({ remarks: 'from A', summary: 'from B' })
})

it('hole 1: «Hier bearbeiten» keeps what the holder saved, and the holder writes nothing after it', async () => {
  const a = await tab()
  const b = await tab()
  const holder = engine(a)
  edit(a, { remarks: 'saved in A' })
  await settle()
  edit(a, { lehren: 'typed in A, still inside the cache debounce' }) // the accepted loss
  b.lock!.takeOver()
  await editable(b)
  await vi.waitFor(() => expect(a.held).toBe(false))
  expect(engine(b).workspace.reportMeta).toEqual({ remarks: 'saved in A' })
  edit(b, { summary: 'from B' })
  await vi.advanceTimersByTimeAsync(70_000) // A's cache debounce, push debounce and every retry
  expect(slot()?.workspace.reportMeta).toEqual({ remarks: 'saved in A', summary: 'from B' })
  expect(putsBy(holder)).toBe(0)
})

it.each([0, CACHE_DEBOUNCE_MS + 200])('hole 2: a tab opening behind the holder writes no server copy over the holder’s draft (lock asked after %i ms)', async (lockAfterMs) => {
  const a = await tab()
  let answer!: () => void
  get.mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve({ workspace: {}, workspace_rev: 1 }) }))
  const opening = tab({ lockAfterMs })
  await vi.waitFor(() => expect(answer).toBeTypeOf('function')) // B read the slot and asks the server
  edit(a, { remarks: 'newer in A' })
  await settle()
  answer()
  const b = await opening
  await vi.advanceTimersByTimeAsync(TAB_LOCK_ANSWER_MS + 500)
  expect(b.held).toBe(false)
  expect(slot()).toMatchObject({ dirty: true, workspace: { reportMeta: { remarks: 'newer in A' } } })
})

it('a follower sends no PUT and no beacon and writes no cache, whatever asks it to', async () => {
  const a = await tab()
  const b = await tab({ options: { slice: 'trupps' } }) // a Trupp slice: the one save a beacon carries
  expect(b.held).toBe(false)
  await settle()
  const before = structuredClone(slot())
  expect(before).toBeDefined()
  engine(b).save({ trupps: [{ id: 't1', name: 'Trupp 1' }] }) // a late render, an echo – nothing an operator typed
  engine(b).flushKeepalive()
  await engine(b).flush()
  await vi.advanceTimersByTimeAsync(70_000)
  expect(putsBy(engine(b))).toBe(0)
  expect(truppsBeacon).not.toHaveBeenCalled()
  expect(slot()).toEqual(before)
  expect(a.held).toBe(true)
})

it('a tab that loses the lock drops its waiting cache write, its push and its retry', async () => {
  const a = await tab()
  const b = await tab()
  const holder = engine(a)
  edit(a, { remarks: 'pushed, refused offline' })
  await vi.advanceTimersByTimeAsync(1_100) // the push went and failed: a retry is armed
  expect(putsBy(holder)).toBe(1)
  edit(a, { summary: 'waiting in both debounces' })
  b.lock!.takeOver()
  await editable(b)
  put.mockResolvedValue({ workspace: null, workspace_rev: 2 })
  await vi.advanceTimersByTimeAsync(70_000)
  expect(putsBy(holder)).toBe(1)
  expect(slot()?.workspace.reportMeta).toEqual({ remarks: 'pushed, refused offline' })
})

it('a Trupp save refused with 422 after the lock was lost does not fall back to a full PUT', async () => {
  const a = await tab()
  const b = await tab()
  const holder = engine(a)
  let refuse!: () => void
  putTrupps.mockImplementationOnce(() => new Promise((_, reject) => { refuse = () => reject(new ApiError(422, 'legacy row')) }))
  holder.save({ ...holder.workspace, trupps: [{ id: 't1', name: 'Trupp 1' }] }) // only the Trupps changed: the slice route
  await vi.advanceTimersByTimeAsync(1_100)
  expect(putTrupps).toHaveBeenCalledOnce()
  b.lock!.takeOver()
  await editable(b)
  refuse()
  await vi.advanceTimersByTimeAsync(70_000)
  expect(put.mock.calls.filter((c) => c.includes(holder.writerId))).toEqual([])
})

it('a follower re-sending refused saves leaves the parked copies on disk', async () => {
  const parked = [{ id: 'r1', owner: 'anna', workspace: { reportMeta: { remarks: 'refused' } }, base: {}, baseRev: 1, refusedAt: 1 }]
  store.set(`kp-front-ws-${ID}::__refused__`, parked)
  await tab()
  const b = await tab()
  expect(b.held).toBe(false)
  await engine(b).requeueRefused()
  await vi.advanceTimersByTimeAsync(70_000)
  expect(store.get(`kp-front-ws-${ID}::__refused__`)).toEqual(parked)
})

it('one tab, a lock that never answers: the cache write and the PUT go after the bound, as on main', async () => {
  Object.defineProperty(globalThis.navigator, 'locks', { value: { request: () => new Promise(() => {}) }, configurable: true })
  put.mockResolvedValue({ workspace: null, workspace_rev: 2 })
  const a = await tab()
  edit(a, { remarks: 'alone' })
  await settle()
  expect(slot()?.workspace.reportMeta).toBeUndefined() // waiting for the lock's first answer
  await vi.advanceTimersByTimeAsync(TAB_LOCK_ANSWER_MS)
  expect(slot()).toMatchObject({ workspace: { reportMeta: { remarks: 'alone' } } })
  await vi.advanceTimersByTimeAsync(TAB_LOCK_ANSWER_MS)
  expect(putsBy(engine(a))).toBe(1)
  expect(slot()).toMatchObject({ dirty: false, workspace: { reportMeta: { remarks: 'alone' } } })
})

it('one tab without Web Locks: the cache write and the PUT go at main’s times', async () => {
  Reflect.deleteProperty(globalThis.navigator, 'locks')
  put.mockResolvedValue({ workspace: null, workspace_rev: 2 })
  const a = await tab()
  edit(a, { remarks: 'alone' })
  await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS)
  expect(slot()).toMatchObject({ dirty: true, workspace: { reportMeta: { remarks: 'alone' } } })
  await vi.advanceTimersByTimeAsync(1_000 - CACHE_DEBOUNCE_MS)
  expect(putsBy(engine(a))).toBe(1)
})
