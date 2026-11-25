// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'

vi.mock('./ui', () => ({ toast: vi.fn(), undoToast: vi.fn() }))
vi.mock('./mediaUrl', () => ({ forgetLocalThumb: vi.fn(), mintLocalThumb: async () => {} }))
vi.mock('./imagePrep', () => ({ prepareUploadImage: async (blob: Blob) => blob }))
import { undoToast } from './ui'
import { useRowMediaUpload } from './useRowMediaUpload'
import type { ReportAttachment } from '../types'

// The Rapport-Beilagen half of the row-media hook (moved out of IncidentWorkspace 23.09.2026). What
// matters across the move: the one-shot pusher is read through the REF OBJECT at call time (the
// workspace assigns it after the hook ran), and a typed Bildlegende is ONE step.
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

function setup(rows: ReportAttachment[]) {
  const pushed: { label: string; restore: () => void; reapply: () => void; drop: ReturnType<typeof vi.fn> }[] = []
  const rememberOneShotRef = { current: (() => () => {}) as (d: never, l: string, r: () => void, a: () => void) => () => void }
  const lastCaptionStepRef = { current: null }
  const emit = vi.fn()
  const media = { enqueue: vi.fn().mockResolvedValue(true), flush: vi.fn().mockResolvedValue(undefined) }
  const hook = renderHook(() => {
    const [attachments, setAttachments] = useState(rows)
    const api = useRowMediaUpload({
      canWriteRecord: true, media: media as never, attachments, setAttachments, emit,
      rememberOneShotRef: rememberOneShotRef as never, lastCaptionStepRef,
    })
    return { attachments, ...api }
  })
  // assigned AFTER the hook ran, exactly as the workspace does
  rememberOneShotRef.current = (_d, label, restore, reapply) => {
    const drop = vi.fn(); pushed.push({ label, restore, reapply, drop }); return drop
  }
  return { hook, pushed, emit, media }
}

