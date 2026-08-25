import { describe, expect, it } from 'vitest'
import { railPlanTiles, buildPlanInfo, extraModuleDoc, BUILDING_PICK_ID } from './useObjectPlans'
import { planGlyph } from './navRail'
import { appConfig } from '../config/appConfig'
import type { PlanDocument } from '../types'
import type { ReferenceDataset } from './incidents'

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

  it('reads «Gebäude» before a stack exists — the footprint glyph alone says «not yet»', () => {
    const [tile] = railPlanTiles([umrisse, tafel], BUILDING_PICK_ID)
    expect(tile.code).toBe(wb.railBuilding)
    expect(glyph(tile)).toEqual({ icon: 'footprint' })
  })

  it('reads «Gebäude» with the storey glyph once a floor stack exists', () => {
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

// One PDF dataset as the backend serves it — only the fields buildPlanInfo reads matter.
const pdf = (over: Partial<ReferenceDataset> & { id: string }): ReferenceDataset => ({
  object_id: 'obj', module: null, kind: 'pdf', title: null, source_type: 'upload',
  source_note: null, content_type: 'application/pdf', size_bytes: 1000, feature_count: null,
  current_version: 1, updated_at: '2026-08-25T00:00:00Z', ...over,
})

// «Bernhardsberg 15» has «Modul 5 - Wasser 1.pdf» AND «Modul 5 - Wasser 2.pdf»; «Hinterbergweg 11»
// has three. Every one of them is a separate waterplan and has to reach the rail as its own tile —
// they used to fold onto one `modul5-wasser` key and only the first survived.
describe('buildPlanInfo — several sheets of one kind are several plans', () => {
  it('keeps numbered siblings apart', () => {
    const { plans, titles } = buildPlanInfo([
      pdf({ id: 'plan:obj:modul5-wasser1', module: 'modul5-wasser1', title: 'Wasser 1' }),
      pdf({ id: 'plan:obj:modul5-wasser2', module: 'modul5-wasser2', title: 'Wasser 2' }),
      pdf({ id: 'plan:obj:modul5-wasser3', module: 'modul5-wasser3', title: 'Wasser 3' }),
    ])
    expect(Object.keys(plans).sort()).toEqual(['modul5-wasser1', 'modul5-wasser2', 'modul5-wasser3'])
    expect(plans['modul5-wasser2']).toBe('/api/reference/plan%3Aobj%3Amodul5-wasser2?v=1')
    expect(titles['modul5-wasser3']).toBe('Wasser 3')
  })

  it('keeps a two-digit variant apart (PV 15 / PV 20)', () => {
    const { plans } = buildPlanInfo([
      pdf({ id: 'a', module: 'modul5-pv15', title: 'PV 15' }),
      pdf({ id: 'b', module: 'modul5-pv20', title: 'PV 20' }),
    ])
    expect(Object.keys(plans).sort()).toEqual(['modul5-pv15', 'modul5-pv20'])
  })

  // A deployment loaded before the importer numbered its slots serves BOTH sheets as plain
  // `modul5-wasser`. The second one still has to get a tile instead of replacing the first.
  it('never drops a plan whose key is already taken', () => {
    const { plans, titles } = buildPlanInfo([
      pdf({ id: 'a', module: 'modul5-wasser', title: 'Wasser 1' }),
      pdf({ id: 'b', module: 'modul5-wasser', title: 'Wasser 2' }),
    ])
    expect(Object.keys(plans).sort()).toEqual(['modul5-wasser', 'modul5-wasser2'])
    expect(titles['modul5-wasser2']).toBe('Wasser 2')
  })

  it('still collapses a combined Modul 2-3 sheet into one tile', () => {
    const { plans } = buildPlanInfo([
      pdf({ id: 'a', module: 'modul2', title: 'Umgebung', size_bytes: 4242 }),
      pdf({ id: 'b', module: 'modul3', title: 'Objektplan', size_bytes: 4242 }),
    ])
    expect(plans['modul2-3']).toBeTruthy()
  })
})

// The whole chain a backend-tagged sheet travels: module key → plan map → synthesized tile.
describe('a numbered sub-slot from the backend reaches the rail as its own tile', () => {
  it('carries a distinct id, label and monogram per sheet', () => {
    const { plans, titles } = buildPlanInfo([
      pdf({ id: 'a', module: 'modul5-wasser1', title: 'Wasser 1' }),
      pdf({ id: 'b', module: 'modul5-wasser2', title: 'Wasser 2' }),
    ])
    const tiles = Object.keys(plans).sort().map((id) => extraModuleDoc(id, plans[id], titles[id]))
    expect(tiles.map((t) => t.id)).toEqual(['modul5-wasser1', 'modul5-wasser2'])
    expect(tiles.map((t) => t.code)).toEqual(['Wasser 1', 'Wasser 2'])
    expect(tiles.map(glyph)).toEqual([{ mono: 'WAS1' }, { mono: 'WAS2' }])
    // `planId` is a foreign key (Verlauf rows, planScale, the board keys) — the tile id IS the
    // module key the backend serves, so an old row still resolves to the sheet it named.
    expect(tiles.map((t) => t.imageUrl)).toEqual([plans['modul5-wasser1'], plans['modul5-wasser2']])
  })
})
