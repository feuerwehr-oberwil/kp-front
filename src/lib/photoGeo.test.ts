import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  cardinalIndex, fmtDistance, forgetPhotoGeo, photoGeoOf, photoMarker, photoPlacement, PHOTO_NEAR_FALLBACK_M, PHOTO_NEAR_M,
  rememberPhotoGeo, resolvePhotoUrl, rowGeoFor, rowPhotoGeo, takenClock, toPhotoGeo, validGeo, withResolvedPhotos,
} from './photoGeo'
import { parseExif } from './exif'
import type { Entity, LngLat, PhotoGeo, TimelineEvent } from '../types'

const fixture = (name: string) => new Blob([readFileSync(`src/lib/fixtures/exif/${name}`)])
const OBERWIL: LngLat = [7.556944, 47.513889]
const geo = (over: Partial<PhotoGeo> = {}): PhotoGeo => ({ lat: 47.5141, lng: 7.5571, ...over })
const row = (over: Partial<TimelineEvent> = {}): TimelineEvent =>
  ({ id: 'j1', t: '14:32', icon: 'photo', text: '', kind: 'photo', ...over })

describe('toPhotoGeo — what the record keeps', () => {
  it('keeps position, altitude, heading and time, and nothing else', () => {
    const m = parseExif(readFileSync('src/lib/fixtures/exif/gps-heading.jpg'))
    const g = toPhotoGeo(m)!
    expect(Object.keys(g).sort()).toEqual(['alt', 'heading', 'lat', 'lng', 'takenAt'])
    expect(g.lat).toBeCloseTo(47.513889, 6)
    expect(g.heading).toBeCloseTo(228.4, 1)
  })

  it('is null without a position — a time or heading alone places nothing', () => {
    expect(toPhotoGeo({ takenAt: '2026-10-08T14:00:00', heading: 90 })).toBeNull()
    expect(toPhotoGeo(null)).toBeNull()
  })
})

describe('the session cache', () => {
  it('remembers a picked file by its blob URL and forgets it on discard', async () => {
    const g = await rememberPhotoGeo('blob:a', fixture('gps-heading.jpg'))
    expect(g?.lat).toBeCloseTo(47.513889, 5)
    expect(photoGeoOf('blob:a')).toEqual(g)
    expect(await rememberPhotoGeo('blob:b', fixture('no-gps.jpg'))).toBeNull()
    expect(photoGeoOf('blob:b')).toBeNull()
    forgetPhotoGeo('blob:a')
    expect(photoGeoOf('blob:a')).toBeNull()
  })

  it('never rejects on a file that is not an image', async () => {
    expect(await rememberPhotoGeo('blob:c', new Blob(['hello']))).toBeNull()
  })

  it('writes photoGeo only when at least one picture has a position', async () => {
    await rememberPhotoGeo('blob:g1', fixture('gps-only.jpg'))
    await rememberPhotoGeo('blob:g2', fixture('no-exif.jpg'))
    const list = rowGeoFor(['blob:g2', 'blob:g1'])!
    expect(list[0]).toBeNull()
    expect(list[1]?.lat).toBeCloseTo(47.5139, 4)
    expect(rowGeoFor(['blob:g2'])).toBeUndefined()
    expect(rowGeoFor([])).toBeUndefined()
  })
})

describe('rowPhotoGeo — the index alignment', () => {
  it('reads picture i while the counts match', () => {
    const r = row({ photoUrls: ['/api/media/a', '/api/media/b'], photoGeo: [null, geo()] })
    expect(rowPhotoGeo(r, 0)).toBeNull()
    expect(rowPhotoGeo(r, 1)?.lat).toBe(47.5141)
  })

  it('trusts nothing when another device sees fewer pictures than were captured', () => {
    // the persisted row lists only uploaded pictures; the capture's #1 is #0 here
    const r = row({ photoUrls: ['/api/media/b'], photoGeo: [null, geo()] })
    expect(rowPhotoGeo(r, 0)).toBeNull()
  })

  it('refuses a malformed synced value', () => {
    expect(rowPhotoGeo(row({ photoUrls: ['/x'], photoGeo: [{ lat: 'x' } as unknown as PhotoGeo] }), 0)).toBeNull()
    expect(rowPhotoGeo(row({ photoUrls: ['/x'], photoGeo: [{ lat: 95, lng: 7 }] }), 0)).toBeNull()
    expect(rowPhotoGeo(row({ photoUrls: ['/x'], photoGeo: 'nope' as unknown as PhotoGeo[] }), 0)).toBeNull()
    expect(validGeo({ lat: 47, lng: 7, heading: Number.NaN })).toBe(false)
  })

  it('reads the legacy single-photo shape too', () => {
    expect(rowPhotoGeo(row({ photoUrl: '/x', photoGeo: [geo()] }), 0)?.lng).toBe(7.5571)
  })
})

