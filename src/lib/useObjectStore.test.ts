// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useObjectStore } from './useObjectStore'
import { fitSimilarity, type GeorefPair } from './georef'
import type { PlanFit, TacticalObject } from './tacticalObjects'
import type { BoardAnno, Entity } from '../types'

/* ONE store, two documents (tmp/design-unified-objects.md · phase 2). These tests pin what the
 * adapters owe every existing mutator: the views are always derived from the live store, a write
 * to either document lands in the same collection, a plan write re-bakes the map body through
 * the fit, and a step of the history restores the OBJECTS — anchors and all. */

const ORIGIN = { lng: 7.5525, lat: 47.5145 }
const mEast = (m: number) => ({ lng: ORIGIN.lng + m / (111320 * Math.cos((ORIGIN.lat * Math.PI) / 180)), lat: ORIGIN.lat })
const PAIRS: GeorefPair[] = [
  { plan: { x: 0, y: 0 }, lngLat: ORIGIN },
  { plan: { x: 1, y: 0 }, lngLat: mEast(100) },
]
const PLAN: PlanFit = { fit: fitSimilarity(PAIRS, 1)!, aspect: 1 }
const FITS = new Map([['modul2', PLAN]])

const ent = (id: string, over: Partial<Entity> = {}): Entity =>
  ({ id, kind: 'symbol', layer: 'taktisch', coord: [ORIGIN.lng, ORIGIN.lat], ...over })
const anno = (id: string, over: Partial<BoardAnno> = {}): BoardAnno =>
  ({ id, kind: 'symbol', x: 0.5, y: 0.5, ...over })

const store = (init: TacticalObject[] = [], fits: ReadonlyMap<string, PlanFit> = FITS, readOnly = false) =>
  renderHook(() => useObjectStore(init, readOnly, { getFits: () => fits, defaultLayer: 'taktisch' }))

