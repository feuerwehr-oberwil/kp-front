import { describe, expect, it } from 'vitest'
import { isOvPath, ovHref, parseOvRoute, showsObjectVisits } from './route'

describe('Objektbesuche routes', () => {
  it('reads every address of the contract', () => {
    expect(parseOvRoute('/besuche', '')).toEqual({ kind: 'overview' })
    expect(parseOvRoute('/besuche/', '')).toEqual({ kind: 'overview' })
    expect(parseOvRoute('/besuche/ov1759473240123-0kf9', '')).toEqual({ kind: 'visit', id: 'ov1759473240123-0kf9' })
    expect(parseOvRoute('/besuche/ov1-ab', '?bearbeiten=1')).toEqual({ kind: 'visit', id: 'ov1-ab', edit: true })
    expect(parseOvRoute('/besuche/ov1-ab/antworten', '')).toEqual({ kind: 'answers', id: 'ov1-ab' })
    expect(parseOvRoute('/besuche/neu', '?object=fwo-schlue%3Aabc&ref=fwo-admin%3Afu-2026%2FB4'))
      .toEqual({ kind: 'new', object: 'fwo-schlue:abc', ref: 'fwo-admin:fu-2026/B4' })
    expect(parseOvRoute('/besuche', '?liste=fu%2FB4')).toEqual({ kind: 'list', ref: 'fu/B4' })
    expect(parseOvRoute('/', '')).toBeNull()
    expect(parseOvRoute('/besucherzahl', '')).toBeNull()
  })
  it('writes them back', () => {
    for (const r of [
      { kind: 'overview' as const }, { kind: 'list' as const, ref: 'fu/B4' }, { kind: 'visit' as const, id: 'ov1-ab' }, { kind: 'visit' as const, id: 'ov1-ab', edit: true }, { kind: 'answers' as const, id: 'ov1-ab' },
      { kind: 'new' as const, object: 'fwo-schlue:abc', ref: 'x/y' }, { kind: 'new' as const, object: 'u1', ref: null },
    ]) {
      const href = ovHref(r)
      const i = href.indexOf('?')
      expect(parseOvRoute(i < 0 ? href : href.slice(0, i), i < 0 ? '' : href.slice(i))).toEqual(r)
    }
  })
  it('reads a visit at a place and where it came from (contract C1)', () => {
    expect(parseOvRoute('/besuche/neu', '?lat=47.52015&lng=7.57175&label=bei%20Talholzstrasse%2015&address=Talholzstrasse%2015%2C%204103%20Bottmingen&from=karte'))
      .toEqual({ kind: 'newPlace', from: 'karte', place: { lat: 47.52015, lng: 7.57175, label: 'bei Talholzstrasse 15', address: 'Talholzstrasse 15, 4103 Bottmingen' } })
    // no address (reverse geocoding failed) and no label are still a place
    expect(parseOvRoute('/besuche/neu', '?lat=47.5&lng=7.5')).toEqual({ kind: 'newPlace', place: { lat: 47.5, lng: 7.5, label: '', address: null } })
    // a position that is not one is no place; an object wins over a position
    expect(parseOvRoute('/besuche/neu', '?lat=470&lng=7.5')).toEqual({ kind: 'new', object: '', ref: null })
    expect(parseOvRoute('/besuche/neu', '?lat=&lng=7.5')).toEqual({ kind: 'new', object: '', ref: null })
    expect(parseOvRoute('/besuche/neu', '?object=u1&lat=47.5&lng=7.5&from=karte')).toEqual({ kind: 'new', object: 'u1', ref: null, from: 'karte' })
    expect(parseOvRoute('/besuche/ov1-ab', '?from=karte')).toEqual({ kind: 'visit', id: 'ov1-ab', from: 'karte' })
    expect(parseOvRoute('/besuche/ov1-ab', '?from=elsewhere')).toEqual({ kind: 'visit', id: 'ov1-ab' })
    for (const r of [
      { kind: 'newPlace' as const, place: { lat: 47.52015, lng: 7.57175, label: 'bei Talholzstrasse 15', address: null }, from: 'karte' as const },
      { kind: 'newPlace' as const, place: { lat: 47.5, lng: 7.5, label: 'Talholzstrasse 15', address: 'Talholzstrasse 15, 4103 Bottmingen' } },
      { kind: 'visit' as const, id: 'ov1-ab', edit: true, from: 'karte' as const }, { kind: 'answers' as const, id: 'ov1-ab', from: 'karte' as const },
    ]) {
      const href = ovHref(r)
      const i = href.indexOf('?')
      expect(parseOvRoute(href.slice(0, i), href.slice(i))).toEqual(r)
    }
  })
  it('a malformed address does not throw', () => {
    expect(parseOvRoute('/besuche/%E0', '')).toEqual({ kind: 'visit', id: '%E0' })
  })
  it('knows its own paths', () => {
    expect(isOvPath('/besuche')).toBe(true)
    expect(isOvPath('/besuche/x')).toBe(true)
    expect(isOvPath('/admin')).toBe(false)
  })
  it('a back gesture onto /besuche never replaces an open Einsatz', () => {
    const on = { routeOn: true, entered: false, incidentOpen: true, linkSession: false }
    expect(showsObjectVisits(on)).toBe(false)
    expect(showsObjectVisits({ ...on, entered: true })).toBe(true) // the launcher / a deep link
    expect(showsObjectVisits({ ...on, incidentOpen: false })).toBe(true) // the launcher was behind it
    expect(showsObjectVisits({ ...on, entered: true, linkSession: true })).toBe(false)
    expect(showsObjectVisits({ ...on, routeOn: false, entered: true })).toBe(false)
  })
})
