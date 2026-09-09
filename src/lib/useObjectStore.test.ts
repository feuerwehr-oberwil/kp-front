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
  renderHook(() => useObjectStore(init, readOnly, { getFits: () => fits, defaultLayer: 'taktisch', fitsVersion: 0 }))

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
      result.current.setBoard((b) => ({ ...b, modul2: [...(b.modul2 ?? []), anno('s1')] }))
      result.current.commit((d) => ({ ...d, entities: [...d.entities, ent('e2')] }))
    })
    // e1, e2 are the Karte's own; s1 arrives last as the baked body of the sheet object
    expect(result.current.doc.entities.map((e) => e.id)).toEqual(['e1', 'e2', 's1'])
    // …and the sheet draws its own anno plus whatever of the Karte lands on it
    expect(result.current.board.modul2.map((a) => a.id)).toEqual(['e1', 'e2', 's1'])
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

  it('a rebake that changes nothing keeps every reference — so it never marks the store dirty', () => {
    // ⚠️ THE open-loop bug: the rebake fires on any render that rebuilt the fits (a hydrate
    // does), and a fresh-but-equal body made the store look edited. Two devices with the same
    // Einsatz open pushed each other in a loop, wiping both undo stacks on every round.
    const { result } = store()
    act(() => result.current.setBoard(() => ({ modul2: [anno('s1')] })))
    const before = result.current.objects
    const beforeBody = before[0].entity
    act(() => result.current.rebake())
    expect(result.current.objects).toBe(before)
    expect(result.current.objects[0].entity).toBe(beforeBody)
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

  it('a corrected reference is ONE undo step, and says how many objects it moved', () => {
    const fits = new Map([['modul2', PLAN]])
    const { result } = store([], fits)
    act(() => result.current.setBoard(() => ({ modul2: [anno('s1'), anno('s2', { x: 0.25 })] })))
    expect(result.current.canUndo).toBe(false) // a plan write keeps its own history, not the map's
    fits.set('modul2', { fit: fitSimilarity([PAIRS[0], { plan: { x: 1, y: 0 }, lngLat: mEast(200) }], 1)!, aspect: 1 })
    let moved = 0
    act(() => { moved = result.current.rebake({ checkpoint: true }) })
    expect(moved).toBe(2)
    act(() => { result.current.undo() })
    expect(result.current.objects[0].entity!.coord[0]).toBeCloseTo(mEast(50).lng, 8) // back where it stood
  })

  it('…and a fit change no object stands on is not a step at all', () => {
    const { result } = store()
    expect(result.current.rebake({ checkpoint: true })).toBe(0)
    expect(result.current.canUndo).toBe(false)
  })
})

/* The unit-bearing seam (10.09.): a metre width means nothing on paper, so these fields cross
 * onto the anno through the plan's own fit. Dropped, the Karte silently refused edits it had
 * just accepted — the next bake put the old number back. */
describe('a Karte edit that is measured in metres', () => {
  const withBoard = (annos: BoardAnno[]) => {
    const h = store()
    act(() => h.result.current.setBoard(() => ({ modul2: annos })))
    return h
  }

  it('a marked position on a plan-drawn Trupp survives the next bake', () => {
    const { result } = withBoard([anno('r1', { kind: 'resource', x: 0.5, y: 0, text: 'Trupp 1' })])
    act(() => result.current.commit((d) => ({
      ...d,
      entities: d.entities.map((e) => ({ ...e, t: '10:20', trail: [{ coord: [mEast(50).lng, ORIGIN.lat] as [number, number], t: '10:20' }] })),
    })))
    expect(result.current.board.modul2[0].trail).toHaveLength(1)
    expect(result.current.board.modul2[0].trail![0]).toMatchObject({ t: '10:20' })
    expect(result.current.board.modul2[0].trail![0].x).toBeCloseTo(0.5, 6)
    act(() => result.current.rebake())
    expect(result.current.doc.entities[0].trail).toHaveLength(1) // the dot is still there
  })

  it('widening an Absperrkreis keeps it on its sheet — a radius is a size, not a placement', () => {
    const { result } = withBoard([anno('c1', { kind: 'circle', x: 0.5, y: 0.5, radiusN: 0.1 })])
    act(() => result.current.commit((d) => ({ ...d, drawings: d.drawings.map((x) => ({ ...x, radiusM: 40 })) })))
    expect(result.current.board.modul2?.[0].radiusN).toBeCloseTo(0.4, 4) // 40 m of a 100 m sheet
    act(() => result.current.rebake())
    expect(result.current.doc.drawings[0].radiusM).toBeCloseTo(40, 6)
  })

  it('a Form resized on the Karte keeps the size it was given', () => {
    const { result } = withBoard([anno('sh1', { kind: 'shape', shape: 'square', x: 0.5, y: 0.5, sizeN: 0.1 })])
    act(() => result.current.commit((d) => ({ ...d, entities: d.entities.map((e) => ({ ...e, sizeM: 25 })) })))
    expect(result.current.board.modul2?.[0].sizeN).toBeCloseTo(0.25, 4)
    act(() => result.current.rebake())
    expect(result.current.doc.entities[0].sizeM).toBeCloseTo(25, 6)
  })

  it('map-only presentation survives a re-bake — the sheet has no word for it', () => {
    const { result } = withBoard([anno('l1', { kind: 'draw', x: undefined, y: undefined, pts: [[0, 0], [1, 0]] })])
    act(() => result.current.commit((d) => ({
      ...d, drawings: d.drawings.map((x) => ({ ...x, abschnittLeiter: 'Oblt Steiner', abschnittAuftrag: 'Riegelstellung', labelAt: [mEast(20).lng, ORIGIN.lat] as [number, number] })),
    })))
    act(() => result.current.rebake())
    expect(result.current.doc.drawings[0]).toMatchObject({ abschnittLeiter: 'Oblt Steiner', abschnittAuftrag: 'Riegelstellung' })
    expect(result.current.doc.drawings[0].labelAt).toBeDefined()
  })
})

