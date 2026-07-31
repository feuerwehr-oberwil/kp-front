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

  // Cold start: the tablet is normally opened AFTER the vehicles have parked at the incident, so
  // the hook never witnesses them moving. Traccar still reports the last fix's course — that is
  // the direction the truck is standing in, and it must orient the glyph.
  it('orients a vehicle already parked at boot by its last reported course', async () => {
    const parked = { ...gpsPos(1), speed: 0, course: 270 }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([parked]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useVehiclePositions())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.vehicles[0].rotation).toBe(autoRotation(270))
    expect(result.current.vehicles[0].symbolSvg).toContain('rotate(180.0)') // body turned, not neutral
    unmount()
  })

  it('does not let a stale parked course override the direction it then drives in', async () => {
    const parked = { ...gpsPos(1), speed: 0, course: 270 }
    const driving = { ...gpsPos(1), speed: 40, course: 0 }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([parked]), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify([driving]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useVehiclePositions())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(result.current.vehicles[0].rotation).toBe(autoRotation(0))
    unmount()
  })

  it('leaves a vehicle without any reported course neutral (no false direction)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([gpsPos(1)]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useVehiclePositions())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.vehicles[0].rotation).toBe(0)
    expect(result.current.vehicles[0].symbolSvg).not.toContain('M 0.46,-0.4 L 1,0') // no front chevron
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

describe('GPS staleness (frozen positions must not look live)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('is not stale while the feed answers', async () => {
    // A FRESH Response per call: a single shared Response has its body consumed by the first
    // .json(), so every later poll throws 'Body is unusable' and the feed only *looks* dead.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([gpsPos(1)]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useVehiclePositions())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.stale).toBe(false)
    // several healthy poll cycles later it is still not stale
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
    expect(result.current.stale).toBe(false)
    expect(result.current.vehicles[0].subtitle).toBe('GPS · Online')
    unmount()
  })

  it('goes stale once the feed stops answering, without dropping the vehicles', async () => {
    let down = false
    const fetchMock = vi.fn(async () => {
      if (down) throw new Error('Network down')
      return new Response(JSON.stringify([gpsPos(1)]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useVehiclePositions())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.stale).toBe(false)

    down = true // the feed dies with a good fix already on screen

    // One missed poll must NOT cry wolf — a single dropped request on field LTE is normal.
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(result.current.stale).toBe(false)

    // Past three missed polls the picture is frozen and has to say so.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(result.current.stale).toBe(true)
    // The vehicle is still on the map — vanishing would read as "it drove off".
    expect(result.current.vehicles).toHaveLength(1)
    expect(result.current.vehicles[0].subtitle).toContain('veraltet')
    expect(result.current.vehicles[0].fields?.['GPS-Feed']).toContain('keine Daten')
    // `live` must stay true: it means "externally sourced, not editable" and guards drag /
    // rotate. Flipping it would make frozen vehicles draggable — a worse bug than the one
    // being fixed.
    expect(result.current.vehicles[0].live).toBe(true)
    unmount()
  })

  it('never reports stale on a deployment that has no Traccar at all', async () => {
    // 503 stops polling for good. There has never been a successful poll, so there is no
    // frozen picture to warn about — the chip must stay away rather than accuse a feed that
    // was never configured.
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useVehiclePositions())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000) })
    expect(result.current.stale).toBe(false)
    expect(result.current.ageMs).toBeNull()
    unmount()
  })

  it('recovers when the feed comes back', async () => {
    // Toggled explicitly rather than by a fixed mock sequence: the poll and the staleness
    // ticker share the 15 s cadence, so counting `mockResolvedValueOnce` calls made the
    // recovery land on the very tick the assertion checked.
    let down = false
    const fetchMock = vi.fn(async () => {
      if (down) throw new Error('Network down')
      return new Response(JSON.stringify([gpsPos(1)]), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useVehiclePositions())
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.stale).toBe(false)

    down = true
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
    expect(result.current.stale).toBe(true)

    down = false
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(result.current.stale).toBe(false)
    expect(result.current.vehicles[0].subtitle).toBe('GPS · Online')
    unmount()
  })

  it('does not re-render the map every poll while the fleet sits parked', async () => {
    // The whole point of vehiclesSignature: a parked fleet reports identical positions every
    // 15 s and must NOT churn the map overlay tree. An early version of the staleness work
    // wrote the last-success timestamp into state on every poll and silently undid that.
    // A FRESH Response per call: a single shared Response has its body consumed by the first
    // .json(), so every later poll throws 'Body is unusable' and the feed only *looks* dead.
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([gpsPos(1)]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    let renders = 0
    const { unmount } = renderHook(() => { renders++; return useVehiclePositions() })
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    const settled = renders
    // Eight minutes of polling a fleet that never moves.
    await act(async () => { await vi.advanceTimersByTimeAsync(480_000) })
    expect(fetchMock.mock.calls.length).toBeGreaterThan(30)
    // The number that matters is that renders do NOT scale with polls: 30+ polls cost at
    // most one settling render. (Verified against 60/120/240/480 s windows — the delta stays
    // 1 while the poll count grows 6 → 34.) Writing the last-success timestamp into state
    // instead of a ref made this grow linearly, re-rendering the whole map every 15 s.
    expect(renders - settled).toBeLessThanOrEqual(1)
    unmount()
  })
})
