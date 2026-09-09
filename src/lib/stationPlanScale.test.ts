import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PlanScale } from './planScale'
import type { Georef } from './georef'
import type { StationPlanScales } from './stationPlanScale'

// The module owns two singletons — the resolved document and «did a real document ever land?» —
// so the tests drive it through its actual boot path (`loadStationPlanScales`) rather than poking
// the singleton, and both the network and the offline cache are stubbed to say exactly what a
// given field situation would say.
const { apiGet, apiPut, idbGet, idbSet, onLinkPage, ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(public status: number, public detail = '') { super(detail); this.name = 'ApiError' }
  }
  return {
    apiGet: vi.fn<(path: string) => Promise<unknown>>(),
    apiPut: vi.fn<(path: string, body: unknown, extra?: Record<string, string>) => Promise<unknown>>(),
    idbGet: vi.fn<(key: string) => Promise<unknown>>(),
    idbSet: vi.fn<(key: string, value: unknown) => Promise<boolean>>(),
    onLinkPage: vi.fn<() => boolean>(),
    ApiError,
  }
})
vi.mock('./api', () => ({ apiGet, apiPut, ApiError }))
vi.mock('./idb', () => ({ idbGet, idbSet }))
vi.mock('./linkMode', () => ({ onLinkPage }))

const AR = 1.414
const scale = (mPerU: number, ar = AR): PlanScale => ({ mPerU, refM: 20, ar })
const doc = (d: Partial<StationPlanScales>): StationPlanScales => ({ default: null, byPlan: {}, georefByPlan: {}, measuredArByPlan: {}, ...d })
/** …as the endpoint answers it: the document plus the token of the version it was read at. */
const served = (d: Partial<StationPlanScales>, version = 'v1') => ({ ...doc(d), version })
/** the `If-Match` a given PUT went out with (undefined = none) */
const sentToken = (i: number) => apiPut.mock.calls[i][2]?.['If-Match']

/** A pristine copy of the module. «This device never learned what the station has» is a state
 *  that exists only before the first successful load, so it cannot be reached twice in one
 *  module instance. */
async function load() {
  vi.resetModules()
  return import('./stationPlanScale')
}

/** Boot the module the way main.tsx does, with the server answering `d`. */
async function booted(d: Partial<StationPlanScales>, version = 'v1') {
  const m = await load()
  apiGet.mockResolvedValue(served(d, version))
  await m.loadStationPlanScales()
  return m
}

/** What the server PUT actually received — the whole document, every time. */
const written = (): StationPlanScales => apiPut.mock.calls[0][1] as StationPlanScales

beforeEach(() => {
  apiGet.mockReset(); apiPut.mockReset(); idbGet.mockReset(); idbSet.mockReset()
  apiPut.mockResolvedValue({ version: 'v-stored' })
  onLinkPage.mockReturnValue(false)
  idbSet.mockResolvedValue(true)
  idbGet.mockResolvedValue(null)
})

describe('resolvePlanScale priority', () => {
  it('prefers the per-incident workspace scale over station layers', async () => {
    const m = await booted({ default: scale(100), byPlan: { p1: scale(50) } })
    expect(m.resolvePlanScale('p1', scale(7), AR)?.mPerU).toBe(7)
  })

  it('falls back to the station per-plan override when no workspace scale', async () => {
    const m = await booted({ default: scale(100), byPlan: { p1: scale(50) } })
    expect(m.resolvePlanScale('p1', undefined, AR)?.mPerU).toBe(50)
  })

  it('falls back to the station default when neither workspace nor per-plan exists', async () => {
    const m = await booted({ default: scale(100) })
    expect(m.resolvePlanScale('pX', undefined, AR)?.mPerU).toBe(100)
  })

  it('returns undefined when nothing is calibrated', async () => {
    const m = await booted({})
    expect(m.resolvePlanScale('pX', undefined, AR)).toBeUndefined()
  })

  it('skips a stale candidate (aspect drift) and falls through to the next layer', async () => {
    // per-plan override derived at a very different aspect → stale for the current AR → skipped;
    // the default (matching AR) is used instead.
    const m = await booted({ default: scale(100), byPlan: { p1: scale(50, 3.0) } })
    expect(m.resolvePlanScale('p1', undefined, AR)?.mPerU).toBe(100)
  })
})

// The georeference shares the document (and therefore the one load/cache path) with the scales.
const georef = (n: number): Georef => ({
  pairs: Array.from({ length: n }, (_, i) => ({
    plan: { x: 0.1 * (i + 1), y: 0.2 },
    lngLat: { lng: 7.54 + i / 1000, lat: 47.5 },
    kind: 'gesetzt' as const,
  })),
})