describe('a machine write never places anything', () => {
  /* ⚠️ Only a hand places an object. The live-GPS pass re-routes an attached Leitung on every
   * poll, and read as a hand-placement it tore plan-drawn hoses off their sheet with nobody
   * touching anything. */
  const withLine = () => {
    const h = store()
    act(() => h.result.current.setBoard(() => ({ modul2: [anno('l1', { kind: 'draw', x: undefined, y: undefined, pts: [[0, 0], [0.5, 0]] })] })))
    return h
  }
  const rerouted = (d: { drawings: { coords: unknown }[] }) => ({
    ...d, drawings: d.drawings.map((x) => ({ ...x, coords: [[ORIGIN.lng, ORIGIN.lat], [mEast(90).lng, ORIGIN.lat]] })),
  })

  it('keeps the sheet anchor and writes the new geometry onto the anno', () => {
    const { result } = withLine()
    act(() => result.current.setDocRaw((d) => rerouted(d) as typeof d, { gesture: false }))
    const o = result.current.objects[0]
    expect(o.sheet?.planId).toBe('modul2')
    expect(o.sheet!.anno.pts![1][0]).toBeCloseTo(0.9, 4) // …in the sheet's own units
    act(() => result.current.rebake())
    expect(result.current.doc.drawings[0].coords[1][0]).toBeCloseTo(mEast(90).lng, 6)
  })

  it('…while the same document from a HAND still flips the anchor', () => {
    const { result } = withLine()
    act(() => result.current.setDocRaw((d) => rerouted(d) as typeof d))
    expect(result.current.objects[0].sheet).toBeUndefined()
  })
})

/* ⚠️ OWNERSHIP DECIDES THE STACK (10.09.). A sheet draws objects it does not own — the Karte's,
 * projected onto it — and an edit of one of those is a store-level act. A per-sheet snapshot of
 * annotations cannot express «this object was geo-anchored», so it could not undo an anchor flip
 * at all: restoring the pre-flip list re-anchored the object at its old spot, or deleted it. */
