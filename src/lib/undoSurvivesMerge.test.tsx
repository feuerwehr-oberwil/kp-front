// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { useRef, useState } from 'react'
import { act, renderHook } from '@testing-library/react'
import { useObjectStore, type ObjectStore } from './useObjectStore'
import { useUndoableSlice, type UndoableSlice } from './useUndoableSlice'
import { pushSliceStep } from './sliceUndoStep'
import { createUndoTimeline, type UndoTimeline } from './undoTimeline'
import { WORKSPACE_RECORDS, planViewChanges, recordByKey, recordDiff, recordKey, workspaceChanges, type RecordKey, type RecordShape } from './undoKeys'
import { planStackTouches, trimPlanHistory, type BoardHistory } from '../components/useBoardDoc'
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
    att.set((cur) => {
      const next = { ...cur }
      if (status === null) delete next[person]; else next[person] = presence(status)
      return next
    })
    pushSliceStep(timeline, { domain: 'anwesenheit', label: 'Anwesenheit', histRef: attRef, record: (moved) => !!moved })
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

/* ── property: random local work, random remote merges ⇒ an undo/redo never reverts a remote
 *    change, and nothing ever throws ────────────────────────────────────────────────────────── */

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

type Dev = ReturnType<typeof useDevice>
const snapshot = (d: Dev): Ws => ({ objects: d.store.liveObjects(), attendance: d.attendance, trupps: d.trupps })
/** every record key whose value differs between two states */
const moved = (a: Ws, b: Ws): Set<RecordKey> => {
  const out = new Set<RecordKey>()
  for (const f of ['objects', 'attendance', 'trupps'] as const) {
    const shape = WORKSPACE_RECORDS[f] as Pick<RecordShape<unknown>, 'records'>
    for (const k of recordDiff(a[f], b[f], shape).keys()) out.add(k)
  }
  return out
}

describe('property — an undo never reverts a remote change', () => {
  const SEEDS = 40
  const OPS = 45
  it(`holds over ${SEEDS} random sessions of ${OPS} operations`, () => {
    let stepsAfterMerges = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed)
      const pick = <T,>(xs: readonly T[]): T | undefined => xs[Math.floor(r() * xs.length)]
      const { result, unmount } = renderHook(() => useDevice(initial()))
      /** records whose CURRENT value a remote device wrote and nothing local has overwritten since */
      const remote = new Map<RecordKey, true>()
      let n = 0
      let merged = false
      const local = (fn: () => void) => {
        const before = snapshot(result.current)
        act(fn)
        for (const k of moved(before, snapshot(result.current))) remote.delete(k)
      }
      for (let i = 0; i < OPS; i++) {
        const d = result.current
        const ids = d.store.doc.entities.map((e) => e.id)
        const roll = r()
        if (roll < 0.14) local(() => d.placeSymbol(`s${seed}-${n++}`))
        else if (roll < 0.24 && ids.length) local(() => d.relabel(pick(ids)!, `L${n++}`))
        else if (roll < 0.30 && ids.length) local(() => d.removeSymbol(pick(ids)!))
        else if (roll < 0.40) local(() => d.mark(pick(['p1', 'p2', 'p3'])!, r() < 0.2 ? null : pick(['anwesend', 'gegangen'])!))
        else if (roll < 0.48) local(() => d.editTrupp(pick(['t1', 't2'])!, n++))
        else if (roll < 0.78) {
          // ↶ or ↷ — the invariant
          const before = snapshot(d)
          let status = ''
          expect(() => act(() => { status = (r() < 0.75 ? d.timeline.undo() : d.timeline.redo()).status })).not.toThrow()
          const touched = moved(before, snapshot(result.current))
          for (const k of touched) expect(remote.has(k), `seed ${seed} op ${i}: ${status} rewrote remote ${k}`).toBe(false)
          if (status === 'done' && merged) stepsAfterMerges++
        } else {
          // another device's save lands: a few records changed, added or removed
          const cur = snapshot(d)
          const next: Ws = { objects: [...cur.objects], attendance: { ...cur.attendance }, trupps: [...cur.trupps] }
          const k = 1 + Math.floor(r() * 2)
          for (let j = 0; j < k; j++) {
            const what = r()
            if (what < 0.3 && next.objects.length) {
              const o = pick(next.objects)!
              next.objects = next.objects.map((x) => (x.id === o.id ? { ...x, entity: { ...x.entity!, label: `R${n++}` } } : x))
            } else if (what < 0.4 && next.objects.length) {
              const o = pick(next.objects)!
              next.objects = next.objects.filter((x) => x.id !== o.id)
            } else if (what < 0.55) {
              const id = `r${seed}-${n++}`
              next.objects = [...next.objects, { id, entity: sym(id) }]
            } else if (what < 0.8) {
              next.attendance = { ...next.attendance, [pick(['p1', 'p2', 'p3'])!]: presence(`R${n++}`) }
            } else {
              const t = pick(next.trupps)!
              next.trupps = next.trupps.map((x) => (x.id === t.id ? { ...x, v: -(n++) } : x))
            }
          }
          let changed = new Set<RecordKey>()
          expect(() => act(() => { changed = d.hydrate(next) })).not.toThrow()
          // what the merge wrote is exactly what now counts as remote (and the state IS the merge)
          expect(changed).toEqual(moved(cur, next))
          for (const key of changed) remote.set(key, true)
          expect(moved(snapshot(result.current), next).size).toBe(0)
          merged = true
        }
      }
      unmount()
    }
    // …and the rule is not vacuous: plenty of steps were still taken after a merge had landed
    expect(stepsAfterMerges).toBeGreaterThan(SEEDS)
  })
})

