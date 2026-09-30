import { describe, expect, it, vi } from 'vitest'
import { KANAL_PAD_MAX, auftragSheetFields, crewFields, fileGuestSlots, kanalPad, kanalSheetFields, leitungChoices, quickAuftragTypes, teamConflict, truppSheetFields } from './truppQuickEdit'
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
  it('lists the drawn Leitungen and keeps the field\'s own number in the row when no hose carries it', () => {
    const drawn = [{ no: 4, onPlan: false }, { no: 2, onPlan: true, takenBy: 'Meier Anna' }]
    expect(leitungChoices(trupp.lineNo, drawn).map((o) => o.no)).toEqual([1, 2, 4])
    // …once, when it is drawn
    expect(leitungChoices(trupp.lineNo, [...drawn, { no: 1, onPlan: false }]).map((o) => o.no)).toEqual([1, 2, 4])
    expect(leitungChoices(undefined, drawn).map((o) => o.no)).toEqual([2, 4])
  })
})

/* ── the crew, shared by the form and the Trupp sheet (④) ─────────────────────────────────── */
describe('the crew helpers the form and the Trupp sheet share', () => {
  const team = [{ name: 'Hirter Stephan', personId: 'p1' }, { name: 'Bendik Dimitri', personId: 'p2' }, { name: 'Gast Gabi' }, { name: '  ' }]

  it('names the first person who is already in another active Trupp, with what may be done about it', () => {
    expect(teamConflict(team, new Set(['p9']), undefined, 'Diese Person')).toBeNull()
    expect(teamConflict(team, new Set(['p2']), () => 'ready', 'Diese Person')).toEqual({ personId: 'p2', name: 'Bendik Dimitri', state: 'ready' })
    // no transfer door ⇒ the plain sentence; an unnamed slot ⇒ the fallback name
    expect(teamConflict([{ name: '', personId: 'p2' }], new Set(['p2']), undefined, 'Diese Person')).toEqual({ personId: 'p2', name: 'Diese Person', state: 'blocked' })
  })

  it('files the typed Gäste at the save and hands their ids back — linked people untouched', () => {
    const onAddGuest = vi.fn((name: string) => `g:${name}`)
    expect(fileGuestSlots(team, onAddGuest)).toEqual({ leaderPersonId: 'p1', memberPersonIds: ['p2', 'g:Gast Gabi'] })
    expect(onAddGuest).toHaveBeenCalledTimes(1)
    expect(onAddGuest).toHaveBeenCalledWith('Gast Gabi')
    // without a door nothing is filed and the Gast stays a bare name
    expect(fileGuestSlots(team)).toEqual({ leaderPersonId: 'p1', memberPersonIds: ['p2'] })
  })

  it('writes the crew in the record\'s shape — leader name + member names, empty slots dropped', () => {
    expect(crewFields(team)).toEqual({ name: 'Hirter Stephan', members: ['Bendik Dimitri', 'Gast Gabi'], leaderPersonId: 'p1', memberPersonIds: ['p2'] })
    expect(crewFields([{ name: 'Solo Sam' }])).toEqual({ name: 'Solo Sam', members: undefined, leaderPersonId: undefined, memberPersonIds: undefined })
  })

  it('the Trupp sheet\'s save replaces crew and Ausrüstung only, ids in the station\'s order, none when none', () => {
    const own = ['retthaube', 'wbk', 'multiwarn']
    const f = truppSheetFields(trupp, [{ name: 'Hirter Stephan', personId: 'p1' }], ['multiwarn', 'retthaube'], own)
    expect(f).toMatchObject({ name: 'Hirter Stephan', members: undefined, equipment: ['retthaube', 'multiwarn'], auftrag: 'loeschen', ziel: 'Test', lineNo: 1, funkkanal: 11, pressure: 280 })
    expect(truppSheetFields(trupp, [{ name: 'Hirter Stephan', personId: 'p1' }], [], own).equipment).toBeUndefined()
    // …and nothing changed writes nothing (editTrupp's rule)
    expect(truppEditChanges(trupp, truppSheetFields(trupp, [{ name: 'Hirter Stephan', personId: 'p1' }, { name: 'Bendik Dimitri', personId: 'p2' }], ['retthaube'], own))).toEqual([])
  })
})
