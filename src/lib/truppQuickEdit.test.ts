import { describe, expect, it } from 'vitest'
import { KANAL_PAD_MAX, auftragSheetFields, kanalPad, kanalSheetFields, leitungChoices, quickAuftragTypes } from './truppQuickEdit'
import { truppEditChanges } from './useTruppActions'
import type { Trupp } from '../types'

/* The mini sheets of the phone card (26.09.2026, phone card slim-down) are new DOORS to
 * `editTrupp`, not a new write. What has to hold: each sheet hands the write the Trupp as it
 * stands with ONLY its own fields changed — so the Verlauf row names that one change and nothing
 * the sheet never showed is silently rewritten. */
const trupp: Trupp = {
  id: 't1', no: 2, name: 'Hirter Stephan', members: ['Bendik Dimitri'],
  leaderPersonId: 'p1', memberPersonIds: ['p2'],
  auftrag: 'loeschen', ziel: 'Test', lineNo: 1, funkkanal: 11,
  entryPressureBar: 280, entryTime: '2026-09-26T20:00:00Z', lastContactTime: '2026-09-26T20:05:00Z',
  status: 'aktiv', equipment: ['retthaube'],
}

describe('kanalPad — the station\'s channel range as keys', () => {
  it('lays out min…max inclusive', () => {
    expect(kanalPad(1, 16)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1))
    expect(kanalPad(5, 5)).toEqual([5])
  })
  it('gives up above a Handfunk\'s range — the stepper takes over', () => {
    expect(kanalPad(1, KANAL_PAD_MAX)).toHaveLength(KANAL_PAD_MAX)
    expect(kanalPad(1, KANAL_PAD_MAX + 1)).toBeNull()
    // the shipped default ceiling is a free number, not a dial
    expect(kanalPad(1, 9999)).toBeNull()
  })
  it('refuses a range that is no range', () => {
    expect(kanalPad(9, 3)).toBeNull()
    expect(kanalPad(NaN, 3)).toBeNull()
  })
})

describe('the Auftrag sheet\'s save', () => {
  it('changes only Auftrag, Ziel and Leitung — crew, channel, pressure and equipment ride through as stored', () => {
    const f = auftragSheetFields(trupp, { auftrag: 'retten', ziel: '2. OG', lineNo: 3 })
    expect(f).toMatchObject({ name: 'Hirter Stephan', members: ['Bendik Dimitri'], leaderPersonId: 'p1', memberPersonIds: ['p2'],
      funkkanal: 11, pressure: 280, equipment: ['retthaube'], auftrag: 'retten', ziel: '2. OG', lineNo: 3 })
    // …and the Verlauf row names exactly that: the Auftrag with its Ziel (one clause), the Leitung
    expect(truppEditChanges(trupp, f)).toHaveLength(2)
    expect(truppEditChanges(trupp, f).join(' | ')).toMatch(/Retten.*2\. OG/)
  })
  it('clears an emptied Ziel and «keine» Leitung as ABSENT, never as an empty string', () => {
    const f = auftragSheetFields(trupp, { auftrag: 'loeschen', ziel: '   ', lineNo: null })
    expect(f.ziel).toBeUndefined()
    expect(f.lineNo).toBeUndefined()
    expect(f.auftrag).toBe('loeschen')
  })
  it('writes nothing new when nothing was touched', () => {
    const f = auftragSheetFields(trupp, { auftrag: trupp.auftrag, ziel: trupp.ziel!, lineNo: trupp.lineNo! })
    expect(truppEditChanges(trupp, f)).toEqual([])
  })
})

describe('the Kanal sheet\'s tap', () => {
  it('is the same Trupp on one other channel', () => {
    const f = kanalSheetFields(trupp, 7)
    expect(f.funkkanal).toBe(7)
    expect(truppEditChanges(trupp, f)).toHaveLength(1)
    expect(truppEditChanges(trupp, kanalSheetFields(trupp, 11))).toEqual([])
  })
})

describe('the sheets\' choices', () => {
  it('offers the Auftrag list of the Trupp\'s Art', () => {
    expect(quickAuftragTypes(trupp).map((a) => a.id)).toEqual(['retten', 'loeschen', 'absuchen', 'sichern', 'erkunden', 'anderes'])
    expect(quickAuftragTypes({ ...trupp, kind: 'einfach' }).map((a) => a.id)).toEqual(['verkehr', 'sanitaet', 'wasser', 'sichern', 'bereitstellung', 'anderes'])
  })
  it('lists the drawn Leitungen and keeps the Trupp\'s own number in the row when no hose carries it', () => {
    const drawn = [{ no: 4, onPlan: false }, { no: 2, onPlan: true, takenBy: 'Meier Anna' }]
    expect(leitungChoices(trupp, drawn).map((o) => o.no)).toEqual([1, 2, 4])
    // …once, when it is drawn
    expect(leitungChoices(trupp, [...drawn, { no: 1, onPlan: false }]).map((o) => o.no)).toEqual([1, 2, 4])
    expect(leitungChoices({ ...trupp, lineNo: undefined }, drawn).map((o) => o.no)).toEqual([2, 4])
  })
})
