// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { appConfig } from '../config/appConfig'

const { armOnAnyTap, uninstall, toast } = vi.hoisted(() => {
  const uninstall = vi.fn()
  return { uninstall, armOnAnyTap: vi.fn((_onArmed: () => void) => uninstall), toast: vi.fn() }
})
vi.mock('./alarm', () => ({ armOnAnyTap }))
vi.mock('./ui', () => ({ toast }))
const { useArmOnAnyTap } = await import('./useArmOnAnyTap')

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
})
