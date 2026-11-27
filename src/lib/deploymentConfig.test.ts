import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { adoptSessionConfig, alarmProviderName, applyCaptureConfig, atemschutzDoctrine, incidentCategories, atemschutzEquipment, demoNote, ensureSessionConfig, getDeploymentConfig, hasStationConfig, loadDeploymentConfig, bootDeploymentConfig, mapReferenceLayers, mergePartial, moduleAlignment, moduleViewer, offlineRadiusM, personnelProviderName, reportLinks, stripLocality, subscribeDeploymentConfig } from './deploymentConfig'
import { idbGet, idbSet, __resetIdbForTests } from './idb'

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
      // @ts-expect-error the server refuses an inline object; a hand-edited cached copy must still not break the map
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

// bootDeploymentConfig is the ONE await on the config before createRoot. A device that has booted
// before must not wait for the network at all (a round trip per launch, cold-start sweep
// 01.11.2026); a first boot must settle within its budget.
describe('bootDeploymentConfig — the launch never waits for /api/config it already has', () => {
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

  it('serves the cached config at once and hands the fresh one to onFresh', async () => {
    await idbSet(CACHE_KEY, { identity: { appName: 'Cached' } })
    let answer!: (r: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((res) => { answer = res }))
    const onFresh = vi.fn()
    const cfg = await bootDeploymentConfig(2_000, onFresh)
    expect(cfg.identity?.appName).toBe('Cached')
    // the synchronous accessor is seeded too, so read sites get the STATION's config from the
    // very first render
    expect(getDeploymentConfig().identity?.appName).toBe('Cached')

    answer(json({ identity: { appName: 'Fresh' } }))
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalledWith({ identity: { appName: 'Fresh' } }))
    expect(getDeploymentConfig().identity?.appName).toBe('Fresh')
  })

  it('waits for the network on a first boot', async () => {
    fetchMock.mockResolvedValueOnce(json({ identity: { appName: 'Fresh' } }))
    const cfg = await bootDeploymentConfig(2_000, () => {})
    expect(cfg.identity?.appName).toBe('Fresh')
  })

  it('settles with what it has on a stalled first boot — never hangs', async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}))
    // what it has: `{}` on a real first boot; the module singleton outlives single tests here
    await expect(bootDeploymentConfig(30, () => {})).resolves.toBe(getDeploymentConfig())
  })

  it('never lets a late anonymous response replace the authenticated demo config', async () => {
    let resolveAnonymous!: (response: Response) => void
    let resolveAuthenticated!: (response: Response) => void
    fetchMock
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveAnonymous = resolve }))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { resolveAuthenticated = resolve }))

    const anonymous = loadDeploymentConfig()
    const authenticated = loadDeploymentConfig()
    resolveAuthenticated(json({ identity: { demoMode: true }, integrations: { cartoBasemapKey: 'session-key' } }))
    await authenticated
    expect(getDeploymentConfig().integrations?.cartoBasemapKey).toBe('session-key')

    resolveAnonymous(json({ partial: true, identity: { demoMode: true } }))
    await anonymous
    expect(getDeploymentConfig().integrations?.cartoBasemapKey).toBe('session-key')
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
    await load({ integrations: { alarms: { provider: 'ilias', configured: true, capabilities: ['pool', 'take'] } } })
    expect(alarmProviderName()).toBe('Ilias')
  })

  it('is null for a webhook-only station — its Einsätze open by themselves, nothing to take', async () => {
    // ⚠️ The sentence this feeds is «übernimm einen X-Alarm», and the generic webhook has no
    // pool: `admin/DataView` renders no Alarmquelle list for it and the app renders no «Alarm
    // übernehmen». Naming it pointed the operator at an affordance that does not exist.
    await load({
      integrations: {
        alarms: {
          provider: 'webhook', configured: true,
          capabilities: ['generic-webhook', 'auto-open', 'lifecycle'],
        },
      },
    })
    expect(alarmProviderName()).toBeNull()
  })

  it('is null for a configured provider that declares no capabilities at all', async () => {
    await load({ integrations: { alarms: { provider: 'ilias', configured: true, capabilities: [] } } })
    expect(alarmProviderName()).toBeNull()
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

/* The Ausrüstung list a Trupp picks from (types · Trupp.equipment): the station's own where it
 * has one, the shipped three otherwise — never a mix, and never nothing. */
describe('demoNote — only on a demo deployment', () => {
  const load = async (cfg: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(cfg), {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    await loadDeploymentConfig()
  }
  afterEach(() => { vi.unstubAllGlobals() })
  const note = 'Demo-Zugang · PIN 000000 für alle'

  it('shows the note while demoMode is on', async () => {
    await load({ identity: { demoMode: true, demoNote: note } })
    expect(demoNote()).toBe(note)
  })

  it('hides it once demoMode is off, even though the field is still set', async () => {
    await load({ identity: { demoMode: false, demoNote: note } })
    expect(demoNote()).toBeNull()
    await load({ identity: { demoNote: note } })
    expect(demoNote()).toBeNull()
  })
})

describe('Atemschutz equipment list', () => {
  const load = async (doctrine: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ doctrine }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    await loadDeploymentConfig()
  }
  afterEach(() => { vi.unstubAllGlobals() })

  it('ships Retthaube · WBK · Multiwarn when the station lists nothing', async () => {
    await load({})
    expect(atemschutzEquipment().map((e) => e.id)).toEqual(['retthaube', 'wbk', 'multiwarn'])
  })

  it('lets the station’s own list win outright, dropping entries without id or label', async () => {
    await load({ equipment: [{ id: 'wbk', label: 'Wärmebildkamera' }, { id: '', label: 'x' }, { label: 'no id' }] })
    expect(atemschutzEquipment()).toEqual([{ id: 'wbk', label: 'Wärmebildkamera' }])
  })

  it('falls back to the default when the station’s list is empty after cleaning', async () => {
    await load({ equipment: [{ id: ' ', label: '' }] })
    expect(atemschutzEquipment().map((e) => e.id)).toEqual(['retthaube', 'wbk', 'multiwarn'])
  })
})

describe('incidentCategories — the server owns the Kategorien', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('offers the served German labels in the served order, and nothing before they arrive', async () => {
    const serve = async (body: unknown) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      })))
      await loadDeploymentConfig()
    }
    await serve({ categoryLabels: { strassenrettung: 'Strassenrettung', brandbekaempfung: 'Brandbekämpfung' } })
    expect(incidentCategories()).toEqual(['Strassenrettung', 'Brandbekämpfung'])
    await serve({})
    expect(incidentCategories()).toEqual([])
  })
})

