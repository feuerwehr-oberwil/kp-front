import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noteAnswered, noteUnreached } from '../lib/connectivity'
import { ApiError } from '../lib/api'
import { __resetIdbForTests } from '../lib/idb'
import { newVisitDoc } from './doc'
import {
  __resetOutboxForTests, adoptServerVisit, flushAll, flushVisit, hasWork, pendingUploads, releaseSettled,
  requestSave, startOutboxRunner, type OutboxDeps,
} from './outbox'
import type { PutResult } from './api'
import {
  __resetStoreForTests, createLocalVisit, deviceId, putAttachment, readAttachment, readVisit, updateVisit, type LocalVisit,
} from './store'
import type { ServerVisit, VisitDoc } from './types'

// ─── a small in-memory server with the contract's PUT semantics ────────────────────────────

class FakeServer {
  visits = new Map<string, { revision: number; doc: VisitDoc; ready: boolean }>()
  ops = new Map<string, PutResult>()
  atts = new Map<string, string>()
  calls: string[] = []
  /** throw a network error AFTER storing (the lost answer) */
  loseNextAnswer = false
  failWith: ApiError | null = null
  /** answer every PUT with a conflict this many times (another device keeps saving) */
  contend = 0
  attFail: Map<string, ApiError> = new Map()

  missing(doc: VisitDoc) { return doc.photos.map((p) => p.id).filter((id) => !this.atts.has(`${doc.id}/${id}`)) }
  read(id: string): ServerVisit {
    const v = this.visits.get(id)!
    const missing = this.missing(v.doc)
    return { ...v.doc, revision: v.revision, ready: missing.length === 0, missing, deliveries: [] }
  }

  deps(): OutboxDeps {
    return {
      put: async (id, body) => {
        this.calls.push(`put:${body.opId}:${body.baseRevision}`)
        if (this.failWith) { const e = this.failWith; this.failWith = null; throw e }
        if (this.contend > 0 && this.visits.has(id)) {
          this.contend--
          const cur = this.visits.get(id)!
          this.visits.set(id, { ...cur, revision: cur.revision + 1 })
          return { kind: 'conflict', revision: cur.revision + 1, visit: this.read(id) }
        }
        const replay = this.ops.get(body.opId)
        if (replay) return replay
        const cur = this.visits.get(id)
        if (cur && body.baseRevision !== cur.revision) {
          return { kind: 'conflict', revision: cur.revision, visit: this.read(id) }
        }
        if (!cur && body.baseRevision !== null) throw new ApiError(422, 'unknown')
        const revision = (cur?.revision ?? 0) + 1
        this.visits.set(id, { revision, doc: body.doc, ready: false })
        const visit = this.read(id)
        const answer: PutResult = { kind: 'accepted', answer: { revision, ready: visit.ready, missing: visit.missing, visit } }
        this.ops.set(body.opId, answer)
        if (this.loseNextAnswer) { this.loseNextAnswer = false; throw new ApiError(0, 'lost') }
        return answer
      },
      get: async (id) => {
        this.calls.push(`get:${id}`)
        if (!this.visits.has(id)) throw new ApiError(404, 'nicht gefunden')
        return this.read(id)
      },
      putAtt: async (visitId, attId, _blob, _type, sha256) => {
        this.calls.push(`att:${attId}`)
        const f = this.attFail.get(attId)
        if (f) throw f
        if (!this.visits.has(visitId)) throw new ApiError(404, 'no visit')
        this.atts.set(`${visitId}/${attId}`, sha256)
        return { id: attId, sha256, size: 1 }
      },
    }
  }
}

const OBJ = { id: 'obj-1', name: 'Gemeindeverwaltung' }

async function newDraft(owner = 'u1'): Promise<VisitDoc> {
  const doc = newVisitDoc({ object: OBJ, checklist: null })
  await createLocalVisit(doc, owner)
  return doc
}
const edit = (id: string, fn: (d: VisitDoc) => VisitDoc) =>
  updateVisit(id, (cur) => (cur ? { ...cur, doc: fn(cur.doc), dirty: true } : null))
