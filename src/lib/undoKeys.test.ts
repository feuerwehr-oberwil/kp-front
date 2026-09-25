import { describe, expect, it } from 'vitest'
import {
  annoRefs, carryUndoThroughMerge, fieldsOf, historyTouches, keyMatcher, listById, noteRemoteChanges, objectRefs, planViewChanges,
  rebaseHistory, rebasePending, recordByKey, recordDiff, sameValue, stepTouches, sucheRecordKey, touchesCache, watchRecords, workspaceChanges,
} from './undoKeys'
import { createUndoTimeline } from './undoTimeline'

type Row = { id: string; v: number }
const rows = listById<Row>('mittel')

describe('undoKeys — records, as the merge counts them', () => {
  it('compares as the wire does: key order and undefined properties do not matter', () => {
    expect(sameValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true)
    expect(sameValue({ a: 1, x: undefined }, { a: 1 })).toBe(true)
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false)
    expect(sameValue([1, 2], [2, 1])).toBe(false)
    expect(sameValue({ a: null }, { a: undefined })).toBe(false)
  })

  it('matches exact keys and whole-field wildcards both ways', () => {
    const m = keyMatcher(['objects:a', 'planview:*'])
    expect(m.meets(['objects:a'])).toBe(true)
    expect(m.meets(['objects:b'])).toBe(false)
    expect(m.meets(['objects:*'])).toBe(true)
    expect(m.meets(['trupps:*'])).toBe(false)
    expect(m.meets(['planview:modul2'])).toBe(true)
    expect(keyMatcher().empty).toBe(true)
  })

  it('diffs a list by id and patches it back with a returning row in its old place', () => {
    const a: Row[] = [{ id: 'x', v: 1 }, { id: 'y', v: 1 }, { id: 'z', v: 1 }]
    const b: Row[] = [{ id: 'x', v: 2 }, { id: 'z', v: 1 }]
    const d = recordDiff(b, a, rows)
    expect([...d.keys()].sort()).toEqual(['mittel:x', 'mittel:y'])
    expect(rows.patch(b, d, a)).toEqual(a)
    // nothing to change → the same array
    expect(rows.patch(a, new Map(), a)).toBe(a)
  })

  it('diffs a record by key and leaves ignored keys alone', () => {
    const shape = recordByKey<unknown>('reportMeta', ['printJob'])
    const d = recordDiff({ a: 1, printJob: 1 }, { a: 2, printJob: 2 }, shape)
    expect([...d.keys()]).toEqual(['reportMeta:a'])
    expect(shape.patch({ a: 2, printJob: 9 }, new Map([['reportMeta:a', 1], ['reportMeta:printJob', 1]]), {})).toEqual({ a: 1, printJob: 9 })
  })

  it('composes fields for the Zeitplan', () => {
    const shape = fieldsOf<{ shifts: Row[]; bands: Row[] }>({ shifts: listById('shifts'), bands: listById('bands') })
    const a = { shifts: [{ id: 's', v: 1 }], bands: [{ id: 'b', v: 1 }] }
    const b = { shifts: [{ id: 's', v: 2 }], bands: [{ id: 'b', v: 1 }] }
    const d = recordDiff(a, b, shape)
    expect([...d.keys()]).toEqual(['shifts:s'])
    const back = shape.patch(b, recordDiff(b, a, shape), a)
    expect(back).toEqual(a)
    expect(back.bands).toBe(b.bands)
  })

  it('lists what a hydrate changed across the workspace, singletons included', () => {
    const prev = { objects: [{ id: 'o1', entity: { id: 'o1' } }], attendance: { p1: { s: 1 } }, building: null, trupps: [] }
    const next = { objects: [{ id: 'o1', entity: { id: 'o1' } }], attendance: { p1: { s: 2 } }, building: { floors: [0] }, trupps: [] }
    expect([...workspaceChanges(prev, next)].sort()).toEqual(['attendance:p1', 'building:'])
    expect(workspaceChanges(prev, prev).size).toBe(0)
  })

  it('names every sheet whose drawn view a changed object is on — or all of them when a fit moved', () => {
    const before = { modul2: [{ id: 'a' }], gebaeude: [{ id: 'b' }] }
    const after = { modul2: [{ id: 'a' }, { id: 'new' }], gebaeude: [{ id: 'b' }] }
    expect(planViewChanges(before, () => after, new Set(['objects:new']))).toEqual(['planview:modul2'])
    // …and the costly half (every sheet's view after the merge) is not even derived when no
    // object changed
    const never = () => { throw new Error('derived for nothing') }
    expect(planViewChanges(before, never, new Set(['trupps:t']))).toEqual([])
    expect(planViewChanges(before, never, new Set(['planScale:modul2']))).toEqual(['planview:*'])
  })
})

