// @vitest-environment jsdom
// «Karte & Objekte» end to end on the surface, with the map as a prop recorder (like the
// IncidentWorkspace harness): an object opens the panel, «Objektbesuch» hands over at the C1
// address and «Melden» asks for the station's Fehlermeldung, a pin becomes a «Meldung» at a place,
// Messen offers NO «Als Linie übernehmen», a plan opens in the Einsatz's reader read-only, and
// nothing the viewer does writes anything but its own view keys. Synthetic Musterdorf data.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { StationObjects, UndergroundSet } from '../../lib/api/stationReference'
import type { LngLat } from '../../types'

const rec = vi.hoisted(() => ({ map: [] as Record<string, unknown>[], phone: false, board: [] as Record<string, unknown>[], catalogue: null as null | StationObjects, rules: [] as unknown[], fakeMap: null as null | object, underground: null as null | UndergroundSet, undergroundAsked: 0 }))
const lastMap = () => rec.map[rec.map.length - 1] as { onMapClick: (c: LngLat) => void; measurePoints: LngLat[]; onMeasureDelete?: (i: number) => void; children?: ReactNode }

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
vi.mock('../MapView', async () => {
  const { useImperativeHandle } = await import('react')
  return {
    // the map's handle is null unless a test hands in a stand-in (React 19: `ref` is a prop); the
    // canvas container's class is what the surface's pointer handlers look for
    MapView: (p: Record<string, unknown> & { children?: ReactNode; ref?: React.Ref<unknown> }) => {
      rec.map.push(p)
      useImperativeHandle(p.ref, () => rec.fakeMap, [])
      return <div data-testid="mapview" className="maplibregl-canvas-container">{p.children}</div>
    },
  }
})
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
  loadUnderground: async () => { rec.undergroundAsked++; return rec.underground },
}))
vi.mock('../../objectVisits/api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../objectVisits/api')>()), listVisits: async () => [] }))
vi.mock('../../lib/api/geo', () => ({
  geocodeSearch: async () => [],
  geocodeReverse: async (lat: number, lng: number) => ({ label: 'Starenstrasse 19, 9999 Musterdorf', lat, lng }),
}))
// the menu button's face (review round 5): the station's mark / short name, per test
const brand = vi.hoisted(() => ({ mark: null as string | null, short: null as string | null, name: 'Feuerwehr Musterdorf' }))
vi.mock('../../lib/deploymentConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/deploymentConfig')>()),
  deploymentMenuMark: () => ({ mark: brand.mark, short: brand.short }),
  deploymentName: () => brand.name,
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
import { __setUnHazardData, type UnHazardEntry } from '../../lib/unHazard'
import adr from '../../../public/un-hazard.json'

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
  rec.fakeMap = null
  rec.underground = null
  rec.undergroundAsked = 0
  brand.mark = null; brand.short = null
  localStorage.clear(); sessionStorage.clear()
  window.history.replaceState(null, '', '/karte')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(toast).mockClear() })

