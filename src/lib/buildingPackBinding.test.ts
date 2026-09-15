import { expect, it } from 'vitest'
import type { BuildingDoc } from '../types'
import { buildingPackBinding } from './buildingPackBinding'
import { inheritPlanBinding } from './incidentPlanBindings'

const binding = (id: string, aspect = 1.4) => inheritPlanBinding({
  id, objectId: id, datasetId: `plan:${id}:modul6`, planId: 'modul6', planVersion: 1, title: 'Modul 6',
}, { id: 1, pairs: [], aspect, approved_at: '2026-09-15' }, null, false, [
  { page: 0, index: 0, name: null }, { page: 1, index: 1, name: null },
])
const building = (bindingId?: string): BuildingDoc => ({
  ring: [], ringAspect: 1 / 1.4, floors: [1, 0], pack: { aspect: 1.4, bindingId },
})

it('keeps the pinned source even when another object binding is first', () => {
  const original = binding('original'), other = binding('other')
  expect(buildingPackBinding(building(original.id), [other, original])).toBe(original)
  expect(buildingPackBinding(building(original.id), [other])).toBeNull()
})

it('recovers the sole legacy source or a unique compatible frozen source', () => {
  const original = binding('original'), other = binding('other', 2)
  expect(buildingPackBinding(building(), [original])).toBe(original)
  expect(buildingPackBinding(building(), [other, original])).toBe(original)
})

it('does not guess between compatible legacy sources or use an incompatible one among several', () => {
  expect(buildingPackBinding(building(), [binding('a'), binding('b')])).toBeNull()
  expect(buildingPackBinding(building(), [binding('a', 2), binding('b', 3)])).toBeNull()
  expect(buildingPackBinding({ ...building(), pack: undefined }, [binding('a')])).toBeNull()
})
