// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ErgState } from '../../lib/karte/overlays'

afterEach(() => { vi.unstubAllGlobals() })

describe('useKarteOverlays — Gefahrgut rings', () => {
  it('a UN number typed before the ERG table landed gets its rings when it lands', async () => {
    vi.resetModules() // the ERG table is module state: not yet loaded
    let land: (r: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn((u: RequestInfo | URL) => (String(u).endsWith('erg.json')
      ? new Promise<Response>((r) => { land = r })
      : Promise.resolve(new Response('[]')))))
    const { useKarteOverlays } = await import('./useKarteOverlays')
    const erg: ErgState = { un: '1005', mode: 'small', center: [7.6, 47.5], at: new Date('2026-11-26T12:00:00Z') }
    const props = {
      outlines: new Map(), cats: new Map(), catOff: () => false, sel: null, selObj: null, ringsNear: () => [],
      tool: 'erg' as const, erg, uncached: [], under: null, underOn: false, outlined: null, hydPoint: null, nearAt: null,
    }
    const { result } = renderHook(() => useKarteOverlays(props))
    const rings = () => result.current.filter((o) => o.id.startsWith('karte-erg-'))
    expect(rings()).toEqual([])
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    land(new Response(JSON.stringify({ version: '2024', un: { 1005: { g: 125, tih: [{ si: '100 m', pd: '0.5 km', pn: '1.5 km' }] } } })))
    await waitFor(() => expect(rings().length).toBeGreaterThan(0))
  })
})