/* ── a Plan's history: view snapshots, so it survives a merge only whole ─────────────────────── */
describe('plan histories across a merge', () => {
  const a = (id: string, x = 0.5): BoardAnno => ({ id, kind: 'symbol', x, y: 0.5 })
  const setup = () => {
    const t = createUndoTimeline()
    const hist: BoardHistory = {
      modul2: { past: [[a('p1')], [a('p1'), a('p2')]], future: [] },
      modul3: { past: [[a('q1')]], future: [] },
    }
    const live: Record<string, BoardAnno[]> = { modul2: [a('p1'), a('p2'), a('p3')], modul3: [a('q1', 0.6)] }
    let n = 0
    const push = (planId: string) => t.push({
      domain: 'plan', scope: planId, label: planId, step: `pl-${n++}`,
      touches: () => planStackTouches(planId, hist[planId], live[planId]), undo: () => true, redo: () => true,
    })
    push('modul2'); push('modul3'); push('modul2')
    // a plan-binding correction shares the scope but is a closure, not one of the stack's steps
    t.push({ domain: 'plan', scope: 'modul2', label: 'Passung', touches: () => ['planBindings:b1'], undo: () => true, redo: () => true })
    return { t, live, hist }
  }

  it('keeps every plan the merge did not draw on, and drops the one it did — whole', () => {
    const s = setup()
    // another device added an object that now projects onto modul2 — in no snapshot, but restoring
    // one would read its absence as a deletion
    const after = { ...s.live, modul2: [...s.live.modul2, a('new')] }
    const changed = new Set(['objects:new', ...planViewChanges(s.live, after, new Set(['objects:new']))])
    s.t.rebase(changed)
    expect(s.t.entries().past.map((e) => e.label)).toEqual(['modul3', 'Passung'])
    const trimmed = trimPlanHistory(s.hist, s.t.entries())
    expect(trimmed.modul2).toEqual({ past: [], future: [] })
    expect(trimmed.modul3).toBe(s.hist.modul3)
  })

  it('an unrelated merge (a Trupp) keeps every plan step', () => {
    const s = setup()
    s.t.rebase(['trupps:t1'])
    expect(s.t.entries().past).toHaveLength(4)
    expect(trimPlanHistory(s.hist, s.t.entries())).toBe(s.hist)
  })

  it('a moved fit drops every plan step', () => {
    const s = setup()
    s.t.rebase(planViewChanges(s.live, s.live, new Set(['planScale:modul2'])))
    expect(s.t.entries().past.map((e) => e.label)).toEqual(['Passung'])
  })
})
