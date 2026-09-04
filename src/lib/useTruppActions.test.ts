import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dispatch, SetStateAction } from 'react'
import { useTruppActions, truppEditChanges, handOrder, nextTruppOrder, LAGE_TARGET } from './useTruppActions'
import type { BoardDoc, Drawing, Entity, Trupp, TruppFields } from '../types'
import { appConfig } from '../config/appConfig'
import { anyTruppInField, truppNeverDeployed } from './atemschutz'
import { fillTemplate } from './format'
import type { Doc } from './workspace'

// Capture the confirm-with-undo toasts, so the undo the operator would tap can be tapped here.
// `vi.hoisted` because vi.mock's factory is hoisted above the imports and would otherwise read
// the array in its temporal dead zone.
// …and the confirms (the Leitung/Symbol takeover, the «einrücken?» ask), so a test can answer
// them the way the operator would. `answer` is what the next dialog resolves to.
const ui = vi.hoisted(() => ({
  toasts: [] as { text: string; undo?: () => void }[],
  confirms: [] as { title?: string; message: string }[],
  answer: false,
}))
vi.mock('./ui', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ui')>(),
  toast: (text: string, opts?: { action?: { onClick: () => void } }) => {
    ui.toasts.push({ text, undo: opts?.action?.onClick })
    return 0
  },
  confirmDialog: (opts: { title?: string; message: string }) => {
    ui.confirms.push(opts)
    return Promise.resolve(ui.answer)
  },
}))

// useTruppActions has no React hooks inside — it's a closure factory over injected setters,
// so the one-place invariant (map XOR plan) is testable without renderHook.

const baseTrupp = (over: Partial<Trupp>): Trupp => ({
  id: 'T1', name: 'Keller Anna', entryPressureBar: 300, entryTime: '2026-07-06T10:00:00Z',
  lastContactTime: '2026-07-06T10:00:00Z', status: 'aktiv', ...over,
})

function harness(
  trupp: Trupp,
  seed?: { board?: BoardDoc; entities?: Entity[]; drawings?: Drawing[] },
  /** capture the Verlauf lines this action writes (icon, text) */
  log: (icon: string, text: string) => void = () => {},
) {
  const state = {
    trupps: [trupp],
    board: seed?.board ?? {},
    doc: { entities: seed?.entities ?? [], drawings: seed?.drawings ?? [] } as Doc,
  }
  const apply = <T,>(cur: T, a: SetStateAction<T>): T => (typeof a === 'function' ? (a as (p: T) => T)(cur) : a)
  // eslint-disable-next-line react-hooks/rules-of-hooks -- plain closure factory, no hooks inside
  const actions = useTruppActions({
    trupps: state.trupps,
    // the live Lage drawings the hose link reads (which numbers are taken, where a line lives)
    drawings: state.doc.drawings,
    // the live Lage entities the colour picker reads (see teamColors.ts)
    entities: state.doc.entities,
    setTrupps: ((a) => { state.trupps = apply(state.trupps, a) }) as Dispatch<SetStateAction<Trupp[]>>,
    board: state.board,
    setBoard: ((a) => { state.board = apply(state.board, a) }) as Dispatch<SetStateAction<BoardDoc>>,
    setDocRaw: ((a) => { state.doc = apply(state.doc, a) }) as Dispatch<SetStateAction<Doc>>,
    building: null,
    log, logPlan: () => {}, emit: () => {},
    setMode: () => {}, setActivePlanId: () => {}, setPanel: () => {}, setPlanFocus: () => {},
    mapCenter: () => [7.53, 47.41],
    focusMapEntity: () => {},
    focusMapDrawing: () => {},
  })
  return { actions, state }
}

describe('useTruppActions placement (one place per Trupp)', () => {
  it('placeTruppOnMap creates a linked team marker at the map centre', () => {
    const { actions, state } = harness(baseTrupp({}))
    actions.placeTruppOnMap('T1')
    const marker = state.doc.entities[0]
    expect(marker.kind).toBe('team')
    expect(marker.truppId).toBe('T1')
    expect(marker.coord).toEqual([7.53, 47.41])
    expect(marker.trail).toEqual([])
    expect(state.trupps[0].entityId).toBe(marker.id)
    expect(state.trupps[0].annoId).toBeUndefined()
  })

  it('placing on the map drops an existing plan chip', () => {
    const chip = { id: 'a1', kind: 'resource' as const, x: 0.5, y: 0.5, floor: 0, text: 'Keller A.' }
    const { actions, state } = harness(
      baseTrupp({ annoId: 'a1', planId: 'p1' }),
      { board: { p1: [chip] } },
    )
    actions.placeTruppOnMap('T1')
    expect(state.board.p1).toEqual([])
    expect(state.trupps[0].annoId).toBeUndefined()
    expect(state.trupps[0].planId).toBeUndefined()
    expect(state.trupps[0].entityId).toBeDefined()
  })

  it('placing on a plan drops an existing map marker', () => {
    const marker: Entity = { id: 'e1', kind: 'team', layer: 'einheiten', coord: [7.5, 47.4], truppId: 'T1', label: 'Keller A.' }
    const { actions, state } = harness(
      baseTrupp({ entityId: 'e1' }),
      { entities: [marker] },
    )
    actions.placeTruppOnPlan('T1', 'p1')
    expect(state.doc.entities).toEqual([])
    expect(state.trupps[0].entityId).toBeUndefined()
    expect(state.trupps[0].annoId).toBeDefined()
    expect(state.trupps[0].planId).toBe('p1')
  })

  // ⚠️ The placement goes; the RECORD stays, stamped. A crew that was under PA and then taken off
  // the Tafel is still part of what happened, and the Atemschutz page of the Rapport prints it
  // (types · Trupp.removedAt). Everything live filters on that stamp at the source.
  it('deleteTrupp removes whichever placement exists, and stamps the Trupp instead of erasing it', () => {
    const marker: Entity = { id: 'e1', kind: 'team', layer: 'einheiten', coord: [7.5, 47.4], truppId: 'T1' }
    const { actions, state } = harness(baseTrupp({ entityId: 'e1' }), { entities: [marker] })
    actions.deleteTrupp('T1')
    expect(state.trupps).toHaveLength(1)
    expect(state.trupps[0].removedAt).toBeTruthy()
    expect(state.doc.entities).toEqual([])
  })

  it('restoreTrupp (undo) re-adds the record but strips the removed placement refs', () => {
    const marker: Entity = { id: 'e1', kind: 'team', layer: 'einheiten', coord: [7.5, 47.4], truppId: 'T1' }
    const snapshot = baseTrupp({ entityId: 'e1', readings: [{ t: '2026-07-06T10:00:00Z', bar: 300, kind: 'entry' }] })
    const { actions, state } = harness(snapshot, { entities: [marker] })
    actions.deleteTrupp('T1')
    actions.restoreTrupp(snapshot)
    expect(state.trupps).toHaveLength(1)
    expect(state.trupps[0].removedAt).toBeUndefined()
    expect(state.trupps[0].readings).toEqual(snapshot.readings)
    expect(state.trupps[0].entityId).toBeUndefined()
    expect(state.trupps[0].annoId).toBeUndefined()
    expect(state.trupps[0].planId).toBeUndefined()
    // the marker stays gone — the restored Trupp is re-placed manually
    expect(state.doc.entities).toEqual([])
  })

  it('restoreTrupp is a no-op when the id already exists (double tap on Rückgängig)', () => {
    const t = baseTrupp({})
    const { actions, state } = harness(t)
    actions.restoreTrupp(t)
    expect(state.trupps).toHaveLength(1)
  })

  it('editTrupp keeps the map marker label in sync with the leader name', () => {
    const marker: Entity = { id: 'e1', kind: 'team', layer: 'einheiten', coord: [7.5, 47.4], truppId: 'T1', label: 'Keller A.' }
    const { actions, state } = harness(baseTrupp({ entityId: 'e1' }), { entities: [marker] })
    actions.editTrupp('T1', { name: 'Beat Muster', pressure: 300 })
    expect(state.doc.entities[0].label).toBe('Beat Muster')
  })

  // A 200 typed for 300 at der Anmeldung used to be uncorrectable: the edit form hid the field,
  // and everything downstream (Verbrauch, «tiefster Druck» on the Rapport) is measured against it.
  it('editTrupp corrects the Eingangsdruck — entry reading and lowestBar move with it', () => {
    const t = baseTrupp({
      entryPressureBar: 200,
      lowestBar: 200,
      readings: [
        { t: '2026-07-06T10:00:00Z', bar: 200, kind: 'entry' },
        { t: '2026-07-06T10:12:00Z', bar: 250, kind: 'pressure' },
      ],
    })
    const { actions, state } = harness(t)
    actions.editTrupp('T1', { name: 'Keller Anna', pressure: 300 })
    expect(state.trupps[0].entryPressureBar).toBe(300)
    // the entry ROW is the same statement written twice — a Verlauf still saying 200 would
    // contradict the card it sits next to
    expect(state.trupps[0].readings?.[0].bar).toBe(300)
    expect(state.trupps[0].readings?.[1].bar).toBe(250) // a real later reading is never rewritten
    // …and the lowest is re-derived, so a corrected entry can't leave a value nobody measured
    expect(state.trupps[0].lowestBar).toBe(250)
  })

  it('correcting the Eingangsdruck is not a Funkkontakt — the safety clock stays where it was', () => {
    const { actions, state } = harness(baseTrupp({ entryPressureBar: 200, lastContactTime: '2026-07-06T10:00:00Z' }))
    actions.editTrupp('T1', { name: 'Keller Anna', pressure: 300 })
    expect(state.trupps[0].lastContactTime).toBe('2026-07-06T10:00:00Z')
  })

  it('exports the Lage placement-target id the picker dispatches on', () => {
    expect(LAGE_TARGET).toBe('lage')
  })
})

