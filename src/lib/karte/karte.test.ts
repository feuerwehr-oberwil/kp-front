import { describe, it, expect, beforeEach } from 'vitest'
import type { LngLat, LayerDef } from '../../types'
import type { StationObject } from '../api/stationReference'
import type { DeploymentModule } from '../deploymentConfig'
import { normText, openableCount, searchObjects } from './search'
import {
  nearbyObjects, nearestPoints, normAddress, objectAtAddress, splitAddress, objectVisitHref, outlineFor, pinNear, placeVisitHref,
  pointsFromGeoJson, ringAt, ringsFromOverpass, streetKey,
  nameIsAddress, nameSaysAddress, objectAddress, objectHeadSub, objectRowSub,
} from './places'
import { isKartePath, karteHref, parseKarteRoute } from './route'
import { KARTE_LAYER_PREFS_ID, karteViewSnapshot, loadKarteView, saveKarteView, saveViewerLayerPrefs, viewerLayers } from './session'

// Synthetic station data only (the mockup's Musterdorf).
const obj = (o: Partial<StationObject> & Pick<StationObject, 'id' | 'name'>): StationObject => ({
  kind: 'objekt', address: null, lat: null, lng: null, aliases: [], plans: [], floors: [], egid: null,
  footprint: null, lastVisit: null, ...o,
})
const plan = (code: string) => ({ id: `plan:x:modul${code}`, module: `modul${code}`, code, title: `Modul ${code}`, pages: null, georef: false, version: 1 })
const SCHLOSS = obj({ id: 'schloss', name: 'Schloss Musterdorf', kind: 'einsatzobjekt', address: 'Schlossgasse 9', lat: 47.523773, lng: 7.570188, aliases: ['Wasserschloss'], plans: [plan('1'), plan('6')], floors: [{ index: 0, name: null }] })
const DEPOT = obj({ id: 'depot', name: 'Schlüsseldepot Schloss', kind: 'depot', address: 'Schlossgasse 9', lat: 47.52402, lng: 7.56985 })
const SCHULE = obj({ id: 'schule', name: 'Schulhaus Lindenhof', kind: 'einsatzobjekt', address: 'Schulstrasse 5, 9999 Musterdorf', lat: 47.521982, lng: 7.572289, plans: [plan('1')] })
const PUMPWERK = obj({ id: 'pump', name: 'Pumpwerk Burggarten', address: 'Burggartenstrasse 15a', aliases: ['Filterhaus'] })
const MAGAZIN = obj({ id: 'mag', name: 'Feuerwehrmagazin', address: 'Therwilerstrasse 14a', lat: 47.522901, lng: 7.570679 })
const ALL = [SCHLOSS, DEPOT, SCHULE, PUMPWERK, MAGAZIN]
const CENTER: LngLat = [7.5703, 47.5231]

describe('search', () => {
  it('folds case, diacritics and ß', () => {
    expect(normText('  Schlüssel  Straße ')).toBe('schlussel strasse')
  })

  it('ranks the name before the alias before the address, objects with plans first', () => {
    const names = searchObjects(ALL, 'Schloss', CENTER).map((h) => h.obj.id)
    // both names START with the word; the one with plans comes first, the key box last
    expect(names).toEqual(['schloss', 'depot'])
    expect(searchObjects(ALL, 'wasserschloss').map((h) => h.obj.id)).toEqual(['schloss'])
    expect(searchObjects(ALL, 'schlossgasse').map((h) => h.obj.id)).toEqual(['schloss', 'depot'])
  })

  it('finds a key box by its word and an umlaut typed without one', () => {
    expect(searchObjects(ALL, 'Schlussel').map((h) => h.obj.id)).toEqual(['depot'])
  })

  it('needs every word of a multi-word query', () => {
    expect(searchObjects(ALL, 'schloss 9').map((h) => h.obj.id)).toEqual(['schloss', 'depot'])
    expect(searchObjects(ALL, 'schloss lindenhof')).toEqual([])
  })

  it('finds objects without coordinates and marks them approximate', () => {
    const [hit] = searchObjects(ALL, 'filter', CENTER)
    expect(hit.obj.id).toBe('pump')
    expect(hit.approx).toBe(true)
    expect(hit.distanceM).toBeNull()
  })

  it('breaks a tie by distance from the map centre', () => {
    const far = obj({ id: 'far', name: 'Schulhaus Nord', address: 'Nordweg 1', lat: 47.6, lng: 7.6, kind: 'einsatzobjekt', plans: [plan('1')] })
    expect(searchObjects([far, SCHULE], 'schulhaus', CENTER).map((h) => h.obj.id)).toEqual(['schule', 'far'])
  })

  it('says nothing for an empty query and counts what an object opens', () => {
    expect(searchObjects(ALL, '   ')).toEqual([])
    expect(openableCount(SCHLOSS)).toBe(3)
    expect(openableCount(DEPOT)).toBe(0)
  })
})

