import { describe, expect, it } from 'vitest'
import { appConfig } from '../../config/appConfig'
import type { Drawing, Entity, LngLat } from '../../types'
import { besideH1, fahrzeugLeitung } from './fahrzeugLeitung'
import { goalStates, nextGoal, type SolveApi, type UiState } from './model'
import { offsetM, SITE_IDS, siteOf, siteScene } from './site'

const C: LngLat = [7.57, 47.52]
const scene = siteScene(C)
const h1 = scene.entities.find((e) => e.id === SITE_IDS.h1)!
const eingang = scene.entities.find((e) => e.id === SITE_IDS.eingang)!
const beside = offsetM(h1.coord, 12, 4)

const vehicle = (coord: LngLat, label = '', id = 'v1'): Entity =>
  ({ id, kind: 'symbol', layer: 'fahrzeuge', coord, symbol: appConfig.symbols.vehicleName, label })
const line = (coords: LngLat[], over: Partial<Drawing> = {}): Drawing => ({ id: 'l1', kind: 'line', coords, arrow: true, ...over })

function states(extra: Entity[], drawings: Drawing[] = []) {
  const entities = [...scene.entities, ...extra]
  return goalStates(fahrzeugLeitung, { entities, drawings }, siteOf(entities))
}

describe('Fahrzeug mit Leitung · the Fahrzeug by H1', () => {
  it('starts with both goals open', () => {
    expect(states([]).map((s) => s.s)).toEqual(['open', 'open'])
  })

  // lenient (owner pick, 20.11.2026): no band, no name – placed near the hydrant is done
  it('any Fahrzeug near H1 is right: unnamed, named, on top of the hydrant, 35 m off', () => {
    expect(states([vehicle(beside)])[0]).toEqual({ s: 'ok' })
    expect(states([vehicle(beside, 'MTF')])[0]).toEqual({ s: 'ok' })
    expect(states([vehicle(offsetM(h1.coord, 2, 0))])[0]).toEqual({ s: 'ok' })
    expect(states([vehicle(offsetM(h1.coord, 35, 0))])[0]).toEqual({ s: 'ok' })
  })

  it('one clearly somewhere else says how far – the nearest Fahrzeug is the one that counts', () => {
    expect(states([vehicle(offsetM(h1.coord, 80, 0))])[0]).toEqual({ s: 'wrong', reason: 'Fahrzeug steht 80 m von H1 – zieh es näher zum Hydranten' })
    expect(states([vehicle(offsetM(h1.coord, 80, 0)), vehicle(beside, '', 'v2')])[0]).toEqual({ s: 'ok' })
  })

  it('a removed H1 says so instead of failing silently', () => {
    const entities = scene.entities.filter((e) => e.id !== SITE_IDS.h1)
    expect(goalStates(fahrzeugLeitung, { entities, drawings: [] }, siteOf(entities))[0].s).toBe('wrong')
  })
})

describe('Fahrzeug mit Leitung · the Leitung with its arrow', () => {
  const v = vehicle(beside)

  it('Fahrzeug → Eingang with the arrow is right, coupled or within a few metres', () => {
    expect(states([v], [line([v.coord, eingang.coord])])).toEqual([{ s: 'ok' }, { s: 'ok' }])
    const coupled = line([offsetM(v.coord, 40, 0), eingang.coord], { startAttachment: { target: { kind: 'object', id: v.id }, routing: 'direct' } })
    expect(states([v], [coupled])[1]).toEqual({ s: 'ok' })
  })

  it('no arrow, or the arrow at the Fahrzeug, is wrong with what the arrow says', () => {
    expect(states([v], [line([v.coord, eingang.coord], { arrow: undefined })])[1])
      .toEqual({ s: 'wrong', reason: 'Pfeil fehlt – er zeigt, wohin das Wasser fliesst' })
    expect(states([v], [line([eingang.coord, v.coord])])[1])
      .toEqual({ s: 'wrong', reason: 'Pfeil zeigt zum Fahrzeug – das Wasser fliesst zum Eingang' })
    // the Entwicklungsgrenze is no Pfeil for water
    expect(states([v], [line([v.coord, eingang.coord], { arrowStop: true })])[1].s).toBe('wrong')
  })

  it('names the end that misses', () => {
    expect(states([v], [line([v.coord, offsetM(eingang.coord, -30, 0)])])[1]).toEqual({ s: 'wrong', reason: 'Leitung endet 30 m vor dem Eingang' })
    expect(states([v], [line([offsetM(v.coord, 0, 40), eingang.coord])])[1]).toEqual({ s: 'wrong', reason: 'Leitung beginnt 40 m vom Fahrzeug' })
  })

  it('a Wand is no Leitung', () => {
    expect(states([v], [line([v.coord, eingang.coord], { role: 'wand' })])[1].s).toBe('open')
  })
})

