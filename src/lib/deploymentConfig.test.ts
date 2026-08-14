import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alarmProviderName, getDeploymentConfig, loadDeploymentConfig, loadDeploymentConfigBounded, mapReferenceLayers, personnelProviderName, reportLinks, stripLocality } from './deploymentConfig'
import { idbSet, __resetIdbForTests } from './idb'

describe('mapReferenceLayers', () => {
  it('returns [] for missing/empty input', () => {
    expect(mapReferenceLayers(undefined)).toEqual([])
    expect(mapReferenceLayers([])).toEqual([])
  })

  it('maps a geojson point layer with its symbol + colours', () => {
    const [l] = mapReferenceLayers([
      {
        id: 'hydrant', group: 'Wasser', label: 'Hydranten', icon: 'drop', kind: 'geojson',
        geojson: '/api/reference/geo:hydrant', vectorKind: 'point', symbol: 'SI Ueberflurhydrant',
        color: '#0f52b5', nightColor: '#5b9bff', opacity: 100, attribution: '© FireGIS',
      },
    ])
    expect(l).toMatchObject({
      id: 'hydrant', group: 'Wasser', label: 'Hydranten', base: false, visible: false,
      geojson: '/api/reference/geo:hydrant', vectorKind: 'point', symbol: 'SI Ueberflurhydrant',
      color: '#0f52b5', nightColor: '#5b9bff', opacity: 100,
    })
  })

  it('defaults vectorKind to line and supplies group/label/icon fallbacks', () => {
    const [l] = mapReferenceLayers([{ id: 'leitung', kind: 'geojson', geojson: '/api/reference/geo:leitung' }])
    expect(l).toMatchObject({ id: 'leitung', group: 'Referenz', label: 'leitung', icon: 'map', vectorKind: 'line' })
  })

  it('passes autoActivate through, dropping an empty list', () => {
    const [a, b] = mapReferenceLayers([
      { id: 'hydrant', kind: 'geojson', geojson: '/api/reference/geo:hydrant', autoActivate: ['Brandbekämpfung'] },
      { id: 'leitung', kind: 'geojson', geojson: '/api/reference/geo:leitung', autoActivate: [] },
    ])
    expect(a.autoActivate).toEqual(['Brandbekämpfung'])
    expect(b.autoActivate).toBeUndefined()
  })

  it('maps a wms/wmts layer to a raster overlay with tiles', () => {
    const [l] = mapReferenceLayers([
      { id: 'flood', group: 'Gefahren', label: 'Hochwasser', kind: 'wms', tiles: ['https://x/{z}/{x}/{y}'], opacity: 65 },
    ])
    expect(l).toMatchObject({ id: 'flood', base: false, tiles: ['https://x/{z}/{x}/{y}'], opacity: 65 })
    expect(l.geojson).toBeUndefined()
  })

  it('skips entries missing an id or their required source', () => {
    expect(mapReferenceLayers([
      { group: 'Wasser', kind: 'geojson', geojson: '/x' },                  // no id
      { id: 'no-url', kind: 'geojson' },                                    // geojson layer, no url
      { id: 'inline', kind: 'geojson', geojson: { type: 'FeatureCollection' } }, // inline object unsupported
      { id: 'no-tiles', kind: 'wms', tiles: [] },                           // wms, no tiles
    ])).toEqual([])
  })
})

describe('stripLocality — home town off compact addresses', () => {
  it('strips the Divera prefix form «Town (KT), street»', () => {
    expect(stripLocality('Musterdorf (BL), Schlossgasse 9', '4104 Musterdorf BL')).toBe('Schlossgasse 9')
    expect(stripLocality('Musterdorf BL, Bachweg 1', 'Musterdorf (BL)')).toBe('Bachweg 1')
  })

  it('strips the swisstopo suffix form «street, PLZ Town»', () => {
    expect(stripLocality('Bachweg 3, 4104 Musterdorf', '4104 Musterdorf BL')).toBe('Bachweg 3')
    expect(stripLocality('Dorfplatz 12, Musterdorf', 'Musterdorf')).toBe('Dorfplatz 12')
  })

  it('leaves OUT-of-town addresses untouched (they should stand out)', () => {
    expect(stripLocality('Nachbarwil (BL), Bahnhofstrasse 2', '4104 Musterdorf BL')).toBe('Nachbarwil (BL), Bahnhofstrasse 2')
    expect(stripLocality('Muristrasse 5, 4054 Basel', '4104 Musterdorf BL')).toBe('Muristrasse 5, 4054 Basel')
  })

  it('never matches inside a longer word (Musterdorferstrasse stays intact)', () => {
    expect(stripLocality('Musterdorferstrasse 5, 4054 Basel', 'Musterdorf')).toBe('Musterdorferstrasse 5, 4054 Basel')
  })

  it('degrades safely: empty locality, and a town-only address returns itself', () => {
    expect(stripLocality('Musterdorf (BL), Bachweg 1', null)).toBe('Musterdorf (BL), Bachweg 1')
    expect(stripLocality('Musterdorf (BL)', '4104 Musterdorf BL')).toBe('Musterdorf (BL)')
  })
})

