import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetLayerData, layerDataSnapshot, loadLayerData, subscribeLayerData, type LayerData } from './layerData'

/** a Response whose body arrives in chunks, the way a multi-megabyte Leitungen file does */
function streamed(text: string, { size = true, status = 200, gzipped = false } = {}) {
  const bytes = new TextEncoder().encode(text)
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let at = 0; at < bytes.length; at += 64) c.enqueue(bytes.slice(at, at + 64))
      c.close()
    },
  })
  const headers: Record<string, string> = {}
  // the API gzips: Content-Length is the COMPRESSED size, X-Raw-Bytes the one to divide by
  if (gzipped) {
    headers['Content-Encoding'] = 'gzip'
    headers['Content-Length'] = String(Math.round(bytes.length / 4))
  }
  if (size) headers[gzipped ? 'X-Raw-Bytes' : 'Content-Length'] = String(bytes.length)
  return new Response(body, { status, headers })
}

const fc = (n: number) => JSON.stringify({
  type: 'FeatureCollection',
  features: Array.from({ length: n }, (_, i) => ({
    type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: [7.5, 47.5] },
  })),
})

const peek = (id: string) => layerDataSnapshot().get(id)

/** the store settles asynchronously (fetch → stream → parse) */
async function settled(id: string) {
  for (let i = 0; i < 100 && (peek(id)?.state ?? 'loading') === 'loading'; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  return peek(id)
}

afterEach(() => { __resetLayerData(); vi.unstubAllGlobals() })

describe('lib/layerData — a GeoJSON Ebene reports its own download', () => {
  it('hands the parsed collection on and counts its features', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamed(fc(3))))
    loadLayerData('leitungen', '/data/leitungen.geojson')
    const entry = await settled('leitungen')
    expect(entry).toMatchObject({ state: 'ready', features: 3 })
    expect((entry as Extract<LayerData, { state: 'ready' }>).data.features).toHaveLength(3)
  })

  it('counts the bytes as they arrive, against the size the server announced', async () => {
    const text = fc(60)
    const bytes = new TextEncoder().encode(text).length
    vi.stubGlobal('fetch', vi.fn(async () => streamed(text)))
    const seen: LayerData[] = []
    const stop = subscribeLayerData(() => { const e = peek('leitungen'); if (e) seen.push(e) })
    loadLayerData('leitungen', '/data/leitungen.geojson')
    await settled('leitungen')
    stop()
    const progress = seen.filter((e): e is Extract<LayerData, { state: 'loading' }> => e.state === 'loading')
    const last = progress[progress.length - 1]
    // the row can say «x von y»: a real number out of a real total, never a guess
    expect(last).toMatchObject({ total: bytes })
    expect(last.loaded).toBeGreaterThan(0)
    expect(last.loaded).toBeLessThanOrEqual(bytes)
  })

  it('without a Content-Length there is no bar to fill — the loader stands alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamed(fc(4), { size: false })))
    const seen: LayerData[] = []
    const stop = subscribeLayerData(() => { const e = peek('leitungen'); if (e) seen.push(e) })
    loadLayerData('leitungen', '/data/leitungen.geojson')
    await settled('leitungen')
    stop()
    expect(seen.filter((e) => e.state === 'loading').every((e) => e.total === null)).toBe(true)
  })

  it('divides by the raw size, not by the gzipped Content-Length', async () => {
    const text = fc(60)
    const bytes = new TextEncoder().encode(text).length
    vi.stubGlobal('fetch', vi.fn(async () => streamed(text, { gzipped: true })))
    const seen: LayerData[] = []
    const stop = subscribeLayerData(() => { const e = peek('leitungen'); if (e) seen.push(e) })
    loadLayerData('leitungen', '/data/leitungen.geojson')
    await settled('leitungen')
    stop()
    const progress = seen.filter((e): e is Extract<LayerData, { state: 'loading' }> => e.state === 'loading')
    expect(progress[progress.length - 1]).toMatchObject({ total: bytes })
    // …and a gzipped answer that states no raw size has no honest bar at all
    __resetLayerData()
    vi.stubGlobal('fetch', vi.fn(async () => streamed(text, { gzipped: true, size: false })))
    const seen2: LayerData[] = []
    const stop2 = subscribeLayerData(() => { const e = peek('schieber'); if (e) seen2.push(e) })
    loadLayerData('schieber', '/data/schieber.geojson')
    await settled('schieber')
    stop2()
    expect(seen2.filter((e) => e.state === 'loading').every((e) => e.total === null)).toBe(true)
  })

  it('an empty file says so instead of looking like it is still loading', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamed(fc(0))))
    loadLayerData('quellen', '/data/quellen.geojson')
    expect(await settled('quellen')).toEqual({ state: 'empty' })
  })

  it('a refused file fails, and switching the layer on again tries once more', async () => {
    const fetchMock = vi.fn(async () => streamed('nope', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    loadLayerData('schieber', '/data/schieber.geojson')
    expect(await settled('schieber')).toEqual({ state: 'failed' })
    fetchMock.mockImplementation(async () => streamed(fc(2)))
    loadLayerData('schieber', '/data/schieber.geojson')
    expect(await settled('schieber')).toMatchObject({ state: 'ready', features: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never downloads the same file twice', async () => {
    const fetchMock = vi.fn(async () => streamed(fc(1)))
    vi.stubGlobal('fetch', fetchMock)
    loadLayerData('hydranten', '/data/hydranten.geojson')
    loadLayerData('hydranten', '/data/hydranten.geojson')
    await settled('hydranten')
    loadLayerData('hydranten', '/data/hydranten.geojson')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
