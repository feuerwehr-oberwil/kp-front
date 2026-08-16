import { describe, it, expect } from 'vitest'
import { configRejections } from './configSchema.test-utils'

// The guard the other suites lean on, held to its own standard: a validator that accepts
// everything is worse than none at all, because it makes the tests that use it read as coverage.
//
// Each case below is a document one of the Verwaltung controls actually produced. They are the
// answer to «would ONE shared helper have caught all three?» — it would, and it does.

describe('configRejections — what PUT /api/config would refuse', () => {
  it('accepts the document the Station pages write when nothing is wrong', () => {
    expect(configRejections({
      version: 'v1', // echoed back into the body; every model is extra="ignore", so it passes
      identity: { appName: 'Feuerwehr Steintal', accentColor: '#1d6f5c' },
      doctrine: { defaultFunkkanal: 11, cylinderLiters: 6.8, auftragColors: { loeschen: '#e8392b' } },
      report: { hoursRounding: { stepMin: 60, graceMin: 10 }, attendanceMergeGapMin: 15, partnerOrgs: [], links: [] },
      alarms: { autoArchiveDays: 7, staleIncidentDays: 30 },
    })).toEqual([])
  })

  it('refuses a null Auftrag colour — `dict[str, str]`, so the KEY has to go, not its value', () => {
    const errs = configRejections({ doctrine: { auftragColors: { retten: null } } })
    expect(errs.join(' ')).toContain('doctrine.auftragColors.retten')
    // …while the two shapes that mean «no colour» are both fine
    expect(configRejections({ doctrine: { auftragColors: null } })).toEqual([])
    expect(configRejections({ doctrine: { auftragColors: {} } })).toEqual([])
  })

  it('refuses a null Rundung — those three ints have no null, unlike the doctrine numbers', () => {
    expect(configRejections({ report: { hoursRounding: { stepMin: null } } }).join(' '))
      .toContain('report.hoursRounding.stepMin')
    expect(configRejections({ report: { attendanceMergeGapMin: null } }).join(' '))
      .toContain('report.attendanceMergeGapMin')
    // the doctrine ones ARE `int | None`, and the helper has to know the difference
    expect(configRejections({ doctrine: { defaultFunkkanal: null } })).toEqual([])
  })

  it('refuses a fraction where the schema says int, and honours every bound it carries', () => {
    expect(configRejections({ doctrine: { defaultFunkkanal: 8.5 } }).join(' ')).toContain('integer')
    expect(configRejections({ report: { hoursRounding: { stepMin: 0 } } }).join(' ')).toContain('minimum')
    expect(configRejections({ report: { hoursRounding: { stepMin: 481 } } }).join(' ')).toContain('maximum')
    expect(configRejections({ report: { attendanceMergeGapMin: 241 } }).join(' ')).toContain('maximum')
    // `gt=0`, not `ge=0`: a 0-litre cylinder is refused, 0.5 L is not
    expect(configRejections({ doctrine: { cylinderLiters: 0 } }).join(' ')).toContain('greater than')
    expect(configRejections({ doctrine: { cylinderLiters: 31 } }).join(' ')).toContain('maximum')
    expect(configRejections({ doctrine: { cylinderLiters: 0.5 } })).toEqual([])
  })

  it('walks into lists, because a config import is refused one entry at a time', () => {
    expect(configRejections({ mittel: { units: [{ id: 'x' }] } }).join(' ')).toContain('mittel.units.0')
    expect(configRejections({ fleet: { vehicles: [{ id: 'tlf-31', label: 'TLF 31' }] } })).toEqual([])
  })
})
