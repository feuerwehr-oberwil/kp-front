// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useObjectStore } from './useObjectStore'
import { bakeGeoBody, sheetAnchoredIds, withOwnAnnos, type AnchorChange, type PlanFit, type TacticalObject } from './tacticalObjects'
import { fitSimilarity } from './georef'
import { removeStorey, stackInstances, withoutOwnOnStorey } from './stackFloors'
import { askStoreyRemoval, storeyAddedRow, storeyRemovedRow, storeyRestoredRow, storeySubject } from './storeyRemoval'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'
import type { BoardAnno, Drawing, Entity } from '../types'

// the confirm, answered the way the operator would (`answer` is what the next dialog resolves to)
const ui = vi.hoisted(() => ({ confirms: [] as { title?: string; message: string }[], answer: false }))
vi.mock('./ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ui')>(),
  confirmDialog: (opts: { title?: string; message: string }) => { ui.confirms.push(opts); return Promise.resolve(ui.answer) },
}))

/* «Geschoss entfernen» on a hand-made Gebäude stack (24.09.2026, noted in the 23.09.2026
 * post-mortem, PR #202). The stack's view holds the Karte's objects projected onto their storey,
 * and the removal swept the WHOLE view — the write seam reads an absent anno as a deletion, so a
 * Fahrzeug placed on the Karte and merely SHOWN on the removed storey was deleted with it.
 *
 * Driven exactly as IncidentWorkspace · onRemoveFloor drives it, through the real store: the
 * sweep and the building change land in the same tick (the fits still name the old storeys), and
 * the stack's new storeys reach the fits one render later. The ↶ writes while the fits still name
 * the REDUCED stack — the moment a full-view restore read the Karte's objects as new placements. */

const origin = { lng: 7.5488, lat: 47.5226 }
const mPerDegLat = 111320, mPerDegLng = 111320 * Math.cos((origin.lat * Math.PI) / 180)
const turn = (-41.49 * Math.PI) / 180
const tileEnd = { lng: origin.lng + (80 * Math.cos(turn)) / mPerDegLng, lat: origin.lat + (80 * Math.sin(turn)) / mPerDegLat }
const stack = (floors: number[]): PlanFit => ({
  fit: fitSimilarity([{ plan: { x: 0, y: 0 }, lngLat: origin }, { plan: { x: 1, y: 0 }, lngLat: tileEnd }], 1.25)!,
  aspect: 1.25,
  stack: { floors },
})
const FLOORS = [0, 1, 2, 3]
const stackAt = (x: number, y: number): [number, number] => { const p = stack(FLOORS).fit.toMap({ x, y }); return [p.lng, p.lat] }

/** a Karte-placed object: geo is its truth, the stack shows it on the storey its badge names */
const karteEntity = (id: string, e: Partial<Entity>): TacticalObject =>
  ({ id, entity: { id, kind: 'symbol', layer: 'taktisch', coord: stackAt(0.4, 0.4), ...e } as Entity })
const karteDrawing = (id: string, d: Partial<Drawing>): TacticalObject =>
  ({ id, drawing: { id, kind: 'line', coords: [stackAt(0.3, 0.3), stackAt(0.6, 0.5)], ...d } as Drawing })
/** an object placed ON the stack: the storey owns it */
const own = (anno: BoardAnno): TacticalObject => bakeGeoBody({ id: anno.id, sheet: { planId: 'gebaeude', anno } }, stack(FLOORS), 'taktisch')

function mount(init: TacticalObject[]) {
  let fits = new Map([['gebaeude', stack(FLOORS)]])
  const onAnchorChange = vi.fn<(c: AnchorChange[]) => void>()
  const hook = renderHook(({ v }) => useObjectStore(init, false, { getFits: () => fits, defaultLayer: 'taktisch', fitsVersion: v, onAnchorChange }), { initialProps: { v: 0 } })
  let v = 0
  const setFloors = (floors: number[]) => { fits = new Map([['gebaeude', stack(floors)]]); hook.rerender({ v: ++v }) }
  /** IncidentWorkspace · onRemoveFloor, verbatim in what it writes and when */
  const removeFloor = (floor: number) => {
    const r = hook.result.current
    const remaining = FLOORS.filter((f) => f !== floor)
    const sweep = removeStorey(r.board.gebaeude ?? [], sheetAnchoredIds(r.objects, 'gebaeude'), floor, remaining)
    const writeOwn = (annos: BoardAnno[]) => act(() => hook.result.current.setBoard((b) => ({ ...b, gebaeude: withOwnAnnos(b.gebaeude, sweep.owned, annos) }), { gesture: false }))
    writeOwn(sweep.after); setFloors(remaining)
    return {
      sweep,
      undo: () => { writeOwn(sweep.before); setFloors(FLOORS) },
      redo: () => { writeOwn(sweep.after); setFloors(remaining) },
    }
  }
  return { result: hook.result, removeFloor, onAnchorChange }
}

