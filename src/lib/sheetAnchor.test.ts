// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useObjectStore, type ForeignSheetEditEvent } from './useObjectStore'
import { bakeGeoBody, withOwnAnnos, type AnchorChange, type PlanFit, type TacticalObject } from './tacticalObjects'
import { fitSimilarity, type GeorefPair } from './georef'
import { floorGeometry } from './whiteboard'
import { rotateAround } from './selectionTransform'
import { stateAt, type ReplayBundle } from './replay'
import { useTruppActions } from './useTruppActions'
import type { BoardAnno, BoardDoc, BoardPoint, Drawing, Entity, Trupp } from '../types'

/* The 23.09.2026 post-mortem, D2 and D3: an object's ANCHOR changed where nobody placed it.
 *
 * D2 — a ~0.3° ⟳ turn on Modul 1 of a Leitung the GEBÄUDE owns (its ink is lent to the other
 * linked sheets, planProjection · projectOntoSheet) moved it onto Modul 1 and dropped its storey,
 * and the SelectionBar's release event named no position, so the replay folded nothing.
 * D3 — the store's plan writer hard-coded `gesture = true`, so every MACHINE writer through it
 * could flip an anchor: a plan ↶, a Trupp settled at a hose end, a hose let go of its crew, a
 * Gebäude amend or storey removal.
 *
 * Fits are built from the field incident's own Modul 1 reference; the Gebäude stack's fit is
 * synthetic but turned like the real one (≈ −41.5°), because the turn is what makes a frame
 * mix-up visible at all. */

const M1_ASPECT = 0.7066508313539193
const M1_PAIRS: GeorefPair[] = [
  { kind: 'gesetzt', plan: { x: 0.40646005140408037, y: 0.454106488610659 }, lngLat: { lat: 47.522652515529245, lng: 7.548849468206271 } },
  { kind: 'gesetzt', plan: { x: 0.8802700125889643, y: 0.6190620876512668 }, lngLat: { lat: 47.52154187505511, lng: 7.552107430910155 } },
  { kind: 'gesetzt', plan: { x: 0.5861094693447954, y: 0.3146685417052829 }, lngLat: { lat: 47.523581674108925, lng: 7.550088730088248 } },
]
const MODUL1: PlanFit = { fit: fitSimilarity(M1_PAIRS, M1_ASPECT)!, aspect: M1_ASPECT }
const TILE_AR = 0.804343198933631
const origin = MODUL1.fit.toMap({ x: 0.40, y: 0.30 })
const mPerDegLat = 111320, mPerDegLng = 111320 * Math.cos((origin.lat * Math.PI) / 180)
// tile x runs 80 m along a bearing turned 41.49° off east — the building's long axis
const turn = (-41.49 * Math.PI) / 180
const tileEnd = { lng: origin.lng + (80 * Math.cos(turn)) / mPerDegLng, lat: origin.lat + (80 * Math.sin(turn)) / mPerDegLat }
const STACK: PlanFit = {
  fit: fitSimilarity([{ plan: { x: 0, y: 0 }, lngLat: origin }, { plan: { x: 1, y: 0 }, lngLat: tileEnd }], 1 / TILE_AR)!,
  aspect: 1 / TILE_AR,
  stack: { floors: [-1, 0, 1, 2, 3, 4] },
}
const FITS = new Map<string, PlanFit>([['gebaeude', STACK], ['modul1', MODUL1]])

const store = (init: TacticalObject[], opts: { onAnchorChange?: (c: AnchorChange[]) => void; onForeignSheetEdit?: (e: ForeignSheetEditEvent[]) => void } = {}) =>
  renderHook(() => useObjectStore(init, false, { getFits: () => FITS, defaultLayer: 'taktisch', fitsVersion: 0, ...opts }))

