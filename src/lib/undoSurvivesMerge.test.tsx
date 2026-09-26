// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { useRef, useState } from 'react'
import { act, renderHook } from '@testing-library/react'
import { boardViewOf, useObjectStore, type ObjectStore } from './useObjectStore'
import { mergeWorkspace } from './mergeWorkspace'
import { useUndoableSlice, type UndoableSlice } from './useUndoableSlice'
import { pushSliceStep } from './sliceUndoStep'
import { createUndoTimeline, type UndoTimeline } from './undoTimeline'
import { WORKSPACE_RECORDS, carryUndoThroughMerge, objectRefs, planViewChanges, recordByKey, recordDiff, recordKey, workspaceChanges, type RecordKey, type RecordShape } from './undoKeys'
import { keepPlanSteps, newPlanStep, planStackTouches, pushBoardPast, type BoardHistory } from '../components/useBoardDoc'
import { objectsFromLegacy, type TacticalObject } from './tacticalObjects'
import type { AttendanceState, BoardAnno, Entity } from '../types'

/**
 * «Undo that survives other devices' saves» (staging walk-through N5, 25.09.2026): within ~2 s of
 * ANY remote save the local ↶ went grey, because a hydrate dropped the whole timeline. Now a merge
 * drops only the steps whose inverse it invalidated.
 *
 * Wired the way IncidentWorkspace wires it, with the REAL domains: the Karte's object store
 * (delegating, re-laid per object), an undoable slice (the Anwesenheit — delegating, re-laid per
 * person) and Trupp closure entries (own inverse, one Trupp each, as useTruppActions · remember).
 * The hydrate below is `applyWorkspace`'s undo half, verbatim in shape.
 */

interface Trupp { id: string; v: number }
interface Ws { objects: TacticalObject[]; attendance: AttendanceState; trupps: Trupp[] }

const ATT = recordByKey<AttendanceState[string]>('attendance')
const sym = (id: string, label = id): Entity => ({ id, kind: 'symbol', layer: 'taktisch', coord: [7.55, 47.51], label })
const presence = (s: string) => ({ status: s } as unknown as AttendanceState[string])

function useDevice(init: Ws) {
  const [timeline] = useState<UndoTimeline>(() => createUndoTimeline())
  // the store's writers keep one identity for its life (useObjectStore · stable writers), so the
  // entry may call them on the `store` of any render — as IncidentWorkspace's refs do
  const store: ObjectStore = useObjectStore(init.objects, false, {
    getFits: () => new Map(), fitsVersion: 0, defaultLayer: 'taktisch',
    onCheckpoint: (step) => timeline.push({
      domain: 'karte', label: 'Karte', step,
      touches: () => store.stepKeys(step),
      undo: () => store.undo(step),
      redo: () => store.redo(step),
    }),
  })
  const [attendance, setAttendance] = useState(init.attendance)
  const att = useUndoableSlice(attendance, setAttendance, false, undefined, ATT)
  // (any render's slice object will do: its stacks are refs shared by every render)
  const attRef: { readonly current: UndoableSlice<AttendanceState> } = { current: att }
  const [trupps, setTruppsState] = useState(init.trupps)
  // the live list, like useTruppActions' `liveTrupps()` — a closure entry checks it when it runs
  const truppsLive = useRef(trupps)
  const setTrupps = (next: Trupp[]) => { truppsLive.current = next; setTruppsState(next) }

  const placeSymbol = (id: string) => store.commit((d) => ({ ...d, entities: [...d.entities, sym(id)] }))
  const relabel = (id: string, label: string) => store.commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === id ? { ...e, label } : e)) }))
  const removeSymbol = (id: string) => store.commit((d) => ({ ...d, entities: d.entities.filter((e) => e.id !== id) }))
  const mark = (person: string, status: string | null) => {
    const laid = att.set((cur) => {
      const next = { ...cur }
      if (status === null) delete next[person]; else next[person] = presence(status)
      return next
    })
    pushSliceStep(timeline, { domain: 'anwesenheit', label: 'Anwesenheit', laid, histRef: attRef, record: (moved) => !!moved })
  }
  const editTrupp = (id: string, v: number) => {
    const before = truppsLive.current.find((t) => t.id === id)
    if (!before) return
    const write = (t: Trupp) => {
      if (!truppsLive.current.some((x) => x.id === id)) return false
      setTrupps(truppsLive.current.map((x) => (x.id === id ? t : x)))
      return true
    }
    write({ id, v })
    timeline.push({ domain: 'trupps', label: `Trupp ${id}`, touches: () => [recordKey('trupps', id)], undo: () => write(before), redo: () => write({ id, v }) })
  }
  /** `applyWorkspace`'s undo half: what changed, what the timeline keeps, each domain re-laid */
  const hydrate = (next: Ws) => {
    const changed = workspaceChanges({ objects: store.liveObjects(), attendance, trupps: truppsLive.current }, next)
    timeline.rebase(changed)
    const live = timeline.steps()
    const keep = (step: string) => live.has(step)
    store.rebaseObjects(next.objects, keep)
    setAttendance(next.attendance)
    att.rebase(next.attendance, keep)
    setTrupps(next.trupps)
    return changed
  }
  return { timeline, store, attendance, trupps, placeSymbol, relabel, removeSymbol, mark, editTrupp, hydrate }
}

