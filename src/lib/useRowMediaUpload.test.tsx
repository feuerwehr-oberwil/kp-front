// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'

vi.mock('./ui', () => ({ toast: vi.fn(), undoToast: vi.fn() }))
import { undoToast } from './ui'
import { useRowMediaUpload } from './useRowMediaUpload'
import type { ReportAttachment } from '../types'

// The Rapport-Beilagen half of the row-media hook (moved out of IncidentWorkspace 23.09.2026). What
// matters across the move: the one-shot pusher is read through the REF OBJECT at call time (the
// workspace assigns it after the hook ran), and a typed Bildlegende is ONE step.
afterEach(() => { vi.clearAllMocks() })

function setup(rows: ReportAttachment[]) {
  const pushed: { label: string; restore: () => void; reapply: () => void; drop: ReturnType<typeof vi.fn> }[] = []
  const rememberOneShotRef = { current: (() => () => {}) as (d: never, l: string, r: () => void, a: () => void) => () => void }
  const lastCaptionStepRef = { current: null }
  const hook = renderHook(() => {
    const [attachments, setAttachments] = useState(rows)
    const api = useRowMediaUpload({
      incidentMeta: { id: 'inc1' }, canWriteRecord: true, media: { enqueue: vi.fn() } as never,
      swapPhoto: vi.fn(), swapRowMedia: vi.fn(), attachments, setAttachments, emit: vi.fn(),
      rememberOneShotRef: rememberOneShotRef as never, lastCaptionStepRef,
    })
    return { attachments, ...api }
  })
  // assigned AFTER the hook ran, exactly as the workspace does
  rememberOneShotRef.current = (_d, label, restore, reapply) => {
    const drop = vi.fn(); pushed.push({ label, restore, reapply, drop }); return drop
  }
  return { hook, pushed }
}

describe('useRowMediaUpload · Beilagen', () => {
  const row: ReportAttachment = { id: 'a1', url: 'https://x/1.jpg', at: '2026-09-23T10:00:00Z' }

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

  it('remove is confirm-with-undo: the toast restores at the same index and drops the timeline entry', () => {
    const { hook, pushed } = setup([row, { ...row, id: 'a2' }, { ...row, id: 'a3' }])
    act(() => hook.result.current.removeAttachment('a2'))
    expect(hook.result.current.attachments.map((a) => a.id)).toEqual(['a1', 'a3'])
    expect(pushed).toHaveLength(1)
    const undo = vi.mocked(undoToast).mock.calls[0][1]
    act(() => undo())
    expect(hook.result.current.attachments.map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
    expect(pushed[0].drop).toHaveBeenCalledTimes(1)
  })
})
