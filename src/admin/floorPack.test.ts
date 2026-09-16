import { describe, expect, it } from 'vitest'
import { appendFloor, appendPart, clampToClip, defaultStack, dropFromStack, entryJoined, floorsFromStack, hitJoinPoint, indexOf, moveJoinPoint, patchEntry, reorderStack, restoreToStack, reverseStack, sameStack, signedIndex, stackComplete, stackFromFloors, storeysOf, partOf, partsOf, trayOf } from './floorPack'

// Wyss Gartencenter Modul 6 as exported: page 0 = 2. OG, 1 = 1. OG, 2 = EG / ZWG, 3 = UG
const wyss = [
  { page: 0, index: 2, part: 0, name: null, clip: null, join: null }, { page: 1, index: 1, part: 0, name: null, clip: null, join: null },
  { page: 2, index: 0, part: 0, name: 'EG / ZWG', clip: null, join: null }, { page: 3, index: -1, part: 0, name: null, clip: null, join: null },
]

describe('floor stack ↔ floors', () => {
  it('indices fall out of the stack order and the level-0 entry, never typed', () => {
    const stack = defaultStack(4)
    const zeroed = { ...stack, zero: stack.order[2].key }
    expect(zeroed.order.map((e) => indexOf(zeroed, e.key))).toEqual([2, 1, 0, -1])
    const named = patchEntry(patchEntry(zeroed, zeroed.order[2].key, { name: 'EG / ZWG' }), zeroed.order[1].key, { name: ' 1. OG ' })
    expect(floorsFromStack(named)).toEqual(wyss) // a standard name is not stored
    const back = stackFromFloors(wyss, 2)!
    expect(back.order.map((e) => e.page)).toEqual([0, 1, 2, 3]); expect(back.order[2].key).toBe(back.zero); expect(back.fitPage).toBeUndefined()
    expect(stackFromFloors([], 0)).toBeNull()
  })
  it('a fit page other than level 0 is the explicit choice it was', () => {
    expect(stackFromFloors(wyss, 3)?.fitPage).toBe(3)
    expect(stackFromFloors(wyss, 7)?.fitPage).toBeUndefined()
  })
  it('regions: several entries on one page, joined two at a time – and the chain must reach everyone', () => {
    const a0 = [
      { page: 0, index: 1, part: 0, name: null, clip: [0.02, 0.5, 0.35, 0.95] as [number, number, number, number], join: { to: 0, at: [0.05, 0.9] as [number, number], there: [0.41, 0.45] as [number, number] } },
      { page: 0, index: 0, part: 0, name: 'EG / ZWG', clip: [0.38, 0.02, 0.98, 0.5] as [number, number, number, number], join: null },
    ]
    const stack = stackFromFloors(a0, 0)!
    expect(stack.order.map((e) => e.page)).toEqual([0, 0])
    expect(stack.order[0].join?.toKey).toBe(stack.order[1].key)
    expect(floorsFromStack(stack)).toEqual(a0) // the join's target comes back as an INDEX
    expect(stackComplete(stack)).toBe(true)
    const more = appendFloor(stack, 0).stack // «Geschoss hinzufügen» – below the lowest, same page
    expect(more.order.map((e: { page: number }) => e.page)).toEqual([0, 0, 0])
    expect(stackComplete(more)).toBe(true) // a whole-page entry needs no join
    const drawn = patchEntry(more, more.order[2].key, { clip: [0.4, 0.55, 0.7, 0.95] })
    expect(stackComplete(drawn)).toBe(false) // …a third drawing does, until it is joined to the rest
    expect(entryJoined(drawn, drawn.order[2].key)).toBe(false)
    const joined = patchEntry(drawn, drawn.order[2].key, { join: { toKey: drawn.order[1].key, at: [0.43, 0.9], there: [0.41, 0.45] } })
    expect(stackComplete(joined)).toBe(true)
    // joining in the OTHER direction counts too: the top floor joined from the ground floor
    const backwards = patchEntry(patchEntry(drawn, drawn.order[2].key, { join: undefined }), drawn.order[1].key, { join: { toKey: drawn.order[2].key, at: [0.41, 0.45], there: [0.43, 0.9] } })
    expect(stackComplete(backwards)).toBe(true)
  })
  it('reordering, reversing, dropping and restoring keep the stack valid', () => {
    let stack = defaultStack(4)
    const [k0, k1, k2, k3] = stack.order.map((e) => e.key)
    stack = reorderStack(stack, k3, k2) // dragged one row up – the grip is the only reorder
    expect(stack.order.map((e) => e.page)).toEqual([0, 1, 3, 2])
    expect(reorderStack(stack, k0, k0)).toBe(stack)
    expect(reorderStack(stack, k0, undefined).order.map((e) => e.page)).toEqual([1, 3, 2, 0])
    expect(reorderStack(stack, k2, k1).order.map((e) => e.page)).toEqual([0, 2, 1, 3])
    stack = reverseStack(defaultStack(4))
    expect(stack.order.map((e) => e.page)).toEqual([3, 2, 1, 0])
    const top = stack.order[0].key
    const dropped = dropFromStack({ ...stack, zero: top, fitPage: 3 }, top)
    expect(dropped.order.map((e) => e.page)).toEqual([2, 1, 0]); expect(dropped.zero).toBe(dropped.order[0].key); expect(dropped.fitPage).toBeUndefined()
    expect(trayOf(dropped, 4)).toEqual([3])
    expect(restoreToStack(dropped, 3).order.map((e) => e.page)).toEqual([2, 1, 0, 3])
    expect(restoreToStack({ order: [], zero: '', }, 1).zero).toBeTruthy()
  })
  it('sameStack compares what would be saved, not how it was reached', () => {
    const a = stackFromFloors(wyss, 2)
    const b = defaultStack(4); const bz = { ...b, zero: b.order[2].key }
    expect(sameStack(a, patchEntry(bz, bz.order[2].key, { name: 'EG / ZWG' }))).toBe(true)
    expect(sameStack(a, { ...bz, fitPage: 3 })).toBe(false)
    expect(sameStack(null, bz)).toBe(false)
  })
  it('signs indices like every floor badge', () => {
    expect([2, 0, -1].map(signedIndex)).toEqual(['+2', '0', '−1'])
  })
})


