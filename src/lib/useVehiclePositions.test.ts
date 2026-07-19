// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { autoRotation, isMoving, useVehiclePositions, vehiclesSignature } from './useVehiclePositions'
import type { Entity } from '../types'

// Minimal live-vehicle entity, as toEntity would produce.
const veh = (id: string, lng: number, lat: number, rotation = 0, over: Partial<Entity> = {}): Entity => ({
  id: `gps-${id}`,
  kind: 'vehicle',
  layer: 'fahrzeuge',
  coord: [lng, lat],
  symbolSvg: '<svg/>',
  rotation,
  label: id,
  live: true,
  ...over,
})

describe('vehiclesSignature (re-render short-circuit)', () => {
  it('is stable when only detail-panel fields change (parked fleet)', () => {
    const a = veh('1', 7.5, 47.5, 90, { subtitle: 'GPS · Online', fields: { 'Letzte GPS-Pos.': '10:00:00' } })
    const b = veh('1', 7.5, 47.5, 90, { subtitle: 'GPS · Online', fields: { 'Letzte GPS-Pos.': '10:00:15' } })
    // same position + rotation, only the last-update timestamp advanced → identical signature,
    // so the map must NOT be told to re-render.
    expect(vehiclesSignature([a])).toBe(vehiclesSignature([b]))
  })

  it('changes when a vehicle moves or rotates', () => {
    const base = vehiclesSignature([veh('1', 7.5, 47.5, 90)])
    expect(vehiclesSignature([veh('1', 7.6, 47.5, 90)])).not.toBe(base) // moved lng
    expect(vehiclesSignature([veh('1', 7.5, 47.6, 90)])).not.toBe(base) // moved lat
    expect(vehiclesSignature([veh('1', 7.5, 47.5, 180)])).not.toBe(base) // rotated
  })

  it('changes when the fleet membership changes', () => {
    const one = vehiclesSignature([veh('1', 7.5, 47.5)])
    const two = vehiclesSignature([veh('1', 7.5, 47.5), veh('2', 7.6, 47.6)])
    expect(one).not.toBe(two)
  })

  it('is empty for an empty fleet (so first non-empty poll always renders)', () => {
    expect(vehiclesSignature([])).toBe('')
  })
})

// Backend VehiclePosition shape, as /api/traccar/positions returns it.
const gpsPos = (device_id: number) => ({
  device_id,
  device_name: `TLF ${device_id}`,
  unique_id: `u${device_id}`,
  status: 'online',
  latitude: 47.5,
  longitude: 7.5,
  speed: 0,
  course: null,
  last_update: '2026-07-15T10:00:00Z',
})

describe('useVehiclePositions polling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('polls the same-origin backend path with the default empty baseUrl (prod regression)', async () => {
    // PR #75 skipped polling entirely for a production build with empty baseUrl — but empty
    // baseUrl IS the production config since the backend serves /api/traccar/positions
    // same-origin. This pins down that polling always starts and vehicles land on the layer.
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([gpsPos(1)]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useVehiclePositions())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock).toHaveBeenCalledWith('/api/traccar/positions', expect.anything())
    expect(result.current.vehicles).toHaveLength(1)
    expect(result.current.vehicles[0].id).toBe('gps-1')
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(fetchMock).toHaveBeenCalledTimes(2) // keeps polling on the interval
    unmount()
  })

  it('stops polling for good when the deployment has no Traccar (503)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useVehiclePositions())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fetchMock).toHaveBeenCalledTimes(1) // interval cleared — no 15 s heartbeat
    expect(result.current.vehicles).toHaveLength(0)
    unmount()
  })

  it('keeps polling through transient upstream failures (502)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 502 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useVehiclePositions())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.error).toBe('HTTP 502')
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    unmount()
  })
})

describe('autoRotation / isMoving (unchanged helpers, kept covered)', () => {
  it('maps a north course to a left-pointing glyph and passes null through', () => {
    expect(autoRotation(0)).toBe(-90)
    expect(autoRotation(90)).toBe(0)
    expect(autoRotation(null)).toBe(0)
  })

  it('treats a real speed as moving, else falls back to course presence', () => {
    expect(isMoving(10, 90)).toBe(true)
    expect(isMoving(0, 90)).toBe(false)
    expect(isMoving(null, 90)).toBe(true)
    expect(isMoving(null, null)).toBe(false)
  })
})
