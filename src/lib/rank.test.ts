import { describe, expect, it } from 'vitest'
import { isOfficer, rankAbbr, rankLabel, rankOrder, rankTier } from './rank'

// No deployment config is loaded in the test env, so these exercise the in-code Swiss default
// (getDeploymentConfig() → {} → SWISS_DEFAULT_RANKS).

describe('rankOrder', () => {
  it('orders by seniority, most senior first', () => {
    expect(rankOrder('kdt')).toBe(0)
    expect(rankOrder('hptm')).toBeLessThan(rankOrder('fwm'))
    expect(rankOrder('lt')).toBeLessThan(rankOrder('kpl'))
  })
  it('sorts unknown/absent ranks last (Infinity)', () => {
    expect(rankOrder('nonesuch')).toBe(Infinity)
    expect(rankOrder(undefined)).toBe(Infinity)
    expect(rankOrder('fwm')).toBeLessThan(rankOrder(undefined))
  })
})

describe('tier helpers', () => {
  it('classifies officers, ncos, crew', () => {
    expect(rankTier('hptm')).toBe('officer')
    expect(rankTier('wm')).toBe('nco')
    expect(rankTier('fwm')).toBe('crew')
    expect(rankTier('nonesuch')).toBeUndefined()
  })
  it('isOfficer is true only for officer tier', () => {
    expect(isOfficer('lt')).toBe(true)
    expect(isOfficer('kpl')).toBe(false)
    expect(isOfficer(undefined)).toBe(false)
  })
})

describe('labels', () => {
  it('resolves label and abbr, empty for unknown', () => {
    expect(rankLabel('hptm')).toBe('Hauptmann')
    expect(rankAbbr('hptm')).toBe('Hptm')
    expect(rankLabel('nonesuch')).toBe('')
    expect(rankAbbr(undefined)).toBe('')
  })
})