const rec = async (id: string): Promise<LocalVisit> => {
  const r = await readVisit(id)
  if (!r.ok || !r.value) throw new Error('no record')
  return r.value
}
async function addPhoto(visitId: string, attId: string, thumb: Blob | null = new Blob(['t'])) {
  await putAttachment(attId, { blob: new Blob(['jpeg']), thumb, type: 'image/jpeg', sha256: `sha-${attId}`, size: 4, visitId })
  await edit(visitId, (d) => ({ ...d, photos: [...d.photos, { id: attId, caption: '', sha256: `sha-${attId}`, size: 4, type: 'image/jpeg' }] }))
}

let server: FakeServer
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
  __resetStoreForTests()
  __resetOutboxForTests()
  server = new FakeServer()
})
afterEach(() => { __resetStoreForTests() })

describe('save points', () => {
  it('nothing is sent until a save point asks for it', async () => {
    const doc = await newDraft()
    await edit(doc.id, (d) => ({ ...d, notes: 'x' }))
    expect(await flushVisit(doc.id, server.deps())).toBe('nothing')
    expect(server.calls).toEqual([])
  })

  it('a save point creates the visit (baseRevision null) and records the accepted revision', async () => {
    const doc = await newDraft()
    expect(await requestSave(doc.id, server.deps())).toBe('done')
    const r = await rec(doc.id)
    expect(server.calls[0]).toMatch(/^put:ovo\d+-[0-9a-z]+:null$/)
    expect(r.base?.revision).toBe(1)
    expect(r.dirty).toBe(false)
    expect(r.wantSave).toBe(false)
    expect(r.op).toBeNull()
    expect(r.sent).toEqual({ revision: 1, ready: true, missing: [] })
    expect(hasWork(r)).toBe(false)
  })

  it('persists the op BEFORE the request leaves', async () => {
    const doc = await newDraft()
    let seenOp: unknown = 'unset'
    const deps = server.deps()
    const put = deps.put
    deps.put = async (id, body) => { seenOp = (await rec(id)).op; return put(id, body) }
    await requestSave(doc.id, deps)
    expect(seenOp).toMatchObject({ baseRevision: null })
    expect((seenOp as { opId: string }).opId).toMatch(/^ovo/)
  })

  it('a lost answer is retried with the SAME opId — one revision, not a conflict with ourselves', async () => {
    const doc = await newDraft()
    server.loseNextAnswer = true
    expect(await requestSave(doc.id, server.deps())).toBe('offline')
    const after = await rec(doc.id)
    expect(after.op).toBeTruthy()
    expect(after.lastError?.kind).toBe('offline')
    // the member keeps typing while the answer is lost, then leaves the visit (a save point)
    await edit(doc.id, (d) => ({ ...d, notes: 'more' }))
    expect(await requestSave(doc.id, server.deps())).toBe('done')
    const opId = after.op!.opId
    expect(server.calls.filter((c) => c.startsWith(`put:${opId}`))).toHaveLength(2) // replayed
    const r = await rec(doc.id)
    expect(r.base?.revision).toBe(2) // the replay (r1), then the newer edits as r2
    expect(server.visits.get(doc.id)?.doc.notes).toBe('more')
    expect(r.dirty).toBe(false)
    expect(r.doc.conflicts).toBeUndefined()
  })

  it('edits made while a revision is in flight stay dirty and wait for the next save point', async () => {
    const doc = await newDraft()
    const deps = server.deps()
    const put = deps.put
    let once = true
    deps.put = async (id, body) => {
      if (once) { once = false; await edit(id, (d) => ({ ...d, notes: 'typed during flight' })) }
      return put(id, body)
    }
    await requestSave(doc.id, deps)
    let r = await rec(doc.id)
    expect(r.base?.revision).toBe(1)
    expect(r.dirty).toBe(true)
    expect(hasWork(r)).toBe(false) // the reconnect does not send what no save point asked for
    await requestSave(doc.id, deps)
    r = await rec(doc.id)
    expect(r.base?.revision).toBe(2)
    expect(server.visits.get(doc.id)?.doc.notes).toBe('typed during flight')
  })

  it('a never-sent draft that was discarded owes nothing', async () => {
    const doc = await newDraft()
    await edit(doc.id, (d) => ({ ...d, lifecycle: 'discarded' }))
    expect(await requestSave(doc.id, server.deps())).toBe('nothing')
    expect(server.calls).toEqual([])
  })
})