/* The Art of a Trupp, changed after the fact (04.09.). Until then a Verkehrstrupp that ended up
 * going in under PA had to be deleted and registered again — throwing away the record of a crew
 * that was already working. What matters is not the flag but what it drags along: a safety watch
 * starts or stops, and the log has to be able to say when. */
describe('useTruppActions — hoch- und zurückstufen', () => {
  const plain = (over: Partial<Trupp> = {}): Trupp => baseTrupp({
    kind: 'einfach', entryPressureBar: 0, lowestBar: 0,
    readings: [{ t: '2026-07-06T10:00:00Z', bar: 0, kind: 'entry' }],
    ...over,
  })

  it('starts the Überwachung NOW, not at the Eintritt', () => {
    const { actions, state } = harness(plain({ lastContactTime: '' }))
    const before = Date.now()
    actions.editTrupp('T1', { name: 'Keller Anna', pressure: 300, kind: 'atemschutz' })

    const t = state.trupps[0]
    expect(t.kind).toBe('atemschutz')
    // ⚠️ the contact clock is stamped at the change. Counted from the Eintritt, a crew that has
    // been inside for forty minutes would be überfällig in the same second — with the tone going
    // off over a Trupp nobody had failed to reach.
    expect(Date.parse(t.lastContactTime)).toBeGreaterThanOrEqual(before)
    // …and the Einsatzzeit is NOT restarted: putting a mask on does not re-send the crew
    expect(t.entryTime).toBe('2026-07-06T10:00:00Z')
  })

  it('logs the Eingangsdruck as its own row instead of rewriting the Eintritt', () => {
    const { actions, state } = harness(plain())
    actions.editTrupp('T1', { name: 'Keller Anna', pressure: 300, kind: 'atemschutz' })

    const readings = state.trupps[0].readings ?? []
    expect(readings).toHaveLength(2)
    // the Eintritt stays exactly as it was recorded — the Trupp did NOT go in under PA
    expect(readings[0]).toMatchObject({ kind: 'entry', bar: 0 })
    expect(readings[1]).toMatchObject({ kind: 'paOn', bar: 300 })
    // …and everything the card measures against is the new cylinder
    expect(state.trupps[0].entryPressureBar).toBe(300)
    expect(state.trupps[0].lowestBar).toBe(300)
  })

  it('keeps the whole Atemschutz record when a Trupp is stood down to a work squad', () => {
    const t = baseTrupp({
      lastPressureBar: 180, lowestBar: 180,
      readings: [
        { t: '2026-07-06T10:00:00Z', bar: 300, kind: 'entry' },
        { t: '2026-07-06T10:20:00Z', bar: 180, kind: 'pressure' },
      ],
    })
    const { actions, state } = harness(t)
    actions.editTrupp('T1', { name: 'Keller Anna', pressure: 300, kind: 'einfach' })

    const now = state.trupps[0]
    expect(now.kind).toBe('einfach')
    // the Atemschutz-Einsatz happened and the sheet still prints it — only the watching stops
    expect(now.entryPressureBar).toBe(300)
    expect(now.lowestBar).toBe(180)
    expect(now.readings?.slice(0, 2)).toEqual(t.readings)
    expect(now.readings?.[2]).toMatchObject({ kind: 'paOff', bar: 180 })
  })

  it('leaves a Trupp alone when the Art did not actually change', () => {
    const { actions, state } = harness(baseTrupp({ readings: [{ t: '2026-07-06T10:00:00Z', bar: 300, kind: 'entry' }] }))
    actions.editTrupp('T1', { name: 'Keller Anna', pressure: 300, kind: 'atemschutz' })
    expect(state.trupps[0].readings).toHaveLength(1) // no paOn row for a Trupp that already was one
  })
})

