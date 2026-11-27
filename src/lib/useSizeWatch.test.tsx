// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSizeWatch } from './useSizeWatch'

/** ResizeObserver stand-in: each instance, what it watches, and whether it was let go */
const made: { observed: Element[]; cb: () => void; gone: boolean }[] = []
class FakeRO {
  me: (typeof made)[number]
  constructor(cb: () => void) { this.me = { observed: [], cb, gone: false }; made.push(this.me) }
  observe(el: Element) { this.me.observed.push(el) }
  disconnect() { this.me.gone = true }
}
beforeEach(() => { made.length = 0; vi.stubGlobal('ResizeObserver', FakeRO) })
afterEach(() => { vi.unstubAllGlobals() })

describe('useSizeWatch', () => {
  const a = document.createElement('div'), b = document.createElement('div')

  it('watches the targets, reports a size change, and keeps ONE observer while the list stays', () => {
    const changed = vi.fn()
    const hook = renderHook(({ els }) => useSizeWatch(() => els, changed), { initialProps: { els: [a] } })
    hook.rerender({ els: [a] })
    expect(made).toHaveLength(1)
    expect(made[0].observed).toEqual([a])
    made[0].cb()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('a target that comes gets a fresh observer (the old one let go); the latest `changed` is called', () => {
    const first = vi.fn(), second = vi.fn()
    const hook = renderHook(({ els, changed }) => useSizeWatch(() => els, changed), { initialProps: { els: [a], changed: first } })
    hook.rerender({ els: [a, b], changed: second })
    expect(made).toHaveLength(2)
    expect(made[0].gone).toBe(true)
    expect(made[1].observed).toEqual([a, b])
    made[1].cb()
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1])
  })

  it('lets go on unmount', () => {
    const hook = renderHook(() => useSizeWatch(() => [a], () => {}))
    hook.unmount()
    expect(made[0].gone).toBe(true)
  })
})
