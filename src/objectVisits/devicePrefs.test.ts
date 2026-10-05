// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { lastWith, rememberWith, splitPeople } from './devicePrefs'
import { loadPrefs, savePrefs } from '../lib/prefs'

describe('«Von» remembered on the device', () => {
  beforeEach(() => {
    document.cookie.split('; ').forEach((c) => { document.cookie = `${c.split('=')[0]}=; max-age=0; path=/` })
    localStorage.clear()
  })

  it('splits typed names', () => {
    expect(splitPeople(' Muster Max, Frei Nina;  ')).toEqual(['Muster Max', 'Frei Nina'])
  })

  it('the next visit starts with the last names; clearing the field is remembered too', () => {
    expect(lastWith()).toEqual([])
    rememberWith(['Muster Max', 'Frei Nina'])
    expect(lastWith()).toEqual(['Muster Max', 'Frei Nina'])
    rememberWith([])
    expect(lastWith()).toEqual([])
  })

  it('lives in localStorage, not in the 7-day script cookie, and leaves the other prefs alone', () => {
    savePrefs({ theme: 'night' })
    rememberWith(['Muster Max'])
    expect(localStorage.getItem('kp.ov.with')).toBe('Muster Max')
    expect(loadPrefs()).toEqual({ theme: 'night' })
  })

  it('a name an older build left in the prefs cookie is still offered once', () => {
    savePrefs({ ovWith: 'Frei Nina' })
    expect(lastWith()).toEqual(['Frei Nina'])
    rememberWith(['Keller Urs'])
    expect(lastWith()).toEqual(['Keller Urs'])
  })
})
