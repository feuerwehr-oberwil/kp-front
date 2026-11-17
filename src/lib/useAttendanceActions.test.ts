import { describe, expect, it, vi } from 'vitest'
import type { Dispatch, SetStateAction } from 'react'
import { useAttendanceActions } from './useAttendanceActions'
import { intervalsOf, isPresent } from './attendanceIntervals'
import type { AttendanceState } from '../types'
import { appConfig } from '../config/appConfig'
import { fillTemplate } from './format'

// every toast raised, so a test can say there was none (owner pick 28: the slice's ↶ is the way back)
const toasts = vi.hoisted(() => ({ said: [] as string[] }))
vi.mock('./ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ui')>(),
  toast: (text: string) => { toasts.said.push(text); return 1 },
  undoToast: (text: string) => { toasts.said.push(text); return 1 },
}))

// useAttendanceActions has no React hooks inside — it's a closure factory over injected
// setters, so it is testable without renderHook (same shape as useTruppActions.test.ts).

const STARTED = '2026-06-23T19:12:00.000Z'

function harness(initial: AttendanceState = {}, notes = { current: {} as Record<string, string> }) {
  const state = { attendance: initial, log: [] as string[] }
  const apply = <T,>(cur: T, a: SetStateAction<T>): T => (typeof a === 'function' ? (a as (p: T) => T)(cur) : a)
  // eslint-disable-next-line react-hooks/rules-of-hooks -- plain closure factory, no hooks inside
  const actions = useAttendanceActions({
    attendance: state.attendance,
    setAttendance: ((a) => { state.attendance = apply(state.attendance, a) }) as Dispatch<SetStateAction<AttendanceState>>,
    blockedAttendanceIds: new Set<string>(),
    startedAt: STARTED,
    reportDoneAt: null,
    noteMemory: notes,
    log: (_icon, text) => state.log.push(text),
  })
  return { actions, state, notes }
}

describe('addGuest — somebody on scene who is not on the Mannschaftsliste', () => {
  it('opens a presence block from the ALARM, like every other first tick', () => {
    const { actions, state } = harness()
    const id = actions.addGuest('Muster Felix (Nachbarwehr)')
    expect(id).toBeTruthy()
    const entry = state.attendance[id!]
    expect(entry.displayNameSnapshot).toBe('Muster Felix (Nachbarwehr)')
    expect(isPresent(entry)).toBe(true)
    // ticking usually happens long after arrival — «von» is the alarm, never now
    expect(intervalsOf(entry)[0]?.from).toBe(STARTED)
  })

  it('is a record of the Einsatz, so it earns a Verlauf row', () => {
    const { actions, state } = harness()
    actions.addGuest('Muster Felix')
    expect(state.log.join(' ')).toContain('Muster Felix')
  })

  it('refuses a blank name instead of creating a nameless row', () => {
    const { actions, state } = harness()
    expect(actions.addGuest('   ')).toBeUndefined()
    expect(Object.keys(state.attendance)).toHaveLength(0)
  })

  // A Gast is usually created BY the field that names them — «Fahrer TLF» on a vehicle, the
  // Einsatzleiter on the Rapport. The job has to be written here: their row does not exist yet,
  // so the caller has nothing to hang a Bemerkung on afterwards.
  it('carries the job it was typed into onto the row, in one Verlauf line', () => {
    const { actions, state } = harness()
    const id = actions.addGuest('Muster Felix', 'Fahrer TLF')
    expect(state.attendance[id!].note).toBe('Fahrer TLF')
    expect(state.log).toHaveLength(1)
    expect(state.log[0]).toContain('Muster Felix')
    expect(state.log[0]).toContain('Fahrer TLF')
  })

  it('gives each guest their own id — two «Gast» entries are two people', () => {
    const { actions, state } = harness()
    const a = actions.addGuest('Muster Felix')
    const b = actions.addGuest('Beispiel Anna')
    expect(a).not.toBe(b)
    expect(Object.keys(state.attendance)).toHaveLength(2)
  })
})

describe('removing a guest on purpose', () => {
  // The row's tap no longer reaches this for a guest (see AnwesenheitView · cycle): their
  // attendance entry is the only record that they were ever here, so the third tap would delete
  // the person. This is the explicit path behind «Person entfernen», and it still works.
  const guest = { id: 'g1', displayName: 'Muster Felix', active: true, updatedAt: '', guest: true }

  it('takes them off the sheet, with the usual undo', () => {
    const { actions, state } = harness({
      g1: { status: 'present', displayNameSnapshot: 'Muster Felix', intervals: [{ from: STARTED }] },
    })
    actions.clearAttendance(guest)
    expect(state.attendance.g1).toBeUndefined()
    expect(state.log.join(' ')).toContain('Muster Felix')
  })
})

