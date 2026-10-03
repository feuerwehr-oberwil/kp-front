// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
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
  const { result } = renderHook(() => useMediaQueue({ incidentId: 'retry-hook', readOnly: false, onUploaded: () => {}, onRestore: () => {} }))
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