describe('Atemschutz pressure-alarm doctrine', () => {
  const load = async (doctrine: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ doctrine }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    await loadDeploymentConfig()
  }
  afterEach(() => { vi.unstubAllGlobals() })

  it('disables both pressure alarms when the demo uses an Alarmdruck of 0', async () => {
    await load({ alarmBar: 0, alarmBarRueckzug: 50 })
    expect(atemschutzDoctrine()).toMatchObject({ alarmBar: 0, alarmBarRueckzug: 0 })
  })

  it('keeps the shipped Rückzug line for an ordinary Alarmdruck', async () => {
    await load({ alarmBar: 100 })
    expect(atemschutzDoctrine()).toMatchObject({ alarmBar: 100, alarmBarRueckzug: 50 })
  })

  it('clamps the shipped Rückzug line to a lower custom Alarmdruck', async () => {
    await load({ alarmBar: 40 })
    expect(atemschutzDoctrine()).toMatchObject({ alarmBar: 40, alarmBarRueckzug: 40 })
  })

  it('also clamps a stale explicit Rückzug line above the active Alarmdruck', async () => {
    await load({ alarmBar: 40, alarmBarRueckzug: 60 })
    expect(atemschutzDoctrine()).toMatchObject({ alarmBar: 40, alarmBarRueckzug: 40 })
  })

  // the Eingangsdruck minimum (24.09.2026): the station's number, else the shipped 270 — and a
  // stored 0 stays 0, because that is how a station switches the question off
  it('reads the Eingangsdruck minimum off the station, with 270 as the shipped default', async () => {
    await load({})
    expect(atemschutzDoctrine().entryPressureMin).toBe(270)
    await load({ entryPressureMin: 250 })
    expect(atemschutzDoctrine().entryPressureMin).toBe(250)
    await load({ entryPressureMin: 0 })
    expect(atemschutzDoctrine().entryPressureMin).toBe(0)
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

// `/api/config` answers a caller WITHOUT a session with the public parts only (`partial`), and
// the boot fetch IS such a caller on a new device and whenever the access cookie has expired.
// What a partial answer does not hold was withheld, never removed.
describe('a partial answer is merged over the copy on the device, never stored in its place', () => {
  const CACHE_KEY = 'kp-front-deployment-config'
  const fetchMock = vi.fn()
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const STATION = {
    identity: { appName: 'Feuerwehr Musterdorf', kommandant: 'Brunner Thomas', accentColor: '#c4161c', assets: { logo: '/old.png' } },
    fleet: { vehicles: [{ id: 'tlf', label: 'TLF' }] },
    doctrine: { defaultFunkkanal: 11 },
    integrations: { cartoBasemapKey: 'k1', diveraConfigured: true, microsoftLoginConfigured: false },
    version: 'v1',
  }
  const PUBLIC = {
    partial: true as const,
    identity: { appName: 'Feuerwehr Musterdorf', shortName: null, accentColor: '#0055aa', assets: { logo: '/new.png' }, demoMode: false },
    integrations: { microsoftLoginConfigured: true },
  }

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    __resetIdbForTests()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  // the poster's parts live for the page's life: take them off again for the next test
  afterEach(() => { vi.unstubAllGlobals(); applyCaptureConfig({}) })

  it('tells its listeners of every answer, of the poster\'s parts, and of the same objects again not at all', async () => {
    const heard = vi.fn()
    const off = subscribeDeploymentConfig(heard)
    try {
      fetchMock.mockResolvedValueOnce(json(STATION))
      await loadDeploymentConfig()
      fetchMock.mockResolvedValueOnce(json(PUBLIC))
      await loadDeploymentConfig()
      const parts = { identity: { appName: 'Poster' } }
      applyCaptureConfig(parts)
      expect(heard).toHaveBeenCalledTimes(3)
      // the same parts over the same document: nothing changed
      applyCaptureConfig(parts)
      expect(heard).toHaveBeenCalledTimes(3)
    } finally { off() }
    // unsubscribed: hears nothing more
    applyCaptureConfig({})
    expect(heard).toHaveBeenCalledTimes(3)
  })

  it('a listener that throws does not break the load', async () => {
    const off = subscribeDeploymentConfig(() => { throw new Error('listener') })
    try {
      fetchMock.mockResolvedValueOnce(json({ ...STATION, version: 'v3' }))
      await expect(loadDeploymentConfig()).resolves.toMatchObject({ version: 'v3' })
      expect(getDeploymentConfig().version).toBe('v3')
    } finally { off() }
  })

  it('mergePartial updates the parts the answer holds and keeps the rest', () => {
    const out = mergePartial(STATION, PUBLIC)
    expect(out.identity).toEqual({
      appName: 'Feuerwehr Musterdorf', kommandant: 'Brunner Thomas', shortName: null,
      accentColor: '#0055aa', assets: { logo: '/new.png' }, demoMode: false,
    })
    expect(out.fleet).toEqual(STATION.fleet)
    expect(out.doctrine).toEqual(STATION.doctrine)
    expect(out.integrations).toEqual({ cartoBasemapKey: 'k1', diveraConfigured: true, microsoftLoginConfigured: true })
    expect(out.version).toBe('v1')
    expect(out).not.toHaveProperty('partial')
  })

  it('a boot without a session keeps the fleet, the Funkkanal and the basemap key — also in the offline copy', async () => {
    fetchMock.mockResolvedValueOnce(json(STATION))
    await loadDeploymentConfig()
    expect(hasStationConfig()).toBe(true)

    fetchMock.mockResolvedValueOnce(json(PUBLIC))
    const cfg = await loadDeploymentConfig()
    expect(cfg.fleet?.vehicles).toHaveLength(1)
    expect(atemschutzDoctrine().defaultFunkkanal).toBe(11)
    expect(getDeploymentConfig().integrations?.cartoBasemapKey).toBe('k1')
    // …and what the public answer does hold is fresh
    expect(getDeploymentConfig().identity?.accentColor).toBe('#0055aa')
    expect(hasStationConfig()).toBe(true)
    await vi.waitFor(async () => {
      expect(await idbGet(CACHE_KEY)).toMatchObject({ fleet: STATION.fleet, identity: { accentColor: '#0055aa' } })
    })
  })

  it('a session answer still replaces the copy: a section the station emptied goes away', async () => {
    fetchMock.mockResolvedValueOnce(json(STATION))
    await loadDeploymentConfig()
    fetchMock.mockResolvedValueOnce(json({ identity: { appName: 'Feuerwehr Musterdorf' }, version: 'v2' }))
    await loadDeploymentConfig()
    expect(getDeploymentConfig().fleet).toBeUndefined()
    expect(getDeploymentConfig().version).toBe('v2')
  })

  it('ensureSessionConfig reads again after a partial answer, and not after a session answer', async () => {
    fetchMock.mockResolvedValueOnce(json(PUBLIC))
    await loadDeploymentConfig()
    fetchMock.mockResolvedValueOnce(json(STATION))
    await ensureSessionConfig()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getDeploymentConfig().fleet?.vehicles).toHaveLength(1)

    await ensureSessionConfig()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('ensureSessionConfig waits for a read that is still on its way before it decides', async () => {
    let answer!: (r: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((res) => { answer = res }))
    const boot = loadDeploymentConfig()
    fetchMock.mockResolvedValueOnce(json(STATION))
    const ensured = ensureSessionConfig()
    // the boot read was sent before the session was renewed: its answer is partial, and lands late
    answer(json(PUBLIC))
    await boot
    await ensured
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getDeploymentConfig().version).toBe('v1')
  })

  it('a session answer replaces the copy: a removed Formular link and a removed basemap key go away', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...STATION, report: { links: [{ id: 'l1', title: 'Formular', url: 'https://forms.example.org/x' }] } }))
    await loadDeploymentConfig()
    expect(getDeploymentConfig().report?.links).toHaveLength(1)
    fetchMock.mockResolvedValueOnce(json({ ...STATION, integrations: { diveraConfigured: true }, report: { links: [] }, version: 'v2' }))
    await loadDeploymentConfig()
    expect(getDeploymentConfig().report?.links).toEqual([])
    expect(getDeploymentConfig().integrations?.cartoBasemapKey).toBeUndefined()
    await vi.waitFor(async () => { expect(await idbGet(CACHE_KEY)).toMatchObject({ version: 'v2', report: { links: [] } }) })
  })

  it('a late partial answer does not write the snapshot of this tab over a newer document another tab stored', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...STATION, report: { links: [{ id: 'l1', title: 'Formular', url: 'https://forms.example.org/x' }] } }))
    await loadDeploymentConfig()
    await vi.waitFor(async () => { expect(await idbGet(CACHE_KEY)).toMatchObject({ version: 'v1' }) })
    // another tab reads with its session after the station removed the link, and stores that
    await idbSet(CACHE_KEY, { ...STATION, report: { links: [] }, version: 'v2' })
    // …then this tab's partial answer lands
    fetchMock.mockResolvedValueOnce(json(PUBLIC))
    await loadDeploymentConfig()
    await vi.waitFor(async () => { expect(await idbGet(CACHE_KEY)).toMatchObject({ identity: { accentColor: '#0055aa' } }) })
    expect(await idbGet(CACHE_KEY)).toMatchObject({ version: 'v2', report: { links: [] } })
  })

  it('a failed read keeps the document the page holds, not a poorer offline copy', async () => {
    fetchMock.mockResolvedValueOnce(json(PUBLIC))
    await loadDeploymentConfig() // the offline copy: public parts only
    adoptSessionConfig({ ...STATION, version: 'admin' }) // /admin read the document itself
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await loadDeploymentConfig()
    expect(getDeploymentConfig().version).toBe('admin')
    expect(getDeploymentConfig().fleet?.vehicles).toHaveLength(1)
  })

  // values no other test holds: the module singleton outlives single tests here
  const POSTER = { fleet: { vehicles: [{ id: 'poster-adl', label: 'ADL' }] }, report: { partnerOrgs: ['Poster-Partner'] }, identity: { kommandant: 'Poster Kdt' } }

  it('the Erfassungs-Poster parts stay when a slow boot read lands after them, and never reach the offline copy', async () => {
    let answer!: (r: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((res) => { answer = res }))
    const boot = loadDeploymentConfig()
    applyCaptureConfig(POSTER)
    expect(getDeploymentConfig().fleet?.vehicles?.[0]?.id).toBe('poster-adl')
    answer(json(PUBLIC))
    await boot
    expect(getDeploymentConfig().fleet?.vehicles?.[0]?.id).toBe('poster-adl')
    expect(getDeploymentConfig().report?.partnerOrgs).toEqual(['Poster-Partner'])
    expect(getDeploymentConfig().identity?.kommandant).toBe('Poster Kdt')
    expect(getDeploymentConfig().identity?.accentColor).toBe('#0055aa')
    await vi.waitFor(async () => { expect(await idbGet(CACHE_KEY)).toMatchObject({ identity: { accentColor: '#0055aa' } }) })
    expect(JSON.stringify(await idbGet(CACHE_KEY))).not.toMatch(/poster/i)
  })

  it('the Erfassungs-Poster parts stay when the slow boot read fails after them', async () => {
    let fail!: (e: Error) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((_res, rej) => { fail = rej }))
    const boot = loadDeploymentConfig()
    applyCaptureConfig(POSTER)
    fail(new TypeError('Failed to fetch'))
    await boot
    expect(getDeploymentConfig().fleet?.vehicles?.[0]?.id).toBe('poster-adl')
    expect(getDeploymentConfig().report?.partnerOrgs).toEqual(['Poster-Partner'])
  })

  it('the answer /admin read itself becomes the runtime config, and a boot read still on its way does not land over it', async () => {
    let answer!: (r: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((res) => { answer = res }))
    const boot = loadDeploymentConfig()
    adoptSessionConfig({ ...STATION, version: 'admin' })
    answer(json(PUBLIC))
    await boot
    expect(getDeploymentConfig().version).toBe('admin')
    expect(getDeploymentConfig().identity?.accentColor).toBe('#c4161c')
    expect(hasStationConfig()).toBe(true)
  })
})

