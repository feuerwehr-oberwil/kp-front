import { describe, expect, it } from 'vitest'
import { mergeWorkspace, unknownWorkspaceKeys } from './mergeWorkspace'
import { carriedWorkspaceKeys, sanitizeWorkspace } from './workspace'

/**
 * A slice a NEWER build added survives this build (the Suche's rollout, 24.09.2026): an older
 * device rebuilt its save from the fields it knew and erased the whole new slice for everybody.
 * Whatever top-level key this build does not know is carried through the load gate, echoed into
 * the save, and merged as a value — `futureSlice` stands for the next one.
 */
describe('a top-level key this build does not know', () => {
  const future = { items: [{ id: 'x1', note: 'from a newer build' }] }

  it('passes the load gate untouched and is what a save carries back', () => {
    const gate = sanitizeWorkspace({ entities: [], futureSlice: future })
    expect((gate.ws as unknown as Record<string, unknown>).futureSlice).toEqual(future)
    expect(carriedWorkspaceKeys(gate.ws)).toEqual({ futureSlice: future })
    expect(unknownWorkspaceKeys({ entities: [], suche: {}, futureSlice: future })).toEqual(['futureSlice'])
  })

  it('survives a merge whose own side never knew it — absent is «never knew», not «deleted»', () => {
    const base = { entities: [], futureSlice: future }
    const newer = { items: [...future.items, { id: 'x2', note: 'added meanwhile' }] }
    const out = mergeWorkspace(base, { entities: [] }, { entities: [], futureSlice: newer })
    expect(out.futureSlice).toEqual(newer)
  })

  it('merges three-way where this side carried it: an unchanged copy yields to the other side', () => {
    const base = { futureSlice: future }
    const newer = { items: [] }
    expect(mergeWorkspace(base, { futureSlice: future }, { futureSlice: newer }).futureSlice).toEqual(newer)
  })
})