// A Rückzug is ordered by the EL / Truppüberwacher or reported by the Trupp, and a Fortsetzen
// means the Trupp was reached and sent back in. Both are radio contacts, so both must reset the
// contact clock — otherwise the card keeps showing «überfällig» for a Trupp somebody just spoke to.
describe('useTruppActions — Rückzug / Fortsetzen count as a Funkkontakt', () => {
  const stale = { lastContactTime: '2026-07-06T10:00:00Z', readings: [{ t: '2026-07-06T10:00:00Z', bar: 300, kind: 'entry' as const }] }

  // …and it is written down AS a Rückzug (11.08.). Filed as a plain «Kontakt» it printed on the
  // Atemschutz-Journal as an ordinary radio check — the one row a reconstruction looks for,
  // indistinguishable from the twenty around it.
  it('Rückzug resets the contact clock and appends a Rückzug reading', () => {
    const { actions, state } = harness(baseTrupp({ status: 'aktiv', lastPressureBar: 140, ...stale }))
    actions.setTruppStatus('T1', 'rueckzug')
    const t = state.trupps[0]
    expect(t.status).toBe('rueckzug')
    expect(t.lastContactTime).not.toBe(stale.lastContactTime)
    expect(t.readings).toHaveLength(2)
    expect(t.readings?.[t.readings.length - 1]).toMatchObject({ kind: 'rueckzug', bar: 140 }) // carries the last known Druck
  })

  it('Fortsetzen out of a Rückzug resets the same clock, and says what it was', () => {
    const { actions, state } = harness(baseTrupp({ status: 'rueckzug', ...stale }))
    actions.setTruppStatus('T1', 'aktiv')
    const t = state.trupps[0]
    expect(t.status).toBe('aktiv')
    expect(t.lastContactTime).not.toBe(stale.lastContactTime)
    // ⚠️ 'resume', not 'contact' (19.08.): it is a Kontakt for the clock, but the crew going back
    // IN is the other half of the Rückzug and must not print as one of twenty radio checks.
    expect(t.readings?.[t.readings.length - 1]).toMatchObject({ kind: 'resume', bar: 300 }) // no reading yet → entry pressure
  })

  it('keeps the entry path intact: the FIRST «Eingerückt» still stamps entryTime and an entry reading', () => {
    const { actions, state } = harness(baseTrupp({ status: 'angemeldet', entryTime: '', lastContactTime: '', readings: [] }))
    actions.setTruppStatus('T1', 'aktiv')
    const t = state.trupps[0]
    expect(t.entryTime).toBeTruthy()
    expect(t.lastContactTime).toBe(t.entryTime)
    expect(t.readings).toEqual([{ t: t.entryTime, bar: 300, kind: 'entry' }])
  })

  it('re-deploy as Reserve keeps the Trupp out of the field: no entryTime, no running clock', () => {
    const out = baseTrupp({ status: 'raus', exitTime: '2026-07-06T10:30:00Z', lastPressureBar: 40, lowestBar: 40 })
    const { actions, state } = harness(out)
    actions.reactivateTrupp('T1', { name: 'Keller Anna', pressure: 300 }, true)
    const t = state.trupps[0]
    expect(t.status).toBe('angemeldet')
    expect(t.entryTime).toBe('')
    expect(t.lastContactTime).toBe('')
    expect(t.exitTime).toBeUndefined()
    // the fresh cylinder was READ — that reading opens the log, so a Reserve that is never
    // sent in still prints a Druckverlauf instead of «Kein Druckverlauf erfasst»
    expect(t.readings).toEqual([{ t: expect.any(String), bar: 300, kind: 'registered' }])
    expect(t.entryPressureBar).toBe(300)
    expect(t.lowestBar).toBe(300) // the old 40 bar must not follow the new bottle
    // and the standby Trupp is genuinely off the contact clock
    expect(anyTruppInField(state.trupps)).toBe(false)
  })

  it('re-deploy without standby still goes straight into the field (unchanged path)', () => {
    const out = baseTrupp({ status: 'raus', exitTime: '2026-07-06T10:30:00Z' })
    const { actions, state } = harness(out)
    actions.reactivateTrupp('T1', { name: 'Keller Anna', pressure: 300 })
    const t = state.trupps[0]
    expect(t.status).toBe('aktiv')
    expect(t.entryTime).toBeTruthy()
    expect(t.lastContactTime).toBe(t.entryTime)
    expect(t.readings).toEqual([{ t: t.entryTime, bar: 300, kind: 'entry' }])
  })

  it('a Trupp put on standby starts its clock only on the later «Eingerückt»', () => {
    const out = baseTrupp({ status: 'raus', exitTime: '2026-07-06T10:30:00Z' })
    const { actions, state } = harness(out)
    actions.reactivateTrupp('T1', { name: 'Keller Anna', pressure: 300 }, true)
    actions.setTruppStatus('T1', 'aktiv')
    const t = state.trupps[0]
    expect(t.status).toBe('aktiv')
    expect(t.entryTime).toBeTruthy()
    // the standby reading stays: the log is append-only, and the two rows are two real
    // moments — the cylinder read at the Tafel, then the crew going under PA
    expect(t.readings).toEqual([
      { t: expect.any(String), bar: 300, kind: 'registered' },
      { t: t.entryTime, bar: 300, kind: 'entry' },
    ])
  })

  it('«Raus» ends monitoring, records the Austritt, and does NOT fake a contact', () => {
    const { actions, state } = harness(baseTrupp({ status: 'rueckzug', ...stale }))
    actions.setTruppStatus('T1', 'raus')
    const t = state.trupps[0]
    expect(t.exitTime).toBeTruthy()
    expect(t.lastContactTime).toBe(stale.lastContactTime) // clock untouched — the Trupp is out
    // …and the log SAYS the crew came out, instead of just stopping (19.08.): the printed
    // Atemschutz page is read as a chronology, and the Austritt used to live only in its header
    expect(t.readings?.[t.readings.length - 1]).toMatchObject({ kind: 'exit' })
  })

  // The Sicherungstrupp that stood ready and was stood down. It is closed like any other Trupp,
  // so it must leave the same three traces: a stamp, a line in the Verlauf, and its own state —
  // and NOT be recorded as having come out of a building it never entered.
  it('standing a registered Trupp down stamps a time and logs it as «nicht eingesetzt»', () => {
    const lines: string[] = []
    const { actions, state } = harness(
      baseTrupp({ status: 'angemeldet', entryTime: '', lastContactTime: '' }),
      undefined,
      (_icon, text) => lines.push(text),
    )
    actions.setTruppStatus('T1', 'raus')
    const t = state.trupps[0]
    expect(t.status).toBe('raus')
    expect(t.exitTime).toBeTruthy()   // the timestamp the card + the Rapport print
    expect(t.entryTime).toBe('')      // …and it never went under PA
    expect(truppNeverDeployed(t)).toBe(true)
    expect(lines).toEqual([`Trupp ${t.name} nicht eingesetzt`])
  })

  it('a Trupp that DID go in is logged as «draussen», not «nicht eingesetzt»', () => {
    const lines: string[] = []
    const { actions, state } = harness(baseTrupp({ status: 'aktiv' }), undefined, (_i, text) => lines.push(text))
    actions.setTruppStatus('T1', 'raus')
    expect(truppNeverDeployed(state.trupps[0])).toBe(false)
    expect(lines).toEqual([`Trupp ${state.trupps[0].name} draussen`])
  })
})

/* The three lifecycle taps that touch the SAFETY CLOCK — «Eingerückt» starts it, «Rückzug» and
 * «Fortsetzen» reset it. A mis-tap on the wrong card therefore silences that Trupp's alarm and
 * writes a false line into an append-only record, so each one owes the same confirm-with-undo
 * «Raus» has always had. The Verlauf line stays either way (append-only); the undo restores the
 * Trupp. */
describe('useTruppActions — every status transition is undoable', () => {
  const stale = { lastContactTime: '2026-07-06T10:00:00Z', readings: [{ t: '2026-07-06T10:00:00Z', bar: 300, kind: 'entry' as const }] }
  const undoLast = () => {
    const undo = ui.toasts[ui.toasts.length - 1]?.undo
    expect(undo).toBeTypeOf('function')
    undo?.()
  }

  it('Rückzug: the undo brings back the status AND the contact clock it reset', () => {
    ui.toasts.length = 0
    const before = baseTrupp({ status: 'aktiv', lastPressureBar: 140, ...stale })
    const { actions, state } = harness(before)
    actions.setTruppStatus('T1', 'rueckzug')
    expect(state.trupps[0].lastContactTime).not.toBe(stale.lastContactTime)
    undoLast()
    expect(state.trupps[0]).toEqual(before)
  })

  it('Fortsetzen: same clock, same way back', () => {
    ui.toasts.length = 0
    const before = baseTrupp({ status: 'rueckzug', ...stale })
    const { actions, state } = harness(before)
    actions.setTruppStatus('T1', 'aktiv')
    const readings = state.trupps[0].readings ?? []
    expect(readings[readings.length - 1]).toMatchObject({ kind: 'resume' })
    undoLast()
    expect(state.trupps[0]).toEqual(before)
  })

  it('Eingerückt: the undo un-stamps entryTime, so the clock is not left running on a crew that never went in', () => {
    ui.toasts.length = 0
    const before = baseTrupp({ status: 'angemeldet', entryTime: '', lastContactTime: '', readings: [] })
    const { actions, state } = harness(before)
    actions.setTruppStatus('T1', 'aktiv')
    expect(state.trupps[0].entryTime).toBeTruthy()
    undoLast()
    expect(state.trupps[0]).toEqual(before)
  })

  it('Raus keeps its own undo (unchanged)', () => {
    ui.toasts.length = 0
    const before = baseTrupp({ status: 'aktiv', ...stale })
    const { actions, state } = harness(before)
    actions.setTruppStatus('T1', 'raus')
    expect(state.trupps[0].exitTime).toBeTruthy()
    undoLast()
    expect(state.trupps[0]).toEqual(before)
  })
})

