// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SucheDoc } from './types'

/*
 * The Suche's door WIRED into the workspace (26.09.2026, the owner's design «F») — what the card
 * alone cannot show: the door stands beside Ebenen in the tool rail with the red count, it opens
 * the card in Ebenen's place, the two are exclusive, the head chip opens the same card, the phone
 * catches a tap beside it, and no other door (the NavRail) is left. Mounted whole, like
 * IncidentWorkspace.grundgeruest.test.tsx, with the map as a prop recorder.
 */

const rec = vi.hoisted(() => ({ map: [] as Record<string, unknown>[], role: 'editor' as string, phone: false }))

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
import { fillTemplate } from './lib/format'

const C = appConfig.copy.suche

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
afterEach(async () => { cleanup(); await new Promise((r) => setTimeout(r, 60)); vi.unstubAllGlobals() })
afterAll(async () => { await new Promise((r) => setTimeout(r, 200)) })

let seq = 0
const meta = (over: Partial<IncidentMeta> = {}): IncidentMeta => ({
  id: `inc-su${++seq}`, divera_id: null, title: 'Suche', type: 'Brandbekämpfung', priority: null, address: 'Teststrasse 1',
  lat: 47.5, lng: 7.6, status: 'offen', source: 'manual', source_ref: null, auto_opened: false,
  started_at: '2026-09-26T10:00:00Z', closed_at: null, is_archived: false, is_exercise: true,
  report_done_at: null, workspace_rev: 0, created_by: null, created_at: '2026-09-26T10:00:00Z', updated_at: '2026-09-26T10:00:00Z',
  ...over,
})
const missing: SucheDoc = {
  personen: [{ id: 'p1', name: 'Muster Tim', wo: 'Keller', bereichId: 'b1', createdAt: '2026-09-26T10:05:00Z', log: [{ id: 'r1', op: 'vermisst', at: '2026-09-26T10:05:00Z', text: 'Vermisst: Muster Tim · zuletzt Keller' }] }],
  bereiche: [{ id: 'b1', name: 'Keller', createdAt: '2026-09-26T10:05:00Z', log: [] }],
}

const settle = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
async function mount(opts: { workspace?: Partial<Saved> } = {}) {
  const m = meta()
  render(<IncidentWorkspace
    incidentMeta={m} incidents={[m]} workspace={({ entities: [], ...opts.workspace }) as unknown as Saved}
    sync={new WorkspaceSync(m.id)} forceReadOnly={false} tabLockLost={false} onTakeOverTab={() => {}}
    onSwitchIncident={() => {}} onOpenHistory={() => {}} onOpenDivera={() => {}} onOpenDatenquellen={() => {}}
    needsReview={false} onReviewDone={() => {}} onEditMeta={() => {}} onCompleteRapport={async () => true}
  />)
  await settle()
}
const door = () => document.querySelector<HTMLButtonElement>('.tool-rail .vrail-suche')
const ebenen = () => document.querySelector<HTMLButtonElement>('.tool-rail .vrail-layers')
const sucheCard = () => document.querySelector('[data-suche-card]')
const layersCard = () => document.querySelector('.layers-card:not([data-suche-card])')
const click = async (el: Element | null) => { act(() => { fireEvent.click(el!) }); await settle() }

describe('the Suche\'s door stands beside Ebenen', () => {
  it('is the next button after Ebenen in the rail\'s foot, and carries the red count of people still missing', async () => {
    await mount({ workspace: { suche: missing } as unknown as Partial<Saved> })
    expect(door()).not.toBeNull()
    expect(ebenen()!.nextElementSibling).toBe(door())
    expect(door()!.querySelector('.nav-count.nav-vermisst')?.textContent).toBe('1')
    expect(door()!.getAttribute('aria-label')).toBe(`${C.title} · ${fillTemplate(C.vermisstChip, { n: 1 })}`)
  })

  it('opens the card in Ebenen\'s place, and a second tap closes it — like Ebenen', async () => {
    await mount()
    expect(sucheCard()).toBeNull()
    await click(door())
    expect(sucheCard()).not.toBeNull()
    expect(sucheCard()!.classList.contains('layers-card')).toBe(true)
    expect(door()!.getAttribute('aria-pressed')).toBe('true')
    // empty: nothing preset — and opening wrote nothing
    expect(screen.getByText(C.emptyTitle)).toBeTruthy()
    await click(door())
    expect(sucheCard()).toBeNull()
  })

  it('Ebenen and Suche are exclusive: opening one closes the other', async () => {
    await mount()
    await click(door())
    await click(ebenen())
    expect(sucheCard()).toBeNull()
    expect(layersCard()).not.toBeNull()
    await click(door())
    expect(layersCard()).toBeNull()
    expect(sucheCard()).not.toBeNull()
  })

  it('the head chip «1 vermisst» opens the same card; its ✕ closes it', async () => {
    await mount({ workspace: { suche: missing } as unknown as Partial<Saved> })
    const chip = document.querySelector<HTMLButtonElement>('.tb-suche')
    expect(chip).not.toBeNull()
    await click(chip)
    expect(sucheCard()).not.toBeNull()
    expect(screen.getByRole('region', { name: 'Keller' })).toBeTruthy()
    await click(screen.getByRole('button', { name: C.close }))
    expect(sucheCard()).toBeNull()
  })

  it('no other door is left: no «Suche» in the left rail', async () => {
    await mount({ workspace: { suche: missing } as unknown as Partial<Saved> })
    expect(document.querySelector('.navrail')?.textContent ?? '').not.toContain(C.title)
  })
})

describe('on a phone', () => {
  it('a tap beside the card closes it (the Ebenen sheet\'s backdrop)', async () => {
    rec.phone = true
    await mount()
    await click(door())
    expect(sucheCard()).not.toBeNull()
    const backdrop = document.querySelector('.mapctl-backdrop')
    expect(backdrop).not.toBeNull()
    await click(backdrop)
    expect(sucheCard()).toBeNull()
    expect(document.querySelector('.mapctl-backdrop')).toBeNull()
  })
})