describe('a sheet edit of an object the sheet does not own', () => {
  const geoStore = (): TacticalObject[] => [{ id: 'e1', entity: ent('e1', { coord: [mEast(50).lng, ORIGIN.lat] }) }]
  /** the anno that sheet is showing for it — what the Whiteboard would hand back */
  const shownAnno = (x: number, y = 0) => anno('e1', { x, y, label: undefined })

  it('lays a step on the STORE stack, and undo puts the anchor back', () => {
    const { result } = store(geoStore())
    expect(result.current.canUndo).toBe(false)
    act(() => result.current.setBoard((b) => ({ ...b, modul2: [shownAnno(0.25)] })))
    expect(result.current.objects[0].sheet?.planId).toBe('modul2') // the hand placed it there
    expect(result.current.canUndo).toBe(true)
    act(() => { result.current.undo() })
    expect(result.current.objects[0].sheet).toBeUndefined() // …and it is the Karte's again
    // the sheet still SHOWS it — as a projection, back at the place the Karte says it stands
    expect(result.current.board.modul2[0].x).toBeCloseTo(0.5, 6)
  })

  it('one gesture is ONE step, however many samples it writes', () => {
    const { result } = store(geoStore())
    act(() => {
      result.current.beginSheetStep()
      for (const x of [0.4, 0.3, 0.25]) result.current.setBoard((b) => ({ ...b, modul2: [shownAnno(x)] }))
    })
    act(() => { result.current.undo() })
    expect(result.current.objects[0].sheet).toBeUndefined() // one ↶ undid the whole drag
  })

  it('…while an edit of the sheet’s OWN anno leaves this stack alone', () => {
    const { result } = store()
    act(() => result.current.setBoard(() => ({ modul2: [anno('s1')] })))
    act(() => result.current.setBoard(() => ({ modul2: [anno('s1', { x: 0.9 })] })))
    expect(result.current.canUndo).toBe(false) // the plan's own history owns that step
  })
})

/* The plan side of the unified object (stage 2). A sheet DRAWS the Karte's objects and edits them
 * with its own chrome; what it hands back is read as the gesture it was. */
describe('what a sheet draws, and what it hands back', () => {
  const mapObject = (): TacticalObject[] => [{ id: 'e1', entity: ent('e1', { coord: [mEast(50).lng, ORIGIN.lat], label: 'TLF' }) }]

  it('a Karte object lands in the sheet’s own anno list, under its own id', () => {
    const { result } = store(mapObject())
    expect(result.current.board.modul2.map((a) => a.id)).toEqual(['e1'])
    expect(result.current.board.modul2[0]).toMatchObject({ kind: 'symbol', label: 'TLF' })
    expect(result.current.board.modul2[0].x).toBeCloseTo(0.5, 6)
  })

  it('…and an object anchored on ANOTHER sheet is not lent to this one', () => {
    const elsewhere: TacticalObject[] = [{ id: 's1', sheet: { planId: 'modul3', anno: anno('s1') } }]
    expect(store(elsewhere).result.current.board.modul2).toBeUndefined()
  })

  it('a prop edit on the sheet lands on the MAP body; the object stays the Karte’s', () => {
    const { result } = store(mapObject())
    act(() => result.current.setBoard((b) => ({ ...b, modul2: [{ ...b.modul2[0], label: 'TLF 1', color: '#f00' }] })))
    expect(result.current.objects[0].sheet).toBeUndefined()
    expect(result.current.doc.entities[0]).toMatchObject({ label: 'TLF 1', color: '#f00' })
    expect(result.current.doc.entities[0].coord[0]).toBeCloseTo(mEast(50).lng, 8) // …and it did not move
  })

  it('deleting it on the sheet deletes the object everywhere — it IS the object', () => {
    const { result } = store(mapObject())
    act(() => result.current.setBoard((b) => ({ ...b, modul2: b.modul2.filter((a) => a.id !== 'e1') })))
    expect(result.current.objects).toEqual([])
    expect(result.current.doc.entities).toEqual([])
  })

  it('the sheet’s own annos and the Karte’s objects share one list, natives on top', () => {
    const { result } = store(mapObject())
    act(() => result.current.setBoard((b) => ({ ...b, modul2: [...b.modul2, anno('s1')] })))
    // projections first, the sheet's own ink after — each surface paints the other's underneath
    expect(result.current.board.modul2.map((a) => a.id)).toEqual(['e1', 's1'])
  })
})

/* ⚠️ The view a sheet is handed and the «what did it look like a moment ago» the write seam
 * compares against have to be built by the same code, in the same order. Built separately they
 * disagreed after any map write (which reorders the store), and every no-op setBoard then read
 * as a full re-arrangement: a checkpoint per pointer sample, a dirty push per poll, and the
 * near-inverse conversions writing `rotation: 0` and default sizes onto untouched map objects. */
