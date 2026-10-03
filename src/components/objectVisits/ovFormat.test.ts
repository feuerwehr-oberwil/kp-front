import { describe, it, expect } from 'vitest'
import { syncLabel, syncShort } from './ovFormat'
import { appConfig } from '../../config/appConfig'

// The head of a visit is one phone line (owner, 03.10.2026: «Entwur · Gespeichert 1 · Ablage wa»):
// where the glyph says what happened, only the time is left; the sheet keeps the long words.
describe('syncShort', () => {
  const at = '2026-10-03T13:42:00+02:00'
  it('drops the word where the glyph says it', () => {
    expect(syncShort({ kind: 'saved', at } as never)).toBe(syncLabel({ kind: 'saved', at } as never).replace(/^\D+/, ''))
    expect(syncShort({ kind: 'saved', at } as never)).not.toContain('Gespeichert')
    expect(syncShort({ kind: 'local', at } as never)).not.toMatch(/Gerät/)
  })
  it('keeps the word where there is no time to show', () => {
    expect(syncShort({ kind: 'conflict' } as never)).toBe(appConfig.copy.objectVisits.sync.conflict)
    expect(syncShort({ kind: 'local' } as never)).toBe(appConfig.copy.objectVisits.sync.local)
  })
})