describe('places', () => {
  it('keys an address by street and number only', () => {
    expect(splitAddress('Schlossgasse 9 4103 Bottmingen')).toEqual(['Schlossgasse 9', '4103 Bottmingen'])
    expect(splitAddress('Schloss # 6246 Altishofen')).toEqual(['Schloss', '6246 Altishofen'])
    expect(splitAddress('Feldweg')).toEqual(['Feldweg', ''])
    expect(normAddress('Schlossgasse 9 4103 Bottmingen')).toBe('Schlossgasse 9, 4103 Bottmingen')
    expect(streetKey('Schlossgasse 9 4103 Bottmingen')).toBe('schlossgasse9')
    expect(streetKey('Hauptstrasse 10, 4104 Oberwil')).toBe('hauptstrasse10')
    expect(streetKey('Mühlemattstrasse 22')).toBe(streetKey('Muhlemattstrasse 22'))
  })

  it('names an object only on an exact address, never the key box at the same door', () => {
    expect(objectAtAddress(ALL, 'Schlossgasse 9, 9999 Musterdorf')?.id).toBe('schloss')
    expect(objectAtAddress(ALL, 'Schlossgasse 11, 9999 Musterdorf')).toBeNull()
    expect(objectAtAddress([DEPOT], 'Schlossgasse 9')).toBeNull()
    expect(objectAtAddress(ALL, '')).toBeNull()
  })

  it('lists what is near by distance only, nearest first, never the object itself', () => {
    const near = nearbyObjects(ALL, [SCHLOSS.lng!, SCHLOSS.lat!], { exceptId: 'schloss' })
    expect(near.map((n) => n.item.id)).toEqual(['depot', 'mag'])
    expect(near[0].distanceM).toBeGreaterThan(20)
    expect(near[0].distanceM).toBeLessThan(60)
    // the Schulhaus is ~250 m away: outside the radius, not «in der Nähe»
    expect(near.some((n) => n.item.id === 'schule')).toBe(false)
  })

  it('takes the nearest points whatever the distance', () => {
    const pts = pointsFromGeoJson({ features: [
      { geometry: { type: 'Point', coordinates: [7.5704, 47.5238] }, properties: { name: 'H-101' } },
      { geometry: { type: 'Point', coordinates: [7.58, 47.53] }, properties: { nr: 7 } },
      { geometry: { type: 'LineString', coordinates: [[7, 47], [7.1, 47.1]] }, properties: {} },
    ] }, 'h')
    expect(pts.map((p) => p.label)).toEqual(['H-101', '7'])
    expect(nearestPoints(pts, [SCHLOSS.lng!, SCHLOSS.lat!], 1).map((n) => n.item.label)).toEqual(['H-101'])
    expect(pointsFromGeoJson(null)).toEqual([])
  })

  it('names a pin after an address only when it is close', () => {
    const at: LngLat = [7.57175, 47.52015]
    expect(pinNear({ label: 'Starenstrasse 19, 9999 Musterdorf', lat: 47.52016, lng: 7.5716 }, at)?.label).toBe('Starenstrasse 19')
    expect(pinNear({ label: 'Weit weg 1', lat: 47.53, lng: 7.58 }, at)).toBeNull()
    // the geocoder answers with the asked point: near, distance unknown
    expect(pinNear({ label: 'Starenstrasse 19, 9999 Musterdorf', lat: at[1], lng: at[0] }, at)).toEqual({ label: 'Starenstrasse 19', distanceM: null })
    expect(pinNear(null, at)).toBeNull()
  })

  it('outlines an object only with the ring that CONTAINS its point', () => {
    const square = (cx: number, cy: number, d: number): LngLat[] => [[cx - d, cy - d], [cx + d, cy - d], [cx + d, cy + d], [cx - d, cy + d], [cx - d, cy - d]]
    const big = square(7.5702, 47.5237, 0.0004)
    const small = square(7.570188, 47.523773, 0.0001)
    const neighbour = square(7.5712, 47.5237, 0.0001)
    expect(outlineFor(SCHLOSS, [big, small, neighbour])).toBe(small)
    // a ring that is merely close is not the building
    expect(outlineFor(SCHLOSS, [neighbour])).toBeNull()
    expect(outlineFor(DEPOT, [square(DEPOT.lng!, DEPOT.lat!, 0.001)])).toBeNull()
    expect(outlineFor(PUMPWERK, [big])).toBeNull()
    expect(ringAt([small], [7.5, 47.5])).toBeNull()
  })

  it('reads Overpass ways and the outer ways of relations', () => {
    const g = [{ lat: 1, lon: 2 }, { lat: 1, lon: 3 }, { lat: 2, lon: 3 }]
    const rings = ringsFromOverpass({ elements: [
      { type: 'way', geometry: g },
      { type: 'relation', members: [{ type: 'way', role: 'outer', geometry: g }, { type: 'way', role: 'inner', geometry: g }] },
      { type: 'way', geometry: g.slice(0, 2) },
    ] })
    expect(rings).toHaveLength(2)
    expect(rings[0][0]).toEqual([2, 1])
  })

  it('links visits per contract C1', () => {
    expect(objectVisitHref('u-1')).toBe('/besuche/neu?object=u-1&from=karte')
    // «Melden»: the same visit, its checklist asked for up front
    expect(objectVisitHref('u-1', 'fehlermeldung')).toBe('/besuche/neu?object=u-1&checkliste=fehlermeldung&from=karte')
    expect(new URLSearchParams(placeVisitHref({ at: [7, 47], label: 'Gesetzter Punkt', checklist: 'fehlermeldung' }).split('?')[1]).get('checkliste')).toBe('fehlermeldung')
    const href = placeVisitHref({ at: [7.57175, 47.52015], label: 'bei Talholzstrasse 15', address: 'Talholzstrasse 15, 4103 Bottmingen' })
    const q = new URLSearchParams(href.split('?')[1])
    expect(href.startsWith('/besuche/neu?')).toBe(true)
    expect(q.get('lat')).toBe('47.520150')
    expect(q.get('lng')).toBe('7.571750')
    expect(q.get('label')).toBe('bei Talholzstrasse 15')
    expect(q.get('address')).toBe('Talholzstrasse 15, 4103 Bottmingen')
    expect(q.get('from')).toBe('karte')
    expect(new URLSearchParams(placeVisitHref({ at: [7, 47], label: 'Gesetzter Punkt' }).split('?')[1]).has('address')).toBe(false)
  })
})