// Oberwil's Wasser 1/2/3 arrive as `modul5-wasser1…3` (the sub-slot capture keeps its trailing
// number, or the second waterplan overwrites the first). They opened viewer-only — no drawing,
// no «Karte verknüpfen» — because only the unnumbered `modul5-wasser` was in the catalogue and
// the siblings fell through to the `modul5` family default.
describe('moduleViewer — a numbered sub-slot is still its own slot', () => {
  const CATALOGUE = [
    { id: 'modul3', code: 'M3', viewer: false },
    { id: 'modul2-3', code: '2/3', viewer: false, combinedWith: ['modul2', 'modul3'] },
    { id: 'modul5', code: 'M5', family: true, viewer: true },
    { id: 'modul5-pv', code: 'PV', viewer: true },
    { id: 'modul5-wasser', code: 'W', viewer: false },
  ]
  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ modules: CATALOGUE }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    await loadDeploymentConfig()
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('reads the numbered waterplans off `modul5-wasser`, not off the family', () => {
    expect(moduleViewer('modul5-wasser')).toBe(false)
    expect(moduleViewer('modul5-wasser1')).toBe(false)
    expect(moduleViewer('modul5-wasser3')).toBe(false)
  })

  it('keeps a numbered sibling of a viewer slot viewer-only', () => {
    expect(moduleViewer('modul5-pv15')).toBe(true)
  })

  it('leaves an unconfigured sub-slot on the family default', () => {
    expect(moduleViewer('modul5-rwa')).toBe(true)
    expect(moduleViewer('modul5-evak2')).toBe(true)
  })

  it('never mistakes a module number or a combined sheet for a sibling', () => {
    expect(moduleViewer('modul5')).toBe(true)   // the family's own id
    expect(moduleViewer('modul2-3')).toBe(false) // a combined sheet, not «modul2» + a number
  })
})