describe('useTruppActions hose link (one action, two collections)', () => {
  const hose = (over: Partial<Drawing> = {}): Drawing =>
    ({ id: 'd1', kind: 'line', coords: [[7.5, 47.4], [7.51, 47.41]], ...over })

  it('writes the anchor on BOTH sides and stamps the Trupp’s number on the hose', () => {
    const { actions, state } = harness(baseTrupp({ lineNo: 1 }), { drawings: [hose()] })
    actions.linkTruppLine('T1', 'd1')
    expect(state.doc.drawings[0].truppId).toBe('T1')
    expect(state.doc.drawings[0].lineNo).toBe(1)
    expect(state.trupps[0].lineId).toBe('d1')
    expect(state.trupps[0].lineNo).toBe(1)
  })

  it('takes the number from the drawing when the Trupp has none', () => {
    const { actions, state } = harness(baseTrupp({}), { drawings: [hose({ lineNo: 4 })] })
    actions.linkTruppLine('T1', 'd1')
    expect(state.trupps[0].lineNo).toBe(4)
    expect(state.doc.drawings[0].lineNo).toBe(4)
  })

  it('moves the link when the Trupp is re-picked — a Trupp is on ONE Leitung', () => {
    const { actions, state } = harness(
      baseTrupp({ lineNo: 1, lineId: 'd1' }),
      { drawings: [hose({ truppId: 'T1', lineNo: 1 }), hose({ id: 'd2', lineNo: 2 })] },
    )
    actions.linkTruppLine('T1', 'd2')
    expect(state.doc.drawings[0].truppId).toBeUndefined() // the old hose lets go
    expect(state.doc.drawings[1].truppId).toBe('T1')
    expect(state.trupps[0].lineId).toBe('d2')
  })

  it('links a hose drawn on a PLAN, inferring the surface from the id', () => {
    const anno = { id: 'p-line', kind: 'draw' as const, pts: [[0.1, 0.1, 0], [0.4, 0.4, 0]] as [number, number, number][], lineNo: 7 }
    const { actions, state } = harness(baseTrupp({}), { board: { gebaeude: [anno] } })
    actions.linkTruppLine('T1', 'p-line')
    expect(state.board.gebaeude[0].truppId).toBe('T1')
    expect(state.trupps[0].lineId).toBe('p-line')
    expect(state.trupps[0].lineNo).toBe(7)
  })

  it('unlink clears BOTH the anchor and the Trupp’s number, and leaves the hose numbered', () => {
    // clearing only the anchor would let the number match re-attach the tag on the next render —
    // «gelöst» would visibly do nothing
    const { actions, state } = harness(
      baseTrupp({ lineNo: 1, lineId: 'd1' }),
      { drawings: [hose({ truppId: 'T1', lineNo: 1 })] },
    )
    actions.unlinkTruppLine('T1')
    expect(state.trupps[0].lineId).toBeUndefined()
    expect(state.trupps[0].lineNo).toBeUndefined()
    expect(state.doc.drawings[0].truppId).toBeUndefined()
    expect(state.doc.drawings[0].lineNo).toBe(1) // the hose is still Leitung 1 in the picture
  })
})

describe('useTruppActions hose link — aiming and missing', () => {
  it('reports false for a tap that did not land on a hose, so the pick stays armed', () => {
    const { actions, state } = harness(baseTrupp({}), {
      drawings: [{ id: 'circle', kind: 'circle', coords: [[7.5, 47.4]], radiusM: 90 }],
    })
    expect(actions.linkTruppLine('T1', 'circle')).toBe(false)
    expect(actions.linkTruppLine('T1', 'nope')).toBe(false)
    expect(state.trupps[0].lineId).toBeUndefined()
  })

  it('unlinkLine releases whoever is on that hose — including a number-only match', () => {
    const { actions, state } = harness(
      baseTrupp({ lineNo: 3 }), // never explicitly picked: matched by number alone
      { drawings: [{ id: 'd1', kind: 'line', coords: [[7.5, 47.4], [7.51, 47.41]], lineNo: 3 }] },
    )
    actions.unlinkLine('d1')
    expect(state.trupps[0].lineNo).toBeUndefined()
  })
})

// Renumbering the DRAWING is the other direction of the link: the Trupp carries a COPY of the
// number (the AS chip prints Trupp.lineNo), so the copy must follow the picture — but only for
// the Trupp actually anchored to this hose, never for one that merely typed the same digit.
describe('useTruppActions — renumbering a hose follows onto the anchored Trupp', () => {
  const hose = (over: Partial<Drawing> = {}): Drawing =>
    ({ id: 'd1', kind: 'line', coords: [[7.5, 47.4], [7.51, 47.41]], ...over })

  it('updates the anchored Trupp’s number (anchor via line.truppId)', () => {
    const { actions, state } = harness(
      baseTrupp({ lineNo: 1, lineId: 'd1' }),
      { drawings: [hose({ truppId: 'T1', lineNo: 1 })] },
    )
    actions.syncLineNoToTrupp('d1', 3)
    expect(state.trupps[0].lineNo).toBe(3)
    expect(state.trupps[0].lineId).toBe('d1') // the anchor survives — same hose, new name
  })

  it('still matches when only the Trupp side of the anchor survived', () => {
    const { actions, state } = harness(
      baseTrupp({ lineNo: 1, lineId: 'd1' }),
      { drawings: [hose({ lineNo: 1 })] }, // line.truppId lost (undo of the link)
    )
    actions.syncLineNoToTrupp('d1', 5)
    expect(state.trupps[0].lineNo).toBe(5)
  })

  it('never touches a Trupp that merely typed the same number (no anchor)', () => {
    const { actions, state } = harness(
      baseTrupp({ lineNo: 1 }), // number-only match, not anchored to d1
      { drawings: [hose({ lineNo: 1 })] },
    )
    actions.syncLineNoToTrupp('d1', 3)
    expect(state.trupps[0].lineNo).toBe(1)
  })

  // ⚠️ a `raus` Trupp SYNCS — its card keeps showing the Leitung chip, and «Ltg 1» beside a
  // hose tagged «Ltg 3» is exactly the lie this helper exists to prevent (19.08.). Only a
  // soft-deleted card is left alone.
  it('follows the renumber on a raus Trupp too — its chip is still showing', () => {
    const { actions, state } = harness(
      baseTrupp({ lineNo: 1, lineId: 'd1', status: 'raus', exitTime: '2026-07-06T10:30:00Z' }),
      { drawings: [hose({ truppId: 'T1', lineNo: 1 })] },
    )
    actions.syncLineNoToTrupp('d1', 3)
    expect(state.trupps[0].lineNo).toBe(3)
  })

  it('leaves a soft-deleted Trupp’s record alone', () => {
    const { actions, state } = harness(
      baseTrupp({ lineNo: 1, lineId: 'd1', removedAt: '2026-07-06T10:30:00Z' }),
      { drawings: [hose({ truppId: 'T1', lineNo: 1 })] },
    )
    actions.syncLineNoToTrupp('d1', 3)
    expect(state.trupps[0].lineNo).toBe(1)
  })

  it('follows a renumber on a PLAN-drawn hose too', () => {
    const anno = { id: 'p-line', kind: 'draw' as const, pts: [[0.1, 0.1, 0], [0.4, 0.4, 0]] as [number, number, number][], lineNo: 7, truppId: 'T1' }
    const { actions, state } = harness(baseTrupp({ lineNo: 7, lineId: 'p-line' }), { board: { gebaeude: [anno] } })
    actions.syncLineNoToTrupp('p-line', 2)
    expect(state.trupps[0].lineNo).toBe(2)
  })

  it('clearing the drawing’s number clears the Trupp’s copy with it', () => {
    const { actions, state } = harness(
      baseTrupp({ lineNo: 1, lineId: 'd1' }),
      { drawings: [hose({ truppId: 'T1', lineNo: 1 })] },
    )
    actions.syncLineNoToTrupp('d1', undefined)
    expect(state.trupps[0].lineNo).toBeUndefined()
  })
})

describe('useTruppActions — the Leitung number IS the link', () => {
  const hose2 = (over: Partial<Drawing> = {}): Drawing =>
    ({ id: 'd1', kind: 'line', coords: [[7.5, 47.4], [7.51, 47.41]], ...over })

  it('clearing the number in the form drops the anchor too', () => {
    // otherwise the tag survives its own number: the Trupp still points at the hose it was
    // picked for, and the operator's «weg damit» does nothing visible
    const { actions, state } = harness(
      baseTrupp({ lineNo: 1, lineId: 'd1' }),
      { drawings: [hose2({ truppId: 'T1', lineNo: 1 })] },
    )
    actions.editTrupp('T1', { name: 'Keller Anna', pressure: 300 }) // no lineNo → cleared
    expect(state.trupps[0].lineNo).toBeUndefined()
    expect(state.trupps[0].lineId).toBeUndefined()
    expect(state.doc.drawings[0].truppId).toBeUndefined()
    expect(state.doc.drawings[0].lineNo).toBe(1) // the hose stays Leitung 1 in the picture
  })

  it('moving to another number drops the old anchor, so the tag follows the number', () => {
    const { actions, state } = harness(
      baseTrupp({ lineNo: 1, lineId: 'd1' }),
      { drawings: [hose2({ truppId: 'T1', lineNo: 1 })] },
    )
    actions.editTrupp('T1', { name: 'Keller Anna', lineNo: 3, pressure: 300 })
    expect(state.trupps[0].lineNo).toBe(3)
    expect(state.trupps[0].lineId).toBeUndefined()
    expect(state.doc.drawings[0].truppId).toBeUndefined()
  })

  it('leaves the anchor alone when the number is unchanged', () => {
    const { actions, state } = harness(
      baseTrupp({ lineNo: 1, lineId: 'd1' }),
      { drawings: [hose2({ truppId: 'T1', lineNo: 1 })] },
    )
    actions.editTrupp('T1', { name: 'Keller Anna', lineNo: 1, pressure: 300 })
    expect(state.trupps[0].lineId).toBe('d1')
    expect(state.doc.drawings[0].truppId).toBe('T1')
  })
})

