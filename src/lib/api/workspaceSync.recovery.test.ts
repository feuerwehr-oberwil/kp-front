import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Workspace } from './workspace'

const state = vi.hoisted(() => ({ store: new Map<string, unknown>(), failMain: false, failClear: false }))
const get = vi.hoisted(() => vi.fn())
const put = vi.hoisted(() => vi.fn())
vi.mock('./workspace', () => ({
  getWorkspace: get, putWorkspace: put, putWorkspaceBeacon: vi.fn(),
  putWorkspaceRecord: vi.fn(), putWorkspaceRecordBeacon: vi.fn(),
  putWorkspaceTrupps: vi.fn(), putWorkspaceTruppsBeacon: vi.fn(),
}))
vi.mock('../idb', () => ({
  idbGet: async (key: string) => structuredClone(state.store.get(key) ?? null),
  idbRead: async (key: string) => ({ ok: true, value: structuredClone(state.store.get(key) ?? null) }),
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
import { WorkspaceSync } from './workspaceSync'

beforeEach(() => {
  state.store.clear(); state.failMain = false; state.failClear = false
  get.mockReset(); put.mockReset()
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers() })

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
  state.store.set(refusedKey, [{ workspace: { cameraViews: [{ id: 'parked', name: 'original' }] }, base: { cameraViews: [] }, baseRev: 7, refusedAt: 123 }])
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
