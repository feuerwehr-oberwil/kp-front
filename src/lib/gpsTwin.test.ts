import { describe, expect, it } from 'vitest'
import { gpsTwin } from './gpsTwin'
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
})
