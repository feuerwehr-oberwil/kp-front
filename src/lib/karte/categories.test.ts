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
    // a key box falls to the catch-all
    expect(categoryOf(obj('depot', []), rules)?.id).toBe('rest')
  })

  it('every condition a rule names must hold', () => {
    const rules = categoryRules([{ id: 'kb', label: 'Schlüssel mit Plan', color: '#7c3aed', match: { kinds: ['depot'], modules: ['modul6'] } }])
    expect(categoryOf(obj('depot', []), rules)).toBeNull()
    expect(categoryOf(obj('einsatzobjekt', ['modul6']), rules)).toBeNull()
    expect(categoryOf(obj('depot', ['modul6']), rules)?.id).toBe('kb')
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
    expect(rules.map((r) => [r.id, r.label, r.color, r.kinds])).toEqual([['b', 'B', '#112233', null]])
  })

  it('labels per language, German then the first one as the fallback', () => {
    expect(categoryLabel({ de: 'Photovoltaik', fr: 'Photovoltaïque' }, 'fr', 'pv')).toBe('Photovoltaïque')
    expect(categoryLabel({ de: 'Photovoltaik' }, 'it', 'pv')).toBe('Photovoltaik')
    expect(categoryLabel({ en: 'Solar' }, 'it', 'pv')).toBe('Solar')
    expect(categoryLabel('', 'de', 'pv')).toBe('pv')
  })

  it('counts per category for the Ebenen rows', () => {
    const objs = [obj('einsatzobjekt', ['modul5-pv']), obj('einsatzobjekt', ['modul1']), obj('depot', [])] as StationObject[]
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
