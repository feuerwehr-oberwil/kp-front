// @vitest-environment jsdom
//
// The SharePoint card on System & Wartung. What it pins is the one thing this connector's UI
// exists for: an operator can SEE that it stopped. Everything else on the page is a number;
// this card is a promise that silence has a colour.
//
//   1. an unconfigured station reads «nicht eingerichtet» — a card that renders nothing looks
//      exactly like a card whose fetch failed, and the difference matters here;
//   2. the last SUCCESSFUL sync is the column, not the last run — a green tick standing over a
//      week of 401s is the failure the whole card is against;
//   3. an expiring Azure client secret is a warning weeks ahead, and an expired one is red.

import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiGet = vi.fn()
const apiPost = vi.fn()

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiGet: (p: string) => apiGet(p), apiPost: (p: string, b: unknown) => apiPost(p, b) }
})

vi.mock('./ConfigContext', () => ({ useConfig: () => ({ draft: {} }) }))
vi.mock('./TelemetryCard', () => ({ TelemetryCard: () => null }))
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

    // The name is both the row's title and its badge label, so the folder path is the anchor.
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
