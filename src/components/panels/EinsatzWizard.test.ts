import { describe, expect, it } from 'vitest'
import { changedOnly } from './EinsatzWizard'

const seed = {
  title: 'Gebäudebrand Schulhaus',
  type: null,
  priority: 'LOW',
  address: 'Schulstrasse 4',
  started_at: '2026-08-02T14:41:37.000Z',
  is_exercise: false,
  lng: 7.55, lat: 47.48,
}

describe('changedOnly — only what the operator actually touched reaches the PATCH', () => {
  it('sends nothing when nothing moved', () => {
    expect(changedOnly({ ...seed }, seed)).toEqual({})
  })

  // ⚠️ THE bug this exists for. The Alarmzeit round-trips through a formatter that drops
  // seconds, so an untouched field comes back as 14:41:00 against a stored 14:41:37 — and the
  // backend stamps `started_at_source = "manual"` for any `started_at` it receives. Fixing a
  // typo in the address used to round the alarm AND tell the statistics consumer that a human
  // had asserted the time.
  it('does not call a seconds-only difference a change to the Alarmzeit', () => {
    const out = changedOnly({ ...seed, started_at: '2026-08-02T14:41:00.000Z' }, seed)
    expect(out).not.toHaveProperty('started_at')
  })

  it('does send the Alarmzeit once the minute actually moves', () => {
    const out = changedOnly({ ...seed, started_at: '2026-08-02T14:42:00.000Z' }, seed)
    expect(out).toEqual({ started_at: '2026-08-02T14:42:00.000Z' })
  })

  it('sends only the corrected address, not the eight-field body', () => {
    expect(changedOnly({ ...seed, address: 'Schulstrasse 6' }, seed)).toEqual({ address: 'Schulstrasse 6' })
  })

  // a null type/priority is the backend's to derive — opening the panel must not invent one
  it('leaves an untouched null Kategorie alone', () => {
    expect(changedOnly({ ...seed, type: null }, seed)).toEqual({})
    expect(changedOnly({ ...seed, type: 'Brandbekämpfung' }, seed)).toEqual({ type: 'Brandbekämpfung' })
  })

  // clearing the location has to be an explicit null — an omitted key is never written
  it('passes an explicit null coordinate through', () => {
    expect(changedOnly({ ...seed, lng: null, lat: null }, seed)).toEqual({ lng: null, lat: null })
  })

  // `text` has no seed (it is fetched separately) — present means send, absent means leave alone
  it('sends text when present and never invents it when absent', () => {
    expect(changedOnly({ ...seed, text: 'BMA ausgelöst' }, seed)).toEqual({ text: 'BMA ausgelöst' })
    expect(changedOnly({ ...seed }, seed)).not.toHaveProperty('text')
  })

  it('on create (no seed) sends everything', () => {
    expect(changedOnly({ title: 'x' }, null)).toEqual({ title: 'x' })
  })
})
