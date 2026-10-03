import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as idb from '../lib/idb'
import { __resetIdbForTests } from '../lib/idb'
import { newVisitDoc } from './doc'
import {
  __resetStoreForTests, attKey, createLocalVisit, findOpenDraft, forgetVisit, INDEX_KEY, isVisitDurable, listLocalVisits,
  onVisitChanged, putAttachment, readAttachment, readIndex, readVisit, retryHeld, updateVisit, visitKey,
} from './store'

const OBJ = { id: 'obj-1', name: 'Gemeindeverwaltung' }

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  __resetStoreForTests()
  vi.restoreAllMocks()

})
afterEach(() => { __resetStoreForTests() })

describe('visits on the device', () => {
  it('uses the contract keys: kp-front-ov-<id> and the index', async () => {
    const doc = newVisitDoc({ object: OBJ, checklist: null })
    const r = await createLocalVisit(doc, 'u1')
    expect(r.durable).toBe(true)
    expect(await idb.idbGet(visitKey(doc.id))).toMatchObject({ doc: { id: doc.id }, base: null, dirty: true, sent: null, lastError: null })
    expect(await idb.idbGet(INDEX_KEY)).toEqual([doc.id])
    expect(doc.id).toMatch(/^ov\d+-[0-9a-z]+$/)
  })

  it('creating twice keeps the first record', async () => {
    const doc = newVisitDoc({ object: OBJ, checklist: null })
    await createLocalVisit(doc, 'u1')
    await updateVisit(doc.id, (cur) => (cur ? { ...cur, doc: { ...cur.doc, notes: 'kept' } } : null))
    await createLocalVisit(doc, 'u1')
    const r = await readVisit(doc.id)
    expect(r.ok && r.value?.doc.notes).toBe('kept')
  })

  it('serialises updates of one visit: none is lost', async () => {
    const doc = newVisitDoc({ object: OBJ, checklist: null })
    await createLocalVisit(doc, 'u1')
    await Promise.all(['a', 'b', 'c', 'd'].map((k) =>
      updateVisit(doc.id, (cur) => (cur ? { ...cur, doc: { ...cur.doc, answers: { ...cur.doc.answers, [k]: { v: 'ok' } } } } : null))))
    const r = await readVisit(doc.id)
    expect(Object.keys(r.ok ? r.value!.doc.answers : {}).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a write that does not land is HELD in memory, said, and still read back', async () => {
    const doc = newVisitDoc({ object: OBJ, checklist: null })
    await createLocalVisit(doc, 'u1')
    vi.spyOn(idb, 'idbSet').mockResolvedValue(false)
    const r = await updateVisit(doc.id, (cur) => (cur ? { ...cur, doc: { ...cur.doc, notes: 'only in memory' } } : null))
    expect(r.durable).toBe(false)
    expect(isVisitDurable(doc.id)).toBe(false)
    const back = await readVisit(doc.id)
    expect(back.ok && back.value?.doc.notes).toBe('only in memory')
    vi.restoreAllMocks()
    expect(await retryHeld()).toBeGreaterThan(0)
    expect(isVisitDurable(doc.id)).toBe(true)
    expect(await idb.idbGet(visitKey(doc.id))).toMatchObject({ doc: { notes: 'only in memory' } })
  })

  it('a failed READ refuses the update instead of writing over the slot', async () => {
    const doc = newVisitDoc({ object: OBJ, checklist: null })
    await createLocalVisit(doc, 'u1')
    vi.spyOn(idb, 'idbRead').mockResolvedValueOnce({ ok: false, error: new Error('io') })
    const write = vi.spyOn(idb, 'idbSet')
    const fn = vi.fn((cur) => cur)
    const r = await updateVisit(doc.id, fn)
    expect(r.ok).toBe(false)
    expect(fn).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('an EDIT over a failed read is queued, shown, said, and lands with the next good write', async () => {
    const doc = newVisitDoc({ object: OBJ, checklist: null })
    await createLocalVisit(doc, 'u1')
    vi.spyOn(idb, 'idbRead').mockResolvedValueOnce({ ok: false, error: new Error('io') })
    const r = await updateVisit(doc.id, (cur) => (cur ? { ...cur, doc: { ...cur.doc, notes: 'typed' } } : null), { queueOnFailure: true })
    expect(r.ok).toBe(false)
    expect(isVisitDurable(doc.id)).toBe(false) // never «gespeichert» while it waits
    const shown = await readVisit(doc.id)
    expect(shown.ok && shown.value?.doc.notes).toBe('typed') // and never lost from the page
    expect((await idb.idbGet<{ doc: { notes: string } }>(visitKey(doc.id)))?.doc.notes).toBe('')
    expect(await retryHeld()).toBeGreaterThan(0)
    expect(isVisitDurable(doc.id)).toBe(true)
    expect((await idb.idbGet<{ doc: { notes: string } }>(visitKey(doc.id)))?.doc.notes).toBe('typed')
  })

  it('queued edits replay in order before the next one', async () => {
    const doc = newVisitDoc({ object: OBJ, checklist: null })
    await createLocalVisit(doc, 'u1')
    vi.spyOn(idb, 'idbRead').mockResolvedValueOnce({ ok: false, error: new Error('io') })
    await updateVisit(doc.id, (cur) => (cur ? { ...cur, doc: { ...cur.doc, notes: cur.doc.notes + 'a' } } : null), { queueOnFailure: true })
    await updateVisit(doc.id, (cur) => (cur ? { ...cur, doc: { ...cur.doc, notes: cur.doc.notes + 'b' } } : null), { queueOnFailure: true })
    expect((await idb.idbGet<{ doc: { notes: string } }>(visitKey(doc.id)))?.doc.notes).toBe('ab')
  })

  it('forgets a discarded never-sent visit entirely: record, photos, index entry', async () => {
    const doc = newVisitDoc({ object: OBJ, checklist: null })
    await createLocalVisit(doc, 'u1')
    await putAttachment('ova1', { blob: new Blob(['x']), thumb: null, type: 'image/jpeg', sha256: 's', size: 1, visitId: doc.id })
    await putAttachment('ova9', { blob: new Blob(['y']), thumb: null, type: 'image/jpeg', sha256: 's', size: 1, visitId: 'other' })
    expect(await forgetVisit(doc.id)).toBe(true)
    expect(await idb.idbGet(visitKey(doc.id))).toBeNull()
    expect(await idb.idbGet(attKey('ova1'))).toBeNull()
    expect(await idb.idbGet(attKey('ova9'))).toBeTruthy()
    expect(await idb.idbGet(INDEX_KEY)).toEqual([])
  })

  it('lists every visit through the index, and says when the index could not be read', async () => {
    const a = newVisitDoc({ object: OBJ, checklist: null })
    const b = newVisitDoc({ object: { id: 'obj-2', name: 'Werkhof' }, checklist: null })
    await createLocalVisit(a, 'u1')
    await createLocalVisit(b, 'u1')
    const all = await listLocalVisits()
    expect(all.ok).toBe(true)
    expect(all.visits.map((v) => v.doc.id).sort()).toEqual([a.id, b.id].sort())
    vi.spyOn(idb, 'idbRead').mockResolvedValueOnce({ ok: false, error: new Error('io') })
    const broken = await listLocalVisits()
    expect(broken.ok).toBe(false)
  })

  it('an index that could not be read is not overwritten; the id is added later', async () => {
    const a = newVisitDoc({ object: OBJ, checklist: null })
    await createLocalVisit(a, 'u1')
    const b = newVisitDoc({ object: OBJ, checklist: null })
    const real = idb.idbRead
    vi.spyOn(idb, 'idbRead').mockImplementation(async (key: string) => (key === INDEX_KEY ? { ok: false, error: new Error('io') } : real(key)) as never)
    await createLocalVisit(b, 'u1')
    vi.restoreAllMocks()
    // the stored index still holds the first id; the held one joins on read and on the next write
    expect(await idb.idbGet(INDEX_KEY)).toEqual([a.id])
    const idx = await readIndex()
    expect(idx.ok && idx.value?.sort()).toEqual([a.id, b.id].sort())
    const c = newVisitDoc({ object: OBJ, checklist: null })
    await createLocalVisit(c, 'u1')
    expect((await idb.idbGet<string[]>(INDEX_KEY))?.sort()).toEqual([a.id, b.id, c.id].sort())
  })

  it('tells listeners which visit changed', async () => {
    const seen: string[] = []
    const off = onVisitChanged((id) => seen.push(id))
    const doc = newVisitDoc({ object: OBJ, checklist: null })
    await createLocalVisit(doc, 'u1')
    off()
    expect(seen).toContain(doc.id)
  })
})

describe('findOpenDraft', () => {
  it('resumes this person\'s draft for (object, workRef) — newest first', async () => {
    const mk = async (workRef: string | null, owner: string, lifecycle: 'draft' | 'completed' = 'draft') => {
      const d = { ...newVisitDoc({ object: OBJ, checklist: null, workRef }), lifecycle }
      await createLocalVisit(d, owner)
      return d
    }
    const listDraft = await mk('fu-2027/B4', 'u1')
    await mk(null, 'u1')
    await mk('fu-2027/B4', 'u2')
    await mk('fu-2027/B4', 'u1', 'completed')
    const { visits } = await listLocalVisits()
    expect(findOpenDraft(visits, OBJ.id, 'fu-2027/B4', 'u1')?.doc.id).toBe(listDraft.id)
    expect(findOpenDraft(visits, OBJ.id, 'fu-2027/B5', 'u1')).toBeNull()
    expect(findOpenDraft(visits, 'other', 'fu-2027/B4', 'u1')).toBeNull()
  })
})

describe('attachments', () => {
  const att = () => ({ blob: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }), thumb: null, type: 'image/jpeg', sha256: 'abc', size: 10 })

  it('stores a photo under kp-front-ov-att-<attId>', async () => {
    expect(await putAttachment('ova1', att())).toBe(true)
    const r = await readAttachment('ova1')
    expect(r.ok && r.value?.sha256).toBe('abc')
    expect(await (r.ok && r.value?.blob ? r.value.blob.text() : '')).toBe('jpeg-bytes')
    expect(await idb.idbGet(attKey('ova1'))).toBeTruthy()
  })

  it('never falls back to localStorage (a Blob would become {}): a refused write is held and said', async () => {
    vi.spyOn(idb, 'idbSetStrict').mockResolvedValue(false)
    const set = vi.spyOn(idb, 'idbSet')
    expect(await putAttachment('ova2', att())).toBe(false)
    expect(set).not.toHaveBeenCalled()
    // still readable from this page, and the visit showing it is not durable
    const r = await readAttachment('ova2')
    expect(r.ok && r.value?.sha256).toBe('abc')
    const doc = { ...newVisitDoc({ object: OBJ, checklist: null }), photos: [{ id: 'ova2', caption: '', sha256: 'abc', size: 10, type: 'image/jpeg' }] }
    expect(isVisitDurable(doc.id, doc)).toBe(false)
  })
})
