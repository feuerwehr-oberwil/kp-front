// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
const upload = vi.hoisted(() => vi.fn())
vi.mock('./incidents', () => ({ uploadMedia: upload }))
vi.mock('./idb', () => ({
  idbRead: async (key: string) => ({ ok: true, value: state.store.get(key) ?? null }),
  idbSet: async (key: string, value: unknown) => { state.store.set(key, value); return true },
  idbDel: async (key: string) => { state.store.delete(key) },
}))
vi.mock('./mediaUrl', () => ({ forgetLocalThumb: vi.fn(), mintLocalThumb: async () => {} }))
import { ApiError } from './api'
import { noteAnswered, noteUnreached } from './connectivity'
import { enqueueMedia, listMediaQueue, __resetMediaQueueForTests } from './mediaQueue'
import { incidentLockName, TAB_LOCK_ANSWER_MS, tabLockAnswers } from './tabLock'
import { useMediaQueue } from './useMediaQueue'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); state.store.clear(); __resetMediaQueueForTests() })
it('renders failures without a retry loop, stops after three rejections, and allows explicit retry', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:restored', revokeObjectURL: vi.fn() })
  upload.mockReset().mockRejectedValue(new ApiError(413, 'too large'))
  await enqueueMedia('retry-hook', 'row', 'audio', new Blob(['audio']), 'voice.webm', new Date().toISOString())
  const { result } = renderHook(() => useMediaQueue({ incidentId: 'retry-hook', readOnly: false, onUploaded: () => true, onRestore: () => {} }))
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(upload).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
  expect(upload).toHaveBeenCalledTimes(1)
  // the pauses are 10 s and 20 s, ±10 % jitter
  await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })
  expect(upload).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(24_000) })
  expect(upload).toHaveBeenCalledTimes(3)
  expect(result.current.syncStatus).toBe('error')
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
  expect(upload).toHaveBeenCalledTimes(3)
  upload.mockResolvedValue({ url: '/uploaded' })
  await act(async () => { await result.current.flush({ retry: true }) })
  expect(upload).toHaveBeenCalledTimes(4)
  expect(result.current.pendingCount).toBe(0)
})

it('restores and completes a persisted attachment with its target, then acknowledges its queue', async () => {
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:restored-attachment', revokeObjectURL: vi.fn() })
  upload.mockReset().mockResolvedValue({ url: '/api/media/attachment' })
  await enqueueMedia('attachment-hook', 'att1', 'photo', new Blob(['damage']), 'damage.jpg', '2026-10-25T10:00:00Z', 'blob:previous-session', 'attachment')
  __resetMediaQueueForTests()
  const onRestore = vi.fn(), onUploaded = vi.fn(() => true)
  const { result } = renderHook(() => useMediaQueue({ incidentId: 'attachment-hook', readOnly: false, onUploaded, onRestore }))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(onRestore).toHaveBeenCalledWith('att1', 'photo', 'blob:restored-attachment', 'blob:previous-session', 'attachment', undefined)
  expect(onUploaded).toHaveBeenCalledWith('att1', 'photo', '/api/media/attachment', 'blob:restored-attachment', 'attachment', undefined)
  expect(result.current.pendingCount).toBe(0)
  expect(result.current.syncStatus).toBe('synced')
})

it('keeps a receipt «not saved» until onUploaded acknowledges its link, without calling it a pending capture', async () => {
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:restored', revokeObjectURL: vi.fn() })
  upload.mockReset().mockResolvedValue({ url: '/media/1' })
  await enqueueMedia('receipt-hook', 'row', 'photo', new Blob(['jpg']), 'photo-row', new Date().toISOString(), 'blob:cap')
  let acknowledged = false
  const onUploaded = vi.fn(() => acknowledged)
  const { result } = renderHook(() => useMediaQueue({ incidentId: 'receipt-hook', readOnly: false, onUploaded, onRestore: () => {} }))
  await waitFor(() => expect(result.current.receiptCount).toBe(1))
  // the picture shown since the restore is the one the server copy replaces
  expect(onUploaded).toHaveBeenCalledWith('row', 'photo', '/media/1', 'blob:restored', undefined, undefined)
  expect(result.current).toMatchObject({ pendingCount: 0, syncStatus: 'pending' })
  expect(result.current.statusOf('row')).toBeUndefined()

  acknowledged = true
  await act(async () => { await result.current.replayReceipts() })
  expect(result.current).toMatchObject({ receiptCount: 0, syncStatus: 'synced' })
  expect(upload).toHaveBeenCalledTimes(1)
})