// loadDeploymentConfigBounded guards the ONE await that sits before createRoot. While it is
// pending the operator sees an empty #root — no splash, no error boundary, nothing to tap —
// and killing the app just re-runs the same stall. So it must ALWAYS settle within its budget,
// serving the offline cache rather than holding first paint.
describe('loadDeploymentConfigBounded — first paint is never held hostage', () => {
  const CACHE_KEY = 'kp-front-deployment-config'
  const fetchMock = vi.fn()

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    __resetIdbForTests()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  it('returns the fresh config when the network answers inside the budget', async () => {
    fetchMock.mockResolvedValueOnce(json({ identity: { appName: 'Fresh' } }))
    const cfg = await loadDeploymentConfigBounded(2_000)
    expect(cfg.identity?.appName).toBe('Fresh')
  })

  it('falls back to the cached config when the request never settles', async () => {
    await idbSet(CACHE_KEY, { identity: { appName: 'Cached' } })
    fetchMock.mockReturnValueOnce(new Promise(() => { /* a half-open connection: never settles */ }))
    const cfg = await loadDeploymentConfigBounded(30)
    expect(cfg.identity?.appName).toBe('Cached')
    // ...and the synchronous accessor is seeded too, so read sites get the STATION's config
    // from the very first render instead of national defaults.
    expect(getDeploymentConfig().identity?.appName).toBe('Cached')
  })

  it('resolves to {} on a stalled request with no cache (first-ever boot) — never hangs', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}))
    await expect(loadDeploymentConfigBounded(30)).resolves.toEqual({})
  })
})

// ⚠️ Copy must never hard-code «Divera». Every station saw «übernimm einen Divera-Alarm» — the
// ones on another source, and the ones entering every Einsatz by hand, who were being pointed at
// a product they do not have. The neutral sentence is the default; naming a source is the
// exception, and `null` here is what selects it.
describe('naming the Alarm-/Personalquelle only where there is one', () => {
  const load = async (cfg: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(cfg), {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    await loadDeploymentConfig()
  }
  afterEach(() => { vi.unstubAllGlobals() })

  it('is null on a station with no integrations at all — the hand-entry case', async () => {
    await load({})
    expect(alarmProviderName()).toBeNull()
    expect(personnelProviderName()).toBeNull()
  })

  it('is null when a provider is registered but NOT configured', async () => {
    // «registered» is a code capability; «configured» is env. Only the second one means a
    // station can actually take an alarm, and unset must not look like working.
    await load({ integrations: { alarms: { provider: 'divera', configured: false, capabilities: [] } } })
    expect(alarmProviderName()).toBeNull()
  })

  it('names whichever provider this station runs, not Divera by default', async () => {
    await load({ integrations: { alarms: { provider: 'ilias', configured: true, capabilities: [] } } })
    expect(alarmProviderName()).toBe('Ilias')
  })

  it('still answers for an older backend that only sends the legacy flag', async () => {
    await load({ integrations: { diveraConfigured: true } })
    expect(alarmProviderName()).toBe('Divera')
    expect(personnelProviderName()).toBe('Divera')
  })

  it('keeps the two sources apart — a station can sync people without taking alarms', async () => {
    await load({ integrations: { personnel: { provider: 'divera', configured: true, capabilities: [] } } })
    expect(personnelProviderName()).toBe('Divera')
    expect(alarmProviderName()).toBeNull()
  })
})

// `reportLinks()` is the boundary the whole «Formulare & Links» feature rests on: whatever it
// returns is rendered on the Rapport and handed to `window.open`. The config document is
// admin-written, but it is still DATA — and it also arrives from the `admin_config` CLI, which
// does not go through the API's validation at all.
describe('reportLinks — what is allowed onto the Rapport', () => {
  const load = async (cfg: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(cfg), {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    await loadDeploymentConfig()
  }
  afterEach(() => { vi.unstubAllGlobals() })

  const withLinks = (links: unknown[]) => load({ report: { links } })
  const ok = { id: 'getraenke', title: 'Getränkeabrechnung', url: 'https://forms.example.ch/f' }

  it('is empty on a station that configured none — which is what removes the section', async () => {
    await load({})
    expect(reportLinks()).toEqual([])
    await load({ report: {} })
    expect(reportLinks()).toEqual([])
  })

  it('passes a configured form through untouched, placeholders and all', async () => {
    await withLinks([{ ...ok, url: 'https://forms.example.ch/f?a={ort}', note: 'nur bei Bezug' }])
    expect(reportLinks()).toHaveLength(1)
    expect(reportLinks()[0].url).toBe('https://forms.example.ch/f?a={ort}')
  })

  it('drops a URL this app would refuse to open', async () => {
    // ⚠️ The one that matters: an href out of the config document must never be able to run.
    await withLinks([{ ...ok, url: 'javascript:alert(1)' }])
    expect(reportLinks()).toEqual([])
    await withLinks([{ ...ok, url: 'data:text/html,<script>alert(1)</script>' }])
    expect(reportLinks()).toEqual([])
    await withLinks([{ ...ok, url: '//evil.example' }])
    expect(reportLinks()).toEqual([])
  })

  it('drops a row with nothing to show or nothing to file the tick under', async () => {
    await withLinks([{ ...ok, title: '   ' }])
    expect(reportLinks()).toEqual([])
    await withLinks([{ ...ok, id: '' }])
    expect(reportLinks()).toEqual([])
  })

  it('drops only the bad row, never the good ones beside it', async () => {
    await withLinks([{ ...ok, url: 'javascript:alert(1)' }, { ...ok, id: 'schaden' }])
    expect(reportLinks().map((l) => l.id)).toEqual(['schaden'])
  })

  it('survives junk in the document rather than taking the Rapport down with it', async () => {
    // reachable via `admin_config load` of a hand-edited file
    await withLinks([null, 'nonsense', {}])
    expect(reportLinks()).toEqual([])
  })
})