const KEY = 'object:o1:plan:modul2'

describe('station georef', () => {
  it('returns null for a sheet that has none', async () => {
    const m = await booted({})
    expect(m.georefForPlan(KEY)).toBeNull()
  })

  it('round-trips a saved georeference', async () => {
    const m = await booted({})
    await m.saveGeoref(KEY, georef(2))
    expect(m.georefForPlan(KEY)?.pairs).toHaveLength(2)
    expect(m.georefForPlan('object:o2:plan:modul2')).toBeNull()
  })

  it('an empty pair list clears the sheet rather than storing a hollow entry', async () => {
    const m = await booted({ georefByPlan: { [KEY]: georef(2) } })
    await m.saveGeoref(KEY, { pairs: [] })
    expect(m.georefForPlan(KEY)).toBeNull()
    expect(written().georefByPlan).toEqual({})
  })

  it('saving a georeference leaves the scale half of the document intact', async () => {
    const m = await booted({ default: scale(100), byPlan: { p1: scale(50) } })
    await m.saveGeoref(KEY, georef(3))
    expect(m.resolvePlanScale('p1', undefined, AR)?.mPerU).toBe(50)
    expect(m.georefForPlan(KEY)?.pairs).toHaveLength(3)
  })

  it('keeps rapid writes for several Modules in one ordered station document', async () => {
    const m = await booted({})
    let releaseFirst!: () => void
    apiPut
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve }))
      .mockResolvedValueOnce(undefined)

    const first = m.saveGeoref('object:o1:plan:modul1', georef(2))
    const second = m.saveGeoref('object:o1:plan:modul2', georef(3))
    await vi.waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1))
    expect((apiPut.mock.calls[0][1] as StationPlanScales).georefByPlan).toHaveProperty('object:o1:plan:modul1')

    releaseFirst()
    await Promise.all([first, second])
    expect(apiPut).toHaveBeenCalledTimes(2)
    const final = apiPut.mock.calls[1][1] as StationPlanScales
    expect(Object.keys(final.georefByPlan)).toEqual([
      'object:o1:plan:modul1',
      'object:o1:plan:modul2',
    ])
  })
})

/* The optimistic-concurrency guard (phase 3). A whole-document PUT where the last writer wins was
 * survivable while it only cost a calibration; since the unified tactical object the georeference
 * is BAKED into every symbol standing on the sheet, so a lost update MOVES objects on the Karte —
 * and the «Referenz angepasst» row that says so is written by the device that overwrote, not by
 * the one whose correction was lost. */
