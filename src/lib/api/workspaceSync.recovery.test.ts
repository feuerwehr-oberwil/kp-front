import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Workspace } from './workspace'

const state = vi.hoisted(() => ({ store: new Map<string, unknown>(), failMain: false, failClear: false, unread: '' }))
const beforeRead = vi.hoisted(() => vi.fn<() => Promise<void>>())
const cleanup = vi.hoisted(() => vi.fn<(key: string, operation: 'set' | 'delete') => Promise<void>>())
const withTileEviction = vi.hoisted(() => vi.fn((write: () => Promise<boolean>) => write()))
const get = vi.hoisted(() => vi.fn())
const put = vi.hoisted(() => vi.fn())
vi.mock('./workspace', () => ({
  getWorkspace: get, putWorkspace: put,
  putWorkspaceRecord: vi.fn(), putWorkspaceRecordBeacon: vi.fn(),
  putWorkspaceTrupps: vi.fn(), putWorkspaceTruppsBeacon: vi.fn(),
}))
vi.mock('../idb', () => ({
  idbGet: async (key: string) => structuredClone(state.store.get(key) ?? null),
  idbRead: async (key: string) => {
    await beforeRead()
    return key === state.unread ? { ok: false, error: new Error('read failed') } : { ok: true, value: structuredClone(state.store.get(key) ?? null) }
  },
  idbSet: async (key: string, value: unknown) => {
    if (key === 'kp-front-ws-i1' && state.failMain) return false
    if (key.endsWith('::__refused__') && state.failClear) return false
    state.store.set(key, structuredClone(value))
    if (Array.isArray(value) && !value.length) await cleanup(key, 'set')
    return true
  },
  idbDel: async (key: string) => { state.store.delete(key); await cleanup(key, 'delete') },
  idbKeys: async (prefix: string) => ({ ok: true, value: [...state.store.keys()].filter((k) => k.startsWith(prefix)) }),
}))
vi.mock('../tileEvict', () => ({ withTileEviction }))
import { ApiError } from '../api'
import { CACHE_DEBOUNCE_MS, SLOT_PROBE_MS, denyWorkspaceCache, setWorkspaceCacheOwner, WorkspaceSync } from './workspaceSync'

