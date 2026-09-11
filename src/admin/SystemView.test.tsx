// @vitest-environment jsdom
//
// System & Wartung. Two things are pinned here.
//
// «Systemzustand» — the page's single primary status surface. Server, Datenbank, Umgebung,
// Release, Commit and Branch answer one question («läuft der Server, und welcher Stand?») and
// therefore live in one place, with two rules that were real bugs: a badge inside an already
// labelled cell is dot + state only, and the raw env string never reaches the UI.
//
// The SharePoint card. What it pins is the one thing this connector's UI exists for: an
// operator can SEE that it stopped. Everything else on the page is a number; this card is a
// promise that silence has a colour.
//
//   1. an unconfigured station reads «nicht eingerichtet» — a card that renders nothing looks
//      exactly like a card whose fetch failed, and the difference matters here;
//   2. the last SUCCESSFUL sync is the column, not the last run — a green tick standing over a
//      week of 401s is the failure the whole card is against;
//   3. an expiring Azure client secret is a warning weeks ahead, and an expired one is red.

import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiGet = vi.fn()
const apiPost = vi.fn()

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiGet: (p: string) => apiGet(p), apiPost: (p: string, b: unknown) => apiPost(p, b) }
})

vi.mock('./ConfigContext', () => ({ useConfig: () => ({ draft: {} }) }))
vi.mock('./SetupChecklist', () => ({ SetupChecklist: () => null }))

import { SystemView } from './SystemView'
import { appConfig } from '../config/appConfig'

const C = appConfig.copy.admin.system

interface Area {
  area: string; path: string; site: string | null
  status: string; detail: string | null
  imported: number; skipped: number; missing: number
  lastRunAt: string | null; lastSuccessAt: string | null
}

const area = (over: Partial<Area>): Area => ({
  area: 'plans', path: 'kp-data/plans', site: 'https://x.sharepoint.com/sites/kp',
  status: 'ok', detail: null, imported: 3, skipped: 1, missing: 0,
  lastRunAt: '2026-09-09T08:00:00Z', lastSuccessAt: '2026-09-09T08:00:00Z', ...over,
})

const SYSTEM = {
  version: { release: '0.10.0', commit: 'abcdef1234', branch: null, env: 'production' },
  database: { ok: true },
  counts: { incidents: 1, incidents_open: 0, personnel_active: 2, users: 3, reference_datasets: 4 },
  storage: null,
  integrations: null,
  connectors: [],
  monitoring: { heartbeatConfigured: true },
}

function serve(sharepoint: unknown) {
  apiGet.mockImplementation((p: string) =>
    Promise.resolve(p.startsWith('/api/sharepoint/status') ? sharepoint : SYSTEM))
}

beforeEach(() => { apiGet.mockReset(); apiPost.mockReset() })
afterEach(cleanup)

describe('a station that has not set the connector up', () => {
  it('says so instead of drawing an empty card', async () => {
    serve({ configured: false, credentials: false, intervalMinutes: 60, secretExpiresInDays: null, areas: [] })
    render(<SystemView />)

    expect(await screen.findByText(C.spNotSetUp)).toBeTruthy()
    expect(screen.getByText(C.spNotSetUpHint)).toBeTruthy()
  })

  it('tells a station whose keys work but whose folders are missing which half is missing', async () => {
    serve({ configured: false, credentials: true, intervalMinutes: 60, secretExpiresInDays: null, areas: [] })
    render(<SystemView />)

    expect(await screen.findByText(C.spNoSources)).toBeTruthy()
  })
})

