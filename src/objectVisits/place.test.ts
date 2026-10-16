import { describe, expect, it } from 'vitest'
import { newVisitDoc } from './doc'
import { knownVisits, visitsAtStop } from './catalogue'
import { mergeVisit } from './merge'
import {
  draftKeyOf, isPlaceKey, parsePlace, placeKey, placeKind, placeOf, placeTarget, placeTiles, stopKeyOf, summaryStopKey, targetOf,
  templatesFor, templateTargets,
} from './place'
import { findOpenDraft, type LocalVisit } from './store'
import type { PlaceTarget } from './types'

const PLACE: PlaceTarget = { kind: 'location', label: 'bei Talholzstrasse 15', address: 'Talholzstrasse 15, 4103 Bottmingen', lat: 47.52015, lng: 7.57175 }

describe('the visit target (contract C1)', () => {
  it('an older document is at its object; a new one says so', () => {
    expect(targetOf({ object: { id: 'u1' } })).toEqual({ kind: 'object', objectId: 'u1' })
    const atObject = newVisitDoc({ object: { id: 'u1', name: 'Schulhaus', lat: 47.5, lng: 7.5 }, checklist: null })
    expect(atObject.target).toEqual({ kind: 'object', objectId: 'u1' })
    expect(atObject.object).toEqual({ id: 'u1', name: 'Schulhaus', lat: 47.5, lng: 7.5 })
    const atPlace = newVisitDoc({ place: PLACE, checklist: null })
    expect(atPlace.object).toBeNull()
    expect(placeOf(atPlace)).toEqual(PLACE)
    expect(placeOf(atObject)).toBeNull()
  })
  it('a draft at a place is found again at that pin (~1 m); a place visit is a stop of its own', () => {
    expect(placeKey(PLACE)).toBe('ort:47.52015,7.57175')
    expect(placeKey({ lat: 47.520151, lng: 7.571749 })).toBe(placeKey(PLACE))
    expect(isPlaceKey(placeKey(PLACE))).toBe(true)
    const a = newVisitDoc({ place: PLACE, checklist: null })
    const b = newVisitDoc({ place: PLACE, checklist: null })
    expect(draftKeyOf(a)).toBe(placeKey(PLACE))
    expect(draftKeyOf(b)).toBe(draftKeyOf(a))
    // two reports on the same pin are two stops
    expect(stopKeyOf(a)).not.toBe(stopKeyOf(b))
    expect(stopKeyOf({ id: 'ov1', object: { id: 'u1' } })).toBe('u1')
    expect(summaryStopKey({ id: a.id, objectId: null, target_kind: 'location' })).toBe(stopKeyOf(a))
    expect(summaryStopKey({ id: 'ov9', objectId: 'u1' })).toBe('u1') // an older server: no target_kind
  })
  it('«Pin» or «Adresse»: picked as an address when the label IS the address', () => {
    expect(placeKind(PLACE)).toBe('pin')
    expect(placeKind({ label: 'Talholzstrasse 15', address: 'Talholzstrasse 15, 4103 Bottmingen' })).toBe('address')
    expect(placeKind({ label: 'Gesetzter Punkt', address: null })).toBe('pin')
  })
  it('the chooser offers what a target may use — no `targets` is an object checklist, as before', () => {
    const key = { id: 'schluessel', targets: undefined }
    const report = { id: 'fehler', targets: ['object', 'location'] as ('object' | 'location')[] }
    const placeOnly = { id: 'ort', targets: ['location'] as ('object' | 'location')[] }
    expect(templateTargets(key)).toEqual(['object'])
    expect(templatesFor([key, report, placeOnly], 'location').map((t) => t.id)).toEqual(['fehler', 'ort'])
    expect(templatesFor([key, report, placeOnly], 'object').map((t) => t.id)).toEqual(['schluessel', 'fehler'])
  })
  it('reads a launch link\'s place; a failed reverse geocode is still a place', () => {
    const q = (s: string) => new URLSearchParams(s)
    expect(parsePlace(q('lat=47.52015&lng=7.57175&label=bei+Talholzstrasse+15&address='))).toEqual({ lat: 47.52015, lng: 7.57175, label: 'bei Talholzstrasse 15', address: null })
    expect(parsePlace(q('lat=47.5'))).toBeNull()
    expect(parsePlace(q('lat=x&lng=7'))).toBeNull()
    expect(parsePlace(q('lat=91&lng=7'))).toBeNull()
    expect(placeTarget({ lat: 47.5, lng: 7.5, label: '', address: null }, 'an gesetztem Punkt'))
      .toEqual({ kind: 'location', label: 'an gesetztem Punkt', address: null, lat: 47.5, lng: 7.5 })
  })
})