describe('undoKeys — a snapshot history re-laid onto a merge', () => {
  // three steps: add x, edit y, delete z — present is after all three
  const s0: Row[] = [{ id: 'y', v: 1 }, { id: 'z', v: 1 }]
  const s1: Row[] = [{ id: 'y', v: 1 }, { id: 'z', v: 1 }, { id: 'x', v: 1 }]
  const s2: Row[] = [{ id: 'y', v: 2 }, { id: 'z', v: 1 }, { id: 'x', v: 1 }]
  const present: Row[] = [{ id: 'y', v: 2 }, { id: 'x', v: 1 }]
  const h = { past: [{ id: 'k1', snap: s0 }, { id: 'k2', snap: s1 }, { id: 'k3', snap: s2 }], present, future: [] }

  it('knows which records each step writes', () => {
    const t = historyTouches(h, rows)
    expect(t.get('k1')).toEqual(['mittel:x'])
    expect(t.get('k2')).toEqual(['mittel:y'])
    expect(t.get('k3')).toEqual(['mittel:z'])
    expect(t.has('nope')).toBe(false)
  })

  it('keeps the kept steps as patches over the merged state, and a remote record survives every one', () => {
    // a remote device added `r` and changed nothing else
    const next = [...present, { id: 'r', v: 7 }]
    const laid = rebaseHistory(h, next, () => true, rows)
    expect(laid.past.map((s) => s.id)).toEqual(['k1', 'k2', 'k3'])
    for (const s of laid.past) expect(s.snap.find((o) => o.id === 'r')).toEqual({ id: 'r', v: 7 })
    expect(laid.past[0].snap.map((o) => o.id).sort()).toEqual(['r', 'y', 'z'])
  })

  it('drops the steps it is told to, and their effect stays', () => {
    const next = present.map((o) => (o.id === 'y' ? { ...o, v: 9 } : o)) // remote changed y
    const laid = rebaseHistory(h, next, (id) => id !== 'k2', rows)
    expect(laid.past.map((s) => s.id)).toEqual(['k1', 'k3'])
    // stepping all the way back never puts y back to 1
    for (const s of laid.past) expect(s.snap.find((o) => o.id === 'y')?.v).toBe(9)
  })

  it('re-lays an open gesture unless the merge changed what it moved', () => {
    const start: Row[] = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }]
    const live: Row[] = [{ id: 'a', v: 5 }, { id: 'b', v: 1 }]
    expect(rebasePending(start, live, [{ id: 'a', v: 5 }, { id: 'b', v: 3 }], rows)).toEqual([{ id: 'a', v: 1 }, { id: 'b', v: 3 }])
    const moved = [{ id: 'a', v: 8 }, { id: 'b', v: 1 }]
    expect(rebasePending(start, live, moved, rows)).toBe(moved)
  })
})

