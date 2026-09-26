import { afterEach, describe, expect, it } from 'vitest'
import { CONTACT_ECHO_MS, OWN_REPEAT_MS, foreignContactAgo, isOwnContact, noteOwnContact, recentOwnContact, resetOwnContacts } from './contactEcho'
import type { TruppReading } from '../types'

afterEach(resetOwnContacts)

const NOW = Date.parse('2026-09-23T19:45:30.000Z')
const at = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString()
const trupp = (readings: TruppReading[]) => ({ id: 't1', readings })

describe('foreignContactAgo', () => {
  it('names a contact another device confirmed 21 s ago', () => {
    const t = trupp([{ t: at(600), bar: 300, kind: 'entry' }, { t: at(21), bar: 300, kind: 'contact' }])
    expect(foreignContactAgo(t, NOW)).toBe(21)
  })

  it('stays quiet for this device’s own contact — a double tap here is what it always was', () => {
    noteOwnContact('t1', at(5))
    expect(isOwnContact('t1', at(5))).toBe(true)
    expect(foreignContactAgo(trupp([{ t: at(5), bar: 300, kind: 'contact' }]), NOW)).toBeNull()
  })

  it('only the LATEST confirmation counts: this device answered after the other one', () => {
    noteOwnContact('t1', at(10))
    const t = trupp([{ t: at(40), bar: 300, kind: 'contact' }, { t: at(10), bar: 280, kind: 'pressure' }])
    expect(foreignContactAgo(t, NOW)).toBeNull()
  })

  it('asks nothing once the other confirmation is a minute old', () => {
    const t = trupp([{ t: new Date(NOW - CONTACT_ECHO_MS).toISOString(), bar: 300, kind: 'contact' }])
    expect(foreignContactAgo(t, NOW)).toBeNull()
    expect(foreignContactAgo(trupp([{ t: at(59), bar: 300, kind: 'contact' }]), NOW)).toBe(59)
  })

  it('counts a Druckmeldung, an Alarmdruck row, a Rückzug and a Fortsetzen as confirmations', () => {
    for (const kind of ['pressure', 'alarm', 'rueckzug', 'resume'] as const) {
      expect(foreignContactAgo(trupp([{ t: at(8), bar: 200, kind }]), NOW)).toBe(8)
    }
  })

  it('never reads the Eintritt, the Anmeldung or a crew row as a contact', () => {
    const t = trupp([
      { t: at(30), bar: 300, kind: 'registered' },
      { t: at(20), bar: 300, kind: 'entry' },
      { t: at(10), bar: 300, kind: 'crew', crew: { name: 'A', members: [] } },
    ])
    expect(foreignContactAgo(t, NOW)).toBeNull()
  })

  it('reads a stamp slightly ahead of this clock as «just now», never a negative age', () => {
    expect(foreignContactAgo(trupp([{ t: at(-2), bar: 300, kind: 'contact' }]), NOW)).toBe(0)
  })

  it('does not read a stamp from a skewed device, well in the future, as an echo', () => {
    expect(foreignContactAgo(trupp([{ t: at(-6), bar: 300, kind: 'contact' }]), NOW)).toBeNull()
    expect(foreignContactAgo(trupp([{ t: at(-40), bar: 300, kind: 'contact' }]), NOW)).toBeNull()
  })

  it('reads a second own contact on the same Trupp within 3 s as the same tap', () => {
    noteOwnContact('t1', at(1))
    expect(recentOwnContact('t1', NOW)).toBe(true)
    expect(recentOwnContact('t2', NOW)).toBe(false)
    expect(recentOwnContact('t1', Date.parse(at(1)) + OWN_REPEAT_MS)).toBe(false)
  })

  it('keeps the own-contact set per Trupp', () => {
    noteOwnContact('t2', at(5))
    expect(foreignContactAgo(trupp([{ t: at(5), bar: 300, kind: 'contact' }]), NOW)).toBe(5)
  })
})
