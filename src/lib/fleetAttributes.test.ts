import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { DeploymentConfig } from './deploymentConfig'

// The data-driven fleet attribute resolver reads getDeploymentConfig().fleet, so we mock
// that singleton accessor and assert symbols.ts resolves attributeLists (with the legacy
// fixed fields as a fallback) and exposes a sane editor catalog.
const cfg: { current: DeploymentConfig } = { current: {} }
vi.mock('./deploymentConfig', async () => {
  const actual = await vi.importActual<typeof import('./deploymentConfig')>('./deploymentConfig')
  return { ...actual, getDeploymentConfig: () => cfg.current }
})

const { symbolTitleOptions, symbolFieldOptions, symbolConfigurableFields } = await import('./symbols')

beforeEach(() => { cfg.current = {} })

describe('fleet attributeLists → symbol option resolution', () => {
  it('attributeLists override the title combobox for a symbol', () => {
    cfg.current = { fleet: { attributeLists: [{ symbol: 'VKF Fahrzeug', field: 'title', options: ['TLF', 'ADL'] }] } }
    expect(symbolTitleOptions('VKF Fahrzeug')).toEqual(['TLF', 'ADL'])
  })

  it('attributeLists override a detail field combobox for a symbol', () => {
    cfg.current = { fleet: { attributeLists: [{ symbol: 'VKF Luefter mobil', field: 'Typ', options: ['Über', 'Elektro'] }] } }
    expect(symbolFieldOptions('VKF Luefter mobil', undefined, [])['Typ']).toEqual(['Über', 'Elektro'])
  })

  it('an unconfigured title has no suggestions — there is no code-baked default', () => {
    cfg.current = { fleet: { attributeLists: [{ symbol: 'VKF Fahrzeug', field: 'title', options: [] }] } }
    // no preset fallback: an empty/absent list resolves to undefined (free typing)
    expect(symbolTitleOptions('VKF Fahrzeug')).toBeUndefined()
  })

  it('the legacy fixed fields still resolve when no attributeLists are present', () => {
    cfg.current = { fleet: { vehicleTypes: ['LegacyTLF'] } }
    expect(symbolTitleOptions('VKF Fahrzeug')).toEqual(['LegacyTLF'])
  })

  it('attributeLists win over the legacy fixed field for the same symbol/field', () => {
    cfg.current = { fleet: { vehicleTypes: ['LegacyTLF'], attributeLists: [{ symbol: 'VKF Fahrzeug', field: 'title', options: ['NewTLF'] }] } }
    expect(symbolTitleOptions('VKF Fahrzeug')).toEqual(['NewTLF'])
  })

  it('a custom attribute list applies to a field the preset never declared options for', () => {
    cfg.current = { fleet: { attributeLists: [{ symbol: 'VKF Gefaehrliche Stoffe', field: 'Stoff', options: ['Chlor'] }] } }
    expect(symbolFieldOptions('VKF Gefaehrliche Stoffe', undefined, [])['Stoff']).toEqual(['Chlor'])
  })
})

describe('symbolConfigurableFields — the viewer attribute model', () => {
  it('exposes Funktion and Name for the Offizier, flagging Name as a roster field', () => {
    const fields = symbolConfigurableFields('FW Offizier')
    const fn = fields.find((f) => f.key === 'Funktion')
    const nm = fields.find((f) => f.key === 'Name')
    expect(fn?.roster).toBe(false)   // a config-listable field
    expect(nm?.roster).toBe(true)    // person-name field — auto-filled from the Mannschaft
  })

  it('offers a title attribute for the user-titled vehicle (config-listed, no code default)', () => {
    const title = symbolConfigurableFields('VKF Fahrzeug').find((f) => f.key === 'title')
    expect(title).toBeTruthy()
    expect(title?.roster).toBe(false)
  })

  it('returns no attributes for a label-only symbol', () => {
    expect(symbolConfigurableFields('VKF KP Front')).toEqual([])
  })
})
