import { describe, expect, it, vi } from 'vitest'
import {
  currentFix, fixToPhotoGeo, geoPermission, localIso, makePhotoPositionSource, MAX_ACCURACY_M, photoPositionGate, RECENT_MS, takenRecently,
} from './devicePosition'

/** A navigator with a scripted geolocation and permission state. */
function fakeNav(opts: { permission?: PermissionState | 'none'; fix?: { lat: number; lng: number; acc: number } | 'error'; noGeo?: boolean } = {}) {
  const getCurrentPosition = vi.fn((ok: PositionCallback, fail: PositionErrorCallback) => {
    if (opts.fix === 'error' || !opts.fix) fail({ code: 1, message: 'denied' } as GeolocationPositionError)
    else ok({ coords: { latitude: opts.fix.lat, longitude: opts.fix.lng, accuracy: opts.fix.acc }, timestamp: Date.parse('2026-10-09T12:00:00Z') } as GeolocationPosition)
  })
  const nav = {
    ...(opts.noGeo ? {} : { geolocation: { getCurrentPosition } }),
    ...(opts.permission && opts.permission !== 'none'
      ? { permissions: { query: vi.fn(async () => ({ state: opts.permission })) } }
      : {}),
  } as unknown as Navigator
  return { nav, getCurrentPosition }
}

describe('photoPositionGate', () => {
  it('asks once — even when the browser already grants geolocation for something else', () => {
    expect(photoPositionGate(undefined, 'granted')).toBe('ask')
    expect(photoPositionGate(undefined, 'prompt')).toBe('ask')
    expect(photoPositionGate(undefined, 'unsupported')).toBe('ask')
  })
  it('uses it after a yes, never after a no, never when the browser refuses or has none', () => {
    expect(photoPositionGate(true, 'granted')).toBe('use')
    expect(photoPositionGate(true, 'prompt')).toBe('use')
    expect(photoPositionGate(false, 'granted')).toBe('off')
    expect(photoPositionGate(true, 'denied')).toBe('off')
    expect(photoPositionGate(undefined, 'denied')).toBe('off')
    expect(photoPositionGate(true, 'unavailable')).toBe('off')
  })
})

describe('geoPermission', () => {
  it('reads the Permissions API, and tells «none to ask» from «no geolocation»', async () => {
    expect(await geoPermission(fakeNav({ permission: 'granted' }).nav)).toBe('granted')
    expect(await geoPermission(fakeNav({ permission: 'none' }).nav)).toBe('unsupported')
    expect(await geoPermission(fakeNav({ noGeo: true }).nav)).toBe('unavailable')
  })
})

describe('currentFix', () => {
  it('returns one fix, and null — never a rejection — on refusal or without geolocation', async () => {
    expect(await currentFix(fakeNav({ fix: { lat: 47.5, lng: 7.5, acc: 12 } }).nav)).toMatchObject({ lat: 47.5, lng: 7.5, acc: 12 })
    expect(await currentFix(fakeNav({ fix: 'error' }).nav)).toBeNull()
    expect(await currentFix(fakeNav({ noGeo: true }).nav)).toBeNull()
  })
})

describe('takenRecently', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  it('trusts the EXIF time first — a library photo from last week is not «now»', () => {
    expect(takenRecently({ lastModified: now }, '2026-10-02T12:00:00+00:00', now)).toBe(false)
    expect(takenRecently({ lastModified: now - 10 * RECENT_MS }, '2026-10-09T11:55:00+00:00', now)).toBe(true)
  })
  it('falls back to the file date, and to yes when nothing says otherwise', () => {
    expect(takenRecently({ lastModified: now - 60_000 }, undefined, now)).toBe(true)
    expect(takenRecently({ lastModified: now - 2 * RECENT_MS }, undefined, now)).toBe(false)
    expect(takenRecently({}, undefined, now)).toBe(true)
    expect(takenRecently({ lastModified: now }, 'garbage', now)).toBe(true)
  })
})

describe('fixToPhotoGeo', () => {
  it('records position, accuracy, time and source — nothing else, no heading', () => {
    const g = fixToPhotoGeo({ lat: 47.513889123, lng: 7.556944987, acc: 11.6, at: Date.parse('2026-10-09T12:00:00Z') })!
    expect(Object.keys(g).sort()).toEqual(['acc', 'lat', 'lng', 'source', 'takenAt'])
    expect(g).toMatchObject({ lat: 47.5138891, lng: 7.556945, acc: 12, source: 'device' })
  })
  it('refuses a fix too coarse to place anything by', () => {
    expect(fixToPhotoGeo({ lat: 47.5, lng: 7.5, acc: MAX_ACCURACY_M + 1, at: 0 })).toBeNull()
    expect(fixToPhotoGeo({ lat: 47.5, lng: 7.5, acc: Number.NaN, at: 0 })).toBeNull()
    expect(fixToPhotoGeo(null)).toBeNull()
  })
})

it('localIso writes the local clock with its offset', () => {
  expect(localIso(Date.parse('2026-10-09T12:00:00Z'))).toMatch(/^2026-10-09T\d{2}:00:00[+-]\d{2}:\d{2}$/)
})

describe('makePhotoPositionSource — the one question', () => {
  const setup = (pref: boolean | undefined, answer: boolean, nav = fakeNav({ permission: 'prompt', fix: { lat: 47.5, lng: 7.5, acc: 8 } })) => {
    let stored = pref
    const ask = vi.fn(async () => answer)
    const source = makePhotoPositionSource({ nav: nav.nav, loadPref: () => stored, savePref: (v) => { stored = v }, ask })
    return { source, ask, nav, stored: () => stored }
  }

  it('asks ONCE for several pictures at once, remembers the yes, and fixes', async () => {
    const t = setup(undefined, true)
    const [a, b] = await Promise.all([t.source(), t.source()])
    expect(t.ask).toHaveBeenCalledTimes(1)
    expect(t.stored()).toBe(true)
    expect(a).toMatchObject({ lat: 47.5, source: 'device' })
    expect(b).toMatchObject({ lat: 47.5 })
    await t.source()
    expect(t.ask).toHaveBeenCalledTimes(1) // never again
  })

  it('a no is remembered, and no fix is ever taken', async () => {
    const t = setup(undefined, false)
    expect(await t.source()).toBeNull()
    expect(await t.source()).toBeNull()
    expect(t.ask).toHaveBeenCalledTimes(1)
    expect(t.stored()).toBe(false)
    expect(t.nav.getCurrentPosition).not.toHaveBeenCalled()
  })

  it('a browser that refuses is not asked about at all', async () => {
    const t = setup(undefined, true, fakeNav({ permission: 'denied' }))
    expect(await t.source()).toBeNull()
    expect(t.ask).not.toHaveBeenCalled()
  })

  it('a yes given before goes straight to the fix, and a failed fix is simply nothing', async () => {
    const t = setup(true, true, fakeNav({ permission: 'granted', fix: 'error' }))
    expect(await t.source()).toBeNull()
    expect(t.ask).not.toHaveBeenCalled()
    expect(t.nav.getCurrentPosition).toHaveBeenCalledTimes(1)
  })
})