describe('undoKeys — links between records (review of #234)', () => {
  const objects = listById<{ id: string }>('objects', objectRefs)

  it('reads every id-valued link a tactical object carries', () => {
    expect(objectRefs({ id: 'p', entity: { id: 'p', dockedTo: 'h', truppId: 't1' } })).toEqual(['objects:h', 'trupps:t1'])
    expect(objectRefs({ id: 'l', drawing: { id: 'l', startAttachment: { target: { kind: 'object', id: 'fz' } }, endAttachment: { target: { kind: 'line', id: 'l2', endpoint: 'end' } } } }))
      .toEqual(['objects:fz', 'objects:l2'])
    // a Gebäude-stack body sits on a storey the building has to still have
    expect(objectRefs({ id: 'g', sheet: { planId: 'gebaeude', anno: { id: 'g', floor: 2 } } })).toEqual(['building:'])
    expect(annoRefs({ id: 'a', endAttachment: { target: { kind: 'object', id: 'x' } } })).toEqual(['objects:x'])
    expect(objectRefs(undefined)).toEqual([])
  })

  it('a step touches what it writes AND what the old or the new value links to', () => {
    const before = [{ id: 'p', entity: { id: 'p' } }, { id: 'h', entity: { id: 'h' } }]
    const docked = [{ id: 'p', entity: { id: 'p', dockedTo: 'h' } }, { id: 'h', entity: { id: 'h' } }]
    expect(stepTouches(before, docked, objects).sort()).toEqual(['objects:h', 'objects:p'])
    expect(stepTouches(docked, before, objects).sort()).toEqual(['objects:h', 'objects:p'])
  })

  it('an open drag of a docked placard gives up its pre-merge half when the merge moved the host', () => {
    const start = [{ id: 'p', entity: { id: 'p', dockedTo: 'h', x: 0 } }, { id: 'h', entity: { id: 'h', x: 0 } }]
    const live = [{ id: 'p', entity: { id: 'p', dockedTo: 'h', x: 1 } }, { id: 'h', entity: { id: 'h', x: 0 } }]
    const next = [{ id: 'p', entity: { id: 'p', dockedTo: 'h', x: 1 } }, { id: 'h', entity: { id: 'h', x: 9 } }]
    expect(rebasePending(start, live, next, objects)).toBe(next)
  })
})

describe('undoKeys — the merge bookkeeping, all or nothing', () => {
  it('rebases every domain with the kept steps, and spends the toasts whose records moved', () => {
    const t = createUndoTimeline()
    t.push({ domain: 'karte', label: 'a', step: 'k1', touches: () => ['objects:a'], undo: () => true, redo: () => true })
    t.push({ domain: 'karte', label: 'b', step: 'k2', touches: () => ['objects:b'], undo: () => true, redo: () => true })
    const w = watchRecords(['objects:b'])
    const kept: boolean[][] = []
    const changed = carryUndoThroughMerge(t, () => new Set(['objects:b']), [
      { rebase: (keep) => kept.push([keep('k1'), keep('k2')]), drop: () => { throw new Error('not on this path') } },
    ])
    expect([...changed!]).toEqual(['objects:b'])
    expect(kept).toEqual([[true, false]])
    expect(w.ok()).toBe(false)
  })

  it('falls back to the old rule when any of it throws — and the merged state still lands', () => {
    const t = createUndoTimeline()
    t.push({ domain: 'karte', label: 'a', touches: () => ['objects:a'], undo: () => true, redo: () => true })
    const w = watchRecords(['attendance:p9'])
    const dropped: string[] = []
    const errors: unknown[] = []
    const changed = carryUndoThroughMerge(t, () => new Set(['trupps:x']), [
      { rebase: () => { throw new Error('boom') }, drop: () => dropped.push('karte') },
      { rebase: () => {}, drop: () => { dropped.push('slices'); throw new Error('also') } },
      { rebase: () => {}, drop: () => dropped.push('plans') },
    ], { onFail: (e) => errors.push(e) })
    expect(changed).toBeNull()
    expect(t.canUndo()).toBe(false)
    expect(dropped).toEqual(['karte', 'slices', 'plans']) // every domain still took the merge
    expect(errors).toHaveLength(2)
    expect(w.ok()).toBe(false) // nothing is known, so no toast may act
  })
})

