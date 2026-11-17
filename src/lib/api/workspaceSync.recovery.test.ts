import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Workspace } from './workspace'

const state = vi.hoisted(() => ({ store: new Map<string, unknown>(), failMain: false, failClear: false, unread: '' }))
const get = vi.hoisted(() => vi.fn())
const put = vi.hoisted(() => vi.fn())
vi.mock('./workspace', () => ({
  getWorkspace: get, putWorkspace: put,
  putWorkspaceRecord: vi.fn(), putWorkspaceRecordBeacon: vi.fn(),
  putWorkspaceTrupps: vi.fn(), putWorkspaceTruppsBeacon: vi.fn(),
}))
vi.mock('../idb', () => ({
  idbGet: async (key: string) => structuredClone(state.store.get(key) ?? null),
  idbRead: async (key: string) => key === state.unread ? { ok: false, error: new Error('read failed') } : { ok: true, value: structuredClone(state.store.get(key) ?? null) },
  idbSet: async (key: string, value: unknown) => {
    if (key === 'kp-front-ws-i1' && state.failMain) return false
    if (key.endsWith('::__refused__') && state.failClear) return false
    state.store.set(key, structuredClone(value)); return true
  },
  idbDel: async (key: string) => { state.store.delete(key) },
  idbKeys: async (prefix: string) => ({ ok: true, value: [...state.store.keys()].filter((k) => k.startsWith(prefix)) }),
}))
vi.mock('../tileEvict', () => ({ withTileEviction: (fn: () => Promise<boolean>) => fn() }))
import { ApiError } from '../api'
import { denyWorkspaceCache, setWorkspaceCacheOwner, WorkspaceSync } from './workspaceSync'

beforeEach(() => {
  state.store.clear(); state.failMain = false; state.failClear = false
  state.unread = ''
  setWorkspaceCacheOwner('anna')
  get.mockReset(); put.mockReset()
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers(); setWorkspaceCacheOwner(null) })

it.each([false, true])('keeps remote additions after a merge upload fails (edit during upload: %s)', async (during) => {
  get.mockResolvedValue({ workspace: { cameraViews: [] }, workspace_rev: 7 })
  const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
  let view: Workspace = { cameraViews: [{ id: 'local-1' }] }
  try {
    await sync.init()
    sync.onApplyMerged = (ws) => { view = ws }
    sync.save(view)
    get.mockResolvedValue({ workspace: { cameraViews: [{ id: 'remote' }] }, workspace_rev: 8 })
    put.mockRejectedValueOnce(new ApiError(409, 'conflict')).mockImplementationOnce(async () => {
      if (during) sync.save({ cameraViews: [{ id: 'local-1' }, { id: 'during' }] })
      throw new ApiError(0, 'offline')
    })
    await sync.flush()
    expect(sync.syncStatus).toBe('offline')
    expect(view.cameraViews).toContainEqual({ id: 'remote' })
    if (during) expect(view.cameraViews).toContainEqual({ id: 'during' })
    sync.save({ ...view, cameraViews: [...view.cameraViews as object[], { id: 'local-2' }] })
    put.mockResolvedValue({ workspace_rev: 9 })
    await sync.flush()
    expect(put.mock.lastCall?.[1].cameraViews).toContainEqual({ id: 'remote' })
    expect(sync.syncStatus).toBe('synced')
  } finally { sync.dispose() }
})

const refusedKey = 'kp-front-ws-i1::__refused__'
function park() {
  state.store.set(refusedKey, [{ workspace: { cameraViews: [{ id: 'parked', name: 'original' }] }, base: { cameraViews: [] }, baseRev: 7, owner: 'anna', refusedAt: 123 }])
  get.mockResolvedValue({ workspace: { cameraViews: [] }, workspace_rev: 8 })
  put.mockRejectedValue(new ApiError(0, 'offline'))
}

it('retains refused work if its replacement cache cannot be written', async () => {
  park()
  const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
  try {
    await sync.init()
    state.failMain = true
    await sync.requeueRefused()
    expect(state.store.get(refusedKey)).toEqual([expect.objectContaining({ refusedAt: 123 })])
    expect(sync.syncStatus).toBe('storage')
  } finally { sync.dispose() }
})

