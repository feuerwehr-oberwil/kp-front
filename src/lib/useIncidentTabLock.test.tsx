// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useIncidentTabLock } from './tabLock'
import { FakeLocks } from './webLocks.test-utils'

beforeEach(() => { Object.defineProperty(navigator, 'locks', { value: new FakeLocks(), configurable: true }) })
afterEach(() => { cleanup(); Reflect.deleteProperty(navigator, 'locks') })

it('says each grant of the lock – where the App reopens an Einsatz a tab took over', async () => {
  const first = renderHook(() => useIncidentTabLock('e1'))
  await waitFor(() => expect(first.result.current.heldAtOpen).toBe(true))
  const onHeld = vi.fn()
  const second = renderHook(() => useIncidentTabLock('e1', onHeld))
  await waitFor(() => expect(second.result.current.held).toBe(false))
  expect(onHeld).not.toHaveBeenCalled()
  act(() => first.unmount()) // the holder closes
  await waitFor(() => expect(onHeld).toHaveBeenCalledWith('e1'))
  expect(second.result.current.held).toBe(true)
})