describe('photos', () => {
  it('the document goes first, then every missing photo; then the revision is ready', async () => {
    const doc = await newDraft()
    await addPhoto(doc.id, 'ova1')
    await addPhoto(doc.id, 'ova2')
    expect(await requestSave(doc.id, server.deps())).toBe('done')
    expect(server.calls.map((c) => c.split(':')[0])).toEqual(['put', 'att', 'att', 'get']) // the fresh read before any release
    const r = await rec(doc.id)
    expect(r.sent).toEqual({ revision: 1, ready: true, missing: [] })
    expect(r.uploaded?.sort()).toEqual(['ova1', 'ova2'])
    expect(pendingUploads(r)).toEqual([])
  })

  it('a photo added after the visit exists uploads without a new revision', async () => {
    const doc = await newDraft()
    await requestSave(doc.id, server.deps())
    await addPhoto(doc.id, 'ova9')
    expect(await flushVisit(doc.id, server.deps())).toBe('done')
    expect(server.calls.filter((c) => c.startsWith('put:'))).toHaveLength(1)
    expect(server.atts.has(`${doc.id}/ova9`)).toBe(true)
  })

  it('photos wait until the visit exists on the server', async () => {
    const doc = await newDraft()
    await addPhoto(doc.id, 'ova1')
    expect(await flushVisit(doc.id, server.deps())).toBe('nothing')
    expect(server.calls).toEqual([])
  })

  it('a refused photo is said and the others still go', async () => {
    const doc = await newDraft()
    await addPhoto(doc.id, 'ova1')
    await addPhoto(doc.id, 'ova2')
    server.attFail.set('ova1', new ApiError(409, 'anderer Hash'))
    expect(await requestSave(doc.id, server.deps())).toBe('refused')
    const r = await rec(doc.id)
    expect(r.lastError?.kind).toBe('attachment')
    expect(server.atts.has(`${doc.id}/ova2`)).toBe(true)
    expect(r.sent?.missing).toEqual(['ova1'])
    expect(r.sent?.ready).toBe(false)
  })

  it('offline in the middle of the photos stops and keeps the rest pending', async () => {
    const doc = await newDraft()
    await addPhoto(doc.id, 'ova1')
    server.attFail.set('ova1', new ApiError(0, 'offline'))
    expect(await requestSave(doc.id, server.deps())).toBe('offline')
    expect(pendingUploads(await rec(doc.id))).toEqual(['ova1'])
  })
})

describe('conflicts (409)', () => {
  it('disjoint changes merge silently and are resent on the server revision', async () => {
    const doc = await newDraft()
    await requestSave(doc.id, server.deps())
    // another device writes revision 2
    const other = server.visits.get(doc.id)!
    server.visits.set(doc.id, { revision: 2, doc: { ...other.doc, answers: { b: { v: 'yes' } } }, ready: true })
    await edit(doc.id, (d) => ({ ...d, answers: { a: { v: 'ok' } } }))
    expect(await requestSave(doc.id, server.deps())).toBe('done')
    const stored = server.visits.get(doc.id)!
    expect(stored.revision).toBe(3)
    expect(stored.doc.answers).toEqual({ a: { v: 'ok' }, b: { v: 'yes' } })
    const r = await rec(doc.id)
    expect(r.doc.conflicts).toBeUndefined()
    expect(r.base?.revision).toBe(3)
    expect(server.calls.filter((c) => c.startsWith('put:')).pop()).toMatch(/:2$/)
  })

  it('the same key on both sides keeps the server value and carries mine in conflicts[]', async () => {
    const doc = await newDraft()
    await requestSave(doc.id, server.deps())
    const other = server.visits.get(doc.id)!
    server.visits.set(doc.id, { revision: 2, doc: { ...other.doc, notes: 'theirs' }, ready: true })
    await edit(doc.id, (d) => ({ ...d, notes: 'mine' }))
    await requestSave(doc.id, server.deps())
    const r = await rec(doc.id)
    expect(r.doc.notes).toBe('theirs')
    expect(r.doc.conflicts?.[0]).toMatchObject({ key: 'notes', mine: 'mine', theirs: 'theirs' })
    // the conflict card travels with the document (stored opaquely by the server)
    expect(server.visits.get(doc.id)?.doc.conflicts?.[0].key).toBe('notes')
  })
})