const initial = (): Ws => ({
  objects: objectsFromLegacy([sym('fz1'), sym('fz2')], [], {}),
  attendance: { p1: presence('anwesend') },
  trupps: [{ id: 't1', v: 0 }, { id: 't2', v: 0 }],
})

describe('undo survives another device’s save', () => {
  it('A places a symbol, B edits an unrelated Trupp and saves — A’s ↶ still removes A’s symbol', () => {
    const { result } = renderHook(() => useDevice(initial()))
    act(() => result.current.placeSymbol('mine'))
    expect(result.current.timeline.canUndo()).toBe(true)

    // B's save arrives: the same objects (A's symbol already merged in), Trupp 2 edited
    const theirs: Ws = {
      objects: result.current.store.liveObjects().map((o) => ({ ...o })),
      attendance: { ...result.current.attendance },
      trupps: result.current.trupps.map((t) => (t.id === 't2' ? { ...t, v: 42 } : t)),
    }
    act(() => { result.current.hydrate(theirs) })

    // ↶ is still there, and still means A's symbol
    expect(result.current.timeline.canUndo()).toBe(true)
    act(() => { expect(result.current.timeline.undo().status).toBe('done') })
    expect(result.current.store.doc.entities.map((e) => e.id)).toEqual(['fz1', 'fz2'])
    // …and B's Trupp edit is untouched by it
    expect(result.current.trupps.find((t) => t.id === 't2')?.v).toBe(42)
  })

  // review of #234, reproduced: the ↷ re-docked the placard at the host's PRE-merge position
  it('A docks a placard onto a host and takes it back; B moves the host ~1 km — A’s ↷ no longer re-docks', () => {
    const { result } = renderHook(() => useDevice(initial()))
    act(() => result.current.placeSymbol('P'))
    act(() => result.current.store.commit((d) => ({ ...d, entities: d.entities.map((e) => (e.id === 'P' ? { ...e, dockedTo: 'fz1' } : e)) })))
    act(() => { result.current.timeline.undo() })
    expect(result.current.timeline.peekRedo()).not.toBeNull()
    const theirs: Ws = {
      objects: result.current.store.liveObjects().map((o) => (o.id === 'fz1' ? { ...o, entity: { ...o.entity!, coord: [7.563, 47.51] } } : o)),
      attendance: result.current.attendance, trupps: result.current.trupps,
    }
    act(() => { result.current.hydrate(theirs) })
    expect(result.current.timeline.canRedo()).toBe(false) // the dock step named the host
    expect(result.current.store.doc.entities.find((e) => e.id === 'P')?.dockedTo).toBeUndefined()
    // the placement of P itself did not touch the host — it stays takeable
    act(() => { expect(result.current.timeline.undo().status).toBe('done') })
    expect(result.current.store.doc.entities.map((e) => e.id)).toEqual(['fz1', 'fz2'])
    expect(result.current.store.doc.entities[0].coord).toEqual([7.563, 47.51])
  })

  it('keeps a Karte step when another device changed a DIFFERENT object — and never reverts that one', () => {
    const { result } = renderHook(() => useDevice(initial()))
    act(() => result.current.relabel('fz1', 'TLF'))
    act(() => result.current.placeSymbol('mine'))
    const theirs: Ws = {
      objects: [...result.current.store.liveObjects().map((o) => (o.id === 'fz2' ? { ...o, entity: { ...o.entity!, label: 'B' } } : o)), { id: 'b-new', entity: sym('b-new') }],
      attendance: result.current.attendance, trupps: result.current.trupps,
    }
    act(() => { result.current.hydrate(theirs) })
    act(() => { result.current.timeline.undo() })
    act(() => { result.current.timeline.undo() })
    const ents = result.current.store.doc.entities
    expect(ents.map((e) => e.id).sort()).toEqual(['b-new', 'fz1', 'fz2'])
    expect(ents.find((e) => e.id === 'fz1')?.label).toBe('fz1') // my relabel taken back
    expect(ents.find((e) => e.id === 'fz2')?.label).toBe('B') // theirs stands
  })

  it('drops exactly the step whose object the other device changed, and the ones behind it on that object', () => {
    const { result } = renderHook(() => useDevice(initial()))
    act(() => result.current.relabel('fz1', 'one'))
    act(() => result.current.placeSymbol('mine'))
    act(() => result.current.relabel('fz1', 'two'))
    act(() => result.current.mark('p2', 'anwesend'))
    const theirs: Ws = {
      objects: result.current.store.liveObjects().map((o) => (o.id === 'fz1' ? { ...o, entity: { ...o.entity!, label: 'B' } } : o)),
      attendance: result.current.attendance, trupps: result.current.trupps,
    }
    act(() => { result.current.hydrate(theirs) })
    // left: the Anwesenheit and the symbol; both relabels of fz1 are gone
    expect(result.current.timeline.entries().past.map((e) => e.label)).toEqual(['Karte', 'Anwesenheit'])
    act(() => { result.current.timeline.undo() })
    act(() => { result.current.timeline.undo() })
    expect(result.current.attendance.p2).toBeUndefined()
    expect(result.current.store.doc.entities.map((e) => e.id)).toEqual(['fz1', 'fz2'])
    expect(result.current.store.doc.entities[0].label).toBe('B')
    expect(result.current.timeline.canUndo()).toBe(false)
  })
})