describe('Fahrzeug mit Leitung · Zeigen', () => {
  const ui = (over: Partial<UiState> = {}): UiState => ({ phone: true, mode: 'map', paletteOpen: false, tool: 'select', pending: null, selectedId: null, selectedDrawingId: null, ...over })
  const hintFor = (u: UiState, extra: Entity[] = [], drawings: Drawing[] = []) => {
    const entities = [...scene.entities, ...extra]
    const snap = { entities, drawings }
    const site = siteOf(entities)
    return fahrzeugLeitung.hint(snap, u, site, nextGoal(goalStates(fahrzeugLeitung, snap, site)))
  }

  it('walks the path to the Fahrzeug: Hinzufügen → Fahrzeug → tap beside H1', () => {
    expect(hintFor(ui())?.anchor).toEqual({ kind: 'control', sel: '.vrail [data-tool="symbol"]' })
    expect(hintFor(ui({ phone: false }))?.words).toBe('Symbol › Fahrzeug, dann neben H1 tippen')
    expect(hintFor(ui({ paletteOpen: true }))?.anchor).toEqual({ kind: 'control', sel: `[data-sym="${appConfig.symbols.vehicleName}"]` })
    expect(hintFor(ui({ tool: 'symbol', pending: appConfig.symbols.vehicleName }))?.anchor).toEqual({ kind: 'map', at: besideH1(h1.coord) })
  })

  it('a Fahrzeug somewhere else is dragged to H1', () => {
    const far = vehicle(offsetM(h1.coord, 90, 0))
    expect(hintFor(ui(), [far])?.gesture).toEqual({ kind: 'drag', from: far.coord, to: besideH1(h1.coord) })
  })

  it('then the Leitung: through Hinzufügen on a phone, straight to Linie on a tablet, then its arrow', () => {
    const v = vehicle(beside)
    expect(hintFor(ui(), [v])?.anchor).toEqual({ kind: 'control', sel: '.vrail [data-tool="symbol"]' })
    expect(hintFor(ui({ phone: false }), [v])?.anchor).toEqual({ kind: 'control', sel: '.vrail [data-tool="line"]' })
    expect(hintFor(ui({ tool: 'line' }), [v])?.gesture).toEqual({ kind: 'drag', from: v.coord, to: eingang.coord })
    const bare = line([v.coord, eingang.coord], { arrow: undefined })
    expect(hintFor(ui(), [v], [bare])?.words).toBe('Leitung antippen')
    // the ring stands on the ONE thing to tap: the «Pfeil» option, the reverse button
    expect(hintFor(ui({ selectedDrawingId: bare.id }), [v], [bare])?.anchor).toEqual({ kind: 'control', sel: '[data-field="lineEnd"] [data-value="arrow"]' })
    const back = line([eingang.coord, v.coord])
    expect(hintFor(ui({ selectedDrawingId: back.id }), [v], [back])?.anchor).toEqual({ kind: 'control', sel: '[data-field="lineReverse"] button' })
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
      patchDrawing: (id, patch) => { doc.drawings = doc.drawings.map((d) => (d.id === id ? { ...d, ...patch } : d)) },
      addLine: (coords, att, props) => { doc.drawings.push({ id: `l${doc.drawings.length}`, kind: 'line', coords, ...att, ...props }) },
    }
    fahrzeugLeitung.solve({ entities: doc.entities, drawings: doc.drawings }, siteOf(doc.entities), api)
    return { states: goalStates(fahrzeugLeitung, doc, siteOf(doc.entities)).map((s) => s.s), doc }
  }

  it('solves from nothing and from a Fahrzeug somewhere else; one that stands near H1 stays where it is', () => {
    expect(run(scene.entities).states).toEqual(['ok', 'ok'])
    expect(run([...scene.entities, vehicle(offsetM(h1.coord, 90, 0))]).states).toEqual(['ok', 'ok'])
    const near = run([...scene.entities, vehicle(beside)])
    expect(near.states).toEqual(['ok', 'ok'])
    expect(near.doc.entities.find((e) => e.id === 'v1')?.coord).toEqual(beside)
  })

  it('gives a drawn Leitung its arrow – turned round when it runs the wrong way – instead of a second one', () => {
    const v = vehicle(beside)
    const back = run([...scene.entities, v], [line([eingang.coord, v.coord], { arrow: undefined })])
    expect(back.states).toEqual(['ok', 'ok'])
    expect(back.doc.drawings).toHaveLength(1)
  })

  it('a second run starts from the problem again', () => {
    const v = vehicle(beside)
    const doc = { entities: [...scene.entities, v], drawings: [...scene.drawings, line([v.coord, eingang.coord])] }
    const fresh = fahrzeugLeitung.prepare(doc)
    expect(fresh.entities.map((e) => e.id)).toEqual(scene.entities.map((e) => e.id))
    expect(fresh.drawings.map((d) => d.id)).toEqual([SITE_IDS.gebaeude])
  })
})
