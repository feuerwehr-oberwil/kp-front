// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ui', () => ({ toast: vi.fn() }))

import { useVoiceMemo } from './useVoiceMemo'
import { toast } from './ui'
import { appConfig } from '../config/appConfig'

afterEach(() => { vi.clearAllMocks(); delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder })

describe('useVoiceMemo — the mic is released whatever fails', () => {
  it('stops the granted tracks when the recorder itself cannot start, and says so (not «verweigert»)', async () => {
    const track = { stop: vi.fn() }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
    })
    ;(globalThis as { MediaRecorder?: unknown }).MediaRecorder = class { constructor() { throw new Error('NotSupportedError') } }

    const { result } = renderHook(() => useVoiceMemo(() => {}))
    await act(() => result.current.start())

    expect(track.stop).toHaveBeenCalledTimes(1) // iOS' orange mic dot goes out
    expect(toast).toHaveBeenCalledWith(appConfig.copy.toast.micFailed, expect.anything())
    expect(result.current.recording).toBe(false)
  })

  it('a refused mic still reads as «verweigert»', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => { throw new Error('NotAllowedError') }) },
    })
    const { result } = renderHook(() => useVoiceMemo(() => {}))
    await act(() => result.current.start())
    expect(toast).toHaveBeenCalledWith(appConfig.copy.toast.micDenied, expect.anything())
  })
})