// ⚠️ the circles sit INSIDE the rectangles, so a press is asked of them first – otherwise
// grabbing a staircase point drags the whole drawing away under it.
describe('grabbing a join point', () => {
  const stack = stackFromFloors([
    { page: 0, index: 1, name: null, clip: [0, 0, 0.4, 1], join: { to: 0, at: [0.1, 0.2], there: [0.7, 0.8] } },
    { page: 0, index: 0, name: null, clip: [0.5, 0, 1, 1], join: null },
  ], 0)!
  const size = { width: 1000, height: 500 }
  const owner = stack.order[0].key

  it('finds the nearest endpoint within reach, both ends of the same join, and nothing beyond it', () => {
    expect(hitJoinPoint(stack.order, 0, [0.1, 0.2], size, 22)).toEqual({ key: owner, end: 'at' })
    expect(hitJoinPoint(stack.order, 0, [0.7, 0.8], size, 22)).toEqual({ key: owner, end: 'there' })
    expect(hitJoinPoint(stack.order, 0, [0.115, 0.2], size, 22)).toEqual({ key: owner, end: 'at' }) // 15 px off
    expect(hitJoinPoint(stack.order, 0, [0.14, 0.2], size, 22)).toBeNull() // 40 px off – that is the rectangle's press
    expect(hitJoinPoint(stack.order, 1, [0.1, 0.2], size, 22)).toBeNull() // the endpoint is drawn on page 1, not here
  })

  it('a dragged endpoint stays inside the drawing it belongs to', () => {
    const at = moveJoinPoint(stack, { key: owner, end: 'at' }, [0.9, 0.5]) // yanked into the OTHER drawing
    expect(at.order[0].join).toEqual({ toKey: stack.order[1].key, at: [0.4, 0.5], there: [0.7, 0.8] })
    const there = moveJoinPoint(stack, { key: owner, end: 'there' }, [0.1, 0.5])
    expect(there.order[0].join?.there).toEqual([0.5, 0.5]) // clamped into the floor it points at
    expect(clampToClip([2, -1], undefined)).toEqual([1, 0]) // a whole page is the whole page
  })
})