/* ── property: random local work, real three-way merges ⇒ an undo/redo never rewrites a record
 *    another device changed, never re-states a link to one, and nothing ever throws ────────── */

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Crew { id: string; v: number; w: number }
interface Att { id: string; caption?: string }
/** the synced state the property device holds — the fields of `Saved` it exercises */
interface Rich { objects: TacticalObject[]; attendance: AttendanceState; trupps: Crew[]; attachments: Att[] }
const RICH_FIELDS = ['objects', 'attendance', 'trupps', 'attachments'] as const
const PLAN = 'modul2'
const NO_FITS = new Map()

/**
 * Every join type at once, wired as IncidentWorkspace wires it: the Karte store (commits, a drag
 * gesture), a plan's view-snapshot stack restored through `setBoard`, an undoable slice, Trupp
 * closure entries and Beilagen closure entries — and the hydrate is `carryUndoThroughMerge`, the
 * very function `applyWorkspace` runs.
 */
/** which merge each entry was laid after (keyed by its `undo`, which the timeline hands back
 *  with the entry it steps) — a step laid after a merge has read the merged value of whatever
 *  it links to, so only a LATER merge makes that link stale */
const LAID = new WeakMap<object, number>()
const EPOCH = { now: 0 }

function useRich(init: Rich) {
  const [timeline] = useState<UndoTimeline>(() => {
    const t = createUndoTimeline()
    const push = t.push
    t.push = (e) => { LAID.set(e.undo, EPOCH.now); return push(e) }
    return t
  })
  const store: ObjectStore = useObjectStore(init.objects, false, {
    getFits: () => NO_FITS, fitsVersion: 0, defaultLayer: 'taktisch',
    onCheckpoint: (step) => timeline.push({
      domain: 'karte', label: 'Karte', step,
      touches: () => store.stepKeys(step), undo: () => store.undo(step), redo: () => store.redo(step),
    }),
  })
  const [attendance, setAttendance] = useState(init.attendance)
  const att = useUndoableSlice(attendance, setAttendance, false, undefined, ATT)
  const attRef: { readonly current: UndoableSlice<AttendanceState> } = { current: att }
  const [trupps, setTruppsState] = useState(init.trupps)
  const truppsLive = useRef(trupps)
  const setTrupps = (next: Crew[]) => { truppsLive.current = next; setTruppsState(next) }
  const [attachments, setAttState] = useState(init.attachments)
  const attLive = useRef(attachments)
  const setAttachments = (next: Att[]) => { attLive.current = next; setAttState(next) }
  const [, setPlanHistState] = useState<BoardHistory>({})
  const planHist = useRef<BoardHistory>({})
  const setPlanHist = (fn: (h: BoardHistory) => BoardHistory) => { planHist.current = fn(planHist.current); setPlanHistState(planHist.current) }
  const liveBoard = () => boardViewOf(store.liveObjects(), NO_FITS)[PLAN] ?? []

  const commit = (fn: (es: Entity[]) => Entity[]) => store.commit((d) => ({ ...d, entities: fn(d.entities) }))
  const mark = (person: string, status: string | null) => {
    const laid = att.set((cur) => {
      const next = { ...cur }
      if (status === null) delete next[person]; else next[person] = presence(status)
      return next
    })
    pushSliceStep(timeline, { domain: 'anwesenheit', label: 'Anwesenheit', laid, histRef: attRef, record: (m) => !!m })
  }
  /** a closure entry over one record of a plain list — useTruppActions · remember, useRowMediaUpload */
  const closure = <T extends { id: string }>(field: 'trupps' | 'attachments', live: { current: T[] }, set: (n: T[]) => void, id: string, after: T | null) => {
    const before = live.current.find((x) => x.id === id) ?? null
    const put = (v: T | null) => {
      const rest = live.current.filter((x) => x.id !== id)
      set(v ? (live.current.some((x) => x.id === id) ? live.current.map((x) => (x.id === id ? v : x)) : [...rest, v]) : rest)
      return true
    }
    put(after)
    timeline.push({ domain: 'trupps', label: field, touches: () => [recordKey(field, id)], undo: () => put(before), redo: () => put(after) })
  }
  const planEdit = (fn: (annos: BoardAnno[]) => BoardAnno[]) => {
    const step = newPlanStep()
    const before = liveBoard()
    setPlanHist((h) => pushBoardPast(h, PLAN, before, step))
    store.setBoard((b) => ({ ...b, [PLAN]: fn(b[PLAN] ?? []) }))
    const go = (dir: 'undo' | 'redo') => {
      const c = planHist.current[PLAN]
      const to = dir === 'undo' ? c?.past[c.past.length - 1] : c?.future[0]
      if (!to || to.id !== step) return false
      const from = { id: to.id, snap: liveBoard() }
      setPlanHist((h) => {
        const cc = h[PLAN]!
        return { ...h, [PLAN]: dir === 'undo' ? { past: cc.past.slice(0, -1), future: [from, ...cc.future] } : { past: [...cc.past, from], future: cc.future.slice(1) } }
      })
      store.setBoard((b) => ({ ...b, [PLAN]: to.snap }), { gesture: false })
      return true
    }
    timeline.push({
      domain: 'plan', scope: PLAN, label: 'Plan', step,
      touches: () => planStackTouches(PLAN, planHist.current[PLAN], liveBoard()), undo: () => go('undo'), redo: () => go('redo'),
    })
  }
  const state = (): Rich => ({ objects: store.liveObjects(), attendance, trupps: truppsLive.current, attachments: attLive.current })
  const hydrate = (next: Rich) => {
    const prev = state()
    const prevBoard = boardViewOf(prev.objects, NO_FITS)
    setAttendance(next.attendance); setTrupps(next.trupps); setAttachments(next.attachments)
    return carryUndoThroughMerge(timeline, () => {
      const changed = workspaceChanges(prev, next)
      for (const k of planViewChanges(prevBoard, () => boardViewOf(next.objects, NO_FITS), changed)) changed.add(k)
      return changed
    }, [
      { rebase: (keep) => store.rebaseObjects(next.objects, keep), drop: () => store.replaceObjects(next.objects) },
      { rebase: (keep) => att.rebase(next.attendance, keep), drop: () => att.clear() },
      { rebase: (keep) => setPlanHist((h) => keepPlanSteps(h, keep)), drop: () => setPlanHist(() => ({})) },
    ])
  }
  return { timeline, store, state, commit, mark, closure, planEdit, hydrate, truppsLive, attLive, setTrupps, setAttachments }
}