describe('useTruppActions — one Leitung, one Trupp', () => {
  it('picking a Trupp for a hose takes the number off whoever else claimed it', () => {
    const state = {
      trupps: [baseTrupp({ id: 'T1', lineNo: 1 }), baseTrupp({ id: 'T2', name: 'Neu Nina' })],
      board: {} as BoardDoc,
      doc: { entities: [], drawings: [{ id: 'd1', kind: 'line', coords: [[7.5, 47.4], [7.51, 47.41]], lineNo: 1 }] } as Doc,
    }
    const apply = <T,>(cur: T, a: SetStateAction<T>): T => (typeof a === 'function' ? (a as (p: T) => T)(cur) : a)
    // called outside a component on purpose: a plain closure factory, no hooks inside
    const actions = useTruppActions({
      trupps: state.trupps, drawings: state.doc.drawings, entities: state.doc.entities,
      setTrupps: ((a) => { state.trupps = apply(state.trupps, a) }) as Dispatch<SetStateAction<Trupp[]>>,
      board: state.board,
      setBoard: ((a) => { state.board = apply(state.board, a) }) as Dispatch<SetStateAction<BoardDoc>>,
      setDocRaw: ((a) => { state.doc = apply(state.doc, a) }) as Dispatch<SetStateAction<Doc>>,
      building: null, log: () => {}, logPlan: () => {}, emit: () => {},
      setMode: () => {}, setActivePlanId: () => {}, setPanel: () => {}, setPlanFocus: () => {},
      mapCenter: () => [7.53, 47.41], focusMapEntity: () => {}, focusMapDrawing: () => {},
    })
    actions.linkTruppLine('T2', 'd1')
    expect(state.trupps[1].lineNo).toBe(1)      // the new Trupp is on it
    expect(state.trupps[0].lineNo).toBeUndefined() // the old one let go
  })
})

// Colour means IDENTITY by default (ten Trupps, ten colours) — but an EL who would rather read the
// Lage by role must be able to say so, per Trupp or per Auftrag for the whole station. A picked
// colour is therefore used verbatim, duplicates included; only the automatic one steps aside.
describe('useTruppActions — Truppfarbe', () => {
  it('places a Trupp in its own picked colour, even if another already wears it', () => {
    const taken: Entity = {
      id: 'e0', kind: 'team', layer: 'operational', coord: [7.5, 47.4], color: '#e8392b', truppId: 'T0',
    } as unknown as Entity
    const { actions, state } = harness(baseTrupp({ color: '#e8392b' }), { entities: [taken] })
    actions.placeTruppOnMap('T1')
    expect(state.doc.entities[1].color).toBe('#e8392b')
  })

  it('falls back to a free palette colour when nobody picked one', () => {
    const { actions, state } = harness(baseTrupp({}))
    actions.placeTruppOnMap('T1')
    expect(state.doc.entities[0].color).toBeTruthy()
  })

  // an already-placed Trupp, the way the surfaces hand it to the actions on a later render
  const placed = (over: Partial<Trupp> = {}) => {
    const marker = { id: 'e1', kind: 'team', layer: 'operational', coord: [7.5, 47.4], color: '#1f6feb', truppId: 'T1' } as unknown as Entity
    return harness(baseTrupp({ entityId: 'e1', ...over }), { entities: [marker] })
  }

  it('setTruppColor writes the Trupp AND repaints its placed marker', () => {
    const { actions, state } = placed()
    actions.setTruppColor('T1', '#8b5cf6')
    expect(state.trupps[0].color).toBe('#8b5cf6')
    expect(state.doc.entities[0].color).toBe('#8b5cf6')
  })

  it('setTruppColor(null) goes back to automatic — the field is gone, the marker repainted', () => {
    const { actions, state } = placed({ color: '#8b5cf6' })
    actions.setTruppColor('T1', null)
    expect(state.trupps[0].color).toBeUndefined()
    expect(state.doc.entities[0].color).not.toBe('#8b5cf6')
  })

  it('editing a Trupp repaints its marker when the colour changed', () => {
    const { actions, state } = placed()
    actions.editTrupp('T1', { name: 'Keller Anna', pressure: 300, color: '#65a30d' })
    expect(state.trupps[0].color).toBe('#65a30d')
    expect(state.doc.entities[0].color).toBe('#65a30d')
  })

  it('truppColors reports what a Trupp actually wears — placed marker first, then its own pick', () => {
    expect(harness(baseTrupp({ color: '#0891b2' })).actions.truppColors()).toEqual({ T1: '#0891b2' })
    // once placed, the marker on screen is the truth (it is what the operator is looking at)
    expect(placed().actions.truppColors()).toEqual({ T1: '#1f6feb' })
  })

  // …and a Trupp that is neither placed nor decided still gets one: the board's colour column
  // had holes in it, which on a board where colour IS identity reads as «dieser hat keine».
  it('gives an unplaced, undecided Trupp its automatic palette slot', () => {
    const { actions } = harness(baseTrupp({}))
    expect(actions.truppColors().T1).toBe(appConfig.drawing.teamColors[0])
  })

  it('keeps the automatic ones apart from each other and from the decided ones', () => {
    const [c0, c1] = appConfig.drawing.teamColors
    const { actions, state } = harness(baseTrupp({}))
    // a second Trupp that has DECIDED on the first palette colour — the automatic one must
    // step aside rather than wear the same colour as its neighbour
    state.trupps.push({ ...baseTrupp({}), id: 'T2', color: c0 })
    const colors = actions.truppColors()
    expect(colors.T2).toBe(c0)
    expect(colors.T1).toBe(c1)
  })
})

describe('moveTrupp (hand-set board order)', () => {
  // the harness seeds one Trupp; a board needs several, so push the rest in first
  const board = (...ts: Trupp[]) => {
    const h = harness(ts[0])
    h.state.trupps = ts
    return h
  }
  const orders = (ts: Trupp[]) => ts.map((t) => [t.id, t.order] as const)

  /** the board as the Atemschutz comparator reads it (lib/useTruppActions · handOrder) */
  const asShown = (ts: Trupp[]) => handOrder(ts.filter((t) => !t.removedAt)).map((e) => e.t.id)

  it('re-keys only the card that moved', () => {
    const { actions, state } = board(
      baseTrupp({ id: 'a', order: 1 }), baseTrupp({ id: 'b', order: 2 }), baseTrupp({ id: 'c', order: 3 }),
    )
    actions.moveTrupp('c', -1)
    // b keeps its number — a concurrent edit on another device merges over nothing this wrote
    expect(orders(state.trupps)).toEqual([['a', 1], ['b', 2], ['c', 1.5]])
    expect(asShown(state.trupps)).toEqual(['a', 'c', 'b'])
  })

  it('does nothing at either end', () => {
    const { actions, state } = board(baseTrupp({ id: 'a', order: 1 }), baseTrupp({ id: 'b', order: 2 }))
    actions.moveTrupp('a', -1)
    actions.moveTrupp('b', 1)
    expect(orders(state.trupps)).toEqual([['a', 1], ['b', 2]])
  })

  it('settles a Trupp that never carried an order from where it currently sits', () => {
    const { actions, state } = board(baseTrupp({ id: 'a' }), baseTrupp({ id: 'b' }))
    actions.moveTrupp('b', -1)
    expect(asShown(state.trupps)).toEqual(['b', 'a'])
  })

  // ⚠️ the old swap took its values from SUBSET indices, so it could hand a card a number another
  // card already carried — and a tie falls back to array order, i.e. the tap did nothing visible
  it('moves a card even on a board whose orders already collide', () => {
    const { actions, state } = board(
      baseTrupp({ id: 'a', order: 0 }), baseTrupp({ id: 'b', order: 0 }), baseTrupp({ id: 'c', order: 0 }),
    )
    actions.moveTrupp('c', -1)
    expect(asShown(state.trupps)[0]).toBe('c')
  })

  /* ⚠️ …and it steps within the card's OWN section (03.09.). The board draws Atemschutz and
   * «Weitere Trupps» apart, so a neighbour in the global key space that lives in the other half
   * is invisible — jumping over it is the same dead button the removedAt filter above exists to
   * prevent. */
  it('steps past the next card of the SAME kind, not over one in the other section', () => {
    const { actions, state } = board(
      baseTrupp({ id: 'pa1', order: 1 }),
      baseTrupp({ id: 'plain', order: 2, kind: 'einfach' }),
      baseTrupp({ id: 'pa2', order: 3 }),
    )
    actions.moveTrupp('pa2', -1)
    // pa2 lands ahead of pa1 — the section it is actually shown in — rather than between the
    // two, where the Atemschutz half would look unchanged
    const pa = (ts: Trupp[]) => handOrder(ts.filter((t) => t.kind !== 'einfach')).map((e) => e.t.id)
    expect(pa(state.trupps)).toEqual(['pa2', 'pa1'])
  })
})

