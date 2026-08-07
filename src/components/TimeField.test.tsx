import { describe, expect, it } from 'vitest'
import { parseHHMM } from './TimeField'

describe('parseHHMM', () => {
  it('normalises hand-typed forms to 24h HH:MM', () => {
    expect(parseHHMM('715')).toBe('07:15')
    expect(parseHHMM('7:15')).toBe('07:15')
    expect(parseHHMM('19.30')).toBe('19:30')
    expect(parseHHMM('2359')).toBe('23:59')
  })
  it('rejects impossible clocks and junk', () => {
    expect(parseHHMM('2460')).toBeNull()
    expect(parseHHMM('abc')).toBeNull()
    expect(parseHHMM('')).toBeNull()
  })
})