// a dead link backs the pause off to minutes; the first answer from the server ends it at once
it('uploads at once when the server is reachable again, not after the remaining pause', async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:restored', revokeObjectURL: vi.fn() })
  upload.mockReset().mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
  await enqueueMedia('cellar-hook', 'row', 'audio', new Blob(['audio']), 'voice.webm', new Date().toISOString())
  const { result } = renderHook(() => useMediaQueue({ incidentId: 'cellar-hook', readOnly: false, onUploaded: () => true, onRestore: () => {} }))
  // tries at 0, 5, 15, 35, 75, 155 s: the next pause is 160 s
  for (let s = 0; s < 32; s++) await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  expect(upload).toHaveBeenCalledTimes(6)
  upload.mockResolvedValue({ url: '/uploaded' })
  noteUnreached()
  act(() => { noteAnswered() })
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(upload).toHaveBeenCalledTimes(7)
  expect(result.current.pendingCount).toBe(0)
})

it('uploads at once on the `online` event, not after the remaining pause', async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:restored', revokeObjectURL: vi.fn() })
  upload.mockReset().mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
  await enqueueMedia('online-hook', 'row', 'audio', new Blob(['audio']), 'voice.webm', new Date().toISOString())
  const { result } = renderHook(() => useMediaQueue({ incidentId: 'online-hook', readOnly: false, onUploaded: () => true, onRestore: () => {} }))
  for (let s = 0; s < 32; s++) await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  expect(upload).toHaveBeenCalledTimes(6)
  upload.mockResolvedValue({ url: '/uploaded' })
  act(() => { window.dispatchEvent(new Event('online')) })
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(upload).toHaveBeenCalledTimes(7)
  expect(result.current.pendingCount).toBe(0)
})

// one recovery signal while the capture's last early try is under a minute old is held, not lost
it('a recovery signal during the early-try spacing gets its try when the spacing ends', async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:restored', revokeObjectURL: vi.fn() })
  upload.mockReset().mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
  await enqueueMedia('spacing-hook', 'row', 'audio', new Blob(['audio']), 'voice.webm', new Date().toISOString())
  const { result } = renderHook(() => useMediaQueue({ incidentId: 'spacing-hook', readOnly: false, onUploaded: () => true, onRestore: () => {} }))
  for (let s = 0; s < 32; s++) await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  expect(upload).toHaveBeenCalledTimes(6)
  noteUnreached()
  act(() => { noteAnswered() }) // the early try, missed: the next pause is 5 min
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(upload).toHaveBeenCalledTimes(7)
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
  upload.mockResolvedValue({ url: '/uploaded' })
  noteUnreached()
  act(() => { noteAnswered() }) // the link is back – but the last early try is 20 s old
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(upload).toHaveBeenCalledTimes(7)
  await act(async () => { await vi.advanceTimersByTimeAsync(38_000) })
  expect(upload).toHaveBeenCalledTimes(7)
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) }) // 60 s after the early try
  expect(upload).toHaveBeenCalledTimes(8)
  expect(result.current.pendingCount).toBe(0)
})

