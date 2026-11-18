import { afterEach, describe, expect, it } from 'vitest'
import { answerZielPick, beginZielPick, cancelZielPick, endZielPick, parkedTruppForm, zielPicking } from './zielPick'
import { clearAllDrafts, keepDraft, readDraft } from './draftKeep'

// «Ziel auf der Karte wählen» (owner pick M5a A, 18.11.2026): a pick writes the tapped symbol's
// name into the form's KEPT Ziel and hands the parked form back; «Abbrechen» hands it back untouched.
const KEY = 'atemschutz:trupp:create:new:ziel'
const form = { mode: 'create' as const }
afterEach(() => { endZielPick(); clearAllDrafts() })

describe('zielPick', () => {
  it('a symbol tap fills the kept Ziel with its name and parks the form for the board', () => {
    keepDraft(KEY, 'Keller')
    beginZielPick(KEY, form)
    expect(zielPicking()).toBe(true)
    answerZielPick({ label: 'Vollbrand 2. OG', symbol: 'VKF Feuer' })
    expect(readDraft(KEY, '')).toBe('Vollbrand 2. OG')
    expect(zielPicking()).toBe(false)
    expect(parkedTruppForm()).toBe(form)
    endZielPick()
    expect(parkedTruppForm()).toBeNull()
  })

  it('an unnamed symbol answers with its display name, capped to the field', () => {
    beginZielPick(KEY, form)
    answerZielPick({ symbol: 'VKF Feuer' })
    expect(readDraft(KEY, '')).toBe('Feuer')
    beginZielPick(KEY, form)
    answerZielPick({ label: 'x'.repeat(80) })
    expect(readDraft(KEY, '')).toHaveLength(60)
  })

  it('«Abbrechen» brings the form back with its Ziel as it was', () => {
    keepDraft(KEY, 'Keller')
    beginZielPick(KEY, form)
    cancelZielPick()
    expect(readDraft(KEY, '')).toBe('Keller')
    expect(parkedTruppForm()).toBe(form)
  })

  it('a tap after the pick ended writes nothing', () => {
    beginZielPick(KEY, form)
    endZielPick()
    answerZielPick({ label: 'Rauch' })
    expect(readDraft(KEY, '')).toBe('')
  })
})