// prod 23.09.2026 18:24:41, l1790187881920: «T2 abgesucht ko plett», drawn on the 1. OG
const FIELD_GEBAEUDE_LINE: BoardAnno = {
  id: 'l1790187881920', kind: 'draw', color: '#1b2330', width: 5, floor: 1, label: 'T2 abgesucht ko plett',
  pts: [[0.10736599736074552, 0.6424166060050425, 1], [0.1159275844965758, 0.6246818289069909, 1], [0.16349215595582003, 0.590394481237845, 1], [0.3727761135269809, 0.48162070141762214, 1]],
}
const gebaeudeLine = () => bakeGeoBody({ id: FIELD_GEBAEUDE_LINE.id, sheet: { planId: 'gebaeude', anno: FIELD_GEBAEUDE_LINE } }, STACK, 'taktisch')

/** the SelectionBar's writer on a single sheet (Whiteboard · barApply → floorGeometry · moveRigid) */
const flat = floorGeometry(false, [0], 1)
const barTurn = (a: BoardAnno, deg: number): BoardAnno => {
  const bpts = flat.boardPts(a.pts!, a.floor ?? 0)
  const c: [number, number] = [bpts.reduce((s, p) => s + p[0], 0) / bpts.length, bpts.reduce((s, p) => s + p[1], 0) / bpts.length]
  return { ...a, pts: flat.moveRigid(bpts, a.floor ?? 0, (x, by) => rotateAround([x, by], c, deg, { xScale: M1_ASPECT })) }
}
const barMove = (a: BoardAnno, ndx: number, ndy: number): BoardAnno =>
  ({ ...a, pts: flat.moveRigid(flat.boardPts(a.pts!, a.floor ?? 0), a.floor ?? 0, (x, by) => [x + ndx, by + ndy]) })

const onModul1 = (board: BoardDoc, id: string) => board.modul1!.find((a) => a.id === id)!
const closePts = (a: readonly BoardPoint[], b: readonly BoardPoint[], digits = 9) => {
  expect(a.length).toBe(b.length)
  a.forEach((p, i) => { expect(p[0]).toBeCloseTo(b[i][0], digits); expect(p[1]).toBeCloseTo(b[i][1], digits) })
}