describe('an object\'s address (review round 2: the address, never «Schlüsseldepot» in its place)', () => {
  const KIND = 'Schlüsseldepot'
  it('knows a name that is an address', () => {
    for (const n of ['Mühlemattstrasse 24', 'Schulstrasse 4', 'Bienenstrasse 28 (EH)', 'Hauptstr. 10a', 'Im Gwidum 3']) expect(nameIsAddress(n), n).toBe(true)
    for (const n of ['Gemeindehaus Musterdorf', 'Schlüsseldepot Schloss', 'ARA Birsig', '', '24 Mühlemattstrasse']) expect(nameIsAddress(n), n).toBe(false)
  })
  it('takes the stored address, else the name when it is one, else none', () => {
    expect(objectAddress({ name: 'Schloss Musterdorf', address: 'Schlossgasse 9' })).toBe('Schlossgasse 9')
    expect(objectAddress({ name: 'Mühlemattstrasse 24', address: null })).toBe('Mühlemattstrasse 24')
    expect(objectAddress({ name: 'Mühlemattstrasse 24', address: '  ' })).toBe('Mühlemattstrasse 24')
    expect(objectAddress({ name: 'ARA Birsig', address: null })).toBeNull()
    // the town only when the server says it is not the home town, never twice
    expect(objectAddress({ name: 'ARA Birsig', address: 'Erlenstrasse 60', locality: 'Therwil' })).toBe('Erlenstrasse 60, Therwil')
    expect(objectAddress({ name: 'ARA Birsig', address: 'Erlenstrasse 60, 4106 Therwil', locality: 'Therwil' })).toBe('Erlenstrasse 60, 4106 Therwil')
    expect(objectHeadSub({ name: 'Erlenstrasse 60', address: null, locality: 'Therwil' })).toBe('Therwil')
  })
  it('sees when the name already says the street and number', () => {
    expect(nameSaysAddress({ name: 'Mühlemattstrasse 24', address: 'Muehlemattstrasse 24, 4104 Oberwil' })).toBe(false) // ü ≠ ue: printed both
    expect(nameSaysAddress({ name: 'Mühlemattstrasse 24', address: 'Mühlemattstrasse 24, 4104 Oberwil' })).toBe(true)
    expect(nameSaysAddress({ name: 'Bienenstrasse 28 (EH)', address: 'Bienenstrasse 28' })).toBe(true)
    expect(nameSaysAddress({ name: 'Therwilerstrasse 18a', address: 'Therwilerstrasse 18' })).toBe(false)
    expect(nameSaysAddress({ name: 'Schlüsseldepot Schloss', address: 'Schlossgasse 9' })).toBe(false)
  })
  it('prints a list row: the address, or once in the title with the place and the kind under it', () => {
    expect(objectRowSub(DEPOT, KIND)).toBe('Schlossgasse 9')
    expect(objectRowSub({ name: 'Mühlemattstrasse 24', address: null }, KIND)).toBe(KIND)
    expect(objectRowSub({ name: 'Mühlemattstrasse 24', address: 'Mühlemattstrasse 24, 4104 Oberwil' }, KIND)).toBe('4104 Oberwil · Schlüsseldepot')
    expect(objectRowSub({ name: 'ARA Birsig', address: null }, 'Stationsobjekt')).toBe('Stationsobjekt')
  })
  it('prints the head (whose kicker says the kind): the address, the place alone, or nothing', () => {
    expect(objectHeadSub(SCHULE)).toBe('Schulstrasse 5, 9999 Musterdorf')
    expect(objectHeadSub({ name: 'Erlenstrasse 60', address: 'Erlenstrasse 60, 4106 Therwil' })).toBe('4106 Therwil')
    expect(objectHeadSub({ name: 'Schulstrasse 4', address: null })).toBeNull()
    expect(objectHeadSub({ name: 'ARA Birsig', address: null })).toBeNull()
  })
})