describe('undoKeys — the ↶ that silently pointed at something else (F8, staging r3)', () => {
  const entry = (label: string, keys: string[]) => ({ domain: 'karte' as const, label, touches: () => keys, undo: () => true, redo: () => true })

  it('says so once when the merge took the step ↶ would have taken back', () => {
    const t = createUndoTimeline()
    t.push({ ...entry('Trupp 1: WBK', ['trupps:t1']), domain: 'trupps' })
    t.push(entry('Gefahrentafel angedockt', ['objects:p', 'objects:h']))
    const told: string[] = []
    carryUndoThroughMerge(t, () => new Set(['objects:h']), [], { onTopDropped: (e) => told.push(e.label) })
    expect(told).toEqual(['Gefahrentafel angedockt'])
    expect(t.peekUndo()?.label).toBe('Trupp 1: WBK')
  })

  it('stays quiet when the top step stands — even if older ones went', () => {
    const t = createUndoTimeline()
    t.push(entry('old', ['objects:a']))
    t.push(entry('top', ['objects:b']))
    const told: string[] = []
    carryUndoThroughMerge(t, () => new Set(['objects:a']), [], { onTopDropped: (e) => told.push(e.label) })
    expect(told).toEqual([])
    carryUndoThroughMerge(createUndoTimeline(), () => new Set(['objects:a']), [], { onTopDropped: (e) => told.push(e.label) })
    expect(told).toEqual([]) // nothing to take back, nothing to say
  })

  it('says so on the fallback too, where everything went', () => {
    const t = createUndoTimeline()
    t.push(entry('top', ['objects:b']))
    const told: string[] = []
    carryUndoThroughMerge(t, () => { throw new Error('x') }, [], { onTopDropped: (e) => told.push(e.label) })
    expect(told).toEqual(['top'])
  })
})

describe('undoKeys — one diff per step per merge', () => {
  it('memoises on the history’s identity', () => {
    const shape = listById<Row>('mittel')
    let reads = 0
    const counting = { ...shape, records: (v: Row[]) => { reads++; return shape.records(v) } }
    const touches = touchesCache(counting)
    const h = { past: [{ id: 'k1', snap: [] as Row[] }, { id: 'k2', snap: [{ id: 'a', v: 1 }] }], present: [{ id: 'a', v: 2 }], future: [] }
    expect(touches(h, 'k1')).toEqual(['mittel:a'])
    const once = reads
    expect(touches(h, 'k2')).toEqual(['mittel:a'])
    expect(reads).toBe(once) // the second entry asked the same history: no second pass
    touches({ ...h, present: [{ id: 'a', v: 3 }] }, 'k2')
    expect(reads).toBeGreaterThan(once) // a new present is a new history
  })
})

describe('undoKeys — a toast that outlives a merge', () => {
  it('is spent once a merge changes a record it would write, and only then', () => {
    const w = watchRecords(['attendance:p1'])
    noteRemoteChanges(['attendance:p2'])
    expect(w.ok()).toBe(true)
    noteRemoteChanges(['attendance:p1'])
    expect(w.ok()).toBe(false)
    const released = watchRecords(['shifts:s'])
    released.release()
    noteRemoteChanges(['shifts:s'])
    expect(released.ok()).toBe(true) // no longer watched — its toast is gone
  })
})

describe('undoKeys — slices other PRs added (staging integration 25.09.2026)', () => {
  it('reads the Suche record by record, person and Bereich apart', () => {
    const before = { personen: [{ id: 'p1', log: [] }], bereiche: [{ id: 'b1', log: [] }] }
    const after = { personen: [{ id: 'p1', log: [{ id: 'r1' }] }], bereiche: [{ id: 'b1', log: [] }, { id: 'b2', log: [] }] }
    expect([...workspaceChanges({ suche: before }, { suche: after })].sort())
      .toEqual([sucheRecordKey('bereiche', 'b2'), sucheRecordKey('personen', 'p1')].sort())
    expect(workspaceChanges({ suche: before }, { suche: structuredClone(before) }).size).toBe(0)
  })

  it('a Trupp whose crew-filing marker only grew is not a changed record — every inverse keeps the marker', () => {
    const t = { id: 't1', no: 1, status: 'bereit' }
    expect(workspaceChanges({ trupps: [t] }, { trupps: [{ ...t, crewFiled: ['p1'] }] }).size).toBe(0)
    expect([...workspaceChanges({ trupps: [t] }, { trupps: [{ ...t, status: 'drin', crewFiled: ['p1'] }] })]).toEqual(['trupps:t1'])
  })
})
