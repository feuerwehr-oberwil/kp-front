// @vitest-environment jsdom
// «Karte & Objekte» end to end on the surface, with the map as a prop recorder (like the
// IncidentWorkspace harness): an object opens the panel, «Objektbesuch» hands over at the C1
// address and «Melden» asks for the station's Fehlermeldung, a pin becomes a «Meldung» at a place,
// Messen offers NO «Als Linie übernehmen», a plan opens in the Einsatz's reader read-only, and
// nothing the viewer does writes anything but its own view keys. Synthetic Musterdorf data.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { StationObjects } from '../../lib/api/stationReference'
import type { LngLat } from '../../types'

const rec = vi.hoisted(() => ({ map: [] as Record<string, unknown>[], phone: false, board: [] as Record<string, unknown>[], catalogue: null as null | StationObjects, rules: [] as unknown[] }))
const lastMap = () => rec.map[rec.map.length - 1] as { onMapClick: (c: LngLat) => void; measurePoints: LngLat[]; children?: ReactNode }

const CATALOGUE: StationObjects = {
  generatedAt: '2026-10-16T10:00:00Z',
  objects: [
    { id: 'schloss', name: 'Schloss Musterdorf', kind: 'einsatzobjekt', address: 'Schlossgasse 9, 9999 Musterdorf', lat: 47.523773, lng: 7.570188,
      aliases: ['Wasserschloss'], plans: [{ id: 'plan:schloss:modul1', module: 'modul1', code: '1', title: 'Modul 1 · Übersicht', pages: 2, georef: false, version: 1 }],
      floors: [], egid: null, footprint: null, lastVisit: null, measures: 'Zufahrt nur über Schlossgasse', measuresSource: 'Modul 1' },
    // plan-less, at the Schloss's door (a «Schlüsseldepot» kind of its own until review round 3)
    { id: 'depot', name: 'Remise Schloss', kind: 'objekt', address: 'Schlossgasse 9', lat: 47.52402, lng: 7.56985,
      aliases: [], plans: [], floors: [], egid: null, footprint: null, lastVisit: null },
    // named by its address, with none stored (review round 2: the lists said «Schlüsseldepot» there)
    { id: 'box', name: 'Starenstrasse 7', kind: 'objekt', address: null, lat: 47.5232, lng: 7.5712,
      aliases: [], plans: [], floors: [], egid: null, footprint: null, lastVisit: null },
  ],
}

vi.mock('../../lib/auth', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/auth')>()
  const value = { user: { id: 'u1', username: 'fu', display_name: 'FU Test', role: 'editor' as const, color: null, last_login: null }, loading: false, probeUnreachable: false, sessionExpired: false, login: () => Promise.resolve(), logout: () => Promise.resolve() }
  return { ...mod, useAuth: () => value }
})
vi.mock('../../lib/useSymbols', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/useSymbols')>()), useSymbols: () => ({ ready: true, error: false, reload: () => {}, order: [], symbols: [], byName: {} }) }))
vi.mock('../MapView', () => ({
  MapView: (p: Record<string, unknown> & { children?: ReactNode }) => { rec.map.push(p); return <div data-testid="mapview">{p.children}</div> },
}))
// a marker says where it stands (lng/lat), how it hangs there and how far it slid
vi.mock('react-map-gl/maplibre', () => ({
  Marker: ({ children, longitude, latitude, anchor, offset }: { children: ReactNode; longitude: number; latitude: number; anchor?: string; offset?: [number, number] }) => (
    <div data-marker="" data-lng={longitude} data-lat={latitude} data-anchor={anchor ?? ''} data-offset={(offset ?? [0, 0]).join(',')}>{children}</div>
  ),
}))
vi.mock('../../lib/api/stationReference', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/stationReference')>()),
  loadStationObjects: async () => ({ value: rec.catalogue ?? CATALOGUE, source: 'network' as const }),
  loadStationBuilding: async () => null,
}))
vi.mock('../../objectVisits/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../objectVisits/api')>()), listVisits: async () => [] }))
vi.mock('../../lib/api/geo', () => ({
  geocodeSearch: async () => [],
  geocodeReverse: async (lat: number, lng: number) => ({ label: 'Starenstrasse 19, 9999 Musterdorf', lat, lng }),
}))
vi.mock('../../lib/deploymentConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/deploymentConfig')>()),
  objectVisitsConfig: () => ({ enabled: true, captureRoles: ['editor', 'el'] }),
  objectCategoryRules: () => rec.rules,
}))
vi.mock('../../lib/useWeather', () => ({ useWeather: () => ({ data: null, error: null }) }))
vi.mock('../../lib/ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/ui')>()), toast: vi.fn() }))
vi.mock('../../lib/useVehicleLayer', () => ({ useVehicleLayer: () => ({ liveVehicles: [] }) }))
// the Einsatz's plan reader (Whiteboard, lazy) as a prop recorder: what the Karte hands it IS the
// proof that it can write nothing
vi.mock('../../workspace/lazySurfaces', () => ({
  Whiteboard: (p: Record<string, unknown> & { plans: { imageUrl: string }[] }) => { rec.board.push(p); return <div data-testid="pdf">{p.plans[0].imageUrl}</div> },
}))