describe('a place in the device list', () => {
  const rec = (doc: ReturnType<typeof newVisitDoc>, owner = 'me'): LocalVisit => ({
    doc, base: null, dirty: true, savedAt: '2026-10-16T17:21:00Z', sent: null, lastError: null, owner,
  })
  it('a reload of the place\'s link resumes the draft there, not one at another place or object', () => {
    const here = rec(newVisitDoc({ place: PLACE, checklist: null }))
    const elsewhere = rec(newVisitDoc({ place: { ...PLACE, lat: 47.53 }, checklist: null }))
    const atObject = rec(newVisitDoc({ object: { id: 'u1', name: 'Schulhaus' }, checklist: null }))
    const all = [elsewhere, atObject, here]
    expect(findOpenDraft(all, placeKey(PLACE), null, 'me')?.doc.id).toBe(here.doc.id)
    expect(findOpenDraft(all, 'u1', null, 'me')?.doc.id).toBe(atObject.doc.id)
    expect(findOpenDraft(all, placeKey(PLACE), null, 'someone else')).toBeNull()
  })
  it('two independent reports on the same pin are never one stop (lead review of #368)', () => {
    // the k5 capture run: one Fehlermeldung from the tablet, one from the phone, same pin
    const a = { ...newVisitDoc({ place: PLACE, checklist: null }), lifecycle: 'completed' as const }
    const known = knownVisits([rec(a)], [
      { id: 'ov-srv', objectId: null, objectName: null, target_kind: 'location', location: { label: 'x', address: null, lat: PLACE.lat, lng: PLACE.lng }, lifecycle: 'completed', revision: 1, ready: true, visitedAt: '2026-10-15T10:00:00Z' },
      { id: 'ov-obj', objectId: 'u1', objectName: 'Schulhaus', lifecycle: 'completed', revision: 1, ready: true, visitedAt: '2026-10-15T10:00:00Z' },
      { id: 'ov-obj2', objectId: 'u1', objectName: 'Schulhaus', lifecycle: 'completed', revision: 1, ready: true, visitedAt: '2026-10-15T11:00:00Z' },
    ])
    expect(visitsAtStop(known, stopKeyOf(a), null).map((v) => v.id)).toEqual([a.id])
    expect(visitsAtStop(known, summaryStopKey({ id: 'ov-srv', objectId: null, target_kind: 'location' }), null).map((v) => v.id)).toEqual(['ov-srv'])
    expect(visitsAtStop(known, placeKey(PLACE), null)).toEqual([])
    // an object stop is unchanged: every visit at the object
    expect(visitsAtStop(known, 'u1', null).map((v) => v.id)).toEqual(['ov-obj2', 'ov-obj'])
  })
  it('a merge keeps the place (a key like any other)', () => {
    const base = newVisitDoc({ place: PLACE, checklist: null })
    const local = { ...base, notes: 'meins' }
    const server = { ...base, visitedAt: '2026-10-17T08:00:00+02:00' }
    const { doc, conflicts } = mergeVisit(base, local, server)
    expect(conflicts).toEqual([])
    expect(doc.target).toEqual(PLACE)
    expect(doc.object).toBeNull()
    expect(doc.notes).toBe('meins')
    // an older server copy without `target` (a build that dropped it) does not lose the place
    const { target: _gone, ...old } = server
    expect(mergeVisit(base, local, old as typeof server).doc.target).toEqual(PLACE)
  })
})

describe('the «Ort» card\'s tiles', () => {
  it('cover the box around the point, box-relative, the point in the middle', () => {
    const tpl = 'https://t/{z}/{x}/{y}.jpeg'
    const tiles = placeTiles(tpl, PLACE.lat, PLACE.lng, 18, 720, 128)
    expect(tiles.length).toBeGreaterThanOrEqual(3)
    expect(tiles.length).toBeLessThanOrEqual(8)
    for (const t of tiles) {
      expect(t.url).toMatch(/^https:\/\/t\/18\/\d+\/\d+\.jpeg$/)
      // every tile overlaps the box, and no number is a world pixel
      expect(t.left).toBeGreaterThan(-256)
      expect(t.left).toBeLessThan(720)
      expect(t.top).toBeGreaterThan(-256)
      expect(t.top).toBeLessThan(128)
    }
    // the box is fully covered: the leftmost tile starts at or before 0, the rightmost ends at or after 720
    expect(Math.min(...tiles.map((t) => t.left))).toBeLessThanOrEqual(0)
    expect(Math.max(...tiles.map((t) => t.left + 256))).toBeGreaterThanOrEqual(720)
  })
})