// one signal, a bounded number of uploads: the held try must not count as a fresh signal
it('two waiting captures do not hand each other an early try a minute after one recovery signal', async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:restored', revokeObjectURL: vi.fn() })
  upload.mockReset().mockRejectedValue(new ApiError(0, 'Netzwerkfehler'))
  await enqueueMedia('pair-hook', 'a', 'audio', new Blob(['a']), 'a.webm', new Date().toISOString())
  const { result } = renderHook(() => useMediaQueue({ incidentId: 'pair-hook', readOnly: false, onUploaded: () => true, onRestore: () => {} }))
  for (let s = 0; s < 32; s++) await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  noteUnreached()
  act(() => { noteAnswered() }) // T: a's early try, missed – its pause is 5 min from here
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(upload).toHaveBeenCalledTimes(7)
  // T+1 s: b joins and misses at 1, 6, 16 and 36 s; its pause then runs to T+76 s
  await enqueueMedia('pair-hook', 'b', 'audio', new Blob(['b']), 'b.webm', new Date().toISOString())
  await act(async () => { await result.current.flush() })
  for (let s = 0; s < 49; s++) await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  expect(upload).toHaveBeenCalledTimes(11)
  noteUnreached()
  act(() => { noteAnswered() }) // T+50 s, the one signal under test: a is held until T+60 s, b tries early
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(upload).toHaveBeenCalledTimes(12)
  // ten minutes with no further signal
  for (let s = 0; s < 120; s++) await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
  const since = (row: string) => upload.mock.calls.slice(12).filter(([, , , name]) => name === `${row}.webm`).length
  // a: its held try at T+60 s, then its 5-min pauses · b: its stored pauses of 80, 160 and 300 s.
  // Handing each other a try, each would go about once a minute: ten times.
  expect(since('a')).toBeLessThanOrEqual(3)
  expect(since('b')).toBeLessThanOrEqual(4)
})

// docs/sync-and-offline.md › Two tabs: the tab that holds the Einsatz's edit lock owns its queue
it.each([
  ['behind the holder', false, 0],
  ['before its lock first answered', undefined, 1],
])('a tab %s uploads nothing and leaves the queue as it is', async (_case, answer, uploadsAfterBound) => {
  vi.useFakeTimers()
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:restored', revokeObjectURL: vi.fn() })
  Object.defineProperty(navigator, 'locks', { value: {}, configurable: true })
  const id = `tab-${String(answer)}`
  tabLockAnswers.set(incidentLockName(id), answer)
  try {
    upload.mockReset().mockResolvedValue({ url: '/media/1' })
    await enqueueMedia(id, 'row', 'photo', new Blob(['jpg']), 'photo-row', new Date().toISOString(), 'blob:cap')
    const queued = await listMediaQueue(id)
    const { result } = renderHook(() => useMediaQueue({ incidentId: id, readOnly: false, onUploaded: () => true, onRestore: () => {} }))
    await act(async () => { void result.current.flush({ retry: true }); await vi.advanceTimersByTimeAsync(TAB_LOCK_ANSWER_MS - 10) })
    expect(upload).not.toHaveBeenCalled()
    expect(await listMediaQueue(id)).toEqual(queued)
    // no answer within the bound: the tab uploads as without Web Locks
    await act(async () => { await vi.advanceTimersByTimeAsync(TAB_LOCK_ANSWER_MS) })
    expect(upload.mock.calls.length > 0 ? 1 : 0).toBe(uploadsAfterBound)
  } finally {
    tabLockAnswers.set(incidentLockName(id), undefined)
    Reflect.deleteProperty(navigator, 'locks')
  }
})

it('a tab that loses the edit lock mid-flush starts no further upload', async () => {
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:restored', revokeObjectURL: vi.fn() })
  Object.defineProperty(navigator, 'locks', { value: {}, configurable: true })
  const id = 'tab-lost'
  tabLockAnswers.set(incidentLockName(id), true)
  try {
    upload.mockReset().mockImplementation(async () => {
      tabLockAnswers.set(incidentLockName(id), false) // another tab took over during this upload
      return { url: '/media/1' }
    })
    await enqueueMedia(id, 'row1', 'photo', new Blob(['a']), 'a.jpg', new Date().toISOString(), 'blob:a')
    await enqueueMedia(id, 'row2', 'photo', new Blob(['b']), 'b.jpg', new Date().toISOString(), 'blob:b')
    const queued = await listMediaQueue(id)
    renderHook(() => useMediaQueue({ incidentId: id, readOnly: false, onUploaded: () => true, onRestore: () => {} }))
    await waitFor(() => expect(upload).toHaveBeenCalledOnce())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(upload).toHaveBeenCalledOnce()
    expect(await listMediaQueue(id)).toEqual(queued) // the new holder's own pass records the queue
  } finally {
    tabLockAnswers.set(incidentLockName(id), undefined)
    Reflect.deleteProperty(navigator, 'locks')
  }
})
