import { describe, expect, it } from 'vitest'
import { parseDateTime, parseHHMM } from './TimeField'

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

describe('parseDateTime', () => {
  it('accepts TT.MM.JJJJ HH:MM with loose separators and 2-digit years', () => {
    expect(parseDateTime('14.7.2026 17:15')?.getTime()).toBe(new Date(2026, 6, 14, 17, 15).getTime())
    expect(parseDateTime('14.07.26 1715')?.getTime()).toBe(new Date(2026, 6, 14, 17, 15).getTime())
  })
  it('rejects impossible dates (31.02.) and junk', () => {
    expect(parseDateTime('31.02.2026 10:00')).toBeNull()
    expect(parseDateTime('kaputt')).toBeNull()
  })
})