describe('a Gebäude object moved through Modul 1 stays the Gebäude’s (post-mortem D2)', () => {
  it('the field turn (19:00:54, ~0.3°): owner, storey and every vertex’s storey survive', () => {
    const changes = vi.fn()
    const { result } = store([gebaeudeLine()], { onAnchorChange: changes })
    const shown = onModul1(result.current.board, FIELD_GEBAEUDE_LINE.id)
    expect(shown.pts!.every((p) => p.length === 2)).toBe(true) // the lent anno states no storey
    const turned = barTurn(shown, 0.3)
    act(() => {
      result.current.beginSheetStep()
      result.current.setBoard((b) => ({ ...b, modul1: b.modul1!.map((a) => (a.id === turned.id ? turned : a)) }))
      result.current.endSheetStep()
    })
    const o = result.current.objects[0]
    expect(o.sheet?.planId).toBe('gebaeude')
    expect(o.sheet?.anno.floor).toBe(1)
    expect(o.sheet?.anno.pts!.map((p) => p[2])).toEqual([1, 1, 1, 1])
    // the derived end tag is not frozen onto the owner by the round trip
    expect(o.sheet?.anno.floorTag).toBeUndefined()
    expect(o.drawing?.floorTag).toBe(1)
    expect(changes).not.toHaveBeenCalled()
    // …and the turn happened: Modul 1 now shows exactly what the hand left there
    closePts(onModul1(result.current.board, turned.id).pts!, turned.pts!)
    // one ↶ puts it all back, on the store's stack (the sheet does not own what it touched)
    act(() => { result.current.undo() })
    expect(result.current.objects).toEqual([gebaeudeLine()])
  })

  it('a ✥ move likewise — written into the owner’s paper through both fits', () => {
    const { result } = store([gebaeudeLine()])
    const moved = barMove(onModul1(result.current.board, FIELD_GEBAEUDE_LINE.id), 0.004, -0.003)
    act(() => result.current.setBoard((b) => ({ ...b, modul1: b.modul1!.map((a) => (a.id === moved.id ? moved : a)) })))
    const o = result.current.objects[0]
    expect(o.sheet?.planId).toBe('gebaeude')
    expect(o.sheet?.anno.pts!.every((p) => p[2] === 1)).toBe(true)
    closePts(onModul1(result.current.board, moved.id).pts!, moved.pts!)
    // the map body is the OWNER's derivation, not a copy of Modul 1's bake
    expect(bakeGeoBody(o, STACK, 'taktisch')).toBe(o)
  })

  it('a symbol keeps its tile and its Von/Bis', () => {
    const fire: BoardAnno = { id: 'f', kind: 'symbol', symbol: 'VKF Feuer', x: 0.3, y: 0.4, floor: 2, floorFrom: 2, floorTo: 3 }
    const { result } = store([bakeGeoBody({ id: 'f', sheet: { planId: 'gebaeude', anno: fire } }, STACK, 'taktisch')])
    act(() => result.current.setBoard((b) => ({ ...b, modul1: b.modul1!.map((a) => (a.id === 'f' ? { ...a, x: a.x! + 0.003 } : a)) })))
    const o = result.current.objects[0]
    expect(o.sheet?.planId).toBe('gebaeude')
    expect(o.sheet?.anno).toMatchObject({ floor: 2, floorFrom: 2, floorTo: 3 })
    expect(o.sheet?.anno.x).not.toBeCloseTo(0.3, 6)
  })

  it('dragged by HAND off the building, Modul 1 takes it — the one move the owner cannot hold', () => {
    const changes = vi.fn()
    const { result } = store([gebaeudeLine()], { onAnchorChange: changes })
    const away = barMove(onModul1(result.current.board, FIELD_GEBAEUDE_LINE.id), 0.3, 0.3)
    act(() => result.current.setBoard((b) => ({ ...b, modul1: b.modul1!.map((a) => (a.id === away.id ? away : a)) })))
    expect(result.current.objects[0].sheet?.planId).toBe('modul1')
    expect(changes).toHaveBeenCalledTimes(1)
  })

  it('…while a MACHINE never re-homes it, however far', () => {
    const { result } = store([gebaeudeLine()])
    const away = barMove(onModul1(result.current.board, FIELD_GEBAEUDE_LINE.id), 0.3, 0.3)
    act(() => result.current.setBoard((b) => ({ ...b, modul1: b.modul1!.map((a) => (a.id === away.id ? away : a)) }), { gesture: false }))
    expect(result.current.objects[0].sheet?.planId).toBe('gebaeude')
    expect(result.current.objects[0].sheet?.anno.floor).toBe(1)
  })

  it('the replay reproduces the owner’s geometry from the events the move emits', async () => {
    const initial = gebaeudeLine()
    const events: ForeignSheetEditEvent[] = []
    const { result } = store([initial], { onForeignSheetEdit: (e) => events.push(...e) })
    const turned = barTurn(onModul1(result.current.board, initial.id), 0.3)
    act(() => {
      result.current.beginSheetStep()
      result.current.setBoard((b) => ({ ...b, modul1: b.modul1!.map((a) => (a.id === turned.id ? turned : a)) }))
      result.current.endSheetStep()
    })
    expect(events.map((e) => e.op)).toEqual(['board.edit', 'draw.edit'])
    // …plus the surface's own release event (Whiteboard · barCommit), which a replay of Modul 1's
    // recorded board has no row for — it must fold to nothing rather than to a second copy
    const all = [...events, { op: 'board.move', payload: { id: initial.id, pts: turned.pts, planId: 'modul1' } }]
    const replay: ReplayBundle = {
      incidentId: 'i', startMs: 0, endMs: 1000, samples: [], snapshotCache: new Map(),
      events: all.map((e, seq) => ({ seq, occurred_at: new Date(100).toISOString(), op_type: e.op, payload_json: JSON.parse(JSON.stringify(e.payload)) })),
      loadSnapshotAt: async () => ({ occurredMs: 0, workspace: { entities: [], drawings: [initial.drawing!], board: { gebaeude: [initial.sheet!.anno] }, recent: [], layerState: [], timeline: [] } }),
    }
    const state = await stateAt(replay, 200)
    expect(state?.board?.gebaeude[0]).toEqual(result.current.objects[0].sheet!.anno)
    expect(state?.drawings[0].coords).toEqual(result.current.objects[0].drawing!.coords)
    expect(state?.board?.modul1 ?? []).toHaveLength(0)
  })
})

