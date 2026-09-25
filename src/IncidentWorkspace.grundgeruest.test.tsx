// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { BoardAnno, Drawing, Entity } from './types'

/*
 * The Lage-Grundgerüst WIRED into the workspace — what the pure rules (lib/lageGrundgeruest) and
 * the card alone cannot show: who may place, that «hier setzen» is one ordinary undo step, that
 * the rail entry toggles without touching the selection, that the phone's «+» entry always
 * OPENS the strip, that the list follows an Einsatzart corrected on another device, that no
 * suggestion is made without the incident's own location, and that «auf die Karte übernehmen»
 * moves the same record rather than making a second one. Mounted whole, like
 * IncidentWorkspace.harness.test.tsx, with the map as a prop recorder.
 */

const rec = vi.hoisted(() => ({ map: [] as Record<string, unknown>[], role: 'editor' as string, phone: false }))
type MapProps = Record<string, unknown> & {
  entities: Entity[]; drawings: Drawing[]; selectedId: string | null; onSelect: (e: Entity) => void; onMapClick: (c: [number, number]) => void
}
const lastMap = () => rec.map[rec.map.length - 1] as MapProps

vi.mock('./lib/auth', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./lib/auth')>()
  const logout = () => Promise.resolve()
  return {
    ...mod,
    useAuth: () => ({
      user: { id: 'u1', username: 'fu', display_name: 'FU Test', role: rec.role, color: null, last_login: null },
      loading: false, probeUnreachable: false, sessionExpired: false, login: () => Promise.resolve(), logout,
    }),
  }
})
const SYM = vi.hoisted(() => ({ ready: true, error: false, reload: () => {}, order: [], symbols: [], byName: {} }))
vi.mock('./lib/useSymbols', async (importOriginal) => ({ ...(await importOriginal<typeof import('./lib/useSymbols')>()), useSymbols: () => SYM }))
vi.mock('./lib/useIsPhone', async (importOriginal) => ({ ...(await importOriginal<typeof import('./lib/useIsPhone')>()), useIsPhone: () => rec.phone }))
// a wind reading from the west, so the KP row has an upwind suggestion to take
vi.mock('./lib/useWeather', () => ({
  useWeather: () => ({
    data: { wind_dir_deg: 270, wind_speed_kmh: 12, wind_gust_kmh: null, temp_c: 15, precip_mm: 0, weather_code: 0, observed_at: null, source: 'test', station: null },
    error: null,
  }),
}))
const PRESETS = vi.hoisted(() => ({
  'fks-standard': {
    beschreibung: 'test',
    kategorien: {
      brandbekaempfung: [
        { id: 'kp', label: 'KP · Einsatzleitung', symbol: 'VKF KP Front', vorschlag: { wind: 'auf', m: 40 } },
        { id: 'zufahrt', label: 'Zufahrt', linie: 'Zufahrt' },
        { id: 'sammel', label: 'Sammelplatz', symbol: 'FW Sammelplatz' },
      ],
      strassenrettung: [{ id: 'patienten', label: 'Patientensammelstelle', symbol: 'VKF Patientensammelstelle' }],
    },
  },
}))
vi.mock('./lib/deploymentConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/deploymentConfig')>()),
  lageGrundgeruestConfig: () => ({ config: { preset: 'fks-standard' }, presets: PRESETS }),
}))
vi.mock('./components/MapView', () => ({
  MapView: (p: Record<string, unknown>) => { rec.map.push(p); return <div data-testid="mapview" /> },
}))
vi.mock('./components/Whiteboard', () => ({ Whiteboard: () => <div data-testid="whiteboard" /> }))
vi.mock('./components/ReportPreflight', () => ({ ReportPreflight: () => null, requestReportStep: () => {} }))

import { IncidentWorkspace } from './IncidentWorkspace'
import { WorkspaceSync } from './lib/api/workspaceSync'
import type { IncidentMeta } from './lib/api/incidents'
import type { Saved } from './lib/workspace'
import { appConfig } from './config/appConfig'
import { fillTemplate, formatSymbolName } from './lib/format'

const C = appConfig.copy.lageGrundgeruest

class RO { observe() {} unobserve() {} disconnect() {} }
beforeAll(() => {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= RO
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})
beforeEach(() => {
  rec.map.length = 0; rec.role = 'editor'; rec.phone = false
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })))
})
// ⚠️ Unmount, then let the workspace's in-flight IndexedDB promises (the media queue's flush)
// land while jsdom's `window` still exists — a setState after the environment is gone is an
// unhandled «window is not defined» that fails the whole run.
afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 60)); vi.unstubAllGlobals() })
afterAll(async () => { await new Promise((r) => setTimeout(r, 200)) })