describe('«Systemzustand» — the one primary status surface', () => {
  const noSharePoint = { configured: false, credentials: false, intervalMinutes: 60, secretExpiresInDays: null, areas: [] }

  it('states Server, Datenbank and Umgebung exactly once each', async () => {
    serve(noSharePoint)
    render(<SystemView />)

    await screen.findByText(C.reachable)
    // Each label is a cell label; no badge repeats it, and no second card restates the fact.
    expect(screen.getAllByText(C.server)).toHaveLength(1)
    expect(screen.getAllByText(C.database)).toHaveLength(1)
    expect(screen.getAllByText(C.environment)).toHaveLength(1)
    expect(screen.getAllByText(C.ok)).toHaveLength(1)
    expect(screen.getAllByText(C.production)).toHaveLength(1)
  })

  it('never shows the raw env string', async () => {
    serve(noSharePoint)
    render(<SystemView />)

    await screen.findByText(C.production)
    expect(screen.queryByText('production')).toBeNull()
  })

  it('carries the version facts in the SAME surface as the server state', async () => {
    // The point of the merge: «läuft der Server, und welcher Stand läuft da» is one question,
    // and it used to be answered by a strip plus a separate Version card further down.
    serve(noSharePoint)
    render(<SystemView />)

    const cell = (await screen.findByText(C.release)).closest('div')!
    const surface = cell.parentElement!
    for (const label of [C.server, C.database, C.environment, C.release, C.commit, C.branch]) {
      expect(within(surface).getByText(label)).toBeTruthy()
    }
    expect(within(surface).getByText('v0.10.0')).toBeTruthy()
    // Short hash in the cell, the full one on hover — forty characters would push the label out.
    expect(within(surface).getByText('abcdef1')).toBeTruthy()
    expect(screen.queryByText('abcdef1234')).toBeNull()
    // No branch reported → a dash, not an empty cell.
    expect(within(surface).getAllByText('—')).toHaveLength(1)
  })

  it('says «nicht verfügbar» in every version cell when the server reports no version', async () => {
    apiGet.mockImplementation((p: string) =>
      Promise.resolve(p.startsWith('/api/sharepoint/status') ? noSharePoint : { ...SYSTEM, version: null }))
    render(<SystemView />)

    const surface = (await screen.findByText(C.release)).closest('div')!.parentElement!
    // Release, Commit and Branch each say it — three dashes would read as three empty fields.
    expect(within(surface).getAllByText(C.notAvailable)).toHaveLength(3)
    // …and an unknown env is «Entwicklung», never a green «Produktion» by default.
    expect(within(surface).getByText(C.development)).toBeTruthy()
  })
})

describe('the per-area read-out', () => {
  it('leads with the last SUCCESSFUL sync, not the last attempt', async () => {
    serve({
      configured: true, credentials: true, intervalMinutes: 60, secretExpiresInDays: 400,
      areas: [
        area({}),
        area({
          area: 'geodata', path: 'gis', status: 'auth_failed', imported: 0, skipped: 0,
          detail: 'AADSTS7000222: client secret keys are expired.',
          lastRunAt: '2026-09-09T09:00:00Z', lastSuccessAt: '2026-08-02T08:00:00Z',
        }),
      ],
    })
    render(<SystemView />)

    // The name is the row's title only — the badge beside it is dot + state — so the folder
    // path is the anchor.
    expect(await screen.findByText('kp-data/plans')).toBeTruthy()
    // The failing area shows the tenant's own sentence — «AADSTS…» is the searchable half.
    expect(screen.getByText(/AADSTS7000222/)).toBeTruthy()
    expect(screen.getByText(C.spStates.auth_failed!)).toBeTruthy()
    // …and its «zuletzt erfolgreich» is the old date, not today's failed run.
    expect(screen.getByText(/02\.08\.2026/)).toBeTruthy()
  })

  it('reads a refusal as a protection, not as an error', async () => {
    serve({
      configured: true, credentials: true, intervalMinutes: 60, secretExpiresInDays: null,
      areas: [area({ status: 'refused', detail: 'the folder listed no usable files' })],
    })
    render(<SystemView />)

    expect(await screen.findByText(C.spStates.refused!)).toBeTruthy()
  })
})

describe('the Azure client secret', () => {
  it('is counted down weeks before it lapses', async () => {
    serve({
      configured: true, credentials: true, intervalMinutes: 60, secretExpiresInDays: 21,
      areas: [area({})],
    })
    render(<SystemView />)

    expect(await screen.findByText(/21/)).toBeTruthy()
  })

  it('says the connector has stopped once it has expired', async () => {
    serve({
      configured: true, credentials: true, intervalMinutes: 60, secretExpiresInDays: -3,
      areas: [area({ status: 'auth_failed' })],
    })
    render(<SystemView />)

    expect(await screen.findByText(C.spSecretExpired)).toBeTruthy()
  })

  it('stays quiet while the date is comfortably away', async () => {
    serve({
      configured: true, credentials: true, intervalMinutes: 60, secretExpiresInDays: 400,
      areas: [area({})],
    })
    render(<SystemView />)

    await screen.findByText('kp-data/plans')
    expect(screen.queryByText(C.spSecretExpired)).toBeNull()
    expect(screen.queryByText(/400/)).toBeNull()
  })
})