beforeEach(() => {
  state.store.clear(); state.failMain = false; state.failClear = false
  state.unread = ''
  setWorkspaceCacheOwner('anna')
  get.mockReset(); put.mockReset(); cleanup.mockReset(); beforeRead.mockReset()
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

function gate() {
  let open!: () => void
  const wait = new Promise<void>((resolve) => { open = resolve })
  return { wait, open }
}

const main = 'kp-front-ws-i1'
const remote = { id: 'B', name: 'remote-only' }
const local = { id: 'A', name: 'local' }
const latest = { id: 'C', name: 'latest edit' }
const successorEdit = { id: 'X', name: 'successor edit' }

it('does not retry a disposed cache write after the same account reopens the incident', async () => {
  get.mockResolvedValue({ workspace: { cameraViews: [] }, workspace_rev: 7 })
  const old = new WorkspaceSync('i1')
  await old.init()
  old.save({ cameraViews: [local] })
  const failed = gate(), spaceFreed = gate(), finished = gate()
  withTileEviction.mockImplementationOnce(async (write) => {
    expect(await write()).toBe(false)
    failed.open()
    await spaceFreed.wait
    const stored = await write()
    finished.open()
    return stored
  })
  state.failMain = true
  old.dispose()
  await failed.wait
  state.failMain = false
  const reopened = new WorkspaceSync('i1')
  try {
    await reopened.init()
    reopened.save({ cameraViews: [successorEdit] })
    reopened.flushKeepalive()
    spaceFreed.open()
    await finished.wait
    expect(state.store.get(main)).toMatchObject({ dirty: true, workspace: { cameraViews: [successorEdit] } })
  } finally { reopened.dispose() }
})

it.each(['ack', 'offline'] as const)('reopens the complete conflict edit after owner handover with a late %s', async (reply) => {
  get.mockResolvedValue({ workspace: { cameraViews: [] }, workspace_rev: 7 })
  const apply = vi.fn()
  const merged = vi.fn()
  const rev = vi.fn()
  const anna = new WorkspaceSync('i1', { debounceMs: 60_000, onMerged: merged, onRev: rev })
  await anna.init()
  anna.onApplyMerged = apply
  anna.save({ cameraViews: [local] })
  const started = gate(), finish = gate()
  put.mockRejectedValueOnce(new ApiError(409, 'conflict')).mockImplementationOnce(async () => {
    started.open()
    await finish.wait
    if (reply === 'offline') throw new ApiError(0, 'offline')
    return { workspace_rev: 9 }
  })
  get.mockResolvedValue({ workspace: { cameraViews: [remote] }, workspace_rev: 8 })
  const pending = anna.flush()
  await started.wait
  rev.mockClear()
  anna.save({ cameraViews: [local, { ...latest, name: 'first edit' }, { id: 'temporary' }] })
  anna.save({ cameraViews: [local, latest] })
  if (reply === 'offline') anna.dispose()
  setWorkspaceCacheOwner('ben')
  const ben = new WorkspaceSync('i1')
  expect((await ben.init()).workspace?.cameraViews).toEqual([remote])
  ben.save({ cameraViews: [remote, successorEdit] })
  await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS + 1)
  const benCache = structuredClone(state.store.get(main))
  // A final render of the unmounted/soon-to-be-unmounted old view still calls the save entry point.
  anna.save({ cameraViews: [{ id: 'stale-after-handover' }] })
  expect(state.store.get(main)).toEqual(benCache)
  finish.open()
  await pending
  anna.dispose()
  await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS + 1)
  expect(state.store.get(main)).toEqual(benCache)
  expect(apply).not.toHaveBeenCalled()
  expect(merged).not.toHaveBeenCalled()
  expect(rev).not.toHaveBeenCalled()
  expect(state.store.get(main + '::anna')).toMatchObject({
    dirty: true, baseRev: 8, workspace: { cameraViews: expect.arrayContaining([local, remote, latest]) },
  })
  ben.dispose()

  setWorkspaceCacheOwner('anna')
  if (reply === 'ack') get.mockResolvedValue({ workspace: { cameraViews: [local, remote] }, workspace_rev: 9 })
  const resumed = new WorkspaceSync('i1')
  const opened = await resumed.init()
  expect(opened.workspace?.cameraViews).toHaveLength(3)
  expect(opened.workspace?.cameraViews).toEqual(expect.arrayContaining([local, latest, remote]))
  expect(state.store.get(main + '::ben')).toEqual(benCache)
  resumed.save({ cameraViews: [local, latest, remote, { id: 'next' }] })
  put.mockResolvedValue({ workspace_rev: 10 })
  await resumed.flush()
  expect(put.mock.lastCall?.[1].cameraViews).toEqual(expect.arrayContaining([local, latest, remote, { id: 'next' }]))
  resumed.dispose()
})

it('uses the view at merge time when a later edit undoes an addition made during the conflict GET', async () => {
  get.mockResolvedValue({ workspace: { cameraViews: [] }, workspace_rev: 7 })
  const merged = vi.fn()
  const sync = new WorkspaceSync('i1', { onMerged: merged })
  try {
    await sync.init()
    const apply = vi.fn()
    sync.onApplyMerged = apply
    sync.save({ cameraViews: [local] })
    const transient = { id: 'T', name: 'temporary' }
    get.mockImplementationOnce(async () => {
      sync.save({ cameraViews: [local, transient] })
      return { workspace: { cameraViews: [remote] }, workspace_rev: 8 }
    })
    put.mockRejectedValueOnce(new ApiError(409, 'conflict')).mockImplementationOnce(async () => {
      sync.save({ cameraViews: [local, latest] })
      return { workspace_rev: 9 }
    }).mockResolvedValue({ workspace_rev: 10 })
    await sync.flush()
    expect(put).toHaveBeenCalledTimes(3)
    expect(put.mock.calls[1][1].cameraViews).toContainEqual(transient)
    const sent = put.mock.calls[2][1].cameraViews
    expect(sent).toHaveLength(3)
    expect(sent).toEqual(expect.arrayContaining([local, latest, remote]))
    expect(apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cameraViews: sent }), 9)
    expect(merged).toHaveBeenCalledTimes(1)
    expect(sync.syncStatus).toBe('synced')
  } finally { sync.dispose() }
})

