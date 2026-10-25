import { describe, expect, it } from 'vitest'
import type { LngLat, PreparedMapOverlay } from '../../types'
import { DEFAULT_ERG_RING_MODE } from '../ergRings'
import { pointerOverlays, stationOverlays, UNDERGROUND_LAYER, type ErgState } from './overlays'
import type { ObjectOutlines } from './selection'

const sq = (x: number, y: number): LngLat[] => [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]]
const SCHLOSS = sq(0, 0), SCHLOSS_GARAGE = sq(0, 3), SCHULE = sq(5, 0), DEPOT = sq(9, 0)
const OUTLINES: ObjectOutlines = new Map([
  ['schloss', { rings: [SCHLOSS], main: SCHLOSS, under: [SCHLOSS_GARAGE] }],
  ['schule', { rings: [SCHULE], main: SCHULE, under: [] }],
  ['depot', { rings: [DEPOT], main: DEPOT, under: [] }],
])
// the Schule is in the «Schulen» category; the others keep the default ink
const CATS = new Map([['schule', { id: 'schulen', color: '#2b6cb0' }]])
const UNDERGROUND: PreparedMapOverlay = { id: 'karte-underground', kind: 'polygons', layer: UNDERGROUND_LAYER, rings: [sq(20, 20)], color: '#4d586a' }
const NO_ERG: ErgState = { un: '', mode: DEFAULT_ERG_RING_MODE, center: null, at: new Date('2026-10-24T10:00:00Z') }
const base = {
  outlines: OUTLINES, cats: CATS, hidden: () => false, ink: '#1b2330', blue: '#2f6fed', hatchInk: '#6c7686',
  sel: null, selId: null, ringsNear: () => [], underground: null, uncached: [], erg: null,
}
const ids = (list: PreparedMapOverlay[]) => list.map((o) => o.id)

describe('stationOverlays · the map\'s stack, bottom first', () => {
  it('offline hatching, then the underground set, then each colour\'s garages under its buildings, then the selection', () => {
    const out = stationOverlays({
      ...base, underground: UNDERGROUND, uncached: [{ x: 1, y: 2, z: 3 }],
      sel: { kind: 'object', id: 'schloss' }, selId: 'schloss',
    })
    // one overlay per colour, in the order the catalogue first meets it (the Schule before the Depot)
    expect(ids(out)).toEqual(['karte-uncached', 'karte-underground', 'karte-objects-schulen', 'karte-objects', 'karte-object-sel-under', 'karte-object-sel'])
    // the selected object is drawn in the strong style only, never in its colour's overlay
    expect(out.find((o) => o.id === 'karte-objects')).toMatchObject({ rings: [DEPOT] })
    expect(out.find((o) => o.id === 'karte-object-sel')).toMatchObject({ rings: [SCHLOSS], color: '#1b2330' })
  })

  it('a hidden category takes its objects off the map; the selected one stays', () => {
    const hidden = (id: string) => id === 'schule'
    expect(ids(stationOverlays({ ...base, hidden }))).toEqual(['karte-objects-under', 'karte-objects'])
    expect(stationOverlays({ ...base, hidden, sel: { kind: 'object', id: 'schule' }, selId: 'schule' }).slice(-1)[0]).toMatchObject({ id: 'karte-object-sel', color: '#2b6cb0' })
  })

  it('a building tap: the house a switch opens dashed, a plain building found by its point', () => {
    const hit = stationOverlays({ ...base, sel: { kind: 'object', id: 'schloss', hit: { at: [0.5, 0.5], ring: SCHLOSS } }, selId: 'schloss' })
    expect(hit.slice(-1)[0]).toMatchObject({ id: 'karte-object-hit', rings: [SCHLOSS], color: '#2f6fed', lineDasharray: [2, 1.4] })
    const plain = sq(30, 30)
    const building = stationOverlays({ ...base, sel: { kind: 'building', at: [30.5, 30.5], ring: null, address: null }, ringsNear: () => [plain] })
    expect(building.slice(-1)[0]).toMatchObject({ id: 'karte-building', rings: [plain] })
  })

  it('an ink category (color null) draws in the theme\'s ink, day and night, and still hides on its own', () => {
    // the Schloss is in «Einsatzpläne» set to ink; the Depot has no category
    const cats = new Map<string, { id: string; color: string | null }>([...CATS, ['schloss', { id: 'plaene', color: null }]])
    for (const ink of ['#1b2330', '#eef1f5']) { // --obj-plans by day, at night
      const out = stationOverlays({ ...base, cats, ink })
      // one slot with the uncategorised Depot, under the default's id, in this theme's ink
      expect(out.find((o) => o.id === 'karte-objects')).toMatchObject({ rings: [SCHLOSS, DEPOT], color: ink })
      expect(out.find((o) => o.id === 'karte-objects-under')).toMatchObject({ rings: [SCHLOSS_GARAGE], color: ink })
      expect(stationOverlays({ ...base, cats, ink, sel: { kind: 'object', id: 'schloss' }, selId: 'schloss' }).slice(-1)[0]).toMatchObject({ id: 'karte-object-sel', color: ink })
      expect(pointerOverlays({ outlined: { kind: 'object', id: 'schloss', ring: null }, outlines: OUTLINES, cats, ink, blue: '#2f6fed', hydrantLine: null })[0]).toMatchObject({ id: 'karte-hover-object', color: ink })
    }
    const hidden = (id: string) => id === 'schloss'
    expect(stationOverlays({ ...base, cats, hidden }).find((o) => o.id === 'karte-objects')).toMatchObject({ rings: [DEPOT] })
  })

  it('Gefahrgut draws only with a UN number AND a centre', () => {
    expect(stationOverlays({ ...base, erg: { ...NO_ERG, un: '1203' } }).some((o) => o.id.startsWith('karte-erg-'))).toBe(false)
    expect(stationOverlays({ ...base, erg: { ...NO_ERG, center: [7.57, 47.52] } }).some((o) => o.id.startsWith('karte-erg-'))).toBe(false)
  })
})

describe('pointerOverlays · what the pointer is about to open', () => {
  it('all of an object\'s buildings in its colour, the one under the pointer in white', () => {
    const out = pointerOverlays({ outlined: { kind: 'object', id: 'schule', ring: SCHULE }, outlines: OUTLINES, cats: CATS, ink: '#1b2330', blue: '#2f6fed', hydrantLine: null })
    expect(out).toMatchObject([{ id: 'karte-hover-object', color: '#2b6cb0', rings: [SCHULE] }, { id: 'karte-hover-house', color: '#ffffff' }])
  })

  it('a plain building in thin blue, and the line to the hydrant shown', () => {
    const line: [LngLat, LngLat] = [[0, 0], [1, 1]]
    const out = pointerOverlays({ outlined: { kind: 'plain', ring: DEPOT }, outlines: OUTLINES, cats: CATS, ink: '#1b2330', blue: '#2f6fed', hydrantLine: line })
    expect(out).toMatchObject([{ id: 'karte-hover-plain', color: '#2f6fed', lineWidth: 2 }, { id: 'karte-hydrant-line', kind: 'line', coords: line }])
    expect(pointerOverlays({ outlined: null, outlines: OUTLINES, cats: CATS, ink: '', blue: '', hydrantLine: null })).toEqual([])
  })
})
