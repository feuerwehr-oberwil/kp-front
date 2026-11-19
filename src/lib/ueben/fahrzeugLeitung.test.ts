import { describe, expect, it } from 'vitest'
import { appConfig } from '../../config/appConfig'
import type { Drawing, Entity, LngLat } from '../../types'
import { fahrzeugLeitung } from './fahrzeugLeitung'
import { goalStates, nextGoal, type SolveApi, type UiState } from './model'
import { offsetM, SITE_IDS, siteOf, siteScene } from './site'

const C: LngLat = [7.57, 47.52]
const scene = siteScene(C)
const h1 = scene.entities.find((e) => e.id === SITE_IDS.h1)!
const eingang = scene.entities.find((e) => e.id === SITE_IDS.eingang)!

const vehicle = (coord: LngLat, label = 'TLF', id = 'v1'): Entity =>
  ({ id, kind: 'symbol', layer: 'fahrzeuge', coord, symbol: appConfig.symbols.vehicleName, label })
const line = (coords: LngLat[], over: Partial<Drawing> = {}): Drawing => ({ id: 'l1', kind: 'line', coords, ...over })

function states(extra: Entity[], drawings: Drawing[] = []) {
  const entities = [...scene.entities, ...extra]
  return goalStates(fahrzeugLeitung, { entities, drawings }, siteOf(entities))
}

describe('Fahrzeug mit Leitung · goals', () => {
  it('starts with both goals open', () => {
    expect(states([]).map((s) => s.s)).toEqual(['open', 'open'])
  })

  it('a TLF beside H1 is right; one 80 m off is wrong, with the distance', () => {
    expect(states([vehicle(offsetM(h1.coord, 8, 4))])[0]).toEqual({ s: 'ok' })
    const far = states([vehicle(offsetM(h1.coord, 80, 0))])[0]
    expect(far).toEqual({ s: 'wrong', reason: 'TLF steht 80 m von H1' })
  })

  it('a Fahrzeug at H1 without its name is still open, with what is missing', () => {
    expect(states([vehicle(offsetM(h1.coord, 5, 0), '')])[0]).toEqual({ s: 'open', note: 'Steht. Noch die Bezeichnung «TLF» wählen' })
  })

  it('an MTF is not the TLF', () => {
    expect(states([vehicle(offsetM(h1.coord, 5, 0), 'MTF')])[0].s).toBe('open')
  })

  it('a Leitung from the TLF to the Eingang is right – either way round, or coupled to the TLF', () => {
    const tlf = vehicle(offsetM(h1.coord, 8, 4))
    expect(states([tlf], [line([tlf.coord, eingang.coord])])).toEqual([{ s: 'ok' }, { s: 'ok' }])
    expect(states([tlf], [line([eingang.coord, tlf.coord])])[1]).toEqual({ s: 'ok' })
    const coupled = line([offsetM(tlf.coord, 40, 0), eingang.coord], { startAttachment: { target: { kind: 'object', id: tlf.id }, routing: 'direct' } })
    expect(states([tlf], [coupled])[1]).toEqual({ s: 'ok' })
  })

  it('names the end that misses', () => {
    const tlf = vehicle(offsetM(h1.coord, 8, 4))
    const short = states([tlf], [line([tlf.coord, offsetM(eingang.coord, -30, 0)])])[1]
    expect(short).toEqual({ s: 'wrong', reason: 'Leitung endet 30 m vor dem Eingang' })
    const loose = states([tlf], [line([offsetM(tlf.coord, 0, 40), eingang.coord])])[1]
    expect(loose).toEqual({ s: 'wrong', reason: 'Leitung beginnt 40 m vom TLF' })
  })

  it('a Wand is no Leitung', () => {
    const tlf = vehicle(offsetM(h1.coord, 8, 4))
    expect(states([tlf], [line([tlf.coord, eingang.coord], { role: 'wand' })])[1].s).toBe('open')
  })

  it('a removed H1 says so instead of failing silently', () => {
    const entities = scene.entities.filter((e) => e.id !== SITE_IDS.h1)
    const [tlf] = goalStates(fahrzeugLeitung, { entities, drawings: [] }, siteOf(entities))
    expect(tlf.s).toBe('wrong')
  })
})

