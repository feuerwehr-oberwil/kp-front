import { describe, expect, it } from 'vitest'
import { conflictIsMine, isTextConflict, mergeVisit, pick3, resolveConflict } from './merge'
import { VISIT_SCHEMA, type VisitDoc, type VisitPhoto, type VisitProposal } from './types'

const base = (over: Partial<VisitDoc> = {}): VisitDoc => ({
  schema: VISIT_SCHEMA,
  id: 'ov1759473240123-0kf9',
  object: { id: 'obj-1', name: 'Gemeindeverwaltung', address: 'Hauptstrasse 24' },
  visitedAt: '2026-10-03T08:14:00+02:00',
  lifecycle: 'draft',
  checklist: null,
  answers: {},
  notes: '',
  photos: [],
  proposals: [],
  ...over,
})

const photo = (id: string, over: Partial<VisitPhoto> = {}): VisitPhoto => ({ id, caption: '', sha256: `h-${id}`, size: 10, type: 'image/jpeg', ...over })
const prop = (id: string, over: Partial<VisitProposal> = {}): VisitProposal => ({ id, field: 'owner_contact', label: 'Kontakt', proposed: 'X', ...over })
const NOW = '2026-10-03T09:00:00.000Z'

describe('pick3', () => {
  it('takes the side that changed, keeps equal sides, flags both-changed', () => {
    expect(pick3('a', 'a', 'b')).toEqual({ value: 'b', conflict: false })
    expect(pick3('a', 'b', 'a')).toEqual({ value: 'b', conflict: false })
    expect(pick3('a', 'b', 'b')).toEqual({ value: 'b', conflict: false })
    expect(pick3('a', 'b', 'c')).toEqual({ value: 'c', conflict: true })
    expect(pick3(undefined, 'x', undefined)).toEqual({ value: 'x', conflict: false })
  })
  it('compares JSON regardless of key order (the server re-sorts JSONB keys)', () => {
    expect(pick3({ v: 'defect', note: 'n' }, { note: 'n', v: 'defect' }, { v: 'ok' })).toEqual({ value: { v: 'ok' }, conflict: false })
  })
})

