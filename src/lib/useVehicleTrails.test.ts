import { describe, expect, it } from 'vitest'
import { trailsToGeoJSON, type VehicleTrail } from './useVehicleTrails'

const trail = (over: Partial<VehicleTrail> = {}): VehicleTrail => ({
  device_id: 1,
  device_name: 'TLF',
  points: [
    { lat: 47.5, lng: 7.6 },
    { lat: 47.51, lng: 7.61 },
  ],
  ...over,
})

describe('trailsToGeoJSON', () => {
  it('maps a track to a LineString in lng,lat order', () => {
    const fc = trailsToGeoJSON([trail()])
    expect(fc.features).toHaveLength(1)
    // GeoJSON is lng-first; getting this backwards puts the fleet in Somalia
    expect(fc.features[0].geometry.coordinates).toEqual([
      [7.6, 47.5],
      [7.61, 47.51],
    ])
  })

  it('keeps the device name so a track can be attributed', () => {
    const fc = trailsToGeoJSON([trail({ device_name: 'ADL' })])
    expect(fc.features[0].properties.device_name).toBe('ADL')
  })

  it('drops a device with fewer than two points', () => {
    // One fix is not a line. It would render as nothing while still costing a feature.
    expect(trailsToGeoJSON([trail({ points: [{ lat: 47.5, lng: 7.6 }] })]).features).toHaveLength(0)
    expect(trailsToGeoJSON([trail({ points: [] })]).features).toHaveLength(0)
  })

  it('drops non-finite coordinates rather than passing them to MapLibre', () => {
    // One NaN makes MapLibre discard the WHOLE source, so a single bad fix would silently take
    // every other vehicle's track down with it.
    const fc = trailsToGeoJSON([
      trail({
        points: [
          { lat: 47.5, lng: 7.6 },
          { lat: Number.NaN, lng: 7.61 },
          { lat: 47.52, lng: 7.62 },
        ],
      }),
    ])
    expect(fc.features[0].geometry.coordinates).toEqual([
      [7.6, 47.5],
      [7.62, 47.52],
    ])
  })

  it('survives a device whose points are missing entirely', () => {
    const fc = trailsToGeoJSON([{ device_id: 2, device_name: 'MTF' } as VehicleTrail])
    expect(fc.features).toHaveLength(0)
  })

  it('one bad device does not take the others with it', () => {
    const fc = trailsToGeoJSON([trail({ points: [] }), trail({ device_id: 3, device_name: 'ADL' })])
    expect(fc.features).toHaveLength(1)
    expect(fc.features[0].properties.device_name).toBe('ADL')
  })
})
