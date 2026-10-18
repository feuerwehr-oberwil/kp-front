// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UndergroundSet } from './api/stationReference'

const rec = vi.hoisted(() => ({ set: null as UndergroundSet | null, asked: 0, fail: false }))
vi.mock('./api/stationReference', async () => {
  const actual = await vi.importActual<typeof import('./api/stationReference')>('./api/stationReference')
  return {
    ...actual,
    loadUnderground: async () => { rec.asked++; if (rec.fail) throw new Error('403'); return rec.set },
  }
})

import { UNDERGROUND_LAYER_ID, UNDERGROUND_MIN_ZOOM, undergroundLayerDef, undergroundOverlay, useUnderground } from './underground'
import { defaultLayers } from './workspace'
import { viewerLayers } from './karte/session'
import { layerPreset } from './layerPreset'

const sq = (lng: number, lat: number, d: number) => [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]
const SET: UndergroundSet = { fetchedAt: '2026-10-18T03:00:00+00:00', count: 2, geometry: { type: 'MultiPolygon', coordinates: [[sq(7.57, 47.52, 0.0002)], [sq(7.571, 47.523, 0.0001)]] } }

beforeEach(() => { rec.set = null; rec.asked = 0; rec.fail = false })

describe('«Unterirdische Bauten» on the Einsatz map (owner, review round 5)', () => {
  it('is an Einsatz layer, ON by default, after the built-in rows, in its own «Station» group', () => {
    const ls = defaultLayers()
    const row = ls.find((l) => l.id === UNDERGROUND_LAYER_ID)
    expect(row).toMatchObject({ visible: true, group: 'Station', label: 'Unterirdische Bauten' })
    expect(row?.base).toBeFalsy()
    expect(ls.indexOf(row!)).toBe(ls.length - 1)
    expect(undergroundLayerDef().visible).toBe(true)
  })

  it('is part of the Einsatz «Standard»: switched off by hand the set is no longer «Standard»', () => {
    const defaults = defaultLayers()
    expect(layerPreset(defaults, defaults)).toBe('standard')
    const off = defaults.map((l) => (l.id === UNDERGROUND_LAYER_ID ? { ...l, visible: false } : l))
    expect(layerPreset(off, defaults)).not.toBe('standard')
  })

  it('is left out of «Karte & Objekte»\'s layer list (the viewer has its own row under «Station»)', () => {
    expect(viewerLayers(defaultLayers(), undefined).some((l) => l.id === UNDERGROUND_LAYER_ID)).toBe(false)
  })

  it('draws a dashed neutral outline from street zoom, no fill, on the layer it is given', () => {
    const ov = undergroundOverlay([[[7.57, 47.52], [7.571, 47.52], [7.571, 47.521]]], '#4d586a', UNDERGROUND_LAYER_ID)
    expect(ov).toMatchObject({ kind: 'polygons', layer: UNDERGROUND_LAYER_ID, color: '#4d586a', fillOpacity: 0, minzoom: UNDERGROUND_MIN_ZOOM })
    expect(ov.kind === 'polygons' && ov.lineDasharray).toBeTruthy()
  })
})

describe('useUnderground', () => {
  it('asks nothing while off, once when on, and keeps the set when switched off and on again', async () => {
    rec.set = SET
    const { result, rerender } = renderHook(({ on }) => useUnderground(on), { initialProps: { on: false } })
    expect(result.current).toBeNull()
    expect(rec.asked).toBe(0)
    rerender({ on: true })
    await waitFor(() => expect(result.current?.state).toBe('ok'))
    expect(result.current?.rings).toHaveLength(2)
    const rings = result.current?.rings
    rerender({ on: false })
    rerender({ on: true })
    expect(rec.asked).toBe(1)
    expect(result.current?.rings).toBe(rings) // the same array: the overlay is not rebuilt
  })

  it('a «none» (nothing stored, offline without a copy, a refusal) is asked again the next time it goes on', async () => {
    rec.fail = true
    const { result, rerender } = renderHook(({ on }) => useUnderground(on), { initialProps: { on: true } })
    await waitFor(() => expect(result.current?.state).toBe('none'))
    rec.fail = false
    rec.set = SET
    rerender({ on: false })
    await act(async () => { rerender({ on: true }) })
    await waitFor(() => expect(result.current?.state).toBe('ok'))
    expect(rec.asked).toBe(2)
  })
})
