import { describe, expect, it } from 'vitest'
import {
  fieldsOf, historyStepKeys, keyMatcher, listById, noteRemoteChanges, planViewChanges, rebaseHistory, rebasePending,
  recordByKey, recordDiff, sameValue, watchRecords, workspaceChanges,
} from './undoKeys'

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
    expect(planViewChanges(before, after, new Set(['objects:new']))).toEqual(['planview:modul2'])
    expect(planViewChanges(before, after, new Set(['trupps:t']))).toEqual([])
    expect(planViewChanges(before, after, new Set(['planScale:modul2']))).toEqual(['planview:*'])
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
    expect(historyStepKeys(h, 'k1', rows)).toEqual(['mittel:x'])
    expect(historyStepKeys(h, 'k2', rows)).toEqual(['mittel:y'])
    expect(historyStepKeys(h, 'k3', rows)).toEqual(['mittel:z'])
    expect(historyStepKeys(h, 'nope', rows)).toBeNull()
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
