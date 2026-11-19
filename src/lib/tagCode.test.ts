import { describe, expect, it } from 'vitest'
import type { Person } from '../types'
import { personIdFromTag, tagHit, tagHitKey, tagPayload, tagsCsv } from './tagCode'

const person = (id: string, extra: Partial<Person> = {}): Person =>
  ({ id, displayName: `P ${id}`, active: true, updatedAt: '2026-11-19T00:00:00Z', ...extra })

const roster = new Map([
  ['a', person('a')],
  ['b', person('b')],
  ['gone', person('gone', { active: false })],
])
const none = new Set<string>()

describe('tag code', () => {
  it('round-trips a person id', () => {
    expect(personIdFromTag(tagPayload('3f2c9a10-7b1e'))).toBe('3f2c9a10-7b1e')
  })

  it('ignores codes that are not ours', () => {
    expect(personIdFromTag('https://example.com')).toBeUndefined()
    expect(personIdFromTag('KPF1:')).toBeUndefined()
    expect(tagHit('WIFI:S:x;;', roster, none, none)).toBeNull()
  })
})

describe('tagHit', () => {
  it('adds a free, active roster person', () => {
    expect(tagHit(tagPayload('a'), roster, none, none)).toEqual({ kind: 'add', person: roster.get('a') })
  })

  it('marks a person in another active Trupp as taken', () => {
    expect(tagHit(tagPayload('a'), roster, new Set(['a']), none)?.kind).toBe('taken')
  })

  it('says nothing new for a person already in this form', () => {
    // in the form AND counted as assigned (an edit of their own Trupp): still just «here»
    expect(tagHit(tagPayload('b'), roster, new Set(['b']), new Set(['b']))?.kind).toBe('here')
  })

  it('treats an inactive or missing roster row as an unknown tag', () => {
    expect(tagHit(tagPayload('gone'), roster, none, none)).toEqual({ kind: 'unknown', id: 'gone' })
    expect(tagHit(tagPayload('zzz'), roster, none, none)).toEqual({ kind: 'unknown', id: 'zzz' })
  })

  it('keys a person and an unknown id apart', () => {
    const hit = tagHit(tagPayload('a'), roster, none, none)
    expect(hit && tagHitKey(hit)).toBe('a')
    expect(tagHitKey({ kind: 'unknown', id: 'a' })).toBe('?a')
  })
})

describe('tagsCsv', () => {
  it('lists the exact QR text per person, quoted, with a BOM for Excel', () => {
    expect(tagsCsv([{ id: 'p1', name: 'Šimunović "Đorđe"', rank: 'Wm' }]))
      .toBe('\uFEFFname,rank,qr\n"Šimunović ""Đorđe""","Wm","KPF1:p1"\n')
  })
})

describe('tagsCsv in a spreadsheet', () => {
  it('keeps a formula-like name from running, the QR text untouched', () => {
    expect(tagsCsv([{ id: 'p1', name: '=HYPERLINK("x")', rank: '-' }]).split('\n')[1])
      .toBe(`"'=HYPERLINK(""x"")","'-","KPF1:p1"`)
  })
})
