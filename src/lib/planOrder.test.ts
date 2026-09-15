import { describe, expect, it } from 'vitest'
import { DEFAULT_MODULES } from './deploymentConfig'
import { comparePlanModules, sortPlanModuleIds, sortPlansByModule } from './planOrder'

// The catalogue as the shipped defaults spell it — `order` puts Modul 4 at 7 and the Modul-5
// family at 5/6, which is exactly the drift the sorter must not inherit.
const ids = (list: readonly string[]) => sortPlanModuleIds(DEFAULT_MODULES, list)

describe('plan module order', () => {
  it('reads the number on the paper plan, not the catalogue’s drifted «order»', () => {
    expect(ids(['modul6', 'modul5-zusatz', 'modul4', 'modul5', 'modul1']))
      .toEqual(['modul1', 'modul4', 'modul5', 'modul5-zusatz', 'modul6'])
  })

  it('keeps a family’s sub-slots directly after their family', () => {
    expect(ids(['modul6', 'modul5-wasser2', 'modul5-pv', 'modul5', 'modul5-wasser']))
      .toEqual(['modul5', 'modul5-pv', 'modul5-wasser', 'modul5-wasser2', 'modul6'])
  })

  it('closes the run a combined sheet replaces: 2/3 sorts on Modul 3', () => {
    expect(ids(['modul4', 'modul2-3', 'modul2', 'modul3']))
      .toEqual(['modul2', 'modul3', 'modul2-3', 'modul4'])
  })

  it('puts a module the catalogue does not list last, whatever its number', () => {
    expect(ids(['modul9-sonder', 'modul6', 'modul1'])).toEqual(['modul1', 'modul6', 'modul9-sonder'])
  })

  it('orders stored plans by their module, leaving the input untouched', () => {
    const plans = [{ module: 'modul6' }, { module: 'modul4' }, { module: null }, { module: 'modul5-zusatz' }]
    expect(sortPlansByModule(DEFAULT_MODULES, plans).map((p) => p.module))
      .toEqual(['modul4', 'modul5-zusatz', 'modul6', null])
    expect(plans.map((p) => p.module)).toEqual(['modul6', 'modul4', null, 'modul5-zusatz'])
  })

  it('breaks a tie inside one module number with the catalogue’s own sequence', () => {
    const catalogue = [
      { id: 'modul5', family: true },
      { id: 'modul5-zusatz' },
      { id: 'modul5-pv' },
    ]
    const cmp = comparePlanModules(catalogue)
    expect(['modul5-pv', 'modul5-zusatz'].slice().sort(cmp)).toEqual(['modul5-zusatz', 'modul5-pv'])
  })
})
