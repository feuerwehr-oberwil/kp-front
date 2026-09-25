import { describe, expect, it } from 'vitest'
import { emptySuche, ensureStoreyBereiche, parseZiel, setBereichStatus, sucheGroups, type SucheCx } from './suche'
import { floorLabel } from './whiteboard'

const cx = (): SucheCx => ({ at: '2026-09-23T20:30:00.000Z', newId: (p) => `${p}1`, floorName: floorLabel })

describe('a Trupp\'s Ziel as an area', () => {
  it('reads the storey off the front of the Ziel, the longest label first', () => {
    const floors = [0, 1, 11]
    expect(parseZiel('1. OG Trakt 3', floors, floorLabel)).toEqual({ floor: 1, name: 'Trakt 3' })
    expect(parseZiel('11. OG Aula', floors, floorLabel)).toEqual({ floor: 11, name: 'Aula' })
    expect(parseZiel('EG', floors, floorLabel)).toEqual({ floor: 0 })
    // a bare name lands on the storey the Trupp's marker stands on, or on none
    expect(parseZiel('Aula', floors, floorLabel, 1)).toEqual({ floor: 1, name: 'Aula' })
    expect(parseZiel('Ufer', [], floorLabel)).toEqual({ floor: undefined, name: 'Ufer' })
    expect(parseZiel('  ', floors, floorLabel)).toEqual({})
  })

  it('«teilweise» at Raus is said in the row, and the area stays open', () => {
    const d = setBereichStatus(ensureStoreyBereiche(emptySuche(), [1], '2026-09-23T19:36:00.000Z'), 'sbg1', 'inArbeit', { label: 'Trupp 4', id: 't4' }, cx()).doc
    const r = setBereichStatus(d, 'sbg1', 'offen', undefined, { ...cx(), newId: (p) => `${p}2` }, 'teilweise abgesucht')
    expect(r.rows[0].text).toBe('1. OG teilweise abgesucht')
    expect(sucheGroups(r.doc, [1], floorLabel)[0].units[0].status).toBe('offen')
  })
})