describe('hand-set board order (the key AtemschutzView sorts on)', () => {
  const t = (over: Partial<Trupp>) => baseTrupp(over)

  it('reads a stored order, and a Trupp without one by where it sits', () => {
    expect(handOrder([t({ id: 'a' }), t({ id: 'b', order: -1 }), t({ id: 'c' })]).map((e) => e.t.id))
      .toEqual(['b', 'a', 'c'])
  })

  // THE bug: `max(order ?? 0) + 1` is 1 on a board of unordered Trupps, so the new card tied with
  // the SECOND one and landed in position 2 instead of at the far right
  it('puts a new Trupp last on a board that carries no orders at all', () => {
    const legacy = [t({ id: 'a' }), t({ id: 'b' }), t({ id: 'c' })]
    expect(nextTruppOrder(legacy)).toBe(3)
    expect(handOrder([...legacy, t({ id: 'neu', order: nextTruppOrder(legacy) })]).map((e) => e.t.id))
      .toEqual(['a', 'b', 'c', 'neu'])
  })

  it('puts a new Trupp last in a MIX of ordered, unordered and removed Trupps', () => {
    const mixed = [
      t({ id: 'a' }), t({ id: 'weg', removedAt: '2026-09-01T10:00:00Z', order: 7 }),
      t({ id: 'b', order: 2 }), t({ id: 'c' }),
    ]
    const neu = t({ id: 'neu', order: nextTruppOrder(mixed) })
    const shown = handOrder([...mixed, neu].filter((x) => !x.removedAt)).map((e) => e.t.id)
    expect(shown[shown.length - 1]).toBe('neu')
  })

  it('a new Trupp still lands last after the board was hand-arranged', () => {
    const { actions, state } = harness(baseTrupp({ id: 'a' }))
    state.trupps = [baseTrupp({ id: 'a' }), baseTrupp({ id: 'b' }), baseTrupp({ id: 'c' })]
    actions.moveTrupp('c', -1)
    actions.moveTrupp('c', -1)
    actions.createTrupp(baseTrupp({ id: 'neu' }))
    expect(handOrder(state.trupps).map((e) => e.t.id)).toEqual(['c', 'a', 'b', 'neu'])
  })
})

describe('truppEditChanges (what the Verlauf line says)', () => {
  const fields = (over: Partial<TruppFields> = {}): TruppFields => ({
    name: 'Keller Anna', members: ['Meier Hans', 'Frei Nina'], pressure: 300, funkkanal: 11, ...over,
  } as TruppFields)
  const prev = baseTrupp({ name: 'Keller Anna', members: ['Meier Hans', 'Frei Nina'], funkkanal: 11 })

  // ⚠️ FIRST in the line, not somewhere in the middle: it is the only change here that turns a
  // safety watch on or off, and the Verlauf is where somebody reads back what was watched when.
  it('leads with the Art, and says nothing about it when it did not change', () => {
    const az = appConfig.copy.atemschutz
    expect(truppEditChanges(prev, fields({ kind: 'einfach', pressure: 280 })))
      .toEqual([az.changeKindPlain, fillTemplate(az.changePressure, { from: '300', to: '280' })])
    expect(truppEditChanges({ ...prev, kind: 'einfach' }, fields({ kind: 'atemschutz' })))
      .toEqual([az.changeKindPa])
    // an ABSENT kind means Atemschutz, so a plain Trupp edited where the chooser is not shown
    // must not read as a downgrade
    expect(truppEditChanges({ ...prev, kind: 'einfach' }, fields())).toEqual([])
  })

  it('names both numbers when the Eingangsdruck was corrected', () => {
    expect(truppEditChanges(prev, fields({ pressure: 280 })))
      .toEqual([fillTemplate(appConfig.copy.atemschutz.changePressure, { from: '300', to: '280' })])
  })

  it('names the AdF who was taken out — the question asked afterwards', () => {
    expect(truppEditChanges(prev, fields({ members: ['Meier Hans'] })))
      .toEqual(['Frei Nina aus dem Trupp genommen'])
  })

  it('names who joined, and reports a swap as both', () => {
    expect(truppEditChanges(prev, fields({ members: ['Meier Hans', 'Graf Stefan'] })))
      .toEqual(['Frei Nina aus dem Trupp genommen', 'Graf Stefan dazugekommen'])
  })

  it('names the outgoing AND incoming Gruppenführer', () => {
    expect(truppEditChanges(prev, fields({ name: 'Schmid Peter' })))
      .toEqual(['Gruppenführer Keller Anna → Schmid Peter'])
  })

  // Field report 02.09.: only the role was swapped, and the row read «Gruppenführer A → B, B aus
  // dem Trupp genommen, A dazugekommen» — the record asserting a departure and an arrival that
  // never happened, on the same crew, in one sentence.
  it('reads a pure role swap as ONE statement — nobody left, nobody joined', () => {
    expect(truppEditChanges(prev, fields({ name: 'Meier Hans', members: ['Keller Anna', 'Frei Nina'] })))
      .toEqual(['Gruppenführer Keller Anna → Meier Hans'])
  })

  it('still names a real departure when the leader is handed over at the same time', () => {
    expect(truppEditChanges(prev, fields({ name: 'Meier Hans', members: ['Keller Anna'] })))
      .toEqual(['Gruppenführer Keller Anna → Meier Hans', 'Frei Nina aus dem Trupp genommen'])
  })

  // «Auftrag angepasst» named nothing: read back an hour later it could be a new order, a
  // corrected floor or a fixed typo, and that is precisely what the Verlauf is read for.
  it('names the Auftrag the Trupp now has, Ziel included', () => {
    expect(truppEditChanges(prev, fields({ auftrag: 'retten', ziel: '2OG links' })))
      .toEqual(['Auftrag Retten – 2OG links'])
  })

  it('lets the free text stand alone under «anderes» — there the text IS the order', () => {
    expect(truppEditChanges(prev, fields({ auftrag: 'anderes', ziel: 'Tank sichern' })))
      .toEqual(['Auftrag Tank sichern'])
  })

  it('says an Auftrag was taken away rather than naming an empty one', () => {
    expect(truppEditChanges(baseTrupp({ ...prev, auftrag: 'retten', ziel: '2OG links' }), fields()))
      .toEqual(['Auftrag entfernt'])
  })

  it('distinguishes a new Leitung from a released one', () => {
    expect(truppEditChanges(prev, fields({ lineNo: 3 }))).toEqual(['Leitung 3'])
    expect(truppEditChanges(baseTrupp({ ...prev, lineNo: 3 }), fields())).toEqual(['Leitung gelöst'])
  })

  it('reports the Funkkanal, which used to vanish into «Auftrag angepasst»', () => {
    expect(truppEditChanges(prev, fields({ funkkanal: 12 }))).toEqual(['Funkkanal 12'])
  })

  it('says nothing when the form was saved unchanged', () => {
    expect(truppEditChanges(prev, fields({ funkkanal: 11 }))).toEqual([])
  })
})