describe('mergeVisit', () => {
  it('merges disjoint answers from both sides without a conflict', () => {
    const b = base({ answers: { a: { v: 'ok' } } })
    const local = base({ answers: { a: { v: 'ok' }, b: { v: 'defect', note: 'klemmt' } } })
    const server = base({ answers: { a: { v: 'ok' }, c: { v: 'yes' } } })
    const r = mergeVisit(b, local, server, { now: NOW })
    expect(r.conflicts).toEqual([])
    expect(r.doc.answers).toEqual({ a: { v: 'ok' }, b: { v: 'defect', note: 'klemmt' }, c: { v: 'yes' } })
    expect(r.doc.conflicts).toBeUndefined()
  })

  it('a removed answer stays removed when the other side did not touch it', () => {
    const b = base({ answers: { a: { v: 'ok' } } })
    const r = mergeVisit(b, base({ answers: {} }), b, { now: NOW })
    expect(r.doc.answers).toEqual({})
    expect(r.conflicts).toEqual([])
  })

  it('the same answer changed on both sides keeps the SERVER value and records mine', () => {
    const b = base({ answers: { a: { v: 'ok' } } })
    const r = mergeVisit(b, base({ answers: { a: { v: 'defect' } } }), base({ answers: { a: { v: 'na' } } }), { now: NOW })
    expect(r.doc.answers.a).toEqual({ v: 'na' })
    expect(r.conflicts).toEqual([{ id: 'ovc-answers.a', key: 'answers.a', mine: { v: 'defect' }, theirs: { v: 'na' }, at: NOW }])
    expect(r.doc.conflicts).toHaveLength(1)
  })

  it('notes edited on both sides → server text in the document, mine in conflicts', () => {
    const b = base({ notes: 'Hauswart' })
    const r = mergeVisit(b, base({ notes: 'Hauswart neu: Herr Keller.' }), base({ notes: 'Hauswart neu: Hr. Keller, Schlüssel bei ihm.' }), { now: NOW })
    expect(r.doc.notes).toBe('Hauswart neu: Hr. Keller, Schlüssel bei ihm.')
    expect(r.conflicts[0]).toMatchObject({ key: 'notes', mine: 'Hauswart neu: Herr Keller.' })
  })

  it('notes edited on one side only are taken silently', () => {
    const b = base({ notes: 'a' })
    expect(mergeVisit(b, base({ notes: 'a' }), base({ notes: 'b' })).doc.notes).toBe('b')
    expect(mergeVisit(b, base({ notes: 'c' }), base({ notes: 'a' })).doc.notes).toBe('c')
  })

  it('visitedAt and with merge like scalars', () => {
    const b = base({ with: ['A'] })
    const r = mergeVisit(b, base({ with: ['A', 'B'] }), base({ visitedAt: '2026-10-02T10:00:00+02:00', with: ['A'] }), { now: NOW })
    expect(r.doc.with).toEqual(['A', 'B'])
    expect(r.doc.visitedAt).toBe('2026-10-02T10:00:00+02:00')
    expect(r.conflicts).toEqual([])
  })

  it('photos: a union by id, server order first then what only this device added', () => {
    const b = base({ photos: [photo('p1')] })
    const r = mergeVisit(b, base({ photos: [photo('p1'), photo('p3')] }), base({ photos: [photo('p1'), photo('p2')] }), { now: NOW })
    expect(r.doc.photos.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
    expect(r.conflicts).toEqual([])
  })

  it('photos: a caption edited here and a link edited there both survive (per field)', () => {
    const b = base({ photos: [photo('p1', { caption: 'x' })] })
    const r = mergeVisit(b, base({ photos: [photo('p1', { caption: 'Deckel klemmt' })] }), base({ photos: [photo('p1', { caption: 'x', item: 'oeffnen' })] }), { now: NOW })
    expect(r.doc.photos[0]).toMatchObject({ caption: 'Deckel klemmt', item: 'oeffnen' })
    expect(r.conflicts).toEqual([])
  })

  it('photos: the same caption edited on both sides is a caption conflict', () => {
    const b = base({ photos: [photo('p1', { caption: 'x' })] })
    const r = mergeVisit(b, base({ photos: [photo('p1', { caption: 'mine' })] }), base({ photos: [photo('p1', { caption: 'theirs' })] }), { now: NOW })
    expect(r.doc.photos[0].caption).toBe('theirs')
    expect(r.conflicts[0]).toMatchObject({ key: 'photos.p1.caption', mine: 'mine', theirs: 'theirs' })
  })

  it('photos: removed there and untouched here goes; removed there and edited here stays with a conflict', () => {
    const b = base({ photos: [photo('p1'), photo('p2')] })
    const local = base({ photos: [photo('p1'), photo('p2', { caption: 'edited' })] })
    const server = base({ photos: [] })
    const r = mergeVisit(b, local, server, { now: NOW })
    expect(r.doc.photos.map((p) => p.id)).toEqual(['p2'])
    expect(r.conflicts).toEqual([expect.objectContaining({ key: 'photos.p2', theirs: null })])
  })

  it('photos: removed here and edited there stays (the edit is the newer fact) with a conflict', () => {
    const b = base({ photos: [photo('p1')] })
    const r = mergeVisit(b, base({ photos: [] }), base({ photos: [photo('p1', { caption: 'neu' })] }), { now: NOW })
    expect(r.doc.photos).toHaveLength(1)
    expect(r.conflicts[0]).toMatchObject({ key: 'photos.p1', mine: null })
  })

  it('proposals merge by id as whole records', () => {
    const b = base({ proposals: [prop('a')] })
    const r = mergeVisit(b, base({ proposals: [prop('a', { proposed: 'mine' }), prop('b')] }), base({ proposals: [prop('a'), prop('c')] }), { now: NOW })
    expect(r.doc.proposals.map((p) => [p.id, p.proposed])).toEqual([['a', 'mine'], ['c', 'X'], ['b', 'X']])
    expect(r.conflicts).toEqual([])
  })

  it('a proposal edited on both sides keeps the server one and records mine', () => {
    const b = base({ proposals: [prop('a')] })
    const r = mergeVisit(b, base({ proposals: [prop('a', { proposed: 'mine' })] }), base({ proposals: [prop('a', { proposed: 'theirs' })] }), { now: NOW })
    expect(r.doc.proposals[0].proposed).toBe('theirs')
    expect(r.conflicts[0]).toMatchObject({ key: 'proposals.a' })
  })

  it('lifecycle only moves forward: discarded > completed > draft, never a conflict', () => {
    const b = base()
    expect(mergeVisit(b, base({ lifecycle: 'completed' }), base()).doc.lifecycle).toBe('completed')
    expect(mergeVisit(b, base(), base({ lifecycle: 'completed' })).doc.lifecycle).toBe('completed')
    expect(mergeVisit(b, base({ lifecycle: 'completed' }), base({ lifecycle: 'discarded' })).doc.lifecycle).toBe('discarded')
    expect(mergeVisit(b, base({ lifecycle: 'discarded' }), base({ lifecycle: 'completed' })).conflicts).toEqual([])
  })

  it('without a base (our lost create), this device wins key by key', () => {
    const server = base({ notes: 'first write' })
    const local = base({ notes: 'first write, then more', answers: { a: { v: 'ok' } } })
    const r = mergeVisit(null, local, server, { now: NOW })
    expect(r.doc.notes).toBe('first write, then more')
    expect(r.doc.answers).toEqual({ a: { v: 'ok' } })
    expect(r.conflicts).toEqual([])
  })

  it('keeps conflicts already recorded on either side, and a new one on the same key replaces the old', () => {
    const old = { id: 'ovc-notes', key: 'notes', mine: 'old', theirs: 'older', at: 'x' }
    const other = { id: 'ovc-answers.z', key: 'answers.z', mine: null, theirs: { v: 'ok' }, at: 'x' }
    const b = base({ notes: 'a' })
    const r = mergeVisit(b, base({ notes: 'b', conflicts: [old] }), base({ notes: 'c', conflicts: [other] }), { now: NOW })
    expect(r.doc.conflicts?.map((c) => c.id).sort()).toEqual(['ovc-answers.z', 'ovc-notes'])
    expect(r.doc.conflicts?.find((c) => c.id === 'ovc-notes')).toMatchObject({ mine: 'b', theirs: 'c', at: NOW })
  })

  it('a card resolved on one side stays resolved — the next 409 does not bring it back', () => {
    const card = { id: 'ovc-notes', key: 'notes', mine: 'm', theirs: 't', at: 'x' }
    const b = base({ notes: 't', conflicts: [card] })
    // this device resolved it (took «Andere»); the server still has the card untouched
    const r = mergeVisit(b, base({ notes: 't', answers: { a: { v: 'ok' } } }), base({ notes: 't', conflicts: [card], answers: { z: { v: 'na' } } }), { now: NOW })
    expect(r.doc.conflicts).toBeUndefined()
    // …and resolved on the server, untouched here
    expect(mergeVisit(b, base({ notes: 't', conflicts: [card] }), base({ notes: 't' }), { now: NOW }).doc.conflicts).toBeUndefined()
  })

  it('a card records who and which device met the collision', () => {
    const b = base({ notes: 'a' })
    const r = mergeVisit(b, base({ notes: 'b' }), base({ notes: 'c' }), { now: NOW, by: 'anna', device: 'dev1' })
    expect(r.conflicts[0]).toMatchObject({ by: 'anna', device: 'dev1' })
  })

  it('a card is «Meine» only for the device and account that met it', () => {
    const c = { id: 'x', key: 'notes', mine: 'm', theirs: 't', at: 'x', by: 'anna', device: 'dev1' }
    expect(conflictIsMine(c, 'anna', 'dev1')).toBe(true)
    expect(conflictIsMine(c, 'anna', 'dev2')).toBe(false)
    expect(conflictIsMine(c, 'beat', 'dev1')).toBe(false)
    expect(conflictIsMine({ ...c, by: undefined, device: undefined }, 'beat', 'dev2')).toBe(true)
  })

  it('is deterministic: the same three documents give the same result', () => {
    const b = base({ notes: 'a', answers: { x: { v: 'ok' } } })
    const l = base({ notes: 'b', answers: { x: { v: 'na' } } })
    const s = base({ notes: 'c', answers: { x: { v: 'defect' } } })
    expect(mergeVisit(b, l, s, { now: NOW })).toEqual(mergeVisit(b, l, s, { now: NOW }))
  })
})

describe('resolveConflict', () => {
  const conflicted = () => {
    const b = base({ notes: 'Hauswart', answers: { a: { v: 'ok' }, t: { v: 'alt' } }, photos: [photo('p1', { caption: 'x' })] })
    return mergeVisit(
      b,
      base({ notes: 'mine', answers: { a: { v: 'defect' }, t: { v: 'meins' } }, photos: [photo('p1', { caption: 'meine' })] }),
      base({ notes: 'theirs', answers: { a: { v: 'na' }, t: { v: 'deins' } }, photos: [photo('p1', { caption: 'deine' })] }),
      { now: NOW },
    ).doc
  }

  it('«Andere» keeps the document and drops the card', () => {
    const d = resolveConflict(conflicted(), 'ovc-notes', 'theirs')
    expect(d.notes).toBe('theirs')
    expect(d.conflicts?.some((c) => c.key === 'notes')).toBe(false)
  })

  it('«Meine» writes this device\'s value back', () => {
    expect(resolveConflict(conflicted(), 'ovc-notes', 'mine').notes).toBe('mine')
    expect(resolveConflict(conflicted(), 'ovc-answers.a', 'mine').answers.a).toEqual({ v: 'defect' })
    expect(resolveConflict(conflicted(), 'ovc-photos.p1.caption', 'mine').photos[0].caption).toBe('meine')
  })

  it('«Beide behalten» joins two texts, theirs first', () => {
    expect(resolveConflict(conflicted(), 'ovc-notes', 'both').notes).toBe('theirs\n\nmine')
    expect(resolveConflict(conflicted(), 'ovc-answers.t', 'both').answers.t).toEqual({ v: 'deins\n\nmeins' })
  })

  it('only free text offers «Beide behalten»', () => {
    const cs = conflicted().conflicts ?? []
    expect(isTextConflict(cs.find((c) => c.key === 'notes')!)).toBe(true)
    expect(isTextConflict(cs.find((c) => c.key === 'answers.a')!)).toBe(false)
    expect(isTextConflict(cs.find((c) => c.key === 'answers.t')!)).toBe(true)
  })

  it('the last resolved card removes the conflicts key altogether', () => {
    let d = conflicted()
    for (const c of d.conflicts ?? []) d = resolveConflict(d, c.id, 'theirs')
    expect(d.conflicts).toBeUndefined()
  })

  it('«Meine» on a photo removed there puts it back; on a removal here takes it out', () => {
    const b = base({ photos: [photo('p1')] })
    const keptByMe = mergeVisit(b, base({ photos: [photo('p1', { caption: 'e' })] }), base({ photos: [] }), { now: NOW }).doc
    expect(resolveConflict(keptByMe, 'ovc-photos.p1', 'mine').photos.map((p) => p.id)).toEqual(['p1'])
    const removedByMe = mergeVisit(b, base({ photos: [] }), base({ photos: [photo('p1', { caption: 'e' })] }), { now: NOW }).doc
    expect(resolveConflict(removedByMe, 'ovc-photos.p1', 'mine').photos).toEqual([])
  })
})
