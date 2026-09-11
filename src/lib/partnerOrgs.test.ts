import { describe, expect, it } from 'vitest'
import {
  addPartnerOrg, partnerOrgOffer, partnerOrgsFromLage, unlistedPartnerOrgs,
} from './partnerOrgs'
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

// «Auf der Karte: Polizei · Sanität — Übernehmen»: the Partner-Bereiche on the Kroki are already
// the answer to «war die da?». Read off the symbols, offered, never ticked on their own.
describe('partnerOrgsFromLage — was das Kroki über die Partner sagt', () => {
  it('reads the station’s organisation off its Partner-Bereich', () => {
    expect(partnerOrgsFromLage([{ symbol: 'VKF Bereich Polizei' }], PRESETS)).toEqual(['Polizei'])
  })

  it('answers in the station’s spelling and order, not the symbol’s', () => {
    const placed = [{ symbol: 'VKF Bereich Sanitaet' }, { symbol: 'VKF Bereich Polizei' }]
    expect(partnerOrgsFromLage(placed, PRESETS)).toEqual(['Polizei', 'Sanität'])
    // a list that calls the same organisation «Rettungsdienst» gets ITS word back
    expect(partnerOrgsFromLage(placed, ['Rettungsdienst'])).toEqual(['Rettungsdienst'])
  })

  it('⚠️ never invents an organisation the station’s list does not carry', () => {
    expect(partnerOrgsFromLage([{ symbol: 'VKF Bereich Zivilschutz' }], PRESETS)).toEqual([])
  })

  // ⚠️ Deliberate: the Feuerwehr-Bereich is the OWN Wehr as often as a nachbarliche, and the
  // Sanitäts-Einrichtungen are set up by the Feuerwehr itself, before anybody from the Sanität
  // is on site. An offer that is wrong half the time is worse than no offer (appConfig.symbols).
  it('says nothing about the ambiguous symbols', () => {
    const placed = [
      { symbol: 'VKF Bereich Feuerwehr' },
      { symbol: 'VKF Sanitaetshilfsstelle' },
      { symbol: 'VKF Patientensammelstelle' },
      { symbol: 'VKF Feuer' },
      { symbol: undefined },
    ]
    expect(partnerOrgsFromLage(placed, [...PRESETS, 'Feuerwehr'])).toEqual([])
  })

  // Since unified objects the caller's union is entities + board, and ONE record shows up in
  // both views under the same id — three times when two georeferenced plans carry it.
  it('names one organisation once, however many views of the symbol arrive', () => {
    const onLage = { id: 'obj-1', symbol: 'VKF Bereich Polizei' }
    expect(partnerOrgsFromLage([onLage, { ...onLage }, { ...onLage }], PRESETS)).toEqual(['Polizei'])
  })
})

describe('partnerOrgOffer — angeboten wird nur, was noch fehlt', () => {
  it('offers what the sheet does not record yet', () => {
    expect(partnerOrgOffer(['Polizei', 'Sanität'], [{ org: 'polizei ' }])).toEqual(['Sanität'])
  })

  it('⚠️ offers nothing once every predicted organisation is ticked — the strip goes away', () => {
    expect(partnerOrgOffer(['Polizei'], [{ org: 'Polizei', note: 'Wm. Keller' }])).toBeNull()
  })

  it('offers nothing when the Kroki shows no partner at all', () => {
    expect(partnerOrgOffer([], [{ org: 'Polizei' }])).toBeNull()
  })

  it('comes back when the Kroki moves, whatever was ticked before', () => {
    expect(partnerOrgOffer(['Polizei', 'Sanität'], [{ org: 'Sanität' }])).toEqual(['Polizei'])
  })
})