describe('refusals', () => {
  it('401: «Anmeldung nötig», the work and the op stay for after the login', async () => {
    const doc = await newDraft()
    server.failWith = new ApiError(401, 'abgelaufen')
    expect(await requestSave(doc.id, server.deps())).toBe('auth')
    const r = await rec(doc.id)
    expect(r.lastError?.kind).toBe('auth')
    expect(r.op).toBeTruthy()
    expect(hasWork(r)).toBe(true)
    expect(await flushAll(server.deps())).toEqual(['done'])
    expect((await rec(doc.id)).base?.revision).toBe(1)
  })

  it('422: the document was refused — kept, said, not retried until the next edit', async () => {
    const doc = await newDraft()
    server.failWith = new ApiError(422, 'Notiz zu lang')
    expect(await requestSave(doc.id, server.deps())).toBe('refused')
    const r = await rec(doc.id)
    expect(r.lastError).toMatchObject({ kind: 'rejected', detail: 'Notiz zu lang' })
    expect(r.op).toBeNull()
    expect(r.wantSave).toBe(false)
    expect(hasWork(r)).toBe(false)
    expect(r.doc).toEqual(doc) // nothing dropped
  })

  it('a network failure keeps everything and the runner retries', async () => {
    const doc = await newDraft()
    server.failWith = new ApiError(0, 'offline')
    expect(await requestSave(doc.id, server.deps())).toBe('offline')
    expect(hasWork(await rec(doc.id))).toBe(true)
    expect(await flushAll(server.deps())).toEqual(['done'])
  })
})

describe('adoptServerVisit', () => {
  const serverVisit = (doc: VisitDoc, revision: number, missing: string[] = []): ServerVisit => ({ ...doc, revision, ready: missing.length === 0, missing, deliveries: [{ destination: 'sp', state: 'pending', revision }] })

  it('takes a visit from another device into the store as saved', async () => {
    const doc = newVisitDoc({ object: OBJ, checklist: null })
    const r = await adoptServerVisit({ ...serverVisit({ ...doc, photos: [{ id: 'ova1', caption: '', sha256: 's', size: 1, type: 'image/jpeg' }] }, 4), createdBy: { id: 'anna', name: 'Anna' } }, 'u2')
    expect(r?.owner).toBe('anna') // the colleague's draft stays hers — not under «Meine Entwürfe» of the viewer
    expect(r?.base?.revision).toBe(4)
    expect(r?.dirty).toBe(false)
    expect(r?.uploaded).toEqual(['ova1'])
    expect(r?.server?.deliveries).toHaveLength(1)
    expect(hasWork(r!)).toBe(false)
  })

  it('a newer server revision replaces a clean device copy, never a dirty one', async () => {
    const doc = await newDraft()
    await requestSave(doc.id, server.deps())
    await adoptServerVisit(serverVisit({ ...doc, notes: 'from elsewhere' }, 5), 'u1')
    expect((await rec(doc.id)).doc.notes).toBe('from elsewhere')
    await edit(doc.id, (d) => ({ ...d, notes: 'mine' }))
    await adoptServerVisit(serverVisit({ ...doc, notes: 'newer elsewhere' }, 6), 'u1')
    const r = await rec(doc.id)
    expect(r.doc.notes).toBe('mine')
    expect(r.base?.revision).toBe(5)
  })
})