describe('a stroke’s release event carries its position (post-mortem D2 · barCommit)', () => {
  it('board.move with `pts` folds the stroke’s geometry in a replay', async () => {
    const line: BoardAnno = { id: 'd', kind: 'draw', pts: [[0.1, 0.1], [0.2, 0.3]] }
    const moved = barMove(line, 0.05, 0.02)
    const replay: ReplayBundle = {
      incidentId: 'i', startMs: 0, endMs: 1000, samples: [], snapshotCache: new Map(),
      events: [{ seq: 0, occurred_at: new Date(100).toISOString(), op_type: 'board.move', payload_json: { id: 'd', pts: moved.pts, planId: 'modul1' } }],
      loadSnapshotAt: async () => ({ occurredMs: 0, workspace: { entities: [], drawings: [], board: { modul1: [line] }, recent: [], layerState: [], timeline: [] } }),
    }
    expect((await stateAt(replay, 200))?.board?.modul1[0].pts).toEqual(moved.pts)
    // the payload the bar sent before: no position at all, so nothing to fold
    const thin = { ...replay, snapshotCache: new Map(), events: [{ ...replay.events[0], payload_json: { id: 'd', planId: 'modul1' } }] }
    expect((await stateAt(thin, 200))?.board?.modul1[0].pts).toEqual(line.pts)
  })

  it('prod 18:13:08: a Karte Leitung dragged on Modul 1 becomes Modul 1’s, with no storey invented', () => {
    // d1790186502206-25laj, drawn on the Karte 18:01:42 (first four vertices)
    const drawing: Drawing = { id: 'k', kind: 'line', color: '#1f6feb', width: 4, coords: [[7.549859457217963, 47.52250880437694], [7.5499528885093525, 47.522451263306664], [7.550030735359769, 47.522442144984154], [7.550107875014135, 47.52245614639054]] }
    const { result } = store([{ id: 'k', drawing }])
    const shown = onModul1(result.current.board, 'k')
    const moved = barMove(shown, 0.0157, -0.007)
    act(() => result.current.setBoard((b) => ({ ...b, modul1: b.modul1!.map((a) => (a.id === 'k' ? moved : a)) })))
    const o = result.current.objects[0]
    expect(o.sheet?.planId).toBe('modul1') // a hand placement from the Karte onto paper: the flip is right
    expect(o.sheet?.anno.pts!.every((p) => p.length === 2)).toBe(true) // it wrote `[x, y, 0]` in the field
    closePts(o.sheet!.anno.pts!, moved.pts!, 12)
  })

  it('an unmoved projection handed back is no drag — the writer keeps its arity', () => {
    const drawing: Drawing = { id: 'k', kind: 'line', coords: [[7.5499, 47.5225], [7.5501, 47.5226]] }
    const init = [{ id: 'k', drawing }]
    const { result } = store(init)
    const same = barMove(onModul1(result.current.board, 'k'), 0, 0)
    const before = result.current.objects
    act(() => result.current.setBoard((b) => ({ ...b, modul1: b.modul1!.map((a) => (a.id === 'k' ? same : a)) })))
    expect(result.current.objects).toBe(before)
  })
})

/* ── D3 — every machine writer leaves anchors where they are ─────────────────────────────── */

const anchors = (objects: TacticalObject[]) => Object.fromEntries(objects.map((o) => [o.id, o.sheet?.planId ?? 'geo']))