describe('route', () => {
  it('reads and writes /karte?objekt=', () => {
    expect(isKartePath('/karte')).toBe(true)
    expect(isKartePath('/karten')).toBe(false)
    expect(parseKarteRoute('/karte', '?objekt=abc')).toEqual({ objekt: 'abc' })
    expect(parseKarteRoute('/karte', '')).toEqual({ objekt: null })
    expect(parseKarteRoute('/besuche', '?objekt=abc')).toBeNull()
    expect(karteHref({ objekt: 'a b' })).toBe('/karte?objekt=a+b')
    expect(karteHref()).toBe('/karte')
  })
})

// Node has no Web Storage in this suite (see lib/layerPrefs.test.ts): a stand-in that records every
// key written, so the test can say exactly what the viewer persisted.
const stores = { local: new Map<string, string>(), session: new Map<string, string>() }
const storage = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => { m.set(k, String(v)) },
  removeItem: (k: string) => { m.delete(k) },
  clear: () => m.clear(),
})
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage(stores.local) })
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage(stores.session) })

describe('session — the temporary-measure guard', () => {
  beforeEach(() => { stores.local.clear(); stores.session.clear() })

  it('persists the view and nothing temporary', () => {
    const state = {
      center: CENTER, zoom: 17, bearing: 0, objectId: 'schloss', surface: { plan: 'plan:x:modul1' },
      tool: 'erg' as const, label: 'Schloss Musterdorf · Modul 1',
      // what the viewer holds besides the view — none of it may reach storage
      measure: { mode: 'line', path: [CENTER, [7.571, 47.524]] },
      erg: { un: '1203', ring: 'small', center: CENTER },
      pin: CENTER,
    }
    expect(Object.keys(karteViewSnapshot(state))).toEqual(['center', 'zoom', 'bearing', 'objectId', 'surface', 'tool', 'label'])
    saveKarteView(state)
    expect([...stores.session.keys()]).toEqual(['kp.karte.view'])
    expect([...stores.local.keys()]).toEqual([])
    const raw = stores.session.get('kp.karte.view')!
    // the open tool is kept by name — never what is in it
    expect(raw).not.toMatch(/measure|path|pin|1203|small/)
    expect(loadKarteView()).toEqual({
      center: CENTER, zoom: 17, bearing: 0, objectId: 'schloss', surface: { plan: 'plan:x:modul1' }, tool: 'erg', label: 'Schloss Musterdorf · Modul 1',
    })
  })

  it('restores only the tools worth reopening, and no label without a selection', () => {
    saveKarteView({ center: CENTER, zoom: 15, bearing: 0, objectId: null, surface: 'karte', tool: 'pin' as never, label: '  ' })
    expect(loadKarteView()).toMatchObject({ tool: null, label: null })
    saveKarteView({ center: CENTER, zoom: 15, bearing: 0, objectId: null, surface: 'karte' })
    expect(loadKarteView()).toMatchObject({ tool: null, label: null })
  })

  it('forgets a garbled view instead of throwing', () => {
    stores.session.set('kp.karte.view', '{"center":"x"}')
    expect(loadKarteView()).toBeNull()
    stores.session.set('kp.karte.view', 'not json')
    expect(loadKarteView()).toBeNull()
  })

  it('keeps its Ebenen under its own key and drops the Einsatz-only layers', () => {
    const layers: LayerDef[] = [
      { id: 'base-carto', group: 'Basis', label: 'Carto', icon: 'map', base: true, visible: true },
      { id: 'base-osm', group: 'Basis', label: 'OSM', icon: 'map', base: true, visible: false },
      { id: 'taktisch', group: 'Inhalte', label: 'Taktische Zeichen', icon: 'hex', visible: true },
      { id: 'markup', group: 'Inhalte', label: 'Skizzen', icon: 'area', visible: true },
      { id: 'personen', group: 'Inhalte', label: 'Personen', icon: 'people', visible: true },
      { id: 'fahrzeuge', group: 'Inhalte', label: 'Fahrzeuge', icon: 'truck', visible: true },
    ]
    const mine = viewerLayers(layers, undefined)
    expect(mine.map((l) => l.id)).toEqual(['base-carto', 'base-osm', 'fahrzeuge'])
    saveViewerLayerPrefs(mine.map((l) => (l.id === 'fahrzeuge' ? { ...l, visible: false } : l)))
    expect([...stores.local.keys()]).toEqual([`kp.layers.${KARTE_LAYER_PREFS_ID}`])
    const again = viewerLayers(layers, JSON.parse(stores.local.get('kp.layers.karte')!))
    expect(again.find((l) => l.id === 'fahrzeuge')?.visible).toBe(false)
    // a stored set without any base falls back to the defaults
    expect(viewerLayers(layers, [{ id: 'base-carto', visible: false }]).find((l) => l.id === 'base-carto')?.visible).toBe(true)
  })
})

