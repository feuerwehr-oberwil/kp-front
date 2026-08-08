import { describe, expect, it } from 'vitest'
import {
  EMPTY_STYLE,
  fc,
  isRotatableSym,
  isVehicleSym,
  lineFeat,
  pathSegmentCount,
  polyFeat,
  pxPerM,
  resumeViewState,
  shapePx,
  effectiveLayer,
  snapNorth,
  symPx,
  vis,
} from './mapView'
import { appConfig } from '../config/appConfig'
import { VEHICLE_SYMBOLS } from './symbols'
import type { Entity, LngLat } from '../types'

const ent = (over: Partial<Entity>): Entity => ({
  id: 'e', kind: 'symbol', layer: 'l', coord: [7, 47], ...over,
})

describe('EMPTY_STYLE / vis', () => {
  it('is an empty MapLibre style v8', () => {
    expect(EMPTY_STYLE).toEqual({ version: 8, sources: {}, layers: [] })
  })
  it('vis toggles MapLibre visibility', () => {
    expect(vis(true)).toEqual({ visibility: 'visible' })
    expect(vis(false)).toEqual({ visibility: 'none' })
  })
})

describe('snapNorth — accidental-rotation self-heal', () => {
  it('snaps a small clockwise drift back to north', () => expect(snapNorth(3)).toBe(0))
  it('snaps a small counter-clockwise drift (negative bearing)', () => expect(snapNorth(-4)).toBe(0))
  it('snaps a near-360 bearing (wraps the circle)', () => expect(snapNorth(357)).toBe(0))
  it('keeps a deliberate rotation past the threshold', () => expect(snapNorth(15)).toBeNull())
  it('keeps a deliberate counter-rotation', () => expect(snapNorth(-45)).toBeNull())
  it('does nothing at exactly north (no redundant ease)', () => expect(snapNorth(0)).toBeNull())
  it('honours the boundary inclusively', () => expect(snapNorth(6)).toBe(0))
  it('honours a custom threshold', () => expect(snapNorth(10, 12)).toBe(0))
})

describe('pxPerM / symPx / shapePx — world-scaled sizing', () => {
  it('pxPerM grows with zoom level', () => {
    const lat = 47
    expect(pxPerM(lat, 18)).toBeGreaterThan(pxPerM(lat, 16))
  })

  it('pxPerM is positive and finite for a normal lat/zoom', () => {
    const v = pxPerM(47, 17)
    expect(v).toBeGreaterThan(0)
    expect(Number.isFinite(v)).toBe(true)
  })

  it('symPx clamps to the [28, 48] px band', () => {
    // very low zoom → tiny → clamps up to the 28px floor
    expect(symPx('symbol', 47, 1)).toBe(28)
    // very high zoom → huge → clamps to the 48px ceiling (no ballooning)
    expect(symPx('symbol', 47, 25)).toBe(48)
  })

  it('symPx scales the whole band by the S/M/L mul factor', () => {
    // L (1.3×) lifts both the floor and the ceiling proportionally
    expect(symPx('symbol', 47, 1, 1.3)).toBeCloseTo(28 * 1.3)
    expect(symPx('symbol', 47, 25, 1.3)).toBeCloseTo(48 * 1.3)
  })

  it('symPx uses the per-kind metre size (vehicle bigger than hydrant at same zoom)', () => {
    // pick a zoom where the bigger kind sits above the floor
    const z = 19.5
    expect(symPx('vehicle', 47, z)).toBeGreaterThanOrEqual(symPx('hydrant', 47, z))
  })

  it('symPx falls back to 8 m for an unknown kind', () => {
    const z = 17
    expect(symPx('mystery', 47, z)).toBe(symPx('symbol', 47, z)) // both default to 8m
  })

  it('shapePx clamps to the [24, 900] px range and defaults size to 40 m', () => {
    expect(shapePx(undefined, 47, 1)).toBe(24)
    expect(shapePx(5000, 47, 20)).toBe(900)
    // a defined size threads through the same scaling as the 40m default
    expect(shapePx(40, 47, 12)).toBe(shapePx(undefined, 47, 12))
  })
})

describe('symbol predicates', () => {
  it('isVehicleSym is true only for the generic vehicle symbol', () => {
    expect(isVehicleSym(ent({ symbol: appConfig.symbols.vehicleName }))).toBe(true)
    expect(isVehicleSym(ent({ symbol: 'VKF Feuer' }))).toBe(false)
    expect(isVehicleSym(ent({ kind: 'shape', symbol: appConfig.symbols.vehicleName }))).toBe(false)
  })

  it('isRotatableSym requires kind symbol + a rotatable symbol name', () => {
    expect(isRotatableSym(ent({ symbol: appConfig.symbols.vehicleName }))).toBe(true)
    expect(isRotatableSym(ent({ symbol: 'VKF Feuer' }))).toBe(false) // not rotatable
    expect(isRotatableSym(ent({ symbol: undefined }))).toBe(false)
    expect(isRotatableSym(ent({ kind: 'shape', symbol: appConfig.symbols.vehicleName }))).toBe(false)
  })
})

