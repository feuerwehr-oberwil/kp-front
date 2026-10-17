import { describe, expect, it } from 'vitest'
import { categorize, categoryCounts, categoryId, categoryLabel, categoryOf, categoryRules, globToRegExp, inkOn, writableRules, type ObjectCategoryRule } from './categories'
import type { StationObject } from '../api/stationReference'
import { configRejections } from '../../admin/configSchema.test-utils'

const obj = (kind: StationObject['kind'], modules: string[]): Pick<StationObject, 'kind' | 'plans'> & { id: string } => ({
  id: `${kind}:${modules.join(',')}`,
  kind,
  plans: modules.map((m) => ({ id: `plan:x:${m}`, module: m, code: m, title: m, pages: null, georef: false, version: 1 })),
})

// the FWO proposal of review round 2 — PV amber, Wasser blue, Einsatzobjekte red, the rest slate
const FWO: ObjectCategoryRule[] = [
  { id: 'pv', label: { de: 'Photovoltaik', fr: 'Photovoltaïque' }, color: '#d97706', match: { modules: ['modul5-pv*'] } },
  { id: 'wasser', label: 'Wasser', color: '#2563eb', match: { modules: ['modul5-wasser*'] } },
  { id: 'einsatz', label: 'Einsatzobjekte', color: '#dc2626', match: { kinds: ['einsatzobjekt'] } },
  { id: 'rest', label: 'Übrige', color: '#64748b', match: {} },
]

describe('object categories', () => {
  it('globs: * any run, ? one character, case-insensitive, nothing else special', () => {
    expect(globToRegExp('modul5-pv*').test('modul5-pv15')).toBe(true)
    expect(globToRegExp('modul5-pv*').test('modul5-pv')).toBe(true)
    expect(globToRegExp('modul5-pv*').test('modul5-pvx')).toBe(true)
    expect(globToRegExp('modul5-pv*').test('modul5')).toBe(false)
    expect(globToRegExp('modul?').test('MODUL3')).toBe(true)
    expect(globToRegExp('modul1.2').test('modul1x2')).toBe(false)
  })

  it('first match wins, in the configured order', () => {
    const rules = categoryRules(FWO)
    // a PV sheet beats the Einsatzobjekt rule below it
    expect(categoryOf(obj('einsatzobjekt', ['modul1', 'modul5-pv20']), rules)?.id).toBe('pv')
    expect(categoryOf(obj('einsatzobjekt', ['modul5-wasser2']), rules)?.id).toBe('wasser')
    expect(categoryOf(obj('einsatzobjekt', ['modul1', 'modul6']), rules)?.id).toBe('einsatz')
    // a plan-less object falls to the catch-all
    expect(categoryOf(obj('objekt', []), rules)?.id).toBe('rest')
  })

  it('every condition a rule names must hold', () => {
    const rules = categoryRules([{ id: 'm6', label: 'Modul 6, Einsatzobjekt', color: '#7c3aed', match: { kinds: ['einsatzobjekt'], modules: ['modul6'] } }])
    expect(categoryOf(obj('einsatzobjekt', ['modul1']), rules)).toBeNull()
    expect(categoryOf(obj('objekt', []), rules)).toBeNull()
    expect(categoryOf(obj('einsatzobjekt', ['modul6']), rules)?.id).toBe('m6')
  })

  // review round 3 (17.10.2026): no key-box objects any more. A station config written for them
  // stays valid, and its `depot` rule paints nothing — never everything
  it('a rule for the retired «depot» kind matches no object', () => {
    const rules = categoryRules([
      { id: 'kb', label: 'Schlüsseldepots', color: '#7c3aed', match: { kinds: ['depot'] } },
      { id: 'mit', label: 'Mit Plänen', color: '#dc2626', match: { kinds: ['einsatzobjekt', 'depot'] } },
    ])
    expect(rules[0].kinds).toEqual([])
    expect(categoryOf(obj('objekt', []), rules)).toBeNull()
    expect(categoryOf(obj('einsatzobjekt', ['modul1']), rules)?.id).toBe('mit')
    expect(configRejections({ map: { objectCategories: [{ id: 'kb', label: 'K', color: '#7c3aed', match: { kinds: ['depot'] } }] } })).toEqual([])
  })

  it('no rules = today\'s look for everything', () => {
    expect(categoryRules(undefined)).toEqual([])
    expect(categorize([obj('einsatzobjekt', ['modul1']) as StationObject], []).size).toBe(0)
  })

  it('drops what would break the map: no id, no #rrggbb colour, a second rule with the same id', () => {
    const rules = categoryRules([
      { id: '', label: 'x', color: '#000000' },
      { id: 'a', label: 'A', color: 'red' },
      { id: 'b', label: 'B', color: '#112233', match: { kinds: ['nonsense' as never] } },
      { id: 'b', label: 'B2', color: '#445566' },
    ])
    // an unknown kind is no kind: the rule matches nothing rather than everything
    expect(rules.map((r) => [r.id, r.label, r.color, r.kinds])).toEqual([['b', 'B', '#112233', []]])
  })

  it('labels per language, German then the first one as the fallback', () => {
    expect(categoryLabel({ de: 'Photovoltaik', fr: 'Photovoltaïque' }, 'fr', 'pv')).toBe('Photovoltaïque')
    expect(categoryLabel({ de: 'Photovoltaik' }, 'it', 'pv')).toBe('Photovoltaik')
    expect(categoryLabel({ en: 'Solar' }, 'it', 'pv')).toBe('Solar')
    expect(categoryLabel('', 'de', 'pv')).toBe('pv')
  })

  it('counts per category for the Ebenen rows', () => {
    const objs = [obj('einsatzobjekt', ['modul5-pv']), obj('einsatzobjekt', ['modul1']), obj('objekt', [])] as StationObject[]
    const counts = categoryCounts(categorize(objs, categoryRules(FWO)))
    expect(Object.fromEntries(counts)).toEqual({ pv: 1, einsatz: 1, rest: 1 })
  })

  it('reads text on the colour: dark on amber, white on blue/red/slate', () => {
    expect(inkOn('#d97706')).toBe('#111418')
    expect(inkOn('#2563eb')).toBe('#ffffff')
    expect(inkOn('#dc2626')).toBe('#ffffff')
    expect(inkOn('#64748b')).toBe('#ffffff')
  })
})

describe('the admin editor\'s rules', () => {
  it('derives an id from the name, unique among the others', () => {
    expect(categoryId('Photovoltaik / PV', [])).toBe('photovoltaik-pv')
    expect(categoryId('Wässer', ['wasser'])).toBe('wasser-2')
    expect(categoryId('', [])).toBe('kategorie')
  })

  it('writes only what the server accepts, and that passes the API schema', () => {
    const rows: ObjectCategoryRule[] = [
      { id: 'pv', label: 'Photovoltaik', color: '#f59e0b', match: { modules: ['modul5-pv*'] } },
      { id: 'halb', label: '', color: '#123456' },
      { id: 'falsch', label: 'Falsch', color: 'blau' },
      { id: 'rest', label: { de: 'Übrige', fr: 'Autres' }, color: '#64748b', match: { kinds: ['objekt'] } },
    ]
    const ok = writableRules(rows)
    expect(ok.map((r) => r.id)).toEqual(['pv', 'rest'])
    expect(configRejections({ map: { objectCategories: ok } })).toEqual([])
    // …and the schema does refuse a rule without a colour (its pattern is the server's to check)
    expect(configRejections({ map: { objectCategories: [{ id: 'x', label: 'X' }] } }).join(' ')).toContain('objectCategories.0')
  })
})
