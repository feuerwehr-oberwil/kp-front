import { describe, expect, it } from 'vitest'
import { gpsTwin, relabel } from './gpsTwin'
import type { Entity } from '../types'

const placed = (label: string): Entity => ({ id: 'p1', kind: 'symbol', layer: 'fahrzeuge', coord: [7.5, 47.5], symbol: 'VKF Fahrzeug', label })
const gps = (id: string, label: string, dLng: number): Entity =>
  ({ id, kind: 'vehicle', layer: 'fahrzeuge', coord: [7.5 + dLng, 47.5], label, live: true })

// owner picks UX journeys B3·33/34 (25.11.2026): one TLF or two?
describe('gpsTwin', () => {
  it('finds the GPS vehicle of the same name within 150 m, the nearest first', () => {
    const near = gps('gps-1', 'TLF', 0.0001) // ≈ 8 m
    const twin = gpsTwin(placed('tlf '), [gps('gps-2', 'TLF', 0.0015), near])
    expect(twin?.vehicle).toBe(near)
    expect(Math.round(twin?.distM ?? 0)).toBe(8)
  })
  it('says nothing for another name, a far one or an unnamed symbol', () => {
    expect(gpsTwin(placed('HLF'), [gps('gps-1', 'TLF', 0.0001)])).toBeNull()
    expect(gpsTwin(placed('TLF'), [gps('gps-1', 'TLF', 0.003)])).toBeNull() // ≈ 225 m
    expect(gpsTwin(placed(''), [gps('gps-1', '', 0)])).toBeNull()
  })
  it('stays quiet for a symbol the operator called a second vehicle («Sind zwei»)', () => {
    expect(gpsTwin({ ...placed('TLF'), gpsTwinOk: true }, [gps('gps-1', 'TLF', 0.0001)])).toBeNull()
  })
})

// owner pick, morning round 26.11.2026: «Sind zwei» was said about a name, so a rename asks again
describe('relabel', () => {
  const twins = [gps('gps-1', 'MTF', 0.0001)]
  it('a rename takes back «Sind zwei», and the renamed symbol is checked again', () => {
    const renamed = relabel({ ...placed('TLF'), gpsTwinOk: true }, 'MTF')
    expect(renamed).toMatchObject({ label: 'MTF', gpsTwinOk: undefined })
    expect(gpsTwin(renamed, twins)?.vehicle.id).toBe('gps-1')
  })
  it('the same name in another case or spacing keeps it', () => {
    expect(relabel({ ...placed('TLF'), gpsTwinOk: true }, 'tlf ')).toMatchObject({ label: 'tlf ', gpsTwinOk: true })
  })
})