describe('If-Match — a write that would overwrite somebody else', () => {
  it('sends the version it last read, and never stores it in the document', async () => {
    const m = await booted({}, 'v7')
    await m.saveGeoref(KEY, georef(2))
    expect(sentToken(0)).toBe('v7')
    expect(written()).not.toHaveProperty('version')
  })

  it('the NEXT write sends the token the previous PUT came back with', async () => {
    // ⚠️ Read inside the queued step, not when the write was scheduled: the second write's base is
    // the document the first one stored, so an older token would refuse it against ourselves.
    const m = await booted({}, 'v7')
    apiPut.mockResolvedValue({ version: 'v8' })
    await m.saveGeoref('object:o1:plan:modul1', georef(2))
    await m.saveGeoref('object:o1:plan:modul2', georef(2))
    expect(sentToken(1)).toBe('v8')
  })

  it('a 409 re-reads and RE-APPLIES the change on top of the other device’s document', async () => {
    const m = await booted({ default: scale(100) }, 'v1')
    apiPut.mockRejectedValueOnce(new ApiError(409)).mockResolvedValueOnce({ version: 'v3' })
    // …meanwhile another device referenced a different Modul and stored it as v2
    apiGet.mockResolvedValue(served({ default: scale(100), georefByPlan: { elsewhere: georef(2) } }, 'v2'))

    await m.saveGeoref(KEY, georef(3))

    expect(apiPut).toHaveBeenCalledTimes(2)
    expect(sentToken(1)).toBe('v2')
    const retried = apiPut.mock.calls[1][1] as StationPlanScales
    // BOTH references survive — the recovery re-runs the per-plan merge rather than re-sending
    // the body it had built, which is what the token was there to prevent
    expect(Object.keys(retried.georefByPlan).sort()).toEqual([KEY, 'elsewhere'].sort())
    expect(retried.default?.mPerU).toBe(100)
    expect(m.georefForPlan('elsewhere')?.pairs).toHaveLength(2)
  })

  it('…once, and then the failure is the caller’s', async () => {
    const m = await booted({}, 'v1')
    apiPut.mockRejectedValue(new ApiError(409))
    apiGet.mockResolvedValue(served({}, 'v2'))
    await expect(m.saveGeoref(KEY, georef(2))).rejects.toThrow()
    expect(apiPut).toHaveBeenCalledTimes(2) // no loop: two devices racing is not ours to settle
  })

  it('a re-read that cannot reach the server leaves the local document alone', async () => {
    // recovering from «you are out of date» must NOT fall back to the offline cache — that is by
    // definition not the document the server refused us over
    const m = await booted({ default: scale(100) }, 'v1')
    apiPut.mockRejectedValue(new ApiError(409))
    apiGet.mockRejectedValue(new Error('offline'))
    await expect(m.saveGeoref(KEY, georef(2))).rejects.toThrow()
    expect(apiPut).toHaveBeenCalledTimes(1)
    expect(m.getStationPlanScales().default?.mPerU).toBe(100)
  })

  it('a refused write stops being the local truth — singleton, cache and the NEXT write', async () => {
    /* ⚠️ The write is optimistic, and a refusal used to leave the refused document standing. The
     * operator was told «fehlgeschlagen» while the sheet went on showing the rejected reference, a
     * reload adopted it back out of the cache, and the next unrelated save read-modify-wrote on
     * top of it — smuggling the refused georeference in as a side effect of a Massstab. */
    const m = await booted({ default: scale(100) }, 'v1')
    apiPut.mockRejectedValue(new ApiError(409))
    apiGet.mockResolvedValue(served({ default: scale(100) }, 'v2'))
    await expect(m.saveGeoref(KEY, georef(2))).rejects.toThrow()

    expect(m.georefForPlan(KEY)).toBeNull()                       // not on the surfaces
    const cached = idbSet.mock.calls[idbSet.mock.calls.length - 1][1] as StationPlanScales
    expect(cached.georefByPlan).toEqual({})                       // …nor in the offline cache
    expect(m.getStationPlanScales().default?.mPerU).toBe(100)     // …and the rest is intact

    // …and the next, unrelated write does not carry it either
    apiPut.mockReset(); apiPut.mockResolvedValue({ version: 'v3' })
    await m.saveStationDefault(scale(42))
    expect(written().georefByPlan).toEqual({})
    expect(written().default?.mPerU).toBe(42)
  })

  it('an ordinary rejection rolls back too — it is not only about 409', async () => {
    const m = await booted({ default: scale(100) }, 'v1')
    apiPut.mockRejectedValue(new Error('offline'))
    await expect(m.saveStationPlanOverride('p1', scale(50))).rejects.toThrow()
    expect(m.getStationPlanScales()).toEqual(doc({ default: scale(100) }))
  })

  /* ⚠️ …and it SAYS it rolled back. The restored document is byte-for-byte the one that was there
   * before, so nothing downstream can tell the rollback from a second operator correcting the
   * reference back — which is exactly what the fit reader did, journalling «Referenz angepasst» a
   * second time and laying a ↶ over an act the server had already refused. */
  it('a rollback announces itself, once', async () => {
    const m = await booted({ default: scale(100) }, 'v1')
    expect(m.takeRolledBackStationWrite()).toBe(false) // nothing has failed yet
    apiPut.mockRejectedValue(new Error('offline'))
    await expect(m.saveStationPlanOverride('p1', scale(50))).rejects.toThrow()
    expect(m.takeRolledBackStationWrite()).toBe(true)
    // consumed by the taking: a refused write that moved no fit must not leave the flag armed for
    // the operator's NEXT real correction
    expect(m.takeRolledBackStationWrite()).toBe(false)
  })

  it('…and a write that LANDS announces nothing', async () => {
    const m = await booted({ default: scale(100) }, 'v1')
    await m.saveStationPlanOverride('p1', scale(50))
    expect(m.takeRolledBackStationWrite()).toBe(false)
  })

  it('…but never over a LATER write that landed', async () => {
    // rolling back on identity, not unconditionally: the failing write's base must not revert
    // somebody else's change that has since become the local document
    const m = await booted({}, 'v1')
    let refuseFirst!: (e: unknown) => void
    apiPut
      .mockImplementationOnce(() => new Promise((_, rej) => { refuseFirst = rej }))
      .mockResolvedValue({ version: 'v2' })

    // both calls move the singleton at once; only their PUTs are queued behind each other
    const first = m.saveStationPlanScales(doc({ default: scale(11) }))
    const second = m.saveStationPlanScales(doc({ default: scale(22) }))
    expect(m.getStationPlanScales().default?.mPerU).toBe(22)

    await vi.waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1)) // the queue got to the first
    refuseFirst(new Error('offline'))
    await expect(first).rejects.toThrow()
    await second
    expect(m.getStationPlanScales().default?.mPerU).toBe(22)
  })

  it('a device that booted out of its cache writes without a token — and still writes', async () => {
    // it holds a document the server confirmed at SOME point and no token at all. Refusing here
    // would mean a Georeferenz that cannot be saved in the field; the endpoint accepts it.
    const m = await load()
    apiGet.mockRejectedValue(new Error('offline'))
    idbGet.mockResolvedValue(doc({ default: scale(100) }))
    await m.loadStationPlanScales()
    await m.saveGeoref(KEY, georef(2))
    expect(sentToken(0)).toBeUndefined()
    expect(written().default?.mPerU).toBe(100)
  })
})