const trupp: Trupp = {
  id: 'T1', name: 'Keller Anna', entryPressureBar: 300, entryTime: '2026-07-06T10:00:00Z',
  lastContactTime: '2026-07-06T10:00:00Z', status: 'aktiv',
} as Trupp

/** useTruppActions wired to the REAL store — the writers, not a stand-in for them */
function truppActions(result: { current: ReturnType<typeof useObjectStore> }, trupps: Trupp[]) {
  const s = result.current
  // eslint-disable-next-line react-hooks/rules-of-hooks -- plain closure factory, no hooks inside
  return useTruppActions({
    trupps, drawings: s.doc.drawings, entities: s.doc.entities, objects: s.objects,
    setTrupps: () => {}, board: s.board, setBoard: s.setBoard, setDocRaw: s.setDocRaw, building: null,
    log: () => {}, logPlan: () => {}, emit: () => {},
    setMode: () => {}, setActivePlanId: () => {}, setPanel: () => {}, setPlanFocus: () => {},
    mapCenter: () => [7.55, 47.52], focusMapEntity: () => {}, focusMapDrawing: () => {},
  })
}

const at = (x: number, y: number) => { const p = MODUL1.fit.toMap({ x, y }); return [p.lng, p.lat] as [number, number] }
const stackAt = (x: number, y: number) => { const p = STACK.fit.toMap({ x, y }); return [p.lng, p.lat] as [number, number] }