describe('useObjectStore — one collection, two documents', () => {
  it('a map commit lands in the store and shows up in the doc view', () => {
    const { result } = store()
    act(() => result.current.commit((d) => ({ ...d, entities: [...d.entities, ent('e1')] })))
    expect(result.current.doc.entities.map((e) => e.id)).toEqual(['e1'])
    expect(result.current.objects.map((o) => o.id)).toEqual(['e1'])
  })

  it('a plan write lands in the SAME collection and bakes the map body through the fit', () => {
    const { result } = store()
    act(() => result.current.setBoard((b) => ({ ...b, modul2: [anno('s1', { x: 0.5, y: 0 })] })))
    expect(result.current.board.modul2?.map((a) => a.id)).toEqual(['s1'])
    const o = result.current.objects.find((x) => x.id === 's1')!
    expect(o.sheet?.planId).toBe('modul2') // the sheet is the anchor
    expect(o.entity?.coord[0]).toBeCloseTo(mEast(50).lng, 8) // …and the map body is already there
  })

  it('a plan without a fit keeps its objects unbaked — honestly absent from the ground', () => {
    const { result } = store([], new Map())
    act(() => result.current.setBoard((b) => ({ ...b, modul2: [anno('s1')] })))
    expect(result.current.objects[0].entity).toBeUndefined()
  })

  it('two writes in the same tick compose — each sees the live store, not the render snapshot', () => {
    const { result } = store()
    act(() => {
      result.current.commit((d) => ({ ...d, entities: [...d.entities, ent('e1')] }))
      result.current.setBoard((b) => ({ ...b, modul2: [anno('s1')] }))
      result.current.commit((d) => ({ ...d, entities: [...d.entities, ent('e2')] }))
    })
    // e1, e2 are the Karte's own; s1 arrives last as the baked body of the sheet object
    expect(result.current.doc.entities.map((e) => e.id)).toEqual(['e1', 'e2', 's1'])
    expect(result.current.board.modul2).toHaveLength(1)
  })

  it('an updater that returns what it was given changes nothing — not even an identity', () => {
    // the live-GPS pass runs on every poll and returns `cur` unchanged; rebuilding the store
    // there would churn every identity the memos hang off
    const { result } = store([{ id: 'e1', entity: ent('e1') }])
    const before = result.current.objects
    const beforeDoc = result.current.doc
    act(() => result.current.setDocRaw((d) => d))
    expect(result.current.objects).toBe(before)
    expect(result.current.doc).toBe(beforeDoc)
  })

  it('the anno ORDER survives the round trip through the store', () => {
    // the sheet's paint order is the anno list's order, and the board view is derived from the
    // store — so a «nach vorne» must not come back in the old order
    const { result } = store()
    act(() => result.current.setBoard(() => ({ modul2: [anno('a'), anno('b'), anno('c')] })))
    act(() => result.current.setBoard((b) => ({ ...b, modul2: [b.modul2[1], b.modul2[2], b.modul2[0]] })))
    expect(result.current.board.modul2.map((a) => a.id)).toEqual(['b', 'c', 'a'])
  })

  it('a history step snapshots and restores the whole STORE, anchors included', () => {
    // ⚠️ Not the map document: what an undo has to be able to put back is the object as it stood,
    // and an object's anchor is not recoverable from a position. (The step that MOVES an anchor
    // arrives with the native map rendering; this pins that the stack carries what it will need.)
    const { result } = store()
    act(() => result.current.setBoard(() => ({ modul2: [anno('s1')] })))
    act(() => result.current.commit((d) => ({ ...d, entities: [...d.entities, ent('e1')] })))
    expect(result.current.objects.map((o) => o.id)).toEqual(['s1', 'e1'])
    act(() => { result.current.undo() })
    expect(result.current.doc.entities.map((e) => e.id)).toEqual(['s1']) // only the sheet object's baked body
    const restored = result.current.objects.find((o) => o.id === 's1')!
    expect(restored.sheet?.planId).toBe('modul2')
    expect(restored.entity?.coord).toBeDefined() // …with its baked map body intact
  })

  /* The Karte draws plan-drawn objects natively now (viewsOf), so the ordinary map mutators
   * reach them — and what comes back has to be read as the gesture it was. */
  describe('a plan-drawn object, edited on the Karte', () => {
    const withSheetSymbol = () => {
      const h = store()
      act(() => h.result.current.setBoard(() => ({ modul2: [anno('s1', { x: 0.5, y: 0, label: 'Feuer' })] })))
      return h
    }

    it('shows up in the doc view as an ordinary entity', () => {
      const { result } = withSheetSymbol()
      expect(result.current.doc.entities.map((e) => e.id)).toEqual(['s1'])
      expect(result.current.doc.entities[0].label).toBe('Feuer')
    })

    it('a MOVE on the map flips the anchor — it leaves the sheet', () => {
      const { result } = withSheetSymbol()
      act(() => result.current.commit((d) => ({
        ...d, entities: d.entities.map((e) => ({ ...e, coord: [mEast(400).lng, ORIGIN.lat] as [number, number] })),
      })))
      expect(result.current.board.modul2).toBeUndefined()
      expect(result.current.doc.entities[0].coord[0]).toBeCloseTo(mEast(400).lng, 8)
    })

    it('a STYLE edit on the map keeps the anchor and survives the next bake', () => {
      const { result } = withSheetSymbol()
      act(() => result.current.commit((d) => ({
        ...d, entities: d.entities.map((e) => ({ ...e, label: 'Brandherd', color: '#f00' })),
      })))
      expect(result.current.board.modul2?.[0]).toMatchObject({ label: 'Brandherd', color: '#f00', x: 0.5 })
      // the rebake is what would undo an edit parked on the map body instead of the anno
      act(() => result.current.rebake())
      expect(result.current.doc.entities[0].label).toBe('Brandherd')
      expect(result.current.doc.entities[0].coord[0]).toBeCloseTo(mEast(50).lng, 8)
    })

    it('a DELETE on the map deletes the object, sheet body and all', () => {
      const { result } = withSheetSymbol()
      act(() => result.current.commit((d) => ({ ...d, entities: [] })))
      expect(result.current.objects).toEqual([])
      expect(result.current.board.modul2).toBeUndefined()
    })
  })

  it('a viewer cannot commit, and replaceObjects drops the history with the state', () => {
    const ro = store([], FITS, true)
    act(() => ro.result.current.commit((d) => ({ ...d, entities: [ent('e1')] })))
    expect(ro.result.current.objects).toEqual([])

    const { result } = store()
    act(() => result.current.commit((d) => ({ ...d, entities: [...d.entities, ent('e1')] })))
    expect(result.current.canUndo).toBe(true)
    act(() => result.current.replaceObjects([{ id: 'x', entity: ent('x') }]))
    expect(result.current.doc.entities.map((e) => e.id)).toEqual(['x'])
    expect(result.current.canUndo).toBe(false)
  })

  it('rebake re-derives every map body when the georeference has moved', () => {
    const fits = new Map([['modul2', PLAN]])
    const { result } = store([], fits)
    act(() => result.current.setBoard(() => ({ modul2: [anno('s1', { x: 0.5, y: 0 })] })))
    expect(result.current.objects[0].entity!.coord[0]).toBeCloseTo(mEast(50).lng, 8)
    // the operator corrects the reference: the sheet is now twice as wide on the ground
    fits.set('modul2', { fit: fitSimilarity([PAIRS[0], { plan: { x: 1, y: 0 }, lngLat: mEast(200) }], 1)!, aspect: 1 })
    act(() => result.current.rebake())
    expect(result.current.objects[0].entity!.coord[0]).toBeCloseTo(mEast(100).lng, 8)
    expect(result.current.objects[0].sheet?.anno.x).toBe(0.5) // the sheet coords are the truth
  })
})