// ⚠️ The PUT replaces the WHOLE document and the column has no history — so a read-modify-write on
// top of a document that was never read is not a lost update, it is the permanent loss of every
// Massstab the station ever calibrated. The If-Match guard cannot catch this one: a device that
// never read the document holds no token either.
describe('a write never builds on a document that never loaded', () => {
  it('refuses when the boot load failed with a cold cache', async () => {
    const m = await load()
    apiGet.mockRejectedValue(new Error('offline'))
    await m.loadStationPlanScales()
    // …and this is the trap: it looks EXACTLY like a station that has calibrated nothing yet
    expect(m.getStationPlanScales()).toEqual(doc({}))
    await expect(m.saveGeoref(KEY, georef(2))).rejects.toThrow()
    expect(apiPut).not.toHaveBeenCalled()
  })

  it('writes on a document that loaded and is genuinely empty', async () => {
    const m = await booted({})
    await m.saveGeoref(KEY, georef(2))
    expect(apiPut).toHaveBeenCalledTimes(1)
  })

  it('counts the offline cache as a real document — it is what the server last confirmed', async () => {
    const m = await load()
    apiGet.mockRejectedValue(new Error('offline'))
    idbGet.mockResolvedValue(doc({ default: scale(100) }))
    await m.loadStationPlanScales()
    await m.saveGeoref(KEY, georef(2))
    expect(written().default?.mPerU).toBe(100)
  })

  it('retries the GET once, and the recovered document is what the georeference merges into', async () => {
    const m = await load()
    apiGet.mockRejectedValue(new Error('offline'))
    await m.loadStationPlanScales()
    apiGet.mockResolvedValue(doc({ default: scale(100), byPlan: { p1: scale(50) } }))
    await m.saveGeoref(KEY, georef(2))
    expect(written().default?.mPerU).toBe(100)
    expect(written().byPlan.p1.mPerU).toBe(50) // the override an offline write would have wiped
    expect(written().georefByPlan[KEY].pairs).toHaveLength(2)
  })

  it('refuses a station default the same way — every writer shares the one merge base', async () => {
    const m = await load()
    apiGet.mockRejectedValue(new Error('offline'))
    await m.loadStationPlanScales()
    await expect(m.saveStationDefault(scale(100))).rejects.toThrow()
    await expect(m.saveStationPlanOverride('p1', scale(50))).rejects.toThrow()
    expect(apiPut).not.toHaveBeenCalled()
  })
})

