// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals() })

describe('useHazardData — a table loads when a surface needs it, never on its own', () => {
  it('fetches nothing without a need, then each table as it is needed, and repaints when it lands', async () => {
    vi.resetModules() // the datasets are module state: a fresh pair, not yet loaded
    const { useHazardData } = await import('./useHazardData')
    const asked: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
      const file = String(u).split('/').pop()!
      asked.push(file)
      return new Response(file === 'erg.json' ? '{"version":"2024","un":{}}' : '[]', { status: 200 })
    }))
    let renders = 0
    const { rerender } = renderHook(({ un, erg }) => { renders++; return useHazardData({ un, erg }) }, { initialProps: { un: false, erg: false } })
    rerender({ un: false, erg: false })
    expect(asked).toEqual([])
    expect(renders).toBe(2)

    rerender({ un: true, erg: false })
    await waitFor(() => expect(renders).toBe(4)) // the rerender, then the ADR table's arrival
    expect(asked).toEqual(['un-hazard.json'])

    rerender({ un: true, erg: true })
    await waitFor(() => expect(asked).toEqual(['un-hazard.json', 'erg.json']))
  })
})
