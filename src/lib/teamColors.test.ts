// Two Trupps on one Lage sharing a colour is the failure this module exists to stop — see the
// header of teamColors.ts for how the old pair of counters produced it.

import { describe, expect, it } from 'vitest'
import { appConfig } from '../config/appConfig'
import { pickTeamColor } from './teamColors'

const P = appConfig.drawing.teamColors

describe('pickTeamColor', () => {
  it('keeps the preferred colour when nothing else has it', () => {
    expect(pickTeamColor(P[3], [P[0], P[1]])).toBe(P[3])
  })

  it('steps aside when the preferred colour is already on the Lage', () => {
    const got = pickTeamColor(P[1], [P[0], P[1]])
    expect(got).not.toBe(P[1])
    expect(got).toBe(P[2])
  })

  it('gives a loose marker the first free colour, not a counter', () => {
    // the old bug: two markers placed after one deletion both landed on teamColors[1]
    expect(pickTeamColor(undefined, [P[0]])).toBe(P[1])
    expect(pickTeamColor(undefined, [P[0], P[1]])).toBe(P[2])
  })

  it('fills gaps left by a deleted Trupp instead of walking past them', () => {
    expect(pickTeamColor(undefined, [P[0], P[2], P[3]])).toBe(P[1])
  })

  it('ignores case and empty slots', () => {
    expect(pickTeamColor(undefined, [P[0].toUpperCase(), undefined, ''])).toBe(P[1])
  })

  it('wraps only once every colour is taken', () => {
    expect(pickTeamColor(P[4], P)).toBe(P[4])       // preferred wins the tie-break
    expect(P).toContain(pickTeamColor(undefined, P)) // …and a loose marker still gets a real colour
  })
})