describe('plans as the rail documents', () => {
  it('turns the modules into monogram documents on the current revision, Gebäude last', async () => {
    const { viewerPlanDocs, planDocId, GEBAEUDE_DOC } = await import('./plans')
    const { planGlyph } = await import('../navRail')
    expect(planDocId({ module: 'modul23', id: 'x' })).toBe('modul2-3')
    expect(planDocId({ module: 'modul5-wasser', id: 'x' })).toBe('modul5-wasser')
    const o = obj({ id: 'o', name: 'O', plans: [plan('1'), { ...plan('23'), version: 4 }, plan('1')], floors: [{ index: 0, name: null }] })
    const docs = viewerPlanDocs(o, 'Gebäude')
    expect(docs.map((d) => d.doc.id)).toEqual(['modul1', 'modul2-3', 'modul12', GEBAEUDE_DOC])
    expect(docs[1].doc.imageUrl).toBe('/api/reference/plan%3Ax%3Amodul23?v=4')
    expect(planGlyph(docs[1].doc)).toEqual({ mono: '2/3' })
    expect(planGlyph(docs[3].doc)).toEqual({ icon: 'floors' })
    expect(viewerPlanDocs({ plans: [], floors: [] }, 'Gebäude')).toEqual([])
  })

  // the station's real catalogue (kp-front-data · oberwil.config.json), the fields the rule reads
  const STATION: DeploymentModule[] = [
    { id: 'modul1', code: 'Modul 1', title: 'Übersicht' },
    { id: 'modul2', code: 'Modul 2', title: 'Wie komme ich herein' },
    { id: 'modul2-3', code: 'Modul 2/3', title: 'Zugang & Objekt' },
    { id: 'modul5', code: 'M5', title: 'Spezialpläne', family: true },
    { id: 'modul5-pv', code: 'PV', title: 'Photovoltaik', viewer: true },
    { id: 'modul5-wasser', code: 'W', title: 'Wasser' },
  ]
  const p = (module: string, title: string) => ({ id: `plan:x:${module}`, module, title })

  it('names a file-name title by the module catalogue (owner R2 · real titles)', async () => {
    const { planTitle } = await import('./plans')
    expect(planTitle(p('modul2', 'Migros – modul2'), STATION)).toBe('Wie komme ich herein')
    expect(planTitle(p('modul5-pv', 'Bruderholzstrasse 150 – modul5-pv'), STATION)).toBe('Photovoltaik')
    // a dash inside the object's own name is not the one before the key
    expect(planTitle(p('modul23', 'Sägestrasse 8 - Schulhaus Hüslimatt – modul2-3'), STATION)).toBe('Zugang & Objekt')
  })

  it('keeps a clean title, and says a key the catalogue cannot name in words', async () => {
    const { planTitle } = await import('./plans')
    expect(planTitle(p('modul1', 'Übersicht'), STATION)).toBe('Übersicht')
    expect(planTitle(p('modul5-pv', 'Photovoltaik'), STATION)).toBe('Photovoltaik')
    expect(planTitle(p('modul1', 'Gemeindehaus – Übersicht'), STATION)).toBe('Gemeindehaus – Übersicht')
    // a second waterplan keeps its number; a family sub-slot without an entry says its own name
    expect(planTitle(p('modul5-wasser2', 'Im Wasen – modul5-wasser2'), STATION)).toBe('Wasser 2')
    expect(planTitle(p('modul5-rwa', 'Im Wasen – modul5-rwa'), STATION)).toBe('RWA')
    expect(planTitle(p('modul7', 'Im Wasen – modul7'), STATION)).toBe('Modul 7')
    // no catalogue at all (and an untitled sheet): the key in words, never an empty row
    expect(planTitle(p('modul2', 'Migros – modul2'), [])).toBe('Modul 2')
    expect(planTitle(p('modul4', ''), STATION)).toBe('Modul 4')
  })

  it('the rail documents carry the rule and the catalogue\'s plain reader', async () => {
    const { viewerPlanDocs } = await import('./plans')
    const o = obj({ id: 'o', name: 'O', plans: [{ ...plan('2'), title: 'Migros – modul2' }, { ...plan('5-pv'), title: 'Migros – modul5-pv' }], floors: [] })
    const docs = viewerPlanDocs(o, 'Gebäude', STATION)
    expect(docs.map((d) => d.doc.title)).toEqual(['Wie komme ich herein', 'Photovoltaik'])
    expect(docs.map((d) => !!d.doc.viewer)).toEqual([false, true])
  })
})

describe('outline cells', () => {
  it('covers a box with cells, nearest the centre first, and names a point\'s cell', async () => {
    const { cellsFor, cellOf, cellBox, MAX_CELLS } = await import('./outlines')
    const keys = cellsFor(7.565, 47.52, 7.575, 47.526)
    expect(keys.length).toBeGreaterThan(1)
    expect(keys.length).toBeLessThanOrEqual(MAX_CELLS)
    const c = cellOf([7.570188, 47.523773])
    const b = cellBox(c)
    expect(7.570188).toBeGreaterThanOrEqual(b.west)
    expect(7.570188).toBeLessThan(b.east)
    expect(47.523773).toBeGreaterThanOrEqual(b.south)
    expect(47.523773).toBeLessThan(b.north)
    expect(keys).toContain(c)
  })
})
