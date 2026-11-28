// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSteadyFns } from './useSteadyFns'

describe('useSteadyFns', () => {
  it('keeps one identity across renders and calls the latest function', () => {
    const h = renderHook(({ n }: { n: number }) => useSteadyFns({ get: () => n, maybe: undefined as (() => number) | undefined }), { initialProps: { n: 1 } })
    const first = h.result.current
    h.rerender({ n: 2 })
    expect(h.result.current).toBe(first)
    expect(h.result.current.get()).toBe(2)
    expect(h.result.current.maybe).toBeUndefined()
  })

  it('changes when a handler appears or goes away', () => {
    const h = renderHook(({ on }: { on: boolean }) => useSteadyFns({ maybe: on ? () => 'da' : undefined }), { initialProps: { on: false } })
    const before = h.result.current
    h.rerender({ on: true })
    expect(h.result.current).not.toBe(before)
    expect(h.result.current.maybe?.()).toBe('da')
  })

  it('a wrapper kept after its handler went away does nothing', () => {
    const h = renderHook(({ on }: { on: boolean }) => useSteadyFns({ maybe: on ? () => 'da' : undefined }), { initialProps: { on: true } })
    const kept = h.result.current.maybe
    h.rerender({ on: false })
    expect(kept).toBeTypeOf('function')
    expect(() => kept?.()).not.toThrow()
    expect(kept?.()).toBeUndefined()
  })
})