describe('moduleAlignment — the catalogue decides which sheets the server may propose for', () => {
  it('defaults to auto for Modul 1/2/2-3 and none elsewhere, with the shipped catalogue or none at all', () => {
    expect(moduleAlignment(undefined, 'modul1')).toBe('auto')
    expect(moduleAlignment([], 'modul2-3')).toBe('auto')
    expect(moduleAlignment(undefined, 'modul6')).toBe('none')
  })
  it('honours an explicit choice and lets a family sub-slot inherit its family', () => {
    const catalogue = [{ id: 'modul2', alignment: 'manual' as const }, { id: 'modul5', family: true, alignment: 'auto' as const }, { id: 'modul6' }]
    expect(moduleAlignment(catalogue, 'modul2')).toBe('manual')
    expect(moduleAlignment(catalogue, 'modul5-wasser1')).toBe('auto')
    expect(moduleAlignment(catalogue, 'modul6')).toBe('none')
    expect(moduleAlignment(catalogue, 'modul1')).toBe('auto')
  })
})

describe('Modul 5 – Zusatz is read, not marked up', () => {
  // a station without its own catalogue: the national defaults decide
  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))
    await loadDeploymentConfig()
  })
  afterEach(() => { vi.unstubAllGlobals() })
  it('opens viewer-only by default, while a numbered Wasser sibling stays annotatable', () => {
    expect(moduleViewer('modul5-zusatz')).toBe(true)
    expect(moduleViewer('modul5-wasser1')).toBe(false)
    expect(moduleViewer('modul6')).toBe(true)
  })
})