describe('reconnect and reload resume by themselves', () => {
  const until = async (cond: () => Promise<boolean>, ms = 3_000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 20)) }
    return false
  }

  it('a save point that hit no network goes up at the next start — the visit is never opened again', async () => {
    const doc = await newDraft()
    await addPhoto(doc.id, 'ova1')
    server.failWith = new ApiError(0, 'offline')
    expect(await requestSave(doc.id, server.deps())).toBe('offline') // leaving the visit, offline
    __resetStoreForTests(); __resetOutboxForTests() // the app is closed and opened again
    expect(await flushAll(server.deps())).toEqual(['done'])
    const r = await rec(doc.id)
    expect(r.sent).toEqual({ revision: 1, ready: true, missing: [] })
    expect(server.atts.has(`${doc.id}/ova1`)).toBe(true)
  })

  it('photos the server is missing go up at start too, without a new revision', async () => {
    const doc = await newDraft()
    await addPhoto(doc.id, 'ova1')
    server.attFail.set('ova1', new ApiError(0, 'offline'))
    expect(await requestSave(doc.id, server.deps())).toBe('offline')
    server.attFail.clear()
    expect(await flushAll(server.deps())).toEqual(['done'])
    expect(server.calls.filter((c) => c.startsWith('put:'))).toHaveLength(1)
    expect((await rec(doc.id)).sent?.ready).toBe(true)
  })

  it('edits after the last acknowledged save point are not sent by a reconnect', async () => {
    const doc = await newDraft()
    await requestSave(doc.id, server.deps())
    await edit(doc.id, (d) => ({ ...d, notes: 'typing, no save point yet' }))
    expect(await flushAll(server.deps())).toEqual([])
    expect(server.calls.filter((c) => c.startsWith('put:'))).toHaveLength(1)
  })

  describe('the runner', () => {
    let stop: (() => void) | null = null
    beforeEach(() => { vi.stubGlobal('window', new EventTarget()) })
    afterEach(() => { stop?.(); stop = null; vi.unstubAllGlobals() })

    it('flushes once at start', async () => {
      const doc = await newDraft()
      server.failWith = new ApiError(0, 'offline')
      await requestSave(doc.id, server.deps())
      stop = startOutboxRunner(server.deps())
      expect(await until(async () => (await rec(doc.id)).base?.revision === 1)).toBe(true)
    })

    it('sends a save point that failed offline as soon as the server answers again', async () => {
      const doc = await newDraft()
      stop = startOutboxRunner(server.deps())
      await new Promise((r) => setTimeout(r, 50))
      server.failWith = new ApiError(0, 'offline')
      noteUnreached()
      expect(await requestSave(doc.id, server.deps())).toBe('offline')
      noteAnswered() // lib/connectivity · onReachable: reconnect is proven by an answer
      expect(await until(async () => (await rec(doc.id)).base?.revision === 1)).toBe(true)
    })

    it('…and on the browser\'s online event', async () => {
      const doc = await newDraft()
      stop = startOutboxRunner(server.deps())
      await new Promise((r) => setTimeout(r, 50))
      server.failWith = new ApiError(0, 'offline')
      await requestSave(doc.id, server.deps())
      window.dispatchEvent(new Event('online'))
      expect(await until(async () => (await rec(doc.id)).base?.revision === 1)).toBe(true)
    })
  })
})

