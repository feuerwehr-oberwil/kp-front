import { describe, expect, it } from 'vitest'
import type { Trupp } from '../types'
import { notfallStrips, notfallTerms } from './notfall'

const t = (id: string): Trupp => ({ id, name: id, entryPressureBar: 300, entryTime: '', lastContactTime: '', status: 'aktiv', notfallAt: '2026-10-30T12:00:00Z' })

// Atemschutz-Link redesign R1 (30.10.2026): a Notfall on another tab is a red strip under the head
describe('notfallStrips — which red strips the link board shows', () => {
  it('none while the only Notfall is the open Trupp — its page says it', () => {
    expect(notfallStrips([t('a')], 'a')).toEqual([])
  })
  it('one strip per Notfall elsewhere, up to two', () => {
    expect(notfallStrips([t('a'), t('b')], 'x').map((s) => s.kind === 'one' && s.t.id)).toEqual(['a', 'b'])
    expect(notfallStrips([t('a'), t('b'), t('c')], 'a').map((s) => s.kind === 'one' && s.t.id)).toEqual(['b', 'c'])
  })
  it('from three on, ONE strip that counts them and goes to the first', () => {
    expect(notfallStrips([t('a'), t('b'), t('c')], 'x')).toEqual([{ kind: 'many', count: 3, goTo: 'a' }])
  })
})

describe('notfallTerms — how a sentence names a Trupp in Notfall', () => {
  it('the number, the term before 12.09. and the lead, of Trupps in Notfall only', () => {
    expect(notfallTerms([{ ...t('Weber Fabian'), no: 2 }, { ...t('Roth Simon'), notfallAt: undefined }]))
      .toEqual(['Trupp 2', 'Trupp Weber Fabian', 'Weber Fabian'])
  })
})