import KarteApp, { type KarteAppProps } from './KarteApp'
import { toast } from '../../lib/ui'
import { appConfig } from '../../config/appConfig'

class RO { observe() {} unobserve() {} disconnect() {} }
beforeAll(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= RO
  window.matchMedia = ((q: string) => ({
    matches: rec.phone, media: q, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
beforeEach(() => {
  rec.map.length = 0
  rec.board.length = 0
  rec.phone = false
  rec.catalogue = null
  rec.rules = []
  localStorage.clear(); sessionStorage.clear()
  window.history.replaceState(null, '', '/karte')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(toast).mockClear() })

const mount = (over: Partial<KarteAppProps> = {}) => {
  const onOpenVisits = vi.fn()
  // the launcher's content as App hands it in: a row that closes the sheet, like «Manueller Einsatz»
  const launcherRow = vi.fn()
  const einsaetze = {
    badge: 0,
    render: (close: () => void) => <button type="button" onClick={() => { launcherRow(); close() }}>Manueller Einsatz</button>,
  }
  render(<KarteApp einsaetze={einsaetze} onOpenVisits={onOpenVisits} running={[]} onOpenIncident={vi.fn()} {...over} />)
  return { onOpenVisits, launcherRow }
}

describe('KarteApp', () => {
  it('colours an object by its category and gives the category an Ebenen row that hides it', async () => {
    // the Schloss stands in a square building of its own (a server footprint) and carries Modul 1
    const sq = (lng: number, lat: number, d: number) => [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]
    rec.catalogue = {
      ...CATALOGUE,
      objects: CATALOGUE.objects.map((o) => (o.id === 'schloss' ? { ...o, footprint: { type: 'MultiPolygon', coordinates: [[sq(7.5700, 47.5236, 0.0004)]] } } : o)),
    }
    rec.rules = [{ id: 'm1', label: { de: 'Mit Übersichtsplan', fr: 'Avec plan' }, color: '#2563eb', match: { modules: ['modul1*'] } }]
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    type Ov = { id: string; color?: string }
    const overlays = () => (lastMap() as unknown as { preparedOverlays: Ov[] }).preparedOverlays
    await waitFor(() => expect(overlays().find((o) => o.id === 'karte-objects-m1')?.color).toBe('#2563eb'))
    // the default red overlay is gone: the only outlined object is in the category
    expect(overlays().some((o) => o.id === 'karte-objects')).toBe(false)
    // its marker wears the colour
    const marker = screen.getByRole('button', { name: /Schloss Musterdorf/ })
    expect(marker.style.getPropertyValue('--cat')).toBe('#2563eb')

    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.karte.tools.layers }))
    const row = await screen.findByRole('button', { name: /Mit Übersichtsplan/ })
    expect(row.textContent).toMatch(/1 Objekte/)
    fireEvent.click(row)
    await waitFor(() => expect(overlays().some((o) => o.id === 'karte-objects-m1')).toBe(false))
    expect(screen.queryByRole('button', { name: /^Schloss Musterdorf/ })).toBeNull()
    // the plan-less object (no category) stays
    expect(screen.getByRole('button', { name: /Remise Schloss/ })).toBeTruthy()
  })

  it('opens an object from its tag and hands a visit over at the contract address', async () => {
    const { onOpenVisits } = mount()
    fireEvent.click(await screen.findByRole('button', { name: /Schloss Musterdorf/ }))
    expect(await screen.findByRole('heading', { name: 'Schloss Musterdorf' })).toBeTruthy()
    expect(screen.getByText('Zufahrt nur über Schlossgasse')).toBeTruthy()
    // the address follows the selection, without a history entry
    await waitFor(() => expect(window.location.search).toBe('?objekt=schloss'))
    fireEvent.click(screen.getByRole('button', { name: /Objektbesuch/ }))
    expect(onOpenVisits).toHaveBeenCalledWith('/besuche/neu?object=schloss&from=karte')
    // «Melden» (owner R2): the same visit, with the station's Fehlermeldung asked for
    fireEvent.click(screen.getByRole('button', { name: 'Melden' }))
    expect(onOpenVisits).toHaveBeenLastCalledWith('/besuche/neu?object=schloss&checkliste=fehlermeldung&from=karte')
  })

  // owner R3 (17.10.2026): «do not move the location of the marker» — the tag sits ON the object's
  // point even when its building's south edge (round 1) or the inside of it (round 2) is elsewhere,
  // and it names the object without a plan count
  it('draws the tag on the object\'s point, centred, with no plan count', async () => {
    const sq = (lng: number, lat: number, d: number) => [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]
    rec.catalogue = {
      ...CATALOGUE,
      objects: CATALOGUE.objects.map((o) => (o.id === 'schloss'
        ? { ...o, footprint: { type: 'MultiPolygon', coordinates: [[sq(7.5700, 47.5236, 0.0004)]] }, plans: [...o.plans, { ...o.plans[0], id: 'plan:schloss:modul2', module: 'modul2', code: '2' }] }
        : o)),
    }
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Schloss Musterdorf/ }))
    await screen.findByRole('heading', { name: 'Schloss Musterdorf' })
    const tag = screen.getAllByRole('button', { name: 'Schloss Musterdorf' }).find((b) => b.closest('[data-marker]'))!
    expect(tag.textContent).toBe('Schloss Musterdorf')
    const m = tag.closest('[data-marker]') as HTMLElement
    expect([Number(m.dataset.lng), Number(m.dataset.lat)]).toEqual([7.570188, 47.523773])
    expect(m.dataset.anchor).toBe('center')
    expect(m.dataset.offset).toBe('0,0')
  })

  it('without categories, an object without plans is told apart by its look, not a number', async () => {
    rec.catalogue = {
      ...CATALOGUE,
      objects: [...CATALOGUE.objects, { id: 'halle', name: 'Lagerhalle Feld', kind: 'objekt', address: 'Feldweg 2', lat: 47.5245, lng: 7.5690, aliases: [], plans: [], floors: [], egid: null, footprint: null, lastVisit: null }],
    }
    mount()
    const bare = await screen.findByRole('button', { name: 'Lagerhalle Feld' })
    const planned = screen.getByRole('button', { name: 'Schloss Musterdorf' })
    expect(bare.className).not.toBe(planned.className)
    expect(planned.textContent + bare.textContent).not.toMatch(/\d/)
  })

  it('measures without offering to keep it, and stores nothing of it', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Schloss Musterdorf/ }))
    // no «Messen ab hier» in the panel any more (owner R2): Messen is the tool's
    expect(screen.queryByRole('button', { name: /Messen ab hier/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Messen' }))
    act(() => lastMap().onMapClick([7.570188, 47.523773]))
    act(() => lastMap().onMapClick([7.5708, 47.52455]))
    await waitFor(() => expect(lastMap().measurePoints).toHaveLength(2))
    expect(screen.queryByRole('button', { name: /übernehmen/ })).toBeNull()
    // …and no line saying so either (owner-6, 17.10.2026): nothing on this surface is ever saved
    expect(screen.queryByText(/Nur zum Nachschauen/)).toBeNull()
    // only the viewer's own view keys were written — no workspace, no drawing, no measure
    expect(Object.keys(sessionStorage)).toEqual(['kp.karte.view'])
    expect(sessionStorage.getItem('kp.karte.view')).not.toMatch(/7\.5708/)
    expect(Object.keys(localStorage).filter((k) => !k.startsWith('kp.karte') && k !== 'kp.layers.karte')).toEqual([])
  })

  it('drops a pin with the tool and files a Meldung at that place', async () => {
    const { onOpenVisits } = mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    fireEvent.click(screen.getByRole('button', { name: 'Punkt setzen' }))
    act(() => lastMap().onMapClick([7.57175, 47.52015]))
    expect(await screen.findByText('bei Starenstrasse 19')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Melden' }))
    const href = onOpenVisits.mock.calls[0][0] as string
    const q = new URLSearchParams(href.split('?')[1])
    expect(href.startsWith('/besuche/neu?')).toBe(true)
    expect(q.get('label')).toBe('bei Starenstrasse 19')
    expect(q.get('address')).toBe('Starenstrasse 19, 9999 Musterdorf')
    expect(q.get('from')).toBe('karte')
    expect(q.get('checkliste')).toBe('fehlermeldung')
  })

  it('searches the catalogue on the device, objects with plans first', async () => {
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    fireEvent.change(screen.getByPlaceholderText('Adresse oder Objekt suchen …'), { target: { value: 'schloss' } })
    const options = await screen.findAllByRole('option')
    expect(options[0].textContent).toMatch(/Schloss Musterdorf/)
    expect(options[1].textContent).toMatch(/Remise Schloss/)
  })

  it('lists an object as glyph · name · address, without its plan count (review round 2)', async () => {
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    const field = screen.getByPlaceholderText('Adresse oder Objekt suchen …')
    fireEvent.focus(field)
    const featured = await screen.findAllByRole('option')
    expect(featured[0].textContent).toContain('Schlossgasse 9, 9999 Musterdorf')
    expect(featured[0].textContent).not.toMatch(/Plan|Pläne/)
    fireEvent.change(field, { target: { value: 'starenstrasse' } })
    const [box] = await screen.findAllByRole('option')
    // the name IS the address: printed once, the kind quietly under it — never in its place
    expect(within(box).getByText('Starenstrasse 7')).toBeTruthy()
    expect(within(box).getByText('Stationsobjekt')).toBeTruthy()
    expect(box.textContent).not.toMatch(/keine Pläne/)
  })

  it('switches every Ebene, the station objects included, with «Alle aus» / «Alle ein» / «Standard»', async () => {
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    fireEvent.click(screen.getByRole('button', { name: 'Ebenen' }))
    const objects = () => screen.getByRole('button', { name: /^Stationsobjekte – / })
    const chip = (name: string) => screen.getByRole('button', { name })
    expect(chip('Standard').getAttribute('aria-pressed')).toBe('true')
    expect(objects().getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chip('Alle aus'))
    expect(objects().getAttribute('aria-pressed')).toBe('false')
    expect(chip('Alle aus').getAttribute('aria-pressed')).toBe('true')
    // the objects are off the map: no tag to tap
    expect(screen.queryByRole('button', { name: /^Schloss Musterdorf/ })).toBeNull()
    fireEvent.click(chip('Alle ein'))
    expect(objects().getAttribute('aria-pressed')).toBe('true')
    expect(chip('Alle ein').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chip('Standard'))
    expect(chip('Standard').getAttribute('aria-pressed')).toBe('true')
    // a row switched by hand: none of the three is lit
    fireEvent.click(objects())
    for (const n of ['Alle ein', 'Alle aus', 'Standard']) expect(chip(n).getAttribute('aria-pressed')).toBe('false')
  })

  it('opens a deep link on its object — a plan-less one as an object like any other', async () => {
    window.history.replaceState(null, '', '/karte?objekt=depot')
    mount()
    expect(await screen.findByRole('heading', { name: 'Remise Schloss' })).toBeTruthy()
    // owner R3: no «Schlüsseldepot» kicker, note or glyph — the kind word and the register
    expect(screen.getAllByText('Stationsobjekt').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/Schlüsseldepot/)
    expect(document.querySelector('[data-section="register"]')).not.toBeNull()
  })

  // home (variant B): the old launcher card is the «Einsätze ▾» sheet — App's content, opened here
  it('opens the launcher content as the «Einsätze» sheet and shuts it when a row acts', async () => {
    const { launcherRow } = mount({ einsaetze: { badge: 2, render: (close) => <button type="button" onClick={() => { close() }}>Manueller Einsatz</button> } })
    void launcherRow
    const button = screen.getByRole('button', { name: /Einsätze/ })
    expect(screen.getByLabelText('2 offen').textContent).toBe('2')
    expect(screen.queryByRole('dialog', { name: 'Einsätze' })).toBeNull()
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Einsätze' })).getByRole('button', { name: 'Manueller Einsatz' }))
    expect(screen.queryByRole('dialog', { name: 'Einsätze' })).toBeNull()
    // Escape and a press outside close it too
    fireEvent.click(button)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Einsätze' })).toBeNull()
    fireEvent.click(button)
    fireEvent.pointerDown(screen.getByTestId('mapview'))
    expect(screen.queryByRole('dialog', { name: 'Einsätze' })).toBeNull()
  })

  // the app menu's offline row on home is the viewer's own «Auf diesem Gerät» (panels/AppMenuRows)
  it('hands the sheet a door to «Auf diesem Gerät», which shuts the sheet and opens it', async () => {
    mount({ einsaetze: { badge: 0, render: (_close, onDevice) => <button type="button" onClick={onDevice}>Gerät</button> } })
    fireEvent.click(screen.getByRole('button', { name: /Einsätze/ }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Einsätze' })).getByRole('button', { name: 'Gerät' }))
    expect(screen.queryByRole('dialog', { name: 'Einsätze' })).toBeNull()
    expect(await screen.findByRole('dialog', { name: appConfig.copy.karte.device.title })).toBeTruthy()
  })

  it('keeps no badge with nothing running and no alarm to take', async () => {
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    expect(screen.queryByLabelText(/offen$/)).toBeNull()
  })

  it('comes back from an Einsatz where it was left — object, plan, tool — and says so once', async () => {
    sessionStorage.setItem('kp.karte.view', JSON.stringify({
      center: [7.570188, 47.523773], zoom: 18, bearing: 0, objectId: 'schloss', surface: { plan: 'plan:schloss:modul1' },
      tool: 'layers', label: 'Schloss Musterdorf · Modul 1',
    }))
    window.history.replaceState(null, '', '/karte')
    mount({ announceReturn: true })
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalled())
    expect(vi.mocked(toast)).toHaveBeenCalledWith('Wieder bei Schloss Musterdorf · Modul 1', { icon: 'check' })
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(1)
    // the tool that was open is open again, and the label the Einsatz menu reads is kept
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('kp.karte.view')!)).toMatchObject({
      objectId: 'schloss', surface: { plan: 'plan:schloss:modul1' }, tool: 'layers', label: 'Schloss Musterdorf · Modul 1',
    }))
  })

  it('says nothing on a plain start (home), only after an Einsatz', async () => {
    window.history.replaceState(null, '', '/')
    sessionStorage.setItem('kp.karte.view', JSON.stringify({ center: [7.57, 47.52], zoom: 16, bearing: 0, objectId: 'schloss', surface: 'karte', label: 'Schloss Musterdorf' }))
    mount()
    expect(await screen.findByRole('heading', { name: 'Schloss Musterdorf' })).toBeTruthy()
    expect(vi.mocked(toast)).not.toHaveBeenCalled()
    // home lives at `/`: the selection does not move it to /karte
    expect(window.location.pathname).toBe('/')
  })

  // owner-4 (17.10.2026): on a phone the plans are rows in the object's sheet — the bar has no
  // «Pläne» tab — and an open plan goes back to the map with its «Zur Karte» chip
  it('on a phone: no Pläne tab, the plan opens from the sheet and goes back to it', async () => {
    rec.phone = true
    mount()
    const nav = await screen.findByRole('navigation', { name: 'Karte & Objekte' })
    expect(within(nav).queryByRole('button', { name: /Pläne/ })).toBeNull()
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Karte', 'Messen', 'Gefahrgut', 'Ebenen'])
    fireEvent.click(await screen.findByRole('button', { name: /Schloss Musterdorf/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Modul 1 · Übersicht/ }))
    expect(await screen.findByTestId('pdf')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Schloss Musterdorf' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Zur Karte/ }))
    expect(await screen.findByRole('heading', { name: 'Schloss Musterdorf' })).toBeTruthy()
    expect(screen.queryByTestId('pdf')).toBeNull()
  })

  // owner R2: «using the normal pdf viewer we have just without the annotation» — the Einsatz's
  // plan reader, and nothing it could write with
  it('opens a plan in the Einsatz\'s reader, read-only, with no writer behind it', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Schloss Musterdorf/ }))
    const fetchBefore = vi.mocked(fetch).mock.calls.length
    // the panel's row (the tablet's rail names the same document)
    fireEvent.click(within(await screen.findByRole('region', { name: 'Karte & Objekte' })).getByRole('button', { name: /Modul 1 · Übersicht/ }))
    expect(await screen.findByTestId('pdf')).toBeTruthy()
    const p = rec.board[rec.board.length - 1] as Record<string, unknown> & { plans: { id: string; imageUrl: string }[] }
    expect(p.readOnly).toBe(true)
    expect(p.slimTools).toBe(false)
    expect(p.linkViewer).toBe(true)
    expect(p.annos).toEqual([])
    expect(p.plans.map((d) => d.imageUrl)).toEqual(['/api/reference/plan%3Aschloss%3Amodul1?v=1'])
    // no door to anything stored under an Einsatz: none of these is handed in
    for (const k of ['incidentId', 'onCalibrate', 'onObjectSwitch', 'onReorient', 'onPlanLiveMove', 'onLinkTrupp', 'onTeamTrupp', 'tafel', 'historyRef', 'keysRef']) expect(p[k]).toBeUndefined()
    // …and what it must be handed writes nothing
    const keys = () => [Object.keys(localStorage).sort(), Object.keys(sessionStorage).sort()]
    const stored = keys()
    ;(p.onChange as (a: unknown[]) => void)([{ id: 'x', kind: 'text', x: 0.5, y: 0.5 }])
    ;(p.log as (i: string, t: string) => void)('pen', 'gezeichnet')
    ;(p.emit as (op: string) => void)('board.add')
    ;(p.onAddFloor as (d: number) => void)(1)
    expect(keys()).toEqual(stored)
    expect(vi.mocked(fetch).mock.calls.slice(fetchBefore).filter(([, init]) => (init as RequestInit | undefined)?.method && (init as RequestInit).method !== 'GET')).toEqual([])
    expect((rec.board[rec.board.length - 1] as { annos: unknown[] }).annos).toEqual([])
  })

  // owner R2: closing the phone sheet returns to the map with the place still selected, and a
  // second tap on it brings the sheet back
  it('on a phone: ✕ shuts the sheet, the object stays selected, a tap on it reopens', async () => {
    rec.phone = true
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Schloss Musterdorf/ }))
    const sheet = await screen.findByRole('region', { name: 'Karte & Objekte' })
    expect(sheet.classList.contains('layers-card')).toBe(true)
    const closes = within(sheet).getAllByRole('button', { name: 'Schliessen' })
    fireEvent.click(closes[closes.length - 1])
    expect(screen.queryByRole('heading', { name: 'Schloss Musterdorf' })).toBeNull()
    // still selected: the address keeps it, the tag stays drawn
    expect(window.location.search).toBe('?objekt=schloss')
    fireEvent.click(screen.getByRole('button', { name: /Schloss Musterdorf/ }))
    expect(await screen.findByRole('heading', { name: 'Schloss Musterdorf' })).toBeTruthy()
  })
})