it('does not replay a transferred refusal over later edits after a failed clear and reload', async () => {
  park()
  const sync = new WorkspaceSync('i1', { debounceMs: 60_000 })
  await sync.init()
  state.failClear = true
  await sync.requeueRefused()
  sync.save({ cameraViews: [{ id: 'parked', name: 'corrected later' }] })
  sync.dispose()
  await Promise.resolve()
  // Reload offline: the replacement cache and the old refused slot both survived.
  get.mockRejectedValue(new ApiError(0, 'offline'))
  state.failClear = false
  const reopened = new WorkspaceSync('i1', { debounceMs: 60_000 })
  try {
    await reopened.init()
    const apply = vi.fn()
    reopened.onApplyMerged = apply
    await reopened.requeueRefused()
    expect(apply.mock.lastCall?.[0].cameraViews).toEqual([{ id: 'parked', name: 'corrected later' }])
    expect(state.store.get(refusedKey)).toEqual([])
  } finally { reopened.dispose() }
})


it('keeps every parked copy when a fallback read fails, and retries on the same engine', async () => {
  park()
  const fallback = refusedKey + ':456'
  const other = { workspace: { cameraViews: [{ id: 'later' }] }, base: { cameraViews: [] }, baseRev: 7, refusedAt: 456, owner: 'anna' }
  state.store.set(fallback, [other])
  state.unread = fallback
  const sync = new WorkspaceSync('i1')
  try {
    await sync.init()
    await sync.requeueRefused()
    expect(state.store.get(fallback)).toEqual([other])
    state.unread = ''
    await sync.requeueRefused()
    expect(put.mock.lastCall?.[1].cameraViews).toContainEqual({ id: 'later' })
  } finally { sync.dispose() }
})

it('keeps foreign and unattributable drafts private across logout, recovery and replay', async () => {
  park()
  const anna = (state.store.get(refusedKey) as object[])[0]
  const legacy = { ...anna, owner: undefined, refusedAt: 124 }
  const ben = { ...anna, owner: 'ben', refusedAt: 125, workspace: { cameraViews: [{ id: 'ben' }] } }
  state.store.set(refusedKey, [anna, legacy, ben])
  const first = new WorkspaceSync('i1')
  await first.init()
  await first.loadRefused()
  expect(first.refusedRecoveryData()).toEqual([anna])
  denyWorkspaceCache()
  setWorkspaceCacheOwner(null)
  expect(first.refusedRecoveryData()).toEqual([])
  first.dispose()
  setWorkspaceCacheOwner('ben')
  const second = new WorkspaceSync('i1')
  try {
    await second.init()
    await second.loadRefused()
    expect(second.refusedRecoveryData()).toEqual([ben])
    await second.requeueRefused()
    expect(put.mock.lastCall?.[1].cameraViews).toEqual([{ id: 'ben' }])
    expect(state.store.get(refusedKey)).toEqual([anna, legacy])
  } finally { second.dispose() }
})

it('never retries an already transferred draft under a different signed-in account', async () => {
  park()
  const sync = new WorkspaceSync('i1')
  try {
    await sync.init()
    await sync.requeueRefused()
    expect(sync.hasUnsynced).toBe(true)
    expect(put).toHaveBeenCalled()
    put.mockClear()
    setWorkspaceCacheOwner('ben')
    await sync.flush()
    await vi.advanceTimersByTimeAsync(65_000)
    expect(put).not.toHaveBeenCalled()
    expect(sync.hasUnsynced).toBe(true)
  } finally { sync.dispose() }
})

it('a demoted owner keeps a full or unstamped refused draft for export until a full session returns', async () => {
  park()
  const legacy = (state.store.get(refusedKey) as object[])[0]
  const full = { ...legacy, shape: 'all', refusedAt: 124 }
  state.store.set(refusedKey, [legacy, full])
  const el = new WorkspaceSync('i1', { slice: 'record' })
  await el.init()
  await el.loadRefused()
  expect(el.refusedCount).toBe(0)
  expect(el.roleParkedRecoveryData()).toEqual([legacy, full])
  await el.requeueRefused()
  expect(state.store.get(refusedKey)).toEqual([legacy, full])
  el.dispose()
  const editor = new WorkspaceSync('i1')
  try {
    await editor.init()
    await editor.requeueRefused()
    expect(state.store.get(refusedKey)).toEqual([])
    expect(put).toHaveBeenCalled()
  } finally { editor.dispose() }
})
