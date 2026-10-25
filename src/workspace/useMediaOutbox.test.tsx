// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

const queue = vi.hoisted(() => vi.fn((_options: unknown) => ({ syncStatus: 'pending' })))
vi.mock('../lib/useMediaQueue', () => ({ useMediaQueue: queue }))
import { useMediaOutbox, type UseMediaOutboxInputs } from './useMediaOutbox'

it('routes attachment restores and uploads to the Rapport without appending journal patches', () => {
  const swapPhoto = vi.fn(), overlayRow = vi.fn(), patchRow = vi.fn(), swapAttachmentMedia = vi.fn()
  const { result } = renderHook(() => useMediaOutbox({
    swapPhoto, overlayRow, patchRow, swapAttachmentMedia, incidentMeta: { id: 'incident' },
    canWriteRecord: true, closedRefusedTotal: 0, exportedClosedRefused: 0,
    recordsSyncStatus: 'synced', journal: {}, auditDelivery: {},
  } as unknown as UseMediaOutboxInputs))
  const opts = queue.mock.calls[queue.mock.calls.length - 1][0] as {
    onRestore: (id: string, kind: 'photo', url: string, replaces: string, target?: 'attachment') => void
    onUploaded: (id: string, kind: 'photo', url: string, replaces: string, target?: 'attachment') => void
  }
  opts.onRestore('att1', 'photo', 'blob:restored', 'blob:expired', 'attachment')
  opts.onUploaded('att1', 'photo', '/api/media/att1', 'blob:restored', 'attachment')
  expect(swapAttachmentMedia.mock.calls).toEqual([['att1', 'blob:restored'], ['att1', '/api/media/att1']])
  expect(swapPhoto).not.toHaveBeenCalled()
  expect(overlayRow).not.toHaveBeenCalled()
  expect(patchRow).not.toHaveBeenCalled()
  expect(result.current.syncStatus).toBe('pending')
  opts.onUploaded('journal1', 'photo', '/api/media/journal1', 'blob:journal')
  expect(swapPhoto).toHaveBeenCalledWith('journal1', 'blob:journal', '/api/media/journal1')
})
