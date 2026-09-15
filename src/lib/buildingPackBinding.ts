import type { BuildingDoc } from '../types'
import type { IncidentPlanBinding } from './incidentPlanBindings'

const WHOLE = [0, 0, 1, 1]

/** Resolve a stack's frozen source without consulting the currently selected object. Older
 *  stacks can recover an unambiguous source; ambiguous stacks require an explicit choice. */
export function buildingPackBinding(
  building: BuildingDoc | null | undefined,
  bindings: IncidentPlanBinding[],
): IncidentPlanBinding | null {
  const pack = building?.pack
  if (!pack) return null
  const candidates = bindings.filter(binding => binding.floors?.length)
  if (pack.bindingId) return candidates.find(binding => binding.id === pack.bindingId) ?? null
  if (candidates.length === 1) return candidates[0]
  const compatible = candidates.filter(binding => {
    if (binding.aspect !== pack.aspect || !binding.floors) return false
    const onFitPage = binding.floors.filter(floor => floor.page === binding.page)
    const ref = onFitPage.find(floor => floor.index === 0) ?? onFitPage[0] ?? binding.floors[0]
    const frame = ref.clip ?? WHOLE
    if (!(pack.frame ?? WHOLE).every((value, i) => value === frame[i])) return false
    const indices = new Set(binding.floors.map(floor => floor.index))
    return indices.size === building.floors.length && building.floors.every(index => indices.has(index))
  })
  return compatible.length === 1 ? compatible[0] : null
}