describe('a module can step behind the Gebäude', () => {
  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ modules: [
      { id: 'modul6', code: 'M6', viewer: true, hideWhenGebaeude: true },
      { id: 'modul5', code: 'M5', family: true, hideWhenGebaeude: true },
      { id: 'modul5-wasser', code: 'W' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } })))
    await loadDeploymentConfig()
  })
  afterEach(() => { vi.unstubAllGlobals() })
  it('resolves exact, sibling and family like the viewer flag; default off', async () => {
    const { moduleHiddenWithGebaeude } = await import('./deploymentConfig')
    expect(moduleHiddenWithGebaeude('modul6')).toBe(true)
    expect(moduleHiddenWithGebaeude('modul5-pv')).toBe(true) // family
    expect(moduleHiddenWithGebaeude('modul5-wasser2')).toBe(false) // the numbered sibling's own slot
    expect(moduleHiddenWithGebaeude('modul1')).toBe(false)
  })
})

// PLACE.7 (13.11.2026): the box every device caches for offline is the station's, not a slider
describe('offlineRadiusM', () => {
  const load = async (cfg: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(cfg), {
      status: 200, headers: { 'content-type': 'application/json' },
    })))
    await loadDeploymentConfig()
  }
  afterEach(() => { vi.unstubAllGlobals() })

  it('is the shipped 1200 m until the station sets one, then the station\'s', async () => {
    await load({})
    expect(offlineRadiusM()).toBe(1200)
    await load({ map: { offlineRadiusM: 2500 } })
    expect(offlineRadiusM()).toBe(2500)
  })

  it('never serves a value outside the 500–3000 m the box allows', async () => {
    await load({ map: { offlineRadiusM: 50 } })
    expect(offlineRadiusM()).toBe(1200)
  })
})