/** the fields' words carry invisible word joiners against iOS's contact AutoFill (lib/typingField) */
const PLAIN = { normalizer: (t: string) => t.replace(/\u2060/g, '') }

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

  // owner R3-9 (17.10.2026): «I can't delete nodes when measuring because it wants to create a
  // point» — a long press anywhere dropped a pin (and left Messen), and holding a measure node is
  // how a node is removed. The pin is the ⊙ tool's only, and a held node is the node's.
  it('a long press on the map drops no pin — Messen keeps holding a node to remove it', async () => {
    const el = document.createElement('div')
    rec.fakeMap = {
      getContainer: () => el, getZoom: () => 10, unproject: () => ({ lng: 7.5712, lat: 47.5232 }), project: () => ({ x: 200, y: 200 }),
      easeTo: () => {}, jumpTo: () => {}, fitBounds: () => {},
    }
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    fireEvent.click(screen.getByRole('button', { name: 'Messen' }))
    act(() => lastMap().onMapClick([7.570188, 47.523773]))
    act(() => lastMap().onMapClick([7.5708, 47.52455]))
    act(() => lastMap().onMapClick([7.5712, 47.5232]))
    await waitFor(() => expect(lastMap().measurePoints).toHaveLength(3))
    // the finger stays down on the middle node (MapView's own hold removes it) …
    const node = screen.getByTestId('mapview')
    fireEvent.pointerDown(node, { isPrimary: true, pointerId: 1, clientX: 200, clientY: 200 })
    await act(() => new Promise((r) => setTimeout(r, 700)))
    act(() => lastMap().onMeasureDelete?.(1))
    fireEvent.pointerUp(node, { isPrimary: true, pointerId: 1, clientX: 200, clientY: 200 })
    // … and the surface did not drop a pin under it, nor leave Messen
    expect(screen.queryByText('Gesetzter Punkt')).toBeNull()
    expect(lastMap().measurePoints).toEqual([[7.570188, 47.523773], [7.5712, 47.5232]])
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
    fireEvent.change(screen.getByPlaceholderText('Adresse oder Objekt suchen …', PLAIN), { target: { value: 'schloss' } })
    const options = await screen.findAllByRole('option')
    expect(options[0].textContent).toMatch(/Schloss Musterdorf/)
    expect(options[1].textContent).toMatch(/Remise Schloss/)
  })

  it('lists an object as glyph · name · address, without its plan count (review round 2)', async () => {
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    const field = screen.getByPlaceholderText('Adresse oder Objekt suchen …', PLAIN)
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

  it('«Unterirdische Bauten»: a Station row, ON when the viewer opens and part of «Standard», drawn dashed under the objects', async () => {
    const sq = (lng: number, lat: number, d: number) => [[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]
    rec.underground = { fetchedAt: '2026-10-17T03:00:00+00:00', count: 2, geometry: { type: 'MultiPolygon', coordinates: [[sq(7.5701, 47.5237, 0.0002)], [sq(7.5710, 47.5230, 0.0001)]] } }
    rec.catalogue = {
      ...CATALOGUE,
      objects: CATALOGUE.objects.map((o) => (o.id === 'schloss' ? { ...o, footprint: { type: 'MultiPolygon', coordinates: [[sq(7.5700, 47.5236, 0.0004)]] } } : o)),
    }
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    type Ov = { id: string; color?: string; rings?: LngLat[][]; lineDasharray?: number[]; fillOpacity?: number; minzoom?: number; layer?: string }
    const overlays = () => (lastMap() as unknown as { preparedOverlays: Ov[] }).preparedOverlays
    const visible = (id: string) => (lastMap() as unknown as { isVisible: (l: string) => boolean }).isVisible(id)
    // owner, review round 5: on by default — asked once as the viewer opens, drawn without a tap
    await waitFor(() => expect(overlays().some((o) => o.id === 'karte-underground')).toBe(true))
    expect(rec.undergroundAsked).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Ebenen' }))
    const row = () => screen.getByRole('button', { name: /^Unterirdische Bauten – / })
    const chip = (name: string) => screen.getByRole('button', { name })
    // in the Station group, on, and «Standard» is lit with it on
    const heads = [...document.querySelectorAll('.lgroup')].filter((h) => h.compareDocumentPosition(row()) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(heads[heads.length - 1]?.textContent).toBe('Station')
    expect(row().getAttribute('aria-pressed')).toBe('true')
    expect(chip('Standard').getAttribute('aria-pressed')).toBe('true')
    expect(row().textContent).toMatch(/2 Bauten/)
    const ov = overlays().find((o) => o.id === 'karte-underground')!
    expect(ov.rings).toHaveLength(2)
    expect(ov.rings![0]).toHaveLength(4) // open rings: the map closes them
    expect(ov.lineDasharray).toBeTruthy()
    expect(ov.fillOpacity).toBe(0)
    expect(ov.minzoom).toBe(16)
    expect(visible(ov.layer!)).toBe(true)
    // neutral, never the objects' red; and UNDER them, so an object's own dashed garage stays on top
    const objects = overlays().find((o) => o.id === 'karte-objects')!
    expect(ov.color).not.toBe(objects.color)
    expect(overlays().indexOf(ov)).toBeLessThan(overlays().indexOf(objects))
    // switched off by hand: gone, and «Standard» is no longer lit — it puts it back on
    fireEvent.click(row())
    expect(row().getAttribute('aria-pressed')).toBe('false')
    await waitFor(() => expect(overlays().some((o) => o.id === 'karte-underground')).toBe(false))
    expect(chip('Standard').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(chip('Standard'))
    expect(row().getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => expect(overlays().some((o) => o.id === 'karte-underground')).toBe(true))
    // «Alle aus» switches it like any row — the set is kept, not asked again
    fireEvent.click(chip('Alle aus'))
    expect(row().getAttribute('aria-pressed')).toBe('false')
    await waitFor(() => expect(overlays().some((o) => o.id === 'karte-underground')).toBe(false))
    fireEvent.click(chip('Alle ein'))
    await waitFor(() => expect(overlays().some((o) => o.id === 'karte-underground')).toBe(true))
    expect(rec.undergroundAsked).toBe(1)
  })

  it('«Unterirdische Bauten» says so when there is nothing to draw, and asks again next time', async () => {
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    fireEvent.click(screen.getByRole('button', { name: 'Ebenen' }))
    const row = () => screen.getByRole('button', { name: /^Unterirdische Bauten – / })
    await waitFor(() => expect(row().textContent).toMatch(/Nicht verfügbar/))
    expect(rec.undergroundAsked).toBe(1)
    fireEvent.click(row())
    fireEvent.click(row())
    await waitFor(() => expect(rec.undergroundAsked).toBe(2))
  })

  // owner on #383: the Karte (only) never zooms past the visible base's last sharp level
  it('asks the map to stop at the base map\'s last sharp zoom', async () => {
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    expect((lastMap() as unknown as { zoomCapAtBase?: boolean }).zoomCapAtBase).toBe(true)
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

  // home (variant B): the old launcher card is the menu sheet — App's content, opened here
  it('opens the launcher content as the menu sheet and shuts it when a row acts', async () => {
    brand.short = 'FWM'
    const { launcherRow } = mount({ einsaetze: { badge: 2, render: (close) => <button type="button" onClick={() => { close() }}>Manueller Einsatz</button> } })
    void launcherRow
    // the count is in the name; on the button it is a dot (owner, review round 5)
    const button = screen.getByRole('button', { name: 'Menü – Feuerwehr Musterdorf, 2 offen' })
    expect(button.querySelector('[data-karte-menu-dot]')).not.toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Menü' })).toBeNull()
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Menü' })).getByRole('button', { name: 'Manueller Einsatz' }))
    expect(screen.queryByRole('dialog', { name: 'Menü' })).toBeNull()
    // Escape and a press outside close it too
    fireEvent.click(button)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Menü' })).toBeNull()
    fireEvent.click(button)
    fireEvent.pointerDown(screen.getByTestId('mapview'))
    expect(screen.queryByRole('dialog', { name: 'Menü' })).toBeNull()
  })

  // the app menu's offline row on home is the viewer's own «Auf diesem Gerät» (panels/AppMenuRows)
  it('hands the sheet a door to «Auf diesem Gerät», which shuts the sheet and opens it', async () => {
    mount({ einsaetze: { badge: 0, render: (_close, onDevice) => <button type="button" onClick={onDevice}>Gerät</button> } })
    fireEvent.click(screen.getByRole('button', { name: /^Menü/ }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Menü' })).getByRole('button', { name: 'Gerät' }))
    expect(screen.queryByRole('dialog', { name: 'Menü' })).toBeNull()
    expect(await screen.findByRole('dialog', { name: appConfig.copy.karte.device.title })).toBeTruthy()
  })

  it('keeps no dot with nothing running and no alarm to take', async () => {
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    expect(screen.getByRole('button', { name: 'Menü – Feuerwehr Musterdorf' })).toBeTruthy()
    expect(document.querySelector('[data-karte-menu-dot]')).toBeNull()
  })

  // owner, review round 5: «not "Einsätze" as the main top button» → the station's short name
  // and/or mark, ▾; with neither configured a neutral menu symbol — never the word «Einsätze»
  it('wears the station on the menu button: short name, mark, both, or the menu symbol', () => {
    const face = () => {
      const b = document.querySelector('[data-karte-menu]')!
      return { text: b.textContent, img: b.querySelector('img')?.getAttribute('src') ?? null, symbol: !!b.querySelector('use[href="#menu"]') }
    }
    mount()
    expect(face()).toEqual({ text: '', img: null, symbol: true })
    expect(document.body.textContent).not.toMatch(/Einsätze/)
    cleanup()
    brand.short = 'FWM'
    mount()
    expect(face()).toEqual({ text: 'FWM', img: null, symbol: false })
    cleanup()
    brand.mark = '/api/branding/file/mark.svg'
    mount()
    expect(face()).toEqual({ text: 'FWM', img: '/api/branding/file/mark.svg', symbol: false })
    cleanup()
    brand.short = null
    mount()
    expect(face()).toEqual({ text: '', img: '/api/branding/file/mark.svg', symbol: false })
    // a mark that cannot load steps back to the symbol, never a broken image
    fireEvent.error(document.querySelector('[data-karte-menu] img')!)
    expect(face()).toEqual({ text: '', img: null, symbol: true })
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
  // «Pläne» tab — and an open plan goes back to the map with its «Zurück» chip
  it('on a phone: no Pläne tab, the plan opens from the sheet and goes back to it', async () => {
    rec.phone = true
    mount()
    const nav = await screen.findByRole('navigation', { name: 'Karte & Objekte' })
    expect(within(nav).queryByRole('button', { name: /Pläne/ })).toBeNull()
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Karte', 'Messen', 'Gefahrgut', 'Ebenen'])
    fireEvent.click(await screen.findByRole('button', { name: /Schloss Musterdorf/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Modul 1' }))
    expect(await screen.findByTestId('pdf')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Schloss Musterdorf' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Zurück/ }))
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
    fireEvent.click(within(await screen.findByRole('region', { name: 'Karte & Objekte' })).getByRole('button', { name: 'Modul 1' }))
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

  // owner, review round 4: «gebäude should be literally 1:1 the same as in the normal incident just
  // without editing» — the Einsatz's Whiteboard on its floor stack, fed with the object's pack
  it('opens the Gebäude in the Einsatz\'s own stack, read-only, with no door to an edit', async () => {
    const m6 = { id: 'plan:schloss:modul6', module: 'modul6', code: '6', title: 'Modul 6', pages: 1, georef: false, version: 2 }
    rec.catalogue = {
      ...CATALOGUE,
      objects: CATALOGUE.objects.map((o) => (o.id === 'schloss' ? { ...o, plans: [...o.plans, m6], floors: [{ index: 0, name: null }, { index: 1, name: null }] } : o)),
    }
    const meta = {
      dataset_id: m6.id, plan_version: 2, revision_url: '',
      floors: [{ page: 0, index: 0, name: 'EG', clip: [0, 0, 0.5, 1] }, { page: 0, index: 1, name: null, clip: [0.5, 0, 1, 1] }],
      alignments: [{ id: 3, page: 0, aspect: 1.414, approved_at: '2026-10-01', pairs: [
        { plan: { x: 0.1, y: 0.1 }, lngLat: { lng: 7.57, lat: 47.524 } }, { plan: { x: 0.4, y: 0.4 }, lngLat: { lng: 7.571, lat: 47.523 } }] }],
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('modul6/alignments')
      ? new Response(JSON.stringify(meta), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }))))
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Schloss Musterdorf/ }))
    fireEvent.click(within(await screen.findByRole('region', { name: 'Karte & Objekte' })).getByRole('button', { name: 'Gebäude' }))
    await waitFor(() => expect(rec.board.some((b) => (b as { building?: unknown }).building)).toBe(true), { timeout: 6000 })
    const p = rec.board[rec.board.length - 1] as Record<string, unknown> & { plans: { id: string; floorStack?: boolean }[]; building: { floors: number[]; pack: { aspect: number }; floorNames?: Record<string, string> }; floorPack: { floors: unknown[] } }
    expect(p.plans.map((d) => [d.id, !!d.floorStack])).toEqual([['gebaeude', true]])
    expect(p.building.floors).toEqual([0, 1])
    expect(p.building.floorNames).toEqual({ 0: 'EG' })
    expect(p.building.pack.aspect).toBe(1.414)
    expect(p.floorPack.floors).toHaveLength(2)
    expect(p.readOnly).toBe(true)
    expect(p.linkViewer).toBe(true)
    // no building pick, no compass turn, no calibration, no Einsatz behind it
    for (const k of ['onBuildingFace', 'onReorient', 'onCalibrate', 'onObjectSwitch', 'incidentId', 'tafel']) expect(p[k]).toBeUndefined()
  }, 10000)

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
  // review round 3 (owner's iPhone): the phone's bar has a round search button, the field lives in
  // an Ebenen-style slide-up whose first line it is; picking a row closes it and selects
  it('on a phone: the search is a button that opens a sheet with the field first, focused, no contact AutoFill', async () => {
    rec.phone = true
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    expect(screen.queryByPlaceholderText('Adresse oder Objekt suchen …', PLAIN)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Suchen' }))
    const sheet = await screen.findByRole('region', { name: 'Suchen' })
    const field = within(sheet).getByPlaceholderText('Adresse oder Objekt', PLAIN) as HTMLInputElement
    expect(document.activeElement).toBe(field)
    expect(field.name).toBe('search-karte')
    expect(field.getAttribute('autocomplete')).toBe('off')
    expect(field.getAttribute('autocorrect')).toBe('off')
    expect(field.placeholder).not.toContain('Adresse')
    fireEvent.change(field, { target: { value: 'schloss' } })
    const [first] = await within(sheet).findAllByRole('option')
    fireEvent.click(first)
    expect(screen.queryByRole('region', { name: 'Suchen' })).toBeNull()
    expect(await screen.findByRole('heading', { name: 'Schloss Musterdorf' })).toBeTruthy()
  })

  it('on a phone: the search sheet stays when the keyboard goes, and ✕ closes it', async () => {
    rec.phone = true
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Suchen' }))
    const sheet = await screen.findByRole('region', { name: 'Suchen' })
    ;(document.activeElement as HTMLElement).blur()
    expect(screen.getByRole('region', { name: 'Suchen' })).toBe(sheet)
    fireEvent.click(within(sheet).getByRole('button', { name: appConfig.copy.closeDialog }))
    expect(screen.queryByRole('region', { name: 'Suchen' })).toBeNull()
  })

  it('on a phone: Gefahrgut is a slide-up with the UN field as its first line, a number field iOS will not autofill', async () => {
    rec.phone = true
    mount()
    const nav = await screen.findByRole('navigation', { name: 'Karte & Objekte' })
    fireEvent.click(within(nav).getByRole('button', { name: /Gefahrgut/ }))
    const sheet = await screen.findByRole('region', { name: 'Gefahrgut' })
    expect(sheet.classList.contains('layers-card')).toBe(true)
    const field = sheet.querySelector('input') as HTMLInputElement
    expect(field.id).toBe('karte-un')
    expect(field).toMatchObject({ name: 'search-karte-un', inputMode: 'numeric' })
    expect(field.getAttribute('autocomplete')).toBe('off')
    expect(field.getAttribute('spellcheck')).toBe('false')
    fireEvent.change(field, { target: { value: '12a03' } })
    expect(field.value).toBe('1203')
    // the readout replaces the empty card's offline line, under the field
    expect(within(sheet).queryByText(appConfig.copy.karte.ergOffline)).toBeNull()
    expect(sheet.querySelector('input')).toBe(field)
  })
  // owner (review round 3): a tap on «Gefahrgut» with no number opens the sheet with the caret in
  // the UN field (the number pad up); with a number already set it opens on the result, no keyboard
  it('on a phone: Gefahrgut opens with the caret in the UN field, or on its result without one', async () => {
    rec.phone = true
    mount()
    const nav = await screen.findByRole('navigation', { name: 'Karte & Objekte' })
    const tab = within(nav).getByRole('button', { name: /Gefahrgut/ })
    fireEvent.click(tab)
    let sheet = await screen.findByRole('region', { name: 'Gefahrgut' })
    const field = sheet.querySelector('input') as HTMLInputElement
    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: '1203' } })
    field.blur()
    fireEvent.click(tab)
    expect(screen.queryByRole('region', { name: 'Gefahrgut' })).toBeNull()
    fireEvent.click(tab)
    sheet = await screen.findByRole('region', { name: 'Gefahrgut' })
    expect((sheet.querySelector('input') as HTMLInputElement).value).toBe('1203')
    expect(document.activeElement).not.toBe(sheet.querySelector('input'))
  })

  // owner R4-6 (17.10.2026): «while measuring we should also be able to measure on top of objects
  // (not have the objects get highlighted)» — a tap tool takes the tap on a tag or dot too
  it('measures over an object: its tag lets the tap through, nothing is selected', async () => {
    mount()
    const tag = await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    fireEvent.click(screen.getByRole('button', { name: 'Messen' }))
    const marker = screen.getByRole('button', { name: /Schloss Musterdorf/ })
    expect(marker.className).toMatch(/through/)
    // a click that reaches it anyway (a keyboard) is the tool's, at the object's point
    fireEvent.click(marker)
    act(() => lastMap().onMapClick([7.5708, 47.52455]))
    await waitFor(() => expect(lastMap().measurePoints).toEqual([[7.570188, 47.523773], [7.5708, 47.52455]]))
    expect(screen.queryByRole('heading', { name: 'Schloss Musterdorf' })).toBeNull()
    expect(window.location.search).toBe('')
    // Messen off: the object is the object's again
    fireEvent.click(screen.getByRole('button', { name: 'Messen' }))
    expect(screen.getByRole('button', { name: /Schloss Musterdorf/ }).className).not.toMatch(/through/)
    expect(tag).toBeTruthy()
  })

  // owner R4-7: «after closing … revert the position again so it doesn't constantly push the map
  // south» (the rule itself: lib/karte/camera.test)
  it('on a phone: closing the sheet eases the camera back to where it was, unless the user moved it', async () => {
    rec.phone = true
    let cam = { center: { lng: 7.56, lat: 47.52 }, zoom: 15.5, padding: { top: 0, bottom: 0, left: 0, right: 0 } }
    const handlers: Record<string, (e: unknown) => void> = {}
    const easeTo = vi.fn((o: { center?: LngLat; zoom?: number; padding?: typeof cam.padding }) => {
      cam = { center: o.center ? { lng: o.center[0], lat: o.center[1] } : cam.center, zoom: o.zoom ?? cam.zoom, padding: o.padding ?? cam.padding }
    })
    const map = {
      getContainer: () => document.createElement('div'), getZoom: () => cam.zoom, getCenter: () => cam.center, getPadding: () => cam.padding,
      unproject: () => ({ lng: 7.56, lat: 47.52 }), project: () => ({ x: 200, y: 700 }), getBounds: () => ({ getWest: () => 7.5, getSouth: () => 47.5, getEast: () => 7.6, getNorth: () => 47.6 }),
      easeTo, jumpTo: () => {}, fitBounds: () => {},
    }
    rec.fakeMap = { ...map, getMap: () => ({ on: (ev: string, h: (e: unknown) => void) => { handlers[ev] = h } }) }
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    act(() => (lastMap() as unknown as { onSettled: () => void }).onSettled())
    const start = { ...cam }
    fireEvent.click(screen.getByRole('button', { name: /Schloss Musterdorf/ }))
    await screen.findByRole('region', { name: 'Karte & Objekte' })
    // the tap framed it in the strip above the sheet (padding) …
    expect(cam.padding.bottom).toBeGreaterThan(0)
    // … another object from «In der Nähe» while it is open keeps the FIRST camera as the way back
    fireEvent.click(screen.getAllByRole('button', { name: /Starenstrasse 7/ }).find((b) => !b.closest('[data-marker]'))!)
    await screen.findByRole('heading', { name: 'Starenstrasse 7' })
    let sheet = screen.getByRole('region', { name: 'Karte & Objekte' })
    const close = within(sheet).getAllByRole('button', { name: appConfig.copy.closeDialog })
    fireEvent.click(close[close.length - 1])
    expect(easeTo).toHaveBeenLastCalledWith(expect.objectContaining({ center: [start.center.lng, start.center.lat], zoom: start.zoom, padding: start.padding }))

    // the user pans while the sheet is open: closing leaves the map where they put it
    fireEvent.click(screen.getByRole('button', { name: /Schloss Musterdorf/ }))
    sheet = await screen.findByRole('region', { name: 'Karte & Objekte' })
    act(() => handlers.movestart({ originalEvent: new Event('touchstart') }))
    const calls = easeTo.mock.calls.length
    const closeAgain = within(sheet).getAllByRole('button', { name: appConfig.copy.closeDialog })
    fireEvent.click(closeAgain[closeAgain.length - 1])
    expect(easeTo.mock.calls.length).toBe(calls)
  })

  // owner R4-3: «for the gefahrgut stuff we also need to know the name (show it as attribute)»
  it('on a phone: Gefahrgut names the substance first («Stoff»)', async () => {
    __setUnHazardData(adr as UnHazardEntry[])
    rec.phone = true
    mount()
    const nav = await screen.findByRole('navigation', { name: 'Karte & Objekte' })
    fireEvent.click(within(nav).getByRole('button', { name: /Gefahrgut/ }))
    const sheet = await screen.findByRole('region', { name: 'Gefahrgut' })
    fireEvent.change(sheet.querySelector('input') as HTMLInputElement, { target: { value: '1203' } })
    const row = await within(sheet).findByText('BENZIN oder OTTOKRAFTSTOFF')
    expect(row.previousElementSibling?.textContent).toBe(appConfig.copy.contextPanel.unSubstance)
    // the first row of the readout
    expect(sheet.querySelector('.un-haz-row')).toBe(row.parentElement)
  })

  // owner R4-1: «move "station" up in ebenen all the way to the top»
  it('lists «Grundkarte» first and the «Station» group right under it in its Ebenen', async () => {
    mount()
    await screen.findByRole('button', { name: /Schloss Musterdorf/ })
    fireEvent.click(screen.getByRole('button', { name: appConfig.copy.karte.tools.layers }))
    const heads = [...document.querySelectorAll('.layers-card .lgroup')].map((el) => el.textContent)
    expect(heads.slice(0, 2)).toEqual([appConfig.copy.baseMap, appConfig.copy.karte.layerGroupStation])
  })
})
