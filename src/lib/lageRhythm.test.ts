import { describe, expect, it } from 'vitest'
import { currentLageReminderId, derivedStartBooking, firstVorOrt, LAGE_START_ID, lageChipState, lageReminderId, lageRhythm } from './lageRhythm'
import { deriveReminders } from './reminders'
import { pendenzRows } from './report'
import type { TimelineEvent } from '../types'

const T0 = Date.parse('2026-10-09T19:12:00Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const OPTS = { defaultMin: 20, firstAfterMin: 5 }

const anchorRow = (id: string, min: number, extra: Partial<TimelineEvent> = {}): TimelineEvent =>
  ({ id, t: '', at: at(min), icon: 'radio', text: `Lagemeldung ${min}`, kind: 'journal', lagemeldung: { v: 1, mode: 'seit', facts: {} }, ...extra })
const booking = (id: string, min: number, dueMin: number, intervalMin = 20, op: 'created' | 'snoozed' | 'done' = 'created'): TimelineEvent =>
  ({ id: `b-${id}-${min}-${op}`, t: '', at: at(min), icon: 'bell', text: 'Nächste Lagemeldung', kind: 'reminder', reminder: { op, id, ...(op !== 'done' ? { dueAt: at(dueMin) } : {}), purpose: op === 'created' ? 'lagemeldung' : undefined, intervalMin } })

describe('the booking id', () => {
  it('is derived from the newest Lagemeldung row, or the start before the first one', () => {
    expect(currentLageReminderId([])).toBe(LAGE_START_ID)
    expect(currentLageReminderId([anchorRow('a1', 5), anchorRow('a2', 25)])).toBe(lageReminderId('a2'))
  })
})

describe('deriveReminders · the bookings supersede each other', () => {
  it('only the booking of the newest Lagemeldung is open — no done row needed', () => {
    const rows = [anchorRow('a1', 5), booking('lgm-a1', 5, 25), anchorRow('a2', 25), booking('lgm-a2', 25, 45)].reverse()
    const open = deriveReminders(rows)
    expect(open.map((r) => [r.id, r.purpose, r.intervalMin])).toEqual([['lgm-a2', 'lagemeldung', 20]])
  })
  it('a retracted Lagemeldung hands the open booking back to the one before', () => {
    const rows = [anchorRow('a1', 5), booking('lgm-a1', 5, 25), booking('lgm-a2', 25, 45)].reverse()
    expect(deriveReminders(rows).map((r) => r.id)).toEqual(['lgm-a1'])
  })
  it('ordinary Wiedervorlagen are untouched', () => {
    const plain: TimelineEvent = { id: 'p', t: '', at: at(3), icon: 'bell', text: 'x', reminder: { op: 'created', id: 'pnd1', dueAt: at(10) } }
    expect(deriveReminders([plain, anchorRow('a1', 5)]).map((r) => r.id)).toEqual(['pnd1'])
  })
  it('the Rapport does not list the bookings among the Pendenzen', () => {
    expect(pendenzRows([booking('lgm-a1', 5, 25), anchorRow('a1', 5)])).toEqual([])
  })
})

describe('lageRhythm', () => {
  it('nothing on scene, nothing sent: idle', () => {
    expect(lageRhythm([], [], [], OPTS)).toMatchObject({ dueAt: null, derived: false, off: false, reminderId: LAGE_START_ID, intervalMin: 20 })
  })
  it('the first one is derived: 5′ after the first vehicle is vor Ort (clock or GPS)', () => {
    const r = lageRhythm([], [], [{ id: 'adl', gps: { zone: 'scene', an: at(9) } }, { id: 'tlf', vorOrt: at(4) }], OPTS)
    expect(r).toMatchObject({ derived: true, dueAt: T0 + 9 * 60_000 })
    expect(firstVorOrt([{ id: 'x' }])).toBeNull()
  })
  it('a written booking wins and carries its interval', () => {
    const rows = [anchorRow('a1', 5), booking('lgm-a1', 5, 35, 30)].reverse()
    const r = lageRhythm(rows, deriveReminders(rows), [{ id: 'tlf', vorOrt: at(4) }], OPTS)
    expect(r).toMatchObject({ derived: false, off: false, dueAt: T0 + 35 * 60_000, intervalMin: 30, reminderId: 'lgm-a1' })
  })
  it('a done row on the current booking is «Aus»; a new Lagemeldung starts it again', () => {
    const rows = [anchorRow('a1', 5), booking('lgm-a1', 5, 25), booking('lgm-a1', 10, 0, 20, 'done')].reverse()
    expect(lageRhythm(rows, deriveReminders(rows), [], OPTS)).toMatchObject({ off: true, dueAt: null })
    const again = [...rows].reverse().concat([anchorRow('a2', 40), booking('lgm-a2', 40, 60)]).reverse()
    expect(lageRhythm(again, deriveReminders(again), [], OPTS)).toMatchObject({ off: false, dueAt: T0 + 60 * 60_000 })
  })
  it('«Aus» before the first Lagemeldung silences the derived start', () => {
    const rows = [booking(LAGE_START_ID, 9, 0, 20, 'done')]
    expect(lageRhythm(rows, deriveReminders(rows), [{ id: 'tlf', vorOrt: at(4) }], OPTS)).toMatchObject({ off: true, derived: false })
  })
  it('+10′ on the derived start writes it: then it is an ordinary booking', () => {
    const rows = [booking(LAGE_START_ID, 9, 19)]
    expect(lageRhythm(rows, deriveReminders(rows), [{ id: 'tlf', vorOrt: at(4) }], OPTS)).toMatchObject({ derived: false, dueAt: T0 + 19 * 60_000 })
  })
  it('sent «bei Übergabe» (no booking): idle, not off', () => {
    const rows = [anchorRow('a1', 50)]
    expect(lageRhythm(rows, deriveReminders(rows), [{ id: 'tlf', vorOrt: at(4) }], OPTS)).toMatchObject({ dueAt: null, off: false, derived: false })
  })
})

describe('lageChipState', () => {
  const now = T0 + 20 * 60_000
  it('counts down, then due, then late after +5′', () => {
    expect(lageChipState({ dueAt: now + 3.5 * 60_000, off: false }, now)).toEqual({ kind: 'soon', mins: 4 })
    expect(lageChipState({ dueAt: now - 60_000, off: false }, now)).toEqual({ kind: 'due', mins: 1 })
    expect(lageChipState({ dueAt: now - 6 * 60_000, off: false }, now)).toEqual({ kind: 'late', mins: 6 })
    expect(lageChipState({ dueAt: null, off: false }, now).kind).toBe('idle')
    expect(lageChipState({ dueAt: now, off: true }, now).kind).toBe('off')
  })
})

describe('derivedStartBooking', () => {
  const opts = { firstAfterMin: 5, text: 'Lagemeldung' }
  it('is due 5′ after the first vehicle on scene, before any Lagemeldung', () => {
    expect(derivedStartBooking([], [{ id: 'tlf', vorOrt: at(4) }], opts)).toMatchObject({ id: LAGE_START_ID, purpose: 'lagemeldung', dueAt: at(9) })
  })
  it('is gone once a Lagemeldung was sent, or the start was written (+10′ / Aus), or nobody is there', () => {
    const f = [{ id: 'tlf', vorOrt: at(4) }]
    expect(derivedStartBooking([anchorRow('a1', 6)], f, opts)).toBeNull()
    expect(derivedStartBooking([booking(LAGE_START_ID, 9, 19)], f, opts)).toBeNull()
    expect(derivedStartBooking([], [], opts)).toBeNull()
  })
})
