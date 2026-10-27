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
import { enqueueMedia, __resetMediaQueueForTests } from './mediaQueue'
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
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
  expect(upload).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
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
  expect(onRestore).toHaveBeenCalledWith('att1', 'photo', 'blob:restored-attachment', 'blob:previous-session', 'attachment')
  expect(onUploaded).toHaveBeenCalledWith('att1', 'photo', '/api/media/attachment', 'blob:restored-attachment', 'attachment')
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
  expect(onUploaded).toHaveBeenCalledWith('row', 'photo', '/media/1', 'blob:restored', undefined)
  expect(result.current).toMatchObject({ pendingCount: 0, syncStatus: 'pending' })
  expect(result.current.statusOf('row')).toBeUndefined()

  acknowledged = true
  await act(async () => { await result.current.replayReceipts() })
  expect(result.current).toMatchObject({ receiptCount: 0, syncStatus: 'synced' })
  expect(upload).toHaveBeenCalledTimes(1)
})