describe('releasing photos the server holds (storage growth)', () => {
  const att = async (attId: string) => { const a = await readAttachment(attId); return a.ok ? a.value : null }

  it('once a FRESH read says the latest revision is ready, acknowledged photos keep only their thumbnail', async () => {
    const doc = await newDraft()
    await addPhoto(doc.id, 'ova1')
    await requestSave(doc.id, server.deps())
    expect(server.calls).toContain(`get:${doc.id}`)
    const a = await att('ova1')
    expect(a?.blob).toBeNull()
    expect(await a?.thumb?.text()).toBe('t')
    expect(a?.sha256).toBe('sha-ova1')
    expect((await rec(doc.id)).releasedAt).toBe(1)
  })

  it('never drops a blob the server has not acknowledged', async () => {
    const doc = await newDraft()
    await addPhoto(doc.id, 'ova1')
    await addPhoto(doc.id, 'ova2')
    server.attFail.set('ova2', new ApiError(0, 'offline'))
    await requestSave(doc.id, server.deps())
    expect((await att('ova1'))?.blob).not.toBeNull() // the revision is not ready yet: nothing goes
    expect((await att('ova2'))?.blob).not.toBeNull()
    server.attFail.clear()
    await flushAll(server.deps())
    expect((await att('ova1'))?.blob).toBeNull()
    expect((await att('ova2'))?.blob).toBeNull()
  })

  it('believes the server, not this device: a photo it lists as missing keeps its bytes', async () => {
    const doc = await newDraft()
    await addPhoto(doc.id, 'ova1')
    await requestSave(doc.id, { ...server.deps(), get: async () => {
      throw new ApiError(0, 'offline') // no fresh read, no release
    } })
    expect((await att('ova1'))?.blob).not.toBeNull()
    server.atts.delete(`${doc.id}/ova1`) // the server lost it after all
    expect(await releaseSettled(doc.id, server.deps())).toBe(0)
    expect((await att('ova1'))?.blob).not.toBeNull()
  })

  it('keeps everything while there are unsent changes, and a photo without a thumbnail', async () => {
    const doc = await newDraft()
    await addPhoto(doc.id, 'ova1')
    await addPhoto(doc.id, 'ova2', null)
    server.loseNextAnswer = true
    await requestSave(doc.id, server.deps()) // the doc is stored, the answer lost: op pending
    expect(await releaseSettled(doc.id, server.deps())).toBe(0)
    await flushAll(server.deps())
    expect((await att('ova1'))?.blob).toBeNull()
    expect((await att('ova2'))?.blob).not.toBeNull() // no thumbnail to fall back on
    await edit(doc.id, (d) => ({ ...d, notes: 'dirty' }))
    expect(await releaseSettled(doc.id, server.deps())).toBe(0)
  })

  it('a photo removed from the visit leaves the device once a revision without it is acknowledged', async () => {
    const doc = await newDraft()
    await addPhoto(doc.id, 'ova1')
    await addPhoto(doc.id, 'ova2')
    await requestSave(doc.id, server.deps())
    await edit(doc.id, (d) => ({ ...d, photos: d.photos.filter((p) => p.id !== 'ova2') }))
    expect(await att('ova2')).toBeTruthy() // not before the server has the revision without it
    await requestSave(doc.id, server.deps())
    expect(await att('ova2')).toBeNull()
    expect(await att('ova1')).toBeTruthy()
  })

  it('a discarded visit keeps no photo here once the server holds the discarded revision', async () => {
    const doc = await newDraft()
    await addPhoto(doc.id, 'ova1')
    await requestSave(doc.id, server.deps())
    await edit(doc.id, (d) => ({ ...d, lifecycle: 'discarded' }))
    await requestSave(doc.id, server.deps())
    expect(await att('ova1')).toBeNull()
  })
})

