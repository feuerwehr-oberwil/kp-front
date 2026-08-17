import { describe, expect, it } from 'vitest'
import { startChips } from './startChips'
import type { TimelineEvent } from '../types'

const row = (text: string): TimelineEvent =>
  ({ id: `e${text}`, t: '22:00', at: '2026-08-17T20:00:00.000Z', icon: 'type', text, kind: 'journal', surface: 'map' })

const PHRASES = ['Rekognoszierung läuft', 'Rückmeldung an ELZ', 'Feuer aus', 'Polizei aufgeboten']

describe('startChips', () => {
  it('leads with the opener — a Funkprotokoll starts with a post, not with a word', () => {
    const [first] = startChips([], PHRASES, 'EL →')
    expect(first).toEqual({ label: 'EL →', insert: 'EL → ', kind: 'opener' })
  })

  // ⚠️ The point of learning from the incident: the second «Rückmeldung an ELZ» of the night beats
  // whatever the list happens to have at the top, and nobody had to configure it.
  it('offers what this Einsatz has already written, most-used first', () => {
    const tl = [
      row('Auftrag · Rückmeldung an ELZ'),
      row('Rückmeldung an ELZ'),
      row('Polizei aufgeboten'),
    ]
    expect(startChips(tl, PHRASES, 'EL →').map((c) => c.label))
      .toEqual(['EL →', 'Rückmeldung an ELZ', 'Polizei aufgeboten', 'Rekognoszierung läuft'])
  })

  it('falls back to the station list, in the station order — an Einsatz starts empty', () => {
    expect(startChips([], PHRASES, 'EL →').map((c) => c.label))
      .toEqual(['EL →', 'Rekognoszierung läuft', 'Rückmeldung an ELZ', 'Feuer aus'])
  })

  it('never repeats a phrase, and honours the limit', () => {
    const tl = [row('Feuer aus'), row('Feuer aus')]
    const chips = startChips(tl, PHRASES, 'EL →', 3)
    expect(chips).toHaveLength(3)
    expect(new Set(chips.map((c) => c.label)).size).toBe(3)
    expect(chips[1].label).toBe('Feuer aus')
  })

  it('works for a station that configured nothing at all', () => {
    expect(startChips([], [], 'EL →').map((c) => c.label)).toEqual(['EL →'])
    expect(startChips([], [])).toEqual([])
  })
})
