// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'
import { resetLayers, useBackLayer } from './overlays/layer'

const { armOnAnyTap, uninstall, toast } = vi.hoisted(() => {
  const uninstall = vi.fn()
  return { uninstall, armOnAnyTap: vi.fn((_onArmed: () => void) => uninstall), toast: vi.fn() }
})
vi.mock('./alarm', () => ({ armOnAnyTap }))
vi.mock('./ui', () => ({ toast }))
const { useArmOnAnyTap } = await import('./useArmOnAnyTap')

afterEach(() => { armOnAnyTap.mockClear(); toast.mockClear(); resetLayers() })

describe('useArmOnAnyTap', () => {
  it('listens only while somebody is signed in, and says «Alarmton an» when the tone is armed', () => {
    const { rerender, unmount } = renderHook(({ on }) => useArmOnAnyTap(on), { initialProps: { on: false } })
    expect(armOnAnyTap).not.toHaveBeenCalled()
    rerender({ on: true })
    expect(armOnAnyTap).toHaveBeenCalledTimes(1)
    armOnAnyTap.mock.calls[0][0]()
    expect(toast).toHaveBeenCalledWith(appConfig.copy.karte.device.alarm.toneArmed, { icon: 'bell' })
    unmount()
    expect(uninstall).toHaveBeenCalledTimes(1)
  })

  // e2e F8 (PR #752, 25.11.2026): the tap on «Eintrag» armed the tone, and the pill stood over
  // the composer that tap had opened
  it('stays silent while a sheet, the composer or a dialog is open – the tap still armed the tone', () => {
    renderHook(() => useArmOnAnyTap(true))
    const sheet = renderHook(({ open }) => useBackLayer(open, () => {}), { initialProps: { open: true } })
    act(() => armOnAnyTap.mock.calls[0][0]())
    expect(toast).not.toHaveBeenCalled()
    sheet.rerender({ open: false })
    act(() => armOnAnyTap.mock.calls[0][0]())
    expect(toast).toHaveBeenCalledTimes(1)
  })
})