let seq = 0
const meta = (over: Partial<IncidentMeta> = {}): IncidentMeta => ({
  id: `inc-gg${++seq}`, divera_id: null, title: 'Grundgerüst', type: 'Brandbekämpfung', priority: null, address: 'Teststrasse 1',
  lat: 47.5, lng: 7.6, status: 'offen', source: 'manual', source_ref: null, auto_opened: false,
  started_at: '2026-09-24T10:00:00Z', closed_at: null, is_archived: false, is_exercise: true,
  report_done_at: null, workspace_rev: 0, created_by: null, created_at: '2026-09-24T10:00:00Z', updated_at: '2026-09-24T10:00:00Z',
  ...over,
})
const truck = { id: 'p1', kind: 'symbol', symbol: 'VKF Fahrzeug', coord: [7.6, 47.5] } as Entity

const settle = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
async function mount(opts: { m?: IncidentMeta; incidents?: IncidentMeta[]; workspace?: Partial<Saved>; forceReadOnly?: boolean } = {}) {
  const m = opts.m ?? meta()
  render(<IncidentWorkspace
    incidentMeta={m} incidents={opts.incidents ?? [m]} workspace={({ entities: [truck], ...opts.workspace }) as unknown as Saved}
    sync={new WorkspaceSync(m.id)} forceReadOnly={opts.forceReadOnly ?? false} tabLockLost={false} onTakeOverTab={() => {}}
    onSwitchIncident={() => {}} onOpenHistory={() => {}} onOpenDivera={() => {}} onOpenDatenquellen={() => {}}
    needsReview={false} onReviewDone={() => {}} onEditMeta={() => {}} onCompleteRapport={async () => true}
  />)
  await settle()
}
const card = () => document.querySelector<HTMLElement>('section.lgg')
const placed = (symbol: string) => lastMap().entities.filter((e) => e.symbol === symbol && !e.live)
const key = (k: string, o: KeyboardEventInit = {}) => { act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o })) }) }
const railEntry = () => document.querySelector<HTMLButtonElement>(`.tool-rail button[aria-label="${appConfig.copy.mapTools.find((t) => t.id === 'grundgeruest')!.label}"]`)

describe('who may place', () => {
  it('an editor gets the card, with the upwind suggestion', async () => {
    await mount()
    expect(card()).not.toBeNull()
    expect(screen.getByText(C.placeHere)).toBeTruthy()
  })

  it('a viewer gets no card and no rail entry', async () => {
    rec.role = 'viewer'
    await mount()
    expect(card()).toBeNull()
    expect(railEntry()).toBeNull()
  })

  it('the el role gets no card either — it writes the record, never the Karte', async () => {
    rec.role = 'el'
    await mount()
    expect(card()).toBeNull()
  })
})

describe('«hier setzen» is an ordinary placement', () => {
  it('places the symbol, selected to drag, and one ⌘Z takes it back', async () => {
    await mount()
    act(() => { screen.getByText(C.placeHere).click() })
    await settle()
    const kp = placed('VKF KP Front')
    expect(kp).toHaveLength(1)
    // west of the incident (wind from W ⇒ upwind is west)
    expect(kp[0].coord[0]).toBeLessThan(7.6)
    expect(lastMap().selectedId).toBe(kp[0].id)
    key('z', { metaKey: true }); await settle()
    expect(placed('VKF KP Front')).toHaveLength(0)
  })
})

describe('what the undo step says', () => {
  it('names what «hier setzen» placed — not «Änderung auf der Karte»', async () => {
    await mount()
    act(() => { screen.getByText(C.placeHere).click() })
    await settle()
    const action = fillTemplate(appConfig.copy.undoDomains.symbolPlaced, { name: formatSymbolName('VKF KP Front') })
    expect(screen.getAllByRole('button', { name: fillTemplate(appConfig.copy.undoNamed, { action }) }).length).toBeGreaterThan(0)
  })
})