const shapeOf = (f: typeof RICH_FIELDS[number]) => WORKSPACE_RECORDS[f] as RecordShape<unknown>
/** every record whose value differs between two states */
const movedRich = (a: Rich, b: Rich): Set<RecordKey> => {
  const out = new Set<RecordKey>()
  for (const f of RICH_FIELDS) for (const k of recordDiff(a[f], b[f], shapeOf(f)).keys()) out.add(k)
  return out
}
const objectValue = (s: Rich, key: RecordKey) => s.objects.find((o) => `objects:${o.id}` === key)

describe('property — an undo never rewrites what another device changed', () => {
  const SEEDS = 40
  const OPS = 60
  it(`holds over ${SEEDS} random sessions of ${OPS} operations with real three-way merges`, () => {
    let afterMerge = 0
    let merges = 0
    let dropsSeen = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed)
      const pick = <T,>(xs: readonly T[]): T | undefined => xs[Math.floor(r() * xs.length)]
      const sheet = (id: string, x: number): TacticalObject => ({ id, sheet: { planId: PLAN, anno: { id, kind: 'symbol', x, y: 0.5 } } })
      const init: Rich = {
        objects: [...objectsFromLegacy([sym('fz1'), sym('fz2'), sym('fz3')], [], {}), sheet('a1', 0.2), sheet('a2', 0.4)],
        attendance: { p1: presence('anwesend') },
        trupps: [{ id: 't1', v: 0, w: 0 }, { id: 't2', v: 0, w: 0 }],
        attachments: [{ id: 'b1' }],
      }
      const { result, unmount } = renderHook(() => useRich(init))
      /** the last state both devices shared — the merge's ancestor */
      let base: Rich = init
      /** records whose CURRENT value another device wrote and nothing local has overwritten since —
       *  with the merge that wrote it */
      const remote = new Map<RecordKey, number>()
      let n = 0
      /** what happened, for the failure message — a property failure without its path is a riddle */
      const trace: string[] = []
      const local = (fn: () => void) => {
        const before = result.current.state()
        act(fn)
        for (const k of movedRich(before, result.current.state())) remote.delete(k)
      }
      const entityIds = () => result.current.store.liveObjects().filter((o) => o.entity).map((o) => o.id)
      const annoIds = () => (boardViewOf(result.current.store.liveObjects(), NO_FITS)[PLAN] ?? []).map((a) => a.id)
      /** another device, working from `base`, saves; this device merges it three ways and hydrates */
      const merge = () => {
        const theirs: Rich = { objects: [...base.objects], attendance: { ...base.attendance }, trupps: [...base.trupps], attachments: [...base.attachments] }
        for (let j = 1 + Math.floor(r() * 2); j > 0; j--) {
          const what = r()
          const obj = pick(theirs.objects)
          if (what < 0.15 && obj?.entity) theirs.objects = theirs.objects.map((o) => (o.id === obj.id ? { ...o, entity: { ...o.entity!, label: `R${n++}` } } : o))
          else if (what < 0.3 && obj?.entity) theirs.objects = theirs.objects.map((o) => (o.id === obj.id ? { ...o, entity: { ...o.entity!, coord: [8 + r(), 47] } } : o)) // a host moved ~km
          else if (what < 0.4 && obj) theirs.objects = theirs.objects.filter((o) => o.id !== obj.id) // delete beats a concurrent edit
          else if (what < 0.48) { const id = `r${seed}-${n++}`; theirs.objects = [...theirs.objects, r() < 0.5 ? { id, entity: sym(id) } : sheet(id, r())] }
          else if (what < 0.58 && obj?.sheet) theirs.objects = theirs.objects.map((o) => (o.id === obj.id ? { ...o, sheet: { ...o.sheet!, anno: { ...o.sheet!.anno, x: r() } } } : o))
          else if (what < 0.7) theirs.attendance = { ...theirs.attendance, [pick(['p1', 'p2', 'p3'])!]: presence(`R${n++}`) }
          else if (what < 0.85) { const t = pick(theirs.trupps)!; const f = r() < 0.5 ? 'v' : 'w'; theirs.trupps = theirs.trupps.map((x) => (x.id === t.id ? { ...x, [f]: -(n++) } : x)) }
          else if (theirs.attachments.length) { const b = pick(theirs.attachments)!; theirs.attachments = r() < 0.5 ? theirs.attachments.filter((x) => x.id !== b.id) : theirs.attachments.map((x) => (x.id === b.id ? { ...x, caption: `R${n++}` } : x)) }
        }
        const mine = result.current.state()
        const m = mergeWorkspace(base as never, mine as never, theirs as never) as unknown as Rich
        const merged: Rich = { objects: m.objects, attendance: m.attendance, trupps: m.trupps, attachments: m.attachments }
        const entries = result.current.timeline.entries().past.length + result.current.timeline.entries().future.length
        let changed: Set<RecordKey> | null = null
        expect(() => act(() => { changed = result.current.hydrate(merged) })).not.toThrow()
        expect(changed, `seed ${seed}: the merge bookkeeping fell back`).not.toBeNull()
        const after = result.current.timeline.entries()
        if (after.past.length + after.future.length < entries) dropsSeen++
        EPOCH.now++
        for (const k of movedRich(mine, merged)) remote.set(k, EPOCH.now)
        trace.push(`merge#${EPOCH.now} changed ${[...(changed ?? [])].join(',')} → entries ${after.past.map((e) => e.label).join('|')}`)
        expect(movedRich(result.current.state(), merged).size, `seed ${seed}: the hydrate did not land`).toBe(0)
        base = merged // both devices now share it
        merges++
      }
      for (let i = 0; i < OPS; i++) {
        const d = result.current
        const ents = entityIds()
        const roll = r()
        trace.push(`${i} roll ${roll.toFixed(3)}`)
        if (roll < 0.07) local(() => d.commit((es) => [...es, sym(`s${seed}-${n++}`)]))
        else if (roll < 0.12 && ents.length) { const id = pick(ents)!; local(() => d.commit((es) => es.map((e) => (e.id === id ? { ...e, label: `L${n++}` } : e)))) }
        else if (roll < 0.15 && ents.length) { const id = pick(ents)!; local(() => d.commit((es) => es.filter((e) => e.id !== id))) }
        else if (roll < 0.21 && ents.length > 1) {
          // dock one symbol onto another — the placard/host bond, and undock
          const p = pick(ents)!, h = pick(ents.filter((x) => x !== p))!
          const dock = r() < 0.7 ? h : undefined
          local(() => d.commit((es) => es.map((e) => (e.id === p ? { ...e, dockedTo: dock } : e))))
        } else if (roll < 0.26 && ents.length) {
          // a drag gesture — sometimes with another device's save landing in the middle of it
          const id = pick(ents)!
          const nudge = () => d.store.setDocRaw((doc) => ({ ...doc, entities: doc.entities.map((e) => (e.id === id ? { ...e, coord: [e.coord[0] + 0.001, e.coord[1]] } : e)) }), { movedIds: [id] })
          local(() => { d.store.beginDrag(); nudge() })
          if (r() < 0.5) merge()
          local(() => { result.current.store.setDocRaw((doc) => ({ ...doc, entities: doc.entities.map((e) => (e.id === id ? { ...e, coord: [e.coord[0] + 0.001, e.coord[1]] } : e)) }), { movedIds: [id] }); result.current.store.endDrag() })
        } else if (roll < 0.32) local(() => d.mark(pick(['p1', 'p2', 'p3'])!, r() < 0.2 ? null : pick(['anwesend', 'gegangen'])!))
        else if (roll < 0.38) {
          const t = pick(d.truppsLive.current)!
          const f = r() < 0.5 ? 'v' : 'w'
          local(() => d.closure('trupps', d.truppsLive, d.setTrupps, t.id, { ...t, [f]: n++ }))
        } else if (roll < 0.43) {
          const b = pick(d.attLive.current)
          if (!b || r() < 0.3) { const id = `b${seed}-${n++}`; local(() => d.closure('attachments', d.attLive, d.setAttachments, id, { id })) }
          else local(() => d.closure('attachments', d.attLive, d.setAttachments, b.id, r() < 0.5 ? null : { ...b, caption: `C${n++}` }))
        } else if (roll < 0.5) {
          const annos = annoIds()
          const which = r()
          if (which < 0.4 || !annos.length) { const id = `pa${seed}-${n++}`; local(() => d.planEdit((as) => [...as, { id, kind: 'symbol', x: r(), y: 0.5 }])) }
          else if (which < 0.8) { const id = pick(annos)!; local(() => d.planEdit((as) => as.map((a) => (a.id === id ? { ...a, x: r() } : a)))) }
          else { const id = pick(annos)!; local(() => d.planEdit((as) => as.filter((a) => a.id !== id))) }
        } else if (roll < 0.53) base = result.current.state() // this device's push landed, nothing new remote
        else if (roll < 0.8) {
          // ↶ or ↷ — the invariant
          const before = d.state()
          let status = ''
          let laid = -1
          expect(() => act(() => {
            const out = r() < 0.75 ? d.timeline.undo() : d.timeline.redo()
            status = out.status
            if (out.status !== 'empty') laid = LAID.get(out.entry.undo) ?? -1
            if (out.status !== 'empty') trace.push(`${out.status} ${out.entry.label} laid@${laid}`)
          })).not.toThrow()
          const after = result.current.state()
          for (const k of movedRich(before, after)) {
            expect(remote.has(k), `seed ${seed} op ${i}: ${status} rewrote remote ${k}`).toBe(false)
            // …nor re-stated a link to a record another device changed after the step was laid:
            // a re-docked placard would land where its host WAS
            const refs = [...objectRefs(objectValue(before, k)), ...objectRefs(objectValue(after, k))]
            for (const ref of refs) expect((remote.get(ref) ?? -1) > laid, `seed ${seed} op ${i}: ${status} re-linked ${k} to remote ${ref}@${remote.get(ref)}\n${trace.slice(-30).join('\n')}`).toBe(false)
          }
          if (status === 'done' && merges > 0) afterMerge++
        } else merge()
      }
      unmount()
    }
    // …and none of it is vacuous: steps are still taken after merges, and merges do drop steps
    expect(afterMerge).toBeGreaterThan(SEEDS)
    expect(dropsSeen).toBeGreaterThan(SEEDS / 2)
  })
})

