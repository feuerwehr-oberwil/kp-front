// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { lastWith, rememberWith, splitPeople } from './devicePrefs'
import { loadPrefs } from '../lib/prefs'

describe('«Von» remembered on the device', () => {
  beforeEach(() => { document.cookie.split('; ').forEach((c) => { document.cookie = `${c.split('=')[0]}=; max-age=0; path=/` }) })

  it('splits typed names', () => {
    expect(splitPeople(' Muster Max, Frei Nina;  ')).toEqual(['Muster Max', 'Frei Nina'])
  })
  it('the next visit starts with the last names, and other prefs survive', () => {
    expect(lastWith()).toEqual([])
    rememberWith(['Muster Max', 'Frei Nina'])
    expect(lastWith()).toEqual(['Muster Max', 'Frei Nina'])
    rememberWith([])
    expect(lastWith()).toEqual([])
    expect(loadPrefs()).toHaveProperty('ovWith', '')
  })
})
