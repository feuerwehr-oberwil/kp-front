import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminGeorefKey, registerAdminGeoref } from './adminGeorefSink'
import { georefDispatch, georefSnapshot, resetGeorefPlan, startGeorefMode } from './georefMode'
import { georefForPlan } from './stationPlanScale'
import type { GeorefPair } from './georef'

const pair = (x: number, y: number, lng: number, lat: number): GeorefPair => ({ plan: { x, y }, lngLat: { lng, lat }, kind: 'gesetzt' })

afterEach(() => { georefDispatch({ type: 'dismiss' }) })

describe('the admin review draft as a home for the pairing mode', () => {
  it('seeds the mode from the draft and writes every finished pair back into it – nothing else', () => {
    let draft: GeorefPair[] = [pair(0.1, 0.1, 7.5, 47.5)]
    const save = vi.fn((p: GeorefPair[]) => { draft = p })
    const key = adminGeorefKey(42)
    const unregister = registerAdminGeoref(key, { pairs: () => draft, save })
    expect(georefForPlan(key)?.pairs).toEqual(draft)
    startGeorefMode('modul2', 1.4, { storageKey: key })
    expect(georefSnapshot().pairs).toHaveLength(1)
    georefDispatch({ type: 'planTap', pt: { x: 0.8, y: 0.8 } })
    georefDispatch({ type: 'mapTap', lngLat: { lng: 7.502, lat: 47.499 } })
    expect(save).toHaveBeenCalled()
    expect(draft).toHaveLength(2)
    expect(draft[1]).toMatchObject({ plan: { x: 0.8, y: 0.8 }, lngLat: { lng: 7.502, lat: 47.499 } })
    // a reset of an admin key empties the draft and never touches the station document
    resetGeorefPlan(key)
    expect(draft).toEqual([])
    unregister()
    expect(georefForPlan(key)).toBeNull()
  })
})
