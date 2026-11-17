import { describe, expect, it } from 'vitest'
import type { OpenReminder } from './reminders'
import { pinnedWithTicked, type TickedHere } from './pinnedPendenzen'

const item = (id: string): OpenReminder => ({ id, rowId: `row-${id}`, text: id, createdAt: '', notes: [] }) as unknown as OpenReminder
const ids = (rs: readonly OpenReminder[]) => rs.map((r) => r.id)

describe('pinnedWithTicked', () => {
  it('keeps an item ticked off here in the slot it was ticked in', () => {
    const ticked = new Map<string, TickedHere>([['b', { r: item('b'), after: 'a' }]])
    expect(ids(pinnedWithTicked([item('a'), item('c')], ticked))).toEqual(['a', 'b', 'c'])
  })

  it('puts the top row back on top, and chains rows ticked one after the other', () => {
    const ticked = new Map<string, TickedHere>([
      ['a', { r: item('a'), after: null }],
      ['b', { r: item('b'), after: 'a' }],
    ])
    expect(ids(pinnedWithTicked([item('c')], ticked))).toEqual(['a', 'b', 'c'])
  })

  it('lists an item that is open again once, from the open list', () => {
    const ticked = new Map<string, TickedHere>([['a', { r: item('a'), after: null }]])
    expect(ids(pinnedWithTicked([item('a'), item('b')], ticked))).toEqual(['a', 'b'])
  })
})