describe('photoPlacement', () => {
  const r = row({ photoUrls: ['/api/media/a'], photoGeo: [geo()] })

  it('is null for a picture without a position — the sheet shows nothing', () => {
    expect(photoPlacement(row({ photoUrls: ['/a'] }), 0, OBERWIL, true, [])).toBeNull()
  })

  it('offers «Auf Karte setzen» near the Einsatz', () => {
    const p = photoPlacement(r, 0, OBERWIL, true, [])!
    expect(p.kind).toBe('place')
    expect(p.distanceM).toBeGreaterThan(10)
    expect(p.distanceM).toBeLessThan(100)
  })

  it('says «too far» beyond the radius, with the coarser one when the Einsatz has no coordinate', () => {
    // ~5.5 km north
    const far = row({ photoUrls: ['/a'], photoGeo: [geo({ lat: 47.5639 })] })
    expect(photoPlacement(far, 0, OBERWIL, true, [])!.kind).toBe('far')
    expect(photoPlacement(far, 0, OBERWIL, false, [])!.kind).toBe('place')
    expect(PHOTO_NEAR_M).toBeLessThan(PHOTO_NEAR_FALLBACK_M)
  })

  it('offers «Auf Karte zeigen» once the picture is on the Karte', () => {
    const m = photoMarker('ph1', r, 0, geo(), 'markup')
    const p = photoPlacement(r, 0, OBERWIL, true, [m])!
    expect(p).toMatchObject({ kind: 'placed', entityId: 'ph1' })
    // …a marker of ANOTHER picture of the row does not count
    const other = { ...m, photoOf: { row: 'j1', i: 1 } }
    expect(photoPlacement(r, 0, OBERWIL, true, [other])!.kind).toBe('place')
  })
})

describe('photoMarker', () => {
  it('stands where the picture was taken, carries heading + time, names its picture', () => {
    const r = row({ photoUrls: ['blob:x'], photoGeo: [geo({ heading: 45, takenAt: '2026-10-08T14:32:05' })] })
    const m = photoMarker('ph1', r, 0, rowPhotoGeo(r, 0)!, 'markup')
    expect(m).toEqual({
      id: 'ph1', kind: 'photo', layer: 'markup', coord: [7.5571, 47.5141],
      photoUrl: 'blob:x', photoOf: { row: 'j1', i: 0 }, heading: 45, takenAt: '2026-10-08T14:32:05',
    })
  })

  it('carries no heading key when the photo stated none', () => {
    const r = row({ photoUrls: ['/a'], photoGeo: [geo()] })
    expect('heading' in photoMarker('ph1', r, 0, geo(), 'markup')).toBe(false)
  })
})

describe('resolvePhotoUrl / withResolvedPhotos', () => {
  const marker: Entity = { id: 'ph1', kind: 'photo', layer: 'markup', coord: [7.5, 47.5], photoUrl: 'blob:old', photoOf: { row: 'j1', i: 1 } }

  it('shows the row’s CURRENT picture — the uploaded one replaces the session blob', () => {
    const r = row({ photoUrls: ['/api/media/a', '/api/media/b'], photoGeo: [null, geo()] })
    expect(resolvePhotoUrl(marker, new Map([['j1', r]]))).toBe('/api/media/b')
  })

  it('keeps the stored URL when the row is gone or the alignment is off', () => {
    expect(resolvePhotoUrl(marker, new Map())).toBe('blob:old')
    const short = row({ photoUrls: ['/api/media/b'], photoGeo: [null, geo()] })
    expect(resolvePhotoUrl(marker, new Map([['j1', short]]))).toBe('blob:old')
  })

  it('returns the SAME array when nothing changes (memo-friendly)', () => {
    const plain: Entity[] = [{ id: 's', kind: 'symbol', layer: 'taktisch', coord: [7, 47] }]
    expect(withResolvedPhotos(plain, [])).toBe(plain)
    const settled = [{ ...marker, photoUrl: '/api/media/b' }]
    const r = row({ photoUrls: ['/api/media/a', '/api/media/b'], photoGeo: [null, geo()] })
    expect(withResolvedPhotos(settled, [r])).toBe(settled)
    expect(withResolvedPhotos([marker], [r])[0].photoUrl).toBe('/api/media/b')
  })
})

describe('words', () => {
  it('names the bearing in eight steps', () => {
    expect([0, 44, 46, 90, 180, 228.4, 315, 359].map(cardinalIndex)).toEqual([0, 1, 1, 2, 4, 5, 7, 0])
  })

  it('formats the distance', () => {
    expect(fmtDistance(3)).toBe('10 m')
    expect(fmtDistance(123)).toBe('120 m')
    expect(fmtDistance(1430)).toMatch(/^1[.,]4 km$/)
  })

  it('reads the clock off an EXIF time', () => {
    expect(takenClock('2026-10-08T14:32:05+02:00')).toBe('14:32')
    expect(takenClock(undefined)).toBeNull()
  })
})
