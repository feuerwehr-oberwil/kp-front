import { afterEach, describe, expect, it, vi } from 'vitest'
import { fillTileTemplate, predownloadArea, tileBbox3857, tilesForBounds } from './offlineTiles'

// A one-tile box at the coarsest zoom, so a run is three fetches and not twelve hundred.
const BOX = { west: 7.5, south: 47.5, east: 7.5001, north: 47.5001 }
const opts = { templates: ['https://tiles.test/{z}/{x}/{y}.png'], bounds: BOX, minZoom: 14, maxZoom: 14 }

afterEach(() => { vi.unstubAllGlobals() })

/** A `fetch` that answers each URL according to `answer` — `ok`, a 404, a 5xx, or a thrown
 *  network error, which is what an offline device produces. */
function stubFetch(answer: (url: string) => 'ok' | 'notfound' | 'servererror' | 'offline') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const a = answer(url)
    if (a === 'offline') throw new TypeError('Failed to fetch')
    return { ok: a === 'ok', status: a === 'ok' ? 200 : a === 'notfound' ? 404 : 502 } as Response
  }))
}

describe('predownloadArea reports HITS, not attempts', () => {
  it('counts tiles and warm resources separately when everything arrives', async () => {
    stubFetch(() => 'ok')
    const res = await predownloadArea({ ...opts, warmUrls: ['/plan.pdf', '/hydranten.geojson'] })
    expect(res).toMatchObject({ fetched: res.total, warmFetched: 2, warmTotal: 2, notFound: 0, failed: 0, capped: false })
    expect(res.total).toBe(tilesForBounds(BOX, 14, 14).length)
  })

  it('warms every raster reference layer over the same covered tile grid', async () => {
    stubFetch(() => 'ok')
    const fetchMock = vi.mocked(fetch)
    const covered = tilesForBounds(BOX, 14, 14).length
    const res = await predownloadArea({
      ...opts,
      overlayTemplates: [
        ['https://wms.test/?BBOX={bbox-epsg-3857}'],
        ['https://wmts-a.test/{z}/{x}/{y}', 'https://wmts-b.test/{z}/{x}/{y}'],
      ],
    })
    expect(res.total).toBe(covered * 3) // base + WMS + WMTS, not one template chosen per tile
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('BBOX=') && !String(url).includes('{bbox'))).toBe(true)
  })

  // The reported bug, in one assertion: a device on dead WLAN used to reach 100 % and toast a
  // green «Karte offline verfügbar (0 Kacheln)». Nothing arrived, and the result has to say so.
  it('reports nothing fetched when every request fails', async () => {
    stubFetch(() => 'offline')
    const res = await predownloadArea({ ...opts, warmUrls: ['/plan.pdf'] })
    expect(res.fetched).toBe(0)
    expect(res.warmFetched).toBe(0)
    expect(res.failed).toBe(res.total + res.warmTotal)
    expect(res.total + res.warmTotal).toBeGreaterThan(0)
  })

  // ⚠️ A resolved `fetch` is not a cached tile. A 404 or a 502 resolves perfectly happily, which
  // is how «1240 Kacheln» came to mean «1240 attempts». But the two are DIFFERENT misses: a 404
  // means the tile does not exist (out of coverage at a layer's edge) and is done for good, a
  // 5xx/network failure is retryable. Filing 404s under «failed» kept «Teilweise geladen …
  // Weiterladen» on screen for ever over an area that was as complete as it can get.
  it('files a 404 under notFound (done), not under failed (retryable)', async () => {
    stubFetch((url) => (url.endsWith('.pdf') ? 'ok' : 'notfound'))
    const res = await predownloadArea({ ...opts, warmUrls: ['/plan.pdf'] })
    expect(res.fetched).toBe(0)
    expect(res.warmFetched).toBe(1)
    expect(res.notFound).toBe(res.total)
    expect(res.failed).toBe(0)
  })

  it('files a 5xx under failed — a «Weiterladen» can still fetch it', async () => {
    stubFetch((url) => (url.endsWith('.pdf') ? 'ok' : 'servererror'))
    const res = await predownloadArea({ ...opts, warmUrls: ['/plan.pdf'] })
    expect(res.fetched).toBe(0)
    expect(res.failed).toBe(res.total)
    expect(res.notFound).toBe(0)
  })
})

describe('raster template expansion', () => {
  it('fills MapLibre WMS bbox templates in EPSG:3857', () => {
    expect(tileBbox3857(0, 0, 0)).toBe('-20037508.342789244,-20037508.342789244,20037508.342789244,20037508.342789244')
    expect(fillTileTemplate('https://wms.test/?BBOX={bbox-epsg-3857}&Z={z}&X={x}&Y={y}', 1, 1, 0))
      .toBe('https://wms.test/?BBOX=0,0,20037508.342789244,20037508.342789244&Z=1&X=1&Y=0')
  })
})

describe('predownloadArea can be cancelled', () => {
  // The bar had no «Abbrechen» and the download no bound: on a half-open link the workers hung
  // for ever and the manual button stayed dead for the session. A cancel stops issuing
  // requests and REJECTS — a cancelled download must not toast «teilweise geladen».
  it('stops after the abort and rejects with the reason', async () => {
    const ctrl = new AbortController()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++
      ctrl.abort(new Error('cancelled'))
      return { ok: true, status: 200 } as Response
    }))
    const many = { ...opts, maxZoom: 16, warmUrls: ['/plan.pdf'], concurrency: 1, signal: ctrl.signal }
    await expect(predownloadArea(many)).rejects.toThrow('cancelled')
    expect(calls).toBe(1)
    expect(tilesForBounds(BOX, 14, 16).length + 1).toBeGreaterThan(calls)
  })

  it('bounds every tile request', async () => {
    stubFetch(() => 'ok')
    await predownloadArea(opts)
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})
