// @vitest-environment jsdom
// «Hier bearbeiten» in a tab that opened behind the holder (docs/sync-and-offline.md › Two tabs):
// the fresh engine of the takeover sends the draft the holder left unsent – without a further edit,
// within the push debounce – and a tab that never took over sends nothing. Tab A is the holder,
// played as in tabHandover.test (its own TabLockAnswers); tab B is App's wiring with the REAL hooks:
// useIncidentTabLock on this document's lock (navigator.locks, the module's tabLockAnswers), the
// reopen of App · reopenTakenOver, and useIncidentSync's owed push for the engine on screen.
import { act, cleanup, renderHook } from '@testing-library/react'
import { useCallback, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Workspace } from './api/workspace'

const store = vi.hoisted(() => new Map<string, unknown>())
const get = vi.hoisted(() => vi.fn())
const put = vi.hoisted(() => vi.fn())
vi.mock('./api/workspace', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api/workspace')>(),
  getWorkspace: get, putWorkspace: put, putWorkspaceTrupps: vi.fn(),
  putWorkspaceRecord: vi.fn(), putWorkspaceRecordBeacon: vi.fn(), putWorkspaceTruppsBeacon: vi.fn(),
  pollWorkspaceSince: vi.fn(async () => null), // the live follow: nothing new
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
import type { IncidentMeta } from './api/incidents'
import { CACHE_DEBOUNCE_MS, setWorkspaceCacheOwner, type WorkspaceSync } from './api/workspaceSync'
import { IncidentSelection } from './incidentSelection'
import { IncidentTabLock, incidentLockName, TabLockAnswers, useIncidentTabLock } from './tabLock'
import { useIncidentSync } from './useIncidentSync'
import { FakeLocks } from './webLocks.test-utils'
import type { Saved } from './workspace'

const ID = 'e1'
const meta = { id: ID } as IncidentMeta
const DEBOUNCE_MS = 1_000
type Stored = { workspace: Workspace; dirty: boolean }
const slot = () => store.get(`kp-front-ws-${ID}`) as Stored | undefined
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))
const putsBy = (e: WorkspaceSync) => put.mock.calls.filter((c) => c.includes(e.writerId))
const noop = () => {}
/** the view's payload: an empty Einsatz with one stable identity – no save effect fires here */
const EMPTY: Saved = { entities: [], drawings: [], recent: [], layerState: [], timeline: [] }
const buildPayload = () => EMPTY

let browser: FakeLocks
const cleanups: (() => void)[] = []

/** Tab A: opens the Einsatz first and holds its lock. */
async function holder() {
  const answers = new TabLockAnswers()
  const selection = new IncidentSelection()
  await selection.open(ID, meta, { debounceMs: DEBOUNCE_MS, tabLock: answers })
  const lock = new IncidentTabLock(incidentLockName(ID), noop, browser.client('a'), answers)
  lock.start()
  cleanups.push(() => { lock.stop(); selection.dispose() })
  await pass(0)
  const engine = selection.current as WorkspaceSync
  return {
    engine,
    edit: (reportMeta: Record<string, string>) => engine.save({ ...engine.workspace, reportMeta: { ...(engine.workspace.reportMeta as object), ...reportMeta } }),
  }
}

/** Tab B: opens the Einsatz behind A, then mounts App's lock and the view's sync hook. */
async function behind() {
  const selection = new IncidentSelection()
  const opts = { debounceMs: DEBOUNCE_MS }
  await selection.open(ID, meta, opts)
  cleanups.push(() => selection.dispose())
  const view = renderHook(() => {
    const [sync, setSync] = useState(() => selection.current as WorkspaceSync)
    // App · reopenTakenOver: a granted lock whose engine followed opens the Einsatz afresh
    const reopen = useCallback((id: string) => {
      if ((selection.opening ?? id) !== id || selection.current?.incidentId !== id || !selection.current.lockLost) return false
      void selection.open(id, meta, opts).then(() => setSync(selection.current as WorkspaceSync))
      return true
    }, [])
    const lock = useIncidentTabLock(ID, reopen)
    useIncidentSync({
      sync, readOnly: false, incidentId: ID, buildPayload, applyWorkspace: noop,
      echoOfPull: () => false, flushEvents: noop, flushEventsBeacon: noop, lockHeldAtOpen: lock.heldAtOpen === true,
    })
    return { sync, lock }
  })
  await pass(50)
  return view
}