describe('running it by hand', () => {
  it('triggers a sync and re-reads the state afterwards', async () => {
    serve({
      configured: true, credentials: true, intervalMinutes: 60, secretExpiresInDays: null,
      areas: [area({})],
    })
    apiPost.mockResolvedValue({ status: 'ok', areas: {} })
    render(<SystemView />)

    fireEvent.click(await screen.findByRole('button', { name: C.spSyncNow }))

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/sharepoint/sync', {}))
    await waitFor(() => expect(screen.getByText(C.spSynced)).toBeTruthy())
    // Re-read: the whole point of the button is finding out whether it works NOW.
    expect(apiGet.mock.calls.filter(([p]) => p === '/api/sharepoint/status')).toHaveLength(2)
  })

  it('says «fehlgeschlagen» rather than silently doing nothing', async () => {
    serve({
      configured: true, credentials: true, intervalMinutes: 60, secretExpiresInDays: null,
      areas: [area({})],
    })
    apiPost.mockRejectedValue(new Error('nope'))
    render(<SystemView />)

    fireEvent.click(await screen.findByRole('button', { name: C.spSyncNow }))

    expect(await screen.findByText(C.spSyncFailed)).toBeTruthy()
  })
})

describe('«Verbindung testen» — the setupOf()-gated probe (POST /api/sharepoint/probe)', () => {
  it('offers Zugangsdaten instead of a probe while nothing is set up at all', async () => {
    serve({ configured: false, credentials: false, intervalMinutes: 60, secretExpiresInDays: null, areas: [] })
    const onNavigate = vi.fn()
    render(<SystemView onNavigate={onNavigate} />)

    await screen.findByText(C.spNotSetUp)
    // A probe here can only fail, and the failure would teach nothing beyond «nicht eingerichtet».
    expect(screen.queryByRole('button', { name: C.spTestConnection })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: C.spOpenCredentials }))
    expect(onNavigate).toHaveBeenCalledWith('zugaenge')
  })

  it('warns rather than staying neutral once credentials exist but no folder does — and keeps the probe', async () => {
    serve({ configured: false, credentials: true, intervalMinutes: 60, secretExpiresInDays: 400, areas: [] })
    render(<SystemView />)

    const badge = (await screen.findByText(C.spNoSources)).closest('.adm-badge')
    expect(badge?.classList.contains('warn')).toBe(true)
    // The probe only needs a token, so it is offered even with zero folders configured.
    expect(screen.getByRole('button', { name: C.spTestConnection })).toBeTruthy()
  })

  it('flags a client secret with no recorded expiry, even once folders are configured', async () => {
    serve({
      configured: true, credentials: true, intervalMinutes: 60, secretExpiresInDays: null,
      areas: [area({})],
    })
    render(<SystemView />)

    const badge = (await screen.findByText(C.spSecretMissing)).closest('.adm-badge')
    expect(badge?.classList.contains('warn')).toBe(true)
  })

  it('reports success against the server’s own answer', async () => {
    serve({
      configured: true, credentials: true, intervalMinutes: 60, secretExpiresInDays: 400,
      areas: [area({})],
    })
    apiPost.mockResolvedValue({ ok: true, detail: null })
    render(<SystemView />)

    fireEvent.click(await screen.findByRole('button', { name: C.spTestConnection }))

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/sharepoint/probe', {}))
    expect(await screen.findByText(C.spTestOk)).toBeTruthy()
  })

  it('shows the tenant’s own sentence when the probe fails, not a generic message', async () => {
    serve({
      configured: true, credentials: true, intervalMinutes: 60, secretExpiresInDays: 400,
      areas: [area({})],
    })
    apiPost.mockResolvedValue({ ok: false, detail: 'AADSTS7000222: client secret keys are expired.' })
    render(<SystemView />)

    fireEvent.click(await screen.findByRole('button', { name: C.spTestConnection }))

    expect(await screen.findByText(/AADSTS7000222/)).toBeTruthy()
  })
})
