import { describe, expect, it } from 'vitest'
import { crewAfterChange, leaderByRank } from './truppLeader'
import { rankOrder } from './rank'

// No deployment config in the test env → the in-code Swiss default ranks (lib/rank).
const ranks: Record<string, string | undefined> = { lt: 'lt', kpl: 'kpl', kpl2: 'kpl', fwm: 'fwm', fwm2: 'fwm', gast: undefined }
const slot = (id: string) => ({ name: id, personId: id === 'gast' ? undefined : id })
const rankOf = (s: { personId?: string; name: string }) => rankOrder(ranks[s.personId ?? s.name])
const names = (t: { name: string }[]) => t.map((s) => s.name)

describe('leaderByRank', () => {
  it('puts the most senior member in front and keeps the others in order', () => {
    expect(names(leaderByRank(['fwm', 'kpl', 'lt'].map(slot), rankOf))).toEqual(['lt', 'fwm', 'kpl'])
  })
  it('keeps whoever is in front on a tie, then list order', () => {
    expect(names(leaderByRank(['kpl', 'kpl2'].map(slot), rankOf))).toEqual(['kpl', 'kpl2'])
    expect(names(leaderByRank(['fwm', 'kpl2', 'kpl'].map(slot), rankOf))).toEqual(['kpl2', 'fwm', 'kpl'])
  })
  it('leaves a crew without ranks (Gäste, a rankless roster) as it was picked', () => {
    const t = ['gast', 'gast'].map(slot)
    expect(leaderByRank(t, rankOf)).toBe(t)
  })
  it('a ranked member outranks a Gast', () => {
    expect(names(leaderByRank(['gast', 'fwm'].map(slot), rankOf))).toEqual(['fwm', 'gast'])
  })
  it('returns the same array when nothing moves (empty and single crews too)', () => {
    const t = ['lt', 'fwm'].map(slot)
    expect(leaderByRank(t, rankOf)).toBe(t)
    expect(leaderByRank([], rankOf)).toEqual([])
  })
})

describe('crewAfterChange', () => {
  it('follows the rank on every add while auto', () => {
    let st = crewAfterChange(['fwm'].map(slot), 'add', true, rankOf)
    st = crewAfterChange([...st.team, slot('lt')], 'add', st.auto, rankOf)
    expect(names(st.team)).toEqual(['lt', 'fwm'])
    st = crewAfterChange([...st.team, slot('kpl')], 'add', st.auto, rankOf)
    expect(names(st.team)).toEqual(['lt', 'fwm', 'kpl'])
    expect(st.auto).toBe(true)
  })
  it('hands the crown to the next most senior when the leader is removed', () => {
    const st = crewAfterChange(['fwm', 'kpl'].map(slot), 'remove', true, rankOf)
    expect(names(st.team)).toEqual(['kpl', 'fwm'])
  })
  it('a manual pick stops it for good', () => {
    let st = crewAfterChange(['fwm', 'lt'].map(slot), 'lead', true, rankOf)
    expect(st.auto).toBe(false)
    expect(names(st.team)).toEqual(['fwm', 'lt'])
    st = crewAfterChange([...st.team, slot('kpl')], 'add', st.auto, rankOf)
    expect(names(st.team)).toEqual(['fwm', 'lt', 'kpl'])
  })
  it('never moves the crown when auto is off (an existing Trupp)', () => {
    const st = crewAfterChange(['fwm', 'lt'].map(slot), 'add', false, rankOf)
    expect(names(st.team)).toEqual(['fwm', 'lt'])
    expect(st.auto).toBe(false)
  })
})
