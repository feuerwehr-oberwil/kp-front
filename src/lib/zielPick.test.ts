import { afterEach, describe, expect, it } from 'vitest'
import { answerZielPick, beginZielPick, cancelZielPick, endZielPick, parkedAuftragSheet, parkedTruppForm, zielPicking } from './zielPick'
import { clearAllDrafts, keepDraft, readDraft } from './draftKeep'

// «Ziel auf der Karte wählen» (owner pick M5a A, 18.11.2026): a pick writes the tapped symbol's
// name into the form's KEPT Ziel (or into the Auftrag sheet's parked fields) and hands the asker back;
// «Abbrechen» hands it back untouched.
const KEY = 'atemschutz:trupp:create:new:ziel'
const form = { mode: 'create' as const }
const asForm = { kind: 'form' as const, form, field: KEY }
afterEach(() => { endZielPick(); clearAllDrafts() })

describe('zielPick', () => {
  it('a symbol tap fills the kept Ziel with its name and parks the form for the board', () => {
    keepDraft(KEY, 'Keller')
    beginZielPick(asForm)
    expect(zielPicking()).toBe(true)
    answerZielPick({ label: 'Vollbrand 2. OG', symbol: 'VKF Feuer' })
    expect(readDraft(KEY, '')).toBe('Vollbrand 2. OG')
    expect(zielPicking()).toBe(false)
    expect(parkedTruppForm()).toBe(form)
    endZielPick()
    expect(parkedTruppForm()).toBeNull()
  })

  it('an unnamed symbol answers with its display name, capped to the field', () => {
    beginZielPick(asForm)
    answerZielPick({ symbol: 'VKF Feuer' })
    expect(readDraft(KEY, '')).toBe('Feuer')
    beginZielPick(asForm)
    answerZielPick({ label: 'x'.repeat(80) })
    expect(readDraft(KEY, '')).toHaveLength(60)
  })

  it('«Abbrechen» brings the form back with its Ziel as it was', () => {
    keepDraft(KEY, 'Keller')
    beginZielPick(asForm)
    cancelZielPick()
    expect(readDraft(KEY, '')).toBe('Keller')
    expect(parkedTruppForm()).toBe(form)
  })

  it('a tap after the pick ended writes nothing', () => {
    beginZielPick(asForm)
    endZielPick()
    answerZielPick({ label: 'Rauch' })
    expect(readDraft(KEY, '')).toBe('')
  })

  it('the Auftrag sheet gets its fields back as typed, with the name in the Ziel', () => {
    const sheet = { truppId: 'tr1', auftrag: 'retten' as const, ziel: 'Keller', lineNo: null }
    beginZielPick({ kind: 'auftrag', sheet })
    expect(parkedTruppForm()).toBeNull()
    answerZielPick({ label: 'Vollbrand 2. OG' })
    expect(parkedAuftragSheet()).toEqual({ ...sheet, ziel: 'Vollbrand 2. OG' })
    // nothing went through draftKeep: the sheet keeps no drafts of its own
    expect(readDraft(KEY, '')).toBe('')
    endZielPick()
    expect(parkedAuftragSheet()).toBeNull()
  })
})