describe('useTruppActions — the Eingangsdruck opens the Druckverlauf', () => {
  it('a newly registered Trupp already has its cylinder reading logged', () => {
    const { actions, state } = harness(baseTrupp({}))
    actions.createTrupp({
      id: 'T9', name: 'Sicherungstrupp', entryPressureBar: 300, entryTime: '', lastContactTime: '',
      lowestBar: 300, status: 'angemeldet', readings: [],
    })
    const t = state.trupps.find((x) => x.id === 'T9')!
    expect(t.readings).toEqual([{ t: expect.any(String), bar: 300, kind: 'registered' }])
  })

  // …and a Trupp without Atemschutz opens no Druckverlauf at all: there is no cylinder, and a
  // «0 bar» row would be a measurement the app invented on a legal record.
  it('a Trupp ohne Atemschutz starts with an empty log', () => {
    const { actions, state } = harness(baseTrupp({}))
    actions.createTrupp({
      id: 'T8', kind: 'einfach', name: 'Verkehr', entryPressureBar: 0, entryTime: '',
      lastContactTime: '', lowestBar: 0, status: 'angemeldet', readings: [],
    })
    expect(state.trupps.find((x) => x.id === 'T8')!.readings).toEqual([])
  })
})

// The two rows the printed Atemschutz-Journal is actually read for: when the Trupp hit its
// Alarmdruck and when it was ordered back. Both used to be indistinguishable on it.
describe('useTruppActions — the Alarmdruck is a reading of its own kind', () => {
  const alarmBar = appConfig.atemschutz.alarmBar

  it('files the reading that CROSSES the Alarmdruck as «alarm», and logs one row for it', () => {
    const lines: string[] = []
    const { actions, state } = harness(
      baseTrupp({ lastPressureBar: alarmBar + 50, readings: [] }),
      undefined,
      (_i, text) => lines.push(text),
    )
    actions.recordPressure('T1', alarmBar)
    const r = state.trupps[0].readings ?? []
    expect(r[r.length - 1]).toMatchObject({ kind: 'alarm', bar: alarmBar })
    // ⚠️ ONE row, not «Druck 100 bar» followed by «Alarmdruck 100 bar erreicht» in the same minute
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(appConfig.copy.atemschutz.readingKind.alarm)
  })

  it('an ordinary reading above the Alarmdruck stays a plain Druck', () => {
    const { actions, state } = harness(baseTrupp({ lastPressureBar: 300, readings: [] }))
    actions.recordPressure('T1', 250)
    const r = state.trupps[0].readings ?? []
    expect(r[r.length - 1]).toMatchObject({ kind: 'pressure', bar: 250 })
  })

  it('does not repeat itself once the Trupp is already below the Alarmdruck', () => {
    const { actions, state } = harness(baseTrupp({ lastPressureBar: alarmBar - 10, readings: [] }))
    actions.recordPressure('T1', alarmBar - 20)
    const r = state.trupps[0].readings ?? []
    expect(r[r.length - 1]).toMatchObject({ kind: 'pressure' })
  })

  it('uses the separate Rückzug line for a Trupp already on its way out', () => {
    const rueckzugBar = appConfig.atemschutz.alarmBarRueckzug
    const { actions, state } = harness(baseTrupp({
      status: 'rueckzug', lastPressureBar: rueckzugBar + 10, readings: [],
    }))
    actions.recordPressure('T1', rueckzugBar)
    const r = state.trupps[0].readings ?? []
    expect(r[r.length - 1]).toMatchObject({ kind: 'alarm', bar: rueckzugBar })
  })
})

// ⚠️ The Atemschutz page of the Rapport prints `readings`. Re-deploying used to START A NEW LOG,
// so the deployment that had been under PA the longest was the one missing from the safety
// document — the same «replace instead of keep» that Trupp-delete was fixed for.
describe('re-deploying a Trupp keeps the pressure log', () => {
  const deployed = (): Trupp => baseTrupp({
    status: 'raus', exitTime: '2026-07-06T10:40:00Z', lowestBar: 120, entryPressureBar: 300,
    readings: [
      { t: '2026-07-06T10:00:00Z', bar: 300, kind: 'entry' },
      { t: '2026-07-06T10:20:00Z', bar: 180, kind: 'pressure' },
      { t: '2026-07-06T10:40:00Z', bar: 120, kind: 'pressure' },
    ],
  })

  it('appends the fresh cylinder to what was already recorded', () => {
    const { actions, state } = harness(deployed())
    actions.reactivateTrupp('T1', { name: 'Keller Anna', pressure: 300 })
    const r = state.trupps[0].readings!
    expect(r).toHaveLength(4)
    expect(r.slice(0, 3).map((x) => x.bar)).toEqual([300, 180, 120])
    expect(r[3]).toMatchObject({ bar: 300, kind: 'entry' })
    // …while the CARD is about the running deployment again
    expect(state.trupps[0].lowestBar).toBe(300)
    expect(state.trupps[0].exitTime).toBeUndefined()
  })

  // ⚠️ …and the correction path has to follow: index 0 is now the entry of an Einsatz that is over.
  // Two harnesses, because the factory closes over the trupps it was given — one render each,
  // exactly like the app.
  it('corrects the entry pressure of the RUNNING deployment, not the first one', () => {
    const first = harness(deployed())
    first.actions.reactivateTrupp('T1', { name: 'Keller Anna', pressure: 200 })

    const second = harness(first.state.trupps[0])
    second.actions.editTrupp('T1', { name: 'Keller Anna', pressure: 300 })
    const r = second.state.trupps[0].readings!
    expect(r[0].bar).toBe(300)   // the old deployment's entry, untouched (it happened to be 300)
    expect(r[1].bar).toBe(180)   // …and its readings
    expect(r[3].bar).toBe(300)   // the corrected entry of the current run
    // the lowest is measured over the RUNNING deployment only — 120 bar was another bottle
    expect(second.state.trupps[0].lowestBar).toBe(300)
  })
})

/* ── A placed symbol and its Trupp find each other in ANY order ────────────────────────────────
 *
 * The mirror of the hose link: a «Trupp 2» dropped on the Lage before anybody was registered can
 * be joined to its Atemschutz-Trupp afterwards, from either end. One symbol belongs to one Trupp,
 * a takeover asks first — and NOTHING in here touches a contact clock. */