const byId = (objects: TacticalObject[]) => [...objects].sort((a, b) => a.id.localeCompare(b.id))
/** the storeys the stack draws an object on — a range on every covered tile the stack has */
const shownOn = (board: { gebaeude?: BoardAnno[] }, id: string, floors = FLOORS) =>
  (board.gebaeude ?? []).filter((a) => a.id === id).flatMap((a) => stackInstances(a, floors)).map((a) => a.floor ?? 0)

describe('«Geschoss entfernen» keeps the Karte’s objects', () => {
  it('a Karte-placed Fahrzeug shown on storey 2 survives the removal of storey 2, on the same ground', () => {
    const tlf = karteEntity('tlf', { symbol: 'VKF Fahrzeug', floor: 2, rotation: 30 })
    const { result, removeFloor, onAnchorChange } = mount([tlf])
    expect(shownOn(result.current.board, 'tlf')).toEqual([2]) // the control: it IS shown there
    removeFloor(2)
    expect(result.current.objects).toEqual([tlf]) // same record — ground position, bearing, storey
    expect(result.current.objects[0].entity!.coord).toEqual(tlf.entity!.coord)
    expect(result.current.board.gebaeude ?? []).toEqual([]) // …and no longer shown on the stack
    expect(onAnchorChange).not.toHaveBeenCalled()
    // the removal lays down no store step of its own — its one step is the Gebäude one-shot
    expect(result.current.canUndo).toBe(false)
  })

  it('a symbol placed ON storey 2 goes with it, as before — and one on storey 1 stays', () => {
    const up = own({ id: 'up', kind: 'symbol', symbol: 'VKF Feuer', x: 0.2, y: 0.2, floor: 2 })
    const below = own({ id: 'below', kind: 'symbol', symbol: 'VKF Feuer', x: 0.2, y: 0.2, floor: 1 })
    const { result, removeFloor } = mount([up, below])
    removeFloor(2)
    expect(result.current.objects).toEqual([below])
  })

  it('a Linie across storeys loses only the vertices on the removed one, as before', () => {
    const riser = own({ id: 'riser', kind: 'draw', floor: 1, pts: [[0.2, 0.2, 1], [0.3, 0.3, 2], [0.4, 0.4, 3]] })
    const { result, removeFloor } = mount([riser])
    removeFloor(2)
    expect(result.current.objects[0].sheet?.anno.pts).toEqual([[0.2, 0.2, 1], [0.4, 0.4, 3]])
  })

  describe('a Von/Bis range is shrunk, never deleted while it still covers a storey', () => {
    const span = (from: number, to: number, floor = from) => own({ id: 'span', kind: 'symbol', symbol: 'VKF Feuer', x: 0.5, y: 0.5, floor, floorFrom: from, floorTo: to })
    const cases: { name: string; init: TacticalObject; remove: number; expect: Partial<BoardAnno> | null; shown?: number[] }[] = [
      { name: '1–3 without 2: still 1–3, shown on 1 and 3', init: span(1, 3), remove: 2, expect: { floor: 1, floorFrom: 1, floorTo: 3 }, shown: [1, 3] },
      { name: '1–3 without its top storey: 1–2', init: span(1, 3), remove: 3, expect: { floor: 1, floorFrom: 1, floorTo: 2 }, shown: [1, 2] },
      { name: '1–3 homed on 1, without 1: re-homed onto 2, 2–3 (it used to be deleted)', init: span(1, 3), remove: 1, expect: { floor: 2, floorFrom: 2, floorTo: 3 }, shown: [2, 3] },
      { name: '2–3 homed on 3, without 2: 3–3, still homed on 3', init: span(2, 3, 3), remove: 2, expect: { floor: 3, floorFrom: 3, floorTo: 3 }, shown: [3] },
      { name: '2–2 covers nothing else: goes, like any object on the storey', init: span(2, 2), remove: 2, expect: null },
      { name: '0–1 does not cover 3: untouched', init: span(0, 1), remove: 3, expect: { floor: 0, floorFrom: 0, floorTo: 1 }, shown: [0, 1] },
    ]
    for (const c of cases) {
      it(c.name, () => {
        const { result, removeFloor } = mount([c.init])
        const { undo } = removeFloor(c.remove)
        const o = result.current.objects.find((x) => x.id === 'span')
        if (!c.expect) expect(o).toBeUndefined()
        else {
          expect(o?.sheet?.anno).toMatchObject(c.expect)
          // the baked map body says the same span
          expect(o?.entity).toMatchObject({ floorFrom: c.expect.floorFrom, floorTo: c.expect.floorTo })
          expect(shownOn(result.current.board, 'span', FLOORS.filter((f) => f !== c.remove))).toEqual(c.shown)
        }
        undo()
        expect(result.current.objects).toEqual([c.init])
      })
    }

    it('a KARTE range 1–3 is the Karte’s statement: untouched, and shown on 1 and 3', () => {
      const fire = karteEntity('fire', { symbol: 'VKF Feuer', floorFrom: 1, floorTo: 3 })
      const { result, removeFloor } = mount([fire])
      expect(shownOn(result.current.board, 'fire')).toEqual([1, 2, 3])
      removeFloor(2)
      expect(result.current.objects).toEqual([fire])
      expect(shownOn(result.current.board, 'fire', [0, 1, 3])).toEqual([1, 3])
    })
  })

  it('↶ restores everything exactly, ↷ repeats the removal — with no anchor flip either way', () => {
    const init = [
      karteEntity('tlf', { symbol: 'VKF Fahrzeug', floor: 2 }),
      karteEntity('fire', { symbol: 'VKF Feuer', floorFrom: 1, floorTo: 3, coord: stackAt(0.6, 0.3) }),
      karteDrawing('hose', { floorTag: 2 }),
      own({ id: 'up', kind: 'symbol', symbol: 'VKF Feuer', x: 0.2, y: 0.2, floor: 2 }),
      own({ id: 'chip', kind: 'resource', text: 'Trupp 1', x: 0.5, y: 0.5, floor: 1, trail: [{ x: 0.4, y: 0.4, floor: 2, t: '10:01' }, { x: 0.5, y: 0.5, floor: 1, t: '10:02' }] }),
      own({ id: 'span', kind: 'symbol', symbol: 'VKF Feuer', x: 0.5, y: 0.5, floor: 2, floorFrom: 2, floorTo: 3 }),
      own({ id: 'riser', kind: 'draw', floor: 1, pts: [[0.2, 0.2, 1], [0.3, 0.3, 2], [0.4, 0.4, 3]] }),
    ]
    const { result, removeFloor, onAnchorChange } = mount(init)
    const viewBefore = result.current.board.gebaeude
    const { undo, redo } = removeFloor(2)
    const afterRemoval = result.current.objects
    expect(afterRemoval.map((o) => o.id).sort()).toEqual(['chip', 'fire', 'hose', 'riser', 'span', 'tlf'])
    // the storey's own: the chip on 1 keeps only its breadcrumbs off 2, the span 2–3 is now 3–3
    expect(afterRemoval.find((o) => o.id === 'chip')?.sheet?.anno.trail?.map((p) => p.floor)).toEqual([1])
    expect(afterRemoval.find((o) => o.id === 'span')?.sheet?.anno).toMatchObject({ floor: 3, floorFrom: 3, floorTo: 3 })
    // the Karte's three are the very same records
    for (const id of ['tlf', 'fire', 'hose']) expect(afterRemoval.find((o) => o.id === id)).toEqual(init.find((o) => o.id === id))
    undo()
    expect(byId(result.current.objects)).toEqual(byId(init))
    expect(result.current.board.gebaeude).toEqual(viewBefore)
    redo()
    expect(byId(result.current.objects)).toEqual(byId(afterRemoval))
    expect(onAnchorChange).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(false)
  })

  describe('every kind: placed on the Karte it stays, placed on the storey it goes', () => {
    const kinds: { kind: string; karte: TacticalObject; storey: BoardAnno }[] = [
      {
        kind: 'entity symbol',
        karte: karteEntity('k', { symbol: 'VKF Fahrzeug', floor: 2 }),
        storey: { id: 's', kind: 'symbol', symbol: 'VKF Fahrzeug', x: 0.4, y: 0.4, floor: 2 },
      },
      {
        kind: 'drawing line',
        karte: karteDrawing('k', { kind: 'line', floorTag: 2 }),
        storey: { id: 's', kind: 'draw', floor: 2, pts: [[0.3, 0.3, 2], [0.6, 0.5, 2]] },
      },
      {
        kind: 'area',
        karte: karteDrawing('k', { kind: 'area', floorTag: 2, coords: [stackAt(0.3, 0.3), stackAt(0.6, 0.3), stackAt(0.5, 0.6)] }),
        storey: { id: 's', kind: 'area', floor: 2, pts: [[0.3, 0.3, 2], [0.6, 0.3, 2], [0.5, 0.6, 2]] },
      },
      {
        kind: 'Trupp marker',
        karte: karteEntity('k', { kind: 'team', label: 'Trupp 1', floor: 2 }),
        storey: { id: 's', kind: 'resource', text: 'Trupp 1', x: 0.4, y: 0.4, floor: 2 },
      },
      {
        kind: 'note',
        karte: karteEntity('k', { kind: 'note', label: 'Schlüssel beim Hauswart', floor: 2 }),
        storey: { id: 's', kind: 'text', text: 'Schlüssel beim Hauswart', x: 0.4, y: 0.4, floor: 2 },
      },
    ]
    for (const { kind, karte, storey } of kinds) {
      it(kind, () => {
        const mine = own(storey)
        const { result, removeFloor, onAnchorChange } = mount([karte, mine])
        // the control: both ARE on storey 2 of the stack before
        expect(result.current.board.gebaeude?.map((a) => [a.id, a.floor ?? a.pts?.[0][2]])).toEqual([['k', 2], ['s', 2]])
        const { undo } = removeFloor(2)
        expect(result.current.objects).toEqual([karte])
        expect(onAnchorChange).not.toHaveBeenCalled()
        expect(result.current.canUndo).toBe(false)
        undo()
        expect(byId(result.current.objects)).toEqual(byId([karte, mine]))
      })
    }
  })

  it('the ↶ of «Geschoss hinzufügen» likewise sweeps only the new storey’s OWN annos', () => {
    // storey 3 has just been added: the Karte Fahrzeug badged «3» is shown on it at once
    const tlf = karteEntity('tlf', { symbol: 'VKF Fahrzeug', floor: 3 })
    const placed = own({ id: 'placed', kind: 'symbol', symbol: 'VKF Feuer', x: 0.2, y: 0.2, floor: 3 })
    const stays = own({ id: 'stays', kind: 'symbol', symbol: 'VKF Feuer', x: 0.2, y: 0.2, floor: 2 })
    const { result, onAnchorChange } = mount([tlf, placed, stays])
    expect(shownOn(result.current.board, 'tlf')).toEqual([3])
    // IncidentWorkspace · onAddFloor's restore, while the fits still name the added storey
    const owned = sheetAnchoredIds(result.current.objects, 'gebaeude')
    act(() => result.current.setBoard((b) => ({ ...b, gebaeude: withoutOwnOnStorey(b.gebaeude ?? [], owned, 3) }), { gesture: false }))
    expect(byId(result.current.objects)).toEqual(byId([tlf, stays]))
    expect(onAnchorChange).not.toHaveBeenCalled()
    expect(result.current.canUndo).toBe(false)
  })

  describe('the confirm asks about what the removal LOSES, counted by the same sweep', () => {
    /** IncidentWorkspace · onRemoveFloor up to the question: the sweep, then the ask off its count */
    const ask = async (init: TacticalObject[], floor: number) => {
      const { result } = mount(init)
      const r = result.current
      const sweep = removeStorey(r.board.gebaeude ?? [], sheetAnchoredIds(r.objects, 'gebaeude'), floor, FLOORS.filter((f) => f !== floor))
      ui.confirms.length = 0
      const go = await askStoreyRemoval(sweep.lost, `${floor}. OG`)
      return { sweep, go, confirms: [...ui.confirms] }
    }

    it('a storey showing ONLY Karte objects goes without a dialog', async () => {
      const { sweep, go, confirms } = await ask([
        karteEntity('tlf', { symbol: 'VKF Fahrzeug', floor: 2 }),
        karteDrawing('hose', { floorTag: 2 }),
        karteEntity('fire', { symbol: 'VKF Feuer', floorFrom: 1, floorTo: 3 }),
        own({ id: 'below', kind: 'symbol', symbol: 'VKF Feuer', x: 0.2, y: 0.2, floor: 1 }), // another storey's
      ], 2)
      expect(sweep.lost).toBe(0)
      expect(go).toBe(true)
      expect(confirms).toEqual([])
    })

    it('a storey with its own ink asks once, with the count of what is deleted or cut short', async () => {
      ui.answer = false
      const { sweep, go, confirms } = await ask([
        karteEntity('tlf', { symbol: 'VKF Fahrzeug', floor: 2 }), // shown there, not counted
        own({ id: 'up', kind: 'symbol', symbol: 'VKF Feuer', x: 0.2, y: 0.2, floor: 2 }), // deleted
        own({ id: 'riser', kind: 'draw', floor: 1, pts: [[0.2, 0.2, 1], [0.3, 0.3, 2], [0.4, 0.4, 3]] }), // cut short
        own({ id: 'chip', kind: 'resource', text: 'Trupp 1', x: 0.5, y: 0.5, floor: 1, trail: [{ x: 0.4, y: 0.4, floor: 2, t: '10:01' }] }), // loses its crumb
        own({ id: 'span', kind: 'symbol', symbol: 'VKF Feuer', x: 0.5, y: 0.5, floor: 1, floorFrom: 1, floorTo: 2 }), // shrinks
        own({ id: 'below', kind: 'symbol', symbol: 'VKF Feuer', x: 0.2, y: 0.2, floor: 1 }), // untouched
      ], 2)
      expect(sweep.lost).toBe(4)
      expect(confirms).toHaveLength(1)
      expect(confirms[0].message).toBe(fillTemplate(appConfig.copy.whiteboard.removeFloorConfirm, { floor: '2. OG', n: 4 }))
      expect(go).toBe(false) // «Abbrechen» calls it off
    })

    it('one own mark reads in the singular, and «Löschen» goes ahead', async () => {
      ui.answer = true
      const { go, confirms } = await ask([own({ id: 'up', kind: 'text', text: 'Schlüssel', x: 0.2, y: 0.2, floor: 3 })], 3)
      expect(confirms.map((c) => c.message)).toEqual([fillTemplate(appConfig.copy.whiteboard.removeFloorConfirmOne, { floor: '3. OG' })])
      expect(go).toBe(true)
    })
  })
})

// staging 25.09.2026: removing a storey wrote only its «… rückgängig gemacht», never itself —
// and what it did write said «gelöscht», the word that now means an extinguished Feuer
describe('the storey removal’s own Verlauf row', () => {
  it('names the storey, and what went with it when anything did — «entfernt»', () => {
    expect(storeyRemovedRow('3. OG', 0)).toBe('Geschoss 3. OG entfernt')
    expect(storeyRemovedRow('3. OG', 2)).toBe('Geschoss 3. OG entfernt – 2 Markierungen entfernt oder gekürzt')
  })
})

describe('the storey’s counter-row when it comes back', () => {
  it('says «wiederhergestellt», whether the toast or ↶ brought it back', () => {
    expect(storeyRestoredRow('3. OG')).toBe('Geschoss 3. OG wiederhergestellt')
  })
})

describe('the storey’s creation row and subject', () => {
  it('says «hinzugefügt», and every storey row names its storey as its subject', () => {
    expect(storeyAddedRow('4. OG')).toBe('Geschoss 4. OG hinzugefügt')
    expect(storeySubject(3)).not.toBe(storeySubject(4))
  })
})