/* ── a Plan's history: view snapshots, so it survives a merge only whole ─────────────────────── */
describe('plan histories across a merge', () => {
  const a = (id: string, x = 0.5): BoardAnno => ({ id, kind: 'symbol', x, y: 0.5 })
  const setup = () => {
    const t = createUndoTimeline()
    const hist: BoardHistory = {
      modul2: { past: [{ id: 'm2-1', snap: [a('p1')] }, { id: 'm2-2', snap: [a('p1'), a('p2')] }], future: [] },
      modul3: { past: [{ id: 'm3-1', snap: [a('q1')] }], future: [] },
    }
    const live: Record<string, BoardAnno[]> = { modul2: [a('p1'), a('p2'), a('p3')], modul3: [a('q1', 0.6)] }
    const push = (planId: string, step: string) => t.push({
      domain: 'plan', scope: planId, label: planId, step,
      touches: () => planStackTouches(planId, hist[planId], live[planId]), undo: () => true, redo: () => true,
    })
    push('modul2', 'm2-1'); push('modul3', 'm3-1'); push('modul2', 'm2-2')
    // a plan-binding correction shares the scope but is a closure, not one of the stack's steps
    t.push({ domain: 'plan', scope: 'modul2', label: 'Passung', touches: () => ['planBindings:b1'], undo: () => true, redo: () => true })
    return { t, live, hist }
  }
  /** the merge's own capture of what survived — a set, never re-read later */
  const kept = (t: UndoTimeline) => { const live = t.steps(); return (id: string) => live.has(id) }

  it('keeps every plan the merge did not draw on, and drops the one it did — whole, by step id', () => {
    const s = setup()
    // another device added an object that now projects onto modul2 — in no snapshot, but restoring
    // one would read its absence as a deletion
    const after = { ...s.live, modul2: [...s.live.modul2, a('new')] }
    const changed = new Set(['objects:new', ...planViewChanges(s.live, () => after, new Set(['objects:new']))])
    s.t.rebase(changed)
    expect(s.t.entries().past.map((e) => e.label)).toEqual(['modul3', 'Passung'])
    const trimmed = keepPlanSteps(s.hist, kept(s.t))
    expect(trimmed.modul2).toEqual({ past: [], future: [] })
    expect(trimmed.modul3).toBe(s.hist.modul3)
  })

  it('an unrelated merge (a Trupp) keeps every plan step', () => {
    const s = setup()
    s.t.rebase(['trupps:t1'])
    expect(s.t.entries().past).toHaveLength(4)
    expect(keepPlanSteps(s.hist, kept(s.t))).toBe(s.hist)
  })

  it('a moved fit drops every plan step', () => {
    const s = setup()
    s.t.rebase(planViewChanges(s.live, () => s.live, new Set(['planScale:modul2'])))
    expect(s.t.entries().past.map((e) => e.label)).toEqual(['Passung'])
  })

  it('a Leitung end docked onto another object ties the whole plan to that object', () => {
    const s = setup()
    s.live.modul2 = [...s.live.modul2, { id: 'hose', kind: 'draw', x: 0, y: 0, endAttachment: { target: { kind: 'object', id: 'karte-tlf' }, routing: 'direct' } } as BoardAnno]
    s.t.rebase(['objects:karte-tlf'])
    expect(s.t.entries().past.map((e) => e.label)).toEqual(['modul3', 'Passung'])
  })
})