// ⚠️ «frei» deletes the entry — that is what «nothing recorded» means, and an empty entry left
// behind would print on the Personalblatt as present for the whole Einsatz. What must NOT be lost
// with it is the Bemerkung: «Fahrer TLF» is a statement about what somebody did here, and a row
// cycled past «frei» by accident threw it away with no way back.
describe('the Bemerkung survives a row cycled to «frei» and back', () => {
  const person = { id: 'p1', displayName: 'Meier Anna', active: true, updatedAt: STARTED }
  const withNote = (note?: string): AttendanceState => ({
    p1: { status: 'present', displayNameSnapshot: 'Meier Anna', note, intervals: [{ from: STARTED }] },
  })

  it('remembers it when the row is cleared, and writes it back on the next tick', () => {
    // ⚠️ two harnesses on purpose: the factory closes over the attendance it was given, exactly
    // like a render does, so «clear, then tick again» is two renders in the app too
    const cleared = harness(withNote('Fahrer TLF'))
    cleared.actions.clearAttendance(person)
    expect(cleared.state.attendance.p1).toBeUndefined()
    expect(cleared.notes.current.p1).toBe('Fahrer TLF')

    const back = harness({}, cleared.notes)
    back.actions.markPresent(person)
    expect(back.state.attendance.p1.note).toBe('Fahrer TLF')
  })

  it('never overwrites a note that is on the record', () => {
    const { actions, state } = harness(withNote('Verkehrsdienst'), { current: { p1: 'Fahrer TLF' } })
    actions.markLeft(person)
    actions.markPresent(person)
    expect(state.attendance.p1.note).toBe('Verkehrsdienst')
  })

  it('forgets it once the note itself is cleared', () => {
    const cleared = harness(withNote('Fahrer TLF'))
    cleared.actions.setAttendanceNote('p1', '')
    expect(cleared.notes.current.p1).toBeUndefined()
  })
})

// ⚠️ 04.09.: the mirror image of the capture side's stamp (lib/captureClient). Without both, a
// divergence row cannot name its two sides and is back to «diese» vs «jene».
describe('every write from this surface is stamped «am Kommandoposten»', () => {
  const person = { id: 'p1', displayName: 'Keller Anna', active: true, updatedAt: STARTED }

  it('stamps an entry this surface created', () => {
    const { actions, state } = harness()
    actions.markPresent(person)
    expect(state.attendance.p1.source).toBe('kp')
  })

  it('stamps an entry this surface CHANGED, whichever action did it', () => {
    const { actions, state } = harness({
      p1: { status: 'present', displayNameSnapshot: 'Keller Anna', source: 'capture' },
    })
    actions.setAttendanceNote('p1', 'Fahrer TLF')
    expect(state.attendance.p1.source).toBe('kp')
    expect(state.attendance.p1.note).toBe('Fahrer TLF')
  })

  it('⚠️ leaves a row nobody touched alone — the stamp says who WROTE it, not who was looking', () => {
    const fromBogen = { status: 'present' as const, displayNameSnapshot: 'Muster Beat', source: 'capture' as const }
    const { actions, state } = harness({ p1: { status: 'present', displayNameSnapshot: 'Keller Anna' }, p2: fromBogen })
    actions.setAttendanceNote('p1', 'Einsatzleiter')
    expect(state.attendance.p2).toBe(fromBogen)
  })
})

// owner pick 28 (17.11.2026): clearing a row and removing a block write the Anwesenheit slice –
// ONE ↶ step each (IncidentWorkspace · attHist) – and raise no toast
describe('clearing a row', () => {
  it('writes the removal row and raises no toast', () => {
    const person = { id: 'p1', displayName: 'Meier Anna' } as Parameters<ReturnType<typeof harness>['actions']['clearAttendance']>[0]
    const { actions, state } = harness({ p1: { status: 'present', displayNameSnapshot: 'Meier Anna', intervals: [{ from: STARTED }] } })
    toasts.said.length = 0
    actions.clearAttendance(person)
    expect(state.attendance.p1).toBeUndefined()
    expect(state.log).toEqual([fillTemplate(appConfig.copy.abschluss.attendanceRemoved, { name: 'Meier Anna' })])
    expect(toasts.said).toEqual([])
  })
})

// UX sweep F1 (20.10.2026): the sheet's delete became the bin
describe('removing one recorded block', () => {
  it('drops that block only, and raises no toast', () => {
    const blocks = [{ from: STARTED, to: '2026-06-23T21:40:00.000Z' }, { from: '2026-06-23T22:10:00.000Z' }]
    const { actions, state } = harness({ p1: { status: 'present', displayNameSnapshot: 'Meier Anna', intervals: blocks } })
    toasts.said.length = 0
    actions.removeAttendanceBlock('p1', 0)
    expect(intervalsOf(state.attendance.p1)).toEqual([blocks[1]])
    expect(toasts.said).toEqual([])
  })
})
