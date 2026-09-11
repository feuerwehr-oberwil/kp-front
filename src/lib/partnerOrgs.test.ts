import { describe, expect, it } from 'vitest'
import { addPartnerOrg, unlistedPartnerOrgs } from './partnerOrgs'
import type { PartnerContact } from './workspace'

// The manual add on the Rapport sheet and on the Erfassungs-Poster: what is typed IS the row.
// Before 11.09. both appended a BLANK row and asked for the name in a second field.

const PRESETS = ['Polizei', 'Sanität', 'Werkhof']

describe('addPartnerOrg — der getippte Name ist die Zeile', () => {
  it('appends exactly one row, named', () => {
    expect(addPartnerOrg([], 'Nachbarwehr Therwil')).toEqual([{ org: 'Nachbarwehr Therwil' }])
  })

  it('keeps what is already recorded, remarks and all', () => {
    const partners: PartnerContact[] = [{ org: 'Polizei', note: 'Wm. Keller, Verkehr ab Kreisel' }]
    expect(addPartnerOrg(partners, 'Werkhof')).toEqual([
      { org: 'Polizei', note: 'Wm. Keller, Verkehr ab Kreisel' },
      { org: 'Werkhof' },
    ])
  })

  it('⚠️ refuses a name the sheet already carries — one organisation, one row', () => {
    const partners: PartnerContact[] = [{ org: 'Polizei' }]
    expect(addPartnerOrg(partners, 'Polizei')).toBeNull()
    expect(addPartnerOrg(partners, '  polizei ')).toBeNull() // …however it was spelled
  })

  it('refuses an empty query instead of standing a nameless row on the rapport', () => {
    expect(addPartnerOrg([], '   ')).toBeNull()
  })

  it('trims, so the row and the checklist entry are the same organisation', () => {
    // a name off the station's list lands as THAT organisation, which is what makes its
    // checklist row tick on rather than a second free row appear beside it
    expect(addPartnerOrg([], ' Polizei ')).toEqual([{ org: 'Polizei' }])
  })
})

describe('unlistedPartnerOrgs — was die Auswahl ohne Tippen anbietet', () => {
  it('drops whatever is already on the sheet', () => {
    expect(unlistedPartnerOrgs(PRESETS, [{ org: 'polizei' }])).toEqual(['Sanität', 'Werkhof'])
  })

  it('offers the whole list while nothing is recorded', () => {
    expect(unlistedPartnerOrgs(PRESETS, [])).toEqual(PRESETS)
  })

  it('is unbothered by a freely typed organisation that is on no list', () => {
    expect(unlistedPartnerOrgs(PRESETS, [{ org: 'Nachbarwehr Therwil' }])).toEqual(PRESETS)
  })
})