describe('GeoJSON feature builders', () => {
  it('fc wraps features in a FeatureCollection', () => {
    expect(fc([1, 2] as never[])).toEqual({ type: 'FeatureCollection', features: [1, 2] })
  })

  it('lineFeat builds a LineString feature with props', () => {
    const coords: LngLat[] = [[7, 47], [8, 48]]
    expect(lineFeat(coords, { color: 'red' })).toEqual({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: { color: 'red' },
    })
  })

  it('lineFeat defaults to empty props', () => {
    expect(lineFeat([[7, 47]]).properties).toEqual({})
  })

  it('polyFeat closes the ring by repeating the first coord', () => {
    const coords: LngLat[] = [[0, 0], [1, 0], [1, 1]]
    const f = polyFeat(coords)
    expect(f.geometry.type).toBe('Polygon')
    expect(f.geometry.coordinates[0]).toEqual([[0, 0], [1, 0], [1, 1], [0, 0]])
  })
})

// Consumed once per map instance. It matters on the SECOND instance: after a WebGL context loss
// the map is rebuilt, and snapping the operator back to the incident's opening framing mid-Lage
// would be its own small disaster.
describe('resumeViewState — surviving a context-loss remount', () => {
  const center: LngLat = [7.6, 47.5]

  it('uses the incident framing on a first mount (no live view yet)', () => {
    expect(resumeViewState(null, center, 17.6, 0)).toEqual({ longitude: 7.6, latitude: 47.5, zoom: 17.6, bearing: 0 })
  })

  it('resumes the live view — including a rotated bearing — on a rebuild', () => {
    const live = { center: [7.61, 47.51] as LngLat, zoom: 19.2, bearing: 142 }
    expect(resumeViewState(live, center, 17.6, 0)).toEqual({ longitude: 7.61, latitude: 47.51, zoom: 19.2, bearing: 142 })
  })

  it('keeps a zeroed live view rather than falling back to the initial one', () => {
    const live = { center: [0, 0] as LngLat, zoom: 0, bearing: 0 }
    expect(resumeViewState(live, center, 17.6, 30)).toEqual({ longitude: 0, latitude: 0, zoom: 0, bearing: 0 })
  })
})

// A hand-placed TLF and a live GPS TLF are the same thing to an operator; only the live ones
// were ever put on the Fahrzeuge layer, so «Fahrzeuge» ausblenden left the placed ones on screen.
describe('effectiveLayer', () => {
  it('answers Fahrzeuge for a driven vehicle whatever its stored layer says', () => {
    for (const name of ['VKF Fahrzeug', 'VKF Drehleiter', 'VKF Hubretter', 'FW Boot']) {
      expect(effectiveLayer(ent({ symbol: name, layer: 'taktisch' }))).toBe(appConfig.gps.layerId)
    }
  })

  it('leaves everything else on the layer it was stored on', () => {
    expect(effectiveLayer(ent({ symbol: 'VKF Drohne', layer: 'taktisch' }))).toBe('taktisch')
    expect(effectiveLayer(ent({ symbol: 'VKF Luefter mobil', layer: 'taktisch' }))).toBe('taktisch')
    expect(effectiveLayer(ent({ kind: 'note', layer: 'markup' }))).toBe('markup')
  })

  it('counts the same segments for the "+" handles as for the tap-the-line hit test', () => {
    // a line of n points has n-1 segments; an area closes back to the first, so it has n …
    expect(pathSegmentCount(4, false)).toBe(3)
    expect(pathSegmentCount(4, true)).toBe(4)
    // … but only once it is actually a ring — two points are still just a line
    expect(pathSegmentCount(2, true)).toBe(1)
    // nothing to insert INTO below two points
    expect(pathSegmentCount(1, false)).toBe(0)
    expect(pathSegmentCount(0, true)).toBe(0)
  })

  it('derives the vehicle set from the presets, not a hand-kept list', () => {
    // a vehicle is what carries a Fahrer — the config comment's "driven vehicles"
    expect(VEHICLE_SYMBOLS.has('VKF Fahrzeug')).toBe(true)
    expect(VEHICLE_SYMBOLS.has('Grosslüfter')).toBe(true)
    expect(VEHICLE_SYMBOLS.has('VKF Drohne')).toBe(false)
  })
})