describe('a sheet with both kinds on it, after the Karte has been written', () => {
  const mixed = (): TacticalObject[] => [
    { id: 'e1', entity: ent('e1', { coord: [mEast(40).lng, ORIGIN.lat] }) },
    { id: 'n1', sheet: { planId: 'modul2', anno: anno('n1', { x: 0.1, y: 0.1 }) } },
    { id: 'e2', entity: ent('e2', { coord: [mEast(70).lng, ORIGIN.lat] }) },
  ]

  it('hands the same list back unchanged — no fold, no checkpoint, no dirty store', () => {
    const { result } = store(mixed())
    // a map write: this reorders the store (sheet-anchored records keep their place, map
    // objects are rebuilt from the document) without touching the sheet at all
    act(() => result.current.commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === 'e2' ? { ...e, label: 'X' } : e)) })))
    const before = result.current.objects
    act(() => result.current.setBoard((b) => ({ ...b })))
    expect(result.current.objects).toBe(before)   // …not folded
    expect(result.current.canUndo).toBe(true)     // …and only the map's own commit is on the stack
    act(() => { result.current.undo() })
    expect(result.current.canUndo).toBe(false)
  })
})

describe('the plan gesture token', () => {
  /* ⚠️ It latched as a tri-state: after the first plan gesture of a session every later
   * cross-ownership write — the board sweeps in useTruppActions, a plan ↶, a Gebäude amend —
   * found it already «done» and laid down no undo step at all. */
  const two = (): TacticalObject[] => [
    { id: 'e1', entity: ent('e1', { coord: [mEast(40).lng, ORIGIN.lat] }) },
    { id: 'e2', entity: ent('e2', { coord: [mEast(70).lng, ORIGIN.lat] }) },
  ]

  it('a discrete write is still its own step, however many gestures came before', () => {
    const { result } = store(two())
    const at = (b: Record<string, { id: string }[]>, id: string) => b.modul2.findIndex((a) => a.id === id)
    act(() => {
      result.current.beginSheetStep()
      result.current.setBoard((b) => ({ ...b, modul2: b.modul2.map((a, i) => (i === at(b, 'e1') ? { ...a, x: 0.25 } : a)) }))
    })
    expect(result.current.objects.find((o) => o.id === 'e1')!.sheet?.planId).toBe('modul2')
    // the finger lifts — a plan step is a pointer gesture, and that is where it ends
    act(() => { window.dispatchEvent(new Event('pointerup')) })
    // …and now a write with NO gesture open — a Trupp sweep, a plan ↶, a Gebäude amend
    act(() => result.current.setBoard((b) => ({ ...b, modul2: b.modul2.map((a, i) => (i === at(b, 'e2') ? { ...a, color: '#f00' } : a)) })))
    act(() => { result.current.undo() })
    expect(result.current.doc.entities.find((e) => e.id === 'e2')!.color).toBeUndefined() // that write came back off
    expect(result.current.objects.find((o) => o.id === 'e1')!.sheet?.planId).toBe('modul2') // …the flip is a step below
  })
})

describe('a write that carries objects the hand did not move', () => {
  /* ⚠️ A gesture is per-object; a map write is per-document. Dragging a Gefahrentafel's HOST
   * carries the placard along and re-routes every hose attached to it, all in one write — read
   * as «the hand placed all of these», the carried placard tore itself off its sheet because
   * something else was dragged. */
  const hostAndPlacard = (): TacticalObject[] => [
    { id: 'host', entity: ent('host', { coord: [mEast(40).lng, ORIGIN.lat] }) },
    { id: 'placard', sheet: { planId: 'modul2', anno: anno('placard', { x: 0.45, y: 0 }) } },
  ]

  it('a docked placard whose host is dragged keeps its sheet', () => {
    const h = store(hostAndPlacard())
    // the placard has a baked map body once the sheet is known
    act(() => h.result.current.rebake())
    const carried = (d: { entities: Entity[] }) => ({
      ...d,
      entities: d.entities.map((e) => ({ ...e, coord: [e.coord[0] + 0.0005, e.coord[1]] as [number, number] })),
    })
    act(() => h.result.current.setDocRaw((d) => carried(d) as typeof d, { movedIds: ['host'] }))
    expect(h.result.current.objects.find((o) => o.id === 'placard')!.sheet?.planId).toBe('modul2')
    expect(h.result.current.objects.find((o) => o.id === 'host')!.entity!.coord[0]).toBeCloseTo(mEast(40).lng + 0.0005, 8)
  })

  it('…and naming it moved flips it, so the narrowing is the only thing holding it', () => {
    const h = store(hostAndPlacard())
    act(() => h.result.current.rebake())
    act(() => h.result.current.setDocRaw((d) => ({
      ...d, entities: d.entities.map((e) => (e.id === 'placard' ? { ...e, coord: [e.coord[0] + 0.0005, e.coord[1]] as [number, number] } : e)),
    }), { movedIds: ['placard'] }))
    expect(h.result.current.objects.find((o) => o.id === 'placard')!.sheet).toBeUndefined()
  })
})