describe('useTruppActions — placed symbol ⇄ Trupp', () => {
  const marker = (over: Partial<Entity> & { id: string }): Entity =>
    ({ kind: 'team', layer: 'operational', coord: [7.5, 47.4], ...over } as Entity)

  /** two Trupps on one board — the shape adoption needs (somebody to take a symbol FROM) */
  function pair(a: Trupp, b: Trupp, seed?: { entities?: Entity[]; board?: BoardDoc }) {
    const state = {
      trupps: [a, b],
      board: seed?.board ?? {},
      doc: { entities: seed?.entities ?? [], drawings: [] } as Doc,
    }
    const apply = <T,>(cur: T, x: SetStateAction<T>): T => (typeof x === 'function' ? (x as (p: T) => T)(cur) : x)
    const lines: string[] = []
    // eslint-disable-next-line react-hooks/rules-of-hooks -- plain closure factory, no hooks inside
    const actions = useTruppActions({
      trupps: state.trupps, drawings: state.doc.drawings, entities: state.doc.entities,
      setTrupps: ((x) => { state.trupps = apply(state.trupps, x) }) as Dispatch<SetStateAction<Trupp[]>>,
      board: state.board,
      setBoard: ((x) => { state.board = apply(state.board, x) }) as Dispatch<SetStateAction<BoardDoc>>,
      setDocRaw: ((x) => { state.doc = apply(state.doc, x) }) as Dispatch<SetStateAction<Doc>>,
      building: null, log: (_i, t) => lines.push(t), logPlan: (_i, t) => lines.push(t), emit: () => {},
      setMode: () => {}, setActivePlanId: () => {}, setPanel: () => {}, setPlanFocus: () => {},
      mapCenter: () => [7.53, 47.41], focusMapEntity: () => {}, focusMapDrawing: () => {},
    })
    return { actions, state, lines }
  }

  const anna = baseTrupp({})
  const beat = baseTrupp({ id: 'T2', name: 'Berger Beat' })

  beforeEach(() => { ui.confirms.length = 0; ui.answer = false })

  it('joins a loose marker: the symbol takes the Trupp’s name, the Trupp its place', async () => {
    const { actions, state } = pair(anna, beat, { entities: [marker({ id: 'e1', label: 'Trupp 2', color: '#111111' })] })
    expect(await actions.adoptTruppMarker('T1', 'e1')).toBe(true)
    expect(state.doc.entities[0].truppId).toBe('T1')
    expect(state.doc.entities[0].label).toBe('Keller Anna')
    expect(state.doc.entities[0].color).not.toBe('#111111') // repainted to the Trupp's colour
    expect(state.trupps[0].entityId).toBe('e1')
    expect(ui.confirms).toHaveLength(0) // nobody held it — nothing to ask
  })

  // the dots ARE the Truppverfolgung: adopting patches the marker, it never re-places it
  it('keeps the marker’s recorded trail', async () => {
    const trail = [{ coord: [7.5, 47.4] as [number, number], t: '10:04' }]
    const { actions, state } = pair(anna, beat, { entities: [marker({ id: 'e1', trail })] })
    await actions.adoptTruppMarker('T1', 'e1')
    expect(state.doc.entities[0].trail).toEqual(trail)
  })

  it('joins a plan chip and records the plan it stands on', async () => {
    const chip = { id: 'a1', kind: 'resource' as const, x: 0.4, y: 0.6, floor: 2, text: 'Trupp 2' }
    const { actions, state } = pair(anna, beat, { board: { gebaeude: [chip] } })
    expect(await actions.adoptTruppMarker('T1', 'a1')).toBe(true)
    expect(state.board.gebaeude[0].truppId).toBe('T1')
    expect(state.trupps[0].annoId).toBe('a1')
    expect(state.trupps[0].planId).toBe('gebaeude')
    expect(state.trupps[0].entityId).toBeUndefined()
  })

  // one Trupp, one place — the same rule «Platzieren» follows
  it('drops the Trupp’s previous placement', async () => {
    const chip = { id: 'a1', kind: 'resource' as const, x: 0.5, y: 0.5, floor: 0, text: 'Keller Anna', truppId: 'T1' }
    const { actions, state } = pair(baseTrupp({ annoId: 'a1', planId: 'gebaeude' }), beat, {
      entities: [marker({ id: 'e1', label: 'Trupp 2' })], board: { gebaeude: [chip] },
    })
    await actions.adoptTruppMarker('T1', 'e1')
    expect(state.board.gebaeude).toEqual([])
    expect(state.trupps[0].entityId).toBe('e1')
    expect(state.trupps[0].annoId).toBeUndefined()
  })

  it('asks before taking a symbol off another Trupp — and Abbrechen writes nothing', async () => {
    const held = { ...beat, entityId: 'e1' }
    const { actions, state } = pair(anna, held, { entities: [marker({ id: 'e1', truppId: 'T2', label: 'Berger Beat' })] })
    expect(await actions.adoptTruppMarker('T1', 'e1')).toBe(false)
    expect(ui.confirms).toHaveLength(1)
    expect(ui.confirms[0].message).toContain('Berger Beat')
    expect(ui.confirms[0].message).toContain('Keller Anna')
    expect(state.doc.entities[0].truppId).toBe('T2')
    expect(state.trupps[1].entityId).toBe('e1')
  })

  it('…and on «Übernehmen» the previous Trupp loses the PLACEMENT and nothing else', async () => {
    ui.answer = true
    const held = { ...beat, entityId: 'e1', lastContactTime: '2026-07-06T10:00:00Z', status: 'aktiv' as const }
    const { actions, state } = pair(anna, held, { entities: [marker({ id: 'e1', truppId: 'T2' })] })
    expect(await actions.adoptTruppMarker('T1', 'e1')).toBe(true)
    expect(state.doc.entities[0].truppId).toBe('T1')
    expect(state.trupps[0].entityId).toBe('e1')
    const previous = state.trupps[1]
    expect(previous.entityId).toBeUndefined()
    // ⚠️ the clock doctrine: a takeover of a SYMBOL is not an event in the Atemschutzüberwachung
    expect(previous.status).toBe('aktiv')
    expect(previous.lastContactTime).toBe('2026-07-06T10:00:00Z')
    expect(previous.exitTime).toBeUndefined()
    expect(previous.readings).toEqual(held.readings)
  })

  it('never asks the operator to take a symbol over from itself', async () => {
    const { actions } = pair(baseTrupp({ entityId: 'e1' }), beat, { entities: [marker({ id: 'e1', truppId: 'T1' })] })
    expect(await actions.adoptTruppMarker('T1', 'e1')).toBe(true)
    expect(ui.confirms).toHaveLength(0)
  })

  it('refuses an id that is not a placed Trupp', async () => {
    const { actions } = pair(anna, beat, { entities: [marker({ id: 's1', kind: 'symbol' })] })
    expect(await actions.adoptTruppMarker('T1', 's1')).toBe(false)
    expect(await actions.adoptTruppMarker('T1', 'nope')).toBe(false)
  })

  it('releasing leaves the symbol standing — it just belongs to nobody', () => {
    const { actions, state } = pair(baseTrupp({ entityId: 'e1' }), beat, {
      entities: [marker({ id: 'e1', truppId: 'T1', label: 'Keller Anna' })],
    })
    actions.releaseTruppMarker('e1')
    expect(state.doc.entities).toHaveLength(1)
    expect(state.doc.entities[0].truppId).toBeUndefined()
    expect(state.doc.entities[0].label).toBe('Keller Anna')
    expect(state.trupps[0].entityId).toBeUndefined()
    // …and the clock is untouched here too
    expect(state.trupps[0].status).toBe('aktiv')
    expect(state.trupps[0].lastContactTime).toBe(anna.lastContactTime)
  })
})

/* ── «Der Trupp steht jetzt da – ist er eingerückt?» ────────────────────────────────────────────
 *
 * Placing (or joining) a symbol for a Trupp the board says never went in is the one moment the
 * picture and the record disagree. The ask is the fix; confirming runs the board's own
 * «Einrücken», declining leaves the symbol and nothing else. */
describe('useTruppActions — the check-in ask on placement', () => {
  const standby = () => baseTrupp({ status: 'angemeldet', entryTime: '', lastContactTime: '', readings: [] })

  beforeEach(() => { ui.confirms.length = 0; ui.answer = false })

  it('asks when an angemeldeter Trupp is placed, and «Einrücken» starts the clock', async () => {
    ui.answer = true
    const { actions, state } = harness(standby())
    actions.placeTruppOnMap('T1')
    await Promise.resolve() // the ask is fired-and-forgotten by the placement
    await Promise.resolve()
    expect(ui.confirms).toHaveLength(1)
    expect(ui.confirms[0].message).toContain('Keller Anna')
    expect(state.trupps[0].status).toBe('aktiv')
    expect(state.trupps[0].entryTime).toBeTruthy()
    expect(state.trupps[0].lastContactTime).toBeTruthy()
    // the board's own «Einrücken» — so the entry reading is written the same way
    const readings = state.trupps[0].readings ?? []
    expect(readings[readings.length - 1]).toMatchObject({ kind: 'entry', bar: 300 })
  })

  it('declining places the symbol and nothing else — no clock, no entry row', async () => {
    const { actions, state } = harness(standby())
    actions.placeTruppOnMap('T1')
    await Promise.resolve()
    await Promise.resolve()
    expect(ui.confirms).toHaveLength(1)
    expect(state.doc.entities[0].truppId).toBe('T1') // …the placement itself stands
    expect(state.trupps[0].status).toBe('angemeldet')
    expect(state.trupps[0].entryTime).toBe('')
    expect(state.trupps[0].readings).toEqual([])
  })

  // a crew that is already inside has nothing to confirm, and one that is out would need a fresh
  // cylinder («Wieder einrücken») — neither may be asked on a placement
  it('stays quiet for a Trupp that is in the field or already out', async () => {
    const inField = harness(baseTrupp({ status: 'aktiv' }))
    inField.actions.placeTruppOnMap('T1')
    const out = harness(baseTrupp({ status: 'raus', exitTime: '2026-07-06T11:00:00Z' }))
    out.actions.placeTruppOnMap('T1')
    await Promise.resolve()
    await Promise.resolve()
    expect(ui.confirms).toHaveLength(0)
  })
})
