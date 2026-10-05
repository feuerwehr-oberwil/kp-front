import { describe, expect, it } from 'vitest'
import { newVisitDoc } from './doc'
import { deliveryState, deriveStatus } from './status'
import type { LocalVisit } from './store'
import type { VisitDoc } from './types'

const doc = (over: Partial<VisitDoc> = {}): VisitDoc => ({ ...newVisitDoc({ object: { id: 'o', name: 'O' }, checklist: null }), ...over })
const photo = (id: string) => ({ id, caption: '', sha256: 's', size: 1, type: 'image/jpeg' })
const rec = (over: Partial<LocalVisit> = {}): LocalVisit => ({
  doc: doc(), base: null, dirty: true, savedAt: '2026-10-03T08:21:00Z', sent: null, lastError: null, ...over,
})
const saved = (d: VisitDoc, over: Partial<LocalVisit> = {}): LocalVisit => rec({
  doc: d, base: { revision: 3, doc: d }, dirty: false, sent: { revision: 3, ready: true, missing: [] }, uploaded: d.photos.map((p) => p.id), ...over,
})
const sync = (r: LocalVisit | null, extra: Partial<Parameters<typeof deriveStatus>[0]> = {}) =>
  deriveStatus({ rec: r, durable: true, flushing: false, sessionExpired: false, ...extra }).sync

describe('deriveStatus · device → server', () => {
  it('never sent: «Nur auf diesem Gerät»', () => {
    expect(sync(rec())).toMatchObject({ kind: 'local', at: '2026-10-03T08:21:00Z' })
  })
  it('«Gespeichert» only when the server holds the latest revision AND all its photos', () => {
    const d = doc({ photos: [photo('a')] })
    expect(sync(saved(d))).toMatchObject({ kind: 'saved', revision: 3 })
    expect(sync(saved(d, { sent: { revision: 3, ready: false, missing: ['a'] }, uploaded: [] }))).toMatchObject({ kind: 'photos', photosDone: 0, photosTotal: 1 })
  })
  it('a photo this device has not uploaded yet is «Fotos n/m», not saved', () => {
    const d = doc({ photos: [photo('a'), photo('b')] })
    expect(sync(saved(d, { uploaded: ['a'] }))).toMatchObject({ kind: 'photos', photosDone: 1, photosTotal: 2 })
  })
  it('edits after the last revision: «Änderungen auf Gerät»', () => {
    const d = doc()
    expect(sync(saved(d, { dirty: true }))).toMatchObject({ kind: 'changes', revision: 3 })
  })
  it('the failed device write outranks everything', () => {
    expect(sync(saved(doc(), { doc: doc({ conflicts: [{ id: 'c', key: 'notes', mine: 'a', theirs: 'b', at: 'x' }] }) }), { durable: false }).kind).toBe('unsaved')
  })
  it('then a conflict, then the login, then a refusal, then sending', () => {
    const c = doc({ conflicts: [{ id: 'c', key: 'notes', mine: 'a', theirs: 'b', at: 'x' }] })
    expect(sync(saved(c)).kind).toBe('conflict')
    expect(sync(rec({ lastError: { kind: 'auth', at: 'x' } })).kind).toBe('auth')
    expect(sync(rec(), { sessionExpired: true }).kind).toBe('auth')
    expect(sync(saved(doc()), { sessionExpired: true }).kind).toBe('saved') // nothing owed, nothing to say
    expect(sync(rec({ lastError: { kind: 'rejected', detail: 'zu lang', at: 'x' } }))).toMatchObject({ kind: 'error' })
    expect(sync(rec(), { flushing: true }).kind).toBe('sending')
  })
  it('still behind another device after the merge rounds says «Konflikt»', () => {
    expect(sync(saved(doc(), { dirty: true, wantSave: true, lastError: { kind: 'contended', at: 'x' } })).kind).toBe('conflict')
  })
  it('flags a send that failed for want of a network', () => {
    expect(sync(rec({ lastError: { kind: 'offline', at: 'x' } }))).toMatchObject({ kind: 'local', offline: true })
  })
  it('a read-only server copy says its revision', () => {
    const v = { ...doc(), revision: 7, ready: true, missing: [] }
    expect(sync(null, { remote: v })).toMatchObject({ kind: 'remote', revision: 7 })
  })
})

describe('deliveryState', () => {
  it('hidden without a destination', () => { expect(deliveryState([], 1).kind).toBe('none') })
  it('failed wins, then waiting, then delivered at the current revision', () => {
    expect(deliveryState([{ destination: 'a', state: 'delivered', revision: 3 }, { destination: 'b', state: 'failed', revision: 2, error: '403' }], 3)).toMatchObject({ kind: 'failed', error: '403' })
    expect(deliveryState([{ destination: 'a', state: 'delivered', revision: 2 }], 3).kind).toBe('waiting')
    expect(deliveryState([{ destination: 'a', state: 'delivered', revision: 3 }], 3).kind).toBe('delivered')
    expect(deliveryState([{ destination: 'a', state: 'paused', revision: 1 }], 3).kind).toBe('paused')
  })
})