describe('review fixes', () => {
  it('a shared tablet: the background sender sends only the signed-in account\'s visits', async () => {
    const a = await newDraft('anna')
    const b = await newDraft('beat')
    server.failWith = new ApiError(0, 'offline')
    await requestSave(a.id, server.deps(), { actor: 'anna' })
    server.failWith = new ApiError(0, 'offline')
    await requestSave(b.id, server.deps(), { actor: 'beat' })
    expect(await flushAll(server.deps(), { user: 'beat' })).toEqual(['done'])
    expect(server.visits.has(b.id)).toBe(true)
    expect(server.visits.has(a.id)).toBe(false) // Anna's draft is not filed under Beat
    expect(await flushAll(server.deps(), { user: 'anna' })).toEqual(['done'])
    expect(server.visits.has(a.id)).toBe(true)
  })

  it('a 403 keeps the save point and parks it for that account only', async () => {
    const doc = await newDraft('anna')
    server.failWith = new ApiError(403, 'darf nicht')
    expect(await requestSave(doc.id, server.deps(), { actor: 'anna' })).toBe('refused')
    const r = await rec(doc.id)
    expect(r.op).toBeTruthy()
    expect(r.lastError).toMatchObject({ kind: 'forbidden', user: 'anna' })
    expect(hasWork(r)).toBe(true)
    expect(await flushAll(server.deps(), { user: 'anna' })).toEqual([]) // parked for Anna
    expect(await requestSave(doc.id, server.deps(), { actor: 'anna', manual: true })).toBe('done') // «Jetzt senden»
  })

  it('still behind after the merge rounds: «contended», not «done», and the save point stays', async () => {
    const doc = await newDraft()
    await requestSave(doc.id, server.deps())
    await edit(doc.id, (d) => ({ ...d, notes: 'mine' }))
    server.contend = 10
    expect(await requestSave(doc.id, server.deps())).toBe('contended')
    const r = await rec(doc.id)
    expect(r.lastError?.kind).toBe('contended')
    expect(hasWork(r)).toBe(true)
    server.contend = 0
    expect(await flushAll(server.deps())).toEqual(['done'])
    expect(server.visits.get(doc.id)?.doc.notes).toBe('mine')
  })

  it('a refused photo is not sent again in full on every pass — until «Jetzt senden» or an edit', async () => {
    const doc = await newDraft()
    await addPhoto(doc.id, 'ova1')
    server.attFail.set('ova1', new ApiError(422, 'kein JPEG'))
    expect(await requestSave(doc.id, server.deps())).toBe('refused')
    expect((await rec(doc.id)).refusedPhotos).toEqual({ ova1: 'sha-ova1' })
    await flushAll(server.deps())
    expect(server.calls.filter((c) => c === 'att:ova1')).toHaveLength(1)
    server.attFail.clear()
    expect(await requestSave(doc.id, server.deps(), { manual: true })).toBe('done')
    expect(server.calls.filter((c) => c === 'att:ova1')).toHaveLength(2)
  })

  it('a 403 / module off on a photo stops the photo pass', async () => {
    const doc = await newDraft()
    await requestSave(doc.id, server.deps())
    await addPhoto(doc.id, 'ova1')
    await addPhoto(doc.id, 'ova2')
    server.attFail.set('ova1', new ApiError(403, 'nein'))
    expect(await flushVisit(doc.id, server.deps())).toBe('refused')
    expect(server.calls).not.toContain('att:ova2')
  })

  it('photos a 409 merge brings in are known — no «Fotos n/m» over the server\'s own photos', async () => {
    const doc = await newDraft()
    await requestSave(doc.id, server.deps())
    const cur = server.visits.get(doc.id)!
    const theirs = { id: 'ovaX', caption: 'other device', sha256: 'x', size: 1, type: 'image/jpeg' }
    server.atts.set(`${doc.id}/ovaX`, 'x')
    server.visits.set(doc.id, { revision: 2, doc: { ...cur.doc, photos: [theirs] }, ready: true })
    await edit(doc.id, (d) => ({ ...d, notes: 'n' }))
    await requestSave(doc.id, server.deps())
    const r = await rec(doc.id)
    expect(r.doc.photos.map((p) => p.id)).toEqual(['ovaX'])
    expect(pendingUploads(r)).toEqual([])
  })

  it('conflict cards carry who and which device met them', async () => {
    const doc = await newDraft('anna')
    await requestSave(doc.id, server.deps(), { actor: 'anna' })
    const cur = server.visits.get(doc.id)!
    server.visits.set(doc.id, { revision: 2, doc: { ...cur.doc, notes: 'theirs' }, ready: true })
    await edit(doc.id, (d) => ({ ...d, notes: 'mine' }))
    await requestSave(doc.id, server.deps(), { actor: 'anna' })
    expect((await rec(doc.id)).doc.conflicts?.[0]).toMatchObject({ key: 'notes', by: 'anna', device: deviceId() })
  })
})