// The document is STATION data: a Massstab or a Georeferenz set on the KP tablet has to reach
// the phone in the same Einsatz. The boot load runs once, so `refreshStationPlanScales` is the
// only path by which an already-running device ever learns about it.
describe('refreshStationPlanScales — a second device picks up the change', () => {
  it('adopts a georeference set on another device and tells its subscribers', async () => {
    const m = await booted({})
    const seen = vi.fn()
    m.subscribeStationPlanScales(seen)

    apiGet.mockResolvedValue(doc({ georefByPlan: { m1: georef(2) } }))
    await m.refreshStationPlanScales()

    expect(m.georefForPlan('m1')?.pairs).toHaveLength(2)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('stays silent when the server answers with what we already have', async () => {
    const m = await booted({ default: scale(100) })
    const seen = vi.fn()
    m.subscribeStationPlanScales(seen)

    apiGet.mockResolvedValue(doc({ default: scale(100) }))
    await m.refreshStationPlanScales()

    expect(seen).not.toHaveBeenCalled()
  })

  it('keeps the resolved document when the refresh fetch fails', async () => {
    const m = await booted({ default: scale(100) })
    apiGet.mockRejectedValue(new Error('offline'))
    await m.refreshStationPlanScales()
    expect(m.getStationPlanScales().default?.mPerU).toBe(100)
  })

  it('does not let an in-flight GET land on top of a local write', async () => {
    const m = await booted({ default: scale(100) })
    // the GET is answered only after the local save has already replaced the document
    let answer: (v: unknown) => void = () => {}
    apiGet.mockReturnValue(new Promise((res) => { answer = res }))
    const refreshing = m.refreshStationPlanScales()
    await m.saveStationDefault(scale(42))
    answer(doc({ default: scale(100) }))
    await refreshing

    expect(m.getStationPlanScales().default?.mPerU).toBe(42)
  })
})

describe('stationPlanScalesLoaded', () => {
  it('is false until a real document lands, and true once one has — cache included', async () => {
    const m = await load()
    expect(m.stationPlanScalesLoaded()).toBe(false) // an empty singleton is not an answer
    apiGet.mockResolvedValue(doc({}))
    await m.loadStationPlanScales()
    expect(m.stationPlanScalesLoaded()).toBe(true)  // …«this station has none» is one
  })

  it('stays false when the GET failed and no cache answered — «we never found out»', async () => {
    const m = await load()
    apiGet.mockRejectedValue(new Error('offline'))
    await m.loadStationPlanScales()
    expect(m.stationPlanScalesLoaded()).toBe(false)
  })
})

/* The MEASURED aspect (phase 3). The app shell fits every plan through an aspect recovered from
 * its stored calibration, and that number goes stale undetectably when a Modul PDF is replaced —
 * staleness is measured against the very aspect being looked for, and the pairs were fitted at the
 * same wrong one. Since the fit is baked into every symbol on the sheet, that is a wrong POSITION
 * in the record. Only the surface holding the bitmap can break the circle. */
describe('noteMeasuredAspect — the sheet says what shape it is', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('stores the measurement when it really disagrees, and leaves the calibration alone', async () => {
    const m = await booted({ default: scale(100, 0.707), byPlan: { p1: scale(50, 0.707) } })
    m.noteMeasuredAspect(KEY, 0.75, 0.707)
    await settle()
    expect(written().measuredArByPlan[KEY]).toBe(0.75)
    // ⚠️ the calibration is UNTOUCHED — `ar · mPerU` is the sheet's ground width, so correcting
    // `ar` in place would silently rescale every measured distance on the plan
    expect(written().default).toEqual(scale(100, 0.707))
    expect(written().byPlan.p1).toEqual(scale(50, 0.707))
  })

  it('says nothing when the app is already fitting through that shape', async () => {
    const m = await booted({})
    m.noteMeasuredAspect(KEY, 0.7072, 0.70721) // the A4 seed's own rounding
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
  })

  it('…and nothing below the 2 % the calibration’s own staleness uses', async () => {
    const m = await booted({})
    m.noteMeasuredAspect(KEY, 0.707 * 1.015, 0.707)
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
  })

  it('writes once per sheet per session, however often the surface offers it', async () => {
    const m = await booted({})
    m.resetMeasuredAspectSession()
    m.noteMeasuredAspect(KEY, 0.75, 0.707)
    m.noteMeasuredAspect(KEY, 0.75, 0.707)
    m.noteMeasuredAspect(KEY, 0.76, 0.707)
    await settle()
    expect(apiPut).toHaveBeenCalledTimes(1)
  })

  it('never writes from a handed-over LINK page, whatever the device is signed in as', async () => {
    // the Atemschutz link's PUT is refused by the server anyway — attempting it was dishonest —
    // and a VIEW link on an editor's device would have been ALLOWED, which is the one that matters
    const m = await booted({})
    onLinkPage.mockReturnValue(true)
    m.noteMeasuredAspect(KEY, 0.75, 0.707)
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
  })

  it('refuses a shape that is not one — a 0, or a pixel count', async () => {
    const m = await booted({})
    m.noteMeasuredAspect(KEY, 0, 0.707)
    m.noteMeasuredAspect(KEY, Number.NaN, 0.707)
    await settle()
    expect(apiPut).not.toHaveBeenCalled()
  })

  it('a failed write is swallowed and offered again — nobody asked for this correction', async () => {
    const m = await booted({})
    apiPut.mockRejectedValueOnce(new Error('offline'))
    m.noteMeasuredAspect(KEY, 0.75, 0.707)
    await settle()
    expect(apiPut).toHaveBeenCalledTimes(1)
    apiPut.mockResolvedValue({ version: 'v2' })
    m.noteMeasuredAspect(KEY, 0.75, 0.707)
    await settle()
    expect(apiPut).toHaveBeenCalledTimes(2)
  })
})
