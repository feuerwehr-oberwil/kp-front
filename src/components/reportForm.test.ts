import { describe, expect, it } from 'vitest'
import { dirtyFormMeta, formToMeta, numOrU, type ReportForm } from './reportForm'

const EMPTY: ReportForm = {
  summary: '', kontaktperson: '', kontaktTel: '', einsatzleiter: '', endedAt: '', ausgerueckt: '',
  remarks: '', lehren: '', gruppen: [], fahrzeuge: [], geretteteP: '', geretteteT: '', rueckName: '', rueckAt: '',
}
const CLEAN = Object.fromEntries(Object.keys(EMPTY).map((k) => [k, false])) as Record<keyof ReportForm, boolean>
const dirtyOn = (...keys: (keyof ReportForm)[]) => ({ ...CLEAN, ...Object.fromEntries(keys.map((k) => [k, true])) })

describe('numOrU', () => {
  it('a blank, negative or non-number count is «nichts eingetragen»', () => {
    expect(numOrU('')).toBeUndefined()
    expect(numOrU('-1')).toBeUndefined()
    expect(numOrU('abc')).toBeUndefined()
    expect(numOrU(' 3 ')).toBe(3)
  })
})

describe('formToMeta', () => {
  it('trims, and a blank field is absent rather than «»', () => {
    const m = formToMeta({ ...EMPTY, summary: '  Brand gelöscht ', remarks: '   ' })
    expect(m.summary).toBe('Brand gelöscht')
    expect(m.remarks).toBeUndefined()
    expect(m.gerettete).toBeUndefined()
    expect(m.rueckmeldungElz).toBeUndefined()
  })
  it('the header «Ausgerückt» follows the vehicle grid once it holds a time', () => {
    const fahrzeuge = [{ id: 'tlf', ausgerueckt: '2026-10-24T20:07:00.000Z' }] as ReportForm['fahrzeuge']
    expect(formToMeta({ ...EMPTY, fahrzeuge }).ausgeruecktAt).toBe('2026-10-24T20:07:00.000Z')
  })
})

describe('dirtyFormMeta — only what this device changed', () => {
  const remote: ReportForm = { ...EMPTY, summary: 'vom iPad', geretteteP: '2', geretteteT: '1', rueckName: 'Muster', rueckAt: '2026-10-24T23:40:00.000Z' }

  it('writes nothing while nothing was touched — the blob passes through', () => {
    expect(dirtyFormMeta({ ...remote, summary: 'veraltet' }, remote, CLEAN)).toEqual({})
  })

  it('writes the touched field and no other', () => {
    const local = { ...remote, summary: 'veraltet', remarks: 'neu' }
    expect(dirtyFormMeta(local, remote, dirtyOn('remarks'))).toEqual({ remarks: 'neu' })
  })

  it('a touched half of a pair takes the untouched half from the BLOB', () => {
    // this device still shows 5 Personen; the blob already says 2 — only the Tiere moved here
    const local = { ...remote, geretteteP: '5', geretteteT: '3' }
    expect(dirtyFormMeta(local, remote, dirtyOn('geretteteT'))).toEqual({ gerettete: { personen: 2, tiere: 3 } })
    const late = { ...remote, rueckName: 'alt', rueckAt: '2026-10-25T00:10:00.000Z' }
    expect(dirtyFormMeta(late, remote, dirtyOn('rueckAt'))).toEqual({
      rueckmeldungElz: { name: 'Muster', at: '2026-10-25T00:10:00.000Z' },
    })
  })

  it('a vehicle time writes the derived «Ausgerückt» with it', () => {
    const fahrzeuge = [{ id: 'tlf', ausgerueckt: '2026-10-24T20:07:00.000Z' }] as ReportForm['fahrzeuge']
    expect(dirtyFormMeta({ ...remote, fahrzeuge }, remote, dirtyOn('fahrzeuge'))).toEqual({
      ausgeruecktAt: '2026-10-24T20:07:00.000Z', fahrzeuge,
    })
  })

  it('clearing a touched field writes its absence', () => {
    const out = dirtyFormMeta({ ...remote, summary: '' }, remote, dirtyOn('summary'))
    expect(out).toHaveProperty('summary', undefined)
  })
})