describe('Fahrzeug mit Leitung · Zeigen', () => {
  const ui = (over: Partial<UiState> = {}): UiState => ({ phone: true, mode: 'map', paletteOpen: false, tool: 'select', pending: null, selectedId: null, ...over })
  const hintFor = (u: UiState, extra: Entity[] = [], drawings: Drawing[] = []) => {
    const entities = [...scene.entities, ...extra]
    const snap = { entities, drawings }
    const site = siteOf(entities)
    return fahrzeugLeitung.hint(snap, u, site, nextGoal(goalStates(fahrzeugLeitung, snap, site)))
  }

  it('walks the path to the TLF: Hinzufügen → Fahrzeug → tap H1 → its name', () => {
    expect(hintFor(ui())?.anchor).toEqual({ kind: 'control', sel: '.vrail [data-tool="symbol"]' })
    expect(hintFor(ui())?.words).toBe('Hinzufügen › Fahrzeug, dann auf H1 tippen')
    expect(hintFor(ui({ phone: false }))?.words).toBe('Symbol › Fahrzeug, dann auf H1 tippen')
    expect(hintFor(ui({ paletteOpen: true }))?.anchor).toEqual({ kind: 'control', sel: `[data-sym="${appConfig.symbols.vehicleName}"]` })
    expect(hintFor(ui({ tool: 'symbol', pending: appConfig.symbols.vehicleName }))?.anchor).toEqual({ kind: 'map', at: h1.coord })
    const placed = vehicle(offsetM(h1.coord, 5, 0), '')
    expect(hintFor(ui({ selectedId: placed.id }), [placed])?.anchor).toEqual({ kind: 'control', sel: '[data-field="label"]' })
  })

  it('a TLF too far is dragged to H1', () => {
    const far = vehicle(offsetM(h1.coord, 80, 0))
    expect(hintFor(ui(), [far])?.gesture).toEqual({ kind: 'drag', from: far.coord, to: h1.coord })
  })

  it('then the Leitung: the phone through Hinzufügen, the tablet straight to Linie, an armed Linie on the map', () => {
    const tlf = vehicle(offsetM(h1.coord, 8, 4))
    expect(hintFor(ui(), [tlf])?.anchor).toEqual({ kind: 'control', sel: '.vrail [data-tool="symbol"]' })
    expect(hintFor(ui({ phone: false }), [tlf])?.anchor).toEqual({ kind: 'control', sel: '.vrail [data-tool="line"]' })
    expect(hintFor(ui({ paletteOpen: true }), [tlf])?.anchor).toEqual({ kind: 'control', sel: '.sym-modal [data-tool="line"]' })
    expect(hintFor(ui({ tool: 'line' }), [tlf])?.gesture).toEqual({ kind: 'drag', from: tlf.coord, to: eingang.coord })
  })

  it('off the Karte, the way back to it comes first', () => {
    expect(hintFor(ui({ mode: 'atemschutz' }))?.anchor).toEqual({ kind: 'control', sel: '.nav-item[data-mode="map"]' })
  })
})

describe('Fahrzeug mit Leitung · Lösung', () => {
  /** a SolveApi over a plain doc, the way the workspace's writers would change it */
  function run(entities: Entity[], drawings: Drawing[] = []) {
    const doc = { entities: [...entities], drawings: [...drawings] }
    const api: SolveApi = {
      addEntity: (e) => { doc.entities.push(e) },
      patchEntity: (id, patch) => { doc.entities = doc.entities.map((e) => (e.id === id ? { ...e, ...patch } : e)) },
      addLine: (coords, att) => { doc.drawings.push({ id: `l${doc.drawings.length}`, kind: 'line', coords, ...att }) },
    }
    fahrzeugLeitung.solve({ entities: doc.entities, drawings: doc.drawings }, siteOf(doc.entities), api)
    return goalStates(fahrzeugLeitung, doc, siteOf(doc.entities)).map((s) => s.s)
  }

  it('solves from nothing, from a far TLF and from an unnamed Fahrzeug', () => {
    expect(run(scene.entities)).toEqual(['ok', 'ok'])
    expect(run([...scene.entities, vehicle(offsetM(h1.coord, 90, 0))])).toEqual(['ok', 'ok'])
    expect(run([...scene.entities, vehicle(offsetM(h1.coord, 4, 0), '')])).toEqual(['ok', 'ok'])
  })

  it('a second run starts from the problem again', () => {
    const tlf = vehicle(offsetM(h1.coord, 8, 4))
    const doc = { entities: [...scene.entities, tlf], drawings: [...scene.drawings, line([tlf.coord, eingang.coord])] }
    const fresh = fahrzeugLeitung.prepare!(doc)
    expect(fresh.entities.map((e) => e.id)).toEqual(scene.entities.map((e) => e.id))
    expect(fresh.drawings.map((d) => d.id)).toEqual([SITE_IDS.gebaeude])
  })
})