it.each(['set', 'delete'] as const)('keeps the successor cache and transfer marker after the final refused-slot %s', async (op) => {
  park()
  const slot = op === 'delete' ? refusedKey + ':123' : refusedKey
  if (slot !== refusedKey) {
    state.store.set(slot, state.store.get(refusedKey))
    state.store.delete(refusedKey)
  }
  const started = gate(), finish = gate()
  cleanup.mockImplementation(async (key, operation) => {
    if (key === slot && operation === op) { started.open(); await finish.wait }
  })
  const anna = new WorkspaceSync('i1')
  await anna.init()
  const transfer = anna.requeueRefused()
  await started.wait
  expect(state.store.get(main)).toMatchObject({ owner: 'anna', requeuedRefused: [123] })
  if (op === 'delete') anna.dispose()
  else setWorkspaceCacheOwner('ben')
  const successor = new WorkspaceSync('i1')
  await successor.init()
  successor.save({ cameraViews: [successorEdit] })
  await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS + 1)
  const successorCache = structuredClone(state.store.get(main))
  finish.open()
  await transfer
  await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS + 1)
  expect(state.store.get(main)).toEqual(successorCache)
  expect(put).not.toHaveBeenCalled()
  const markerKey = op === 'delete' ? main : main + '::anna'
  expect(state.store.get(markerKey)).toMatchObject({ owner: 'anna', requeuedRefused: [123] })
  anna.dispose()
  successor.dispose()
  const reopened = new WorkspaceSync('i1')
  expect((await reopened.init()).workspace?.cameraViews).toEqual([successorEdit])
  reopened.dispose()
})

it('parks the final debounced edit before a handover and ignores new saves from the old view', async () => {
  get.mockResolvedValue({ workspace: { cameraViews: [] }, workspace_rev: 7 })
  const anna = new WorkspaceSync('i1', { debounceMs: 60_000 })
  await anna.init()
  anna.save({ cameraViews: [latest] })
  setWorkspaceCacheOwner('ben')
  const ben = new WorkspaceSync('i1', { debounceMs: 60_000 })
  await ben.init()
  ben.save({ cameraViews: [successorEdit] })
  ben.flushKeepalive()
  anna.save({ cameraViews: [{ id: 'stale-after-handover' }] })
  await vi.advanceTimersByTimeAsync(CACHE_DEBOUNCE_MS + 1)
  expect(state.store.get(main)).toMatchObject({ owner: 'ben', workspace: { cameraViews: [successorEdit] } })
  expect(state.store.get(main + '::anna')).toMatchObject({ owner: 'anna', workspace: { cameraViews: [latest] } })
  ben.dispose()

  // Returning to the same account opens a new engine. The delayed old view stays retired.
  setWorkspaceCacheOwner('anna')
  const returned = new WorkspaceSync('i1')
  expect((await returned.init()).workspace?.cameraViews).toEqual([latest])
  returned.save({ cameraViews: [local, latest] })
  returned.flushKeepalive()
  anna.save({ cameraViews: [{ id: 'stale-after-return' }] })
  anna.dispose()
  expect(state.store.get(main)).toMatchObject({ owner: 'anna', workspace: { cameraViews: [local, latest] } })
  returned.dispose()
})

it.each([false, true])('never adopts the successor’s dirty records through an old unread-slot timer (read already started: %s)', async (inFlight) => {
  state.unread = main
  get.mockResolvedValue({ workspace: { cameraViews: [] }, workspace_rev: 7 })
  const anna = new WorkspaceSync('i1', { debounceMs: 60_000 })
  const apply = vi.fn()
  anna.onApplyMerged = apply
  await anna.init()
  expect(anna.syncStatus).toBe('storage')
  state.unread = ''
  const started = gate(), finish = gate()
  if (inFlight) {
    beforeRead.mockImplementationOnce(async () => { started.open(); await finish.wait })
    await vi.advanceTimersByTimeAsync(SLOT_PROBE_MS)
    await started.wait
  }
  setWorkspaceCacheOwner('ben')
  const ben = new WorkspaceSync('i1', { debounceMs: 60_000 })
  await ben.init()
  ben.save({ cameraViews: [successorEdit] })
  ben.flushKeepalive()
  finish.open()
  await vi.advanceTimersByTimeAsync(SLOT_PROBE_MS + CACHE_DEBOUNCE_MS)
  expect(apply).not.toHaveBeenCalled()
  expect(state.store.get(main)).toMatchObject({ owner: 'ben', workspace: { cameraViews: [successorEdit] } })
  expect(anna.workspace.cameraViews).toEqual([])
  anna.dispose()
  ben.dispose()
})

it('keeps accepting local edits while the offline session has no settled owner', async () => {
  setWorkspaceCacheOwner(null)
  state.store.set(main, { workspace: { cameraViews: [local] }, baseRev: 7, dirty: true, owner: 'anna' })
  get.mockRejectedValue(new ApiError(0, 'offline'))
  const offline = new WorkspaceSync('i1')
  expect((await offline.init()).workspace?.cameraViews).toEqual([local])
  offline.save({ cameraViews: [local, latest] })
  offline.dispose()
  expect(state.store.get(main)).toMatchObject({ owner: 'anna', workspace: { cameraViews: [local, latest] } })
})