describe('a line row arms the gesture it promises', () => {
  it('«+ Zufahrt» arms Punkte: taps lay the points, ✓ draws the Zufahrt, the row ticks', async () => {
    await mount()
    // the row and the dock say the same words (the dock carries the styling sentence after it)
    expect(appConfig.copy.dockHints.lineNodes.startsWith(C.armedLine)).toBe(true)
    act(() => { screen.getByText('Zufahrt').click() })
    await settle()
    expect(screen.getByText(C.armedLine)).toBeTruthy()
    act(() => lastMap().onMapClick([7.6, 47.5]))
    act(() => lastMap().onMapClick([7.601, 47.501]))
    await settle()
    act(() => { screen.getByRole('button', { name: appConfig.copy.done }).click() })
    await settle()
    const lines = lastMap().drawings.filter((d) => d.kind === 'line')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ arrow: true, marker: 'Z' })
    expect(lines[0].coords).toHaveLength(2)
    expect(screen.queryByText(C.armedLine)).toBeNull()
    // …and its ↶ says what it takes back, in the Verlauf row's words
    const action = fillTemplate(appConfig.copy.log.shapeDrawn, { name: 'Zufahrt' })
    expect(screen.getAllByRole('button', { name: fillTemplate(appConfig.copy.undoNamed, { action }) }).length).toBeGreaterThan(0)
  })
})

describe('the rail entry (tablet)', () => {
  it('toggles the card and leaves the selection alone', async () => {
    await mount()
    act(() => lastMap().onSelect(truck))
    await settle()
    expect(lastMap().selectedId).toBe('p1')
    act(() => { railEntry()!.click() })
    expect(card()).toBeNull()
    expect(lastMap().selectedId).toBe('p1')
    act(() => { railEntry()!.click() })
    expect(card()).not.toBeNull()
    expect(lastMap().selectedId).toBe('p1')
  })
})

describe('«ausblenden» is remembered on this device, per Einsatz', () => {
  it('survives a reload; the rail entry brings the card back and clears the flag', async () => {
    const m = meta()
    await mount({ m })
    act(() => { screen.getByRole('button', { name: C.hideAria }).click() })
    expect(card()).toBeNull()
    cleanup()
    await mount({ m })
    expect(card()).toBeNull()
    // another Einsatz on the same device is not affected
    cleanup()
    await mount()
    expect(card()).not.toBeNull()
    cleanup()
    await mount({ m })
    act(() => { railEntry()!.click() })
    expect(card()).not.toBeNull()
    cleanup()
    await mount({ m })
    expect(card()).not.toBeNull()
  })
})

describe('the «+» sheet entry (phone)', () => {
  it('always shows the strip OPEN — a second time too, never a hide', async () => {
    rec.phone = true
    await mount()
    expect(card()?.classList.contains('lgg-folded')).toBe(true)
    for (let i = 0; i < 2; i++) {
      act(() => { screen.getByRole('button', { name: appConfig.copy.addSheet.tile }).click() })
      await settle()
      const entry = [...document.querySelectorAll<HTMLButtonElement>('.sym-cell-tool')].find((b) => b.title === appConfig.copy.mapTools.find((t) => t.id === 'grundgeruest')!.label)!
      act(() => { entry.click() })
      await settle()
      expect(card()).not.toBeNull()
      expect(card()!.classList.contains('lgg-folded')).toBe(false)
    }
  })
})

describe('what the card is computed from', () => {
  it('follows an Einsatzart corrected on ANOTHER device (the incidents watch copy)', async () => {
    const m = meta()
    const other = { ...m, type: 'Strassenrettung', updated_at: '2026-09-24T10:05:00Z' }
    await mount({ m, incidents: [other] })
    expect(screen.getByText('Patientensammelstelle')).toBeTruthy()
    expect(screen.queryByText('Sammelplatz')).toBeNull()
  })

  it('without the incident\'s own location: no suggestion, and it says why', async () => {
    await mount({ m: meta({ lat: null, lng: null }) })
    expect(card()).not.toBeNull()
    expect(screen.queryByText(C.placeHere)).toBeNull()
    expect(screen.getByText(C.noLocation)).toBeTruthy()
  })
})

describe('«auf die Karte übernehmen» moves the same record', () => {
  it('a Sammelplatz on an unlinked sheet takes the next Karte tap — no second object', async () => {
    const anno = { id: 'sp1', kind: 'symbol', x: 0.4, y: 0.5, symbol: 'FW Sammelplatz', label: 'Sammelplatz' } as BoardAnno
    await mount({ workspace: { board: { modul3: [anno] } } as unknown as Partial<Saved> })
    expect(placed('FW Sammelplatz')).toHaveLength(0)
    act(() => { screen.getByText(C.toKarte).click() })
    act(() => lastMap().onMapClick([7.601, 47.501]))
    await settle()
    const sp = placed('FW Sammelplatz')
    expect(sp.map((e) => e.id)).toEqual(['sp1'])
    expect(sp[0].coord).toEqual([7.601, 47.501])
    // taken over, so nothing is offered any more
    expect(screen.queryByText(C.toKarte)).toBeNull()
    key('z', { metaKey: true }); await settle()
    expect(placed('FW Sammelplatz')).toHaveLength(0)
  })
})