describe('useRowMediaUpload · Beilagen', () => {
  const row: ReportAttachment = { id: 'a1', url: 'https://x/1.jpg', at: '2026-09-23T10:00:00Z' }

  it('persists attachment bytes in the media outbox before asking it to upload', async () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:attachment', revokeObjectURL: vi.fn() })
    const { hook, media } = setup([])
    const file = new File(['damage photo'], 'damage.jpg', { type: 'image/jpeg' })
    await act(async () => { hook.result.current.addAttachments([file]) })
    const attachment = hook.result.current.attachments[0]
    expect(attachment.url).toBe('blob:attachment')
    expect(media.enqueue).toHaveBeenCalledWith(attachment.id, 'photo', file, 'damage.jpg', attachment.at, 'blob:attachment', 'attachment')
    expect(media.flush).toHaveBeenCalledOnce()
    expect(media.enqueue.mock.invocationCallOrder[0]).toBeLessThan(media.flush.mock.invocationCallOrder[0])
  })

  it('upload completion keeps the current caption and an undo restores its server URL', async () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:attachment', revokeObjectURL: vi.fn() })
    const { hook, pushed } = setup([])
    await act(async () => { hook.result.current.addAttachments([new File(['photo'], 'photo.jpg')]) })
    const id = hook.result.current.attachments[0].id
    act(() => hook.result.current.captionAttachment(id, 'Damage to kitchen'))
    act(() => pushed[0].restore()) // undo the add before the upload finishes
    act(() => hook.result.current.swapAttachmentMedia(id, '/api/media/attachment'))
    expect(hook.result.current.attachments).toEqual([]) // never resurrect a removed attachment
    act(() => pushed[0].reapply())
    expect(hook.result.current.attachments[0]).toMatchObject({ url: '/api/media/attachment', caption: 'Damage to kitchen' })
  })

  it('a pending attachment restored after reload replaces only its URL', () => {
    const { hook } = setup([{ ...row, url: 'blob:dead-session', caption: 'Kitchen' }])
    act(() => hook.result.current.swapAttachmentMedia('a1', 'blob:restored'))
    expect(hook.result.current.attachments[0]).toMatchObject({ url: 'blob:restored', caption: 'Kitchen' })
    act(() => hook.result.current.swapAttachmentMedia('a1', '/api/media/attachment'))
    expect(hook.result.current.attachments[0]).toMatchObject({ url: '/api/media/attachment', caption: 'Kitchen' })
    act(() => hook.result.current.swapAttachmentMedia('removed', '/api/media/unused'))
    expect(hook.result.current.attachments).toHaveLength(1)
  })

  it('removing a pending attachment still undoes to its uploaded URL', () => {
    const { hook, pushed } = setup([{ ...row, url: 'blob:pending', caption: 'Kitchen' }])
    act(() => hook.result.current.removeAttachment('a1'))
    act(() => hook.result.current.swapAttachmentMedia('a1', '/api/media/uploaded'))
    expect(hook.result.current.attachments).toEqual([])
    act(() => pushed[0].restore())
    expect(hook.result.current.attachments[0]).toMatchObject({ url: '/api/media/uploaded', caption: 'Kitchen' })
  })

  it('a typed Bildlegende folds into ONE step that restores the caption it started from', () => {
    const { hook, pushed } = setup([{ ...row, caption: 'Alt' }])
    act(() => hook.result.current.captionAttachment('a1', 'N'))
    act(() => hook.result.current.captionAttachment('a1', 'Ne'))
    act(() => hook.result.current.captionAttachment('a1', 'Neu'))
    expect(hook.result.current.attachments[0].caption).toBe('Neu')
    // every keystroke drops the standing step and lays a wider one: one live step at the end
    expect(pushed.filter((p) => p.drop.mock.calls.length === 0)).toHaveLength(1)
    act(() => pushed[pushed.length - 1].restore())
    expect(hook.result.current.attachments[0].caption).toBe('Alt')
  })

  // owner pick 28 (17.11.2026): the removal is one ↶ step, and no toast doubles it
  it('remove is one ↶ step that restores at the same index, with no toast', () => {
    const { hook, pushed } = setup([row, { ...row, id: 'a2' }, { ...row, id: 'a3' }])
    act(() => hook.result.current.removeAttachment('a2'))
    expect(hook.result.current.attachments.map((a) => a.id)).toEqual(['a1', 'a3'])
    expect(pushed).toHaveLength(1)
    expect(undoToast).not.toHaveBeenCalled()
    act(() => pushed[0].restore())
    expect(hook.result.current.attachments.map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
  })
})

// offline-sync F2 (hunt 24.11.2026): a Verlauf capture is stored BEFORE its upload is asked for —
// the bytes used to reach the queue only once the upload had failed, so a tab killed during a slow
// upload kept the row without its picture or voice memo.
describe('useRowMediaUpload · Verlauf captures', () => {
  it.each([
    ['photo', (api: ReturnType<typeof useRowMediaUpload>) => api.uploadPhotoForRow('r1', 'blob:shot', 1), ['r1', 'photo', expect.any(Blob), 'photo-r1', expect.any(String), 'blob:shot', undefined, undefined, 1]],
    ['voice memo', (api: ReturnType<typeof useRowMediaUpload>) => api.uploadAudioForRow('r1', 'blob:memo'), ['r1', 'audio', expect.any(Blob), 'audio-r1', expect.any(String), undefined, undefined, undefined, undefined]],
  ] as const)('a %s is queued durably first, then sent through the queue', async (_kind, capture, args) => {
    vi.stubGlobal('fetch', async () => ({ blob: async () => new Blob(['bytes']) }))
    const { hook, media } = setup([])
    // the store answers only when we say so: the upload must not be asked for before it has
    let stored!: (ok: boolean) => void
    media.enqueue.mockImplementationOnce(() => new Promise<boolean>((res) => { stored = res }))
    let done!: Promise<unknown>
    await act(async () => { done = Promise.resolve(capture(hook.result.current)) })
    expect(media.enqueue).toHaveBeenCalledWith(...args)
    expect(media.flush).not.toHaveBeenCalled()
    await act(async () => { stored(true); await done })
    expect(media.flush).toHaveBeenCalled()
  })
})