it('requires cropped floors on different pages to connect to the reference', () => {
  const stack = stackFromFloors([
    { page: 0, index: 0, name: null, clip: [0.1, 0.1, 0.9, 0.9] },
    { page: 1, index: 1, name: null, clip: [0.2, 0.2, 0.8, 0.8] },
  ], 0)!
  expect(stackComplete(stack)).toBe(false)
  const connected = patchEntry(stack, stack.order[0].key, {
    join: { toKey: stack.zero, at: [0.3, 0.3], there: [0.5, 0.5] },
  })
  expect(stackComplete(connected)).toBe(true)
})

// One Geschoss out of several drawings (16.09.2026): the further drawings are entries too, but
// only the STOREYS carry an index – the pieces are pieces of the row above them.
describe('a storey drawn in several pieces', () => {
  const wings = [
    { page: 0, index: 1, part: 0, name: 'West', clip: [0.02, 0.05, 0.45, 0.95] as [number, number, number, number], join: { to: 0, at: [0.1, 0.5] as [number, number], there: [0.2, 0.5] as [number, number] } },
    { page: 0, index: 1, part: 1, name: 'Ost', clip: [0.5, 0.05, 0.95, 0.95] as [number, number, number, number], join: { to: 0, at: [0.6, 0.5] as [number, number], there: [0.8, 0.5] as [number, number] } },
    { page: 1, index: 0, part: 0, name: null, clip: null, join: null },
  ]
  it('round-trips through the stack: two rows, three drawings, the indices unmoved', () => {
    const stack = stackFromFloors(wings, 1)!
    expect(storeysOf(stack)).toHaveLength(2)
    expect(stack.order).toHaveLength(3)
    expect(stack.order.map((e) => indexOf(stack, e.key))).toEqual([1, 1, 0])
    expect(stack.order.map((e) => partOf(stack, e.key))).toEqual([0, 1, 0])
    expect(floorsFromStack(stack)).toEqual(wings)
    expect(stackComplete(stack)).toBe(true)
  })
  it('a further drawing is added behind its storey, needs its own rectangle, and can be dropped alone', () => {
    const stack = stackFromFloors(wings, 1)!
    const eg = storeysOf(stack)[1]
    const { stack: grown, key } = appendPart(stack, eg.key)
    expect(storeysOf(grown)).toHaveLength(2) // still two Geschosse…
    expect(partsOf(grown, eg.key).map((e) => e.key)).toEqual([eg.key, key]) // …and the EG has two drawings
    expect(floorsFromStack(grown).map((f) => [f.index, f.part])).toEqual([[1, 0], [1, 1], [0, 0], [0, 1]])
    expect(stackComplete(grown)).toBe(false) // a piece without a rectangle is nothing yet
    expect(floorsFromStack(dropFromStack(grown, key)).map((f) => [f.index, f.part])).toEqual([[1, 0], [1, 1], [0, 0]])
  })
  it('a storey takes its pieces with it – when it is removed, and when it is reversed', () => {
    const stack = stackFromFloors(wings, 1)!
    const gone = dropFromStack(stack, storeysOf(stack)[0].key)
    expect(gone.order).toHaveLength(1) // both wings left with their storey…
    expect(gone.order[0].join).toBeUndefined() // …and the join that pointed into them is no join
    const flipped = reverseStack(stack)
    expect(flipped.order.map((e) => [indexOf(flipped, e.key), partOf(flipped, e.key)])).toEqual([[0, 0], [-1, 0], [-1, 1]])
  })
})
