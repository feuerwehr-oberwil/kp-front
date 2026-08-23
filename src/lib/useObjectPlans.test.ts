import { describe, expect, it } from 'vitest'
import { railPlanTiles, BUILDING_PICK_ID } from './useObjectPlans'
import { planGlyph } from './navRail'
import { appConfig } from '../config/appConfig'
import type { PlanDocument } from '../types'

const doc = (p: Partial<PlanDocument> & { id: string }): PlanDocument => ({
  code: p.id, title: '', subtitle: '', imageUrl: '', orientation: 'landscape', ...p,
})

const modul3 = doc({ id: 'modul3', code: 'Modul 3' })
const umrisse = doc({ id: BUILDING_PICK_ID, code: 'Umrisse', icon: 'footprint', osm: { center: [7.6, 47.5], radiusM: 250 } })
const gebaeude = doc({ id: 'gebaeude', code: 'Gebäude', icon: 'floors', floorStack: true })
const tafel = doc({ id: 'tafel', code: 'Tafel', icon: 'pen' })

const wb = appConfig.copy.whiteboard
const glyph = (d: PlanDocument) => planGlyph(d)

// The outline picker and the floor stack are ONE tile in the rail, and two documents everywhere
// else. Both halves of that sentence are load-bearing, so both are pinned here.
describe('railPlanTiles — the merged Gebäude tile', () => {
  it('shows one tile for the pair, in the picker\'s slot', () => {
    const rail = railPlanTiles([modul3, umrisse, gebaeude, tafel], 'gebaeude')
    expect(rail.map((p) => p.id)).toEqual(['modul3', 'gebaeude', 'tafel'])
  })

  it('says in glyph AND word that no floor stack exists yet', () => {
    const [tile] = railPlanTiles([umrisse, tafel], BUILDING_PICK_ID)
    expect(tile.code).toBe(wb.railBuildingNone)
    expect(glyph(tile)).toEqual({ icon: 'footprint' })
  })

  it('says in glyph AND word that a floor stack exists', () => {
    const [tile] = railPlanTiles([umrisse, gebaeude, tafel], 'gebaeude')
    expect(tile.code).toBe(wb.railBuilding)
    expect(glyph(tile)).toEqual({ icon: 'floors' })
  })

  // The whole reason the merge is cheap: `planId` is a foreign key (Verlauf rows, Trupp.planId,
  // planScale, the board keys, the audit trail). The tile addresses whichever of the two the
  // operator is actually on, so the rail highlights it either way.
  it('addresses the picker while the operator stands on it — and still reports the stack', () => {
    const [tile] = railPlanTiles([umrisse, gebaeude, tafel], BUILDING_PICK_ID)
    expect(tile.id).toBe(BUILDING_PICK_ID)
    expect(tile.osm).toBeTruthy() // still the selection-only surface (isSelectOnlySurface)
    expect(tile.code).toBe(wb.railBuilding)
    expect(glyph(tile)).toEqual({ icon: 'floors' })
  })

  it('addresses the stack from anywhere else', () => {
    const [, tile] = railPlanTiles([modul3, umrisse, gebaeude], 'modul3')
    expect(tile.id).toBe('gebaeude')
    expect(tile.osm).toBeFalsy()
  })

  it('leaves a catalog without either surface alone', () => {
    const docs = [modul3, tafel]
    expect(railPlanTiles(docs, 'modul3')).toEqual(docs)
  })

  it('does not touch the catalog it was handed', () => {
    const docs = [umrisse, gebaeude]
    railPlanTiles(docs, 'gebaeude')
    expect(docs.map((p) => p.id)).toEqual([BUILDING_PICK_ID, 'gebaeude'])
    expect(umrisse.code).toBe('Umrisse') // the DOCUMENT keeps its own name — that is what prints
  })
})
