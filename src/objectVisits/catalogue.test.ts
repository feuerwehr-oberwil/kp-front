import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../lib/api'
import { __resetIdbForTests, idbGet } from '../lib/idb'
import {
  CATALOGUE_KEY, distanceM, knownVisits, listProgress, loadCatalogue, loadSummaries, nearestObjects, resolveObject, visitTemplates,
} from './catalogue'
import type { Catalogue } from './types'

const cat = (over: Partial<Catalogue> = {}): Catalogue => ({
  generatedAt: '2026-10-03T08:12:00Z',
  canCapture: true,
  objects: [
    { id: 'u1', name: 'Gemeindeverwaltung', address: 'Hauptstrasse 24', lat: 47.513, lng: 7.559, refs: [{ source: 'fwo-schlue', id: 'h-1' }], lastVisit: null },
    { id: 'u2', name: 'Werkhof', address: 'Sägestrasse 9', lat: 47.52, lng: 7.56, refs: [] },
    { id: 'u3', name: 'Ohne Koordinaten' },
  ],
  templates: [
    { id: 'schluessel', kind: 'visit', version: 1, title: 'Kontrolle Schlüsselhülse', source: 'FU', phases: [] },
    { id: 'schluessel', kind: 'visit', version: 2, title: 'Kontrolle Schlüsselhülse', source: 'FU', phases: [] },
    { id: 'fu', kind: 'action', version: 1, title: 'FU Aktion', source: 'FU', phases: [] },
  ],
  lists: [{ ref: 'fu-2027/B4', title: 'B4', objectIds: ['u1', 'u2', 'u3'] }],
  proposalFields: [],
  ...over,
})

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  __resetIdbForTests()
})

describe('loadCatalogue', () => {
  it('network first, cached under kp-front-ov-catalogue, visit templates only', async () => {
    const r = await loadCatalogue(async () => cat())
    expect(r.state).toBe('ready')
    if (r.state !== 'ready') return
    expect(r.catalogue.templates.every((t) => t.kind === 'visit')).toBe(true)
    await new Promise((res) => setTimeout(res, 10))
    expect(await idbGet(CATALOGUE_KEY)).toMatchObject({ generatedAt: '2026-10-03T08:12:00Z' })
  })

  it('offline → the device copy, marked stale', async () => {
    await loadCatalogue(async () => cat())
    await new Promise((res) => setTimeout(res, 10))
    const r = await loadCatalogue(async () => { throw new ApiError(0, 'offline') })
    expect(r.state).toBe('stale')
  })

  it('a lapsed session still opens the device copy (work does not stop with a login)', async () => {
    await loadCatalogue(async () => cat())
    await new Promise((res) => setTimeout(res, 10))
    expect((await loadCatalogue(async () => { throw new ApiError(401, 'x') })).state).toBe('stale')
  })

  it('never prepared and offline is MISSING — never an empty catalogue', async () => {
    const r = await loadCatalogue(async () => { throw new ApiError(0, 'offline') })
    expect(r.state).toBe('missing')
  })

  it('the module off is a refusal', async () => {
    const e = new ApiError(404, 'aus')
    e.code = 'object_visits_disabled'
    expect((await loadCatalogue(async () => { throw e })).state).toBe('refused')
  })
})

describe('catalogue helpers', () => {
  it('resolves a launch link by ref or by uuid', () => {
    expect(resolveObject(cat(), 'fwo-schlue:h-1')?.id).toBe('u1')
    expect(resolveObject(cat(), 'u2')?.id).toBe('u2')
    expect(resolveObject(cat(), 'fwo-schlue:nope')).toBeNull()
    expect(resolveObject(cat(), '')).toBeNull()
  })
  it('offers the newest version of each visit checklist', () => {
    expect(visitTemplates(cat()).map((t) => `${t.id}@${t.version}`)).toEqual(['fu@1', 'schluessel@2']) // by order, then title
  })
  it('sorts nearby objects by distance and skips those without coordinates', () => {
    const near = nearestObjects(cat(), { lat: 47.513, lng: 7.559 })
    expect(near.map((n) => n.object.id)).toEqual(['u1', 'u2'])
    expect(near[0].m).toBeLessThan(1)
    expect(distanceM({ lat: 47, lng: 7 }, { lat: 47.01, lng: 7 })).toBeGreaterThan(1100)
  })
  it('list progress counts completed visits with the list reference only', () => {
    const list = cat().lists[0]
    const visits = knownVisits(
      [{ doc: { id: 'ov2', object: { id: 'u2' }, workRef: 'fu-2027/B4', lifecycle: 'draft', visitedAt: '2026-10-03' } }],
      [
        { id: 'ov1', objectId: 'u1', workRef: 'fu-2027/B4', lifecycle: 'completed', revision: 2, ready: true, visitedAt: '2026-10-01', objectName: 'G' },
        { id: 'ov9', objectId: 'u3', workRef: 'other', lifecycle: 'completed', revision: 1, ready: true, visitedAt: '2026-10-01', objectName: 'X' },
      ],
    )
    const p = listProgress(list, visits)
    expect(p).toMatchObject({ done: 1, total: 3 })
    expect(p.byObject.get('u2')?.lifecycle).toBe('draft')
    expect(p.byObject.has('u3')).toBe(false)
  })
  it('summaries: null when nobody answered, never an empty list', async () => {
    expect(await loadSummaries(async () => { throw new ApiError(0, 'x') })).toBeNull()
    expect(await loadSummaries(async () => [])).toEqual({ list: [], fresh: true })
  })
})