describe('machine writers never flip an anchor (post-mortem D3)', () => {
  const table: { writer: string; init: () => TacticalObject[]; run: (r: { current: ReturnType<typeof useObjectStore> }) => void; moved: string }[] = [
    {
      writer: 'settleAtHoseEnd — a Gebäude Trupp chip moved to a Karte hose’s end (setDocRaw)',
      init: () => [
        bakeGeoBody({ id: 'chip', sheet: { planId: 'gebaeude', anno: { id: 'chip', kind: 'resource', x: 0.5, y: 0.5, floor: 2, text: 'Trupp 1', truppId: 'T1' } } }, STACK, 'taktisch'),
        { id: 'hose', drawing: { id: 'hose', kind: 'line', coords: [at(0.3, 0.3), stackAt(0.55, 0.45)] } },
      ],
      run: (r) => { truppActions(r, [trupp]).linkTruppLine('T1', 'hose') },
      moved: 'chip',
    },
    {
      writer: 'settleAtHoseEnd — a Karte Trupp marker lent to Modul 1, moved to a Modul 1 hose’s end (setBoard)',
      init: () => [
        { id: 'mk', entity: { id: 'mk', kind: 'team', layer: 'taktisch', coord: at(0.5, 0.5), label: 'Trupp 1', truppId: 'T1' } as Entity },
        { id: 'p1', sheet: { planId: 'modul1', anno: { id: 'p1', kind: 'draw', pts: [[0.2, 0.2], [0.52, 0.47]] } } },
      ],
      run: (r) => { truppActions(r, [trupp]).linkTruppLine('T1', 'p1') },
      moved: 'mk',
    },
    {
      writer: 'unlinkTruppLine — a Gebäude hose’s end let go at the Karte marker (setDocRaw)',
      init: () => {
        const line = bakeGeoBody({ id: 'gl', sheet: { planId: 'gebaeude', anno: { id: 'gl', kind: 'draw', floor: 1, truppId: 'T1', pts: [[0.2, 0.3, 1], [0.5, 0.5, 1]] } } }, STACK, 'taktisch')
        return [
          { id: 'mk', entity: { id: 'mk', kind: 'team', layer: 'taktisch', coord: stackAt(0.52, 0.52), truppId: 'T1' } as Entity },
          { ...line, drawing: { ...line.drawing!, endAttachment: { target: { kind: 'object', id: 'mk' }, routing: 'trace' } } },
        ]
      },
      run: (r) => { truppActions(r, [{ ...trupp, lineId: 'gl', lineNo: 1 }]).unlinkTruppLine('T1') },
      moved: 'gl',
    },
    {
      writer: 'plan ↶ (planStepAt / useBoardDoc) — a snapshot holding a Karte object at an older spot',
      init: () => [{ id: 's', entity: { id: 's', kind: 'symbol', layer: 'taktisch', symbol: 'VKF Feuer', coord: at(0.5, 0.5) } }],
      run: (r) => {
        const snapshot = r.current.board.modul1!
        act(() => r.current.commit((d) => ({ ...d, entities: d.entities.map((e) => ({ ...e, coord: at(0.6, 0.6) })) })))
        act(() => r.current.setBoard((b) => ({ ...b, modul1: snapshot }), { gesture: false }))
      },
      moved: 's',
    },
    {
      writer: 'Gebäude amend — own ink re-anchored, the Karte’s projections left as shown',
      init: () => [
        { id: 'g', entity: { id: 'g', kind: 'symbol', layer: 'taktisch', symbol: 'VKF Feuer', coord: stackAt(0.4, 0.4) } },
        bakeGeoBody({ id: 'own', sheet: { planId: 'gebaeude', anno: { id: 'own', kind: 'symbol', symbol: 'VKF Feuer', x: 0.2, y: 0.2, floor: 0 } } }, STACK, 'taktisch'),
      ],
      run: (r) => {
        const own = r.current.board.gebaeude!.filter((a) => a.id === 'own').map((a) => ({ ...a, x: 0.25 }))
        act(() => r.current.setBoard((b) => ({ ...b, gebaeude: withOwnAnnos(b.gebaeude, new Set(['own']), own) }), { gesture: false }))
      },
      moved: 'own',
    },
    {
      writer: 'storey removal — a sweep of storey 1, everything else handed back as shown',
      init: () => [
        { id: 'g', entity: { id: 'g', kind: 'symbol', layer: 'taktisch', symbol: 'VKF Feuer', coord: stackAt(0.4, 0.4) } },
        bakeGeoBody({ id: 'up', sheet: { planId: 'gebaeude', anno: { id: 'up', kind: 'symbol', symbol: 'VKF Feuer', x: 0.2, y: 0.2, floor: 1 } } }, STACK, 'taktisch'),
      ],
      run: (r) => { act(() => r.current.setBoard((b) => ({ ...b, gebaeude: b.gebaeude!.filter((a) => (a.floor ?? 0) !== 1) }), { gesture: false })) },
      moved: '',
    },
  ]

  for (const { writer, init, run, moved } of table) {
    it(writer, () => {
      const changes = vi.fn()
      const { result } = store(init(), { onAnchorChange: changes })
      const before = anchors(result.current.objects)
      const was = result.current.objects.find((o) => o.id === moved)
      act(() => run(result))
      const after = anchors(result.current.objects)
      // every object still there stands on the surface it stood on
      for (const [id, a] of Object.entries(after)) expect([id, a]).toEqual([id, before[id]])
      expect(changes).not.toHaveBeenCalled()
      // …and the writer DID write (a vacuous pass would prove nothing)
      if (moved) expect(result.current.objects.find((o) => o.id === moved)).not.toEqual(was)
      const sheet = result.current.objects.find((o) => o.id === moved)?.sheet
      if (sheet?.planId === 'gebaeude') expect(sheet.anno.floor).toBe(was?.sheet?.anno.floor)
    })
  }

  it('…where a GESTURE doing the same does flip — the control for the table above', () => {
    const [chip, hose] = table[1].init()
    const { result } = store([chip, hose])
    const end = result.current.board.modul1!.find((a) => a.id === 'p1')!.pts![1]
    act(() => result.current.setBoard((b) => ({ ...b, modul1: b.modul1!.map((a) => (a.id === 'mk' ? { ...a, x: end[0], y: end[1] } : a)) })))
    expect(result.current.objects.find((o) => o.id === 'mk')?.sheet?.planId).toBe('modul1')
  })
})