beforeEach(() => {
  vi.useFakeTimers()
  browser = new FakeLocks()
  Object.defineProperty(navigator, 'locks', { value: browser.client('b'), configurable: true })
  store.clear()
  setWorkspaceCacheOwner('anna')
  get.mockReset().mockResolvedValue({ workspace: {}, workspace_rev: 1 })
  put.mockReset().mockResolvedValue({ workspace: null, workspace_rev: 2 })
})
afterEach(() => {
  cleanup()
  for (const done of cleanups.splice(0)) done()
  Reflect.deleteProperty(navigator, 'locks')
  vi.useRealTimers()
  setWorkspaceCacheOwner(null)
})

it('«Hier bearbeiten» sends the draft the holder left unsent, within the push debounce', async () => {
  const a = await holder()
  a.edit({ remarks: 'from A' })
  await pass(CACHE_DEBOUNCE_MS + 50) // in the slot; A's push still waits for its debounce
  expect(slot()).toMatchObject({ dirty: true })
  const b = await behind() // B's first engine holds a copy of that draft
  const follower = b.result.current.sync
  expect(b.result.current.lock.held).toBe(false)
  act(() => b.result.current.lock.takeOver())
  await pass(50)
  const fresh = b.result.current.sync
  expect([b.result.current.lock.held, fresh.lockLost, fresh === follower]).toEqual([true, false, false])
  await pass(DEBOUNCE_MS)
  expect(putsBy(fresh).map((c) => c[1])).toEqual([{ reportMeta: { remarks: 'from A' } }])
  await pass(70_000)
  expect(put).toHaveBeenCalledOnce() // nothing from A, nothing from B's first engine

})

it('a tab behind the holder that never takes over sends nothing', async () => {
  const a = await holder()
  a.edit({ remarks: 'from A' })
  await pass(CACHE_DEBOUNCE_MS + 50)
  put.mockRejectedValue(new Error('offline')) // A's draft stays dirty in the slot
  await pass(DEBOUNCE_MS)
  const b = await behind()
  await pass(70_000)
  expect(b.result.current.lock.held).toBe(false)
  expect(putsBy(b.result.current.sync)).toEqual([])
})

it('a takeover over a clean slot sends nothing', async () => {
  const a = await holder()
  a.edit({ remarks: 'from A' })
  await pass(DEBOUNCE_MS + CACHE_DEBOUNCE_MS + 50) // pushed, acknowledged, cached: the slot is clean
  expect(slot()).toMatchObject({ dirty: false })
  const b = await behind()
  act(() => b.result.current.lock.takeOver())
  await pass(70_000)
  expect(b.result.current.lock.held).toBe(true)
  expect(put).toHaveBeenCalledOnce() // A's own push
})

it('a takeover while the server is ahead sends the merged draft once', async () => {
  const a = await holder()
  const b = await behind()
  a.edit({ remarks: 'from A' })
  await pass(CACHE_DEBOUNCE_MS + 50)
  get.mockResolvedValue({ workspace: { reportMeta: { summary: 'from another device' } }, workspace_rev: 5 })
  act(() => b.result.current.lock.takeOver())
  await pass(50)
  await pass(70_000)
  const fresh = b.result.current.sync
  expect(putsBy(fresh).map((c) => [c[1].reportMeta, c[2]])).toEqual([[{ remarks: 'from A', summary: 'from another device' }, 5]]) // on the server's rev
})

it('an edit right after the takeover goes in the same push', async () => {
  const a = await holder()
  const b = await behind()
  a.edit({ remarks: 'from A' })
  await pass(CACHE_DEBOUNCE_MS + 50)
  act(() => b.result.current.lock.takeOver())
  await pass(50)
  const fresh = b.result.current.sync
  fresh.save({ ...fresh.workspace, reportMeta: { ...(fresh.workspace.reportMeta as object), summary: 'from B' } })
  await pass(70_000)
  expect(putsBy(fresh).map((c) => c[1])).toEqual([{ reportMeta: { remarks: 'from A', summary: 'from B' } }])
})
