import { describe, expect, it } from 'vitest'
import { mergeById, mergeRecord, mergeWorkspace } from './mergeWorkspace'

const o = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra })

describe('mergeById — three-way object merge', () => {
  it('keeps independent additions from both sides, server order then mine', () => {
    const base = [o('a')]
    const theirs = [o('a'), o('b')] // they added b
    const mine = [o('a'), o('c')] // I added c
    expect(mergeById(base, mine, theirs).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('same object edited on both sides → last writer (mine) wins', () => {
    const base = [o('a', { x: 0 })]
    const theirs = [o('a', { x: 1 })]
    const mine = [o('a', { x: 2 })]
    expect(mergeById(base, mine, theirs)).toEqual([o('a', { x: 2 })])
  })

  it('delete beats a concurrent edit (theirs edits, I delete → stays gone)', () => {
    const base = [o('a', { x: 0 })]
    const theirs = [o('a', { x: 9 })] // they moved it
    const mine: ReturnType<typeof o>[] = [] // I deleted it
    expect(mergeById(base, mine, theirs)).toEqual([])
  })

  it('delete beats a concurrent edit (I edit, they delete → stays gone)', () => {
    const base = [o('a', { x: 0 })]
    const theirs: ReturnType<typeof o>[] = [] // they deleted it
    const mine = [o('a', { x: 5 })] // I moved it
    expect(mergeById(base, mine, theirs)).toEqual([])
  })

  it('my new add is never mistaken for a delete (absent in base AND theirs)', () => {
    expect(mergeById([], [o('new')], [])).toEqual([o('new')])
  })

  it('an untouched object survives even if absent on my side but present in base+theirs only when I deleted it', () => {
    // present in base+theirs, absent in mine, theirs unchanged → I deleted it → drop
    expect(mergeById([o('a')], [], [o('a')])).toEqual([])
  })

  it('is idempotent: merging an already-merged superset against itself is stable', () => {
    const base = [o('a')]
    const merged = mergeById(base, [o('a'), o('c')], [o('a'), o('b')])
    // re-merge the result against itself (both sides equal, base = previous server)
    expect(mergeById(base, merged, merged)).toEqual(merged)
  })
})

describe('mergeRecord — three-way key/value merge', () => {
  it('unions new keys and LWW-mine on shared keys both changed', () => {
    expect(mergeRecord({ a: 1 }, { a: 2, c: 3 }, { a: 9, b: 8 })).toEqual({ a: 2, b: 8, c: 3 })
  })
  it('honors a removed shared key (delete wins)', () => {
    // key a in base+theirs, removed in mine → dropped
    expect(mergeRecord({ a: 1 }, {}, { a: 1 })).toEqual({})
  })
  it('takes THEIRS for a key the resolver left at the ancestor (no cross-domain clobber)', () => {
    // base a=1; mine untouched (a=1); theirs changed a=2 → take theirs, not mine's stale 1
    expect(mergeRecord({ a: 1 }, { a: 1 }, { a: 2 })).toEqual({ a: 2 })
  })
  it('keeps MINE for a key only the resolver changed', () => {
    expect(mergeRecord({ a: 1 }, { a: 5 }, { a: 1 })).toEqual({ a: 5 })
  })
})

describe('mergeWorkspace — whole blob', () => {
  it('merges collections by id and keeps the local view/config (activePlanId)', () => {
    const base = { entities: [o('e1')], drawings: [], activePlanId: 'p1' }
    const theirs = { entities: [o('e1'), o('e2')], drawings: [o('d1')], activePlanId: 'p1' } // they added e2 + a drawing
    const mine = { entities: [o('e1')], drawings: [o('d2')], activePlanId: 'p2' } // I added a drawing, switched plan
    const merged = mergeWorkspace(base, mine, theirs)
    expect((merged.entities as { id: string }[]).map((x) => x.id)).toEqual(['e1', 'e2'])
    expect((merged.drawings as { id: string }[]).map((x) => x.id)).toEqual(['d1', 'd2'])
    expect(merged.activePlanId).toBe('p2') // my active plan is not yanked by the merge
  })

  it('merges per-plan board annotations independently', () => {
    const base = { board: { p1: [o('a1')] } }
    const theirs = { board: { p1: [o('a1'), o('a2')] } }
    const mine = { board: { p1: [o('a1')], p2: [o('b1')] } }
    const merged = mergeWorkspace(base, mine, theirs) as { board: Record<string, { id: string }[]> }
    expect(merged.board.p1.map((x) => x.id)).toEqual(['a1', 'a2'])
    expect(merged.board.p2.map((x) => x.id)).toEqual(['b1'])
  })

  it('clear-board (delete-all) wins over an untouched plan on the other side', () => {
    const base = { board: { p1: [o('a1'), o('a2')] } }
    const theirs = { board: { p1: [o('a1'), o('a2')] } } // unchanged
    const mine = { board: { p1: [] } } // I cleared the board
    const merged = mergeWorkspace(base, mine, theirs) as { board: Record<string, { id: string }[]> }
    expect(merged.board.p1).toEqual([])
  })
})

describe('mergeWorkspace — task-scoped cross-domain merges (no clobbering)', () => {
  // The headline guarantee: two operators on the SAME incident working DIFFERENT domains both keep
  // their work. The resolver ("mine") is the device flushing; "theirs" is the server holding the
  // other operator's concurrent edit. Each case = one operator edited domain X while the resolver
  // touched only domain Y and left X at the ancestor.

  it('Atemschutz (trupps) on one device + Anwesenheit (attendance) on another — both survive', () => {
    const base = { trupps: [o('t1')], attendance: {} }
    const theirs = { trupps: [o('t1')], attendance: { p1: { present: true } } } // they marked p1 present
    const mine = { trupps: [o('t1'), o('t2')], attendance: {} }                  // I added a Trupp
    const merged = mergeWorkspace(base, mine, theirs) as { trupps: { id: string }[]; attendance: Record<string, unknown> }
    expect(merged.trupps.map((x) => x.id)).toEqual(['t1', 't2']) // my Trupp add
    expect(merged.attendance).toEqual({ p1: { present: true } }) // their attendance NOT clobbered
  })

  it('a settings change on one device is not reverted by an unrelated map edit on another', () => {
    const base = { entities: [o('e1')], settings: { contactIntervalMin: 10 } }
    const theirs = { entities: [o('e1')], settings: { contactIntervalMin: 20 } } // they changed doctrine
    const mine = { entities: [o('e1'), o('e2')], settings: { contactIntervalMin: 10 } } // I only drew on the map
    const merged = mergeWorkspace(base, mine, theirs) as { entities: { id: string }[]; settings: { contactIntervalMin: number } }
    expect(merged.entities.map((x) => x.id)).toEqual(['e1', 'e2'])
    expect(merged.settings.contactIntervalMin).toBe(20) // their settings change survives
  })

  it('toggling an existing person\'s presence survives a concurrent edit elsewhere', () => {
    const base = { attendance: { p1: { present: true } }, drawings: [] }
    const theirs = { attendance: { p1: { present: false } }, drawings: [] } // they signed p1 out
    const mine = { attendance: { p1: { present: true } }, drawings: [o('d1')] } // I drew a line
    const merged = mergeWorkspace(base, mine, theirs) as { attendance: Record<string, { present: boolean }> }
    expect(merged.attendance.p1.present).toBe(false) // their toggle isn't reverted by my stale copy
  })

  it('independent plan calibrations on two devices both survive', () => {
    const base = { planScale: {} }
    const theirs = { planScale: { modul1: 1.5 } } // they calibrated modul1
    const mine = { planScale: { modul2: 2.0 } }   // I calibrated modul2
    const merged = mergeWorkspace(base, mine, theirs) as { planScale: Record<string, number> }
    expect(merged.planScale).toEqual({ modul1: 1.5, modul2: 2.0 })
  })

  it('a building edit on one device survives a map edit on another (whole-doc three-way)', () => {
    const base = { building: { floors: [{ id: 'f0' }] }, entities: [] }
    const theirs = { building: { floors: [{ id: 'f0' }, { id: 'f1' }] }, entities: [] } // they added a floor
    const mine = { building: { floors: [{ id: 'f0' }] }, entities: [o('e1')] }           // I drew on the map
    const merged = mergeWorkspace(base, mine, theirs) as { building: { floors: { id: string }[] } }
    expect(merged.building.floors.map((f) => f.id)).toEqual(['f0', 'f1']) // their building edit survives
  })

  it('merges target movement concurrently with attachment/style editing on a different line object', () => {
    const attachment = { target: { kind: 'object', id: 'pump' }, routing: 'direct' }
    const base = { entities: [o('pump', { coord: [7, 47] })], drawings: [o('hose', { coords: [[7, 47], [7.1, 47.1]], color: 'blue', startAttachment: attachment })] }
    const theirs = { ...base, entities: [o('pump', { coord: [7.01, 47.01] })] }
    const mine = { ...base, drawings: [o('hose', { coords: [[7, 47], [7.1, 47.1]], color: 'red', startAttachment: attachment })] }
    const merged = mergeWorkspace(base, mine, theirs) as { entities: { coord: number[] }[]; drawings: { color: string; startAttachment: unknown }[] }
    expect(merged.entities[0].coord).toEqual([7.01, 47.01])
    expect(merged.drawings[0]).toMatchObject({ color: 'red', startAttachment: attachment })
  })

  it('the shared picked Einsatzobjekt propagates when the resolver did not change it', () => {
    const base = { pickedObjectId: undefined }
    const theirs = { pickedObjectId: 'obj-7' } // they picked an object
    const mine = { pickedObjectId: undefined, entities: [o('e1')] } // I only drew
    expect(mergeWorkspace(base, mine, theirs).pickedObjectId).toBe('obj-7')
  })

  it('same singleton edited on both sides stays last-writer-wins (mine)', () => {
    const base = { settings: { contactIntervalMin: 10 } }
    const theirs = { settings: { contactIntervalMin: 20 } }
    const mine = { settings: { contactIntervalMin: 30 } }
    const merged = mergeWorkspace(base, mine, theirs) as { settings: { contactIntervalMin: number } }
    expect(merged.settings.contactIntervalMin).toBe(30)
  })

  it('still keeps local view state (activePlanId) on the resolver side', () => {
    const merged = mergeWorkspace({ activePlanId: 'p1' }, { activePlanId: 'p2' }, { activePlanId: 'p3' })
    expect(merged.activePlanId).toBe('p2') // my view is never yanked by a merge
  })
})

describe('mergeById — documented LWW data-loss (whole-object replacement)', () => {
  // The merge is per-OBJECT last-writer-wins with WHOLE-OBJECT replacement — it does NOT
  // merge field-by-field within a single object. So when two devices concurrently edit
  // DIFFERENT fields of the SAME object, the later writer ("mine") replaces the object
  // wholesale and the other device's field change is silently lost. This test locks that
  // documented limitation in (see memory: KP Front sync limitations / per-object LWW).
  it('loses one side when two devices edit different fields of the same object', () => {
    const base = [o('a', { label: 'Tank', floor: 0 })]
    const theirs = [o('a', { label: 'Tank', floor: 3 })] // they only changed floor
    const mine = [o('a', { label: 'TLF', floor: 0 })]    // I only changed the label
    const [merged] = mergeById(base, mine, theirs)
    // mine wins wholesale: my label survives but THEIR floor edit is gone (not 3).
    // The whole object is replaced, so floor is my 0, NOT their concurrent 3.
    expect(merged).toEqual(o('a', { label: 'TLF', floor: 0 }))
  })

  it('whole-blob: a concurrent field edit on the same entity is dropped at the workspace level too', () => {
    const base = { entities: [o('e1', { label: 'A', rotation: 0 })] }
    const theirs = { entities: [o('e1', { label: 'A', rotation: 90 })] } // they rotated it
    const mine = { entities: [o('e1', { label: 'B', rotation: 0 })] }    // I renamed it
    const merged = mergeWorkspace(base, mine, theirs) as { entities: { label: string; rotation: number }[] }
    expect(merged.entities).toHaveLength(1)
    expect(merged.entities[0].label).toBe('B')      // my rename survives
    expect(merged.entities[0].rotation).toBe(0)     // their concurrent rotation is lost (not 90)
  })
})
